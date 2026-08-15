import { INK, WAIT_COLORS, MONO_FONT } from './palette.js'
import { phaseFor, squashStretch } from './easing.js'

// Pure drawing primitives. Nothing in here reads run data, everything takes
// explicit coordinates, so this module is stable regardless of the JSON shape.

// A fat rounded capsule. Drawn centered on x,y and rotated to angle.
export function capsule(ctx, x, y, len, thick, angle) {
  const r = thick / 2
  const half = Math.max(r, len / 2)
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)
  ctx.beginPath()
  ctx.moveTo(-half + r, -r)
  ctx.lineTo(half - r, -r)
  ctx.arc(half - r, 0, r, -Math.PI / 2, Math.PI / 2)
  ctx.lineTo(-half + r, r)
  ctx.arc(-half + r, 0, r, Math.PI / 2, -Math.PI / 2)
  ctx.closePath()
  ctx.restore()
}

// A train: fat capsule, two dot eyes at the leading end.
// squash is signed, positive stretches along travel (start), negative squashes
// across it (stop). Kept inside the 8 percent cap by squashStretch.
export function drawTrain(ctx, opts) {
  const {
    x,
    y,
    angle = 0,
    color,
    len = 34,
    thick = 15,
    squash = 0,
    id = 'train',
    t = 0,
  } = opts

  const { along, across } = squashStretch(squash)
  const L = len * along
  const T = thick * across

  // Idle micro-motion, randomized phase so a yard of trains never breathes in
  // unison. Sub pixel on purpose, it should read as life not as wobble.
  const ph = phaseFor(id) * Math.PI * 2
  const bob = Math.sin(t * 1.7 + ph) * 0.45

  ctx.save()
  ctx.translate(x, y + bob)

  capsule(ctx, 0, 0, L, T, angle)
  ctx.fillStyle = color
  ctx.fill()
  ctx.lineWidth = 2
  ctx.strokeStyle = INK
  ctx.stroke()

  // Eyes ride at the leading end, in the train's own rotated frame.
  ctx.rotate(angle)
  const eyeX = L / 2 - T * 0.38
  const eyeGap = T * 0.24
  const eyeR = Math.max(1.4, T * 0.11)
  // Blink is rare and per train, driven off the same stable phase.
  const blinkCycle = 3.6 + phaseFor(`blink:${id}`) * 3
  const blinkT = (t + ph) % blinkCycle
  const lidClosed = blinkT < 0.09
  ctx.fillStyle = INK
  for (const s of [-1, 1]) {
    ctx.beginPath()
    if (lidClosed) {
      ctx.ellipse(eyeX, s * eyeGap, eyeR, eyeR * 0.18, 0, 0, Math.PI * 2)
    } else {
      ctx.arc(eyeX, s * eyeGap, eyeR, 0, Math.PI * 2)
    }
    ctx.fill()
  }

  ctx.restore()
}

// Passenger dots stacked at a station. Visible dots are capped at CAP and the
// remainder is shown as a mono count, otherwise a busy station kills framerate.
export const PASSENGER_CAP = 8

// waits is an array of state strings: 'calm' | 'waiting' | 'stranded'.
// dir is the unit vector pointing toward the platform edge, used for the lean.
export function drawPassengers(ctx, opts) {
  const {
    x,
    y,
    waits = [],
    t = 0,
    id = 'stn',
    dirX = 0,
    dirY = -1,
    lean = 0,
    dotR = 3.1,
    gap = 2.4,
  } = opts

  const shown = Math.min(waits.length, PASSENGER_CAP)
  const step = dotR * 2 + gap

  for (let i = 0; i < shown; i++) {
    const state = waits[i] || 'calm'
    const ph = phaseFor(`${id}:${i}`) * Math.PI * 2
    // Each dot drifts on its own clock so the crowd reads as individuals.
    const sway = Math.sin(t * 1.15 + ph) * 0.7
    const breathe = 1 + Math.sin(t * 2.1 + ph) * 0.05

    // Lean toward the platform edge a beat before the train arrives.
    const lx = dirX * lean * (3 + (i % 3))
    const ly = dirY * lean * (3 + (i % 3))

    const px = x + dirY * (i * step - ((shown - 1) * step) / 2) + lx + sway
    const py = y - dirX * (i * step - ((shown - 1) * step) / 2) + ly

    ctx.beginPath()
    ctx.arc(px, py, dotR * breathe, 0, Math.PI * 2)
    ctx.fillStyle = WAIT_COLORS[state] || WAIT_COLORS.calm
    ctx.fill()
  }

  const hidden = waits.length - shown
  if (hidden > 0) {
    ctx.font = `500 10px ${MONO_FONT}`
    ctx.fillStyle = INK
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const ox = x + dirY * (shown * step - ((shown - 1) * step) / 2) + 2
    const oy = y - dirX * (shown * step - ((shown - 1) * step) / 2)
    ctx.fillText(`+${hidden}`, ox, oy)
  }
}

// Station tick on the line. Vignelli style: a plain dot, ink ringed.
export function drawStation(ctx, x, y, r = 4.2) {
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fillStyle = '#FFFFFF'
  ctx.fill()
  ctx.lineWidth = 2
  ctx.strokeStyle = INK
  ctx.stroke()
}
