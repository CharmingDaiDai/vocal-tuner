import { useState, useRef, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useLibrary, useUpload, useDeleteSong, useAnalysisJob, useUploadLyrics, useUploadOriginal, keys } from '@/api/hooks'
import { Card } from '@/components/ui/Card'
import { Spinner } from '@/components/ui/Spinner'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { Upload, Trash2, Play, Music, FileText, Disc } from 'lucide-react'
import { toast } from '@/store/toastStore'
import { cn } from '@/lib/cn'
import type { SongMeta } from '@/types'

// ── Polling card for in-progress jobs ─────────────────────
function AnalyzingCard({ jobId, onComplete }: { jobId: string; onComplete: (id: string) => void }) {
  const { data } = useAnalysisJob(jobId)
  const uploadOriginal = useUploadOriginal()
  const uploadLyrics = useUploadLyrics()
  const origInputRef = useRef<HTMLInputElement>(null)
  const lrcInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (data?.status === 'done') {
      onComplete(jobId)
    }
  }, [data?.status, jobId, onComplete])

  const handleOrigFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    uploadOriginal.mutate({ jobId, file })
    e.target.value = ''
  }

  const handleLrcFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    uploadLyrics.mutate({ jobId, file })
    e.target.value = ''
  }

  const isFailed = data?.status === 'error'

  return (
    <Card className={isFailed ? 'opacity-90' : 'opacity-70'}>
      <div className="flex items-center gap-3">
        {isFailed ? (
          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-bad/20 text-bad text-xs font-bold">!</div>
        ) : (
          <Spinner size="sm" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-text">{data?.original_name ?? jobId}</div>
          {isFailed ? (
            <div className="mt-1.5 text-xs text-bad font-medium">分析失败</div>
          ) : (
            <ProgressBar value={data?.progress ?? 0} showLabel className="mt-1.5" />
          )}
        </div>
      </div>
      {!isFailed && (
        <div className="mt-2 flex gap-1.5">
          <button
            onClick={() => origInputRef.current?.click()}
            disabled={uploadOriginal.isPending}
            title="上传原文件（用于播放）"
            className="flex flex-1 items-center justify-center gap-1 rounded border border-border py-1 text-xs text-text-muted hover:border-accent/40 hover:text-accent transition-colors"
          >
            {uploadOriginal.isPending ? <Spinner size="sm" /> : <Disc size={11} />}
            原文件
          </button>
          <button
            onClick={() => lrcInputRef.current?.click()}
            disabled={uploadLyrics.isPending}
            title="上传 .lrc 歌词文件"
            className="flex flex-1 items-center justify-center gap-1 rounded border border-border py-1 text-xs text-text-muted hover:border-accent/40 hover:text-accent transition-colors"
          >
            {uploadLyrics.isPending ? <Spinner size="sm" /> : <FileText size={11} />}
            歌词
          </button>
        </div>
      )}
      <input ref={origInputRef} type="file" accept="audio/*" className="hidden" onChange={handleOrigFile} />
      <input ref={lrcInputRef} type="file" accept=".lrc,text/plain" className="hidden" onChange={handleLrcFile} />
    </Card>
  )
}

// ── Song card ──────────────────────────────────────────────
function SongCard({
  song,
  onDelete,
}: {
  song: SongMeta
  onDelete: (id: string) => void
}) {
  const navigate = useNavigate()
  const uploadLyrics = useUploadLyrics()
  const uploadOriginal = useUploadOriginal()
  const lrcInputRef = useRef<HTMLInputElement>(null)
  const origInputRef = useRef<HTMLInputElement>(null)

  const handleLrcFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    uploadLyrics.mutate(
      { jobId: song.job_id, file },
      {
        onError: (err) => toast.error(`上传歌词失败：${err.message}`),
        onSuccess: (res) => toast.success(`歌词上传成功（共 ${res.count} 行）`),
      },
    )
    e.target.value = ''
  }

  const handleOrigFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    uploadOriginal.mutate(
      { jobId: song.job_id, file },
      { onError: (err) => toast.error(`上传原文件失败：${err.message}`) },
    )
    e.target.value = ''
  }

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
        {/* 上传原文件按钮 */}
        <button
          onClick={() => origInputRef.current?.click()}
          disabled={uploadOriginal.isPending}
          title={song.original_url ? `已设置原文件：${song.original_track_name ?? ''}（点击替换）` : '上传原文件（用于播放）'}
          className={cn(
            'flex items-center justify-center rounded border p-1 transition-all',
            song.original_url
              ? 'border-accent/40 text-accent opacity-100'
              : 'border-border text-text-muted opacity-0 group-hover:opacity-100 hover:border-accent/40 hover:text-accent',
            uploadOriginal.isPending && 'opacity-100 cursor-wait',
          )}
        >
          {uploadOriginal.isPending ? <Spinner size="sm" /> : <Disc size={13} />}
        </button>
        {/* 上传歌词按钮 */}
        <button
          onClick={() => lrcInputRef.current?.click()}
          disabled={uploadLyrics.isPending}
          title="上传 .lrc 歌词文件"
          className={cn(
            'flex items-center justify-center rounded border border-border p-1 text-text-muted opacity-0 group-hover:opacity-100 hover:border-accent/40 hover:text-accent transition-all',
            uploadLyrics.isPending && 'opacity-100 cursor-wait',
          )}
        >
          {uploadLyrics.isPending ? <Spinner size="sm" /> : <FileText size={13} />}
        </button>
        <button
          onClick={() => onDelete(song.job_id)}
          className="flex items-center justify-center rounded border border-border p-1 text-text-muted opacity-0 group-hover:opacity-100 hover:border-bad/40 hover:text-bad transition-all"
        >
          <Trash2 size={13} />
        </button>
      </div>
      <input
        ref={origInputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={handleOrigFile}
      />
      <input
        ref={lrcInputRef}
        type="file"
        accept=".lrc,text/plain"
        className="hidden"
        onChange={handleLrcFile}
      />
    </Card>
  )
}

