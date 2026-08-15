// Station coordinates come straight from the run file. The web app does zero
// layout math, per the contract: it only walks between the points sim gave it.

// pos is a float station index. 3.42 means 42 percent of the way from station
// 3 to station 4.
export function posToXY(stations, pos) {
  const last = stations.length - 1
  const p = Math.max(0, Math.min(last, pos))
  const i = Math.min(last - 1, Math.floor(p))
  const f = p - i
  const a = stations[i]
  const b = stations[i + 1]
  return {
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
    angle: Math.atan2(b.y - a.y, b.x - a.x),
  }
}

// Bounding box over every station of every loaded line, used to fit the
// diagram to the viewport. Fitting is not layout: the shape is already fixed
// by sim, this only chooses a scale and an offset.
export function boundsOf(docs) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const doc of docs) {
    if (!doc) continue
    for (const s of doc.stations) {
      if (s.x < minX) minX = s.x
      if (s.x > maxX) maxX = s.x
      if (s.y < minY) minY = s.y
      if (s.y > maxY) maxY = s.y
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  return { minX, minY, maxX, maxY }
}

export function fitTransform(bounds, width, height, pad = 34) {
  const w = bounds.maxX - bounds.minX || 1
  const h = bounds.maxY - bounds.minY || 1
  const scale = Math.min((width - pad * 2) / w, (height - pad * 2) / h)
  return {
    scale,
    dx: (width - w * scale) / 2 - bounds.minX * scale,
    dy: (height - h * scale) / 2 - bounds.minY * scale,
  }
}
