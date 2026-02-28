import { useState, useRef, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useSong } from '@/api/hooks'
import { useWsStore } from '@/store/wsStore'
import { useAppStore } from '@/store/appStore'
import { PitchHistory } from '@/components/visualizers/PitchHistory'
import { SongOverview } from '@/components/visualizers/SongOverview'
import { NeedleMeter } from '@/components/visualizers/NeedleMeter'
import { Spinner } from '@/components/ui/Spinner'
import { TuneBadge } from '@/components/ui/TuneBadge'
import { ArrowLeft, Play, Pause, SkipBack } from 'lucide-react'
import { cn } from '@/lib/cn'

export default function Karaoke() {
  const { jobId } = useParams<{ jobId: string }>()
  const navigate = useNavigate()
  const { data: song, isLoading, error } = useSong(jobId ?? null)
  const { latestPitch, paused, setPaused } = useWsStore()
  const { style, toggleStyle, recordedFrames, pushFrame } = useAppStore()

  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [wallStart, setWallStart] = useState<number | undefined>(undefined)

  // Push mic frames to history
  useEffect(() => {
    if (latestPitch?.voiced) pushFrame(latestPitch)
  }, [latestPitch, pushFrame])

  // Resume mic when entering karaoke
  useEffect(() => {
    if (paused) setPaused(false)
  }, [])

  const handlePlay = useCallback(async () => {
    const el = audioRef.current
    if (!el) return
    if (playing) {
      el.pause()
      setPlaying(false)
    } else {
      try {
        await el.play()
        setWallStart(Date.now() / 1000 - el.currentTime)
        setPlaying(true)
      } catch (e) {
        console.error('Playback error', e)
      }
    }
  }, [playing])

  const handleSeek = useCallback((t: number) => {
    const el = audioRef.current
    if (!el) return
    el.currentTime = t
    setCurrentTime(t)
    if (playing) {
      setWallStart(Date.now() / 1000 - t)
    }
  }, [playing])

  const handleRestart = () => {
    handleSeek(0)
    const el = audioRef.current
    if (el && !playing) { el.play(); setPlaying(true) }
  }

  if (isLoading) {
    return <div className="flex h-full items-center justify-center"><Spinner size="lg" /></div>
  }

  if (error || !song) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-text-muted">
        <div>歌曲不存在或加载失败</div>
        <button onClick={() => navigate('/library')} className="text-accent hover:underline text-sm">
          返回曲库
        </button>
      </div>
    )
  }

  const duration = song.duration ?? 0

  return (
    <div className="flex h-full flex-col gap-0 overflow-hidden bg-bg">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <button
          onClick={() => navigate('/library')}
          className="rounded p-1 text-text-muted hover:text-text transition-colors"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-text">{song.original_name}</div>
          <div className="text-xs text-text-muted">{duration.toFixed(0)}s · 跟唱模式</div>
        </div>
        <TuneBadge level={latestPitch?.voiced ? latestPitch.tune_level : null} />
        <button
          onClick={toggleStyle}
          className="rounded border border-border px-2 py-0.5 text-xs text-text-muted hover:border-accent/40 transition-colors"
        >
          {style === 'piano' ? 'Piano Roll' : '折线'}
        </button>
      </div>

      {/* Main visualizer */}
      <div className="relative flex-1 min-h-0">
        <PitchHistory
          frames={recordedFrames.slice(-2048)}
          refPitches={song.fine_pitches}
          wallStart={wallStart}
          style={style}
          className="absolute inset-0"
        />
        {/* Side meter */}
        <div className="absolute right-3 top-3 h-32 w-28 rounded-lg border border-border/60 bg-bg/80 backdrop-blur">
          <NeedleMeter pitch={latestPitch} className="absolute inset-0" />
        </div>
      </div>

      {/* Overview */}
      <div className="relative h-20 border-t border-border">
        <SongOverview
          pitches={song.fine_pitches}
          rms={song.rms}
          duration={duration}
          currentTime={currentTime}
          onSeek={handleSeek}
          className="absolute inset-0"
        />
      </div>

      {/* Transport controls */}
      <div className="flex items-center gap-4 border-t border-border px-6 py-3">
        <button
          onClick={handleRestart}
          className="rounded p-1.5 text-text-muted hover:text-text transition-colors"
        >
          <SkipBack size={18} />
        </button>
        <button
          onClick={handlePlay}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-bg hover:bg-accent/80 transition-colors"
        >
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <div className="flex flex-1 items-center gap-2">
          <span className="w-12 text-right font-mono text-xs text-text-muted">
            {formatTime(currentTime)}
          </span>
          <div className="relative flex-1 h-1.5 rounded-full bg-border">
            <div
              className="absolute h-full rounded-full bg-accent"
              style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
            />
            <input
              type="range"
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              min={0}
              max={duration}
              step={0.1}
              value={currentTime}
              onChange={e => handleSeek(parseFloat(e.target.value))}
            />
          </div>
          <span className="w-12 font-mono text-xs text-text-muted">
            {formatTime(duration)}
          </span>
        </div>
      </div>

      {/* Hidden audio element */}
      <audio
        ref={audioRef}
        src={song.audio_url}
        onTimeUpdate={e => setCurrentTime((e.target as HTMLAudioElement).currentTime)}
        onEnded={() => setPlaying(false)}
        onError={e => console.error('Audio error', e)}
        preload="auto"
      />
    </div>
  )
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}
