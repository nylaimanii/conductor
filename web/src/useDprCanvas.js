import { useEffect, useRef } from 'react'

// Sizes the canvas backing store to devicePixelRatio and runs a rAF loop.
// The draw callback receives a context already scaled so that all drawing
// coordinates are plain CSS pixels.
//
// draw(ctx, { width, height, dt, t })
//   width/height are CSS pixels, dt is seconds since last frame (clamped),
//   t is seconds since the loop started.
export function useDprCanvas(draw, { running = true } = {}) {
  const canvasRef = useRef(null)
  const drawRef = useRef(draw)
  drawRef.current = draw

  const runningRef = useRef(running)
  runningRef.current = running

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')

    // CSS-pixel size of the canvas, kept in sync by the observer below.
    let cssWidth = 0
    let cssHeight = 0

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      // devicePixelRatio can be fractional on scaled displays.
      const dpr = window.devicePixelRatio || 1
      cssWidth = rect.width
      cssHeight = rect.height
      const bw = Math.max(1, Math.round(rect.width * dpr))
      const bh = Math.max(1, Math.round(rect.height * dpr))
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw
        canvas.height = bh
      }
      // Draw in CSS pixels, let the transform handle the density.
      ctx.setTransform(bw / (rect.width || 1), 0, 0, bh / (rect.height || 1), 0, 0)
    }

    resize()

    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    // devicePixelRatio changes when the window moves between displays.
    window.addEventListener('resize', resize)

    let raf = 0
    let last = performance.now()
    let start = last

    const frame = (now) => {
      raf = requestAnimationFrame(frame)
      // Clamp so a backgrounded tab does not fire one huge step on return.
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      if (!runningRef.current) return
      const fn = drawRef.current
      if (!fn) return
      ctx.save()
      fn(ctx, {
        width: cssWidth,
        height: cssHeight,
        dt,
        t: (now - start) / 1000,
      })
      ctx.restore()
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('resize', resize)
    }
  }, [])

  return canvasRef
}
