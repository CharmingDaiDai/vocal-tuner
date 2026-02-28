/**
 * page-home.js — 实时音准检测页面
 *
 * 复用现有四个可视化模块（调音表、音高历史、钢琴、FFT）。
 * WebSocket 连接由 ws-client 单例维护，此页面只注册/注销监听器。
 */

import {
  addListener, removeListener, updateStatusEls,
  sendPause, sendResume, isPaused,
} from '/js/ws-client.js';
import { recordPitch, exportCSV, getHistory } from '/js/recorder.js';
import { NeedleMeter }  from '/js/visualizers/needle-meter.js';
import { PitchHistory } from '/js/visualizers/pitch-history.js';
import { Piano }        from '/js/visualizers/piano.js';
import { FftSpectrum }  from '/js/visualizers/fft-spectrum.js';

// ── 页面内部状态 ──────────────────────────────────────────
let _handler   = null;   // WS 监听器句柄
let _instances = null;   // { needle, history, piano, fft }
let _started   = false;

// ── 挂载 ─────────────────────────────────────────────────
export function mount(rootEl) {
  _started = false;

  rootEl.innerHTML = `
<div class="page page-home">
  <!-- 顶部工具栏 -->
  <header class="ph-header">
    <div class="ctrl-group">
      <div class="conn-dot" id="conn-dot"></div>
      <span id="conn-label" class="text-muted small">连接中...</span>
    </div>
    <div class="ctrl-group" id="device-group">
      <label for="mic-select" class="text-muted small" style="white-space:nowrap">🎧 麦克风</label>
      <select id="mic-select" class="mic-select" title="选择麦克风设备">
        <option value="">加载中...</option>
      </select>
      <span id="device-status" class="device-status"></span>
    </div>
    <div class="ctrl-group">
      <button class="btn btn-start"  id="btn-start"  title="开始采集">▶ 开始</button>
      <button class="btn btn-pause"  id="btn-pause"  title="暂停采集" disabled>⏸ 暂停</button>
      <button class="btn btn-export" id="btn-export" title="导出 CSV">💾 导出 CSV</button>
    </div>
  </header>

  <!-- 四面板主区 -->
  <main class="ph-main">
    <!-- 面板 1：指针调音表（左列，跨两行）-->
    <div class="panel" style="grid-row: 1 / 3;">
      <div class="panel-title">调音表 · 实时音准</div>
      <canvas id="canvas-needle"></canvas>
    </div>

    <!-- 面板 2：音高历史时间轴 -->
    <div class="panel" id="panel-history">
      <div class="panel-title">
        音高历史 · 30 秒
        <span class="panel-tools">
          <button class="panel-btn" id="btn-zoom-in"    title="放大音域（滚轮可缩放）">＋</button>
          <button class="panel-btn" id="btn-zoom-out"   title="缩小音域">－</button>
          <button class="panel-btn" id="btn-zoom-reset" title="重置缩放">⊡</button>
          <button class="panel-btn active" id="btn-style"  title="切换风格：点线 / 柱状">点线</button>
          <button class="panel-btn active" id="btn-follow" title="自动跟随音高">跟随</button>
          <button class="panel-btn"        id="btn-expand" title="全屏展开">⛶</button>
        </span>
      </div>
      <canvas id="canvas-history"></canvas>
    </div>

    <!-- 面板 3：钢琴 + FFT（右列下方）-->
    <div class="panel" style="display:grid;grid-template-rows:auto 1fr;">
      <div class="panel-title">钢琴键盘 · C3–B5</div>
      <div style="display:grid;grid-template-rows:55% 45%;min-height:0;height:100%;">
        <canvas id="canvas-piano"></canvas>
        <div style="border-top:1px solid var(--border);display:flex;flex-direction:column;min-height:0;">
          <div class="panel-title" style="border:none;padding-top:6px;">FFT 频谱</div>
          <canvas id="canvas-fft" style="flex:1;min-height:0;"></canvas>
        </div>
      </div>
    </div>
  </main>

  <!-- 状态栏 -->
  <footer class="ph-footer">
    <span>采样率: 44100 Hz</span>
    <span id="status-text">等待连接...</span>
    <span id="fps-text" style="margin-left:auto;"></span>
  </footer>
</div>`;

  // ── 初始化可视化模块 ────────────────────────────────────
  const needle  = new NeedleMeter (rootEl.querySelector('#canvas-needle'));
  const history = new PitchHistory(rootEl.querySelector('#canvas-history'));
  const piano   = new Piano       (rootEl.querySelector('#canvas-piano'));
  const fft     = new FftSpectrum (rootEl.querySelector('#canvas-fft'));
  _instances = { needle, history, piano, fft };

  // ── 注册 WS 监听器 ──────────────────────────────────────
  const fpsEl = rootEl.querySelector('#fps-text');
  let _frameCount = 0, _lastFpsTick = Date.now();

  _handler = (msg) => {
    if (msg.type !== 'pitch') return;
    _frameCount++;
    const now = Date.now();
    if (now - _lastFpsTick >= 1000) {
      if (fpsEl) fpsEl.textContent = `${_frameCount} msg/s`;
      _frameCount = 0; _lastFpsTick = now;
    }
    needle .update(msg);
    history.update(msg);
    piano  .update(msg);
    fft    .update(msg);
    recordPitch(msg);
    const statusEl = rootEl.querySelector('#status-text');
    if (statusEl) {
      statusEl.textContent = msg.voiced
        ? `音符: ${msg.note_full}  频率: ${msg.freq?.toFixed(1)} Hz  偏差: ${msg.cents >= 0 ? '+' : ''}${msg.cents?.toFixed(1)}¢  置信度: ${(msg.confidence * 100).toFixed(0)}%`
        : '静音 / 未检出音高';
    }
  };
  addListener(_handler);

  // ── 绑定 WS 状态显示元素 ────────────────────────────────
  updateStatusEls({
    dotEl:    rootEl.querySelector('#conn-dot'),
    labelEl:  rootEl.querySelector('#conn-label'),
    statusEl: rootEl.querySelector('#status-text'),
  });

  // ── 按钮逻辑 ───────────────────────────────────────────
  const btnStart  = rootEl.querySelector('#btn-start');
  const btnPause  = rootEl.querySelector('#btn-pause');
  const btnExport = rootEl.querySelector('#btn-export');

  btnStart.addEventListener('click', async () => {
    if (!_started) {
      await sendResume();
      _started = true;
      btnStart.disabled = true;
      btnPause.disabled = false;
      history.setPaused(false);
    }
  });

  btnPause.addEventListener('click', async () => {
    if (!isPaused()) {
      await sendPause();
      btnPause.textContent = '▶ 恢复';
      btnPause.classList.replace('btn-pause', 'btn-start');
      history.setPaused(true);
    } else {
      await sendResume();
      btnPause.textContent = '⏸ 暂停';
      btnPause.classList.replace('btn-start', 'btn-pause');
      history.setPaused(false);
    }
  });

  btnExport?.addEventListener('click', () => exportCSV());

  // ── 麦克风设备选择 ─────────────────────────────────────
  _loadDevices(rootEl);

  // ── 音高历史工具栏 ─────────────────────────────────────
  const panelHistory = rootEl.querySelector('#panel-history');

  rootEl.querySelector('#btn-zoom-in')   ?.addEventListener('click', () => history.zoomIn());
  rootEl.querySelector('#btn-zoom-out')  ?.addEventListener('click', () => history.zoomOut());
  rootEl.querySelector('#btn-zoom-reset')?.addEventListener('click', () => history.resetZoom());

  const btnStyle  = rootEl.querySelector('#btn-style');
  const btnFollow = rootEl.querySelector('#btn-follow');

  btnStyle?.addEventListener('click', () => {
    const style = history.toggleStyle();
    btnStyle.textContent = style === 'bar' ? '柱状' : '点线';
    btnStyle.classList.add('active');
  });

  btnFollow?.addEventListener('click', () => {
    const next = !history.autoFollow;
    history.setAutoFollow(next);
    btnFollow?.classList.toggle('active', next);
  });

  rootEl.querySelector('#btn-expand')?.addEventListener('click', () => {
    const isExpanded = panelHistory?.classList.toggle('expanded');
    if (isExpanded) {
      const onEsc = (e) => {
        if (e.key === 'Escape') {
          panelHistory.classList.remove('expanded');
          document.removeEventListener('keydown', onEsc);
        }
      };
      document.addEventListener('keydown', onEsc);
    }
  });
}

