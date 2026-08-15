import { INK, TILE, LINE_COLORS, MONO_FONT } from './palette.js'
import { clamp01, phaseFor } from './easing.js'
import { featureFor, axisFeature } from './interp.js'

// THE DECISION BOUNDARY.
//
// Every other panel shows what the policy did. This one shows the rule it
// learned: P(hold) over two observation features, with the live fleet plotted
// on top. A train crossing the edge is the moment the rule fires, which is the
// thing the trains and the ribbons can only show the consequences of.

// Sequential ramp, tile through amber to red. Low P(hold) sits at the page
// color so the eye reads the hot region as the added thing, and it stays in
// the project palette rather than importing a rainbow.
//
// FIXED SCALE, PINNED TO [0,1]. This is not a styling choice, it carries the
// argument. The untrained field spans 0.4988 to 0.4992: four ten thousandths
// of numerical noise out of a network that has learned nothing. Normalising
// each file to its own range would stretch that noise across the full ramp and
// draw a vivid structured map of nothing, which is exactly the claim the panel
// exists to refute. Flat against structured is only honest if both are
// measured against the same ruler.
const STOPS = [
  [0.0, [239, 235, 228]],
  [0.5, [232, 176, 75]],
  [1.0, [216, 80, 60]],
]

export function ramp(v) {
  const t = clamp01(v)
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const [t0, c0] = STOPS[i - 1]
      const [t1, c1] = STOPS[i]
      const u = (t - t0) / (t1 - t0 || 1)
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * u),
        Math.round(c0[1] + (c1[1] - c0[1]) * u),
        Math.round(c0[2] + (c1[2] - c0[2]) * u),
      ]
    }
  }
  return STOPS[STOPS.length - 1][1]
}

// The field is static per checkpoint, so it is rasterised once at grid
// resolution and scaled up on draw. Repainting 1600 cells every frame would be
// wasted work and would fight the live dots for frame budget.
const fieldCache = new WeakMap()

function fieldFor(doc) {
  const hit = fieldCache.get(doc)
  if (hit) return hit
  const res = doc.grid?.nx || doc.resolution || doc.p_hold.length
  const c = document.createElement('canvas')
  c.width = res
  c.height = res
  const ctx = c.getContext('2d')
  const img = ctx.createImageData(res, res)
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      // Row 0 of the matrix is the bottom of the y range, and canvas y grows
      // downward, so the row index is flipped on the way in.
      const v = doc.p_hold[res - 1 - y]?.[x] ?? 0
      const [r, g, b] = ramp(v)
      const i = (y * res + x) * 4
      img.data[i] = r
      img.data[i + 1] = g
      img.data[i + 2] = b
      img.data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  fieldCache.set(doc, c)
  return c
}

const PAD = { l: 54, r: 16, t: 14, b: 40 }

