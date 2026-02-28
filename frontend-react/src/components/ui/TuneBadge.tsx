import { cn } from '@/lib/cn'

type TuneLevel = 'good' | 'close' | 'off' | null | undefined

interface BadgeProps {
  level: TuneLevel
  className?: string
}

const LABELS: Record<NonNullable<TuneLevel>, string> = {
  good: '准',
  close: '偏',
  off: '跑调',
}

const STYLES: Record<NonNullable<TuneLevel>, string> = {
  good: 'bg-good/20 text-good border-good/40',
  close: 'bg-warn/20 text-warn border-warn/40',
  off: 'bg-bad/20 text-bad border-bad/40',
}

export function TuneBadge({ level, className }: BadgeProps) {
  if (!level) return null
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
        STYLES[level],
        className
      )}
    >
      {LABELS[level]}
    </span>
  )
}
