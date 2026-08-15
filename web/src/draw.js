import { DARK_INK as INK, WAIT_COLORS, MONO_FONT } from './palette.js'
import { phaseFor, squashStretch, clamp01, easeOutBack } from './easing.js'

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

  // THE ACTION, MADE VISIBLE.
  //
  // Holding is the only thing the policy ever does, and without a mark it is
  // indistinguishable from a train that happens to be stopped. The ring pulses
  // outward and fades, so a held train reads as being acted upon rather than
  // as merely parked. Drawn in ink rather than in one of the wait colors so it
  // cannot be misread as a passenger state.
  if (opts.holding) {
    const pulse = Math.sin(t * 3.4 + ph * 2) * 0.5 + 0.5
    const grow = 3.5 + pulse * 5
    ctx.save()
    ctx.shadowColor = 'rgba(150,225,255,0.95)'
    ctx.shadowBlur = 10 + pulse * 16
    capsule(ctx, 0, 0, L + grow * 2, T + grow * 2, angle)
    ctx.lineWidth = 1.4
    ctx.strokeStyle = `rgba(170,230,255,${0.5 - pulse * 0.22})`
    ctx.stroke()
    ctx.restore()
  }

  // A train sits on top of a line of its own color, so without a halo it reads
  // as a thickening of the line rather than as a vehicle. The tile colored
  // stroke cuts it free of the track before the ink outline goes on.
  // Soft edged block with a rim light. No face, no eyes.
  capsule(ctx, 0, 0, L, T, angle)
  ctx.save()
  ctx.shadowColor = color
  ctx.shadowBlur = 14
  ctx.fillStyle = color
  ctx.fill()
  ctx.restore()

  ctx.save()
  capsule(ctx, 0, 0, L, T, angle)
  ctx.clip()
  const rim = ctx.createLinearGradient(0, -T / 2, 0, T / 2)
  rim.addColorStop(0, 'rgba(255,255,255,0.5)')
  rim.addColorStop(0.45, 'rgba(255,255,255,0.05)')
  rim.addColorStop(1, 'rgba(0,0,0,0.35)')
  ctx.fillStyle = rim
  ctx.fillRect(-L, -T, L * 2, T * 2)
  ctx.restore()


  ctx.restore()
}

// Passenger dots stacked at a station. Visible dots are capped at CAP and the
// remainder is shown as a mono count, otherwise a busy station kills framerate.
export const PASSENGER_CAP = 8

// Passengers cluster beside their platform rather than trailing off in a line.
// A single file queue of eight dots is longer than the gap between stations, so
// the crowds of neighbouring stops run into each other and into the other
// lines. A compact block of four across by two deep stays local to its station
// at every zoom the diagram is drawn at.
//
// waits is an array of state strings: 'calm' | 'waiting' | 'stranded'.
// tx,ty is the unit tangent along the line, nx,ny the unit normal pointing to
// the side the crowd stands on. lean slides the block toward the platform edge.
const PER_ROW = 4

export function drawPassengers(ctx, opts) {
  const {
    x,
    y,
    waits = [],
    t = 0,
    id = 'stn',
    tx = 1,
    ty = 0,
    nx = 0,
    ny = -1,
    lean = 0,
    dotR = 2.9,
    gap = 2.2,
  } = opts

  const shown = Math.min(waits.length, PASSENGER_CAP)
  if (shown === 0) return
  const step = dotR * 2 + gap
  const standoff = 10.5
  // count is the fractional queue length. Riders board one at a time off it.
  const level = opts.count === undefined ? waits.length : opts.count

  for (let i = 0; i < shown; i++) {
    const state = waits[i] || 'calm'
    const ph = phaseFor(`${id}:${i}`) * Math.PI * 2

    // Staggered boarding. Each dot leaves on its own threshold, jittered by a
    // stable per rider phase, so a crowd drains as a run of individuals rather
    // than every dot shrinking at once. The jitter spans roughly a tenth of a
    // tick, which at playback speed lands in the forty to sixty millisecond
    // band that stops it reading as a single mechanical event.
    const jitter = phaseFor(`board:${id}:${i}`) * 0.55
    const presence = clamp01(level - i + jitter)
    if (presence <= 0.001) continue
    // Overshoot on the way in, so a rider arriving on the platform settles
    // rather than blinking into place.
    const grow = easeOutBack(presence)

    // Each dot drifts on its own clock so the crowd reads as individuals
    // rather than one shape pulsing in unison.
    const sway = Math.sin(t * 1.15 + ph) * 0.55
    const breathe = 1 + Math.sin(t * 2.1 + ph) * 0.05

    const col = i % PER_ROW
    const row = Math.floor(i / PER_ROW)
    const along = (col - (PER_ROW - 1) / 2) * step + sway
    // Lean pulls the block in toward the track a beat before arrival, and a
    // boarding rider slides the last of the way in as they go.
    const out = standoff + row * step - lean * 3.4 - (1 - presence) * 4

    const px = x + tx * along + nx * out
    const py = y + ty * along + ny * out

    const c = WAIT_COLORS[state] || WAIT_COLORS.calm
    ctx.save()
    ctx.shadowColor = c
    ctx.shadowBlur = 7
    ctx.beginPath()
    ctx.arc(px, py, Math.max(0.1, dotR * breathe * grow), 0, Math.PI * 2)
    ctx.fillStyle = c
    ctx.fill()
    ctx.restore()
  }

  const hidden = waits.length - shown
  if (hidden > 0) {
    const rows = Math.ceil(shown / PER_ROW)
    const out = standoff + rows * step - lean * 3.4
    ctx.font = `500 9px ${MONO_FONT}`
    ctx.fillStyle = INK
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(`+${hidden}`, x + nx * out, y + ny * out)
  }
}

// Station tick on the line. Vignelli style: a plain dot, ink ringed.
// A glowing node. Brightness is carried by the caller through alpha, so a
// crowded platform reads hotter than an empty one.
export function drawStation(ctx, x, y, r = 4.2, glow = 0) {
  ctx.save()
  ctx.shadowColor = 'rgba(200,235,255,0.9)'
  ctx.shadowBlur = 6 + glow * 14
  ctx.beginPath()
  ctx.arc(x, y, r * 0.72, 0, Math.PI * 2)
  ctx.fillStyle = `rgba(232,245,255,${0.75 + glow * 0.25})`
  ctx.fill()
  ctx.restore()
}
