import { useEffect } from 'react'
import { useWsStore } from '@/store/wsStore'
import { useAppStore } from '@/store/appStore'
import { NeedleMeter } from '@/components/visualizers/NeedleMeter'
import { PitchHistory } from '@/components/visualizers/PitchHistory'
import { Piano } from '@/components/visualizers/Piano'
import { FftSpectrum } from '@/components/visualizers/FftSpectrum'
import { TuneBadge } from '@/components/ui/TuneBadge'
import { useDevices, useSwitchDevice } from '@/api/hooks'
import { cn } from '@/lib/cn'
import { Mic, MicOff, RotateCcw } from 'lucide-react'

export default function Home() {
  const { latestPitch, paused, connected, setPaused } = useWsStore()
  const { style, toggleStyle, recordedFrames, pushFrame, clearHistory } = useAppStore()
  const { data: devicesData } = useDevices()
  const switchDevice = useSwitchDevice()

  // Stream mic frames into history store
  useEffect(() => {
    if (latestPitch?.voiced) pushFrame(latestPitch)
  }, [latestPitch, pushFrame])

  const midi = latestPitch?.voiced && latestPitch.freq > 0
    ? Math.round(69 + 12 * Math.log2(latestPitch.freq / 440))
    : null

  return (
    <div className="flex h-full flex-col gap-3 p-3 overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center gap-3">
        <div className={cn(
          'h-2 w-2 rounded-full',
          connected ? 'bg-good' : 'bg-bad'
        )} title={connected ? '已连接' : '未连接'} />
        <span className="text-sm text-text-muted">
          {connected ? '实时模式' : '连接中…'}
        </span>

        {/* Device selector */}
        {devicesData && (
          <select
            className="ml-auto rounded border border-border bg-bg-card px-2 py-1 text-sm text-text"
            onChange={e => switchDevice.mutate(e.target.value === '' ? null : parseInt(e.target.value))}
          >
            {devicesData.devices.map(d => (
              <option key={d.id ?? 'default'} value={d.id ?? ''}>
                {d.is_default ? '⭐ ' : ''}{d.name}
              </option>
            ))}
          </select>
        )}

        {/* Style toggle */}
        <button
          onClick={toggleStyle}
          className="rounded border border-border bg-bg-card px-3 py-1 text-xs text-text-muted hover:border-accent/50 hover:text-text transition-colors"
        >
          {style === 'piano' ? 'Piano Roll' : '折线'}
        </button>

        {/* Pause/resume */}
        <button
          onClick={() => setPaused(!paused)}
          className={cn(
            'flex items-center gap-1.5 rounded border px-3 py-1 text-xs transition-colors',
            paused
              ? 'border-good/40 bg-good/10 text-good hover:bg-good/20'
              : 'border-border bg-bg-card text-text-muted hover:border-bad/40 hover:text-bad'
          )}
        >
          {paused ? <><Mic size={12} /> 恢复</> : <><MicOff size={12} /> 暂停</>}
        </button>

        {/* Clear history */}
        <button
          onClick={clearHistory}
          className="rounded border border-border bg-bg-card p-1.5 text-text-muted hover:text-text transition-colors"
          title="清除历史"
        >
          <RotateCcw size={12} />
        </button>
      </div>

      {/* Main layout */}
      <div className="flex flex-1 gap-3 min-h-0">
        {/* Left: meter + piano */}
        <div className="flex w-56 flex-shrink-0 flex-col gap-3">
          {/* Needle meter */}
          <div className="relative flex-1 min-h-0 rounded-lg border border-border bg-bg-card">
            <NeedleMeter pitch={latestPitch} className="absolute inset-0" />
          </div>

          {/* Current note info */}
          <div className="rounded-lg border border-border bg-bg-card p-3 text-center">
            <div className="font-mono text-3xl font-bold text-text">
              {latestPitch?.voiced ? (latestPitch.note_full ?? '—') : '—'}
            </div>
            <div className="mt-1 flex items-center justify-center gap-2">
              <TuneBadge level={latestPitch?.voiced ? latestPitch.tune_level : null} />
              {latestPitch?.voiced && latestPitch.freq > 0 && (
                <span className="font-mono text-xs text-text-muted">
                  {latestPitch.freq.toFixed(1)} Hz
                </span>
              )}
            </div>
          </div>

          {/* Piano keyboard */}
          <div className="h-16 rounded-lg border border-border bg-bg-card overflow-hidden">
            <Piano highlightedMidi={midi} className="absolute inset-0" />
          </div>
        </div>

        {/* Right: pitch history + FFT */}
        <div className="flex flex-1 flex-col gap-3 min-w-0">
          <div className="relative flex-1 min-h-0 rounded-lg border border-border bg-bg-card overflow-hidden">
            <PitchHistory
              frames={recordedFrames.slice(-2048)}
              style={style}
              className="absolute inset-0"
            />
          </div>

          <div className="relative h-24 rounded-lg border border-border bg-bg-card overflow-hidden">
            <FftSpectrum pitch={latestPitch} className="absolute inset-0" />
            <div className="absolute bottom-1 left-2 text-[9px] text-text-muted opacity-50">
              0 — 4000 Hz
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
