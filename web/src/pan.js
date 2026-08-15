import { useEffect } from 'react'

// Pan and zoom for the dark scene.
//
// Affine only. A perspective tilt was built and cut: see the notes in the
// commit. This layers a pan in screen pixels and a zoom multiplier on top of
// the renderer's existing fit transform, which is the transform that has been
// painting reliably all along.

export function makeCamera2d() {
  return { panX: 0, panY: 0, zoom: 1, tPanX: 0, tPanY: 0, tZoom: 1, vx: 0, vy: 0 }
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 8

export function stepCamera2d(cam, dt) {
  const k = 1 - Math.exp(-dt * 10)
  const decay = Math.exp(-dt * 3.6)
  cam.tPanX += cam.vx * dt
  cam.tPanY += cam.vy * dt
  cam.vx *= decay
  cam.vy *= decay
  if (Math.abs(cam.vx) < 0.5) cam.vx = 0
  if (Math.abs(cam.vy) < 0.5) cam.vy = 0
  cam.tZoom = clamp(cam.tZoom, ZOOM_MIN, ZOOM_MAX)
  cam.panX += (cam.tPanX - cam.panX) * k
  cam.panY += (cam.tPanY - cam.panY) * k
  cam.zoom += (cam.tZoom - cam.zoom) * k
}

export function resetCamera2d(cam) {
  cam.tPanX = 0
  cam.tPanY = 0
  cam.tZoom = 1
  cam.vx = 0
  cam.vy = 0
}

// Drag to pan, wheel and pinch to zoom. Pointer events cover mouse, trackpad
// and touch in one path. A press that neither travels far nor lasts long is
// reported as a tap, so selecting a train and dragging the map stay separate.
export function usePanZoom(ref, cam, { onTap } = {}) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const pts = new Map()
    let last = null
    let moved = 0
    let downAt = 0
    let pinch = null

    const local = (e) => {
      const r = el.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const zoomAt = (px, py, factor) => {
      const before = cam.tZoom
      cam.tZoom = clamp(cam.tZoom * factor, ZOOM_MIN, ZOOM_MAX)
      const r = el.getBoundingClientRect()
      const cx = px - r.width / 2
      const cy = py - r.height / 2
      const g = cam.tZoom / before
      // Keep the point under the cursor fixed.
      cam.tPanX = (cam.tPanX + cx) * g - cx
      cam.tPanY = (cam.tPanY + cy) * g - cy
    }

    const down = (e) => {
      el.setPointerCapture?.(e.pointerId)
      pts.set(e.pointerId, local(e))
      if (pts.size === 1) {
        last = local(e)
        moved = 0
        downAt = performance.now()
        cam.vx = 0
        cam.vy = 0
      } else if (pts.size === 2) {
        const [a, b] = [...pts.values()]
        pinch = Math.hypot(a.x - b.x, a.y - b.y)
      }
    }
    const move = (e) => {
      if (!pts.has(e.pointerId)) return
      const p = local(e)
      pts.set(e.pointerId, p)
      if (pts.size === 2 && pinch) {
        const [a, b] = [...pts.values()]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        if (pinch > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinch)
        pinch = d
        return
      }
      if (!last) return
      const ddx = p.x - last.x
      const ddy = p.y - last.y
      cam.tPanX -= ddx
      cam.tPanY -= ddy
      cam.vx = -ddx * 12
      cam.vy = -ddy * 12
      moved += Math.hypot(ddx, ddy)
      last = p
    }
    const up = () => {
      const quick = performance.now() - downAt < 350
      if (pts.size <= 1) pinch = null
      pts.clear()
      if (moved < 6 && quick && onTap && last) onTap(last)
      last = null
    }
    const wheel = (e) => {
      e.preventDefault()
      const p = local(e)
      zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022)))
    }

    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    el.addEventListener('wheel', wheel, { passive: false })
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      el.removeEventListener('wheel', wheel)
    }
  }, [ref, cam, onTap])
}
