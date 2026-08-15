import { LINE_COLORS, INK, MONO_FONT } from './palette.js'
import { clamp01 } from './easing.js'

// HEADWAY RIBBONS.
//
// One strip per line. Each segment is the gap between two consecutive trains
// around the circuit, so the strip is a direct picture of the headway
// distribution. Untrained, a few segments swallow the strip while others
// collapse to slivers. Trained, every segment settles to the same width.
//
// The dashed marker is the ideal segment width, circuit length over train
// count. It gives the eye something to converge on, which is what makes the
// equalizing read as correct rather than merely different.

const ROW_H = 30
const BAR_H = 15

export function drawRibbons(ctx, opts) {
  const { width, height, lines, t } = opts
  ctx.clearRect(0, 0, width, height)

  const rows = lines.filter(Boolean)
  if (rows.length === 0) return

  const labelW = 26
  const x0 = labelW + 8
  const barW = Math.max(40, width - x0 - 54)

  rows.forEach((s, r) => {
    const y = r * ROW_H + (height - rows.length * ROW_H) / 2 + ROW_H / 2
    const color = LINE_COLORS[s.line]

    ctx.font = `700 13px ${MONO_FONT}`
    ctx.fillStyle = INK
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(s.line, 4, y)

    // Trough.
    ctx.beginPath()
    ctx.roundRect(x0, y - BAR_H / 2, barW, BAR_H, BAR_H / 2)
    ctx.fillStyle = 'rgba(22,24,26,0.09)'
    ctx.fill()

    const total = s.gaps.reduce((a, b) => a + b, 0) || 1
    const ideal = total / Math.max(1, s.gaps.length)

    let cx = x0
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(x0, y - BAR_H / 2, barW, BAR_H, BAR_H / 2)
    ctx.clip()

    s.gaps.forEach((g, i) => {
      const w = (g / total) * barW
      // A segment far from ideal is drawn hotter and slightly taller, so the
      // uneven state reads as agitated rather than merely striped.
      const err = clamp01(Math.abs(g - ideal) / ideal)
      const h = BAR_H * (1 - 0.16 * err)
      // Idle shimmer, per segment phase, so the strip breathes when uneven and
      // goes still once the gaps equalize.
      const wob = Math.sin(t * 2.3 + i * 1.7) * err * 0.7

      ctx.beginPath()
      ctx.rect(cx + 0.75, y - h / 2 + wob, Math.max(0, w - 1.5), h)
      ctx.fillStyle = color
      ctx.globalAlpha = 0.45 + 0.55 * (1 - err)
      ctx.fill()
      ctx.globalAlpha = 1
      cx += w
    })
    ctx.restore()

    // Ideal width marker.
    ctx.save()
    ctx.setLineDash([3, 3])
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(22,24,26,0.5)'
    const step = (ideal / total) * barW
    for (let i = 1; i < s.gaps.length; i++) {
      const mx = x0 + step * i
      ctx.beginPath()
      ctx.moveTo(mx, y - BAR_H / 2 - 2)
      ctx.lineTo(mx, y + BAR_H / 2 + 2)
      ctx.stroke()
    }
    ctx.restore()

    ctx.font = `500 11px ${MONO_FONT}`
    ctx.fillStyle = INK
    ctx.textAlign = 'right'
    ctx.fillText(s.cvNow.toFixed(2), width - 4, y)
  })
}

export const ribbonHeight = (n) => n * ROW_H + 10
