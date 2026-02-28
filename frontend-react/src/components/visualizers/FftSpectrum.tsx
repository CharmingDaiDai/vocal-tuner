import { useRef } from 'react'
import { useCanvas } from '@/hooks/useCanvas'
import type { PitchMessage } from '@/types'

interface Props {
  pitch: PitchMessage | null
  className?: string
}

export function FftSpectrum({ pitch, className }: Props) {
  const fftRef = useRef<number[] | null>(null)
  const freqRef = useRef<number | null>(null)

  // Cache FFT - only update when new fft arrives
  if (pitch?.fft) fftRef.current = pitch.fft
  if (pitch?.freq != null) freqRef.current = pitch.freq

  const canvasRef = useCanvas((ctx, { w, h }) => {
    ctx.clearRect(0, 0, w, h)

    const fft = fftRef.current
    if (!fft || fft.length === 0) {
      // Placeholder
      ctx.fillStyle = '#21262d'
      ctx.fillRect(0, 0, w, h)
      return
    }

    ctx.fillStyle = '#0d1117'
    ctx.fillRect(0, 0, w, h)

    const n = fft.length
    const barW = w / n
    const maxFreq = 4000

    // Gradient
    const grad = ctx.createLinearGradient(0, h, 0, 0)
    grad.addColorStop(0, '#1f6feb')
    grad.addColorStop(0.6, '#58a6ff')
    grad.addColorStop(1, '#79c0ff')

    ctx.fillStyle = grad
    for (let i = 0; i < n; i++) {
      const barH = fft[i] * h * 0.92
      ctx.fillRect(i * barW, h - barH, Math.max(barW - 0.5, 1), barH)
    }

    // Fundamental frequency marker
    const freq = freqRef.current
    if (freq && freq > 0) {
      const x = (freq / maxFreq) * w
      ctx.save()
      ctx.strokeStyle = '#f0883e'
      ctx.lineWidth = 1.5
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
      ctx.restore()
    }
  })

  return <canvas ref={canvasRef} className={className} style={{ width: '100%', height: '100%' }} />
}
