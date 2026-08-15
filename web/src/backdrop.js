// Static backdrop: the Hudson, the East River, and the harbour.
//
// Only the water is drawn. The tile color already reads as land, so painting
// the boroughs as well would mean two more masses competing for attention
// behind five saturated line colors for no gain. Water alone gives the diagram
// somewhere to sit.
//
// Schematic blobs, not coastline. Every edge is 45 or 90 degrees, built from a
// vertex list that only ever steps axis aligned or exactly diagonal. Nothing
// here is a function of time: this layer never animates.

const WATER = '#0C1218'

// Coordinates are in the same space sim writes station x,y into. The shapes
// deliberately run well past the station bounds so they bleed off every edge
// instead of floating as islands inside the frame.
const SHAPES = [
  // Hudson, down the west side.
  [
    [-600, -400],
    [40, -400],
    [40, 120],
    [10, 150],
    [10, 420],
    [60, 470],
    [60, 900],
    [-600, 900],
  ],
  // East River, running southwest between Manhattan and the far boroughs.
  [
    [500, -400],
    [580, -400],
    [580, 120],
    [420, 280],
    [420, 900],
    [350, 900],
    [350, 250],
    [500, 100],
  ],
  // Harbour across the bottom.
  [
    [-600, 700],
    [1600, 700],
    [1600, 1000],
    [-600, 1000],
  ],
]

export function drawBackdrop(ctx) {
  ctx.save()
  // Land first, then water over it, so both read as plates just above the
  // background rather than as the page colour showing through.
  ctx.fillStyle = '#12171C'
  ctx.fillRect(-600, -400, 2200, 1400)
  ctx.fillStyle = WATER
  for (const pts of SHAPES) {
    ctx.beginPath()
    ctx.moveTo(pts[0][0], pts[0][1])
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1])
    ctx.closePath()
    ctx.fill()
  }
  ctx.restore()
}

// Guards the geometry above: every edge must be axis aligned or an exact
// diagonal. Called by the shape test rather than at runtime.
export function offAngleEdges() {
  const bad = []
  SHAPES.forEach((pts, s) => {
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i]
      const [x1, y1] = pts[(i + 1) % pts.length]
      const dx = Math.abs(x1 - x0)
      const dy = Math.abs(y1 - y0)
      const ok = dx === 0 || dy === 0 || dx === dy
      if (!ok) bad.push({ shape: s, from: [x0, y0], to: [x1, y1] })
    }
  })
  return bad
}


// The same shapes, tagged, for the dark renderer. Land is not drawn in the
// light theme because the page colour already reads as land; against a near
// black ground it has to be drawn explicitly or the water has nothing to be
// water against.
export const PLATES = [
  { water: false, pts: [[-600, -400], [1600, -400], [1600, 1000], [-600, 1000]] },
  ...SHAPES.map((pts) => ({ water: true, pts })),
]
