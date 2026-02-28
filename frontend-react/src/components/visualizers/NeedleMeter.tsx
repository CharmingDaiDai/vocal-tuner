import { useRef } from 'react'
import { useCanvas } from '@/hooks/useCanvas'
import type { PitchMessage } from '@/types'

interface Props {
  pitch: PitchMessage | null
  className?: string
}

function tuneColor(cents: number | null | undefined): string {
  const a = Math.abs(cents ?? 0)
  if (a <= 15) return '#3fb950'
  if (a <= 30) return '#d29922'
  return '#f85149'
}

export function NeedleMeter({ pitch, className }: Props) {
  const smoothedRef = useRef(0)  // smoothed cents for needle

  const canvasRef = useCanvas((ctx, { w, h }) => {
    ctx.clearRect(0, 0, w, h)

    const cx = w / 2
    const cy = h * 0.72
    const r  = Math.min(w * 0.44, h * 0.68)

    // Low-pass filter cents
    const targetCents = (pitch?.voiced && pitch.cents != null) ? pitch.cents : 0
    smoothedRef.current += (targetCents - smoothedRef.current) * 0.25
    const smoothed = smoothedRef.current

    // ── Arc background ───────────────────────────────────
    const arcStart = Math.PI * 0.85
    const arcEnd   = Math.PI * 0.15
    ctx.save()
    // Zone bands: green (±15¢), yellow (±30¢), red (outer)
    const zones = [
      { extent: 30/50, color: '#f85149' },
      { extent: 15/50, color: '#d29922' },
      { extent: 0,     color: '#3fb950' },
    ]
    const totalArc = Math.PI - 0.7 * Math.PI  // actually π × (1-0.85+0.15) ≈ ...
    const span = Math.PI - 0.3 * Math.PI  // use a simpler approach below

    // Just draw the arc rail
    ctx.beginPath()
    ctx.arc(cx, cy, r, Math.PI * 0.85, Math.PI * 0.15)
    ctx.strokeStyle = '#21262d'
    ctx.lineWidth = r * 0.08
    ctx.lineCap = 'round'
    ctx.stroke()

    // Colored zone overlays
    const totalSpan = (2 * Math.PI - Math.PI * 0.85 + Math.PI * 0.15) % (2 * Math.PI)
    // 0¢ is at top (π * 1.5), ±50¢ maps to full arc
    const centToAngle = (c: number) => Math.PI * 1.5 + (c / 50) * (totalSpan / 2)

    // draw green band
    ctx.beginPath()
    ctx.arc(cx, cy, r, centToAngle(-15), centToAngle(15))
    ctx.strokeStyle = '#3fb9502a'
    ctx.lineWidth = r * 0.08
    ctx.stroke()

    // draw yellow
    ctx.beginPath()
    ctx.arc(cx, cy, r, centToAngle(-30), centToAngle(-15))
    ctx.strokeStyle = '#d299222a'
    ctx.lineWidth = r * 0.08
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(cx, cy, r, centToAngle(15), centToAngle(30))
    ctx.strokeStyle = '#d299222a'
    ctx.lineWidth = r * 0.08
    ctx.stroke()

    // Tick marks every 10¢
    for (let c = -50; c <= 50; c += 10) {
      const angle = centToAngle(c)
      const isMain = c % 50 === 0
      const r1 = r - (isMain ? r * 0.14 : r * 0.08)
      ctx.beginPath()
      ctx.moveTo(cx + r1 * Math.cos(angle), cy + r1 * Math.sin(angle))
      ctx.lineTo(cx + (r + r * 0.015) * Math.cos(angle), cy + (r + r * 0.015) * Math.sin(angle))
      ctx.strokeStyle = c === 0 ? '#58a6ff' : '#30363d'
      ctx.lineWidth = isMain ? 1.5 : 0.8
      ctx.stroke()
    }
    ctx.restore()

    // ── Needle ───────────────────────────────────────────
    const clampedCents = Math.max(-50, Math.min(50, smoothed))
    const needleAngle = centToAngle(clampedCents)
    const needleLen = r * 0.88
    const color = tuneColor(pitch?.voiced ? smoothed : null)

    ctx.save()
    ctx.shadowColor = color
    ctx.shadowBlur = 10
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + needleLen * Math.cos(needleAngle), cy + needleLen * Math.sin(needleAngle))
    ctx.strokeStyle = color
    ctx.lineWidth = 2.5
    ctx.lineCap = 'round'
    ctx.stroke()
    ctx.restore()

    // Pivot circle
    ctx.beginPath()
    ctx.arc(cx, cy, 5, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()

    // ── Label ────────────────────────────────────────────
    if (pitch?.voiced && pitch.note_full) {
      ctx.save()
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.font = `bold ${Math.round(h * 0.14)}px "JetBrains Mono", monospace`
      ctx.fillStyle = color
      ctx.fillText(pitch.note_full, cx, cy * 0.45)
      ctx.font = `${Math.round(h * 0.07)}px "Inter", sans-serif`
      ctx.fillStyle = '#8b949e'
      const centsStr = pitch.cents != null
        ? `${pitch.cents >= 0 ? '+' : ''}${pitch.cents.toFixed(0)}¢`
        : '—'
      ctx.fillText(centsStr, cx, cy * 0.65)
      if (pitch.freq > 0) {
        ctx.font = `${Math.round(h * 0.06)}px "JetBrains Mono", monospace`
        ctx.fillStyle = '#6e7681'
        ctx.fillText(`${pitch.freq.toFixed(1)} Hz`, cx, cy * 0.8)
      }
      ctx.restore()
    } else {
      ctx.save()
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.font = `bold ${Math.round(h * 0.12)}px "Inter", sans-serif`
      ctx.fillStyle = '#30363d'
      ctx.fillText('—', cx, cy * 0.5)
      ctx.restore()
    }
  })

  return <canvas ref={canvasRef} className={className} style={{ width: '100%', height: '100%' }} />
}
