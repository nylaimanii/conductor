// Easing and timing helpers for the aliveness pass.
// Rule for this project: nothing is linear, nothing stops dead.

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
export const clamp01 = (v) => clamp(v, 0, 1)

// Standard settle, used when overshoot would read as sloppy.
export const easeOutCubic = (t) => 1 - Math.pow(1 - clamp01(t), 3)

export const easeInOutCubic = (t) => {
  const x = clamp01(t)
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}

// Overshoot settle. s controls how far past 1 it travels before coming back.
// s = 1.70158 is the classic ~10 percent overshoot.
export const easeOutBack = (t, s = 1.70158) => {
  const x = clamp01(t) - 1
  return x * x * ((s + 1) * x + s) + 1
}

// Anticipation: dip backward before moving forward. Returns a value that goes
// slightly negative early on, then travels to 1. This is the highest payoff
// curve in the project, used for train departures.
export const easeInOutBack = (t, s = 1.70158) => {
  const x = clamp01(t)
  const c = s * 1.525
  return x < 0.5
    ? (Math.pow(2 * x, 2) * ((c + 1) * 2 * x - c)) / 2
    : (Math.pow(2 * x - 2, 2) * ((c + 1) * (x * 2 - 2) + c) + 2) / 2
}

// Damped spring settle sampled as a closed form, cheaper than integrating.
// Reads livelier than easeOut for things that snap into place.
export const springOut = (t, freq = 3, decay = 6) => {
  const x = clamp01(t)
  if (x === 1) return 1
  return 1 - Math.exp(-decay * x) * Math.cos(freq * Math.PI * x)
}

// One frame of recoil, used when a passenger cannot board.
// Sharp kick out, soft return.
export const recoil = (t) => {
  const x = clamp01(t)
  return x < 0.18 ? x / 0.18 : Math.pow(1 - (x - 0.18) / 0.82, 2)
}

// Squash and stretch. Volume preserving, capped to the 5 to 8 percent band so
// it never tips into cartoon.
// amount is signed: positive stretches along travel, negative squashes.
export function squashStretch(amount, cap = 0.08) {
  const a = clamp(amount, -cap, cap)
  const along = 1 + a
  return { along, across: 1 / along }
}

// Deterministic per-object phase so idle motion never pulses in unison.
// Feed it a stable id, get back a number in [0, 1).
export function phaseFor(id) {
  const s = String(id)
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100000) / 100000
}

// Staggered start offset in seconds for the nth item in a group.
// The project spec is 40 to 60ms, jittered per item so it is not a metronome.
export function stagger(index, id = index) {
  return index * (0.04 + phaseFor(`stagger:${id}`) * 0.02)
}
