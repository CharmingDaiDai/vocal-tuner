import { useMemo } from 'react'
import type { LyricLine } from '@/types'

interface Props {
  lyrics: LyricLine[]
  currentTime: number  // 当前播放时间（秒）
}

/**
 * 实时歌词显示组件
 * 显示当前行（高亮）+ 上一行（半透明）+ 下一行（半透明）
 */
export default function LyricsDisplay({ lyrics, currentTime }: Props) {
  // 找到当前应显示的歌词索引
  const currentIdx = useMemo(() => {
    let idx = -1
    for (let i = 0; i < lyrics.length; i++) {
      if (lyrics[i].t <= currentTime) {
        idx = i
      } else {
        break
      }
    }
    return idx
  }, [lyrics, currentTime])

  if (!lyrics.length) return null

  const prev = currentIdx > 0 ? lyrics[currentIdx - 1] : null
  const curr = currentIdx >= 0 ? lyrics[currentIdx] : null
  const next = currentIdx < lyrics.length - 1 ? lyrics[currentIdx + 1] : null

  return (
    <div className="flex flex-col items-center justify-center gap-1 py-2 px-4 text-center select-none">
      {/* 上一行 */}
      <div className="h-5 text-sm text-text-muted/40 transition-all duration-300 truncate max-w-full">
        {prev?.text ?? ''}
      </div>

      {/* 当前行 */}
      <div
        className="h-7 text-base font-semibold text-text transition-all duration-200 truncate max-w-full"
        style={{
          textShadow: curr ? '0 0 12px rgba(88,166,255,0.4)' : 'none',
          color: curr ? '#c9d1d9' : 'transparent',
        }}
      >
        {curr?.text ?? '♪'}
      </div>

      {/* 下一行 */}
      <div className="h-5 text-sm text-text-muted/40 transition-all duration-300 truncate max-w-full">
        {next?.text ?? ''}
      </div>
    </div>
  )
}
