// Headway math, derived entirely from fields the contract already provides.
//
// The contract gives pos as a float station index but says nothing about which
// way a train is travelling. Direction is recoverable: a train keeps its index
// in the trains array across ticks, so the sign of the change in pos over the
// next tick is its heading. That matters because a line is run out and back,
// so two trains at the same pos heading opposite ways are not near each other
// in service terms at all. Measuring gaps without direction bottoms out around
// cv 0.5 even for a perfect policy and is not even monotonic.
//
// With direction recovered, every train maps onto a circuit coordinate:
//   outbound  c = pos
//   inbound   c = 2N - pos
// where N is the last station index. The circuit is a loop of length 2N, gaps
// along it are true headways, and their coefficient of variation is the number
// the whole project is about. Wait scales with 1 + cv squared.

const dirCache = new WeakMap()
const cvCache = new WeakMap()

export const circuitLength = (doc) => 2 * (doc.stations.length - 1)

// Heading per train per tick. Carried forward through turnarounds and dwells,
// where the change in pos is zero and the sign says nothing.
export function directionsFor(doc) {
  const hit = dirCache.get(doc)
  if (hit) return hit

  const { ticks } = doc
  const nTrains = ticks[0]?.trains.length ?? 0
  const out = ticks.map(() => new Int8Array(nTrains))

  for (let i = 0; i < nTrains; i++) {
    // Only ticks where the train actually moved carry a heading. A train
    // sitting at a platform has a flat pos and says nothing about which way it
    // is pointed, and so does a train that has not moved yet at tick zero.
    const raw = new Int8Array(ticks.length)
    for (let k = 0; k < ticks.length - 1; k++) {
      const d = ticks[k + 1].trains[i].pos - ticks[k].trains[i].pos
      raw[k] = Math.abs(d) > 1e-9 ? (d > 0 ? 1 : -1) : 0
    }

    // Fill the silent ticks from the next tick that did move. A dwelling train
    // belongs to the direction it is about to depart in, which is the direction
    // its riders are queued for. Guessing a default here instead puts the train
    // on the wrong branch of the circuit and throws its position out by twice
    // its distance from the terminal.
    for (let k = ticks.length - 2; k >= 0; k--) if (raw[k] === 0) raw[k] = raw[k + 1]
    // Anything still unset is a trailing dwell, which inherits from before it.
    for (let k = 1; k < ticks.length; k++) if (raw[k] === 0) raw[k] = raw[k - 1]

    for (let k = 0; k < ticks.length; k++) out[k][i] = raw[k] || 1
  }
  dirCache.set(doc, out)
  return out
}

const moveCache = new WeakMap()

// Ticks until each train next moves. A train whose pos is unchanged across a
// tick is sitting at a platform, and knowing how long is left before it pulls
// away is what lets it dip backward in anticipation first. Computed with one
// backward pass and memoized.
export function ticksToMove(doc) {
  const hit = moveCache.get(doc)
  if (hit) return hit

  const { ticks } = doc
  const n = ticks.length
  const nTrains = ticks[0]?.trains.length ?? 0
  const out = Array.from({ length: n }, () => new Float32Array(nTrains))

  for (let i = 0; i < nTrains; i++) {
    // Nothing is known past the end of the run, so treat it as far away.
    out[n - 1][i] = 99
    for (let k = n - 2; k >= 0; k--) {
      const moved = Math.abs(ticks[k + 1].trains[i].pos - ticks[k].trains[i].pos) > 1e-9
      out[k][i] = moved ? 0 : out[k + 1][i] + 1
    }
  }
  moveCache.set(doc, out)
  return out
}

// Circuit coordinates of every train at tick index k.
export function circuitAt(doc, k) {
  const C = circuitLength(doc)
  const N = doc.stations.length - 1
  const dirs = directionsFor(doc)[k]
  return doc.ticks[k].trains.map((tr, i) =>
    dirs[i] > 0 ? tr.pos : (C - tr.pos) % C
  )
}

export const posFromCircuit = (c, N) => {
  const C = 2 * N
  const m = ((c % C) + C) % C
  return m <= N ? m : C - m
}

// Signed shortest way round the loop from a to b.
export function deltaCircuit(a, b, C) {
  let d = ((b - a) % C + C) % C
  if (d > C / 2) d -= C
  return d
}

// Shortest path interpolation around the loop, so a train never streaks the
// long way round when two runs disagree about where it is.
export function lerpCircuit(a, b, f, C) {
  return ((a + deltaCircuit(a, b, C) * f) % C + C) % C
}

// Sorted gaps between consecutive trains around the circuit. This is exactly
// what one ribbon draws, so the ribbon and the cv are the same quantity.
export function gapsOf(cs, C) {
  if (cs.length === 0) return []
  const s = [...cs].sort((p, q) => p - q)
  const gaps = []
  for (let i = 0; i < s.length; i++) {
    gaps.push(i === s.length - 1 ? s[0] + C - s[i] : s[i + 1] - s[i])
  }
  return gaps
}

export function cvOf(gaps) {
  if (gaps.length < 2) return 0
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length
  if (mean <= 0) return 0
  const varr = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length
  return Math.sqrt(varr) / mean
}

// Share of train ticks sitting behind a gap far larger than even spacing.
// Even is a third; this counts anything past 0.6, roughly a gap almost twice
// what it should be, which is the moment a rider is left standing on a platform
// watching nothing arrive. Derived from the run, not quoted.
const LONG_GAP = 0.6
export function longGapPct(run) {
  if (!run?.ticks) return null
  let total = 0
  let big = 0
  for (const tick of run.ticks) {
    for (const tr of tick.trains) {
      const v = tr?.obs?.headway_ahead_ratio
      if (typeof v !== 'number') continue
      total++
      if (v > LONG_GAP) big++
    }
  }
  return total ? (big / total) * 100 : null
}

const holdCache = new WeakMap()

// Fraction of train ticks the policy spent holding a train at a platform.
//
// This is the policy itself rather than a consequence of it. Holding is the
// only action the agent has, so an untrained run reads exactly zero and a
// trained one reads whatever it learned to use. It comes straight from the
// holding flag the contract already carries, so sim's real values land here
// with no change on this side.
export function holdRate(doc) {
  const hit = holdCache.get(doc)
  if (hit !== undefined) return hit
  let held = 0
  let total = 0
  for (const tick of doc.ticks) {
    for (const tr of tick.trains) {
      total++
      if (tr.holding) held++
    }
  }
  const v = total ? held / total : 0
  holdCache.set(doc, v)
  return v
}

// Run level cv, averaged over every tick. Memoized: this walks the whole run.
export function runCv(doc) {
  const hit = cvCache.get(doc)
  if (hit !== undefined) return hit
  const C = circuitLength(doc)
  let acc = 0
  for (let k = 0; k < doc.ticks.length; k++) acc += cvOf(gapsOf(circuitAt(doc, k), C))
  const v = doc.ticks.length ? acc / doc.ticks.length : 0
  cvCache.set(doc, v)
  return v
}
