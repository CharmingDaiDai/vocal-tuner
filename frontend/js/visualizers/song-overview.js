/**
 * song-overview.js — 全曲音高总览 Canvas 组件
 *
 * 功能：
 *  - 展示整首歌的 pitch 轨迹（X 轴 = 时间 0~duration，Y 轴 = MIDI）
 *  - 高亮矩形框标注当前 30s 播放窗口在全曲中的位置
 *  - 叠加麦克风实际演唱录音（来自 recorder.js 历史数组）
 *  - 点击 / 拖拽 → 触发 onSeek(t) 回调
 *  - 支持粗分析数据 → 精细化数据的无缝替换
 */

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const NATURAL    = new Set([0, 2, 4, 5, 7, 9, 11]);

const LABEL_W  = 40;     // 左侧 Y 轴标签区宽度 px
const PAD_B    = 18;     // 底部时间轴高度 px
const DOT_R    = 1.5;    // 参考轨点半径
const MIC_R    = 2;      // 麦克风轨点半径（稍大）

export class SongOverview {
  constructor(canvas) {
    this.canvas       = canvas;
    this.ctx          = canvas.getContext('2d');

    this._pitches     = [];      // 参考轨数组 [{t, midi, voiced, cents}...]
    this._micHistory  = null;    // 由外部传入的 recorder.js _history 引用
    this._duration    = 0;
    this._rms         = [];      // RMS 曲线 [0-1]
    this._rmsHop      = 512;     // 对应 song_analyzer 的 RMS_HOP
    this._rmsSr       = 22050;

    this._viewStart   = 0;       // 当前播放窗口起始时间（秒）
    this._viewEnd     = 30;      // 窗口结束时间

    // Y 轴显示范围
    this._midiMin     = 36;      // C2
    this._midiMax     = 84;      // C6

    this.onSeek       = null;    // (t: number) => void

    this._dragging    = false;
    this._animId      = null;

    canvas.addEventListener('mousedown', this._onMouseDown.bind(this));
    canvas.addEventListener('mousemove', this._onMouseMove.bind(this));
    canvas.addEventListener('mouseup',   this._onMouseUp.bind(this));
    canvas.addEventListener('mouseleave',this._onMouseUp.bind(this));
    canvas.style.cursor = 'pointer';

    this._start();
  }

  /**
   * 加载参考轨数据
   * @param {Array}  pitches   — 来自 /api/analyze 的 coarse_pitches 或 fine_pitches
   * @param {number} duration  — 歌曲总时长（秒）
   * @param {Array}  rms       — RMS 能量曲线
   */
  setSongPitches(pitches, duration, rms = []) {
    this._pitches  = pitches || [];
    this._duration = duration || 0;
    this._rms      = rms || [];
    this._autoYRange();
  }

  /**
   * 传入 recorder.js 的历史数组引用（实时更新，无需重新赋值）
   * @param {Array} historyRef
   */
  setMicHistoryRef(historyRef) {
    this._micHistory = historyRef;
  }

  /**
   * 更新当前播放窗口（由外部 onTimeUpdate 驱动）
   * @param {number} currentTime  — 当前播放时间（秒）
   * @param {number} windowSec    — 可视窗口时长（默认 30s）
   */
  setViewport(currentTime, windowSec = 30) {
    this._viewStart = Math.max(0, currentTime - windowSec * 0.15);
    this._viewEnd   = this._viewStart + windowSec;
  }

  // ── 坐标辅助 ─────────────────────────────────────────

  _tToX(t, plotW) {
    if (this._duration <= 0) return LABEL_W;
    return LABEL_W + (t / this._duration) * plotW;
  }

  _midiToY(m, H) {
    const range = this._midiMax - this._midiMin;
    return (H - PAD_B) * (1 - (m - this._midiMin) / range);
  }

  _xToT(x, W) {
    const plotW = W - LABEL_W;
    return Math.max(0, ((x - LABEL_W) / plotW) * this._duration);
  }

  // ── 自动 Y 范围 ───────────────────────────────────────

