import { useEffect, useRef, useState } from 'react'
import { useDprCanvas } from './useDprCanvas.js'
import {
  LINE_IDS,
  nearestTagFor,
  loadRun,
  peekRun,
  tagsNeeded,
  timestepsFor,
  timestepsForTag,
  noteFor,
  LADDER_TAGS,
  FIRST_TAG,
  TOTAL_TIMESTEPS,
} from './runs.js'
import { sampleLine, captureOffsets, withOffsets } from './sample.js'
import { easeOutCubic, clamp01 } from './easing.js'
import { drawScene } from './scene.js'
import { drawRibbons, ribbonHeight } from './ribbons.js'
import { drawSparkline } from './sparkline.js'
import { runCv, holdRate } from './headway.js'
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

// The learning curve for the featured line. L is the only line cut at all four
// checkpoints, so it is the one that can show a curve rather than two points.
//
// The ladder is fetched once the first frame is up rather than on mount, so it
// never competes with getting trains on screen. Four small files, requested
// through the same cache as everything else, so nothing is fetched twice.
const CURVE_LINE = 'L'
// Derived from the single ladder definition in runs.js, so re-cutting the
// checkpoints does not leave the learning curve plotting the old ones.
const CURVE_LADDER = LADDER_TAGS.map((tag) => ({ tag, steps: timestepsForTag(tag) }))

// Idle loads the two reference runs every line needs: the timetable baseline
// and the untrained policy. The headline compares against both live, at the
// same tick as what is on screen, so those files have to be resident before
// the comparison can be made. Also reports the untrained hold rate, which is
// what tells a trained hold rate apart from a random one.
//
// Variance reduction is deliberately not offered anywhere: it is the largest
// of the available figures and reads as cherry picking.
function useReferenceRuns() {
  const [refs, setRefs] = useState({ baseline: null, untrained: null, firstHold: null })
  useEffect(() => {
    let alive = true
    const collect = () => {
      const all = (tag) => {
        const docs = LINE_IDS.map((l) => peekRun(l, tag))
        return docs.some((d) => !d) ? null : docs
      }
      const avgCv = (docs) => (docs ? docs.reduce((a, d) => a + runCv(d), 0) / docs.length : null)
      const untr = all(FIRST_TAG)
      if (!alive) return
      setRefs({
        baseline: avgCv(all('baseline')),
        untrained: avgCv(untr),
        firstHold: untr ? untr.reduce((a, d) => a + holdRate(d), 0) / untr.length : null,
      })
    }
    const start = () => {
      for (const line of LINE_IDS) {
        for (const tag of ['baseline', FIRST_TAG]) {
          loadRun(line, tag)
            .then(collect)
            .catch((err) => console.error('reference run unavailable:', err.message))
        }
      }
    }
    const idle = window.requestIdleCallback
      ? window.requestIdleCallback(start, { timeout: 2500 })
      : setTimeout(start, 900)
    return () => {
      alive = false
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle)
      else clearTimeout(idle)
    }
  }, [])
  return refs
}

