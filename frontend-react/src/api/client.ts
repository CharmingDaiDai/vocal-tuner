import type {
  DevicesResponse,
  LibraryResponse,
  SongDetail,
  AnalysisJobResponse,
  UploadResponse,
  ServerInfo,
  StatusResponse,
  SessionMeta,
  SessionDetail,
} from '@/types'

const BASE = ''  // same-origin; dev proxy handles /api → :9000

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, init)
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`${res.status} ${res.statusText}: ${body}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  // Status & devices
  status: () => apiFetch<StatusResponse>('/api/status'),
  serverInfo: () => apiFetch<ServerInfo>('/api/server-info'),
  devices: () => apiFetch<DevicesResponse>('/api/devices'),
  switchDevice: (device_id: number | null) =>
    apiFetch('/api/device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id }),
    }),

  // Pause / resume
  pause: () => apiFetch('/api/pause', { method: 'POST' }),
  resume: () => apiFetch('/api/resume', { method: 'POST' }),

  // Library
  library: () => apiFetch<LibraryResponse>('/api/library'),
  song: (jobId: string) => apiFetch<SongDetail>(`/api/library/${jobId}`),
  deleteSong: (jobId: string) =>
    apiFetch(`/api/library/${jobId}`, { method: 'DELETE' }),

  // Analysis
  analysisJob: (jobId: string) =>
    apiFetch<AnalysisJobResponse>(`/api/analyze/${jobId}`),

  // Upload
  upload: (file: File): Promise<UploadResponse> => {
    const form = new FormData()
    form.append('file', file)
    return apiFetch<UploadResponse>('/api/analyze', { method: 'POST', body: form })
  },

  // Settings
  getSettings: () => apiFetch<{ conf_thresh: number }>('/api/settings'),
  updateSettings: (conf_thresh: number) =>
    apiFetch<{ conf_thresh: number }>('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conf_thresh }),
    }),

  // Lyrics
  uploadLyrics: (jobId: string, file: File): Promise<{ job_id: string; count: number }> => {
    const form = new FormData()
    form.append('file', file)
    return apiFetch(`/api/library/${jobId}/lyrics`, { method: 'POST', body: form })
  },
  deleteLyrics: (jobId: string) =>
    apiFetch(`/api/library/${jobId}/lyrics`, { method: 'DELETE' }),

  // Original track
  uploadOriginal: (jobId: string, file: File): Promise<{ job_id: string; original_url: string; lyrics_auto: boolean }> => {
    const form = new FormData()
    form.append('file', file)
    return apiFetch(`/api/library/${jobId}/original`, { method: 'POST', body: form })
  },
  deleteOriginal: (jobId: string) =>
    apiFetch(`/api/library/${jobId}/original`, { method: 'DELETE' }),

  // Sessions
  sessions: () => apiFetch<{ sessions: SessionMeta[] }>('/api/sessions'),
  session: (id: string) => apiFetch<SessionDetail>(`/api/sessions/${id}`),
  saveSession: (data: {
    frames: object[]
    name?: string
    song_job_id?: string
    duration?: number
    wav_session_id?: string
  }): Promise<{ session_id: string; frame_count: number }> =>
    apiFetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  deleteSession: (id: string) =>
    apiFetch(`/api/sessions/${id}`, { method: 'DELETE' }),

  // WAV recording
  startRecording: () => apiFetch('/api/sessions/start-recording', { method: 'POST' }),
  stopRecording: (): Promise<{ session_id: string; audio_url: string }> =>
    apiFetch('/api/sessions/stop-recording', { method: 'POST' }),
}
