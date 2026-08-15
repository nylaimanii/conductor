import { LINE_COLORS, TILE, INK } from './palette.js'
import { drawTrain, drawPassengers, drawStation } from './draw.js'
import { posToXY, boundsOf, fitTransform } from './geometry.js'
import { clamp01, easeOutBack, recoil } from './easing.js'

// The contract gives a passenger count per station, not per rider wait times,
// so the three wait colors are derived from queue depth. A queue only gets
// deep when trains are bunched, so depth is the honest stand in for wait: the
// riders at the front have been standing there longest.
export function waitStates(n) {
  const stressed = Math.max(0, n - 5)
  const critical = Math.max(0, n - 10)
  const out = []
  for (let i = 0; i < n; i++) {
    out.push(i < critical ? 'stranded' : i < stressed ? 'waiting' : 'calm')
  }
  return out
}

// Unit tangent along the line at a station, plus the normal the crowd stands
// on. The normal side is chosen deterministically, above horizontal runs and
// to the right of vertical ones, so crowds never flip sides as the diagram
// redraws and never land on top of the line itself.
function frameAt(stations, i) {
  const a = stations[Math.max(0, i - 1)]
  const b = stations[Math.min(stations.length - 1, i + 1)]
  let tx = b.x - a.x
  let ty = b.y - a.y
  const len = Math.hypot(tx, ty) || 1
  tx /= len
  ty /= len
  let nx = -ty
  let ny = tx
  if (ny > 0 || (Math.abs(ny) < 1e-6 && nx < 0)) {
    nx = -nx
    ny = -ny
  }
  return { tx, ty, nx, ny }
}

// How close the nearest inbound train is to each station, in station units.
// Drives the anticipation lean: the platform reacts a beat before arrival,
// which is the single cheapest thing that makes the scene feel alive.
function approachPerStation(sampled) {
  const out = new Array(sampled.stations.length).fill(Infinity)
  for (const tr of sampled.trains) {
    // Where this train reaches next, given the way it is heading.
    const target = tr.dir > 0 ? Math.ceil(tr.pos) : Math.floor(tr.pos)
    const d = Math.abs(target - tr.pos)
    if (target >= 0 && target < out.length && d < out[target]) out[target] = d
  }
  return out
}

export function drawScene(ctx, opts) {
  const { width, height, lines, t, focus = null } = opts

  ctx.fillStyle = TILE
  ctx.fillRect(0, 0, width, height)

  const docs = lines.filter(Boolean)
  if (docs.length === 0) return

  const bounds = boundsOf(docs)
  const { scale, dx, dy } = fitTransform(bounds, width, height)

  ctx.save()
  ctx.translate(dx, dy)
  ctx.scale(scale, scale)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  for (const s of docs) {
    if (focus && s.line !== focus) continue
    const color = LINE_COLORS[s.line]

    // Ink underlay then color, the Vignelli weight without a shadow.
    ctx.beginPath()
    ctx.moveTo(s.stations[0].x, s.stations[0].y)
    for (let i = 1; i < s.stations.length; i++) ctx.lineTo(s.stations[i].x, s.stations[i].y)
    ctx.lineWidth = 13
    ctx.strokeStyle = INK
    ctx.stroke()
    ctx.lineWidth = 9
    ctx.strokeStyle = color
    ctx.stroke()
  }

  for (const s of docs) {
    if (focus && s.line !== focus) continue
    const approach = approachPerStation(s)

    for (let i = 0; i < s.stations.length; i++) {
      const st = s.stations[i]
      drawStation(ctx, st.x, st.y, 4.6)

      const n = s.waiting[i] || 0
      if (n <= 0) continue

      // Lean toward the platform edge just before the train lands.
      const near = approach[i]
      const lean = Number.isFinite(near) ? easeOutBack(clamp01(1 - near / 0.7)) : 0

      // One frame of recoil when the platform is deep and the arriving train
      // has no room: the crowd surges and gets pushed back.
      const jammed = n > 10 && lean > 0.6
      const kick = jammed ? recoil(((t * 1.7) % 1)) * 1.6 : 0

      const fr = frameAt(s.stations, i)
      drawPassengers(ctx, {
        x: st.x,
        y: st.y,
        waits: waitStates(n),
        t,
        id: `${s.line}:${i}`,
        ...fr,
        lean: lean * 1.6 - kick,
      })
    }
  }

  for (const s of docs) {
    if (focus && s.line !== focus) continue
    const color = LINE_COLORS[s.line]

    for (let i = 0; i < s.trains.length; i++) {
      const tr = s.trains[i]
      const p = posToXY(s.stations, tr.pos)

      // Squash and stretch is driven by how close the train is to a platform.
      // Approaching, it compresses. Just released, it stretches. The dip
      // backward before departure is already baked into the circuit position
      // by the anticipation term below.
      const frac = Math.abs(tr.pos - Math.round(tr.pos))
      const atStation = clamp01(1 - frac / 0.18)
      const squash = tr.holding ? -0.07 * atStation : 0.06 * (1 - atStation) * clamp01(frac / 0.3)

      drawTrain(ctx, {
        x: p.x,
        y: p.y,
        angle: p.angle,
        color,
        len: 30,
        thick: 13,
        id: `${s.line}:${i}`,
        t,
        squash,
      })
    }
  }

  ctx.restore()
}
