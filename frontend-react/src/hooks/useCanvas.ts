import { useRef, useEffect, useCallback } from 'react'
import { useRafLoop } from './useRafLoop'

interface CanvasSize {
  w: number
  h: number
  dpr: number
}

type DrawFn = (ctx: CanvasRenderingContext2D, size: CanvasSize) => void

/**
 * Returns a ref to attach to a <canvas> element.
 * Handles HiDPI scaling and drives the draw function via rAF.
 */
export function useCanvas(draw: DrawFn, active = true) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawRef = useRef(draw)
  drawRef.current = draw

  const resize = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    const w = Math.floor(rect.width)
    const h = Math.floor(rect.height)
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr
      canvas.height = h * dpr
    }
  }, [])

  // Resize observer
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    resize()
    return () => ro.disconnect()
  }, [resize])

  useRafLoop(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.width / dpr
    const h = canvas.height / dpr
    if (w <= 0 || h <= 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.save()
    ctx.scale(dpr, dpr)
    drawRef.current(ctx, { w, h, dpr })
    ctx.restore()
  }, active)

  return canvasRef
}