// ── 卸载 ─────────────────────────────────────────────────
export function unmount() {
  if (_handler) {
    removeListener(_handler);
    _handler = null;
  }
  // 清除 WS 状态元素引用
  updateStatusEls({});
  _instances = null;
  _started   = false;
}

// ── 内部辅助 ─────────────────────────────────────────────

async function _loadDevices(rootEl) {
  const sel    = rootEl.querySelector('#mic-select');
  const status = rootEl.querySelector('#device-status');
  if (!sel) return;
  let devices = [];
  try {
    const res  = await fetch('/api/devices');
    const data = await res.json();
    devices = data.devices ?? [];
  } catch {
    sel.innerHTML = '<option value="">获取失败</option>';
    return;
  }
  sel.innerHTML = '';
  for (const d of devices) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = (d.is_default ? '★ ' : '') + d.name + (d.channels > 1 ? ` (${d.channels}ch)` : '');
    if (d.is_active) opt.selected = true;
    sel.appendChild(opt);
  }
  if (devices.length === 0) sel.innerHTML = '<option value="">无可用设备</option>';

  sel.addEventListener('change', async () => {
    const deviceId = sel.value === '' ? null : parseInt(sel.value, 10);
    if (status) { status.textContent = '切换中...'; status.className = 'device-status switching'; }
    sel.disabled = true;
    try {
      const res  = await fetch('/api/device', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: deviceId }),
      });
      const data = await res.json();
      if (status) {
        status.textContent = data.status === 'ok' ? `✓ ${data.device_name}` : `⚠ ${data.message}`;
        status.className   = `device-status ${data.status === 'ok' ? 'ok' : 'err'}`;
      }
    } catch {
      if (status) { status.textContent = '⚠ 请求失败'; status.className = 'device-status err'; }
    } finally {
      sel.disabled = false;
      setTimeout(() => { if (status) { status.textContent = ''; status.className = 'device-status'; } }, 3000);
    }
  });
}
