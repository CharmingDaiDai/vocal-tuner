import { useMemo } from 'react'
import type { PitchMessage } from '@/types'

interface Props {
  frames: PitchMessage[]
}

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
  sharpPct: number   // 偏高比例
  flatPct: number    // 偏低比例
  midiMin: number
  midiMax: number
  timeline: ('good' | 'close' | 'off')[]  // 每4帧一个区间
}

function computeStats(frames: PitchMessage[]): Stats | null {
  const voiced = frames.filter(f => f.voiced && f.tune_level)
  if (voiced.length === 0) return null

  let good = 0, close = 0, off = 0
  let centsSum = 0, sharpCount = 0, flatCount = 0
  let midiMin = Infinity, midiMax = -Infinity

  for (const f of voiced) {
    if (f.tune_level === 'good') good++
    else if (f.tune_level === 'close') close++
    else off++

    const c = f.cents ?? 0
    centsSum += c
    if (c > 5) sharpCount++
    else if (c < -5) flatCount++

    if (f.freq > 0) {
      const m = 69 + 12 * Math.log2(f.freq / 440)
      if (m < midiMin) midiMin = m
      if (m > midiMax) midiMax = m
    }
  }

  const total = voiced.length
  const goodPct = (good / total) * 100
  const closePct = (close / total) * 100
  const offPct = (off / total) * 100
  const score = Math.round(goodPct * 1.0 + closePct * 0.6 + offPct * 0.2)
  const avgCents = centsSum / total

  // Timeline: group voiced frames by 4, pick dominant tune_level
  const timeline: ('good' | 'close' | 'off')[] = []
  for (let i = 0; i < voiced.length; i += 4) {
    const chunk = voiced.slice(i, i + 4)
    const counts = { good: 0, close: 0, off: 0 }
    chunk.forEach(f => { if (f.tune_level) counts[f.tune_level]++ })
    const dom = (Object.entries(counts) as [('good' | 'close' | 'off'), number][])
      .sort((a, b) => b[1] - a[1])[0][0]
    timeline.push(dom)
  }

  return {
    total, good, close, off,
    goodPct, closePct, offPct, score,
    avgCents,
    sharpPct: (sharpCount / total) * 100,
    flatPct: (flatCount / total) * 100,
    midiMin: midiMin === Infinity ? 60 : midiMin,
    midiMax: midiMax === -Infinity ? 60 : midiMax,
    timeline,
  }
}

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

// ── Cents histogram ────────────────────────────────────────
function CentsHistogram({ frames }: { frames: PitchMessage[] }) {
  const bins = useMemo(() => {
    const b = new Array(20).fill(0)  // -50 to +50, step 5
    frames.filter(f => f.voiced && f.cents != null).forEach(f => {
      const idx = Math.floor((f.cents! + 50) / 5)
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

// ── Timeline strip ─────────────────────────────────────────
function Timeline({ data }: { data: ('good' | 'close' | 'off')[] }) {
  const COLOR = { good: '#3fb950', close: '#d29922', off: '#f85149' } as const
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-text-muted">准确度时间轴</div>
      <div className="flex h-5 gap-px overflow-hidden rounded">
        {data.map((level, i) => (
          <div key={i} className="flex-1" style={{ backgroundColor: COLOR[level] }} title={level} />
        ))}
      </div>
      <div className="mt-0.5 flex justify-between text-[9px] text-text-muted">
        <span>开始</span><span>结束</span>
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────
export default function PracticeReport({ frames }: Props) {
  const stats = useMemo(() => computeStats(frames), [frames])

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

  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-start gap-6">
        <ScoreRing score={stats.score} />
        <div className="flex flex-col gap-1 justify-center">
          <div className="text-sm text-text">
            共分析 <span className="font-mono text-accent">{stats.total}</span> 帧有声数据
          </div>
          <div className="text-sm text-text">
            平均偏差：<span className="font-mono" style={{ color: Math.abs(stats.avgCents) <= 15 ? '#3fb950' : '#d29922' }}>{tendencyText}</span>
          </div>
          <div className="text-sm text-text">
            音域范围：<span className="font-mono text-accent">{midiToNote(stats.midiMin)} — {midiToNote(stats.midiMax)}</span>
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

      {/* Cents histogram */}
      <div className="rounded-lg border border-border bg-bg-card p-4">
        <CentsHistogram frames={frames} />
      </div>

      {/* Timeline */}
      {stats.timeline.length > 0 && (
        <div className="rounded-lg border border-border bg-bg-card p-4">
          <Timeline data={stats.timeline} />
        </div>
      )}
    </div>
  )
}
