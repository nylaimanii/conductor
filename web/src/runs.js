// Run file access. Everything here is shaped by /contract.md and nothing else.
//
//   path   /runs/{LINE}_{TAG}.json
//   tags   L has 000 025 050 100 baseline. G 7 1 6 have 000 100 baseline.

export const LINE_IDS = ['L', 'G', '7', '1', '6']

// Training checkpoints as numbers, so the scrubber can bracket them. The
// baseline tag is deliberately not here: it is the comparison run for the
// split screen, not a point on the training timeline.
const CHECKPOINTS = {
  L: [0, 25, 50, 100],
  G: [0, 100],
  7: [0, 100],
  1: [0, 100],
  6: [0, 100],
}

export const tagFor = (n) => String(n).padStart(3, '0')

const cache = new Map()
const inflight = new Map()

// Lazy by construction: nothing is fetched until someone asks for that exact
// line and tag. Nothing is prefetched on mount.
export function loadRun(line, tag) {
  const key = `${line}_${tag}`
  if (cache.has(key)) return Promise.resolve(cache.get(key))
  if (inflight.has(key)) return inflight.get(key)

  const p = fetch(`${import.meta.env.BASE_URL}runs/${key}.json`)
    .then((r) => {
      if (!r.ok) throw new Error(`run ${key} returned ${r.status}`)
      return r.json()
    })
    .then((doc) => {
      cache.set(key, doc)
      inflight.delete(key)
      return doc
    })
    .catch((err) => {
      inflight.delete(key)
      throw err
    })

  inflight.set(key, p)
  return p
}

export const peekRun = (line, tag) => cache.get(`${line}_${tag}`) || null

// Which checkpoint file drives a line at a given scrubber value.
//
// The scrubber swaps the driving file rather than blending two of them. Two
// checkpoints are independent simulations: they drift arbitrarily far apart
// over a run, and once they sit half a loop apart the shortest way round
// between them flips, which teleports a train across the map mid drag. The
// swap is made to feel continuous by easing the trains from their old
// arrangement into the new one, which is a decaying offset rather than a live
// blend of two moving targets.
export function nearestTagFor(line, u) {
  const cps = CHECKPOINTS[line]
  const v = Math.max(0, Math.min(100, u * 100))
  let best = cps[0]
  for (const c of cps) if (Math.abs(c - v) < Math.abs(best - v)) best = c
  return tagFor(best)
}

// Every tag needed for a given scrubber value: exactly one file per line.
export function tagsNeeded(u) {
  return LINE_IDS.map((line) => ({ line, tags: [nearestTagFor(line, u)] }))
}
