/**
 * pitch-history.js — Piano Roll 风格实时音高时间轴
 *
 * - 30 秒滚动窗口，X = 时间，Y = 音高（MIDI）
 * - Piano Roll 背景：黑键行深色 / 白键行浅色 / C 音蓝色高亮
 * - 水平色块轨迹（梯形连接相邻帧，呈现滑音带；弃用垂直柱）
 * - 背景水印音名（极低透明度，叠在绘图区内）
 * - 颜色语义：绿(±15¢准) / 橙(±30¢偏) / 红(>30¢跑调)
 * - 当前音高发光指示器 + 音分偏差标注
 * - 右侧播放头竖虚线（标记"现在"）
 * - 右上角图例
 * - 动态音域收紧（基于过去 10s 实际音域）
 * - 鼠标滚轮 / 双指捏合缩放
 */

const NOTE_NAMES  = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const NATURAL     = new Set([0, 2, 4, 5, 7, 9, 11]); // 白键
const BLACK_KEYS  = new Set([1, 3, 6, 8, 10]);        // 黑键

const WINDOW_SEC       = 30;
const MIDI_MIN_DEFAULT = 48;   // C3
const MIDI_MAX_DEFAULT = 72;   // C5
const BUFFER_SEC       = 90;
const LABEL_W          = 40;   // 左侧标签宽（减小；辅以背景水印）
const MAX_GAP_SEC      = 0.22; // 超过此间隔即断开音块

export class PitchHistory {
  constructor(canvas) {
    this.canvas  = canvas;
    this.ctx     = canvas.getContext('2d');

    // 循环缓冲区（O(1) 写入，无 shift()）
    this._CAP  = 2048;
    this._buf  = new Array(this._CAP);
    this._wPtr = 0;
    this._len  = 0;

    this._paused     = false;
    this._animId     = null;
    this._style      = 'piano'; // 'piano' | 'line'
    this._autoFollow = true;

    // 参考轨
    this._refPitches  = [];
    this._wallStart   = null;
    this._compareMode = 'overlay';

    // Y 轴视窗（浮点 MIDI，lerp 插值）
    this._viewMin   = MIDI_MIN_DEFAULT;
    this._viewMax   = MIDI_MAX_DEFAULT;
    this._targetMin = MIDI_MIN_DEFAULT;
    this._targetMax = MIDI_MAX_DEFAULT;

    canvas.addEventListener('wheel', this._onWheel.bind(this), { passive: false });
    this._touches = [];
    canvas.addEventListener('touchstart', this._onTouchStart.bind(this), { passive: true  });
    canvas.addEventListener('touchmove',  this._onTouchMove.bind(this),  { passive: false });

    this._start();
  }

  /** 迭代缓冲区内所有点（从最旧到最新），对每个点调用 fn(point) */
  _eachPoint(fn) {
    const { _CAP, _buf, _wPtr, _len } = this;
    const start = _len < _CAP ? 0 : _wPtr;  // 满时从最旧位置开始
    for (let i = 0; i < _len; i++) {
      fn(_buf[(start + i) % _CAP]);
    }
  }

  update(msg) {
    if (this._paused) return;
    const midi = msg.voiced ? _freqToMidi(msg.freq) : null;
    // 写入循环缓冲区（自动覆盖最旧条目，无需 shift()）
    this._buf[this._wPtr] = {
      ts:         msg.ts ?? Date.now() / 1000,
      midi,
      note_full:  msg.note_full ?? '',
      voiced:     msg.voiced,
      cents:      msg.cents ?? 0,
      confidence: msg.confidence ?? 1,
    };
    this._wPtr = (this._wPtr + 1) % this._CAP;
    if (this._len < this._CAP) this._len++;

    if (this._autoFollow && msg.voiced && midi !== null) {
      this._autoZoom(midi);
    }
  }

  /** 当前音高超出视窗边缘 20% 时平滑跟随 */
  _autoZoom(midi) {
    const range  = this._targetMax - this._targetMin;
    const margin = range * 0.20;
    if (midi < this._targetMin + margin || midi > this._targetMax - margin) {
      let newMin = midi - range / 2;
      newMin     = Math.max(12, Math.min(newMin, 108 - range));
      this._targetMin = newMin;
      this._targetMax = newMin + range;
    }
  }

