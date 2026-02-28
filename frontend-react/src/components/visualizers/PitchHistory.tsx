import { useRef, useCallback, useEffect } from 'react'
import { useCanvas } from '@/hooks/useCanvas'
import type { PitchMessage, PitchPoint } from '@/types'

// ── Constants ──────────────────────────────────────────────
const WINDOW_SEC   = 8
const AHEAD_SEC    = 1.0  // indicator looks-ahead target
const LABEL_W      = 36
const MIDI_MIN     = 36   // C2
const MIDI_MAX     = 83   // B5
const MAX_GAP_SEC  = 0.18

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']

function tuneColor(cents: number | null | undefined): string {
  const a = Math.abs(cents ?? 0)
  if (a <= 15) return '#3fb950'
  if (a <= 30) return '#d29922'
  return '#f85149'
}

function freqToMidi(freq: number): number | null {
  if (!freq || freq <= 0) return null
  return Math.round((69 + 12 * Math.log2(freq / 440)) * 100) / 100
}

// ── Point type used internally ─────────────────────────────
interface InternalPoint {
  ts: number
  midi: number | null
  voiced: boolean
  cents: number | null
  confidence?: number
  note_full?: string | null
}

function buildRefPoints(pitches: PitchPoint[], wallStart: number): InternalPoint[] {
  return pitches.map(p => ({
    ts: wallStart + p.t,
    midi: p.midi,
    voiced: p.voiced,
    cents: null,
    confidence: p.confidence,
  }))
}

interface Props {
  /** Live mic frames */
  frames: PitchMessage[]
  /** Optional reference pitch data (for karaoke compare mode) */
  refPitches?: PitchPoint[]
  /** Wall-clock time when the reference track started playing */
  wallStart?: number
  style?: 'piano' | 'line'
  /** Number of visible MIDI semitones on Y axis (6–52, default 24) */
  midiRange?: number
  /** When false, Y-axis center is frozen (no auto-follow) */
  autoFollow?: boolean
  /** Called on wheel scroll with zoom delta (+4 or -4) */
  onZoom?: (delta: number) => void
  className?: string
}

