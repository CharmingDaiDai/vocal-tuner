import {
  useQuery,
  useMutation,
  useQueryClient,
  queryOptions,
} from '@tanstack/react-query'
import { api } from './client'

// ── Query key factory ────────────────────────────────────
export const keys = {
  library: ['library'] as const,
  song: (jobId: string) => ['library', jobId] as const,
  job: (jobId: string) => ['job', jobId] as const,
  devices: ['devices'] as const,
  status: ['status'] as const,
  serverInfo: ['serverInfo'] as const,
}

// ── Library ──────────────────────────────────────────────
export function useLibrary() {
  return useQuery({
    queryKey: keys.library,
    queryFn: api.library,
    staleTime: 10_000,
  })
}

export function useSong(jobId: string | null) {
  return useQuery({
    queryKey: keys.song(jobId ?? ''),
    queryFn: () => api.song(jobId!),
    enabled: !!jobId,
    staleTime: Infinity,
  })
}

// ── Analysis job polling ─────────────────────────────────
export function useAnalysisJob(jobId: string | null) {
  return useQuery({
    queryKey: keys.job(jobId ?? ''),
    queryFn: () => api.analysisJob(jobId!),
    enabled: !!jobId,
    refetchInterval: (query) => {
      const status = query.state.data?.status
      if (!status || status === 'analyzing') return 600
      return false
    },
    staleTime: 0,
  })
}

// ── Devices ──────────────────────────────────────────────
export function useDevices() {
  return useQuery({
    queryKey: keys.devices,
    queryFn: api.devices,
    staleTime: 30_000,
  })
}

// ── Server info ──────────────────────────────────────────
export function useServerInfo() {
  return useQuery({
    queryKey: keys.serverInfo,
    queryFn: api.serverInfo,
    staleTime: Infinity,
  })
}

// ── Mutations ─────────────────────────────────────────────
export function useUpload() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.upload,
    onSuccess: () => {
      // Invalidate library so it refreshes after analysis
      qc.invalidateQueries({ queryKey: keys.library })
    },
  })
}

export function useDeleteSong() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.deleteSong,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.library })
    },
  })
}

export function useSwitchDevice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.switchDevice,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.devices })
    },
  })
}

// Re-export queryOptions helper for pre-fetching
export { queryOptions }
