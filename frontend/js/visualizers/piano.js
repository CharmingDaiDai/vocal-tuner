/**
 * piano.js — 钢琴键盘高亮可视化
 * 绘制 C2–B5（4 个八度），当前音符高亮，颜色随 cents 偏差变化。
 */

const NOTE_NAMES   = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const BLACK_KEYS   = new Set([1, 3, 6, 8, 10]);  // C#, D#, F#, G#, A#
const OCT_START    = 2;  // C2
const OCT_END      = 5;  // B5 (4 个八度)
const TOTAL_WHITES = 7 * (OCT_END - OCT_START + 1);  // 28 白键

// 音符 → MIDI
function noteToMidi(note, oct) {
  return (oct + 1) * 12 + NOTE_NAMES.indexOf(note);
}
// 频率 → MIDI
function freqToMidi(freq) {
  if (!freq || freq <= 0) return null;
  return Math.round(69 + 12 * Math.log2(freq / 440));
}
// MIDI → 音名 + 八度
function midiInfo(m) {
  return { note: NOTE_NAMES[m % 12], octave: Math.floor(m / 12) - 1 };
}

function tuneColor(cents, alpha = 1) {
  const a = Math.abs(cents ?? 0);
  const r = a <= 15 ? [63, 185, 80] : a <= 30 ? [210, 153, 34] : [248, 81, 73];
  return `rgba(${r[0]},${r[1]},${r[2]},${alpha})`;
}

export class Piano {
  constructor(canvas) {
    this.canvas  = canvas;
    this.ctx     = canvas.getContext('2d');
    this._data   = null;
    this._animId = null;
    this._start();
  }

  update(msg) { this._data = msg; }

  _start() {
    const loop = () => { this._draw(); this._animId = requestAnimationFrame(loop); };
    loop();
  }

  _draw() {
    const { canvas, ctx } = this;
    const W = canvas.offsetWidth, H = canvas.offsetHeight;
    if (W === 0 || H === 0) return;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }

    ctx.clearRect(0, 0, W, H);

    const msg    = this._data;
    const voiced = msg?.voiced ?? false;
    const midi   = voiced ? freqToMidi(msg.freq) : null;
    const cents  = msg?.cents ?? 0;

    const wkW  = Math.floor(W / TOTAL_WHITES);  // 白键宽度
    const wkH  = H * 0.88;
    const bkW  = wkW * 0.58;
    const bkH  = wkH * 0.62;
    const startX = (W - wkW * TOTAL_WHITES) / 2;

    // 收集白键 x 位置（用于黑键定位）
    const whiteKeyX = [];  // index → x
    let wi = 0;

    for (let oct = OCT_START; oct <= OCT_END; oct++) {
      for (let ni = 0; ni < 12; ni++) {
        if (BLACK_KEYS.has(ni)) continue;
        whiteKeyX.push({ oct, ni, x: startX + wi * wkW });
        wi++;
      }
    }

    // ── 绘制白键 ─────────────────────────────────────────
    for (const { oct, ni, x } of whiteKeyX) {
      const m   = noteToMidi(NOTE_NAMES[ni], oct);
      const hit = midi === m;

      ctx.beginPath();
      ctx.roundRect(x + 1, 4, wkW - 2, wkH - 4, 3);
      ctx.fillStyle = hit ? tuneColor(cents, 0.9) : '#e6edf3';
      ctx.fill();
      ctx.strokeStyle = '#30363d';
      ctx.lineWidth   = 1;
      ctx.stroke();

      // 键名标注（C 音和当前高亮键）
      if (ni === 0 || hit) {
        ctx.font      = `${Math.round(wkW * 0.45)}px monospace`;
        ctx.fillStyle = hit ? '#fff' : '#484f58';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(NOTE_NAMES[ni] + oct, x + wkW / 2, wkH);
      }
    }

    // ── 绘制黑键 ─────────────────────────────────────────
    let bwi = 0;  // 白键计数器（黑键插在相邻白键间）
    for (let oct = OCT_START; oct <= OCT_END; oct++) {
      for (let ni = 0; ni < 12; ni++) {
        if (!BLACK_KEYS.has(ni)) { bwi++; continue; }

        const m   = noteToMidi(NOTE_NAMES[ni], oct);
        const hit = midi === m;
        // 黑键位于前一白键右边缘
        const bx  = startX + bwi * wkW - bkW / 2;

        ctx.beginPath();
        ctx.roundRect(bx, 4, bkW, bkH, 3);
        ctx.fillStyle = hit ? tuneColor(cents, 0.95) : '#1c2128';
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth   = 1;
        ctx.stroke();

        if (hit) {
          ctx.font         = `${Math.round(bkW * 0.5)}px monospace`;
          ctx.fillStyle    = '#fff';
          ctx.textAlign    = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillText(NOTE_NAMES[ni], bx + bkW / 2, bkH - 2);
        }
      }
    }

    // ── 无声提示 ─────────────────────────────────────────
    if (!voiced) {
      ctx.fillStyle    = 'rgba(13,17,23,0.55)';
      ctx.fillRect(0, 0, W, H);
      ctx.font         = '13px "Segoe UI"';
      ctx.fillStyle    = '#484f58';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('等待音频...', W / 2, H / 2);
    }
  }
}
