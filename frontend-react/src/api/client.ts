import type {
  DevicesResponse,
  LibraryResponse,
  SongDetail,
  AnalysisJobResponse,
  UploadResponse,
  ServerInfo,
  StatusResponse,
} from '@/types'

const BASE = ''  // same-origin; dev proxy handles /api → :8000

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
}
