import type { PitchMessage } from '@/types'
import { cn } from '@/lib/cn'

interface Props {
  pitch: PitchMessage | null
  className?: string
}

/**
 * Small vibrato indicator: shows rate (Hz) and depth (¢) when vibrato is detected.
 * Renders nothing when pitch is unvoiced or vibrato is not detected.
 */
export function VibratoMeter({ pitch, className }: Props) {
  const vib = pitch?.vibrato
  const active = vib?.is_vibrato && pitch?.voiced

  if (!pitch?.voiced) return null

  return (
    <div
      className={cn(
        'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-mono transition-colors',
        active
          ? 'border-accent/50 bg-accent/10 text-accent'
          : 'border-border bg-bg-card text-text-muted opacity-40',
        className
      )}
      title={active ? `Vibrato: ${vib?.rate_hz} Hz / ${vib?.depth_cents}¢` : '无颤音'}
    >
      <span className={cn('text-[10px] font-sans', active ? 'text-accent' : 'text-text-muted')}>
        颤
      </span>
      {active ? (
        <>
          <span>{vib?.rate_hz}Hz</span>
          <span className="text-text-muted">·</span>
          <span>{vib?.depth_cents}¢</span>
        </>
      ) : (
        <span>—</span>
      )}
    </div>
  )
}
