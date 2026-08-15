// Run file access. Everything here is shaped by /contract.md and nothing else.
//
//   path   /runs/{LINE}_{TAG}.json
//   tags   every line has baseline plus the training ladder below.

export const LINE_IDS = ['L', 'G', '7', '1', '6']

// THE TRAINING LADDER. One definition, everything else derives from it.
//
// Each entry pairs the tag in the filename with the point in training it was
// cut at, as a fraction of the full run. Re-cutting the ladder is an edit to
// this array and nothing else: the scrubber, the timestep readout, the lazy
// loader and the learning curve all read it.
//
// tag is the {TAG} in /runs/{LINE}_{TAG}.json. baseline is not on the ladder,
// it is the published timetable the policy is measured against.
// Training was early stopped at 012, which is the shipped policy, so the
// denominator is the run that actually happened rather than the one originally
// planned. The tag numbers are percent of the original 20M run; frac is the
// position along the shipped run, which is what the scrubber travels.
//
// note is shown when that rung is the one driving the screen. Training is not
// monotonic and 003 is genuinely worse than the rung before it, so the curve
// says why rather than hiding it. A ladder picked to look smooth would be a
// worse account of what happened.
// 000 is the honest before-learning anchor. 001 is not untrained: it already
// holds a meaningful fraction of the time, so using it as the reference
// understated everything training bought.
const LADDER = [
  { tag: '000', frac: 0 },
  { tag: '001', frac: 1 / 12 },
  { tag: '003', frac: 0.25, note:
      'a quarter of the way through training, it started holding trains far too often and made things worse than doing nothing.' },
  { tag: '006', frac: 0.5 },
  { tag: '012', frac: 1 },
]

export const TOTAL_TIMESTEPS = 2_400_000

export const LADDER_TAGS = LADDER.map((c) => c.tag)
export const LADDER_FRACS = LADDER.map((c) => c.frac)

// Nearest checkpoint position. The scrubber only has five meaningful stops, so
// the handle sits on one of them rather than anywhere between.
export const snapToRung = (u) => nearestRung(u).frac

// The two ends of the ladder. Named rather than spelled out at each use, so a
// re-cut does not leave a stale tag hiding in a comparison somewhere.
export const FIRST_TAG = LADDER[0].tag
export const FINAL_TAG = LADDER[LADDER.length - 1].tag

// Timesteps a given tag was cut at.
export const timestepsForTag = (tag) =>
  Math.round((LADDER.find((c) => c.tag === tag)?.frac ?? 0) * TOTAL_TIMESTEPS)

// Which checkpoint drives a line at a given scrubber value.
//
// The scrubber swaps the driving file rather than blending two of them. Two
// checkpoints are independent simulations: they drift arbitrarily far apart
// over a run, and once they sit half a loop apart the shortest way round
// between them flips, which teleports a train across the map mid drag. The
// swap is made to feel continuous by easing the trains from their old
// arrangement into the new one, which is a decaying offset rather than a live
// blend of two moving targets.
function nearestRung(u) {
  const v = Math.max(0, Math.min(1, u))
  let best = LADDER[0]
  // Ties resolve to the later checkpoint, so the midpoint of a two rung ladder
  // reads as trained rather than untrained.
  for (const c of LADDER) if (Math.abs(c.frac - v) <= Math.abs(best.frac - v)) best = c
  return best
}

export const nearestTagFor = (line, u) => nearestRung(u).tag

// Timesteps of training represented by a scrubber value, snapped to the
// checkpoint actually driving the screen so the number cannot claim a stage
// that is not being shown.
export const timestepsFor = (u) => Math.round(nearestRung(u).frac * TOTAL_TIMESTEPS)

// Commentary for the rung currently on screen, or null if it needs none.
export const noteFor = (u) => nearestRung(u).note ?? null

// Every tag needed for a given scrubber value: exactly one file per line.
export function tagsNeeded(u) {
  const tag = nearestRung(u).tag
  return LINE_IDS.map((line) => ({ line, tags: [tag] }))
}

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
      // A dev server with an SPA fallback answers a missing run with 200 and
      // the index page, so status alone cannot tell a delivered run from an
      // absent one. Without this check a missing file surfaces only as a JSON
      // parse error somewhere downstream, and the line silently vanishes from
      // the diagram with nothing pointing at the cause.
      const type = r.headers.get('content-type') || ''
      if (!type.includes('json')) {
        throw new Error(`run ${key} is missing: server answered with ${type || 'no content type'}`)
      }
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

