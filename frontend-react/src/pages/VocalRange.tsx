/**
 * VocalRange.tsx — 音域测试页面
 *
 * 引导用户从低到高依次唱音符，记录成功发声的最低 / 最高 MIDI 音，
 * 在钢琴键盘上高亮显示用户音域。
 */
import { useState, useEffect, useRef } from 'react'
import { useWsStore } from '@/store/wsStore'
import { cn } from '@/lib/cn'

// Notes to test, C2 → C6
const TEST_NOTES: Array<{ midi: number; label: string }> = (() => {
  const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  const notes = []
  for (let midi = 36; midi <= 84; midi += 1) {
    const octave = Math.floor(midi / 12) - 1
    const name = noteNames[midi % 12]
    // Only label natural notes + some sharps for display
    notes.push({ midi, label: `${name}${octave}` })
  }
  return notes
})()

// Piano-key rendering helpers
function isBlackKey(midi: number): boolean {
  return [1, 3, 6, 8, 10].includes(midi % 12)
}

function PianoRangeDisplay({
  minMidi,
  maxMidi,
}: {
  minMidi: number | null
  maxMidi: number | null
}) {
  // Show C2 – C7 range (midi 36–96)
  const start = 36
  const end = 84
  const whiteKeys: number[] = []
  for (let m = start; m <= end; m++) {
    if (!isBlackKey(m)) whiteKeys.push(m)
  }

  return (
    <div className="relative w-full overflow-x-auto">
      <div className="relative flex h-24 min-w-[600px]">
        {whiteKeys.map((midi, i) => {
          const inRange = minMidi != null && maxMidi != null && midi >= minMidi && midi <= maxMidi
          const isMin = midi === minMidi
          const isMax = midi === maxMidi
          return (
            <div
              key={midi}
              className={cn(
                'relative flex-1 border border-border/50 rounded-b flex items-end justify-center pb-1',
                inRange ? 'bg-accent/30' : 'bg-bg-card',
                (isMin || isMax) && 'bg-accent/60',
              )}
            >
              {(isMin || isMax) && (
                <span className="text-[8px] font-mono text-accent font-bold">
                  {TEST_NOTES.find(n => n.midi === midi)?.label ?? ''}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

type Phase = 'idle' | 'testing-low' | 'testing-high' | 'done'

const TARGET_LOW_MIDI = 52   // E3 — a comfortable starting point going down
const TARGET_HIGH_MIDI = 64  // E4 — going up
const HOLD_FRAMES = 8        // frames to hold note for it to count

export default function VocalRange() {
  const { latestPitch } = useWsStore()
  const [phase, setPhase] = useState<Phase>('idle')
  const [minMidi, setMinMidi] = useState<number | null>(null)
  const [maxMidi, setMaxMidi] = useState<number | null>(null)
  const [currentTarget, setCurrentTarget] = useState<number>(TARGET_LOW_MIDI)
  const [heldFrames, setHeldFrames] = useState(0)
  const [succeeded, setSucceeded] = useState<Set<number>>(new Set())
  const [message, setMessage] = useState('')
  const heldRef = useRef(0)

  const startTest = () => {
    setPhase('testing-low')
    setCurrentTarget(TARGET_LOW_MIDI)
    setMinMidi(null)
    setMaxMidi(null)
    setSucceeded(new Set())
    heldRef.current = 0
    setHeldFrames(0)
    setMessage(`请唱 ${TEST_NOTES.find(n => n.midi === TARGET_LOW_MIDI)?.label}，我们将从这里向低音测试`)
  }

  useEffect(() => {
    if (phase === 'idle' || phase === 'done') return
    if (!latestPitch?.voiced || !latestPitch.freq) return

    const currentMidi = Math.round(69 + 12 * Math.log2(latestPitch.freq / 440))
    const diff = Math.abs(currentMidi - currentTarget)

    if (diff <= 1) {
      heldRef.current++
      setHeldFrames(heldRef.current)

      if (heldRef.current >= HOLD_FRAMES) {
        // Note confirmed!
        setSucceeded(prev => new Set([...prev, currentTarget]))
        heldRef.current = 0
        setHeldFrames(0)

        if (phase === 'testing-low') {
          const nextTarget = currentTarget - 1
          if (nextTarget < 36) {
            // Reached lowest testable, switch to high
            setMinMidi(currentTarget)
            setPhase('testing-high')
            setCurrentTarget(TARGET_HIGH_MIDI)
            setMessage(`很好！向高音测试。请唱 ${TEST_NOTES.find(n => n.midi === TARGET_HIGH_MIDI)?.label}`)
          } else {
            setMinMidi(currentTarget)
            setCurrentTarget(nextTarget)
            setMessage(`继续！请唱 ${TEST_NOTES.find(n => n.midi === nextTarget)?.label}`)
          }
        } else {
          // testing-high
          const nextTarget = currentTarget + 1
          if (nextTarget > 84) {
            setMaxMidi(currentTarget)
            setPhase('done')
            setMessage('测试完成！')
          } else {
            setMaxMidi(currentTarget)
            setCurrentTarget(nextTarget)
            setMessage(`继续！请唱 ${TEST_NOTES.find(n => n.midi === nextTarget)?.label}`)
          }
        }
      }
    } else {
      heldRef.current = Math.max(0, heldRef.current - 1)
      setHeldFrames(heldRef.current)
    }
  }, [latestPitch, phase, currentTarget])

  const targetLabel = TEST_NOTES.find(n => n.midi === currentTarget)?.label ?? ''
  const holdPct = Math.min(100, (heldFrames / HOLD_FRAMES) * 100)

  const rangeLabel = minMidi != null && maxMidi != null
    ? `${TEST_NOTES.find(n => n.midi === minMidi)?.label} — ${TEST_NOTES.find(n => n.midi === maxMidi)?.label}`
    : '—'

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto p-5">
      <div>
        <h1 className="text-lg font-semibold text-text">音域测试</h1>
        <p className="text-sm text-text-muted">测量你的演唱音域范围，从低音到高音逐步检测</p>
      </div>

      {/* Start / result card */}
      <div className="rounded-xl border border-border bg-bg-card p-6 flex flex-col items-center gap-4">
        {phase === 'idle' && (
          <>
            <p className="text-sm text-text-muted text-center max-w-xs">
              点击开始后，按提示依次演唱每个音名，每个音持续约 0.2 秒即可记录。
              未能演唱的音将标记为边界。
            </p>
            <button
              onClick={startTest}
              className="rounded-lg bg-accent px-6 py-2 text-sm font-medium text-bg hover:bg-accent/80 transition-colors"
            >
              开始测试
            </button>
          </>
        )}

        {(phase === 'testing-low' || phase === 'testing-high') && (
          <>
            <div className="text-center">
              <div className="text-xs text-text-muted mb-1">
                {phase === 'testing-low' ? '低音探测中' : '高音探测中'}
              </div>
              <div className="font-mono text-4xl font-bold text-accent">{targetLabel}</div>
              <div className="text-xs text-text-muted mt-1">
                {latestPitch?.voiced
                  ? `检测到 ${TEST_NOTES.find(n => n.midi === Math.round(69 + 12 * Math.log2((latestPitch?.freq ?? 440) / 440)))?.label ?? '?'}`
                  : '请演唱…'}
              </div>
            </div>

            {/* Hold progress bar */}
            <div className="w-full max-w-xs">
              <div className="h-2 rounded-full bg-border">
                <div
                  className="h-full rounded-full bg-accent transition-all duration-100"
                  style={{ width: `${holdPct}%` }}
                />
              </div>
              <div className="mt-1 text-center text-xs text-text-muted">保持 {heldFrames}/{HOLD_FRAMES} 帧</div>
            </div>

            <div className="text-sm text-text-muted text-center max-w-xs">{message}</div>

            <button
              onClick={() => {
                // Skip current note, move on
                if (phase === 'testing-low') {
                  setMinMidi(currentTarget + 1)
                  setPhase('testing-high')
                  setCurrentTarget(TARGET_HIGH_MIDI)
                  setMessage(`切换到高音测试。请唱 ${TEST_NOTES.find(n => n.midi === TARGET_HIGH_MIDI)?.label}`)
                } else {
                  setMaxMidi(currentTarget - 1)
                  setPhase('done')
                  setMessage('测试完成！')
                }
                heldRef.current = 0
                setHeldFrames(0)
              }}
              className="text-xs text-text-muted hover:text-text underline transition-colors"
            >
              跳过（无法演唱此音）
            </button>
          </>
        )}

        {phase === 'done' && (
          <>
            <div className="text-center">
              <div className="text-xs text-text-muted mb-1">你的演唱音域</div>
              <div className="font-mono text-2xl font-bold text-accent">{rangeLabel}</div>
              {minMidi != null && maxMidi != null && (
                <div className="text-xs text-text-muted mt-1">
                  共 {maxMidi - minMidi + 1} 个半音 ({((maxMidi - minMidi) / 12).toFixed(1)} 个八度)
                </div>
              )}
            </div>
            <button
              onClick={startTest}
              className="rounded border border-border px-4 py-1.5 text-sm text-text-muted hover:text-text transition-colors"
            >
              重新测试
            </button>
          </>
        )}
      </div>

      {/* Piano visualization */}
      {(minMidi != null || maxMidi != null) && (
        <div className="rounded-xl border border-border bg-bg-card p-4">
          <div className="mb-2 text-xs font-medium text-text-muted">音域键盘示意（C2 — C6）</div>
          <PianoRangeDisplay minMidi={minMidi} maxMidi={maxMidi} />
          <div className="mt-2 flex items-center gap-2 text-xs text-text-muted">
            <div className="h-3 w-3 rounded-sm bg-accent/30" /> 音域范围
            <div className="h-3 w-3 rounded-sm bg-accent/60 ml-2" /> 边界音
          </div>
        </div>
      )}

      {/* Tips */}
      <div className="rounded-xl border border-border bg-bg-card/50 p-4 text-xs text-text-muted space-y-1">
        <div className="font-medium text-text">使用说明</div>
        <div>• 测试时请保持稳定音量，靠近麦克风</div>
        <div>• 每个音保持约 0.2 秒即可记录（8 帧）</div>
        <div>• 无法演唱的音可点击"跳过"继续</div>
        <div>• 音域数据仅在本页面显示，不会自动保存</div>
      </div>
    </div>
  )
}
