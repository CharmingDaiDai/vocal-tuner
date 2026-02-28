import { create } from 'zustand'
import type { PitchMessage } from '@/types'

export type VisStyle = 'piano' | 'line'

const MAX_HISTORY = 10_000

interface AppState {
  style: VisStyle
  autoFollow: boolean
  recordedFrames: PitchMessage[]
}

interface AppActions {
  toggleStyle: () => void
  setAutoFollow: (v: boolean) => void
  pushFrame: (msg: PitchMessage) => void
  clearHistory: () => void
}

export const useAppStore = create<AppState & AppActions>((set, get) => ({
  style: 'piano',
  autoFollow: true,
  recordedFrames: [],

  toggleStyle() {
    set(s => ({ style: s.style === 'piano' ? 'line' : 'piano' }))
  },

  setAutoFollow(v) {
    set({ autoFollow: v })
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
}))
