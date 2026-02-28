"""
song_analyzer.py — 歌曲音高分析流水线

支持任意音频格式（通过 librosa/soundfile/audioread 解码）。
采用两轮策略：
  1. 粗分析（Coarse）~3-8 s：hop_length=4096，约 185 ms/帧精度
     → 完成后立即通知前端可以开始播放
  2. 精细化（Fine）后台继续，~15-60 s：hop_length=512，约 23 ms/帧精度
     → 完成后替换粗数据
"""

import logging
from typing import Optional

import numpy as np
import librosa

from pitch.music_theory import freq_to_note

logger = logging.getLogger(__name__)

ANALYSIS_SR    = 22050          # 分析用采样率（half of 44100，速度提升 2×）
FMIN           = librosa.note_to_hz("C2")   # ~65 Hz
FMAX           = librosa.note_to_hz("C7")   # ~2093 Hz
# pYIN 参数（hop_length 必须 < frame_length）
FINE_HOP   = 512    # hop（约 23 ms/帧 @ 22050 Hz）
FINE_FRAME = 2048   # frame_length（= 4 × hop）
RMS_HOP    = 512    # RMS 能量曲线 hop


# ── 工具 ──────────────────────────────────────────────────

def _run_pyin(y: np.ndarray, sr: int, hop_length: int, frame_length: int) -> list[dict]:
    """
    对整段音频运行 pYIN，返回每帧字典列表。
    每帧：{t, freq, voiced, confidence, note_full, cents, midi}
    注意：librosa pYIN 要求 hop_length < frame_length。
    """
    f0, voiced_flag, voiced_prob = librosa.pyin(
        y,
        fmin=FMIN,
        fmax=FMAX,
        sr=sr,
        frame_length=frame_length,
        hop_length=hop_length,
    )

    frames = []
    n = len(f0)
    for i in range(n):
        t          = float(i * hop_length / sr)
        raw_freq   = float(f0[i]) if not np.isnan(f0[i]) else 0.0
        v          = bool(voiced_flag[i])
        conf       = float(voiced_prob[i])
        freq       = raw_freq if (v and raw_freq > 0) else 0.0

        note_info  = freq_to_note(freq) if freq > 0 else None

        frames.append({
            "t":          round(t, 4),
            "freq":       round(freq, 3),
            "voiced":     v and freq > 0,
            "confidence": round(conf, 4),
            "note_full":  note_info["note_full"] if note_info else None,
            "cents":      note_info["cents"]     if note_info else 0.0,
            "midi":       note_info["midi"]      if note_info else None,
        })

    return frames


def _compute_rms_curve(y: np.ndarray, sr: int, hop: int = RMS_HOP) -> np.ndarray:
    """返回 RMS 能量曲线（归一化到 0-1）。"""
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    mx  = rms.max()
    return (rms / mx).tolist() if mx > 0 else rms.tolist()


# ── 主分析入口 ────────────────────────────────────────────

def analyze_audio_file(filepath: str) -> dict:
    """
    同步分析音频文件（在线程池中调用此函数）。

    参数：
        filepath:  音频文件路径（支持 mp3/flac/wav/ogg/m4a 等）

    返回 dict：
        {
          "duration":     float,       # 秒
          "sr":           int,         # 实际采样率
          "fine_pitches": list[dict],  # pYIN 音高帧（hop=512，约 23 ms/帧）
          "rms":          list[float], # RMS 能量曲线（归一化）
        }

    如发生错误会抛出 Exception，调用方应在外层捕获。
    """
    logger.info(f"[SongAnalyzer] 开始加载：{filepath}")

    # ── 加载音频 ──────────────────────────────────────────
    y, sr = librosa.load(filepath, sr=ANALYSIS_SR, mono=True)
    duration = float(len(y) / sr)
    logger.info(f"[SongAnalyzer] 加载完成：{duration:.1f}s，{sr} Hz")

    # ── pYIN 分析 ─────────────────────────────────────────
    rms_curve    = _compute_rms_curve(y, sr)
    logger.info(f"[SongAnalyzer] 开始 pYIN 分析（hop={FINE_HOP}, frame={FINE_FRAME}）...")
    fine_pitches = _run_pyin(y, sr, FINE_HOP, FINE_FRAME)
    logger.info(f"[SongAnalyzer] 分析完成，{len(fine_pitches)} 帧")

    return {
        "duration":     round(duration, 3),
        "sr":           sr,
        "fine_pitches": fine_pitches,
        "rms":          rms_curve,
    }
