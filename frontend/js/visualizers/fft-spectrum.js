/**
 * fft-spectrum.js — 实时 FFT 频谱图
 * 显示 0–4000 Hz 的幅度柱状图，基频位置用橙色竖线 + 音名标注。
 */

export class FftSpectrum {
  constructor(canvas) {
    this.canvas  = canvas;
    this.ctx     = canvas.getContext('2d');
    this._fft    = null;
    this._data   = null;
    this._animId = null;
    this._start();
  }

  /** 更新 FFT 数据（可能每隔几帧来一次） */
  updateFft(fftArray) { this._fft = fftArray; }

  /** 更新音高数据（每帧） */
  update(msg) {
    this._data = msg;
    if (msg.fft) this._fft = msg.fft;
  }

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

    const fft    = this._fft;
    const msg    = this._data;
    const voiced = msg?.voiced ?? false;
    const freq   = msg?.freq   ?? 0;
    const note   = msg?.note_full ?? '';

    const PAD_L = 36, PAD_B = 28, PAD_T = 10, PAD_R = 10;
    const plotW = W - PAD_L - PAD_R;
    const plotH = H - PAD_T - PAD_B;
    const MAX_FREQ = 4000;

    // ── 网格 ─────────────────────────────────────────────
    ctx.strokeStyle = '#21262d';
    ctx.lineWidth   = 1;
    for (let i = 0; i <= 4; i++) {
      const y = PAD_T + (plotH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(PAD_L, y); ctx.lineTo(W - PAD_R, y);
      ctx.stroke();
    }

    // X 轴刻度（500, 1000, 2000, 3000, 4000 Hz）
    ctx.font         = '10px monospace';
    ctx.fillStyle    = '#484f58';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    for (const f of [500, 1000, 2000, 3000, 4000]) {
      const x = PAD_L + (f / MAX_FREQ) * plotW;
      ctx.beginPath();
      ctx.moveTo(x, PAD_T); ctx.lineTo(x, PAD_T + plotH);
      ctx.strokeStyle = '#21262d';
      ctx.stroke();
      ctx.fillStyle = '#484f58';
      ctx.fillText(f >= 1000 ? `${f/1000}k` : `${f}`, x, PAD_T + plotH + 4);
    }

    // Y 轴标签
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const y   = PAD_T + plotH - (plotH * i) / 4;
      ctx.fillStyle = '#484f58';
      ctx.fillText(`${i * 25}%`, PAD_L - 4, y);
    }

    // ── 频谱柱 ───────────────────────────────────────────
    if (fft && fft.length > 0) {
      const n    = fft.length;
      const barW = plotW / n;

      // 创建渐变
      const grad = ctx.createLinearGradient(0, PAD_T, 0, PAD_T + plotH);
      grad.addColorStop(0,   '#58a6ff');
      grad.addColorStop(0.6, '#388bfd');
      grad.addColorStop(1,   '#1f6feb');
      ctx.fillStyle = grad;

      for (let i = 0; i < n; i++) {
        const barH = fft[i] * plotH;
        const x    = PAD_L + i * barW;
        const y    = PAD_T + plotH - barH;
        ctx.fillRect(x + 0.5, y, Math.max(barW - 1, 1), barH);
      }
    } else {
      ctx.fillStyle    = '#484f58';
      ctx.font         = '13px "Segoe UI"';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('等待 FFT 数据...', PAD_L + plotW / 2, PAD_T + plotH / 2);
    }

    // ── 基频标注线 ───────────────────────────────────────
    if (voiced && freq > 0 && freq <= MAX_FREQ) {
      const fx = PAD_L + (freq / MAX_FREQ) * plotW;

      ctx.save();
      ctx.strokeStyle = '#f0883e';
      ctx.lineWidth   = 2;
      ctx.setLineDash([4, 3]);
      ctx.shadowColor = '#f0883e';
      ctx.shadowBlur  = 6;
      ctx.beginPath();
      ctx.moveTo(fx, PAD_T);
      ctx.lineTo(fx, PAD_T + plotH);
      ctx.stroke();
      ctx.restore();

      // 音名标签
      const labelX = Math.min(fx + 6, W - PAD_R - 40);
      ctx.font         = 'bold 11px monospace';
      ctx.fillStyle    = '#f0883e';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`${note}  ${freq.toFixed(0)}Hz`, labelX, PAD_T + 4);
    }

    // ── 坐标轴 ───────────────────────────────────────────
    ctx.strokeStyle = '#30363d';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(PAD_L, PAD_T);
    ctx.lineTo(PAD_L, PAD_T + plotH);
    ctx.lineTo(W - PAD_R, PAD_T + plotH);
    ctx.stroke();
  }
}
