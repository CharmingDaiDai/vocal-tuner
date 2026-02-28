/**
 * ws-client.js — WebSocket 连接管理，支持自动重连（指数退避）
 * 将收到的数据通过事件分发给各可视化模块。
 */

const WS_URL = `ws://${location.host}/ws/pitch`;

let _ws = null;
let _retryDelay = 1000;
let _retryTimer = null;
let _paused = false;
let _listeners = [];

// rAF 节流：onmessage 只缓存最新消息，rAF 统一分发，避免消息速率超越帧率时多余 DOM 写入
let _pendingMsg = null;
let _rafId = null;

function _rafDispatch() {
  if (_pendingMsg !== null) {
    const msg = _pendingMsg;
    _pendingMsg = null;
    for (const fn of _listeners) fn(msg);
  }
  _rafId = requestAnimationFrame(_rafDispatch);
}
// 启动持续 rAF 循环（模块加载时开始，全生命周期运行）
_rafId = requestAnimationFrame(_rafDispatch);

// 状态 DOM 元素引用（由 index.html 注入）
let _dotEl = null;
let _labelEl = null;
let _statusEl = null;

export function initWsClient({ dotEl, labelEl, statusEl } = {}) {
  _dotEl   = dotEl   ?? null;
  _labelEl = labelEl ?? null;
  _statusEl = statusEl ?? null;
  if (!_ws) _connect();  // 只建立一次连接
}

/** 动态更新状态 DOM 元素引用（页面切换时使用） */
export function updateStatusEls({ dotEl, labelEl, statusEl } = {}) {
  _dotEl    = dotEl    ?? null;
  _labelEl  = labelEl  ?? null;
  _statusEl = statusEl ?? null;
  // 如果已连接，立即更新显示状态
  if (_dotEl && _ws?.readyState === WebSocket.OPEN) {
    _setDot('connected');
    _setStatus('recording', _paused ? '已暂停' : '实时采集中');
  }
}

export function addListener(fn) {
  _listeners.push(fn);
  return fn;  // 返回函数自身作为句柄
}

export function removeListener(fn) {
  const idx = _listeners.indexOf(fn);
  if (idx !== -1) _listeners.splice(idx, 1);
}

export function isPaused() { return _paused; }

/** 发送暂停请求到后端 REST */
export async function sendPause() {
  await fetch('/api/pause', { method: 'POST' });
  _paused = true;
  _setStatus('paused', '已暂停');
}

/** 发送恢复请求到后端 REST */
export async function sendResume() {
  await fetch('/api/resume', { method: 'POST' });
  _paused = false;
  _setStatus('recording', '实时采集中');
}

// ── 内部 ────────────────────────────────────────────────

function _connect() {
  _setDot('connecting');
  try {
    _ws = new WebSocket(WS_URL);
  } catch (e) {
    _scheduleRetry();
    return;
  }

  _ws.onopen = () => {
    _retryDelay = 1000;
    _setDot('connected');
    _setStatus('recording', '实时采集中');
    console.log('[ws-client] 已连接');
  };

  _ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'status') {
        _paused = msg.state === 'paused';
        _setStatus(msg.state, _paused ? '已暂停' : '实时采集中');
        return;
      }
      if (msg.type === 'heartbeat') return;
      // 仅缓存最新消息，由 rAF 循环在下一帧统一分发，避免超帧率多余调度
      _pendingMsg = msg;
    } catch (_) {}
  };

  _ws.onerror = () => {};

  _ws.onclose = () => {
    _setDot('disconnected');
    _setStatus('disconnected', '连接断开，重试中...');
    _scheduleRetry();
  };
}

function _scheduleRetry() {
  if (_retryTimer) return;
  _retryTimer = setTimeout(() => {
    _retryTimer = null;
    _connect();
  }, _retryDelay);
  _retryDelay = Math.min(_retryDelay * 1.5, 10000);
}

function _setDot(state) {
  if (!_dotEl) return;
  _dotEl.className = 'conn-dot ' + state;
  if (_labelEl) {
    _labelEl.textContent = state === 'connected' ? '已连接'
      : state === 'connecting' ? '连接中...' : '已断开';
  }
}

function _setStatus(state, text) {
  if (_statusEl) _statusEl.textContent = text;
}