  _autoYRange() {
    const voiced = this._pitches.filter(p => p.voiced && p.midi != null);
    if (voiced.length === 0) return;
    const mids = voiced.map(p => p.midi);
    const lo   = Math.min(...mids) - 2;
    const hi   = Math.max(...mids) + 2;
    this._midiMin = Math.max(12, Math.floor(lo / 12) * 12);
    this._midiMax = Math.min(108, Math.ceil(hi / 12) * 12);
    // 至少显示 2 个八度
    if (this._midiMax - this._midiMin < 24) {
      const center  = (this._midiMin + this._midiMax) / 2;
      this._midiMin = Math.floor(center) - 12;
      this._midiMax = Math.ceil(center) + 12;
    }
  }

  // ── 事件 ─────────────────────────────────────────────

  _onMouseDown(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x    = e.clientX - rect.left;
    if (x < LABEL_W) return;
    this._dragging = true;
    this._seekTo(e);
  }

  _onMouseMove(e) {
    if (!this._dragging) return;
    this._seekTo(e);
  }

  _onMouseUp() { this._dragging = false; }

  _seekTo(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x    = e.clientX - rect.left;
    const W    = this.canvas.offsetWidth;
    const t    = this._xToT(x, W);
    this.onSeek?.(t);
  }

  // ── rAF 循环 ─────────────────────────────────────────

  _start() {
    const loop = () => {
      this._draw();
      this._animId = requestAnimationFrame(loop);
    };
    loop();
  }

  // ── 主渲染 ───────────────────────────────────────────

  _draw() {
    const { canvas, ctx } = this;
    const W = canvas.offsetWidth, H = canvas.offsetHeight;
    if (W === 0 || H === 0) return;
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W; canvas.height = H;
    }

    ctx.clearRect(0, 0, W, H);

    const plotW  = W - LABEL_W;
    const plotH  = H - PAD_B;
    const range  = this._midiMax - this._midiMin;
    const midiToY = (m) => this._midiToY(m, H);
    const tToX    = (t) => this._tToX(t, plotW);

    // ── 背景 ─────────────────────────────────────────
    ctx.fillStyle = 'rgba(13,17,23,0.9)';
    ctx.fillRect(0, 0, W, H);

    // ── RMS 能量波形（背景装饰）─────────────────────
    if (this._rms.length > 0 && this._duration > 0) {
      const rmsHopSec = this._rmsHop / this._rmsSr;
      ctx.beginPath();
      ctx.fillStyle = 'rgba(30,50,90,0.35)';
      for (let i = 0; i < this._rms.length; i++) {
        const t    = i * rmsHopSec;
        const x    = tToX(t);
        const amp  = this._rms[i] * plotH * 0.4;
        ctx.fillRect(x, plotH / 2 - amp / 2, Math.max(1.5, plotW / this._rms.length - 0.5), amp);
      }
    }

