import { useEffect, useRef, useState } from 'react'
import { useDprCanvas } from './useDprCanvas.js'
import { LINE_IDS, loadRun, peekRun, FIRST_TAG, FINAL_TAG } from './runs.js'
import {
  loadBoundary,
  peekBoundary,
  axesResolvable,
  axisFeature,
  spanOf,
  SURFACES,
  evennessPct,
} from './interp.js'
import { sampleLine } from './sample.js'
import { drawBoundary, drawScale } from './boundary.js'

// The mech interp panel. Every other view shows what the policy did; this one
// shows the rule it learned, as P(hold) over two of its own observation
// features, with the live fleet plotted on top.
//
// The contrast between the two checkpoints is the argument, and it only holds
// because both are drawn on the same fixed [0,1] scale. See boundary.js.

const TICKS_PER_SEC = 12

export default function Boundary({ playing, speed }) {
  const [tag, setTag] = useState(FINAL_TAG)
  const [surface, setSurface] = useState(SURFACES[0].id)
  const [, bump] = useState(0)
  const [status, setStatus] = useState(null)
  const headRef = useRef(0)
  const tagRef = useRef(tag)
  tagRef.current = tag
  const surfaceRef = useRef(surface)
  surfaceRef.current = surface

  const playingRef = useRef(playing)
  playingRef.current = playing
  const speedRef = useRef(speed)
  speedRef.current = speed

  // Both checkpoints of the current surface, so the toggle is instant, plus the
  // runs that supply the live fleet. Requested only when this panel is opened.
  useEffect(() => {
    let alive = true
    setStatus(null)
    for (const t of [FIRST_TAG, FINAL_TAG]) {
      if (!peekBoundary(surface, t)) {
        loadBoundary(surface, t)
          .then(() => alive && bump((n) => n + 1))
          .catch((err) => {
            console.error(err.message)
            if (alive) setStatus(err.message)
          })
      }
    }
    for (const line of LINE_IDS) {
      if (!peekRun(line, tag)) {
        loadRun(line, tag)
          .then(() => alive && bump((n) => n + 1))
          .catch((err) => console.error('run unavailable:', err.message))
      }
    }
    return () => {
      alive = false
    }
  }, [tag, surface])

  const canvasRef = useDprCanvas((ctx, { width, height, dt, t }) => {
    const doc = peekBoundary(surfaceRef.current, tagRef.current)
    const first = peekRun(LINE_IDS[0], tagRef.current)
    const n = first ? first.ticks.length : 200
    if (playingRef.current) {
      headRef.current = (headRef.current + dt * TICKS_PER_SEC * speedRef.current) % n
    }

    // The fleet shown belongs to the checkpoint on display, so the dots are the
    // trains that this boundary actually produced.
    const lines = LINE_IDS.map((l) => {
      const d = peekRun(l, tagRef.current)
      return d ? sampleLine(d, headRef.current) : null
    }).filter(Boolean)

    drawBoundary(ctx, { width, height, doc, lines, t })
  })

  const scaleRef = useDprCanvas((ctx, { width, height }) => drawScale(ctx, width, height))

  const doc = peekBoundary(surface, tag)
  const anyLine = LINE_IDS.map((l) => peekRun(l, tag)).find(Boolean)
  const sample = anyLine ? sampleLine(anyLine, headRef.current) : null
  const plottable = doc && sample ? axesResolvable(doc, sample) : true
  const span = spanOf(doc)
  // Scoped to the line the boundary was measured on, and derived from that
  // line's run rather than quoted, so the figure and the surface always
  // describe the same thing.
  const boundaryLine = doc?.line
  const evenPct = boundaryLine ? evennessPct(peekRun(boundaryLine, tag)) : null

  return (
    <div className="boundary">
      <div className="tabs">
        <button
          className={`tab tab-wide mono${tag === FIRST_TAG ? ' tab-on' : ''}`}
          onClick={() => setTag(FIRST_TAG)}
        >
          before learning
        </button>
        <button
          className={`tab tab-wide mono${tag === FINAL_TAG ? ' tab-on' : ''}`}
          onClick={() => setTag(FINAL_TAG)}
        >
          after learning
        </button>
        <span className="tab-gap" />
        {SURFACES.map((s) => (
          <button
            key={s.id}
            className={`tab tab-wide mono${s.id === surface ? ' tab-on' : ''}`}
            onClick={() => setSurface(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="boundary-stage">
        <canvas ref={canvasRef} />
      </div>

      <p className="note key-note mono">
        0.33 on either headway axis is perfectly even spacing. below 0.33 the train has
        caught up to the one ahead. above 0.33 it is running late.
        {evenPct !== null && (
          <>
            {' '}
            <strong>
              {boundaryLine} line sits within 0.05 of even on {evenPct.toFixed(1)}% of train ticks
              {tag === FINAL_TAG ? '' : ` at ${tag}`}.
            </strong>
          </>
        )}
      </p>

      <div className="boundary-foot">
        <div className="scale">
          <canvas ref={scaleRef} />
        </div>
        <div className="note mono">
          {/* Stated as a number, because the argument is that the untrained
              surface is genuinely flat rather than merely drawn flat. */}
          {span && (
            <>
              chance of waiting ranges from {span.lo.toFixed(4)} to {span.hi.toFixed(4)}, on a
              fixed 0 to 1 scale
              {span.hi - span.lo < 0.01 ? '. completely flat: there is no rule here yet.' : '.'}
              <br />
            </>
          )}
          {status
            ? status
            : !plottable
              ? `field only. ${axisFeature(doc?.x)} and ${axisFeature(doc?.y)} are policy ` +
                `observation features that the run files do not carry, so no train is plotted ` +
                `rather than plotted somewhere invented.`
              : 'each dot is a train. ringed dots are waiting at the platform right now.'}
        </div>
      </div>

      {doc?.slice_note && <p className="note slice-note mono">{doc.slice_note}</p>}
    </div>
  )
}
