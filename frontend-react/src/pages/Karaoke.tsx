import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useSong, useSaveSession } from '@/api/hooks'
import { api } from '@/api/client'
import { useWsStore } from '@/store/wsStore'
import { useAppStore } from '@/store/appStore'
import { PitchHistory } from '@/components/visualizers/PitchHistory'
import { SongOverview } from '@/components/visualizers/SongOverview'
import { NeedleMeter } from '@/components/visualizers/NeedleMeter'
import LyricsDisplay from '@/components/LyricsDisplay'
import { Spinner } from '@/components/ui/Spinner'
import { TuneBadge } from '@/components/ui/TuneBadge'
import { ArrowLeft, Play, Pause, SkipBack, Save } from 'lucide-react'
import { cn } from '@/lib/cn'

// 检测管线延迟补偿：capture(23ms) + pYIN(20ms) + smoother(10ms) + WS(5ms) + render(16ms) ≈ 100ms
// 正值 → 参考轨道右移 → 实时音高相对左移，补偿延迟
const LATENCY_OFFSET_SEC = 0.10

import type { PitchPoint, PitchMessage } from '@/types'

// Binary search: find the closest voiced reference pitch at songTime (within ±50ms)
function findRefPitch(
  refVoiced: PitchPoint[],
  songTime: number,
): PitchPoint | null {
  if (refVoiced.length === 0 || songTime < 0) return null
  let lo = 0, hi = refVoiced.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (refVoiced[mid].t < songTime) lo = mid + 1
    else hi = mid
  }
  // Check lo and lo-1 for closest
  let best = lo
  if (lo > 0 && Math.abs(refVoiced[lo - 1].t - songTime) < Math.abs(refVoiced[lo].t - songTime)) {
    best = lo - 1
  }
  return Math.abs(refVoiced[best].t - songTime) <= 0.05 ? refVoiced[best] : null
}

function karaokeLevel(cents: number): 'good' | 'close' | 'off' {
  const a = Math.abs(cents)
  if (a <= 15) return 'good'
  if (a <= 30) return 'close'
  return 'off'
}

