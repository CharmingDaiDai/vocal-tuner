import { Outlet, NavLink } from 'react-router-dom'
import { Mic, Library } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useWsStore } from '@/store/wsStore'

const NAV = [
  { to: '/home', icon: Mic, label: '调音' },
  { to: '/library', icon: Library, label: '曲库' },
]

export default function Layout() {
  const { connected } = useWsStore()

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <nav className="flex w-14 flex-col items-center gap-1 border-r border-border bg-bg py-3">
        {/* Logo */}
        <div className="mb-2 flex h-9 w-9 items-center justify-center rounded-lg bg-accent/20 text-accent">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </svg>
        </div>

        {NAV.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            title={label}
            className={({ isActive }) =>
              cn(
                'flex h-10 w-10 flex-col items-center justify-center rounded-lg text-[9px] gap-0.5 transition-colors',
                isActive
                  ? 'bg-accent/20 text-accent'
                  : 'text-text-muted hover:bg-border hover:text-text'
              )
            }
          >
            <Icon size={16} />
            <span>{label}</span>
          </NavLink>
        ))}

        {/* Connection indicator at bottom */}
        <div className="mt-auto mb-1" title={connected ? 'WS 已连接' : 'WS 未连接'}>
          <div className={cn(
            'h-2 w-2 rounded-full',
            connected ? 'bg-good' : 'bg-text-muted'
          )} />
        </div>
      </nav>

      {/* Page content */}
      <main className="flex-1 min-w-0 overflow-hidden">
        <Outlet />
      </main>
    </div>
  )
}
