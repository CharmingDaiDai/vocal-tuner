import { useMemo, useRef, useEffect } from 'react'
import type { PitchMessage, PitchPoint } from '@/types'

interface Props {
  frames: PitchMessage[]
  refPitches?: PitchPoint[]
  audioUrl?: string
  duration?: number
}

// ── Stats ─────────────────────────────────────────────────
interface Stats {
  total: number
  good: number
  close: number
  off: number
  goodPct: number
  closePct: number
  offPct: number
  score: number
  avgCents: number
  sharpPct: number
  flatPct: number
  midiMin: number
  midiMax: number
}

interface SegmentScore {
  startSec: number
  endSec: number
  score: number
  goodPct: number
}

const SEGMENT_SEC = 15

function computeStats(frames: PitchMessage[]): Stats | null {
  const voiced = frames.filter(f => f.voiced)
  // Use karaoke_tune if available, else tune_level
  const scored = voiced.filter(f => (f.karaoke_tune ?? f.tune_level))
  if (scored.length === 0) return null

  let good = 0, close = 0, off = 0
  let centsSum = 0, sharpCount = 0, flatCount = 0
  let midiMin = Infinity, midiMax = -Infinity

  for (const f of scored) {
    const level = f.karaoke_tune ?? f.tune_level
    if (level === 'good') good++
    else if (level === 'close') close++
    else off++

    const c = f.karaoke_cents ?? f.cents ?? 0
    centsSum += c
    if (c > 5) sharpCount++
    else if (c < -5) flatCount++

    if (f.freq > 0) {
      const m = 69 + 12 * Math.log2(f.freq / 440)
      if (m < midiMin) midiMin = m
      if (m > midiMax) midiMax = m
    }
  }

  const total = scored.length
  const goodPct = (good / total) * 100
  const closePct = (close / total) * 100
  const offPct = (off / total) * 100
  const score = Math.round(goodPct * 1.0 + closePct * 0.6 + offPct * 0.2)

  return {
    total, good, close, off,
    goodPct, closePct, offPct, score,
    avgCents: centsSum / total,
    sharpPct: (sharpCount / total) * 100,
    flatPct: (flatCount / total) * 100,
    midiMin: midiMin === Infinity ? 60 : midiMin,
    midiMax: midiMax === -Infinity ? 60 : midiMax,
  }
}

function computeSegments(frames: PitchMessage[], duration: number): SegmentScore[] {
  if (duration <= 0 || frames.length === 0) return []
  // Karaoke sessions have song_time; free-practice falls back to relative ts
  const hasKaraokeTime = frames.some(f => f.song_time != null)
  const firstTs = frames[0].ts
  const getT = (f: PitchMessage): number | null =>
    hasKaraokeTime ? (f.song_time ?? null) : (f.ts - firstTs)

  const segments: SegmentScore[] = []
  const numSegs = Math.ceil(duration / SEGMENT_SEC)

  for (let i = 0; i < numSegs; i++) {
    const startSec = i * SEGMENT_SEC
    const endSec = Math.min((i + 1) * SEGMENT_SEC, duration)
    const segFrames = frames.filter(f => {
      const t = getT(f)
      return t != null && t >= startSec && t < endSec && f.voiced
    })
    const scored = segFrames.filter(f => f.karaoke_tune ?? f.tune_level)
    if (scored.length === 0) {
      segments.push({ startSec, endSec, score: 0, goodPct: 0 })
      continue
    }
    let good = 0, close = 0, off = 0
    for (const f of scored) {
      const level = f.karaoke_tune ?? f.tune_level
      if (level === 'good') good++
      else if (level === 'close') close++
      else off++
    }
    const total = scored.length
    const goodPct = (good / total) * 100
    const closePct = (close / total) * 100
    const offPct = (off / total) * 100
    const score = Math.round(goodPct * 1.0 + closePct * 0.6 + offPct * 0.2)
    segments.push({ startSec, endSec, score, goodPct })
  }
  return segments
}

