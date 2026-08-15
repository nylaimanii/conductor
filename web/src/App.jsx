import { useEffect, useRef, useState } from 'react'
import { useDprCanvas } from './useDprCanvas.js'
import {
  LINE_IDS,
  nearestTagFor,
  loadRun,
  peekRun,
  tagsNeeded,
  timestepsFor,
  TOTAL_TIMESTEPS,
} from './runs.js'
import { sampleLine, captureOffsets, withOffsets } from './sample.js'
import { easeOutCubic, clamp01 } from './easing.js'
import { drawScene } from './scene.js'
import { drawRibbons, ribbonHeight } from './ribbons.js'
import Compare from './Compare.jsx'

function ViewSwitch({ view, setView }) {
  return (
    <div className="viewswitch">
      {['network', 'compare'].map((v) => (
        <button
          key={v}
          className={`vbtn mono${v === view ? ' vbtn-on' : ''}`}
          onClick={() => setView(v)}
        >
          {v}
        </button>
      ))}
    </div>
  )
}

// The one breakpoint. Below it the network shows a single line at a time,
// because five lines at phone width is an unreadable tangle. This is the only
// place layout branches on width.
function useIsNarrow() {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches
  )
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 760px)')
    const on = (e) => setNarrow(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return narrow
}

// Ticks consumed per second at 1x. The runs hold 200 subsampled ticks, so a
// full pass is a bit under twenty seconds.
const TICKS_PER_SEC = 12