  /** 根据过去 10s 实际音域动态收紧 Y 轴（每帧调用） */
  _fitRangeToHistory(now) {
    if (!this._autoFollow) return;
    const since = now - 10;
    let lo = Infinity, hi = -Infinity;
    this._eachPoint(p => {
      if (p.voiced && p.midi !== null && p.ts >= since) {
        if (p.midi < lo) lo = p.midi;
        if (p.midi > hi) hi = p.midi;
      }
    });
    if (lo === Infinity) return;
    const pad      = 4;
    const newMin   = Math.max(12, lo - pad);
    const newMax   = Math.min(108, hi + pad);
    const newRange = newMax - newMin;
    if (newRange < 6) return;
    this._targetMin = newMin;
    this._targetMax = newMax;
  }

  setPaused(v) { this._paused = v; }

  /**
   * 加载参考轨（歌曲分析结果），pitches 中的 t 字段为歌曲内相对时间（秒）
   * 渲染时对应 wallStart + t 的 wall-clock 时间戳
   */
  setReferenceTrack(pitches) {
    this._refPitches = (pitches || []).map(p => ({
      ts:       null,   // 延迟计算（需要 _wallStart）
      t:        p.t,
      midi:     p.midi ?? _freqToMidi(p.freq ?? 0),
      voiced:   p.voiced,
      cents:    p.cents ?? 0,
      note_full: p.note_full ?? '',
    }));
  }

  /** 设置歌曲开始播放的 wall-clock 时间（秒），用于参考轨与麦克风时间对齐 */
  setPlaybackWallStart(wallTs) {
    this._wallStart = wallTs;
  }

  /** 设置对比模式：'overlay'（叠加）| 'split'（上下分离） */
  setCompareMode(mode) {
    this._compareMode = mode;
  }
  get compareMode() { return this._compareMode; }

  /** 重置 Y 轴缩放 */
  resetZoom() {
    this._viewMin   = MIDI_MIN_DEFAULT;
    this._viewMax   = MIDI_MAX_DEFAULT;
    this._targetMin = MIDI_MIN_DEFAULT;
    this._targetMax = MIDI_MAX_DEFAULT;
  }

  /** 放大（缩小 Y 轴范围） */
  zoomIn()  { this._adjustZoom(-4); }

  /** 缩小（扩大 Y 轴范围） */
  zoomOut() { this._adjustZoom(+4); }

  // ── 缩放逻辑 ─────────────────────────────────────────

  _adjustZoom(delta, focusFrac = 0.5) {
    const range    = this._viewMax - this._viewMin;
    const newRange = Math.max(6, Math.min(52, range + delta));
    const center   = this._viewMin + range * focusFrac;
    const newMin   = center - newRange * focusFrac;
    const clamped  = Math.max(12, Math.min(newMin, 108 - newRange));
    // 用户手动缩放时同步更新 view 和 target（立即生效，不走 lerp）
    this._viewMin   = clamped;
    this._viewMax   = clamped + newRange;
    this._targetMin = clamped;
    this._targetMax = clamped + newRange;
  }

  _onWheel(e) {
    e.preventDefault();
    const rect      = this.canvas.getBoundingClientRect();
    const H         = rect.height || 1;
    const focusFrac = 1 - (e.clientY - rect.top) / H; // 底=低音=0, 顶=高音=1
    const delta     = e.deltaY > 0 ? +3 : -3;          // 向下滚=缩小=看得更宽
    this._adjustZoom(delta, focusFrac);
  }

  _onTouchStart(e) { this._touches = Array.from(e.touches); }
  _onTouchMove(e) {
    if (e.touches.length !== 2 || this._touches.length !== 2) return;
    e.preventDefault();
    const prev = Math.abs(this._touches[0].clientY - this._touches[1].clientY);
    const curr = Math.abs(e.touches[0].clientY   - e.touches[1].clientY);
    this._adjustZoom((prev - curr) * 0.15);
    this._touches = Array.from(e.touches);
  }

  _start() {
    const loop = () => {
      this._draw();
      this._animId = requestAnimationFrame(loop);
    };
    loop();
  }

  _draw() {
    const { canvas, ctx } = this;
    const W = canvas.offsetWidth, H = canvas.offsetHeight;
    if (W === 0 || H === 0) return;
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W; canvas.height = H;
    }

    const now = Date.now() / 1000;

    // 动态收紧 Y 轴
    this._fitRangeToHistory(now);

    // 平滑 lerp 到目标视窗
    const LERP = 0.08;
    this._viewMin += (this._targetMin - this._viewMin) * LERP;
    this._viewMax += (this._targetMax - this._viewMax) * LERP;