// ── Score Ring ────────────────────────────────────────────
function ScoreRing({ score }: { score: number }) {
  const r = 36, circ = 2 * Math.PI * r
  const pct = score / 100
  const color = score >= 80 ? '#3fb950' : score >= 60 ? '#d29922' : '#f85149'
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width="90" height="90" viewBox="0 0 90 90">
        <circle cx="45" cy="45" r={r} fill="none" stroke="#30363d" strokeWidth="8" />
        <circle
          cx="45" cy="45" r={r}
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - pct)}
          strokeLinecap="round"
          transform="rotate(-90 45 45)"
        />
        <text x="45" y="50" textAnchor="middle" fill={color} fontSize="22" fontWeight="bold" fontFamily="monospace">
          {score}
        </text>
      </svg>
      <span className="text-xs text-text-muted">综合评分</span>
    </div>
  )
}

// ── Accuracy Bar ──────────────────────────────────────────
function Bar({ label, pct, color }: { label: string; pct: number; color: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-8 text-right text-text-muted">{label}</span>
      <div className="relative h-4 flex-1 rounded bg-border/30">
        <div
          className="absolute h-full rounded transition-all duration-500"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <span className="w-10 font-mono text-text-muted">{pct.toFixed(1)}%</span>
    </div>
  )
}

// ── Cents Histogram ───────────────────────────────────────
function CentsHistogram({ frames }: { frames: PitchMessage[] }) {
  const bins = useMemo(() => {
    const b = new Array(20).fill(0)
    frames.filter(f => f.voiced).forEach(f => {
      const c = f.karaoke_cents ?? f.cents
      if (c == null) return
      const idx = Math.floor((c + 50) / 5)
      if (idx >= 0 && idx < 20) b[idx]++
    })
    const max = Math.max(...b, 1)
    return b.map((v, i) => ({ v, pct: v / max * 100, cents: -47.5 + i * 5 }))
  }, [frames])

  return (
    <div>
      <div className="mb-1 text-xs font-medium text-text-muted">音分偏差分布</div>
      <div className="flex h-16 items-end gap-px">
        {bins.map((b, i) => (
          <div
            key={i}
            className="flex-1 rounded-t transition-all"
            style={{
              height: `${b.pct}%`,
              backgroundColor: b.cents >= -15 && b.cents <= 15 ? '#3fb950' :
                               b.cents >= -30 && b.cents <= 30 ? '#d29922' : '#f85149',
              minHeight: b.v > 0 ? 2 : 0,
            }}
            title={`${b.cents > 0 ? '+' : ''}${b.cents}¢: ${b.v}帧`}
          />
        ))}
      </div>
      <div className="mt-0.5 flex justify-between text-[9px] text-text-muted">
        <span>-50¢</span><span>0</span><span>+50¢</span>
      </div>
    </div>
  )
}