export function drawBoundary(ctx, opts) {
  const { width, height, doc, lines, t, showTrains = true } = opts

  ctx.fillStyle = TILE
  ctx.fillRect(0, 0, width, height)
  if (!doc) return

  // The grid is square and both axes are normalised to [0,1], so the plot is
  // drawn square. Stretching it to the panel skews the gradient and makes a
  // boundary read as steeper in whichever direction happens to be shorter.
  const availW = Math.max(10, width - PAD.l - PAD.r)
  const availH = Math.max(10, height - PAD.t - PAD.b)
  const side = Math.min(availW, availH)
  const w = side
  const h = side
  const ox = PAD.l + (availW - side) / 2
  const oy = PAD.t + (availH - side) / 2

  // The field, smoothed. It is a probability surface sampled on a coarse grid,
  // so interpolating between samples is a fairer picture of it than blocks.
  ctx.save()
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(fieldFor(doc), ox, oy, w, h)
  ctx.restore()

  ctx.strokeStyle = INK
  ctx.lineWidth = 2
  ctx.strokeRect(ox, oy, w, h)

  const ax = doc.x || {}
  const ay = doc.y || {}
  const x0 = ax.min ?? 0
  const x1 = ax.max ?? 1
  const y0 = ay.min ?? 0
  const y1 = ay.max ?? 1
  const px = (v) => ox + ((v - x0) / (x1 - x0 || 1)) * w
  const py = (v) => oy + h - ((v - y0) / (y1 - y0 || 1)) * h

  // Axes.
  ctx.font = `500 11px ${MONO_FONT}`
  ctx.fillStyle = INK
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillText(axisFeature(doc.x) || 'x', ox + w / 2, oy + h + 20)
  ctx.save()
  ctx.translate(14, oy + h / 2)
  ctx.rotate(-Math.PI / 2)
  ctx.fillText(axisFeature(doc.y) || 'y', 0, 0)
  ctx.restore()

  ctx.font = `500 9px ${MONO_FONT}`
  ctx.fillStyle = 'rgba(22,24,26,0.6)'
  ctx.textAlign = 'left'
  ctx.fillText(String(x0), ox, oy + h + 6)
  ctx.textAlign = 'right'
  ctx.fillText(String(x1), ox + w, oy + h + 6)
  ctx.textAlign = 'right'
  ctx.textBaseline = 'bottom'
  ctx.fillText(String(y1), ox - 6, oy + 10)
  ctx.textBaseline = 'top'
  ctx.fillText(String(y0), ox - 6, oy + h - 10)

  // Where the shipped policy actually operates. Most of the swept domain is
  // extrapolation the policy never sees, and an edge out there is not evidence
  // of a learned rule, so the region that matters is marked.
  const obs = doc.observed_range
  if (obs?.x && obs?.y) {
    const rx = px(obs.x[0])
    const ry = py(obs.y[1])
    const rw = px(obs.x[1]) - rx
    const rh = py(obs.y[0]) - ry
    ctx.save()
    // Everything outside the region is knocked back, so the eye lands on the
    // part of the surface the policy actually visits. Structure out in the
    // extrapolated corners is not evidence of a learned rule.
    ctx.fillStyle = 'rgba(239,235,228,0.62)'
    ctx.beginPath()
    ctx.rect(ox, oy, w, h)
    ctx.rect(rx, ry, rw, rh)
    ctx.fill('evenodd')
    ctx.setLineDash([4, 3])
    ctx.lineWidth = 1.5
    ctx.strokeStyle = 'rgba(22,24,26,0.75)'
    ctx.strokeRect(rx, ry, rw, rh)
    ctx.setLineDash([])
    ctx.font = `500 9px ${MONO_FONT}`
    ctx.fillStyle = 'rgba(22,24,26,0.75)'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'bottom'
    ctx.fillText('where it actually operates', rx + 2, ry - 3)
    ctx.restore()
  }

  if (!showTrains) return

  // The live fleet, in the policy's own coordinates. A train that is holding
  // gets a ring, the same mark it carries on the map, so the two panels can be
  // read against each other.
  for (const s of lines || []) {
    const color = LINE_COLORS[s.line]
    for (let i = 0; i < s.trains.length; i++) {
      const tr = s.trains[i]
      const fx = featureFor(axisFeature(doc.x), tr)
      const fy = featureFor(axisFeature(doc.y), tr)
      if (fx === null || fy === null) continue

      // Clamped to the plot, so a train outside the sampled range still shows
      // at the edge instead of vanishing without explanation.
      const cx = Math.max(ox, Math.min(ox + w, px(fx)))
      const cy = Math.max(oy, Math.min(oy + h, py(fy)))
      const ph = phaseFor(`${s.line}:${i}`) * Math.PI * 2
      const bob = Math.sin(t * 1.6 + ph) * 0.4

      if (tr.holding) {
        const pulse = Math.sin(t * 3.4 + ph * 2) * 0.5 + 0.5
        ctx.beginPath()
        ctx.arc(cx, cy + bob, 6 + pulse * 3.5, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(22,24,26,${0.55 - pulse * 0.3})`
        ctx.lineWidth = 1.5
        ctx.setLineDash([2.5, 2.5])
        ctx.stroke()
        ctx.setLineDash([])
      }

      ctx.beginPath()
      ctx.arc(cx, cy + bob, 4.4, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
      ctx.lineWidth = 1.6
      ctx.strokeStyle = INK
      ctx.stroke()
    }
  }
}

// Legend strip for the ramp.
export function drawScale(ctx, width, height) {
  ctx.clearRect(0, 0, width, height)
  const w = Math.max(10, width - 92)
  for (let i = 0; i < w; i++) {
    const [r, g, b] = ramp(i / (w - 1))
    ctx.fillStyle = `rgb(${r},${g},${b})`
    ctx.fillRect(i, 4, 1, height - 16)
  }
  ctx.strokeStyle = INK
  ctx.lineWidth = 1
  ctx.strokeRect(0.5, 4.5, w - 1, height - 17)
  ctx.font = `500 9px ${MONO_FONT}`
  ctx.fillStyle = INK
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillText('P(hold)  0', w + 6, height / 2)
  ctx.textAlign = 'right'
  ctx.fillText('1', width, height / 2)
}
