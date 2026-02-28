// ── WebSocket 消息类型 ────────────────────────────────────

export interface StatusMessage {
  type: 'status'
  state: 'paused' | 'recording'
  sample_rate: number
}

export interface HeartbeatMessage {
  type: 'heartbeat'
  ts: number
}

export interface PitchMessage {
  type: 'pitch'
  ts: number
  freq: number
  voiced: boolean
  confidence: number
  rms: number
  suppressed: 'conf' | 'spike' | 'debounce' | null
  note_full: string | null
  note: string | null
  octave: number | null
  cents: number | null
  ref_freq: number | null
  tune_level: 'good' | 'close' | 'off' | null
  fft: number[] | null
}

export type WsMessage = StatusMessage | HeartbeatMessage | PitchMessage

// ── REST API 类型 ─────────────────────────────────────────

export interface DeviceInfo {
  id: number | null
  name: string
  channels: number
  is_default: boolean
  is_active: boolean
}

export interface DevicesResponse {
  devices: DeviceInfo[]
}

export interface SongMeta {
  job_id: string
  original_name: string
  filename: string
  duration: number
  created_at: string
  audio_url: string
}

export interface LibraryResponse {
  songs: SongMeta[]
}

export interface AnalysisJobResponse {
  job_id: string
  status: 'analyzing' | 'done' | 'error'
  filename: string
  original_name: string | null
  duration: number | null
  audio_url: string
  progress: number
  error?: string
}

export interface UploadResponse {
  job_id: string
  filename: string
  original_name: string | null
  audio_url: string
}

export interface PitchPoint {
  t: number
  freq: number
  voiced: boolean
  midi: number | null
  confidence: number
}

export interface SongDetail extends SongMeta {
  fine_pitches: PitchPoint[]
  rms: number[]
  sr: number
}

export interface ServerInfo {
  local_ip: string
  port: number
}

export interface StatusResponse {
  paused: boolean
  connections: number
  sample_rate: number
  chunk_size: number
  current_device: DeviceInfo | null
}
