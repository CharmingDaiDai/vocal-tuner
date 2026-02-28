import { cn } from '@/lib/cn'
import type { ReactNode } from 'react'

interface CardProps {
  children: ReactNode
  className?: string
  onClick?: () => void
}

export function Card({ children, className, onClick }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-bg-card p-4',
        onClick && 'cursor-pointer transition-colors hover:border-accent/50',
        className
      )}
      onClick={onClick}
    >
      {children}
    </div>
  )
}
