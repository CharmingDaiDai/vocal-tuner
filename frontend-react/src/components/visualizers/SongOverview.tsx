import { useRef } from 'react'
import { useCanvas } from '@/hooks/useCanvas'
import type { PitchPoint } from '@/types'

interface Props {
  pitches: PitchPoint[]
  rms: number[]
  duration: number
  currentTime?: number
  onSeek?: (t: number) => void
  className?: string
}

function tuneColor(midi: number | null): string {
  if (!midi) return '#58a6ff'
  return '#58a6ff'
}

export function SongOverview({ pitches, rms, duration, currentTime, onSeek, className }: Props) {
  const dragRef = useRef(false)

  const canvasRef = useCanvas((ctx, { w, h }) => {
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#0d1117'
    ctx.fillRect(0, 0, w, h)

    if (duration <= 0) return

    const tToX = (t: number) => (t / duration) * w
    const midiMin = 48, midiMax = 84
    const midiToY = (m: number) => h - ((m - midiMin) / (midiMax - midiMin)) * h * 0.85 - h * 0.075

    // RMS background
    if (rms.length > 0) {
      const step = duration / rms.length
      ctx.fillStyle = '#1f6feb22'
      rms.forEach((v, i) => {
        const x = tToX(i * step)
        const bh = v * h * 0.5
        ctx.fillRect(x, h - bh, Math.max(1, w / rms.length), bh)
      })
    }

    // Pitch ribbon
    let prev: { x: number; y: number } | null = null
    ctx.beginPath()
    let started = false

    for (const p of pitches) {
      if (!p.voiced || !p.midi) { prev = null; started = false; continue }
      const x = tToX(p.t)
      const y = midiToY(p.midi)
      if (!started || !prev) {
        ctx.moveTo(x, y)
        started = true
      } else {
        ctx.lineTo(x, y)
      }
      prev = { x, y }
    }
    ctx.strokeStyle = '#58a6ff80'
    ctx.lineWidth = 1.5
    ctx.lineJoin = 'round'
    ctx.stroke()

    // Playhead
    if (currentTime != null && currentTime >= 0 && currentTime <= duration) {
      const px = tToX(currentTime)
      ctx.strokeStyle = '#f0883e'
      ctx.lineWidth = 1.5
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(px, 0)
      ctx.lineTo(px, h)
      ctx.stroke()
      ctx.setLineDash([])
    }
  })

  // Seek on click/drag
  const getTime = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    return frac * duration
  }

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: '100%', height: '100%', cursor: 'pointer' }}
      onMouseDown={(e) => { dragRef.current = true; onSeek?.(getTime(e)) }}
      onMouseMove={(e) => { if (dragRef.current) onSeek?.(getTime(e)) }}
      onMouseUp={() => { dragRef.current = false }}
      onMouseLeave={() => { dragRef.current = false }}
    />
  )
}