    // ── Y 轴网格 + 标签 ──────────────────────────────
    ctx.save();
    ctx.font         = '9px "Segoe UI", monospace';
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';
    for (let m = this._midiMin; m <= this._midiMax; m++) {
      const ni = ((m % 12) + 12) % 12;
      if (ni !== 0 && !NATURAL.has(ni)) continue;
      if ((plotH / range) < 3 && ni !== 0) continue; // 太密时只画 C 音
      const y = midiToY(m);
      if (y < 0 || y > plotH) continue;
      ctx.strokeStyle = ni === 0 ? '#2d3d4f' : '#1a2233';
      ctx.lineWidth   = ni === 0 ? 0.8 : 0.4;
      ctx.setLineDash(ni === 0 ? [4,4] : [2,4]);
      ctx.beginPath();
      ctx.moveTo(LABEL_W, y); ctx.lineTo(W, y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (ni === 0) {
        const oct = Math.floor(m / 12) - 1;
        ctx.fillStyle = '#4a6a8a';
        ctx.fillText(`C${oct}`, LABEL_W - 3, y);
      } else if (plotH / range >= 6) {
        ctx.fillStyle = '#2d3d4f';
        ctx.fillText(NOTE_NAMES[ni] + (Math.floor(m / 12) - 1), LABEL_W - 3, y);
      }
    }
    ctx.restore();

    // ── X 轴时间刻度 ─────────────────────────────────
    if (this._duration > 0) {
      const step  = this._duration <= 60 ? 10 : this._duration <= 180 ? 30 : 60;
      ctx.font      = '9px "Segoe UI", monospace';
      ctx.fillStyle = '#3c444d';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (let t = 0; t <= this._duration; t += step) {
        const x = tToX(t);
        ctx.strokeStyle = '#21262d';
        ctx.lineWidth   = 0.5;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(x, 0); ctx.lineTo(x, plotH);
        ctx.stroke();
        ctx.fillText(_formatTime(t), x, plotH + 2);
      }
    }

    if (this._pitches.length === 0) {
      ctx.fillStyle    = '#484f58';
      ctx.font         = '12px "Segoe UI"';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('等待歌曲分析...', LABEL_W + plotW / 2, plotH / 2);
      return;
    }

    // ── 参考轨（歌曲原音）─────────────────────────────
    this._drawTrack(ctx, this._pitches, tToX, midiToY, 'rgba(88,166,255,0.55)', 1.5, false);

    // ── 麦克风演唱轨（来自 recorder 历史）────────────
    if (this._micHistory && this._micHistory.length > 0 && this._duration > 0) {
      // mic 历史用 wall-clock ts，需要知道歌曲播放的起点 wall-clock
      // 由外部通过 setPlaybackWallStart() 传入
      if (this._wallStart != null) {
        const shifted = this._micHistory.map(p => ({
          t:      p.ts - this._wallStart,
          midi:   p.midi ?? _freqToMidi(p.freq),
          voiced: true,
          cents:  p.cents ?? 0,
        })).filter(p => p.t >= 0 && p.t <= this._duration && p.midi != null);
        this._drawTrack(ctx, shifted, tToX, midiToY, null, MIC_R, true);
      }
    }

    // ── 当前播放窗口高亮框 ───────────────────────────
    if (this._duration > 0) {
      const x1 = tToX(this._viewStart);
      const x2 = tToX(Math.min(this._viewEnd, this._duration));
      ctx.save();
      ctx.fillStyle   = 'rgba(88,166,255,0.08)';
      ctx.strokeStyle = 'rgba(88,166,255,0.5)';
      ctx.lineWidth   = 1.5;
      ctx.fillRect(x1, 0, x2 - x1, plotH);
      ctx.strokeRect(x1, 0, x2 - x1, plotH);
      // 当前播放位置线
      const xCur = tToX(this._viewStart + (this._viewEnd - this._viewStart) * 0.15);
      ctx.strokeStyle = 'rgba(88,166,255,0.9)';
      ctx.lineWidth   = 1;
      ctx.setLineDash([3,3]);
      ctx.beginPath();
      ctx.moveTo(xCur, 0); ctx.lineTo(xCur, plotH);
      ctx.stroke();
      ctx.restore();
    }

    // ── 坐标轴边框 ───────────────────────────────────
    ctx.strokeStyle = '#21262d';
    ctx.lineWidth   = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(LABEL_W, 0);
    ctx.lineTo(LABEL_W, plotH);
    ctx.lineTo(W, plotH);
    ctx.stroke();
  }

  _drawTrack(ctx, pts, tToX, midiToY, fixedColor, radius, useNoteColor) {
    let prevX = null, prevY = null, prevVoiced = false;
    for (const p of pts) {
      const midi = p.midi ?? _freqToMidi(p.freq ?? 0);
      if (!p.voiced || midi == null) { prevVoiced = false; continue; }
      const x     = tToX(p.t ?? p.ts ?? 0);
      const y     = midiToY(midi);
      const color = fixedColor ?? _tuneColor(p.cents ?? 0, 0.7);

      if (prevVoiced && prevX !== null) {
        ctx.beginPath();
        ctx.moveTo(prevX, prevY);
        ctx.lineTo(x, y);
        ctx.strokeStyle = color;
        ctx.lineWidth   = radius;
        ctx.lineCap     = 'round';
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      prevX = x; prevY = y; prevVoiced = true;
    }
  }

  /**
   * 设置歌曲开始播放时的 wall-clock 时间戳（秒），用于对齐麦克风历史
   * @param {number} wallTs  — Date.now() / 1000 at the moment play() was called
   */
  setPlaybackWallStart(wallTs) {
    this._wallStart = wallTs;
  }
}

// ── 工具函数 ─────────────────────────────────────────────

function _freqToMidi(freq) {
  if (!freq || freq <= 0) return null;
  return Math.round(69 + 12 * Math.log2(freq / 440));
}

function _tuneColor(cents, alpha = 1) {
  const a = Math.abs(cents ?? 0);
  if (a <= 15) return `rgba(63,185,80,${alpha})`;
  if (a <= 30) return `rgba(210,153,34,${alpha})`;
  return `rgba(248,81,73,${alpha})`;
}

function _formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
