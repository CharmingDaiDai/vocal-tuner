"""
analysis_store.py — 歌曲分析结果的文件系统持久化层

每首歌在 uploads/ 目录下存一个 {job_id}.json 文件：
  uploads/{job_id}.json  ← 元数据 + pitches + rms
  uploads/{job_id}.flac  ← 原始音频（由上传流程保存）

接口：
  store.save(job_id, data)         → 写盘
  store.load(job_id)               → 读完整数据（含 pitches）
  store.list_all()                 → 所有歌曲元数据（不含 pitches）
  store.delete(job_id, upload_dir) → 删除 json + 音频
  store.exists(job_id)             → 是否存在
"""

import json
import logging
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)


class AnalysisStore:
    """基于文件系统的分析结果持久化。"""

    def __init__(self, store_dir: Path):
        self._dir = store_dir
        self._dir.mkdir(exist_ok=True, parents=True)

    # ── 写入 ────────────────────────────────────────────────

    def save(self, job_id: str, data: dict) -> None:
        """将分析结果写入两个文件：
        - {job_id}.json      完整数据（含 fine_pitches），用于跟唱模式加载
        - {job_id}.meta.json 仅元数据（无 pitches），用于快速列表查询
        """
        meta = {
            "job_id":        job_id,
            "original_name": data.get("original_name"),
            "filename":      data.get("filename"),
            "duration":      data.get("duration"),
            "sr":            data.get("sr", 22050),
            "created_at":    data.get("created_at", datetime.now().isoformat(timespec="seconds")),
        }
        payload = {
            **meta,
            "rms":          data.get("rms"),
            "fine_pitches": data.get("fine_pitches"),
        }

        # 先写完整数据文件
        full_path = self._dir / f"{job_id}.json"
        with full_path.open("w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

        # 再写轻量元数据文件（极小，list_all 只读这个）
        meta_path = self._dir / f"{job_id}.meta.json"
        with meta_path.open("w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, separators=(",", ":"))

        logger.info(f"[Store] 已保存 {job_id}（{full_path.stat().st_size // 1024} KB）")

    # ── 读取 ────────────────────────────────────────────────

    def load(self, job_id: str) -> dict | None:
        """读取完整数据（含 pitches）。"""
        path = self._dir / f"{job_id}.json"
        if not path.exists():
            return None
        with path.open(encoding="utf-8") as f:
            return json.load(f)

    def list_all(self) -> list[dict]:
        """扫描 *.meta.json 返回元数据列表（按 mtime 倒序，不含 pitches）。
        对没有 meta 文件的旧数据自动降级读取完整 json（迁移兼容）。
        """
        results = []
        seen: set[str] = set()

        # 优先读轻量 meta 文件
        for p in sorted(self._dir.glob("*.meta.json"),
                        key=lambda x: x.stat().st_mtime, reverse=True):
            job_id = p.stem.replace(".meta", "")
            seen.add(job_id)
            try:
                with p.open(encoding="utf-8") as f:
                    meta = json.load(f)
                results.append({
                    "job_id":        meta.get("job_id", job_id),
                    "original_name": meta.get("original_name"),
                    "filename":      meta.get("filename"),
                    "duration":      meta.get("duration"),
                    "created_at":    meta.get("created_at"),
                    "audio_url":     f"/uploads/{meta.get('filename', '')}",
                })
            except Exception as e:
                logger.warning(f"[Store] 跳过损坏文件 {p.name}：{e}")

        # 兼容旧数据：只有 .json 没有 .meta.json 的条目
        for p in sorted(self._dir.glob("*.json"),
                        key=lambda x: x.stat().st_mtime, reverse=True):
            if p.stem in seen:
                continue
            try:
                with p.open(encoding="utf-8") as f:
                    data = json.load(f)
                job_id = data.get("job_id", p.stem)
                if job_id in seen:
                    continue
                seen.add(job_id)
                results.append({
                    "job_id":        job_id,
                    "original_name": data.get("original_name"),
                    "filename":      data.get("filename"),
                    "duration":      data.get("duration"),
                    "created_at":    data.get("created_at"),
                    "audio_url":     f"/uploads/{data.get('filename', '')}",
                })
                # 顺手生成 meta 文件，之后就不用再读大文件了
                self._write_meta(job_id, data)
            except Exception as e:
                logger.warning(f"[Store] 跳过损坏文件 {p.name}：{e}")

        # 按 created_at 倒序（meta 文件已按 mtime 排序，混合列表再统一排一次）
        results.sort(key=lambda x: x.get("created_at") or "", reverse=True)
        return results

    def _write_meta(self, job_id: str, data: dict) -> None:
        """写入 meta 文件（供迁移使用）。"""
        try:
            meta = {
                "job_id":        job_id,
                "original_name": data.get("original_name"),
                "filename":      data.get("filename"),
                "duration":      data.get("duration"),
                "sr":            data.get("sr", 22050),
                "created_at":    data.get("created_at"),
            }
            meta_path = self._dir / f"{job_id}.meta.json"
            with meta_path.open("w", encoding="utf-8") as f:
                json.dump(meta, f, ensure_ascii=False, separators=(",", ":"))
        except Exception as e:
            logger.warning(f"[Store] 写入 meta 文件失败（{job_id}）：{e}")

    # ── 删除 ────────────────────────────────────────────────

    def delete(self, job_id: str, upload_dir: Path) -> bool:
        """删除 json、meta.json 及对应的音频文件，返回是否成功。"""
        json_path = self._dir / f"{job_id}.json"
        meta_path = self._dir / f"{job_id}.meta.json"
        if not json_path.exists() and not meta_path.exists():
            return False
        # 尝试删除音频文件
        try:
            src = json_path if json_path.exists() else meta_path
            with src.open(encoding="utf-8") as f:
                data = json.load(f)
            filename = data.get("filename", "")
            if filename:
                audio_path = upload_dir / filename
                if audio_path.exists():
                    audio_path.unlink()
                    logger.info(f"[Store] 已删除音频 {filename}")
        except Exception as e:
            logger.warning(f"[Store] 删除音频失败（{job_id}）：{e}")
        # 删除 json 和 meta
        for p in (json_path, meta_path):
            if p.exists():
                p.unlink()
        logger.info(f"[Store] 已删除记录 {job_id}")
        return True

    # ── 查询 ────────────────────────────────────────────────

    def exists(self, job_id: str) -> bool:
        return (self._dir / f"{job_id}.json").exists() or \
               (self._dir / f"{job_id}.meta.json").exists()
