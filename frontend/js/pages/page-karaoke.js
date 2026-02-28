/**
 * page-karaoke.js — 跟唱模式页面（全屏）
 *
 * 功能：
 *  - 从 URL hash 参数 id= 读取 job_id
 *  - GET /api/library/{id} 加载歌曲参考音准 + 音频 URL
 *  - 全屏 PitchHistory Canvas（叠加 或 分离 两种对比模式）
 *  - AudioPlayer 控制播放进度，与麦克风实时音准同时展示
 *  - HUD 工具栏：鼠标移动时显示，2s 无操作淡出
 */

import { addListener, removeListener } from '/js/ws-client.js';
import { recordPitch, getHistory }     from '/js/recorder.js';
import { PitchHistory }  from '/js/visualizers/pitch-history.js';
import { SongOverview }  from '/js/visualizers/song-overview.js';
import { AudioPlayer }   from '/js/audio-player.js';
import { currentParams, navigate } from '/js/router.js';

// ── 页面状态 ──────────────────────────────────────────────
let _handler   = null;
let _player    = null;
let _history   = null;
let _overview  = null;
let _hudTimer  = null;
let _rootEl    = null;

// ── 挂载 ─────────────────────────────────────────────────
export async function mount(rootEl) {
  _rootEl = rootEl;

  const params = currentParams();
  const jobId  = params.get('id');

  rootEl.innerHTML = `
<div class="page page-karaoke">
  <!-- HUD（悬浮工具栏，会自动淡出）-->
  <div class="karaoke-hud" id="k-hud">
    <button class="k-btn k-back" id="k-back" title="返回曲库">← 返回</button>
    <div class="k-song-info">
      <span id="k-song-name" class="k-song-name">加载中...</span>
      <span id="k-time" class="k-time">0:00 / 0:00</span>
    </div>
    <div class="k-controls">
      <span class="k-mic-group">
        <label for="k-mic-select" class="k-mic-label" title="选择麦克风">🎙</label>
        <select id="k-mic-select" class="k-mic-select" title="选择麦克风设备">
          <option value="">加载中...</option>
        </select>
      </span>
      <input type="range" id="k-seek" min="0" max="100" value="0" step="0.1" class="k-seek">
      <button class="k-btn k-play" id="k-play" disabled>▶</button>
      <label class="k-chk"><input type="checkbox" id="k-loop"> 循环</label>
      <button class="k-btn" id="k-mode" title="切换叠加/分离对比模式">叠加</button>
      <button class="k-btn" id="k-overview-toggle" title="显示/隐藏全曲概览">总览</button>
    </div>
  </div>

  <!-- 全曲音高概览（可折叠，置于主体上方） -->
  <div class="karaoke-overview-wrap" id="k-overview-wrap" hidden>
    <canvas id="k-canvas-overview"></canvas>
  </div>

  <!-- 主体：PitchHistory 全屏 Canvas -->
  <div class="karaoke-canvas-wrap">
    <canvas id="k-canvas-history"></canvas>
  </div>

  <!-- 加载状态遮罩 -->
  <div class="karaoke-loading" id="k-loading">
    <div class="loading-spinner"></div>
    <div id="k-loading-text">正在加载歌曲数据...</div>
  </div>
</div>`;

  // ── WS 监听 ──────────────────────────────────────────────
  _handler = (msg) => {
    if (msg.type !== 'pitch') return;
    _history?.update(msg);
    recordPitch(msg);
  };
  addListener(_handler);

  // ── 初始化可视化 ─────────────────────────────────────────
  _history  = new PitchHistory(rootEl.querySelector('#k-canvas-history'));
  _overview = new SongOverview(rootEl.querySelector('#k-canvas-overview'));
  _player   = new AudioPlayer();
  _player.onError = (e) => {
    console.error('[AudioPlayer] error', e);
    const loadingTxt = rootEl.querySelector('#k-loading-txt');
    if (loadingTxt) loadingTxt.textContent = '音频加载失败，请检查文件';
  };

  // ── 绑定按钮 ─────────────────────────────────────────────
  rootEl.querySelector('#k-back')?.addEventListener('click', () => navigate('library'));

  const modeBtn = rootEl.querySelector('#k-mode');
  modeBtn?.addEventListener('click', () => {
    const next = _history.compareMode === 'overlay' ? 'split' : 'overlay';
    _history.setCompareMode(next);
    if (modeBtn) modeBtn.textContent = next === 'split' ? '分离' : '叠加';
  });

  const overviewToggle = rootEl.querySelector('#k-overview-toggle');
  const overviewWrap   = rootEl.querySelector('#k-overview-wrap');
  overviewToggle?.addEventListener('click', () => {
    const hidden = overviewWrap?.hasAttribute('hidden');
    if (hidden) overviewWrap?.removeAttribute('hidden');
    else overviewWrap?.setAttribute('hidden', '');
    overviewToggle.classList.toggle('active', !hidden);
  });

  rootEl.querySelector('#k-loop')?.addEventListener('change', (e) => {
    if (_player) _player.loop = e.target.checked;
  });

  // Seek 条
  const seekEl = rootEl.querySelector('#k-seek');
  seekEl?.addEventListener('mousedown', () => { if (seekEl) seekEl._drag = true; });
  seekEl?.addEventListener('touchstart', () => { if (seekEl) seekEl._drag = true; });
  seekEl?.addEventListener('change', () => {
    if (seekEl) seekEl._drag = false;
    const t = parseFloat(seekEl?.value ?? 0);
    _player?.seek(t);
    _syncWallStart(t);
  });

  // 播放按钮
  rootEl.querySelector('#k-play')?.addEventListener('click', _togglePlay);

  // ── HUD 自动淡出 ─────────────────────────────────────────
  const hud = rootEl.querySelector('#k-hud');
  const showHud = () => {
    hud?.classList.remove('hidden');
    clearTimeout(_hudTimer);
    _hudTimer = setTimeout(() => hud?.classList.add('hidden'), 2500);
  };
  rootEl.addEventListener('mousemove', showHud);
  rootEl.addEventListener('touchstart', showHud);
  // 鼠标在 HUD 上不触发淡出
  hud?.addEventListener('mouseenter', () => clearTimeout(_hudTimer));
  hud?.addEventListener('mouseleave', showHud);

  // ── 加载歌曲数据 ─────────────────────────────────────────
  if (jobId) {
    _loadSong(jobId);
  } else {
    // 没有 id 参数，显示错误
    rootEl.querySelector('#k-loading-text').textContent = '未指定歌曲，请从曲库选择';
    setTimeout(() => navigate('library'), 2000);
  }

  // 麦克风设备选择
  _loadDevices(rootEl);

  // 初始显示 HUD
  showHud();
}