export function PitchHistory({ frames, refPitches, wallStart, style = 'piano', midiRange = 24, autoFollow = true, onZoom, className }: Props) {
  const midiCenterRef = useRef(60)  // LERP target midi for Y-axis center
  const midiDisplayRef = useRef(60) // current smoothed center

  const getPoints = useCallback((): InternalPoint[] => {
    return frames.map(f => ({
      ts: f.ts,
      midi: freqToMidi(f.freq),
      voiced: f.voiced,
      cents: f.cents,
      confidence: f.confidence,
      note_full: f.note_full,
    }))
  }, [frames])

  const canvasRef = useCanvas((ctx, { w, h }) => {
    ctx.clearRect(0, 0, w, h)

    const now      = Date.now() / 1000
    const winStart = now - WINDOW_SEC + AHEAD_SEC
    const plotW    = w - LABEL_W

    // Collect visible points
    const pts = getPoints().filter(p => p.ts >= winStart - 0.5 && p.ts <= winStart + WINDOW_SEC + 0.5)

    // Update MIDI center (LERP toward voiced points) — only when autoFollow
    if (autoFollow) {
      const recentVoiced = pts.filter(p => p.voiced && p.midi !== null && p.ts > now - 2)
      if (recentVoiced.length > 0) {
        const avg = recentVoiced.reduce((s, p) => s + p.midi!, 0) / recentVoiced.length
        midiCenterRef.current = avg
      }
    }
    midiDisplayRef.current += (midiCenterRef.current - midiDisplayRef.current) * 0.08
    const half      = midiRange / 2
    const midiCenter = Math.max(MIDI_MIN + half, Math.min(MIDI_MAX - half, midiDisplayRef.current))

    // Visible MIDI range
    const pixPerMidi = h / midiRange
    const midiTop    = midiCenter + half
    const midiBot    = midiCenter - half

    const tsToX  = (ts: number) => LABEL_W + ((ts - winStart) / WINDOW_SEC) * plotW
    const midiToY = (m: number) => h - ((m - midiBot) / (midiTop - midiBot)) * h

    // ── Pass 1: dark background ────────────────────────────
    ctx.fillStyle = '#0d1117'
    ctx.fillRect(0, 0, w, h)

    // ── Pass 2: piano grid ─────────────────────────────────
    const BLACK = [1,3,6,8,10]
    for (let midi = Math.ceil(midiBot); midi <= Math.floor(midiTop); midi++) {
      const semitone = ((midi % 12) + 12) % 12
      const y = midiToY(midi)
      const rowH = pixPerMidi

      if (BLACK.includes(semitone)) {
        ctx.fillStyle = '#161b22'
        ctx.fillRect(LABEL_W, y - rowH / 2, plotW, rowH)
      }

      // E-F / B-C dividers
      if (semitone === 5 || semitone === 0) {
        ctx.strokeStyle = '#30363d'
        ctx.lineWidth = 0.5
        ctx.beginPath()
        ctx.moveTo(LABEL_W, y + rowH / 2)
        ctx.lineTo(w, y + rowH / 2)
        ctx.stroke()
      }

      // Note label
      const noteName = NOTE_NAMES[semitone]
      if (noteName.length === 1) {  // Natural notes
        const oct = Math.floor(midi / 12) - 1
        ctx.fillStyle = semitone === 0 ? '#8b949e' : '#30363d'
        ctx.font = `${Math.min(pixPerMidi * 0.75, 11)}px "Inter",sans-serif`
        ctx.textAlign = 'right'
        ctx.textBaseline = 'middle'
        ctx.fillText(`${noteName}${oct}`, LABEL_W - 3, y)
      }
    }

    // Vertical time lines
    ctx.strokeStyle = '#21262d'
    ctx.lineWidth = 0.6
    for (let i = 0; i <= 6; i++) {
      const x = LABEL_W + (i / 6) * plotW
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
    }

    // ── Pass 3: reference track (blue, behind) ─────────────
    if (refPitches && wallStart) {
      drawRefTrack(ctx, refPitches, wallStart, winStart, tsToX, midiToY, pixPerMidi)
    }

    // ── Pass 4: mic track ──────────────────────────────────
    if (style === 'line') {
      drawLineTrack(ctx, pts, tsToX, midiToY, winStart)
    } else {
      drawPianoRollTrack(ctx, pts, tsToX, midiToY, pixPerMidi, winStart)
    }

    // ── Pass 5: current indicator ──────────────────────────
    const recentFour = []
    for (let i = pts.length - 1; i >= 0 && recentFour.length < 4; i--) {
      if (pts[i].voiced && pts[i].midi !== null) recentFour.push(pts[i])
    }
    if (recentFour.length > 0) {
      drawIndicator(ctx, recentFour, tsToX, midiToY, w, h)
    }

    // ── X axis labels ──────────────────────────────────────
    ctx.font = '10px "Inter",sans-serif'
    ctx.fillStyle = '#6e7681'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    for (let i = 0; i <= 6; i++) {
      const x = LABEL_W + (i / 6) * plotW
      const secAgo = Math.round(WINDOW_SEC * (1 - i / 6))
      ctx.fillText(secAgo === 0 ? '现在' : `-${secAgo}s`, x, h - 1)
    }
  })

  // Wheel zoom: pass delta back to parent via onZoom
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !onZoom) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      onZoom(e.deltaY > 0 ? +4 : -4)
    }
    canvas.addEventListener('wheel', handler, { passive: false })
    return () => canvas.removeEventListener('wheel', handler)
  }, [canvasRef, onZoom])

  return <canvas ref={canvasRef} className={className} style={{ width: '100%', height: '100%' }} />
}

// ── Drawing helpers ────────────────────────────────────────

function mergeSegments(pts: InternalPoint[]): { pts: InternalPoint[]; lastTs: number }[] {
  const segs: { pts: InternalPoint[]; lastTs: number }[] = []
  let seg: { pts: InternalPoint[]; lastTs: number } | null = null
  for (const p of pts) {
    if (!p.voiced || p.midi === null) { seg = null; continue }
    if (!seg || (p.ts - seg.lastTs) > MAX_GAP_SEC) {
      seg = { pts: [p], lastTs: p.ts }
      segs.push(seg)
    } else {
      seg.pts.push(p)
      seg.lastTs = p.ts
    }
  }
  return segs
}

