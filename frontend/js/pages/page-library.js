/**
 * page-library.js — 音乐分析库页面
 *
 * 功能：
 *  - 展示已分析歌曲的卡片网格（来自 GET /api/library，持久化存储）
 *  - 上传新歌曲 → 轮询分析进度 → 完成后入库并更新卡片
 *  - 每张卡片支持「跟唱」（跳转到 karaoke 页）和「删除」操作
 */

import { navigate } from '/js/router.js';

// key = jobId, value = intervalId  —— 支持多任务并行轮询
const _pending = new Map();
let _rootEl = null;

// ── 挂载 ─────────────────────────────────────────────────────
export function mount(rootEl) {
  _rootEl = rootEl;
  _pending.clear();

  rootEl.innerHTML = `
<div class="page page-library">
  <header class="lib-toolbar">
    <h2 class="page-title">🎵 音乐分析库</h2>
    <div class="lib-actions">
      <label class="btn btn-song" for="lib-file-input" title="支持同时选择多个文件">
        ＋ 上传歌曲
      </label>
      <input type="file" id="lib-file-input" multiple
             accept=".mp3,.flac,.wav,.ogg,.m4a,.aac" style="display:none">
      <span id="lib-analyze-status" class="analyze-status"></span>
    </div>
  </header>

  <div class="lib-content">
    <div id="lib-grid" class="lib-grid">
      <div class="lib-empty">加载中...</div>
    </div>
  </div>
</div>`;

  // 加载已有曲库
  _loadLibrary();

  // 绑定上传按钮
  rootEl.querySelector('#lib-file-input')?.addEventListener('change', _handleUpload);
}

// ── 卸载 ─────────────────────────────────────────────────
export function unmount() {
  for (const tid of _pending.values()) clearInterval(tid);
  _pending.clear();
  _rootEl = null;
}

// ── 加载曲库 ─────────────────────────────────────────────

async function _loadLibrary() {
  const grid = _rootEl?.querySelector('#lib-grid');
  if (!grid) return;

  try {
    const res  = await fetch('/api/library');
    const data = await res.json();
    const songs = data.songs ?? [];
    _renderGrid(grid, songs);
  } catch (e) {
    if (grid) grid.innerHTML = `<div class="lib-empty">加载失败: ${e.message}</div>`;
  }
}

function _renderGrid(grid, songs) {
  if (songs.length === 0) {
    grid.innerHTML = '<div class="lib-empty">还没有分析过的歌曲，点击「上传歌曲」开始</div>';
    return;
  }
  grid.innerHTML = '';
  for (const song of songs) {
    grid.appendChild(_makeCard(song));
  }
}

function _makeCard(song) {
  const dur  = _fmtTime(song.duration);
  const date = song.created_at?.slice(0, 10) ?? '—';
  const name = song.original_name ?? song.filename ?? '未知歌曲';

  const card = document.createElement('div');
  card.className  = 'song-card';
  card.dataset.id = song.job_id;
  card.innerHTML  = `
    <div class="song-card-icon">🎵</div>
    <div class="song-card-info">
      <div class="song-card-name" title="${_esc(name)}">${_esc(name)}</div>
      <div class="song-card-meta">${dur} · ${date}</div>
    </div>
    <div class="song-card-actions">
      <button class="btn btn-karaoke" data-id="${song.job_id}" title="进入跟唱模式">🎤 跟唱</button>
      <button class="btn btn-del"     data-id="${song.job_id}" title="删除">🗑</button>
    </div>`;

  card.querySelector('.btn-karaoke')?.addEventListener('click', (e) => {
    e.stopPropagation();
    navigate('karaoke', `id=${song.job_id}`);
  });
  card.querySelector('.btn-del')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`确定删除「${name}」？此操作不可撤销。`)) return;
    await _deleteCard(song.job_id, card);
  });
  return card;
}

async function _deleteCard(jobId, cardEl) {
  try {
    const res = await fetch(`/api/library/${jobId}`, { method: 'DELETE' });
    if (res.ok) {
      cardEl.classList.add('removing');
      cardEl.addEventListener('transitionend', () => {
        cardEl.remove();
        // 如果网格空了，显示提示
        const grid = _rootEl?.querySelector('#lib-grid');
        if (grid && grid.querySelectorAll('.song-card').length === 0) {
          grid.innerHTML = '<div class="lib-empty">还没有分析过的歌曲，点击「上传歌曲」开始</div>';
        }
      }, { once: true });
    }
  } catch (e) {
    alert(`删除失败: ${e.message}`);
  }
}

