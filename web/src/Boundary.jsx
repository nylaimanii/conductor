import { useEffect, useRef, useState } from 'react'
import { useDprCanvas } from './useDprCanvas.js'
import { loadRun, peekRun, LADDER_TAGS, timestepsForTag, noteForTag, FINAL_TAG } from './runs.js'
import { loadBoundary, peekBoundary, spanOf, SURFACES, evennessPct } from './interp.js'
import { sampleLine } from './sample.js'
import { drawBoundary, drawScale } from './boundary.js'

// The rule the policy taught itself.
//
// Every other view shows what the trains did. This one shows the rule behind
// it: the chance of waiting, over two of the things the policy can actually
// see, with the live fleet moving on top.
//
// Five checkpoints side by side rather than a toggle, so the rule forming is
// one glance instead of a memory test. Every map is drawn on the same fixed
// 0 to 1 scale. The first is genuinely featureless, and normalising each map to
// its own range would invent vivid structure inside it. See boundary.js.

const TICKS_PER_SEC = 12

function Cell({ surface, tag, headRef, isFinal, first }) {
  const doc = peekBoundary(surface, tag)

  const canvasRef = useDprCanvas((ctx, { width, height, t }) => {
    const d = peekBoundary(surface, tag)
    if (!d) {
      ctx.clearRect(0, 0, width, height)
      return
    }
    // The boundary is measured on one line, so only that line's trains belong
    // on it. Plotting the whole network here would put four other lines' trains
    // on a surface that was never measured for them.
    const run = d.line ? peekRun(d.line, tag) : null
    const lines = run ? [sampleLine(run, headRef.current)] : []
    drawBoundary(ctx, { width, height, doc: d, lines, t, compact: true })
  })

  const span = spanOf(doc)
  const flat = span && span.hi - span.lo < 0.01
  const backwards = Boolean(noteForTag(tag))

  return (
    <div className={`cell${isFinal ? ' cell-final' : ''}`}>
      <div className="cell-head mono">
        {first ? 'before learning' : isFinal ? 'after learning' : null}
        {!first && !isFinal ? `${timestepsForTag(tag).toLocaleString('en-US')} runs` : null}
      </div>
      <div className="cell-plot">
        <canvas ref={canvasRef} />
      </div>
      <div className={`cell-foot mono${backwards ? ' cell-warn' : ''}`}>
        {!doc ? 'loading' : flat ? 'no rule yet' : backwards ? 'learned it backwards' : 'a rule'}
      </div>
    </div>
  )
}

export default function Boundary({ playing, speed }) {
  const [surface, setSurface] = useState(SURFACES[0].id)
  const [, bump] = useState(0)
  const [status, setStatus] = useState(null)
  const headRef = useRef(0)

  const playingRef = useRef(playing)
  playingRef.current = playing
  const speedRef = useRef(speed)
  speedRef.current = speed

  // Every checkpoint of the current surface, plus the runs for the single line
  // the boundary was measured on. Sequential, so a slow connection fills the
  // row left to right rather than stalling on all of it at once.
  useEffect(() => {
    let alive = true
    setStatus(null)
    ;(async () => {
      for (const tag of LADDER_TAGS) {
        if (!alive) return
        try {
          const doc = peekBoundary(surface, tag) || (await loadBoundary(surface, tag))
          if (!alive) return
          bump((n) => n + 1)
          if (doc?.line && !peekRun(doc.line, tag)) {
            await loadRun(doc.line, tag)
            if (!alive) return
            bump((n) => n + 1)
          }
        } catch (err) {
          console.error(err.message)
          if (alive) setStatus(err.message)
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [surface])

  // One clock for the whole row, so the five fleets are the same moment.
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const step = (now) => {
      raf = requestAnimationFrame(step)
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      if (!playingRef.current) return
      const any = LADDER_TAGS.map((t) => {
        const d = peekBoundary(surface, t)
        return d?.line ? peekRun(d.line, t) : null
      }).find(Boolean)
      const n = any ? any.ticks.length : 200
      headRef.current = (headRef.current + dt * TICKS_PER_SEC * speedRef.current) % n
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [surface])

  const scaleRef = useDprCanvas((ctx, { width, height }) => drawScale(ctx, width, height))

  const finalDoc = peekBoundary(surface, FINAL_TAG)
  const line = finalDoc?.line
  const evenPct = line ? evennessPct(peekRun(line, FINAL_TAG)) : null
  const spacingPair = /headway_ahead/.test(finalDoc?.x?.feature || '')

  return (
    <div className="boundary">
      <div className="tabs">
        {SURFACES.map((s) => (
          <button
            key={s.id}
            className={`tab tab-wide mono${s.id === surface ? ' tab-on' : ''}`}
            onClick={() => setSurface(s.id)}
          >
            {s.label}
          </button>
        ))}
        <div className="boundary-caption mono">
          {line ? `measured on the ${line} line` : ''}
        </div>
      </div>

      <div className="cells">
        {LADDER_TAGS.map((tag, i) => (
          <Cell
            key={tag}
            surface={surface}
            tag={tag}
            headRef={headRef}
            first={i === 0}
            isFinal={tag === FINAL_TAG}
          />
        ))}
      </div>

      {/* The whole point of the panel, said outright rather than left to be
          inferred from a heatmap. */}
      <div className="rule">
        <p className="rule-text display">
          {spacingPair
            ? 'wait when you have caught up to the train ahead and the one behind is far back. go when you are running late and the train behind is close.'
            : 'wait longer at the platform when the train behind is still far away. leave promptly once it has closed up.'}
        </p>
        <p className="rule-sub">
          nobody wrote this rule. it was never told about spacing. it only knew how many
          people were waiting on the platforms.
        </p>
      </div>

      <div className="boundary-foot">
        <div className="scale">
          <canvas ref={scaleRef} />
        </div>
        <div className="note mono">
          {status ||
            'red means the train is likely to wait. each dot is a train, ringed while it is waiting at the platform.'}
          <br />
          0.33 on either gap axis is perfectly even spacing. below it the train has caught up
          to the one ahead. above it, it is running late.
          {evenPct !== null && (
            <strong>
              {' '}
              after learning, the {line} line is within 0.05 of even {evenPct.toFixed(1)}% of
              the time.
            </strong>
          )}
        </div>
      </div>
    </div>
  )
}
