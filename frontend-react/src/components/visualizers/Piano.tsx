import { useRef } from 'react'
import { useCanvas } from '@/hooks/useCanvas'

// C2 (midi 36) → B5 (midi 83), 4 octaves
const MIDI_MIN = 36
const MIDI_MAX = 83
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const BLACK_KEYS = [1, 3, 6, 8, 10]  // semitone index within octave

function isBlack(midi: number) {
  return BLACK_KEYS.includes(((midi % 12) + 12) % 12)
}

interface Props {
  highlightedMidi: number | null
  className?: string
}

export function Piano({ highlightedMidi, className }: Props) {
  const canvasRef = useCanvas((ctx, { w, h }) => {
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#0d1117'
    ctx.fillRect(0, 0, w, h)

    // Count white keys
    const whites: number[] = []
    for (let m = MIDI_MIN; m <= MIDI_MAX; m++) {
      if (!isBlack(m)) whites.push(m)
    }

    const keyW = w / whites.length
    const keyH = h

    // Draw white keys first
    whites.forEach((midi, i) => {
      const x = i * keyW
      const isHighlighted = highlightedMidi !== null && Math.round(highlightedMidi) === midi

      ctx.fillStyle = isHighlighted ? '#58a6ff' : '#d0d7de'
      ctx.beginPath()
      ;(ctx as any).roundRect?.(x + 0.5, 0, keyW - 1, keyH - 1, [0, 0, 3, 3])
      ctx.fill()

      // Note name on C keys
      const noteName = NOTE_NAMES[((midi % 12) + 12) % 12]
      if (noteName === 'C') {
        const oct = Math.floor(midi / 12) - 1
        ctx.fillStyle = isHighlighted ? '#0d1117' : '#57606a'
        ctx.font = `${Math.round(keyW * 0.45)}px "Inter", sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'bottom'
        ctx.fillText(`C${oct}`, x + keyW / 2, keyH - 3)
      }
    })

    // Draw black keys on top
    const blackW = keyW * 0.6
    const blackH = keyH * 0.58

    whites.forEach((midi, i) => {
      // Check if there's a black key to the right of this white key
      const nextMidi = midi + 1
      if (nextMidi > MIDI_MAX) return
      if (!isBlack(nextMidi)) return

      const isHighlighted = highlightedMidi !== null && Math.round(highlightedMidi) === nextMidi

      const x = (i + 1) * keyW - blackW / 2
      ctx.fillStyle = isHighlighted ? '#1f6feb' : '#161b22'
      ctx.beginPath()
      ;(ctx as any).roundRect?.(x, 0, blackW, blackH, [0, 0, 2, 2])
      ctx.fill()

      ctx.strokeStyle = '#30363d'
      ctx.lineWidth = 0.5
      ctx.stroke()
    })
  })

  return <canvas ref={canvasRef} className={className} style={{ width: '100%', height: '100%' }} />
}