// ── Drop zone ─────────────────────────────────────────────
function DropZone({ onFiles }: { onFiles: (files: FileList) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const files = e.dataTransfer.files
    if (!files.length) return
    const hasInvalid = Array.from(files).some(f => !f.type.startsWith('audio/'))
    if (hasInvalid) {
      toast.error('不支持的文件格式，请上传音频文件')
    }
    onFiles(files)
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
  const qc = useQueryClient()
  const [pendingJobIds, setPendingJobIds] = useState<string[]>([])

  const handleComplete = useCallback((jobId: string) => {
    setPendingJobIds(prev => prev.filter(id => id !== jobId))
    qc.invalidateQueries({ queryKey: keys.library })
  }, [qc])

  const handleFiles = async (files: FileList) => {
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('audio/')) {
        toast.error('不支持的文件格式，请上传音频文件')
        continue
      }
      try {
        const res = await upload.mutateAsync(file)
        setPendingJobIds(prev => [...prev, res.job_id])
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
        <p className="text-sm text-text-muted">上传音频，分析音高轨迹，进入跟唱模式。悬浮歌曲卡片可上传 .lrc 歌词文件。</p>
      </div>

      <DropZone onFiles={handleFiles} />

      {upload.isPending && (
        <div className="flex items-center gap-2 text-sm text-text-muted">
          <Spinner size="sm" /> 上传中…
        </div>
      )}

      {songs.length === 0 && pendingJobIds.length === 0 && !upload.isPending ? (
        <div className="py-8 text-center text-text-muted">
          还没有歌曲，上传一首开始吧
        </div>
      ) : (
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
          {pendingJobIds.map(jobId => (
            <AnalyzingCard key={jobId} jobId={jobId} onComplete={handleComplete} />
          ))}
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
