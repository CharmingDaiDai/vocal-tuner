import { useEffect, useRef } from 'react'

/**
 * Runs `callback` inside a persistent requestAnimationFrame loop.
 * Loop is cancelled on unmount.
 */
export function useRafLoop(callback: (dt: number) => void, active = true) {
  const cbRef = useRef(callback)
  cbRef.current = callback

  const rafRef = useRef<number>(0)
  const lastRef = useRef<number>(0)

  useEffect(() => {
    if (!active) return

    let running = true

    function tick(now: number) {
      if (!running) return
      const dt = lastRef.current ? now - lastRef.current : 0
      lastRef.current = now
      cbRef.current(dt)
      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)

    return () => {
      running = false
      cancelAnimationFrame(rafRef.current)
    }
  }, [active])
}
