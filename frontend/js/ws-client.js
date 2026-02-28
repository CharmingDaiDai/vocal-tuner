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

// 状态 DOM 元素引用（由 index.html 注入）
let _dotEl = null;
let _labelEl = null;
let _statusEl = null;

export function initWsClient({ dotEl, labelEl, statusEl }) {
  _dotEl = dotEl;
  _labelEl = labelEl;
  _statusEl = statusEl;
  _connect();
}

export function addListener(fn) {
  _listeners.push(fn);
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
      // 分发给所有监听者
      for (const fn of _listeners) fn(msg);
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
