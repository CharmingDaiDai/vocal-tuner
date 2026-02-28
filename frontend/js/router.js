/**
 * router.js — 轻量级 Hash 路由器
 *
 * 用法：
 *   router.register('home',    homePageModule);
 *   router.register('library', libraryPageModule);
 *   router.navigate('home');
 *
 * 每个页面模块需导出：
 *   export function mount(rootEl)  — 将 HTML 渲染到 rootEl，绑定事件
 *   export function unmount()       — 取消事件监听、停止 rAF、清理状态
 */

const _pages   = {};         // name → { mount, unmount }
let   _current = null;       // 当前页面名
let   _rootEl  = null;       // 挂载容器（由 init() 注入）
let   _onNav   = null;       // 路由切换回调（供侧边栏高亮等外部逻辑使用）

// ── 公共 API ─────────────────────────────────────────────

/** 初始化路由器，指定页面根容器和路由切换回调 */
export function init(rootEl, onNavigate) {
  _rootEl = rootEl;
  _onNav  = onNavigate ?? null;
  window.addEventListener('hashchange', _onHashChange);
}

/** 注册一个页面 */
export function register(name, pageModule) {
  _pages[name] = pageModule;
}

/**
 * 跳转到指定页面（可带可选参数字符串）。
 * 例：navigate('karaoke', 'id=d3d85386')
 * 会产生 URL hash: #karaoke?id=d3d85386
 */
export function navigate(name, params = '') {
  const hash = params ? `#${name}?${params}` : `#${name}`;
  if (location.hash === hash && _current === name) return;
  location.hash = hash;
}

/** 解析当前 hash 的参数部分，返回 URLSearchParams */
export function currentParams() {
  const raw = location.hash.slice(1);   // 去掉 #
  const q   = raw.indexOf('?');
  return new URLSearchParams(q >= 0 ? raw.slice(q + 1) : '');
}

/** 当前页面名 */
export function currentPage() { return _current; }

// ── 内部 ─────────────────────────────────────────────────

function _onHashChange() {
  const raw  = location.hash.slice(1);  // 去掉 #
  const name = raw.split('?')[0] || 'home';
  _activate(name);
}

function _activate(name) {
  if (!_pages[name]) {
    console.warn(`[router] 未注册的页面：${name}，回退到 home`);
    name = 'home';
  }
  if (_current === name) return;

  // 卸载旧页面
  if (_current && _pages[_current]?.unmount) {
    try { _pages[_current].unmount(); } catch (e) { console.error('[router] unmount 异常', e); }
  }

  // 清空容器
  if (_rootEl) _rootEl.innerHTML = '';

  // 挂载新页面
  _current = name;
  if (_pages[name]?.mount) {
    try { _pages[name].mount(_rootEl); } catch (e) { console.error('[router] mount 异常', e); }
  }

  // 通知外部（用于导航栏高亮等）
  _onNav?.(name);
}

/** 启动路由（读取初始 hash 或跳转到默认页） */
export function start(defaultPage = 'home') {
  const raw  = location.hash.slice(1);
  const name = raw.split('?')[0] || defaultPage;
  _activate(name);
}