function drawPianoRollTrack(
  ctx: CanvasRenderingContext2D,
  pts: InternalPoint[],
  tsToX: (t: number) => number,
  midiToY: (m: number) => number,
  pixPerMidi: number,
  winStart: number,
) {
  const barH   = Math.max(4, Math.min(pixPerMidi * 0.65, 20))
  const segs   = mergeSegments(pts)

  const MIN_CAPS_SEC = 0.06

  for (const s of segs) {
    const dur = s.lastTs - s.pts[0].ts
    const avgConf = s.pts.reduce((a, p) => a + (p.confidence ?? 1), 0) / s.pts.length
    if (dur < MIN_CAPS_SEC && avgConf < 0.75) continue

    const n = s.pts.length
    const first = s.pts[0]
    const last = s.pts[n - 1]
    const midTs = (first.ts + last.ts) / 2
    const ageFrac = Math.max(0, Math.min(1, (midTs - winStart) / WINDOW_SEC))
    const baseAlpha = 0.20 + ageFrac * 0.80

    const avgCents = s.pts.reduce((a, p) => a + (p.cents ?? 0), 0) / n
    const color = tuneColor(avgCents)

    ctx.save()
    ctx.shadowColor = color
    ctx.shadowBlur = 6
    ctx.globalAlpha = baseAlpha * 0.9
    ctx.fillStyle = color

    if (n === 1) {
      const y = midiToY(first.midi!)
      ctx.beginPath()
      ;(ctx as any).roundRect?.(tsToX(first.ts) - barH / 2, y - barH / 2, barH, barH, barH / 2)
      ctx.fill()
    } else {
      const x0 = tsToX(first.ts); const y0 = midiToY(first.midi!)
      const xN = tsToX(last.ts);  const yN = midiToY(last.midi!)

      ctx.beginPath()
      ctx.moveTo(x0, y0 - barH / 2)
      for (let i = 1; i < n; i++) {
        ctx.lineTo(tsToX(s.pts[i].ts), midiToY(s.pts[i].midi!) - barH / 2)
      }
      ctx.arc(xN, yN, barH / 2, -Math.PI / 2, Math.PI / 2)
      for (let i = n - 2; i >= 0; i--) {
        ctx.lineTo(tsToX(s.pts[i].ts), midiToY(s.pts[i].midi!) + barH / 2)
      }
      ctx.arc(x0, y0, barH / 2, Math.PI / 2, -Math.PI / 2, true)
      ctx.closePath()
      ctx.fill()
    }
    ctx.restore()
  }
}

function drawLineTrack(
  ctx: CanvasRenderingContext2D,
  pts: InternalPoint[],
  tsToX: (t: number) => number,
  midiToY: (m: number) => number,
  winStart: number,
) {
  const segs = mergeSegments(pts)

  ctx.save()
  ctx.lineWidth = 2
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  for (const s of segs) {
    const midTs = (s.pts[0].ts + s.lastTs) / 2
    const ageFrac = Math.max(0, Math.min(1, (midTs - winStart) / WINDOW_SEC))
    const avgCents = s.pts.reduce((a, p) => a + (p.cents ?? 0), 0) / s.pts.length
    const color = tuneColor(avgCents)

    ctx.globalAlpha = 0.25 + ageFrac * 0.75
    ctx.strokeStyle = color
    ctx.shadowColor = color
    ctx.shadowBlur = 4
    ctx.beginPath()
    ctx.moveTo(tsToX(s.pts[0].ts), midiToY(s.pts[0].midi!))
    for (let i = 1; i < s.pts.length; i++) {
      ctx.lineTo(tsToX(s.pts[i].ts), midiToY(s.pts[i].midi!))
    }
    ctx.stroke()
  }
  ctx.restore()
}

