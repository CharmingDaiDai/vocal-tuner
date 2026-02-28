/**
 * recorder.js — 音高历史记录与 CSV 导出
 */

const MAX_RECORDS = 10000;   // 最多保存条数（约 ~460 s）

const _history = [];          // { ts, freq, note_full, cents, voiced }

export function recordPitch(msg) {
  if (!msg.voiced) return;    // 只记录有声帧
  _history.push({
    ts:        msg.ts,
    freq:      msg.freq,
    note_full: msg.note_full ?? '',
    cents:     msg.cents ?? 0,
    confidence:msg.confidence ?? 0,
  });
  if (_history.length > MAX_RECORDS) _history.shift();
}

export function getHistory() { return _history; }

export function clearHistory() { _history.length = 0; }

/** 将历史数据导出为 CSV 并触发浏览器下载 */
export function exportCSV() {
  if (_history.length === 0) {
    alert('暂无数据，请先开始检测。');
    return;
  }

  const header = 'timestamp,freq_hz,note,cents,confidence\n';
  const rows = _history.map(r =>
    `${r.ts.toFixed(3)},${r.freq},${r.note_full},${r.cents},${r.confidence}`
  ).join('\n');

  const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);

  const now = new Date();
  const filename = `pitch-session-${now.toISOString().slice(0,19).replace(/[:]/g, '-')}.csv`;

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
