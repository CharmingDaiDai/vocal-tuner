/**
 * audio-player.js — <audio> 元素封装，驱动参考轨时间同步
 *
 * 用法：
 *   const player = new AudioPlayer();
 *   player.onTimeUpdate = (currentTime, duration) => { ... };
 *   await player.load('/uploads/xxx.mp3');
 *   player.play();
 */

export class AudioPlayer {
  constructor() {
    this._el      = new Audio();
    this._el.crossOrigin = 'anonymous';
    this._rafId   = null;
    this._url     = null;

    // 公共回调
    this.onTimeUpdate = null;   // (currentTime: number, duration: number) => void
    this.onEnded      = null;   // () => void
    this.onError      = null;   // (err) => void

    this._el.addEventListener('ended', () => {
      this._stopRaf();
      this.onEnded?.();
    });
    this._el.addEventListener('error', (e) => {
      this.onError?.(e);
    });
  }

  /** 加载音频 URL，返回 Promise（元数据加载完成后 resolve）  */
  load(url) {
    return new Promise((resolve, reject) => {
      this._url    = url;
      this._el.src = url;
      this._el.load();
      const onMeta = () => {
        this._el.removeEventListener('loadedmetadata', onMeta);
        this._el.removeEventListener('error', onErr);
        resolve(this._el.duration);
      };
      const onErr = (e) => {
        this._el.removeEventListener('loadedmetadata', onMeta);
        this._el.removeEventListener('error', onErr);
        reject(e);
      };
      this._el.addEventListener('loadedmetadata', onMeta);
      this._el.addEventListener('error', onErr);
    });
  }

  play() {
    this._el.play().catch(() => {});
    this._startRaf();
  }

  pause() {
    this._el.pause();
    this._stopRaf();
  }

  stop() {
    this._el.pause();
    this._el.currentTime = 0;
    this._stopRaf();
    this.onTimeUpdate?.(0, this._el.duration || 0);
  }

  seek(t) {
    this._el.currentTime = Math.max(0, Math.min(t, this._el.duration || 0));
    this.onTimeUpdate?.(this._el.currentTime, this._el.duration || 0);
  }

  get currentTime() { return this._el.currentTime; }
  get duration()    { return this._el.duration || 0; }
  get paused()      { return this._el.paused; }

  /** 循环播放 */
  set loop(v) { this._el.loop = v; }
  get loop()   { return this._el.loop; }

  /** 音量 [0,1] */
  set volume(v) { this._el.volume = Math.max(0, Math.min(1, v)); }
  get volume()  { return this._el.volume; }

  // ── 内部：rAF 定时广播当前时间 ────────────────────────

  _startRaf() {
    if (this._rafId) return;
    const tick = () => {
      if (!this._el.paused) {
        this.onTimeUpdate?.(this._el.currentTime, this._el.duration || 0);
        this._rafId = requestAnimationFrame(tick);
      } else {
        this._rafId = null;
      }
    };
    this._rafId = requestAnimationFrame(tick);
  }

  _stopRaf() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  destroy() {
    this._stopRaf();
    this._el.pause();
    this._el.src = '';
  }
}
