import { INK, MONO_FONT } from './palette.js'

// Headway spread against training timesteps: the learning curve itself.
//
// Points arrive as checkpoints load, so the curve fills in rather than waiting
// on a complete set. Anything not yet loaded is simply not plotted.

export function drawSparkline(ctx, opts) {
  const { width, height, points, at } = opts
  ctx.clearRect(0, 0, width, height)
  if (!points || points.length === 0) return

  const padL = 4
  const padR = 26
  const padY = 7
  const w = Math.max(1, width - padL - padR)
  const h = Math.max(1, height - padY * 2)

  const maxX = Math.max(...points.map((p) => p.x)) || 1
  // Anchored at zero so the shape reads as a drop to the floor rather than as
  // whatever the loaded subset happens to span.
  const maxY = Math.max(...points.map((p) => p.y), 0.001)

  const px = (x) => padL + (x / maxX) * w
  const py = (y) => padY + (1 - y / maxY) * h

  // Baseline rule at cv zero.
  ctx.beginPath()
  ctx.moveTo(padL, py(0))
  ctx.lineTo(padL + w, py(0))
  ctx.strokeStyle = 'rgba(22,24,26,0.18)'
  ctx.lineWidth = 1
  ctx.stroke()

  const sorted = [...points].sort((a, b) => a.x - b.x)

  ctx.beginPath()
  sorted.forEach((p, i) => (i ? ctx.lineTo(px(p.x), py(p.y)) : ctx.moveTo(px(p.x), py(p.y))))
  ctx.strokeStyle = INK
  ctx.lineWidth = 1.6
  ctx.lineJoin = 'round'
  ctx.stroke()

  for (const p of sorted) {
    ctx.beginPath()
    ctx.arc(px(p.x), py(p.y), 2, 0, Math.PI * 2)
    ctx.fillStyle = INK
    ctx.fill()
  }

  // Where the scrubber currently sits.
  if (at !== undefined && at !== null) {
    const cx = px(Math.min(at, maxX))
    ctx.beginPath()
    ctx.moveTo(cx, padY - 3)
    ctx.lineTo(cx, padY + h + 3)
    ctx.strokeStyle = 'rgba(22,24,26,0.45)'
    ctx.lineWidth = 1
    ctx.stroke()
  }

  ctx.font = `500 9px ${MONO_FONT}`
  ctx.fillStyle = 'rgba(22,24,26,0.55)'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText('cv', padL + w + 5, py(0) - h / 2)
}