// ── 上传与分析 ────────────────────────────────────────────

/** 文件选择回调 — 逐一启动独立上传流程 */
async function _handleUpload(e) {
  const files = Array.from(e.target.files);
  e.target.value = '';
  if (!files.length) return;
  for (const file of files) _uploadOne(file);
}

/** 单个文件的完整上传→分析→卡片更新流程 */
async function _uploadOne(file) {
  const statusEl = _rootEl?.querySelector('#lib-analyze-status');

  const fd = new FormData();
  fd.append('file', file);

  let jobId, audioUrl, originalName;
  try {
    const res  = await fetch('/api/analyze', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail ?? '上传失败');
    jobId        = data.job_id;
    audioUrl     = data.audio_url;
    originalName = data.original_name;
  } catch (err) {
    _setStatus(statusEl, 'error', `⚠ ${file.name}: ${err.message}`);
    return;
  }

  // 在网格顶部插入占位卡片
  const grid = _rootEl?.querySelector('#lib-grid');
  const placeholder = _makePendingCard(jobId, originalName ?? file.name);
  grid?.querySelector('.lib-empty')?.remove();
  grid?.prepend(placeholder);

  // 每个任务独立定时器，存入 Map
  const tid = setInterval(
    () => _pollJob(jobId, audioUrl, originalName, placeholder, statusEl),
    1000,
  );
  _pending.set(jobId, tid);
  _updateStatusEl(statusEl);
}

async function _pollJob(jobId, audioUrl, originalName, placeholder, statusEl) {
  if (!_pending.has(jobId)) return; // 已在 unmount 时清除
  let data;
  try {
    const res = await fetch(`/api/analyze/${jobId}`);
    data = await res.json();
  } catch { return; }

  if (data.status === 'error') {
    clearInterval(_pending.get(jobId));
    _pending.delete(jobId);
    placeholder?.remove();
    _updateStatusEl(statusEl);
    return;
  }

  if (data.status === 'done') {
    clearInterval(_pending.get(jobId));
    _pending.delete(jobId);
    const song = {
      job_id:        data.job_id,
      original_name: data.original_name ?? originalName,
      filename:      data.filename,
      duration:      data.duration,
      created_at:    data.created_at ?? new Date().toISOString().slice(0, 10),
      audio_url:     audioUrl,
    };
    placeholder?.replaceWith(_makeCard(song));
    _updateStatusEl(statusEl);
  } else if (data.status === 'analyzing') {
    // 分段进度：更新占位卡片的进度文字
    const pct = data.progress ?? 0;
    const metaEl = placeholder?.querySelector('.song-card-meta');
    if (metaEl) metaEl.textContent = pct > 0 ? `分析中 ${Math.round(pct * 100)}%` : '正在分析...';
  }
}

function _updateStatusEl(statusEl) {
  if (!statusEl) return;
  const n = _pending.size;
  _setStatus(statusEl, n ? 'analyzing' : '', n ? `分析中（${n} 首）...` : '');
}

function _makePendingCard(jobId, name) {
  const card = document.createElement('div');
  card.className  = 'song-card song-card--pending';
  card.dataset.id = jobId;
  card.innerHTML  = `
    <div class="song-card-icon pending-spin">⏳</div>
    <div class="song-card-info">
      <div class="song-card-name" title="${_esc(name)}">${_esc(name)}</div>
      <div class="song-card-meta">正在分析...</div>
    </div>
    <div class="song-card-actions">
      <button class="btn" disabled>🎤 跟唱</button>
      <button class="btn btn-del" disabled>🗑</button>
    </div>`;
  return card;
}

// ── 工具函数 ─────────────────────────────────────────────

function _fmtTime(s) {
  if (!s || !isFinite(s)) return '—';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function _setStatus(el, cls, text) {
  if (!el) return;
  el.textContent = text;
  el.className   = `analyze-status${cls ? ` ${cls}` : ''}`;
}
