"""
session_store.py — 练习会话的文件系统持久化层

每次练习会话存储在 sessions/ 目录下：
  sessions/{session_id}.json      ← 完整数据（含 frames）
  sessions/{session_id}.meta.json ← 仅元数据（快速列表查询）
  sessions/{session_id}.wav       ← 可选：录音文件

接口：
  store.save(session_id, meta, frames) → 写盘
  store.load(session_id)               → 读完整数据
  store.list_all()                     → 元数据列表（不含 frames）
  store.delete(session_id)             → 删除 json + meta + wav
  store.exists(session_id)             → 是否存在
"""

import json
import logging
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)


class SessionStore:
    """基于文件系统的练习会话持久化。"""

    def __init__(self, store_dir: Path):
        self._dir = store_dir
        self._dir.mkdir(exist_ok=True, parents=True)

    # ── 写入 ────────────────────────────────────────────────

    def save(self, session_id: str, meta: dict, frames: list[dict]) -> None:
        """
        保存会话。
        meta 字段：name, song_job_id（可选）, duration, frame_count, created_at
        frames: PitchPoint 列表（已过滤 voiced=True）
        """
        now = datetime.now().isoformat(timespec="seconds")
        full_meta = {
            "session_id":  session_id,
            "name":        meta.get("name") or f"练习 {now[:10]}",
            "song_job_id": meta.get("song_job_id"),       # None 表示自由练习
            "duration":    meta.get("duration", 0.0),
            "frame_count": len(frames),
            "created_at":  meta.get("created_at", now),
            "has_audio":   meta.get("has_audio", False),  # 是否有 WAV 录音
        }

        payload = {**full_meta, "frames": frames}

        full_path = self._dir / f"{session_id}.json"
        with full_path.open("w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

        meta_path = self._dir / f"{session_id}.meta.json"
        with meta_path.open("w", encoding="utf-8") as f:
            json.dump(full_meta, f, ensure_ascii=False, separators=(",", ":"))

        logger.info(
            f"[SessionStore] 已保存会话 {session_id}（{len(frames)} 帧，"
            f"{full_path.stat().st_size // 1024} KB）"
        )

    # ── 读取 ────────────────────────────────────────────────

    def load(self, session_id: str) -> dict | None:
        """读取完整会话数据（含 frames）。"""
        path = self._dir / f"{session_id}.json"
        if not path.exists():
            return None
        with path.open(encoding="utf-8") as f:
            return json.load(f)

    def list_all(self) -> list[dict]:
        """返回所有会话的元数据列表（按 created_at 倒序）。"""
        results: list[dict] = []
        seen: set[str] = set()

        for p in sorted(self._dir.glob("*.meta.json"),
                        key=lambda x: x.stat().st_mtime, reverse=True):
            sid = p.stem.replace(".meta", "")
            seen.add(sid)
            try:
                with p.open(encoding="utf-8") as f:
                    meta = json.load(f)
                results.append(meta)
            except Exception as e:
                logger.warning(f"[SessionStore] 跳过损坏文件 {p.name}：{e}")

        results.sort(key=lambda x: x.get("created_at") or "", reverse=True)
        return results

    # ── 删除 ────────────────────────────────────────────────

    def delete(self, session_id: str) -> bool:
        """删除会话所有相关文件（json + meta + wav），返回是否成功。"""
        json_path = self._dir / f"{session_id}.json"
        meta_path = self._dir / f"{session_id}.meta.json"
        wav_path  = self._dir / f"{session_id}.wav"

        if not json_path.exists() and not meta_path.exists():
            return False

        for p in (json_path, meta_path, wav_path):
            if p.exists():
                p.unlink()

        logger.info(f"[SessionStore] 已删除会话 {session_id}")
        return True

    # ── 查询 ────────────────────────────────────────────────

    def exists(self, session_id: str) -> bool:
        return (self._dir / f"{session_id}.json").exists()

    def wav_path(self, session_id: str) -> Path:
        """返回该会话 WAV 文件路径（无论是否存在）。"""
        return self._dir / f"{session_id}.wav"
