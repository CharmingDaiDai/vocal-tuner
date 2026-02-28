"""
song_analyzer.py — 歌曲音高分析流水线

支持任意音频格式（通过 librosa/soundfile/audioread 解码）。
当前策略：分段精细 pYIN（每段 30s），逐段推进进度回调，降低长歌曲延迟感知。
"""

import logging
from typing import Callable

import numpy as np
import librosa

logger = logging.getLogger(__name__)

ANALYSIS_SR    = 22050          # 分析用采样率（half of 44100，速度提升 2×）
FMIN           = librosa.note_to_hz("C2")   # ~65 Hz
FMAX           = librosa.note_to_hz("C7")   # ~2093 Hz
# pYIN 参数（hop_length 必须 < frame_length）
FINE_HOP   = 512    # hop（约 23 ms/帧 @ 22050 Hz）
FINE_FRAME = 2048   # frame_length（= 4 × hop）
RMS_HOP    = 512    # RMS 能量曲线 hop
CHUNK_SEC  = 30     # 每段分析长度（秒）—— 分段推进进度


# ── 工具 ──────────────────────────────────────────────────

def _run_pyin_segment(y: np.ndarray, sr: int, offset_sec: float,
                      hop_length: int, frame_length: int) -> list[dict]:
    """
    对一段音频运行 pYIN，返回每帧字典列表，时间戳基于 offset_sec 偏移。
    """
    f0, voiced_flag, _ = librosa.pyin(
        y,
        fmin=FMIN,
        fmax=FMAX,
        sr=sr,
        frame_length=frame_length,
        hop_length=hop_length,
    )

    frames = []
    for i, (freq_raw, voiced) in enumerate(zip(f0, voiced_flag)):
        t        = float(offset_sec + i * hop_length / sr)
        raw_freq = float(freq_raw) if not np.isnan(freq_raw) else 0.0
        v        = bool(voiced) and raw_freq > 0
        freq     = raw_freq if v else 0.0
        midi     = int(round(69 + 12 * np.log2(freq / 440.0))) if v else None

        frames.append({
            "t":      round(t, 4),
            "freq":   round(freq, 3),
            "voiced": v,
            "midi":   midi,
        })

    return frames


def _compute_rms_curve(y: np.ndarray, sr: int, hop: int = RMS_HOP) -> list[float]:
    """返回 RMS 能量曲线（归一化到 0-1）。"""
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    mx  = rms.max()
    return (rms / mx).tolist() if mx > 0 else rms.tolist()


# ── 主分析入口 ────────────────────────────────────────────

def analyze_audio_file(
    filepath: str,
    progress_callback: Callable[[float], None] | None = None,
) -> dict:
    """
    同步分析音频文件（在线程池中调用此函数）。
    按 CHUNK_SEC 秒分段运行 pYIN，每段完成后调用 progress_callback(0.0-1.0)。

    参数：
        filepath:          音频文件路径（支持 mp3/flac/wav/ogg/m4a 等）
        progress_callback: 可选，每段完成后传入当前进度 0.0~1.0

    返回 dict：
        {
          "duration":     float,       # 秒
          "sr":           int,         # 实际采样率
          "fine_pitches": list[dict],  # pYIN 音高帧（hop=512，约 23 ms/帧）
          "rms":          list[float], # RMS 能量曲线（归一化）
        }
    """
    logger.info(f"[SongAnalyzer] 开始加载：{filepath}")

    # ── 加载音频 ──────────────────────────────────────────
    y, sr = librosa.load(filepath, sr=ANALYSIS_SR, mono=True)
    duration = float(len(y) / sr)
    logger.info(f"[SongAnalyzer] 加载完成：{duration:.1f}s，{sr} Hz")

    # ── RMS 曲线（一次性，快速）────────────────────────────
    rms_curve = _compute_rms_curve(y, sr)

    # ── 分段 pYIN ─────────────────────────────────────────
    chunk_samples = int(CHUNK_SEC * sr)
    total_samples = len(y)
    num_chunks    = max(1, int(np.ceil(total_samples / chunk_samples)))
    logger.info(f"[SongAnalyzer] 开始分段 pYIN（{num_chunks} 段，每段 {CHUNK_SEC}s）...")

    all_frames: list[dict] = []
    for i in range(num_chunks):
        start  = i * chunk_samples
        end    = min(start + chunk_samples, total_samples)
        seg    = y[start:end]
        offset = start / sr

        seg_frames = _run_pyin_segment(seg, sr, offset, FINE_HOP, FINE_FRAME)
        all_frames.extend(seg_frames)

        pct = (i + 1) / num_chunks
        logger.info(f"[SongAnalyzer] 进度 {pct*100:.0f}%（段 {i+1}/{num_chunks}）")
        if progress_callback is not None:
            try:
                progress_callback(pct)
            except Exception:
                pass  # 回调失败不中断分析

    logger.info(f"[SongAnalyzer] 分析完成，共 {len(all_frames)} 帧")

    return {
        "duration":     round(duration, 3),
        "sr":           sr,
        "fine_pitches": all_frames,
        "rms":          rms_curve,
    }
