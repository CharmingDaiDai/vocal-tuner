import { cn } from '@/lib/cn'

interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const SIZES = { sm: 'h-4 w-4', md: 'h-6 w-6', lg: 'h-10 w-10' }

export function Spinner({ size = 'md', className }: SpinnerProps) {
  return (
    <div
      className={cn(
        'animate-spin rounded-full border-2 border-border border-t-accent',
        SIZES[size],
        className
      )}
    />
  )
}