    const plotW    = W - LABEL_W;
    // 先留 2s 空白，让最新数据离右边有一点呀吱感
    const AHEAD_SEC = 2;
    const winStart   = now - WINDOW_SEC + AHEAD_SEC;
    const vMin     = this._viewMin;
    const vMax     = this._viewMax;
    const range    = vMax - vMin;
    const midiToY  = (m) => H - ((m - vMin) / range) * H;
    const tsToX    = (ts) => LABEL_W + ((ts - winStart) / WINDOW_SEC) * plotW;
    const pixPerMidi = H / range;

    // ── 1. Piano Roll 背景 ───────────────────────────────
    this._drawPianoRoll(ctx, W, H, midiToY, range, pixPerMidi, plotW);

    // ── 2. 参考轨 ───────────────────────────────────────
    if (this._refPitches.length > 0 && this._wallStart != null) {
      this._drawRefTrack(ctx, winStart, tsToX, midiToY, pixPerMidi);
    }

    // ── 3. 收集可见音高点 ────────────────────────────────
    const pts = [];
    this._eachPoint(p => { if (p.ts >= winStart && p.ts <= now) pts.push(p); });

    if (pts.length === 0) {
      ctx.fillStyle    = 'rgba(139,148,158,0.4)';
      ctx.font         = '13px "Segoe UI"';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('等待音频输入...', LABEL_W + plotW / 2, H / 2);
    } else {
      // ── 4. 水平色块轨迹 ─────────────────────────────────
      this._drawPianoRollTrack(ctx, pts, tsToX, midiToY, pixPerMidi, winStart);

      // ── 5. 最近 4 个有声帧拖尾指示器 ──────────────────
      const recentVoiced = [];
      for (let i = pts.length - 1; i >= 0 && recentVoiced.length < 4; i--) {
        if (pts[i].voiced && pts[i].midi !== null) recentVoiced.push(pts[i]);
      }
      if (recentVoiced.length > 0) this._drawCurrentIndicator(ctx, recentVoiced, tsToX, midiToY, W, H);
    }

    // ── 6. 播放头（‘2s 前“现在”竖虚线）─────────────
    const headX = Math.round(tsToX(now));
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(headX, 0);
    ctx.lineTo(headX, H);
    ctx.stroke();
    ctx.fillStyle    = 'rgba(255,255,255,0.35)';
    ctx.font         = '9px "Segoe UI"';
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText('现在', headX - 3, 3);
    ctx.restore();

    // ── 7. X 轴时间刻度 ─────────────────────────────────
    this._drawXAxis(ctx, W, H, plotW);

