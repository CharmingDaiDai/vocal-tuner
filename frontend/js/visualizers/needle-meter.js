/**
 * needle-meter.js — 指针式调音表
 * 中央大字显示当前音名（A4 / C#4 等），指针显示 cents 偏差，颜色编码音准等级。
 */

const COLORS = { good: '#3fb950', close: '#d29922', off: '#f85149', muted: '#484f58' };

export class NeedleMeter {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this._data  = null;
    this._animId = null;
    // 平滑指针（低通滤波）
    this._smoothCents = 0;
    this._smoothFreq  = 0;
    this._start();
  }

  /** 更新数据（由外部调用） */
  update(msg) { this._data = msg; }

  _start() {
    const loop = () => {
      this._draw();
      this._animId = requestAnimationFrame(loop);
    };
    loop();
  }

  _draw() {
    const { canvas, ctx } = this;
    const W = canvas.offsetWidth,  H = canvas.offsetHeight;
    if (W === 0 || H === 0) return;

    // 同步 canvas 分辨率（响应窗口缩放）
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width  = W;
      canvas.height = H;
    }

    ctx.clearRect(0, 0, W, H);

    const msg     = this._data;
    const voiced  = msg?.voiced ?? false;
    const cents   = voiced ? (msg.cents ?? 0) : 0;
    const freq    = voiced ? (msg.freq  ?? 0) : 0;
    const level   = msg?.tune_level ?? 'off';
    const noteFull= msg?.note_full  ?? '—';

    // 平滑
    const alpha = voiced ? 0.25 : 0.1;
    this._smoothCents += alpha * (cents          - this._smoothCents);
    this._smoothFreq  += alpha * (freq           - this._smoothFreq);

    const cx = W / 2;
    const cy = H * 0.62;
    const R  = Math.min(W, H) * 0.40;

    const fgColor = voiced ? COLORS[level] : COLORS.muted;

    // ── 半圆刻度盘 ───────────────────────────────────────
    const arcStart = Math.PI;
    const arcEnd   = 2 * Math.PI;

    // 背景弧
    ctx.beginPath();
    ctx.arc(cx, cy, R, arcStart, arcEnd);
    ctx.strokeStyle = '#2d333b';
    ctx.lineWidth = 8;
    ctx.stroke();

    // 彩色进度弧（从正中到当前位置）
    const midAngle  = Math.PI * 1.5;           // 顶部（0 cents）
    const maxAngle  = Math.PI * 0.5;           // 半圆半径对应 ±50 cents
    const direction = this._smoothCents / 50;  // [-1, 1]
    const endAngle  = midAngle + direction * maxAngle;

    ctx.beginPath();
    ctx.arc(cx, cy, R, Math.min(midAngle, endAngle), Math.max(midAngle, endAngle));
    ctx.strokeStyle = fgColor;
    ctx.lineWidth = 8;
    ctx.lineCap = 'round';
    ctx.stroke();

    // 刻度线 & 标签
    for (let c = -50; c <= 50; c += 10) {
      const a = midAngle + (c / 50) * maxAngle;
      const isZero = c === 0;
      const innerR = R - (isZero ? 18 : 10);
      const outerR = R + 6;

      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * innerR, cy + Math.sin(a) * innerR);
      ctx.lineTo(cx + Math.cos(a) * outerR, cy + Math.sin(a) * outerR);
      ctx.strokeStyle = isZero ? '#58a6ff' : '#444c56';
      ctx.lineWidth   = isZero ? 3 : 1;
      ctx.stroke();

      // 刻度数字
      if (c % 20 === 0) {
        const tx = cx + Math.cos(a) * (R + 18);
        const ty = cy + Math.sin(a) * (R + 18);
        ctx.fillStyle = '#8b949e';
        ctx.font = `${Math.round(R * 0.13)}px 'Segoe UI', sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(c === 0 ? '0' : `${c > 0 ? '+' : ''}${c}`, tx, ty);
      }
    }

    // ── 指针 ─────────────────────────────────────────────
    const needleAngle = midAngle + (this._smoothCents / 50) * maxAngle;
    const needleLen   = R - 12;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(
      cx + Math.cos(needleAngle) * needleLen,
      cy + Math.sin(needleAngle) * needleLen,
    );
    ctx.strokeStyle = fgColor;
    ctx.lineWidth   = 3;
    ctx.lineCap     = 'round';
    ctx.shadowColor  = fgColor;
    ctx.shadowBlur   = voiced ? 8 : 0;
    ctx.stroke();
    ctx.restore();

    // 中心圆点
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, 2 * Math.PI);
    ctx.fillStyle = voiced ? fgColor : COLORS.muted;
    ctx.fill();

    // ── 中央大字：音名 ───────────────────────────────────
    const noteFontSize = Math.round(Math.min(W, H) * 0.22);
    ctx.font = `700 ${noteFontSize}px 'Segoe UI', monospace`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = voiced ? fgColor : COLORS.muted;
    // 光晕
    if (voiced) {
      ctx.shadowColor = fgColor;
      ctx.shadowBlur  = 20;
    }
    ctx.fillText(noteFull, cx, H * 0.24);
    ctx.shadowBlur = 0;

    // ── 频率副标题 ───────────────────────────────────────
    const subFontSize = Math.round(Math.min(W, H) * 0.065);
    ctx.font      = `${subFontSize}px 'Segoe UI', sans-serif`;
    ctx.fillStyle = '#8b949e';

    if (voiced) {
      const centsStr = this._smoothCents >= 0
        ? `+${this._smoothCents.toFixed(1)}¢`
        : `${this._smoothCents.toFixed(1)}¢`;
      ctx.fillText(`${this._smoothFreq.toFixed(1)} Hz  ${centsStr}`, cx, H * 0.36);
    } else {
      ctx.fillStyle = '#484f58';
      ctx.fillText('静音 / 无信号', cx, H * 0.36);
    }

    // ── 底部 cents 数字 ──────────────────────────────────
    if (voiced) {
      ctx.font      = `500 ${Math.round(R * 0.18)}px 'Segoe UI', monospace`;
      ctx.fillStyle = fgColor;
      ctx.textAlign = 'center';
      const centsLabel = this._smoothCents >= 0
        ? `+${this._smoothCents.toFixed(1)}¢`
        : `${this._smoothCents.toFixed(1)}¢`;
      ctx.fillText(centsLabel, cx, H * 0.88);
    }
  }
}
