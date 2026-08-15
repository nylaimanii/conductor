import {
  circuitAt,
  circuitLength,
  lerpCircuit,
  deltaCircuit,
  posFromCircuit,
  gapsOf,
  cvOf,
  runCv,
  directionsFor,
} from './headway.js'

const lerp = (a, b, f) => a + (b - a) * f

// The state actually drawn for one line at one moment, from one run file.
//
// Time interpolation between adjacent ticks is what makes 200 subsampled ticks
// read as smooth motion, and it happens in circuit space so that a train
// rounding a terminal does not jump.
export function sampleLine(run, tickFloat) {
  if (!run) return null
  const N = run.stations.length - 1
  const C = circuitLength(run)
  const n = run.ticks.length

  const k0 = Math.max(0, Math.min(n - 1, Math.floor(tickFloat)))
  const k1 = Math.min(n - 1, k0 + 1)
  const ft = tickFloat - Math.floor(tickFloat)

  const c0 = circuitAt(run, k0)
  const c1 = circuitAt(run, k1)
  const dirs = directionsFor(run)[k0]

  const cs = []
  const trains = []
  for (let i = 0; i < c0.length; i++) {
    const c = lerpCircuit(c0[i], c1[i], ft, C)
    cs.push(c)
    const tr = run.ticks[k0].trains[i]
    trains.push({
      c,
      pos: posFromCircuit(c, N),
      onboard: tr.onboard,
      holding: tr.holding,
      dir: dirs[i] > 0 ? 1 : -1,
    })
  }

  const w0 = run.ticks[k0].waiting
  const w1 = run.ticks[k1].waiting
  const waiting = w0.map((v, s) => Math.max(0, Math.round(lerp(v, w1[s] ?? v, ft))))

  const gaps = gapsOf(cs, C)

  return {
    line: run.line,
    tag: run.tag,
    label: run.label,
    stations: run.stations,
    capacity: run.capacity,
    trains,
    waiting,
    gaps,
    circuit: C,
    cvNow: cvOf(gaps),
    cvRun: runCv(run),
    meanWait: run.metrics.mean_wait,
    baselineWait: run.metrics.baseline_wait,
    improvement: run.metrics.improvement_pct,
  }
}

// Captures how far each train has to travel to get from the arrangement on
// screen to the arrangement in the newly selected checkpoint. The offsets
// decay to zero, so the swap reads as the trains sliding into their new
// spacing rather than cutting to it.
export function captureOffsets(prevState, nextState) {
  if (!prevState || !nextState) return null
  const C = nextState.circuit
  const n = Math.min(prevState.trains.length, nextState.trains.length)

  // Match by rank around the loop so no train crosses another on the way, then
  // pick the rotation with the least total travel. Resolved once per swap, so
  // there is no moving target to become unstable.
  const pa = prevState.trains.map((t) => t.c)
  const pb = nextState.trains.map((t) => t.c)
  const orderA = pa.map((_, i) => i).slice(0, n).sort((p, q) => pa[p] - pa[q])
  const orderB = pb.map((_, i) => i).slice(0, n).sort((p, q) => pb[p] - pb[q])

  let best = null
  for (let r = 0; r < n; r++) {
    let cost = 0
    for (let i = 0; i < n; i++) {
      cost += Math.abs(deltaCircuit(pb[orderB[(i + r) % n]], pa[orderA[i]], C))
    }
    if (best === null || cost < best.cost) best = { cost, r }
  }

  const offsets = new Float64Array(nextState.trains.length)
  for (let i = 0; i < n; i++) {
    const ai = orderA[i]
    const bi = orderB[(i + best.r) % n]
    offsets[bi] = deltaCircuit(pb[bi], pa[ai], C)
  }
  return offsets
}

// Re-derives everything the scene and the ribbon read, with the residual
// transition offset applied. Positions, gaps and cv stay consistent with each
// other because they all come from the same shifted circuit coordinates.
export function withOffsets(state, offsets, amount) {
  if (!state || !offsets || amount <= 0.001) return state
  const C = state.circuit
  const N = state.stations.length - 1

  const cs = []
  const trains = state.trains.map((t, i) => {
    const c = ((t.c + (offsets[i] || 0) * amount) % C + C) % C
    cs.push(c)
    return { ...t, c, pos: posFromCircuit(c, N) }
  })

  const gaps = gapsOf(cs, C)
  return { ...state, trains, gaps, cvNow: cvOf(gaps) }
}
