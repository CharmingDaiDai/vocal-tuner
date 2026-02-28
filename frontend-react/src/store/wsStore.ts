import { create } from 'zustand'
import type { PitchMessage, WsMessage } from '@/types'

const WS_URL = (() => {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws/pitch`
})()

const MAX_BACKOFF = 10_000
const BASE_BACKOFF = 1_000

interface WsState {
  connected: boolean
  paused: boolean
  sampleRate: number
  latestPitch: PitchMessage | null
  // internal
  _ws: WebSocket | null
  _listeners: Set<(msg: WsMessage) => void>
  _backoff: number
  _retryTimer: ReturnType<typeof setTimeout> | null
}

interface WsActions {
  connect: () => void
  disconnect: () => void
  setPaused: (v: boolean) => void
  addListener: (fn: (msg: WsMessage) => void) => () => void
}

export const useWsStore = create<WsState & WsActions>((set, get) => ({
  connected: false,
  paused: false,
  sampleRate: 44100,
  latestPitch: null,
  _ws: null,
  _listeners: new Set(),
  _backoff: BASE_BACKOFF,
  _retryTimer: null,

  connect() {
    const state = get()
    if (state._ws?.readyState === WebSocket.OPEN) return

    const ws = new WebSocket(WS_URL)

    ws.onopen = () => {
      set({ connected: true, _backoff: BASE_BACKOFF })
    }

    ws.onmessage = (e) => {
      let msg: WsMessage
      try { msg = JSON.parse(e.data) } catch { return }

      if (msg.type === 'status') {
        set({ paused: msg.state === 'paused', sampleRate: msg.sample_rate })
      } else if (msg.type === 'pitch') {
        set({ latestPitch: msg })
      }

      // Notify all listeners
      get()._listeners.forEach(fn => fn(msg))
    }

    ws.onclose = () => {
      set({ connected: false, _ws: null })
      const backoff = get()._backoff
      const timer = setTimeout(() => {
        get().connect()
      }, backoff)
      set({
        _retryTimer: timer,
        _backoff: Math.min(backoff * 1.5, MAX_BACKOFF),
      })
    }

    ws.onerror = () => {
      ws.close()
    }

    set({ _ws: ws })
  },

  disconnect() {
    const { _ws, _retryTimer } = get()
    if (_retryTimer) clearTimeout(_retryTimer)
    _ws?.close()
    set({ _ws: null, connected: false, _retryTimer: null })
  },

  async setPaused(v: boolean) {
    const endpoint = v ? '/api/pause' : '/api/resume'
    await fetch(endpoint, { method: 'POST' })
    set({ paused: v })
  },

  addListener(fn) {
    get()._listeners.add(fn)
    return () => get()._listeners.delete(fn)
  },
}))