    // ── 8. 颜色图例 ──────────────────────────────────────
    this._drawLegend(ctx, W);
  }

  // ────────────────────────────────────────────────────────
  //  Piano Roll 背景（黑/白键行 + C音高亮 + 背景水印）
  // ────────────────────────────────────────────────────────
  _drawPianoRoll(ctx, W, H, midiToY, range, pixPerMidi, plotW) {
    // 清底
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, H);

    const mLo = Math.floor(this._viewMin) - 1;
    const mHi = Math.ceil(this._viewMax)  + 1;

    // ── 第一遍：所有行画白键浅色底（包括黑键行位置也先画浅色） ──
    // 这样 E-F、B-C 之间只有两个紧邻的浅色行，不会夹着深色条
    for (let m = mLo; m <= mHi; m++) {
      const ni  = ((m % 12) + 12) % 12;
      const isC = ni === 0;

      const yTop    = midiToY(m + 1);
      const yBottom = midiToY(m);
      const rowH    = yBottom - yTop;
      if (rowH <= 0) continue;

      if (isC) {
        ctx.fillStyle = 'rgba(30,60,100,0.30)';
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.055)';
      }
      ctx.fillRect(LABEL_W, yTop, plotW, rowH);

      // C 音行：蓝色左侧条 + 蓝色分隔线
      if (isC) {
        ctx.fillStyle = 'rgba(56,139,253,0.45)';
        ctx.fillRect(LABEL_W, yTop, 3, rowH);
        ctx.strokeStyle = 'rgba(56,139,253,0.35)';
        ctx.lineWidth   = 1;
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.lineWidth   = 0.5;
      }
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(LABEL_W, yBottom);
      ctx.lineTo(W, yBottom);
      ctx.stroke();
    }

    // ── 第二遍：黑键行画居中深色细条覆盖（宽度约 70% 行高，上下留空白） ──
    // 只有真正存在黑键的位置（C#,D#,F#,G#,A#）才会有深色条，
    // E-F 和 B-C 之间不会被影响
    for (let m = mLo; m <= mHi; m++) {
      const ni = ((m % 12) + 12) % 12;
      if (!BLACK_KEYS.has(ni)) continue;

      const yTop    = midiToY(m + 1);
      const yBottom = midiToY(m);
      const rowH    = yBottom - yTop;
      if (rowH <= 0) continue;

      const pad = rowH * 0.1;   // 上下各留 10%
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(LABEL_W, yTop + pad, plotW, rowH - pad * 2);
    }

    // ── 第三遍：背景水印音名（白键行） ─────────────────
    if (pixPerMidi >= 8) {
      for (let m = mLo; m <= mHi; m++) {
        const ni  = ((m % 12) + 12) % 12;
        if (BLACK_KEYS.has(ni)) continue;
        const isC = ni === 0;
        const oct = Math.floor(m / 12) - 1;
        const yTop    = midiToY(m + 1);
        const yBottom = midiToY(m);
        const rowH    = yBottom - yTop;
        if (rowH <= 0) continue;
        const name = NOTE_NAMES[ni] + oct;
        ctx.save();
        ctx.font         = isC ? 'bold 10px "Segoe UI"' : '9px "Segoe UI"';
        ctx.fillStyle    = isC ? 'rgba(56,139,253,0.30)' : 'rgba(139,148,158,0.15)';
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(name, LABEL_W + 5, yTop + rowH / 2);
        ctx.restore();
      }
    }

    // ── 左侧标签列 ───────────────────────────────────
    ctx.fillStyle = 'rgba(13,17,23,0.75)';
    ctx.fillRect(0, 0, LABEL_W, H);
    // 分隔线
    ctx.strokeStyle = '#21262d';
    ctx.lineWidth   = 1;
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(LABEL_W - 0.5, 0); ctx.lineTo(LABEL_W - 0.5, H); ctx.stroke();

    if (pixPerMidi >= 5) {
      ctx.textAlign    = 'right';
      ctx.textBaseline = 'middle';
      for (let m = mLo; m <= mHi; m++) {
        const ni  = ((m % 12) + 12) % 12;
        const isC = ni === 0;
        if (!isC && !NATURAL.has(ni)) continue;
        const oct = Math.floor(m / 12) - 1;
        const y   = midiToY(m);
        if (y < -4 || y > H + 4) continue;
        if (isC) {
          ctx.font      = 'bold 11px "Segoe UI"';
          ctx.fillStyle = '#79c0ff';
        } else if (pixPerMidi >= 10) {
          ctx.font      = '10px "Segoe UI"';
          ctx.fillStyle = '#6e7681';
        } else continue;
        ctx.fillText(NOTE_NAMES[ni] + oct, LABEL_W - 5, y);
      }
    }
  }

  // ────────────────────────────────────────────────────────
  //  水平色块轨迹（Piano Roll 风格，连续帧合并为色块）
  // ────────────────────────────────────────────────────────
  _drawPianoRollTrack(ctx, pts, tsToX, midiToY, pixPerMidi, winStart) {
    const barH   = Math.max(4, Math.min(pixPerMidi * 0.65, 20));
    const radius = barH / 2;

    // 将连续 voiced 帧合并成"音符块"
    const segments = [];
    let seg = null;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!p.voiced || p.midi === null) {
        seg = null; continue;
      }
      if (!seg || (p.ts - seg.lastTs) > MAX_GAP_SEC) {
        seg = { pts: [p], lastTs: p.ts };
        segments.push(seg);
      } else {
        seg.pts.push(p);
        seg.lastTs = p.ts;
      }
    }

    // 前端最后一道防线：过滤持续时间不足且置信度偏低的短爆音胶囊
    // （后端 smoother 已处理大部分情况，此处属于容错垃圾收集）
    const MIN_CAPS_SEC  = 0.06;   // 小于 60 ms 且均均置信度 < 0.75 则跳过
    const filteredSegs = segments.filter(s => {
      const dur = s.lastTs - s.pts[0].ts;
      if (dur >= MIN_CAPS_SEC) return true;
      const avgConf = s.pts.reduce((a, p) => a + (p.confidence ?? 1), 0) / s.pts.length;
      return avgConf >= 0.75;
    });

    // 绘制每个音符块（水平胶囊色块，全部用 roundRect，不再用 arc）
    for (const s of filteredSegs) {
      if (s.pts.length === 0) continue;
      const first = s.pts[0];
      const last  = s.pts[s.pts.length - 1];

      // 时间淡出：越旧越透明（0.20 → 1.0）
      const midTs   = (first.ts + last.ts) / 2;
      const ageFrac = Math.max(0, Math.min(1, (midTs - winStart) / WINDOW_SEC));
      const baseAlpha = 0.20 + ageFrac * 0.80;

      const x0   = tsToX(first.ts);
      const x1   = tsToX(last.ts) + 2;  // 略延伸避免闪烁
      // 单帧也保证最小宽度 = barH（形成圆形胶囊），不再用 arc
      const segW = Math.max(barH, x1 - x0);

      const avgMidi  = s.pts.reduce((a, p) => a + p.midi, 0) / s.pts.length;
      const avgCents = s.pts.reduce((a, p) => a + (p.cents ?? 0), 0) / s.pts.length;
      const color    = _tuneColor(avgCents);
      const y        = midiToY(avgMidi);

      // 主色块（统一用圆角矩形胶囊）
      ctx.save();
      ctx.shadowColor  = color;
      ctx.shadowBlur   = 6;
      ctx.globalAlpha  = baseAlpha * 0.9;
      ctx.beginPath();
      ctx.roundRect(x0, y - barH / 2, segW, barH, radius);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.restore();

      // 高光细线（顶部 1px 白色，增加立体感）
      ctx.save();
      ctx.globalAlpha = baseAlpha * 0.25;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(x0 + radius, y - barH / 2 + 0.5);
      ctx.lineTo(x0 + segW - radius, y - barH / 2 + 0.5);
      ctx.stroke();
      ctx.restore();

      // 若帧间 midi 起伏明显，叠加平滑连线（滑音曲线），降低至 20% 不透明度
      const midiRange = Math.max(...s.pts.map(p => p.midi)) - Math.min(...s.pts.map(p => p.midi));
      if (midiRange >= 1 && s.pts.length >= 3) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.20)';
        ctx.lineWidth   = 1.5;
        ctx.lineJoin    = 'round';
        ctx.lineCap     = 'round';
        ctx.globalAlpha = baseAlpha;
        ctx.beginPath();
        s.pts.forEach((p, i) => {
          const px = tsToX(p.ts);
          const py = midiToY(p.midi);
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        });
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  // ────────────────────────────────────────────────────────
  //  当前音高发光指示器（最近几个帧拖尾，newest-first 数组）
  // ────────────────────────────────────────────────────────
  _drawCurrentIndicator(ctx, recentVoiced, tsToX, midiToY, W, H) {
    // recentVoiced[0] = 最新，[n-1] = 最旧
    const last  = recentVoiced[0];
    const x     = tsToX(last.ts);
    const y     = midiToY(last.midi);
    const color = _tuneColor(last.cents);

    ctx.save();

    // ── 拖尾（从旧到新，越旧越小越透明）──────────────────
    for (let i = recentVoiced.length - 1; i >= 1; i--) {
      const p      = recentVoiced[i];
      const frac   = 1 - i / recentVoiced.length; // 0(最旧)→接近1(次新)
      const alpha  = 0.15 + frac * 0.35;
      const radius = 2 + frac * 3;
      const pc     = _tuneColor(p.cents);
      ctx.globalAlpha = alpha;
      ctx.fillStyle   = pc;
      ctx.beginPath();
      ctx.arc(tsToX(p.ts), midiToY(p.midi), radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // ── 贯穿全宽极淡辅助水平线 ────────────────────────────
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.12;
    ctx.lineWidth   = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(LABEL_W, y);
    ctx.lineTo(W, y);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // ── 外光晕 ────────────────────────────────────────────
    const r   = 7;
    const grd = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 3.5);
    grd.addColorStop(0, color + 'cc');
    grd.addColorStop(1, color + '00');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(x, y, r * 3.5, 0, Math.PI * 2);
    ctx.fill();

    // ── 实心圆点 ──────────────────────────────────────────
    ctx.shadowColor = color;
    ctx.shadowBlur  = 10;
    ctx.fillStyle   = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur  = 0;

    // ── 音名 + 音分偏差标注 ───────────────────────────────
    const centsStr = last.cents != null
      ? ` ${last.cents >= 0 ? '+' : ''}${last.cents.toFixed(0)}¢`
      : '';
    const label  = (last.note_full ?? '') + centsStr;
    const labelX = Math.min(x + r + 6, W - 4);

    ctx.font         = 'bold 13px "Segoe UI", monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign    = 'left';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(13,17,23,0.8)';
    ctx.fillRect(labelX - 2, y - 9, tw + 6, 18);
    ctx.fillStyle = color;
    ctx.fillText(label, labelX, y);

    ctx.restore();
  }

  // ────────────────────────────────────────────────────────
  //  参考轨（半透明蓝色色块）
  // ────────────────────────────────────────────────────────
  _drawRefTrack(ctx, winStart, tsToX, midiToY, pixPerMidi) {
    if (!this._wallStart) return;
    const barH = Math.max(3, Math.min(pixPerMidi * 0.55, 16));
    const refPts = this._refPitches
      .filter(p => p.voiced && p.midi != null)
      .map(p => ({ ...p, ts: this._wallStart + p.t }))
      .filter(p => p.ts >= winStart && p.ts <= winStart + WINDOW_SEC);
    if (refPts.length === 0) return;

    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.fillStyle   = '#58a6ff';

    // 同样做合并分段
    let rSeg = null;
    const rSegs = [];
    for (const p of refPts) {
      if (!rSeg || (p.ts - rSeg.endTs) > MAX_GAP_SEC) {
        rSeg = { x0: tsToX(p.ts), endX: tsToX(p.ts), midi: p.midi, endTs: p.ts };
        rSegs.push(rSeg);
      } else {
        rSeg.endX  = tsToX(p.ts);
        rSeg.endTs = p.ts;
      }
    }
    for (const s of rSegs) {
      const y    = midiToY(s.midi);
      const segW = Math.max(3, s.endX - s.x0 + 2);
      ctx.beginPath();
      ctx.roundRect(s.x0, y - barH / 2, segW, barH, barH / 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** 颜色图例（右上角，三色说明） */
  _drawLegend(ctx, W) {
    const items = [
      { color: '#3fb950', label: '±15¢ 准' },
      { color: '#d29922', label: '±30¢ 偏' },
      { color: '#f85149', label: '>30¢  跑调' },
    ];
    const x0 = W - 4;
    let  y0  = 4;
    ctx.save();
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'top';
    ctx.font         = '9px "Segoe UI"';
    for (const it of items) {
      ctx.fillStyle = it.color;
      ctx.fillRect(x0 - ctx.measureText(it.label).width - 9, y0 + 2, 6, 6);
      ctx.fillStyle = 'rgba(139,148,158,0.65)';
      ctx.fillText(it.label, x0, y0);
      y0 += 14;
    }
    ctx.restore();
  }

  _drawXAxis(ctx, W, H, plotW) {
    const tickCount = 6;
    ctx.font         = '10px "Segoe UI", monospace';
    ctx.fillStyle    = '#6e7681';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';
    ctx.strokeStyle  = '#21262d';
    ctx.lineWidth    = 0.6;

    for (let i = 0; i <= tickCount; i++) {
      const frac    = i / tickCount;
      const x       = LABEL_W + frac * plotW;
      const secAgo  = Math.round(WINDOW_SEC * (1 - frac));

      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x, 0); ctx.lineTo(x, H);
      ctx.stroke();

      ctx.fillText(secAgo === 0 ? '现在' : `-${secAgo}s`, x, H - 1);
    }
  }

  /** 切换绘制风格，返回当前风格 */
  toggleStyle() {
    this._style = this._style === 'piano' ? 'line' : 'piano';
    return this._style;
  }

  /** 设置自动跟随 */
  setAutoFollow(v) { this._autoFollow = v; }

  /** 读取自动跟随状态 */
  get autoFollow() { return this._autoFollow; }
}

// ── 工具函数 ──────────────────────────────────────────────

function _freqToMidi(freq) {
  if (!freq || freq <= 0) return null;
  return Math.round(69 + 12 * Math.log2(freq / 440));
}

function _midiName(m) {
  const oct = Math.floor(m / 12) - 1;
  return NOTE_NAMES[((m % 12) + 12) % 12] + oct;
}

function _tuneColor(cents) {
  const a = Math.abs(cents ?? 0);
  if (a <= 15) return '#3fb950';
  if (a <= 30) return '#d29922';
  return '#f85149';
}
