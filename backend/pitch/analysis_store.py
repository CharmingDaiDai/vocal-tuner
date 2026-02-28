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
        """将分析结果序列化并写入 {job_id}.json。"""
        path = self._dir / f"{job_id}.json"
        payload = {
            "job_id":         job_id,
            "original_name":  data.get("original_name"),
            "filename":       data.get("filename"),
            "duration":       data.get("duration"),
            "sr":             data.get("sr", 22050),
            "created_at":     data.get("created_at", datetime.now().isoformat(timespec="seconds")),
            "rms":            data.get("rms"),
            "coarse_pitches": data.get("coarse_pitches"),
            "fine_pitches":   data.get("fine_pitches"),
        }
        with path.open("w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        logger.info(f"[Store] 已保存 {job_id}.json（{path.stat().st_size // 1024} KB）")

    # ── 读取 ────────────────────────────────────────────────

    def load(self, job_id: str) -> dict | None:
        """读取完整数据（含 pitches）。"""
        path = self._dir / f"{job_id}.json"
        if not path.exists():
            return None
        with path.open(encoding="utf-8") as f:
            return json.load(f)

    def list_all(self) -> list[dict]:
        """扫描目录，返回所有已保存歌曲的元数据列表（按创建时间倒序，不含 pitches）。"""
        results = []
        for p in sorted(self._dir.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
            try:
                with p.open(encoding="utf-8") as f:
                    data = json.load(f)
                results.append({
                    "job_id":        data.get("job_id", p.stem),
                    "original_name": data.get("original_name"),
                    "filename":      data.get("filename"),
                    "duration":      data.get("duration"),
                    "created_at":    data.get("created_at"),
                    "audio_url":     f"/uploads/{data.get('filename', '')}",
                })
            except Exception as e:
                logger.warning(f"[Store] 跳过损坏文件 {p.name}：{e}")
        return results

    # ── 删除 ────────────────────────────────────────────────

    def delete(self, job_id: str, upload_dir: Path) -> bool:
        """删除 json 文件及对应的音频文件，返回是否成功。"""
        json_path = self._dir / f"{job_id}.json"
        if not json_path.exists():
            return False
        # 尝试删除音频文件
        try:
            with json_path.open(encoding="utf-8") as f:
                data = json.load(f)
            filename = data.get("filename", "")
            if filename:
                audio_path = upload_dir / filename
                if audio_path.exists():
                    audio_path.unlink()
                    logger.info(f"[Store] 已删除音频 {filename}")
        except Exception as e:
            logger.warning(f"[Store] 删除音频失败（{job_id}）：{e}")
        # 删除 json
        json_path.unlink()
        logger.info(f"[Store] 已删除记录 {job_id}")
        return True

    # ── 查询 ────────────────────────────────────────────────

    def exists(self, job_id: str) -> bool:
        return (self._dir / f"{job_id}.json").exists()