export default function Karaoke() {
  const { jobId } = useParams<{ jobId: string }>()
  const navigate = useNavigate()
  const { data: song, isLoading, error } = useSong(jobId ?? null)
  const { latestPitch, paused, setPaused } = useWsStore()
  const { style, toggleStyle, recordedFrames, pushFrame } = useAppStore()
  const saveSession = useSaveSession()

  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [wallStart, setWallStart] = useState<number | undefined>(undefined)

  // WAV recording state
  const [wavSessionId, setWavSessionId] = useState<string | null>(null)
  const [showSavePrompt, setShowSavePrompt] = useState(false)

  // Build sorted reference pitch lookup (voiced only)
  const refVoiced = useMemo(() => {
    if (!song?.fine_pitches) return []
    return song.fine_pitches.filter(p => p.voiced && p.midi != null && p.freq > 0)
  }, [song?.fine_pitches])

  // Latest karaoke-augmented pitch (for TuneBadge / NeedleMeter)
  const [karaokePitch, setKaraokePitch] = useState<PitchMessage | null>(null)

  // Push mic frames to history, augmented with karaoke comparison
  useEffect(() => {
    if (!latestPitch?.voiced || !latestPitch.freq) return
    const el = audioRef.current
    const songTime = el ? el.currentTime : undefined

    // Augment frame with karaoke comparison data
    let augmented: PitchMessage = latestPitch
    if (songTime != null && songTime > 0 && refVoiced.length > 0 && playing) {
      const ref = findRefPitch(refVoiced, songTime)
      if (ref && ref.freq > 0) {
        const kCents = 1200 * Math.log2(latestPitch.freq / ref.freq)
        augmented = {
          ...latestPitch,
          karaoke_cents: Math.round(kCents * 100) / 100,
          karaoke_tune: karaokeLevel(kCents),
          song_time: songTime,
          ref_midi: ref.midi ?? undefined,
        }
      } else {
        augmented = { ...latestPitch, song_time: songTime }
      }
    }
    setKaraokePitch(augmented)
    pushFrame(augmented)
  }, [latestPitch, pushFrame, refVoiced, playing])

  // Resume mic when entering karaoke; stop any leftover recording on unmount
  useEffect(() => {
    if (paused) setPaused(false)
    return () => {
      // Fire-and-forget: stop recording if active when navigating away
      api.stopRecording().catch(() => {})
    }
  }, [])

  const handlePlay = useCallback(async () => {
    const el = audioRef.current
    if (!el) return
    if (playing) {
      el.pause()
      setPlaying(false)
      // Stop recording when pausing
      try {
        const r = await api.stopRecording()
        setWavSessionId(r.session_id)
      } catch {}
    } else {
      try {
        // Start recording before playback
        api.startRecording().catch(() => {})
        await el.play()
        setPlaying(true)
        setWallStart(Date.now() / 1000 - el.currentTime + LATENCY_OFFSET_SEC)
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
      setWallStart(Date.now() / 1000 - t + LATENCY_OFFSET_SEC)
    }
  }, [playing])

  const handleRestart = () => {
    handleSeek(0)
    const el = audioRef.current
    if (el && !playing) { el.play(); setPlaying(true) }
  }

  const handleEnded = useCallback(async () => {
    setPlaying(false)
    // Stop recording and prompt to save
    try {
      const r = await api.stopRecording()
      setWavSessionId(r.session_id)
    } catch {}
    setShowSavePrompt(true)
  }, [])

  const handleSaveSession = () => {
    if (!song || !jobId) return
    const duration = recordedFrames.length > 1
      ? recordedFrames[recordedFrames.length - 1].ts - recordedFrames[0].ts
      : currentTime
    saveSession.mutate(
      {
        frames: recordedFrames as object[],
        name: song.original_name,
        song_job_id: jobId,
        duration,
        wav_session_id: wavSessionId ?? undefined,
      },
      {
        onSuccess: () => {
          setShowSavePrompt(false)
          setWavSessionId(null)
          navigate('/sessions')
        },
      }
    )
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
        <TuneBadge level={karaokePitch?.voiced ? (karaokePitch.karaoke_tune ?? karaokePitch.tune_level) : null} />
        <button
          onClick={() => {
            if (recordedFrames.length > 0) setShowSavePrompt(true)
          }}
          title="保存本次练习"
          className="rounded border border-border p-1.5 text-text-muted hover:border-accent/40 hover:text-accent transition-colors"
        >
          <Save size={15} />
        </button>
        <button
          onClick={toggleStyle}
          className="rounded border border-border px-2 py-0.5 text-xs text-text-muted hover:border-accent/40 transition-colors"
        >
          {style === 'piano' ? 'Piano Roll' : '折线'}
        </button>
      </div>

      {/* 歌词显示（如有） */}
      {song.lyrics && song.lyrics.length > 0 && (
        <div className="border-b border-border/50 bg-bg-card/50">
          <LyricsDisplay lyrics={song.lyrics} currentTime={currentTime} />
        </div>
      )}

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
          <NeedleMeter pitch={karaokePitch ?? latestPitch} className="absolute inset-0" />
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
        src={song.original_url ?? song.audio_url}
        onTimeUpdate={e => setCurrentTime((e.target as HTMLAudioElement).currentTime)}
        onEnded={handleEnded}
        onError={e => console.error('Audio error', e)}
        preload="auto"
      />

      {/* Save prompt overlay */}
      {showSavePrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80 backdrop-blur-sm">
          <div className="w-72 rounded-xl border border-border bg-bg-card p-6 shadow-lg flex flex-col gap-4">
            <h3 className="font-semibold text-text">保存本次练习？</h3>
            <p className="text-sm text-text-muted">
              已录制 <span className="text-accent font-mono">{recordedFrames.length}</span> 帧音高数据
              {wavSessionId && '，以及 WAV 录音'}
            </p>
            <div className={cn('text-xs text-text-muted', !song.original_name && 'hidden')}>
              歌曲：{song.original_name}
            </div>
            <div className="flex gap-3">
              <button
                onClick={handleSaveSession}
                disabled={saveSession.isPending}
                className="flex-1 rounded bg-accent py-2 text-sm font-medium text-bg hover:bg-accent/80 disabled:opacity-50 transition-colors"
              >
                {saveSession.isPending ? '保存中…' : '保存'}
              </button>
              <button
                onClick={() => setShowSavePrompt(false)}
                className="flex-1 rounded border border-border py-2 text-sm text-text-muted hover:bg-border/20 transition-colors"
              >
                跳过
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}
