import { create } from 'zustand'
import type { PitchMessage } from '@/types'
import { toast } from './toastStore'

export type VisStyle = 'piano' | 'line'

const MAX_HISTORY = 10_000
const MIDI_RANGE_MIN = 6
const MIDI_RANGE_MAX = 52
const MIDI_RANGE_DEFAULT = 24

interface AppState {
  style: VisStyle
  autoFollow: boolean
  midiRange: number           // visible semitones on Y axis (6–52)
  recordedFrames: PitchMessage[]
}

interface AppActions {
  toggleStyle: () => void
  setAutoFollow: (v: boolean) => void
  zoomIn: () => void
  zoomOut: () => void
  resetZoom: () => void
  pushFrame: (msg: PitchMessage) => void
  clearHistory: () => void
  exportCSV: () => void
}

export const useAppStore = create<AppState & AppActions>((set, get) => ({
  style: 'piano',
  autoFollow: true,
  midiRange: MIDI_RANGE_DEFAULT,
  recordedFrames: [],

  toggleStyle() {
    set(s => ({ style: s.style === 'piano' ? 'line' : 'piano' }))
  },

  setAutoFollow(v) {
    set({ autoFollow: v })
  },

  zoomIn() {
    set(s => ({ midiRange: Math.max(MIDI_RANGE_MIN, s.midiRange - 4) }))
  },

  zoomOut() {
    set(s => ({ midiRange: Math.min(MIDI_RANGE_MAX, s.midiRange + 4) }))
  },

  resetZoom() {
    set({ midiRange: MIDI_RANGE_DEFAULT })
  },

  pushFrame(msg) {
    set(s => {
      const frames = s.recordedFrames
      const next = frames.length >= MAX_HISTORY
        ? [...frames.slice(frames.length - MAX_HISTORY + 1), msg]
        : [...frames, msg]
      return { recordedFrames: next }
    })
  },

  clearHistory() {
    set({ recordedFrames: [] })
  },

  exportCSV() {
    const frames = get().recordedFrames
    if (frames.length === 0) {
      toast.info('暂无数据，请先开始检测')
      return
    }
    const header = 'timestamp,freq_hz,note,cents,confidence\n'
    const rows = frames
      .filter(f => f.voiced)
      .map(f =>
        `${f.ts.toFixed(3)},${(f.freq ?? 0).toFixed(2)},${f.note_full ?? ''},${(f.cents ?? 0).toFixed(2)},${(f.confidence ?? 0).toFixed(3)}`
      )
      .join('\n')
    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' })
    const url  = URL.createObjectURL(blob)
    const now  = new Date()
    const name = `pitch-session-${now.toISOString().slice(0,19).replace(/[:]/g, '-')}.csv`
    const a    = document.createElement('a')
    a.href = url; a.download = name; a.click()
    URL.revokeObjectURL(url)
  },
}))
