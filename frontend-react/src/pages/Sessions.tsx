import { useState } from 'react'
import { useSessions, useDeleteSession, useSession, useSong } from '@/api/hooks'
import { Card } from '@/components/ui/Card'
import { Spinner } from '@/components/ui/Spinner'
import { Trash2, BarChart2, ChevronLeft } from 'lucide-react'
import type { SessionMeta } from '@/types'
import PracticeReport from '@/components/PracticeReport'

// ── Session card ───────────────────────────────────────────
function SessionCard({
  session,
  onDelete,
  onReport,
}: {
  session: SessionMeta
  onDelete: (id: string) => void
  onReport: (id: string) => void
}) {
  const mins = Math.floor(session.duration / 60)
  const secs = Math.floor(session.duration % 60)
  const durationStr = mins > 0
    ? `${mins}:${secs.toString().padStart(2, '0')}`
    : `${secs}s`

  return (
    <Card className="group flex flex-col gap-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-text">{session.name}</div>
        <div className="text-xs text-text-muted">
          {session.created_at.slice(0, 10)} · {durationStr} ·  {session.frame_count} 帧
          {session.song_job_id && <span className="ml-1 text-accent/70">跟唱</span>}
          {session.has_audio && <span className="ml-1 text-good/70">有录音</span>}
        </div>
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => onReport(session.session_id)}
          className="flex flex-1 items-center justify-center gap-1.5 rounded border border-accent/30 bg-accent/10 py-1 text-xs text-accent hover:bg-accent/20 transition-colors"
        >
          <BarChart2 size={11} /> 查看报告
        </button>
        <button
          onClick={() => onDelete(session.session_id)}
          className="flex items-center justify-center rounded border border-border p-1 text-text-muted opacity-0 group-hover:opacity-100 hover:border-bad/40 hover:text-bad transition-all"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </Card>
  )
}

// ── Report view ────────────────────────────────────────────
function ReportView({ sessionId, onBack }: { sessionId: string; onBack: () => void }) {
  const { data, isLoading, error } = useSession(sessionId)
  // Load reference song for pitch comparison (when session is from karaoke mode)
  const { data: refSong } = useSong(data?.song_job_id ?? null)

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size="lg" />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-text-muted">
        <div>加载失败</div>
        <button onClick={onBack} className="text-accent hover:underline text-sm">返回</button>
      </div>
    )
  }

  const audioUrl = data.has_audio
    ? `/api/sessions/${data.session_id}/audio`
    : undefined

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <button
          onClick={onBack}
          className="rounded p-1 text-text-muted hover:text-text transition-colors"
        >
          <ChevronLeft size={18} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-text">{data.name}</div>
          <div className="text-xs text-text-muted">
            {data.created_at.slice(0, 10)} · {data.frame_count} 帧
            {data.song_job_id && <span className="ml-1 text-accent/70">跟唱</span>}
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <PracticeReport
          frames={data.frames}
          refPitches={refSong?.fine_pitches}
          audioUrl={audioUrl}
          duration={data.duration}
        />
      </div>
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────
export default function Sessions() {
  const { data, isLoading } = useSessions()
  const deleteSession = useDeleteSession()
  const [reportSessionId, setReportSessionId] = useState<string | null>(null)

  if (reportSessionId) {
    return (
      <ReportView
        sessionId={reportSessionId}
        onBack={() => setReportSessionId(null)}
      />
    )
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size="lg" />
      </div>
    )
  }

  const sessions = data?.sessions ?? []

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <div>
        <h1 className="text-lg font-semibold text-text">练习记录</h1>
        <p className="text-sm text-text-muted">查看历史练习数据、录音回放和练习报告</p>
      </div>

      {sessions.length === 0 ? (
        <div className="py-8 text-center text-text-muted">
          暂无练习记录。在调音页面点击"保存练习"即可记录。
        </div>
      ) : (
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
          {sessions.map(s => (
            <SessionCard
              key={s.session_id}
              session={s}
              onDelete={id => deleteSession.mutate(id)}
              onReport={id => setReportSessionId(id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