// ── 卸载 ─────────────────────────────────────────────────
export function unmount() {
  if (_handler) { removeListener(_handler); _handler = null; }
  if (_player)  { _player.destroy(); _player = null; }
  if (_hudTimer) { clearTimeout(_hudTimer); _hudTimer = null; }
  _history  = null;
  _overview = null;
  _rootEl   = null;
}
// ── 麦克风设备加载与切换 ────────────────────────────────────────

async function _loadDevices(rootEl) {
  const sel = rootEl.querySelector('#k-mic-select');
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
    opt.textContent = (d.is_default ? '★ ' : '') + d.name;
    if (d.is_active) opt.selected = true;
    sel.appendChild(opt);
  }
  if (devices.length === 0) sel.innerHTML = '<option value="">无可用设备</option>';

  sel.addEventListener('change', async () => {
    const deviceId = sel.value === '' ? null : parseInt(sel.value, 10);
    const prev = sel.dataset.prev ?? sel.value;
    sel.disabled = true;
    try {
      const res  = await fetch('/api/device', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: deviceId }),
      });
      const data = await res.json();
      if (data.status !== 'ok') {
        // 切换失败，回滚选项
        sel.value = prev;
      } else {
        sel.dataset.prev = sel.value;
      }
    } catch {
      sel.value = prev;
    } finally {
      sel.disabled = false;
    }
  });
  sel.dataset.prev = sel.value;
}
// ── 加载歌曲 ─────────────────────────────────────────────

async function _loadSong(jobId) {
  const loadingEl  = _rootEl?.querySelector('#k-loading');
  const loadingTxt = _rootEl?.querySelector('#k-loading-text');
  const songNameEl = _rootEl?.querySelector('#k-song-name');
  const playBtn    = _rootEl?.querySelector('#k-play');
  const seekEl     = _rootEl?.querySelector('#k-seek');
  const timeEl     = _rootEl?.querySelector('#k-time');

  try {
    const res  = await fetch(`/api/library/${jobId}`);
    if (!res.ok) throw new Error('歌曲不存在');
    const data = await res.json();

    const pitches  = data.fine_pitches ?? data.coarse_pitches ?? [];
    const duration = data.duration ?? 0;
    const rms      = data.rms ?? [];
    const audioUrl = data.audio_url;
    const songName = data.original_name ?? data.filename ?? '未知歌曲';

    // 设置参考轨
    _history?.setReferenceTrack(pitches);
    _overview?.setSongPitches(pitches, duration, rms);
    _overview?.setMicHistoryRef(getHistory());

    // 显示歌曲名
    if (songNameEl) songNameEl.textContent = songName;

    // 加载音频
    if (loadingTxt) loadingTxt.textContent = '加载音频...';
    await _player.load(audioUrl);

    if (seekEl) seekEl.max = _player.duration.toFixed(1);

    // 绑定播放回调
    _player.onTimeUpdate = (ct, dur) => {
      if (!seekEl?._drag && seekEl) seekEl.value = ct.toFixed(1);
      if (timeEl) timeEl.textContent = `${_fmt(ct)} / ${_fmt(dur)}`;
      _overview?.setViewport(ct, 30);
    };
    _player.onEnded = () => {
      if (playBtn) playBtn.textContent = '▶';
    };

    // 概览 Seek 回调
    _overview.onSeek = (t) => {
      _player?.seek(t);
      if (seekEl) seekEl.value = t.toFixed(1);
      _syncWallStart(t);
    };

    // 启用播放按钮，隐藏 loading 遮罩
    if (playBtn) playBtn.disabled = false;
    loadingEl?.remove();

  } catch (e) {
    if (loadingTxt) loadingTxt.textContent = `加载失败：${e.message}`;
    setTimeout(() => navigate('library'), 2500);
  }
}

// ── 播放控制 ─────────────────────────────────────────────

async function _togglePlay() {
  if (!_player) return;
  const playBtn = _rootEl?.querySelector('#k-play');
  if (_player.paused) {
    await _player.play();
    _syncWallStart(_player.currentTime);
    if (playBtn) playBtn.textContent = '⏸';
  } else {
    _player.pause();
    if (playBtn) playBtn.textContent = '▶';
  }
}

function _syncWallStart(currentSongTime) {
  const wallStart = Date.now() / 1000 - currentSongTime;
  _history?.setPlaybackWallStart(wallStart);
  _overview?.setPlaybackWallStart(wallStart);
}

function _fmt(s) {
  if (!isFinite(s) || s < 0) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
