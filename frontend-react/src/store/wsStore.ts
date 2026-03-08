import { create } from 'zustand'
import type { PitchMessage, WsMessage } from '@/types'
import { toast } from './toastStore'

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
  _wasConnected: boolean  // true if we had a successful connection before
  _disconnectToastShown: boolean
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
  _wasConnected: false,
  _disconnectToastShown: false,

  connect() {
    const state = get()
    if (state._ws?.readyState === WebSocket.OPEN) return

    const ws = new WebSocket(WS_URL)

    ws.onopen = () => {
      const wasConnected = get()._wasConnected
      set({ connected: true, _backoff: BASE_BACKOFF, _wasConnected: true })
      if (wasConnected && get()._disconnectToastShown) {
        toast.success('麦克风已重新连接')
        set({ _disconnectToastShown: false })
      }
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
      const wasConnected = get()._wasConnected
      set({ connected: false, _ws: null })
      // Show toast after first disconnect (not on initial load)
      if (wasConnected && !get()._disconnectToastShown) {
        setTimeout(() => {
          if (!get().connected) {
            toast.error('麦克风连接中断，正在重连…')
            set({ _disconnectToastShown: true })
          }
        }, 2000)
      }
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
