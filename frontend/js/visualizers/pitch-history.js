/**
 * pitch-history.js — 滚动音高时间轴
 * - 30 秒滚动窗口
 * - Y 轴范围 C2(MIDI 36) ~ C6(MIDI 84)，精细标注所有自然音
 * - 鼠标滚轮：垂直缩放（聚焦特定音域）
 * - 双指捏合缩放（触摸设备）
 * - 支持全屏展开（由外部 CSS 驱动，canvas 自动适配）
 */

const NOTE_NAMES  = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const NATURAL     = new Set([0, 2, 4, 5, 7, 9, 11]); // C D E F G A B

const WINDOW_SEC       = 30;
const MIDI_MIN_DEFAULT = 48;   // C3（默认 2 个八度视窗）
const MIDI_MAX_DEFAULT = 72;   // C5
const BUFFER_SEC       = 90;   // 内存中最多保留 90 秒
const DOT_RADIUS       = 2.5;
const BAR_MIN_H        = 5;    // 柱状模式最小高度 px
const LABEL_W          = 56;   // 左侧标签区宽度（放大以容纳更大字体）

export class PitchHistory {
  constructor(canvas) {
    this.canvas   = canvas;
    this.ctx      = canvas.getContext('2d');

    // 循环缓冲区替代 Array + shift()，消除 O(n) 内存移动
    // 容量 = BUFFER_SEC × ~22 fps + 余量，取 2 的幂方便位运算
    this._CAP    = 2048;               // ~93s @ 22 fps
    this._buf    = new Array(this._CAP);
    this._wPtr   = 0;                  // 下一个写入位置
    this._len    = 0;                  // 已存储条目数

    this._paused  = false;
    this._animId  = null;

    // 显示风格: 'dot' 点线 | 'bar' 横向柱状
    this._style      = 'dot';

    // 自动跟随当前音高
    this._autoFollow = true;

    // 参考轨（歌曲分析结果）
    this._refPitches  = [];    // [{t, midi, voiced, cents, note_full}...]
    this._wallStart   = null;  // 歌曲开始播放时的 wall-clock 时间戳（秒）
    this._compareMode = 'overlay'; // 'overlay' 叠加 | 'split' 上下分离

    // Y 轴可视范围（MIDI 浮点，lerp 插值）
    this._viewMin    = MIDI_MIN_DEFAULT;
    this._viewMax    = MIDI_MAX_DEFAULT;

    // 目标视窗（自动跟随时先修改 target，view 平滑跟上）
    this._targetMin  = MIDI_MIN_DEFAULT;
    this._targetMax  = MIDI_MAX_DEFAULT;

    // 注册滚轮缩放
    canvas.addEventListener('wheel', this._onWheel.bind(this), { passive: false });
    // 触摸双指捏合
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
      ts:        msg.ts ?? Date.now() / 1000,
      midi,
      note_full: msg.note_full ?? '',
      voiced:    msg.voiced,
      cents:     msg.cents ?? 0,
    };
    this._wPtr = (this._wPtr + 1) % this._CAP;
    if (this._len < this._CAP) this._len++;

    // 自动跟随：当音高超出可视范围边缘 25% 时平滑移动至中心
    if (this._autoFollow && msg.voiced && midi !== null) {
      const range  = this._targetMax - this._targetMin;
      const margin = range * 0.25;
      if (midi < this._targetMin + margin || midi > this._targetMax - margin) {
        let newMin = midi - range / 2;
        newMin     = Math.max(12, Math.min(newMin, 108 - range));
        this._targetMin = newMin;
        this._targetMax = newMin + range;
      }
    }
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

    ctx.clearRect(0, 0, W, H);

    // ── 平滑插值到目标视窗（自动跟随时产生滑动效果）────────
    const LERP = 0.10;
    this._viewMin += (this._targetMin - this._viewMin) * LERP;
    this._viewMax += (this._targetMax - this._viewMax) * LERP;

    const plotW    = W - LABEL_W;
    const now      = Date.now() / 1000;
    const winStart = now - WINDOW_SEC;
    const vMin     = this._viewMin;
    const vMax     = this._viewMax;
    const range    = vMax - vMin;
    const midiToY  = (m) => H - ((m - vMin) / range) * H;

    // ── Y 轴网格与标注 ──────────────────────────────────
    this._drawYAxis(ctx, W, H, midiToY, range);

    // ── X 轴时间刻度 ────────────────────────────────────
    this._drawXAxis(ctx, W, H, plotW);

    // ── 音高轨迹 ────────────────────────────────────────
    // 从循环缓冲区收集可见窗口内的点（只扫描 _len 个条目，无内存分配开销）
    const pts = [];
    this._eachPoint(p => { if (p.ts >= winStart && p.ts <= now) pts.push(p); });

    if (pts.length === 0) {
      ctx.fillStyle    = '#484f58';
      ctx.font         = '13px "Segoe UI"';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('等待音频输入...', LABEL_W + plotW / 2, H / 2);
      return;
    }