export default function App() {
  const [view, setView] = useState('network')
  const narrow = useIsNarrow()
  const [soloLine, setSoloLine] = useState('L')
  const [scrub, setScrub] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [, bump] = useState(0)

  const focusRef = useRef(null)
  focusRef.current = narrow ? soloLine : null

  const scrubRef = useRef(scrub)
  scrubRef.current = scrub
  const playingRef = useRef(playing)
  playingRef.current = playing
  const speedRef = useRef(speed)
  speedRef.current = speed
  const headRef = useRef(0)
  const sampledRef = useRef([])

  // Lazy load: only the checkpoints the current scrubber value actually
  // brackets are ever requested, and each file is fetched at most once.
  useEffect(() => {
    let alive = true
    for (const { line, tags } of tagsNeeded(scrub)) {
      for (const tag of tags) {
        if (peekRun(line, tag)) continue
        loadRun(line, tag)
          .then(() => alive && bump((n) => n + 1))
          .catch((err) => console.error('run load failed', line, tag, err))
      }
    }
    return () => {
      alive = false
    }
  }, [scrub])

  // Per line: the tag currently on screen, plus any in flight swap.
  const shownRef = useRef(new Map())
  const transitionRef = useRef(new Map())
  const SWAP_SECONDS = 0.55

  const stageRef = useDprCanvas((ctx, { width, height, dt, t }) => {
    if (playingRef.current) headRef.current += dt * TICKS_PER_SEC * speedRef.current

    const u = scrubRef.current
    const any = peekRun('L', '000')
    const n = any ? any.ticks.length : 200
    if (headRef.current >= n) headRef.current -= n
    const head = headRef.current

    const sampled = []
    for (const line of LINE_IDS) {
      const want = nearestTagFor(line, u)
      const shown = shownRef.current.get(line)
      // Keep drawing the tag already on screen until the wanted one has landed,
      // so dragging never stalls the trains on a network hiccup.
      const doc = peekRun(line, want) || (shown ? peekRun(line, shown) : null)
      if (!doc) continue

      const state = sampleLine(doc, head)

      if (shown !== doc.tag) {
        const prev = shown ? sampledRef.current.find((s) => s.line === line) : null
        if (prev) {
          transitionRef.current.set(line, {
            offsets: captureOffsets(prev, state),
            elapsed: 0,
          })
        }
        shownRef.current.set(line, doc.tag)
      }

      const tr = transitionRef.current.get(line)
      if (tr) {
        tr.elapsed += dt
        const p = clamp01(tr.elapsed / SWAP_SECONDS)
        if (p >= 1) transitionRef.current.delete(line)
        // Residual travel, eased out so the trains settle into the new spacing.
        sampled.push(withOffsets(state, tr.offsets, 1 - easeOutCubic(p)))
      } else {
        sampled.push(state)
      }
    }

    sampledRef.current = sampled
    drawScene(ctx, {
      width,
      height,
      lines: sampled,
      t,
      focus: focusRef.current,
      // The rivers are placed against the whole network, so they only make
      // sense when the whole network is on screen.
      backdrop: !focusRef.current,
    })
  })

  const ribbonRef = useDprCanvas((ctx, { width, height, t }) => {
    const all = sampledRef.current
    const rows = focusRef.current ? all.filter((s) => s.line === focusRef.current) : all
    drawRibbons(ctx, { width, height, lines: rows, t })
  })

  // Hero figure: mean headway coefficient of variation across the visible
  // lines. Wait time is a consequence of this number, not the other way round.
  const [hero, setHero] = useState({ cv: null, wait: null, hold: null })
  useEffect(() => {
    const id = setInterval(() => {
      const all = sampledRef.current
      const s = focusRef.current ? all.filter((x) => x.line === focusRef.current) : all
      if (!s.length) return
      setHero({
        cv: s.reduce((a, x) => a + x.cvRun, 0) / s.length,
        wait: s.reduce((a, x) => a + x.meanWait, 0) / s.length,
        hold: s.reduce((a, x) => a + x.holdRun, 0) / s.length,
      })
    }, 120)
    return () => clearInterval(id)
  }, [])

  if (view === 'compare') {
    return (
      <div className="app">
        <div className="topbar">
          <h1 className="headline display">
            same day, same riders. the policy on the right learned to space its trains.
          </h1>
          <ViewSwitch view={view} setView={setView} />
        </div>
        <Compare playing={playing} speed={speed} />
        <div className="controls">
          <button className="btn" onClick={() => setPlaying((p) => !p)}>
            {playing ? 'pause' : 'play'}
          </button>
          <button className="btn mono" onClick={() => setSpeed((s) => (s === 1 ? 2 : 1))}>
            {speed}x
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <div className="topbar">
        <h1 className="headline display">
          these trains are teaching themselves to space out. drag the bar to watch them learn.
        </h1>
        <ViewSwitch view={view} setView={setView} />
      </div>

      {narrow && (
        <div className="tabs">
          {LINE_IDS.map((id) => (
            <button
              key={id}
              className={`tab mono${id === soloLine ? ' tab-on' : ''}`}
              onClick={() => setSoloLine(id)}
            >
              {id}
            </button>
          ))}
        </div>
      )}

      <div className="stage">
        <canvas ref={stageRef} />
      </div>

      <div className="panel">
        <div className="hero">
          <div className="hero-label">headway spread, cv</div>
          <div className="hero-value mono">{hero.cv === null ? '--' : hero.cv.toFixed(3)}</div>
          <div className="hero-sub">lower is evenly spaced</div>
        </div>
        <div className="hero">
          <div className="hero-label">hold rate</div>
          <div className="hero-value mono">
            {hero.hold === null ? '--' : `${(hero.hold * 100).toFixed(0)}%`}
          </div>
          <div className="hero-sub">the policy's only action</div>
        </div>
        <div className="ribbons" style={{ height: ribbonHeight(narrow ? 1 : LINE_IDS.length) }}>
          <canvas ref={ribbonRef} />
        </div>
        <div className="secondary">
          <div className="sec-label">mean wait</div>
          <div className="sec-value mono">{hero.wait === null ? '--' : hero.wait.toFixed(2)}</div>
          <div className="sec-unit mono">min</div>
        </div>
      </div>

      <div className="controls">
        <button className="btn" onClick={() => setPlaying((p) => !p)}>
          {playing ? 'pause' : 'play'}
        </button>
        <button className="btn mono" onClick={() => setSpeed((s) => (s === 1 ? 2 : 1))}>
          {speed}x
        </button>
        <input
          className="scrubber"
          type="range"
          min={0}
          max={1000}
          value={Math.round(scrub * 1000)}
          onChange={(e) => setScrub(Number(e.target.value) / 1000)}
          aria-label="training progress"
        />
      </div>
      <p className="note">
        training progress · {timestepsFor(scrub).toLocaleString('en-US')} /{' '}
        {TOTAL_TIMESTEPS.toLocaleString('en-US')} timesteps
      </p>
    </div>
  )
}
