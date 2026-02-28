/**
 * Home.tsx — 实时音准检测页面
 *
 * 功能与旧版 page-home.js 完全对齐：
 *   - 调音表、音高历史（缩放/自动跟随/全屏）、钢琴键盘、FFT 频谱
 *   - 麦克风设备选择、暂停/恢复
 *   - 导出 CSV
 *   - 底部状态栏（音符/分/Hz/置信度/FPS）
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { useWsStore } from '@/store/wsStore'
import { useAppStore } from '@/store/appStore'
import { NeedleMeter }  from '@/components/visualizers/NeedleMeter'
import { PitchHistory } from '@/components/visualizers/PitchHistory'
import { Piano }        from '@/components/visualizers/Piano'
import { FftSpectrum }  from '@/components/visualizers/FftSpectrum'
import { TuneBadge }    from '@/components/ui/TuneBadge'
import { useDevices, useSwitchDevice } from '@/api/hooks'
import { cn } from '@/lib/cn'
import {
  Mic, MicOff, RotateCcw, ZoomIn, ZoomOut, Maximize2, Minimize2,
  Download, AlignCenter,
} from 'lucide-react'

// ── Small toolbar button ──────────────────────────────────
function ToolBtn({
  onClick, title, active, children, danger,
}: {
  onClick: () => void
  title?: string
  active?: boolean
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'flex items-center gap-1 rounded border px-2 py-1 text-xs transition-colors',
        active
          ? 'border-accent/60 bg-accent/15 text-accent'
          : danger
          ? 'border-border bg-bg-card text-text-muted hover:border-bad/40 hover:text-bad'
          : 'border-border bg-bg-card text-text-muted hover:border-accent/40 hover:text-text',
      )}
    >
      {children}
    </button>
  )
}

// ── Main page ─────────────────────────────────────────────
export default function Home() {
  const { latestPitch, paused, connected, sampleRate, setPaused } = useWsStore()
  const {
    style, toggleStyle,
    autoFollow, setAutoFollow,
    midiRange, zoomIn, zoomOut, resetZoom,
    recordedFrames, pushFrame, clearHistory, exportCSV,
  } = useAppStore()

  const { data: devicesData } = useDevices()
  const switchDevice = useSwitchDevice()

  // ── Push live frames into history ────────────────────────
  useEffect(() => {
    if (latestPitch?.voiced) pushFrame(latestPitch)
  }, [latestPitch, pushFrame])

  // ── FPS counter ──────────────────────────────────────────
  const [fps, setFps] = useState(0)
  const fpsCountRef  = useRef(0)
  const fpsTickRef   = useRef(Date.now())
  useEffect(() => {
    if (!latestPitch) return
    fpsCountRef.current++
    const now = Date.now()
    if (now - fpsTickRef.current >= 1000) {
      setFps(fpsCountRef.current)
      fpsCountRef.current = 0
      fpsTickRef.current = now
    }
  }, [latestPitch])

  // ── Full-screen expand panel ─────────────────────────────
  const [expanded, setExpanded] = useState(false)
  const handleKeyEsc = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') setExpanded(false)
  }, [])
  useEffect(() => {
    if (expanded) document.addEventListener('keydown', handleKeyEsc)
    else document.removeEventListener('keydown', handleKeyEsc)
    return () => document.removeEventListener('keydown', handleKeyEsc)
  }, [expanded, handleKeyEsc])

  // ── MIDI note for Piano highlight ─────────────────────────
  const midi = latestPitch?.voiced && latestPitch.freq > 0
    ? Math.round(69 + 12 * Math.log2(latestPitch.freq / 440))
    : null

  // ── Status text ──────────────────────────────────────────
  const statusText = latestPitch?.voiced
    ? `${latestPitch.note_full ?? '?'}   ${latestPitch.cents != null ? (latestPitch.cents >= 0 ? '+' : '') + latestPitch.cents.toFixed(1) + '¢' : ''}   ${latestPitch.freq?.toFixed(1)} Hz   置信度 ${((latestPitch.confidence ?? 0) * 100).toFixed(0)}%`
    : (connected ? '静音 / 未检出音高' : '连接中…')

  return (
    <div className="flex h-full flex-col overflow-hidden">

      {/* ── Top bar ──────────────────────────────────────── */}
      <header className="flex flex-wrap items-center gap-2 border-b border-border bg-bg px-3 py-2">
        {/* Connection dot */}
        <div
          className={cn('h-2 w-2 rounded-full flex-shrink-0', connected ? 'bg-good' : 'bg-bad')}
          title={connected ? '已连接' : '未连接'}
        />
        <span className="text-xs text-text-muted whitespace-nowrap">
          {connected ? (paused ? '已暂停' : '实时采集中') : '连接中…'}
        </span>

        {/* Device selector */}
        {devicesData && (
          <label className="flex items-center gap-1.5 ml-2">
            <span className="text-xs text-text-muted">🎧</span>
            <select
              className="rounded border border-border bg-bg-card px-2 py-1 text-xs text-text max-w-[220px]"
              onChange={e => switchDevice.mutate(e.target.value === '' ? null : parseInt(e.target.value))}
            >
              {devicesData.devices.map(d => (
                <option key={d.id ?? 'default'} value={d.id ?? ''}>
                  {d.is_default ? '⭐ ' : ''}{d.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="ml-auto flex items-center gap-1.5 flex-wrap">
          {/* Style */}
          <ToolBtn onClick={toggleStyle} title="切换 Piano Roll / 折线">
            {style === 'piano' ? '🎹 Piano' : '📈 Line'}
          </ToolBtn>

          {/* Pause / Resume */}
          <ToolBtn
            onClick={() => setPaused(!paused)}
            danger={!paused}
            title={paused ? '恢复采集' : '暂停采集'}
          >
            {paused ? <><Mic size={11} /> 恢复</> : <><MicOff size={11} /> 暂停</>}
          </ToolBtn>

          {/* Export CSV */}
          <ToolBtn onClick={exportCSV} title="导出 CSV（仅有声帧）">
            <Download size={11} /> 导出 CSV
          </ToolBtn>

          {/* Clear history */}
          <ToolBtn onClick={clearHistory} title="清除历史">
            <RotateCcw size={11} />
          </ToolBtn>
        </div>
      </header>

      {/* ── Main area ────────────────────────────────────── */}
      <div className="flex flex-1 gap-3 min-h-0 p-3 overflow-hidden">

        {/* Left column (hidden in expanded mode) */}
        {!expanded && (
          <div className="flex w-52 flex-shrink-0 flex-col gap-3">
            {/* Needle meter */}
            <div className="relative flex-1 min-h-0 rounded-lg border border-border bg-bg-card">
              <NeedleMeter pitch={latestPitch} className="absolute inset-0" />
            </div>

            {/* Current note info */}
            <div className="rounded-lg border border-border bg-bg-card p-3 text-center flex-shrink-0">
              <div className="font-mono text-3xl font-bold text-text leading-none">
                {latestPitch?.voiced ? (latestPitch.note_full ?? '—') : '—'}
              </div>
              <div className="mt-1.5 flex items-center justify-center gap-2">
                <TuneBadge level={latestPitch?.voiced ? latestPitch.tune_level : null} />
                {latestPitch?.voiced && latestPitch.freq != null && (
                  <span className="font-mono text-xs text-text-muted">
                    {latestPitch.freq.toFixed(1)} Hz
                  </span>
                )}
              </div>
              {latestPitch?.voiced && latestPitch.cents != null && (
                <div className="mt-1 font-mono text-sm text-text-muted">
                  {latestPitch.cents >= 0 ? '+' : ''}{latestPitch.cents.toFixed(1)}¢
                </div>
              )}
            </div>

            {/* Piano keyboard */}
            <div className="relative h-16 flex-shrink-0 rounded-lg border border-border bg-bg-card overflow-hidden">
              <Piano highlightedMidi={midi} className="absolute inset-0" />
            </div>

            {/* FFT spectrum */}
            <div className="relative h-20 flex-shrink-0 rounded-lg border border-border bg-bg-card overflow-hidden">
              <FftSpectrum pitch={latestPitch} className="absolute inset-0" />
              <div className="absolute bottom-1 left-2 text-[9px] text-text-muted opacity-50 pointer-events-none">
                0 — 4000 Hz
              </div>
            </div>
          </div>
        )}

        {/* Right: pitch history */}
        <div className="flex flex-1 flex-col min-w-0">
          {/* Panel header */}
          <div className="mb-1.5 flex items-center gap-1.5">
            <span className="text-xs font-medium text-text-muted">音高历史 · 8 秒</span>
            <div className="ml-auto flex items-center gap-1">
              <ToolBtn onClick={zoomIn}   title="放大音域（可用滚轮↑）"><ZoomIn  size={11} /></ToolBtn>
              <ToolBtn onClick={zoomOut}  title="缩小音域（可用滚轮↓）"><ZoomOut size={11} /></ToolBtn>
              <ToolBtn onClick={resetZoom} title="重置缩放"><AlignCenter size={11} /></ToolBtn>
              <ToolBtn
                onClick={() => setAutoFollow(!autoFollow)}
                active={autoFollow}
                title={autoFollow ? '关闭自动跟随' : '开启自动跟随 Y 轴'}
              >
                跟随
              </ToolBtn>
              <ToolBtn
                onClick={() => setExpanded(v => !v)}
                active={expanded}
                title={expanded ? '退出全屏 (Esc)' : '全屏展开'}
              >
                {expanded ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
              </ToolBtn>
            </div>
          </div>

          {/* Canvas */}
          <div className="relative flex-1 min-h-0 rounded-lg border border-border bg-bg-card overflow-hidden">
            <PitchHistory
              frames={recordedFrames.slice(-2048)}
              style={style}
              midiRange={midiRange}
              autoFollow={autoFollow}
              onZoom={delta => (delta > 0 ? zoomOut() : zoomIn())}
              className="absolute inset-0"
            />
          </div>
        </div>
      </div>

      {/* ── Status bar ───────────────────────────────────── */}
      <footer className="flex items-center gap-4 border-t border-border bg-bg px-3 py-1 text-[11px] text-text-muted flex-shrink-0 font-mono">
        <span className="flex-shrink-0">采样率: {(sampleRate ?? 44100).toLocaleString()} Hz</span>
        <span className="flex-1 truncate">{statusText}</span>
        <span className="flex-shrink-0">{fps} msg/s</span>
      </footer>
    </div>
  )
}