    const tsToX = (ts) => LABEL_W + ((ts - winStart) / WINDOW_SEC) * plotW;

    if (this._compareMode === 'split' && this._refPitches.length > 0 && this._wallStart != null) {
      // ── 上下分离模式 ─────────────────────────────────────
      const halfH = H / 2;
      // 上半部分（参考轨）midiToY
      const midiToYRef = (m) => halfH - ((m - vMin) / range) * halfH;
      // 下半部分（麦克风轨）midiToY
      const midiToYMic = (m) => H   - ((m - vMin) / range) * halfH;

      // 上半区绘制参考轨
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, halfH);
      ctx.clip();
      this._drawRefOverlay(ctx, winStart, tsToX, midiToYRef, W, halfH);
      ctx.restore();

      // 分隔线
      ctx.save();
      ctx.strokeStyle = '#30363d';
      ctx.lineWidth   = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(LABEL_W, halfH);
      ctx.lineTo(W, halfH);
      ctx.stroke();
      ctx.restore();

      // 下半区绘制麦克风轨
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, halfH, W, halfH);
      ctx.clip();
      if (this._style === 'bar') {
        this._drawBars(ctx, pts, tsToX, midiToYMic, halfH);
      } else {
        this._drawDots(ctx, pts, tsToX, midiToYMic);
      }
      ctx.restore();

      // 区域标签
      ctx.font         = '10px "Segoe UI"';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle    = 'rgba(88,166,255,0.7)';
      ctx.fillText('参考', LABEL_W + 4, 2);
      ctx.fillStyle    = 'rgba(63,185,80,0.7)';
      ctx.fillText('麦克风', LABEL_W + 4, halfH + 2);
    } else {
      // ── 叠加模式（默认）────────────────────────────────────
      this._drawRefOverlay(ctx, winStart, tsToX, midiToY, W, H);
      if (this._style === 'bar') {
        this._drawBars(ctx, pts, tsToX, midiToY, H);
      } else {
        this._drawDots(ctx, pts, tsToX, midiToY);
      }
    }

    // ── 最新音名标注 ─────────────────────────────────────
    const last = [...pts].reverse().find(p => p.voiced);
    if (last) {
      const x = tsToX(last.ts);
      const y = midiToY(last.midi);
      ctx.save();
      ctx.font         = 'bold 12px monospace';
      ctx.fillStyle    = '#e6edf3';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'middle';
      ctx.shadowColor  = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur   = 3;
      ctx.fillText(last.note_full, Math.min(x + 7, W - 36), y);
      ctx.restore();
    }

    // ── 缩放信息提示 ─────────────────────────────────────
    if (range < (MIDI_MAX_DEFAULT - MIDI_MIN_DEFAULT) - 1) {
      ctx.font         = '9px "Segoe UI"';
      ctx.fillStyle    = '#484f58';
      ctx.textAlign    = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(
        `${_midiName(Math.round(vMin))}–${_midiName(Math.round(vMax - 1))}  滚轮缩放`,
        W - 4, 3
      );
    }
  }

  _drawYAxis(ctx, W, H, midiToY, range) {
    const pixPerMidi     = H / range;
    const showAllNatural = pixPerMidi >= 4;   // 足够密时标注全部自然音
    const showSharps     = pixPerMidi >= 14;  // 极密时画半音线

    ctx.save();

    // 标签区背景（轻微区分，辅助阅读）
    ctx.fillStyle = 'rgba(13,17,23,0.55)';
    ctx.fillRect(0, 0, LABEL_W - 1, H);

    // 标签区右侧分隔线
    ctx.strokeStyle = '#21262d';
    ctx.lineWidth   = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(LABEL_W - 0.5, 0);
    ctx.lineTo(LABEL_W - 0.5, H);
    ctx.stroke();

    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';

    for (let m = Math.floor(this._viewMin); m <= Math.ceil(this._viewMax) + 1; m++) {
      const ni      = ((m % 12) + 12) % 12;
      const oct     = Math.floor(m / 12) - 1;
      const isC       = ni === 0;
      const isNatural = NATURAL.has(ni);
      const isSharp   = !isNatural;

      const y = midiToY(m);
      if (y < -2 || y > H + 2) continue;

      // 网格线
      if (isC) {
        ctx.strokeStyle = '#2d3d4f';
        ctx.lineWidth   = 1;
        ctx.setLineDash([6, 5]);
      } else if (isNatural && showAllNatural) {
        ctx.strokeStyle = '#1e2830';
        ctx.lineWidth   = 0.75;
        ctx.setLineDash([2, 5]);
      } else if (isSharp && showSharps) {
        ctx.strokeStyle = '#191e25';
        ctx.lineWidth   = 0.4;
        ctx.setLineDash([]);
      } else {
        continue;
      }

      ctx.beginPath();
      ctx.moveTo(LABEL_W, y);
      ctx.lineTo(W, y);
      ctx.stroke();
      ctx.setLineDash([]);

      // 文字标签
      if (isC) {
        // C 音：大号粗体 + 高亮 + 淡底色条带
        ctx.fillStyle = 'rgba(56,139,253,0.08)';
        ctx.fillRect(0, y - 9, LABEL_W - 1, 18);
        ctx.font      = 'bold 13px "Segoe UI", monospace';
        ctx.fillStyle = '#79c0ff';
        ctx.fillText(`C${oct}`, LABEL_W - 7, y);
      } else if (isNatural && showAllNatural) {
        ctx.font      = '11px "Segoe UI", monospace';
        ctx.fillStyle = '#8b949e';
        ctx.fillText(`${NOTE_NAMES[ni]}${oct}`, LABEL_W - 7, y);
      }
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

  /** 点线风格 */
  _drawDots(ctx, pts, tsToX, midiToY) {
    let prevVoiced = false, prevX = 0, prevY = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!p.voiced || p.midi === null) { prevVoiced = false; continue; }
      const x     = tsToX(p.ts);
      const y     = midiToY(p.midi);
      const color = _tuneColor(p.cents);
      if (prevVoiced) {
        ctx.beginPath();
        ctx.moveTo(prevX, prevY);
        ctx.lineTo(x, y);
        ctx.strokeStyle = color;
        ctx.lineWidth   = 2;
        ctx.lineCap     = 'round';
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      prevVoiced = true; prevX = x; prevY = y;
    }
  }

  /** 横向柱状风格 */
  _drawBars(ctx, pts, tsToX, midiToY, H) {
    const range      = this._viewMax - this._viewMin;
    const pixPerMidi = H / range;
    const barH       = Math.max(BAR_MIN_H, pixPerMidi * 0.72);
    const radius     = barH / 2;

    for (let i = 0; i < pts.length; i++) {
      const p    = pts[i];
      if (!p.voiced || p.midi === null) continue;

      const x    = tsToX(p.ts);
      const y    = midiToY(p.midi);
      const next = pts[i + 1];
      // 柱宽延伸到下一个点（或固定宽度作为孤立点）
      let barW;
      if (next && next.voiced && next.midi !== null && (next.ts - p.ts) < 0.35) {
        barW = (tsToX(next.ts) - x) + 1;
      } else {
        // 单独的点用固定宽度
        barW = Math.max(6, pixPerMidi * 0.5);
      }
      barW = Math.max(3, barW);

      const color = _tuneColor(p.cents);
      // 圆角矩形
      ctx.beginPath();
      ctx.roundRect(x, y - barH / 2, barW, barH, radius);
      ctx.fillStyle = color;
      ctx.fill();
    }
  }

  /** 叠加模式：在麦克风轨之前绘制半透明参考轨 */
  _drawRefOverlay(ctx, winStart, tsToX, midiToY, W, H) {
    if (this._refPitches.length === 0 || this._wallStart == null) return;
    const pts = this._refPitches
      .filter(p => p.voiced && p.midi != null)
      .map(p => ({ ...p, ts: this._wallStart + p.t }))
      .filter(p => p.ts >= winStart && p.ts <= winStart + WINDOW_SEC);
    if (pts.length === 0) return;

    const range      = this._viewMax - this._viewMin;
    const pixPerMidi = H / range;
    const barH       = Math.max(4, pixPerMidi * 0.68);
    const style      = this._style;

    ctx.save();
    ctx.globalAlpha = 0.55;

    if (style === 'bar') {
      for (let i = 0; i < pts.length; i++) {
        const p    = pts[i];
        const x    = tsToX(p.ts);
        const y    = midiToY(p.midi);
        const next = pts[i + 1];
        const barW = (next && (next.ts - p.ts) < 0.35)
          ? (tsToX(next.ts) - x + 1)
          : Math.max(6, pixPerMidi * 0.5);
        ctx.beginPath();
        ctx.roundRect(x, y - barH / 2, Math.max(3, barW), barH, barH / 2);
        ctx.fillStyle = 'rgba(88,166,255,0.9)';
        ctx.fill();
      }
    } else {
      let prevX = null, prevY = null;
      for (const p of pts) {
        const x = tsToX(p.ts);
        const y = midiToY(p.midi);
        if (prevX !== null) {
          ctx.beginPath();
          ctx.moveTo(prevX, prevY);
          ctx.lineTo(x, y);
          ctx.strokeStyle = 'rgba(88,166,255,0.9)';
          ctx.lineWidth   = 2;
          ctx.lineCap     = 'round';
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(88,166,255,0.9)';
        ctx.fill();
        prevX = x; prevY = y;
      }
    }
    ctx.restore();
  }

  /** 切换绘制风格，返回当前风格 */
  toggleStyle() {
    this._style = this._style === 'dot' ? 'bar' : 'dot';
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
