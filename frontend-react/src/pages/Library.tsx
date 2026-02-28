import { useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLibrary, useUpload, useDeleteSong, useAnalysisJob } from '@/api/hooks'
import { Card } from '@/components/ui/Card'
import { Spinner } from '@/components/ui/Spinner'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { Upload, Trash2, Play, Music } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { SongMeta } from '@/types'

// ── Polling card for in-progress jobs ─────────────────────
function AnalyzingCard({ jobId }: { jobId: string }) {
  const { data } = useAnalysisJob(jobId)
  return (
    <Card className="opacity-70">
      <div className="flex items-center gap-3">
        <Spinner size="sm" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-text">{data?.original_name ?? jobId}</div>
          <ProgressBar value={data?.progress ?? 0} showLabel className="mt-1.5" />
        </div>
      </div>
    </Card>
  )
}

// ── Song card ──────────────────────────────────────────────
function SongCard({ song, onDelete }: { song: SongMeta; onDelete: (id: string) => void }) {
  const navigate = useNavigate()
  return (
    <Card className="group flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
          <Music size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-text">{song.original_name}</div>
          <div className="text-xs text-text-muted">
            {song.duration ? `${song.duration.toFixed(0)}s` : '—'} · {song.created_at.slice(0, 10)}
          </div>
        </div>
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => navigate(`/karaoke/${song.job_id}`)}
          className="flex flex-1 items-center justify-center gap-1.5 rounded border border-accent/30 bg-accent/10 py-1 text-xs text-accent hover:bg-accent/20 transition-colors"
        >
          <Play size={11} /> 跟唱
        </button>
        <button
          onClick={() => onDelete(song.job_id)}
          className="flex items-center justify-center rounded border border-border p-1 text-text-muted opacity-0 group-hover:opacity-100 hover:border-bad/40 hover:text-bad transition-all"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </Card>
  )
}

// ── Drop zone ─────────────────────────────────────────────
function DropZone({ onFiles }: { onFiles: (files: FileList) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files)
  }, [onFiles])

  return (
    <div
      className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-border p-8 text-center hover:border-accent/40 transition-colors"
      onDragOver={e => e.preventDefault()}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
    >
      <Upload size={28} className="text-text-muted" />
      <div>
        <div className="text-sm text-text">拖放音频文件或点击上传</div>
        <div className="mt-0.5 text-xs text-text-muted">支持 MP3、WAV、FLAC、M4A、OGG</div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        multiple
        className="hidden"
        onChange={e => e.target.files && onFiles(e.target.files)}
      />
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────
export default function Library() {
  const { data, isLoading } = useLibrary()
  const upload = useUpload()
  const deleteSong = useDeleteSong()
  const pendingJobIds = useRef<string[]>([])

  const handleFiles = async (files: FileList) => {
    for (const file of Array.from(files)) {
      try {
        const res = await upload.mutateAsync(file)
        pendingJobIds.current.push(res.job_id)
      } catch (err) {
        console.error('Upload failed', err)
      }
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size="lg" />
      </div>
    )
  }

  const songs = data?.songs ?? []

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <div>
        <h1 className="text-lg font-semibold text-text">曲库</h1>
        <p className="text-sm text-text-muted">上传音频，分析音高轨迹，进入跟唱模式</p>
      </div>

      <DropZone onFiles={handleFiles} />

      {upload.isPending && (
        <div className="flex items-center gap-2 text-sm text-text-muted">
          <Spinner size="sm" /> 上传中…
        </div>
      )}

      {songs.length === 0 && !upload.isPending ? (
        <div className="py-8 text-center text-text-muted">
          还没有歌曲，上传一首开始吧
        </div>
      ) : (
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
          {songs.map(song => (
            <SongCard
              key={song.job_id}
              song={song}
              onDelete={id => deleteSong.mutate(id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