function useCvCurve() {
  const [points, setPoints] = useState([])
  useEffect(() => {
    let alive = true
    const collect = () => {
      const pts = []
      for (const { tag, steps } of CURVE_LADDER) {
        const doc = peekRun(CURVE_LINE, tag)
        if (doc) pts.push({ x: steps, y: runCv(doc) })
      }
      if (alive) setPoints(pts)
    }
    const start = () => {
      for (const { tag } of CURVE_LADDER) {
        loadRun(CURVE_LINE, tag)
          .then(collect)
          .catch((err) => console.error('curve checkpoint unavailable:', err.message))
      }
    }
    const idle = window.requestIdleCallback
      ? window.requestIdleCallback(start, { timeout: 2500 })
      : setTimeout(start, 900)
    return () => {
      alive = false
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle)
      else clearTimeout(idle)
    }
  }, [])
  return points
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
  const curve = useCvCurve()
  const refs = useReferenceRuns()
  // 'all' or a line id. Desktop defaults to the whole network: the transfer
  // moment is four lines the policy never trained on equalizing at once, and
  // that only reads if they are on screen together. Narrow screens cannot fit
  // five lines, so they fall back to a single line and lose that reading.
  const [focusSel, setFocusSel] = useState('all')
  const [scrub, setScrub] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [, bump] = useState(0)

  const focus = narrow ? (focusSel === 'all' ? 'L' : focusSel) : focusSel === 'all' ? null : focusSel
  const focusRef = useRef(null)
  focusRef.current = focus

  const scrubRef = useRef(scrub)
  scrubRef.current = scrub
  const playingRef = useRef(playing)
  playingRef.current = playing
  const speedRef = useRef(speed)
  speedRef.current = speed
  const headRef = useRef(0)
  const sampledRef = useRef([])
  const liveRef = useRef({ cv: null, baseline: null, untrained: null })

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
    const any = peekRun(LINE_IDS[0], FIRST_TAG)
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

    // Live headway spread, and the same figure for the timetable and the
    // untrained policy at this exact moment of the run. Comparing a live value
    // against a run average would be comparing two different things, and the
    // untrained runs start evenly spaced and fall apart over the run, so the
    // two disagree most at the point a judge first looks.
    const liveCv = (tag) => {
      const docs = LINE_IDS.map((l) => peekRun(l, tag))
      if (docs.some((d) => !d)) return null
      return docs.reduce((a, d) => a + sampleLine(d, head).cvNow, 0) / docs.length
    }
    liveRef.current = {
      cv: sampled.length ? sampled.reduce((a, x) => a + x.cvNow, 0) / sampled.length : null,
      baseline: liveCv('baseline'),
      untrained: liveCv(FIRST_TAG),
    }

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

  const curveRef = useRef(curve)
  curveRef.current = curve
  const sparkRef = useDprCanvas((ctx, { width, height }) => {
    drawSparkline(ctx, {
      width,
      height,
      points: curveRef.current,
      at: timestepsFor(scrubRef.current),
    })
  })

  const ribbonRef = useDprCanvas((ctx, { width, height, t }) => {
    const all = sampledRef.current
    const rows = focusRef.current ? all.filter((s) => s.line === focusRef.current) : all
    drawRibbons(ctx, { width, height, lines: rows, t })
  })

  // Hero figure: mean headway coefficient of variation across the visible
  // lines. Wait time is a consequence of this number, not the other way round.
  const [hero, setHero] = useState({ cv: null, cvRun: null, wait: null, hold: null })
  useEffect(() => {
    // Exponential smoothing. The live spread genuinely jitters tick to tick, and
    // an unsmoothed readout flickers too fast to read without misrepresenting
    // anything. Slow enough to settle, fast enough to follow a drag.
    const ease = (prev, next) => (prev === null || next === null ? next : prev + (next - prev) * 0.25)
    const id = setInterval(() => {
      const all = sampledRef.current
      const s = focusRef.current ? all.filter((x) => x.line === focusRef.current) : all
      if (!s.length) return
      const live = liveRef.current
      setHero((h) => ({
        // Live, so it agrees with the ribbons directly beneath it.
        cv: ease(h.cv, focusRef.current ? s[0].cvNow : live.cv),
        // Run level, for the comparisons. Both the timetable and the untrained
        // policy start evenly spaced and come apart over the run, so comparing
        // two single ticks is dominated by where in that decay each happens to
        // be. It swings tens of percent within a second and changes sign.
        cvRun: s.reduce((a, x) => a + x.cvRun, 0) / s.length,
        wait: s.reduce((a, x) => a + x.meanWait, 0) / s.length,
        hold: s.reduce((a, x) => a + x.holdRun, 0) / s.length,
      }))
    }, 120)
    return () => clearInterval(id)
  }, [])

  // Headline: how far below the published timetable the spread now sits.
  // Scrubber: how far below the untrained policy, which is what training bought.
  const pct = (from, to) =>
    from !== null && from > 0 && to !== null && to !== undefined ? ((from - to) / from) * 100 : null
  const vsTimetable = pct(refs.baseline, hero.cvRun)
  const vsUntrained = pct(refs.untrained, hero.cvRun)

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

      <div className="tabs">
        {!narrow && (
          <button
            className={`tab tab-wide mono${focusSel === 'all' ? ' tab-on' : ''}`}
            onClick={() => setFocusSel('all')}
          >
            all
          </button>
        )}
        {LINE_IDS.map((id) => (
          <button
            key={id}
            className={`tab mono${
              (narrow ? focusSel === 'all' ? 'L' : focusSel : focusSel) === id ? ' tab-on' : ''
            }`}
            onClick={() => setFocusSel(id)}
          >
            {id}
          </button>
        ))}
      </div>

      <div className="stage">
        <canvas ref={stageRef} />
      </div>

      <div className="panel">
        <div className="hero">
          <div className="hero-label">headway spread, cv</div>
          <div className="hero-value mono">{hero.cv === null ? '--' : hero.cv.toFixed(3)}</div>
          <div className="hero-sub">
            {vsTimetable === null
              ? 'lower is evenly spaced'
              : vsTimetable >= 0
                ? `${vsTimetable.toFixed(0)}% below the timetable, run average`
                : `${Math.abs(vsTimetable).toFixed(0)}% above the timetable, run average`}
          </div>
        </div>
        <div className="hero">
          <div className="hero-label">hold rate</div>
          <div className="hero-value mono">
            {hero.hold === null ? '--' : `${(hero.hold * 100).toFixed(0)}%`}
          </div>
          <div className="hero-sub">
            {/* Read from the data rather than assumed. Which way this moves
                depends on where the ladder is cut: a policy can learn to use
                the action, or learn to stop spending it. Both have been true
                of this run at different cuts, so the label follows the
                numbers instead of asserting a direction. */}
            {refs.firstHold === null || hero.hold === null
              ? "the policy's only action"
              : noteFor(scrub)
                ? 'holding, not yet aiming'
                : hero.hold > refs.firstHold * 1.3
                  ? 'learned to hold, and where'
                  : hero.hold < refs.firstHold * 0.7
                    ? 'fewer holds, better aimed'
                    : "the policy's only action"}
          </div>
        </div>
        <div
          className="ribbons"
          style={{ height: ribbonHeight(focus ? 1 : LINE_IDS.length) }}
        >
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
        <div className="spark">
          <canvas ref={sparkRef} />
        </div>
      </div>
      <p className="note">
        training progress · {timestepsFor(scrub).toLocaleString('en-US')} /{' '}
        {TOTAL_TIMESTEPS.toLocaleString('en-US')} timesteps
        {vsUntrained === null
          ? ''
          : vsUntrained >= 0
            ? ` · headway spread ${vsUntrained.toFixed(0)}% below untrained, run average`
            : ` · headway spread ${Math.abs(vsUntrained).toFixed(0)}% above untrained, run average`}
      </p>
      {noteFor(scrub) && <p className="note note-flag">{noteFor(scrub)}</p>}
    </div>
  )
}