// ── Segment scores ────────────────────────────────────────
function SegmentBars({ segments }: { segments: SegmentScore[] }) {
  if (segments.length === 0) return null
  const fmt = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, '0')}`
  }
  return (
    <div>
      <div className="mb-2 text-xs font-medium text-text-muted">分段评分（每 {SEGMENT_SEC}s）</div>
      <div className="flex flex-col gap-1">
        {segments.map((seg, i) => {
          const color = seg.score >= 80 ? '#3fb950' : seg.score >= 60 ? '#d29922' : '#f85149'
          return (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className="w-16 text-right font-mono text-text-muted">
                {fmt(seg.startSec)}
              </span>
              <div className="relative h-3.5 flex-1 rounded bg-border/30">
                <div
                  className="absolute h-full rounded transition-all duration-300"
                  style={{ width: `${seg.score}%`, backgroundColor: color }}
                />
              </div>
              <span className="w-8 font-mono text-text-muted">{seg.score}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Pitch Comparison Canvas ───────────────────────────────
function PitchCompareChart({ frames, refPitches, duration }: {
  frames: PitchMessage[]
  refPitches: PitchPoint[]
  duration: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cvs = canvasRef.current
    if (!cvs) return
    const ctx = cvs.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const rect = cvs.getBoundingClientRect()
    const w = rect.width * dpr
    const h = rect.height * dpr
    cvs.width = w
    cvs.height = h
    ctx.scale(dpr, dpr)
    const W = rect.width
    const H = rect.height

    ctx.clearRect(0, 0, W, H)

    // Compute MIDI range from both reference and user frames
    let midiMin = 100, midiMax = 30
    for (const p of refPitches) {
      if (p.voiced && p.midi != null) {
        if (p.midi < midiMin) midiMin = p.midi
        if (p.midi > midiMax) midiMax = p.midi
      }
    }
    for (const f of frames) {
      if (f.voiced && f.freq > 0) {
        const m = 69 + 12 * Math.log2(f.freq / 440)
        if (m < midiMin) midiMin = m
        if (m > midiMax) midiMax = m
      }
    }
    midiMin = Math.floor(midiMin) - 2
    midiMax = Math.ceil(midiMax) + 2
    const midiRange = Math.max(midiMax - midiMin, 12)

    const MARGIN_L = 32, MARGIN_R = 8, MARGIN_T = 4, MARGIN_B = 16
    const plotW = W - MARGIN_L - MARGIN_R
    const plotH = H - MARGIN_T - MARGIN_B

    const tToX = (t: number) => MARGIN_L + (t / duration) * plotW
    const midiToY = (m: number) => MARGIN_T + plotH - ((m - midiMin) / midiRange) * plotH

    // Background grid (every 2 semitones)
    ctx.strokeStyle = '#21262d'
    ctx.lineWidth = 0.5
    const noteNames = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
    for (let m = Math.ceil(midiMin); m <= Math.floor(midiMax); m++) {
      if (m % 2 !== 0) continue
      const y = midiToY(m)
      ctx.beginPath()
      ctx.moveTo(MARGIN_L, y)
      ctx.lineTo(W - MARGIN_R, y)
      ctx.stroke()
      // Label
      if (m % 12 === 0 || m % 12 === 4 || m % 12 === 7) {
        ctx.fillStyle = '#484f58'
        ctx.font = '9px monospace'
        ctx.textAlign = 'right'
        ctx.textBaseline = 'middle'
        ctx.fillText(`${noteNames[m % 12]}${Math.floor(m / 12) - 1}`, MARGIN_L - 3, y)
      }
    }

    // Reference track (blue)
    ctx.globalAlpha = 0.5
    ctx.fillStyle = '#58a6ff'
    const barH = Math.max(2, plotH / midiRange * 0.6)
    for (const p of refPitches) {
      if (!p.voiced || p.midi == null) continue
      const x = tToX(p.t)
      const y = midiToY(p.midi)
      ctx.fillRect(x - 0.5, y - barH / 2, 1.5, barH)
    }
    ctx.globalAlpha = 1.0

    // User track (colored by karaoke_tune)
    const COLOR = { good: '#3fb950', close: '#d29922', off: '#f85149' }
    for (const f of frames) {
      if (!f.voiced || !f.freq || f.song_time == null) continue
      const m = 69 + 12 * Math.log2(f.freq / 440)
      const x = tToX(f.song_time)
      const y = midiToY(m)
      const level = f.karaoke_tune ?? f.tune_level ?? 'off'
      ctx.fillStyle = COLOR[level] ?? '#f85149'
      ctx.globalAlpha = 0.85
      ctx.beginPath()
      ctx.arc(x, y, 1.8, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1.0

    // Time axis labels
    ctx.fillStyle = '#484f58'
    ctx.font = '9px monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    const step = duration > 180 ? 30 : duration > 60 ? 15 : 10
    for (let t = 0; t <= duration; t += step) {
      const m = Math.floor(t / 60)
      const s = Math.floor(t % 60)
      ctx.fillText(`${m}:${s.toString().padStart(2, '0')}`, tToX(t), H - MARGIN_B + 2)
    }
  }, [frames, refPitches, duration])

  return (
    <div>
      <div className="mb-1 flex items-center gap-3 text-xs text-text-muted">
        <span className="font-medium">音高对比</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-4 rounded bg-[#58a6ff]/50" /> 参考</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-4 rounded bg-[#3fb950]" /> 准</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-4 rounded bg-[#d29922]" /> 偏</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-4 rounded bg-[#f85149]" /> 跑调</span>
      </div>
      <canvas
        ref={canvasRef}
        className="h-40 w-full rounded border border-border/50 bg-[#0d1117]"
        style={{ imageRendering: 'pixelated' }}
      />
    </div>
  )
}

// ── Main component ────────────────────────────────────────
export default function PracticeReport({ frames, refPitches, audioUrl, duration: propDuration }: Props) {
  const stats = useMemo(() => computeStats(frames), [frames])
  const duration = propDuration ?? (frames.length > 1
    ? (frames[frames.length - 1].song_time ?? frames[frames.length - 1].ts) - (frames[0].song_time ?? frames[0].ts)
    : 0)
  const segments = useMemo(
    () => computeSegments(frames, duration),
    [frames, duration],
  )

  if (!stats) {
    return (
      <div className="flex h-40 items-center justify-center text-text-muted text-sm">
        数据不足，请先完成一次练习
      </div>
    )
  }

  const tendencyText = stats.avgCents > 5
    ? `偏高 +${stats.avgCents.toFixed(1)}¢`
    : stats.avgCents < -5
    ? `偏低 ${stats.avgCents.toFixed(1)}¢`
    : '音准居中'

  const midiToNote = (m: number) => {
    const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    const n = Math.round(m)
    return notes[n % 12] + Math.floor(n / 12 - 1)
  }

  const hasKaraoke = frames.some(f => f.karaoke_tune != null)

  return (
    <div className="flex flex-col gap-5">
      {/* Audio player (prominent) */}
      {audioUrl && (
        <div className="rounded-lg border border-border bg-bg-card p-4">
          <div className="mb-2 text-xs font-medium text-text-muted">录音回放</div>
          <audio controls src={audioUrl} className="w-full" />
        </div>
      )}

      {/* Header: Score + key metrics */}
      <div className="flex items-start gap-6">
        <ScoreRing score={stats.score} />
        <div className="flex flex-col gap-1.5 justify-center">
          <div className="text-sm text-text">
            共分析 <span className="font-mono text-accent">{stats.total}</span> 帧有声数据
            {hasKaraoke && <span className="ml-2 text-xs text-accent/70">(参考对比模式)</span>}
          </div>
          <div className="text-sm text-text">
            平均偏差：<span className="font-mono" style={{ color: Math.abs(stats.avgCents) <= 15 ? '#3fb950' : '#d29922' }}>{tendencyText}</span>
          </div>
          <div className="text-sm text-text">
            音域范围：<span className="font-mono text-accent">{midiToNote(stats.midiMin)} — {midiToNote(stats.midiMax)}</span>
          </div>
          <div className="text-sm text-text">
            偏高 <span className="font-mono text-[#d29922]">{stats.sharpPct.toFixed(0)}%</span>
            {' / '}偏低 <span className="font-mono text-[#58a6ff]">{stats.flatPct.toFixed(0)}%</span>
          </div>
        </div>
      </div>

      {/* Accuracy bars */}
      <div className="rounded-lg border border-border bg-bg-card p-4 flex flex-col gap-2">
        <div className="mb-1 text-xs font-medium text-text-muted">准确率分布</div>
        <Bar label="准" pct={stats.goodPct} color="#3fb950" />
        <Bar label="偏" pct={stats.closePct} color="#d29922" />
        <Bar label="跑调" pct={stats.offPct} color="#f85149" />
      </div>

      {/* Pitch comparison chart (only when reference data available) */}
      {refPitches && refPitches.length > 0 && duration > 0 && (
        <div className="rounded-lg border border-border bg-bg-card p-4">
          <PitchCompareChart frames={frames} refPitches={refPitches} duration={duration} />
        </div>
      )}

      {/* Segment scores */}
      {segments.length > 1 && (
        <div className="rounded-lg border border-border bg-bg-card p-4">
          <SegmentBars segments={segments} />
        </div>
      )}

      {/* Cents histogram */}
      <div className="rounded-lg border border-border bg-bg-card p-4">
        <CentsHistogram frames={frames} />
      </div>
    </div>
  )
}