function drawRefTrack(
  ctx: CanvasRenderingContext2D,
  refPitches: PitchPoint[],
  wallStart: number,
  winStart: number,
  tsToX: (t: number) => number,
  midiToY: (m: number) => number,
  pixPerMidi: number,
) {
  const barH = Math.max(3, Math.min(pixPerMidi * 0.55, 16))
  const refPts = refPitches
    .filter(p => p.voiced && p.midi != null)
    .map(p => ({ ts: wallStart + p.t, midi: p.midi!, voiced: true }))
    .filter(p => p.ts >= winStart && p.ts <= winStart + WINDOW_SEC)

  if (refPts.length === 0) return

  const segs: { pts: typeof refPts; lastTs: number }[] = []
  let seg: { pts: typeof refPts; lastTs: number } | null = null
  for (const p of refPts) {
    if (!seg || (p.ts - seg.lastTs) > MAX_GAP_SEC) {
      seg = { pts: [p], lastTs: p.ts }
      segs.push(seg)
    } else {
      seg.pts.push(p)
      seg.lastTs = p.ts
    }
  }

  ctx.save()
  ctx.globalAlpha = 0.50
  ctx.fillStyle = '#58a6ff'

  for (const s of segs) {
    const pts = s.pts
    const n = pts.length
    if (n === 0) continue

    if (n === 1) {
      const y = midiToY(pts[0].midi)
      ctx.beginPath()
      ;(ctx as any).roundRect?.(tsToX(pts[0].ts) - barH / 2, y - barH / 2, barH, barH, barH / 2)
      ctx.fill()
      continue
    }

    const x0 = tsToX(pts[0].ts); const y0 = midiToY(pts[0].midi)
    const xN = tsToX(pts[n - 1].ts); const yN = midiToY(pts[n - 1].midi)
    ctx.beginPath()
    ctx.moveTo(x0, y0 - barH / 2)
    for (let i = 1; i < n; i++) {
      ctx.lineTo(tsToX(pts[i].ts), midiToY(pts[i].midi) - barH / 2)
    }
    ctx.arc(xN, yN, barH / 2, -Math.PI / 2, Math.PI / 2)
    for (let i = n - 2; i >= 0; i--) {
      ctx.lineTo(tsToX(pts[i].ts), midiToY(pts[i].midi) + barH / 2)
    }
    ctx.arc(x0, y0, barH / 2, Math.PI / 2, -Math.PI / 2, true)
    ctx.closePath()
    ctx.fill()
  }
  ctx.restore()
}

function drawIndicator(
  ctx: CanvasRenderingContext2D,
  recent: InternalPoint[],
  tsToX: (t: number) => number,
  midiToY: (m: number) => number,
  W: number,
  H: number,
) {
  const last = recent[0]
  const x = tsToX(last.ts)
  const y = midiToY(last.midi!)
  const color = tuneColor(last.cents)

  ctx.save()

  // Trailing dots
  for (let i = recent.length - 1; i >= 1; i--) {
    const p = recent[i]
    const frac = 1 - i / recent.length
    const alpha = 0.15 + frac * 0.35
    const r = 2 + frac * 3
    ctx.globalAlpha = alpha
    ctx.fillStyle = tuneColor(p.cents)
    ctx.beginPath()
    ctx.arc(tsToX(p.ts), midiToY(p.midi!), r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1

  // Horizontal guide line
  ctx.strokeStyle = color
  ctx.globalAlpha = 0.12
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(LABEL_W, y)
  ctx.lineTo(W, y)
  ctx.stroke()
  ctx.globalAlpha = 1

  // Glow
  const r = 7
  const grd = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 3.5)
  grd.addColorStop(0, color + 'cc')
  grd.addColorStop(1, color + '00')
  ctx.fillStyle = grd
  ctx.beginPath()
  ctx.arc(x, y, r * 3.5, 0, Math.PI * 2)
  ctx.fill()

  // Dot
  ctx.shadowColor = color
  ctx.shadowBlur = 10
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.shadowBlur = 0

  // Label
  const centsStr = last.cents != null
    ? ` ${last.cents >= 0 ? '+' : ''}${last.cents.toFixed(0)}¢`
    : ''
  const label = (last.note_full ?? '') + centsStr
  const labelX = Math.min(x + r + 6, W - 4)
  ctx.font = 'bold 13px "Inter",sans-serif'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  const tw = ctx.measureText(label).width
  ctx.fillStyle = 'rgba(13,17,23,0.8)'
  ctx.fillRect(labelX - 2, y - 9, tw + 6, 18)
  ctx.fillStyle = color
  ctx.fillText(label, labelX, y)

  ctx.restore()
}
