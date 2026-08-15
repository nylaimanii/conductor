import { useEffect, useRef, useState } from 'react'
import { useDprCanvas } from './useDprCanvas.js'
import { LINE_IDS, loadRun, peekRun } from './runs.js'
import { sampleLine } from './sample.js'
import { drawScene } from './scene.js'
import { drawRibbons, ribbonHeight } from './ribbons.js'

// Split screen: the same line, the same passenger demand, the untrained policy
// on the left and the trained one on the right, both driven off one playhead so
// the two sides are always the same moment of the same day.

const TICKS_PER_SEC = 12

function Side({ line, tag, headRef, label, onState }) {
  const stateRef = useRef(null)

  const canvasRef = useDprCanvas((ctx, { width, height, t }) => {
    const doc = peekRun(line, tag)
    if (!doc) {
      ctx.clearRect(0, 0, width, height)
      return
    }
    const s = sampleLine(doc, headRef.current)
    stateRef.current = s
    onState(s)
    drawScene(ctx, { width, height, lines: [s], t })
  })

  const ribbonRef = useDprCanvas((ctx, { width, height, t }) => {
    const s = stateRef.current
    drawRibbons(ctx, { width, height, lines: s ? [s] : [], t })
  })

  return (
    <div className="side">
      <div className="side-head display">{label}</div>
      <div className="side-stage">
        <canvas ref={canvasRef} />
      </div>
      <div className="side-ribbon" style={{ height: ribbonHeight(1) }}>
        <canvas ref={ribbonRef} />
      </div>
    </div>
  )
}

export default function Compare({ playing, speed }) {
  const [line, setLine] = useState('L')
  const [, bump] = useState(0)
  const headRef = useRef(0)
  const leftRef = useRef(null)
  const rightRef = useRef(null)
  const [stats, setStats] = useState(null)

  const playingRef = useRef(playing)
  playingRef.current = playing
  const speedRef = useRef(speed)
  speedRef.current = speed

  // Only the two files this comparison needs, fetched when the line changes.
  useEffect(() => {
    let alive = true
    for (const tag of ['baseline', '100']) {
      if (peekRun(line, tag)) continue
      loadRun(line, tag)
        .then(() => alive && bump((n) => n + 1))
        .catch((err) => console.error('run load failed', line, tag, err))
    }
    return () => {
      alive = false
    }
  }, [line])

  // One clock for both sides.
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const step = (now) => {
      raf = requestAnimationFrame(step)
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      if (!playingRef.current) return
      const doc = peekRun(line, 'baseline')
      const n = doc ? doc.ticks.length : 200
      headRef.current = (headRef.current + dt * TICKS_PER_SEC * speedRef.current) % n
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [line])

  useEffect(() => {
    const id = setInterval(() => {
      const l = leftRef.current
      const r = rightRef.current
      if (!l || !r) return
      setStats({
        cvL: l.cvRun,
        cvR: r.cvRun,
        holdL: l.holdRun,
        holdR: r.holdRun,
        waitL: l.meanWait,
        waitR: r.meanWait,
        improvement: r.improvement,
      })
    }, 150)
    return () => clearInterval(id)
  }, [])

  // The headline figure is the drop in headway spread. Wait time follows from
  // it, so it is reported underneath rather than in place of it.
  const cvDrop =
    stats && stats.cvL > 0 ? ((stats.cvL - stats.cvR) / stats.cvL) * 100 : null

  return (
    <div className="compare">
      <div className="tabs">
        {LINE_IDS.map((id) => (
          <button
            key={id}
            className={`tab mono${id === line ? ' tab-on' : ''}`}
            onClick={() => setLine(id)}
          >
            {id}
          </button>
        ))}
      </div>

      <div className="split">
        <Side
          line={line}
          tag="baseline"
          headRef={headRef}
          label="baseline"
          onState={(s) => (leftRef.current = s)}
        />
        <Side
          line={line}
          tag="100"
          headRef={headRef}
          label="trained"
          onState={(s) => (rightRef.current = s)}
        />
      </div>

      <div className="metrics">
        <div className="metric metric-hero">
          <div className="metric-label">headway spread, cv</div>
          <div className="metric-pair mono">
            <span className="was">{stats ? stats.cvL.toFixed(3) : '--'}</span>
            <span className="arrow">to</span>
            <span className="now">{stats ? stats.cvR.toFixed(3) : '--'}</span>
          </div>
          <div className="metric-delta mono">
            {cvDrop === null ? '' : `${cvDrop.toFixed(0)}% more even`}
          </div>
        </div>
        <div className="metric metric-hero">
          <div className="metric-label">hold rate</div>
          <div className="metric-pair mono">
            <span className="was">{stats ? `${(stats.holdL * 100).toFixed(0)}%` : '--'}</span>
            <span className="arrow">to</span>
            <span className="now">{stats ? `${(stats.holdR * 100).toFixed(0)}%` : '--'}</span>
          </div>
          <div className="metric-delta mono">the policy's only action</div>
        </div>
        <div className="metric">
          <div className="metric-label">mean wait</div>
          <div className="metric-pair mono small">
            <span className="was">{stats ? stats.waitL.toFixed(2) : '--'}</span>
            <span className="arrow">to</span>
            <span className="now">{stats ? stats.waitR.toFixed(2) : '--'}</span>
          </div>
          <div className="metric-delta mono">
            {stats ? `${stats.improvement.toFixed(1)}% shorter` : ''}
          </div>
        </div>
      </div>
    </div>
  )
}
