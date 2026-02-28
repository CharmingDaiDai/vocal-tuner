import { cn } from '@/lib/cn'

interface ProgressBarProps {
  value: number  // 0-1
  className?: string
  showLabel?: boolean
}

export function ProgressBar({ value, className, showLabel }: ProgressBarProps) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100)
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
        <div
          className="h-full rounded-full bg-accent transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      {showLabel && (
        <span className="font-mono text-xs text-text-muted w-8 text-right">{pct}%</span>
      )}
    </div>
  )
}
