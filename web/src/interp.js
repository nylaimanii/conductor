// Decision boundary files. Separate from runs.js because this is a different
// artifact with a different owner: runs are trajectories, these are a slice
// through the policy itself.
//
//   path  /interp/boundary_{TAG}.json
//
// See tools/gen-boundary.mjs for the shape this expects.

// The feature pairings sim exports. Both are slices through the same policy at
// the same checkpoint, so they share the checkpoint toggle.
//
// id matches the pair_id carried in each file. The filename convention is
// recorded here rather than inferred, and the loaded doc is checked against it,
// so a file that does not contain the pairing it is named for is caught rather
// than mislabelled on screen.
export const SURFACES = [
  { id: 'primary', label: 'dwell x headway behind', file: (tag) => `boundary_${tag}` },
  { id: 'spacing', label: 'headway ahead x behind', file: (tag) => `boundary_spacing_${tag}` },
]

const fileFor = (surface, tag) =>
  (SURFACES.find((s) => s.id === surface) || SURFACES[0]).file(tag)

const cache = new Map()
const inflight = new Map()

export function loadBoundary(surface, tag) {
  const key = fileFor(surface, tag)
  if (cache.has(key)) return Promise.resolve(cache.get(key))
  if (inflight.has(key)) return inflight.get(key)

  const p = fetch(`${import.meta.env.BASE_URL}interp/${key}.json`)
    .then((r) => {
      if (!r.ok) throw new Error(`boundary ${key} returned ${r.status}`)
      // Same trap as the run files: an SPA fallback answers a missing file with
      // 200 and the index page.
      const type = r.headers.get('content-type') || ''
      if (!type.includes('json')) {
        throw new Error(`boundary ${key} is missing: server answered with ${type || 'no type'}`)
      }
      return r.json()
    })
    .then((doc) => {
      if (doc?.pair_id && doc.pair_id !== surface) {
        throw new Error(
          `boundary ${key} carries pair_id "${doc.pair_id}" but was loaded as "${surface}"`
        )
      }
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

export const peekBoundary = (surface, tag) => cache.get(fileFor(surface, tag)) || null

// Actual span of the field, so the panel can state it rather than leaving the
// reader to trust that a flat looking map is really flat.
export function spanOf(doc) {
  if (!doc?.p_hold) return null
  let lo = Infinity
  let hi = -Infinity
  for (const row of doc.p_hold) {
    for (const v of row) {
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  }
  return Number.isFinite(lo) ? { lo, hi } : null
}

// Where a train sits in the policy's decision space.
//
// The axes are the policy's own observation features, normalised inside sim's
// environment. They cannot be recovered from the run files: the contract gives
// pos, onboard and holding, and the scaling sim applies to build an observation
// is not derivable from those. Reconstructing them by guessing a normalisation
// would put every dot in the wrong place while looking entirely plausible,
// which is the worst outcome for a panel whose whole claim is that this is the
// rule the policy actually learned.
//
// So the value is read from the train, not computed here. If a run carries the
// feature values, the dots plot. If it does not, the panel says so and draws
// the field alone rather than inventing coordinates.
export function featureFor(feature, train) {
  const v = train?.obs?.[feature]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export const axisFeature = (axis) => (typeof axis === 'string' ? axis : axis?.feature) ?? null

export function axesResolvable(doc, state) {
  if (!doc || !state || !state.trains.length) return false
  const t = state.trains[0]
  return (
    featureFor(axisFeature(doc.x), t) !== null && featureFor(axisFeature(doc.y), t) !== null
  )
}
