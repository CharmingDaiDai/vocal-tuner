import { useToastStore } from '@/store/toastStore'
import { X, CheckCircle2, AlertCircle, Info } from 'lucide-react'
import { cn } from '@/lib/cn'

const icons = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
}

const colors = {
  success: 'border-good/40 bg-good/10 text-good',
  error: 'border-bad/40 bg-bad/10 text-bad',
  info: 'border-accent/40 bg-accent/10 text-accent',
}

export function ToastContainer() {
  const { toasts, remove } = useToastStore()

  if (toasts.length === 0) return null

  return (
    <div className="fixed top-3 right-3 z-[9999] flex flex-col gap-2 max-w-xs">
      {toasts.map((t) => {
        const Icon = icons[t.type]
        return (
          <div
            key={t.id}
            className={cn(
              'flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm shadow-lg backdrop-blur-sm animate-toast-in',
              colors[t.type],
            )}
          >
            <Icon size={16} className="mt-0.5 shrink-0" />
            <span className="flex-1 text-text">{t.message}</span>
            <button
              onClick={() => remove(t.id)}
              className="shrink-0 rounded p-0.5 hover:bg-white/10 transition-colors"
            >
              <X size={12} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
