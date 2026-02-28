"""
音高检测器 — 封装 librosa.pyin，提供统一的逐帧检测接口。
采用 pYIN（概率 YIN）算法，专为人声设计，内置 voiced/unvoiced 区分。
"""
import numpy as np
import librosa
import logging

logger = logging.getLogger(__name__)

# 预热标志，避免首帧因 numba JIT 阻塞
_warmed_up = False


def warmup(sample_rate: int = 44100, chunk_size: int = 2048) -> None:
    """
    在服务启动时预热 librosa numba JIT 编译，消除首帧 2-5 秒延迟。
    传一段静默音频触发编译。
    """
    global _warmed_up
    if _warmed_up:
        return
    logger.info("正在预热 librosa pYIN（numba JIT 编译）...")
    silence = np.zeros(chunk_size * 4, dtype=np.float32)
    try:
        librosa.pyin(
            silence,
            fmin=librosa.note_to_hz("C2"),
            fmax=librosa.note_to_hz("C7"),
            sr=sample_rate,
            frame_length=chunk_size,
            hop_length=chunk_size // 4,
        )
        _warmed_up = True
        logger.info("librosa pYIN 预热完成")
    except Exception as e:
        logger.warning(f"预热失败（不影响运行）：{e}")


def detect_pitch(
    audio_frame: np.ndarray,
    sample_rate: int = 44100,
    chunk_size: int = 2048,
) -> dict:
    """
    对一帧音频数据进行音高检测。

    参数：
        audio_frame: float32 NumPy 数组，单声道 PCM
        sample_rate: 采样率（Hz）
        chunk_size: 帧长度（样本数）

    返回 dict：
        freq (float)      — 检测到的基频（Hz），0.0 表示无声
        voiced (bool)     — 是否检测到有效音高
        confidence (float)— 置信度 [0, 1]
    """
    # 如果帧长不足，补零
    if len(audio_frame) < chunk_size:
        audio_frame = np.pad(audio_frame, (0, chunk_size - len(audio_frame)))

    audio_frame = audio_frame.astype(np.float32)

    # 静默检测：RMS < 阈值则直接返回无声
    rms = float(np.sqrt(np.mean(audio_frame ** 2)))
    if rms < 0.005:
        return {"freq": 0.0, "voiced": False, "confidence": 0.0, "rms": rms}

    try:
        f0, voiced_flag, voiced_prob = librosa.pyin(
            audio_frame,
            fmin=librosa.note_to_hz("C2"),   # ~65 Hz，人声最低限
            fmax=librosa.note_to_hz("C7"),   # ~2093 Hz，人声最高限
            sr=sample_rate,
            frame_length=chunk_size,
            hop_length=chunk_size // 2,
        )

        # pYIN 返回多帧，取最后一帧（最新数据）中 voiced 的结果
        valid_indices = np.where(voiced_flag)[0]
        if len(valid_indices) == 0:
            return {"freq": 0.0, "voiced": False, "confidence": 0.0, "rms": rms}

        idx = valid_indices[-1]
        freq = float(f0[idx]) if not np.isnan(f0[idx]) else 0.0
        confidence = float(voiced_prob[idx])

        if freq <= 0 or np.isnan(freq):
            return {"freq": 0.0, "voiced": False, "confidence": 0.0, "rms": rms}

        return {
            "freq": round(freq, 3),
            "voiced": True,
            "confidence": round(confidence, 4),
            "rms": round(rms, 6),
        }

    except Exception as e:
        logger.error(f"音高检测异常：{e}")
        return {"freq": 0.0, "voiced": False, "confidence": 0.0, "rms": rms}


def compute_fft(
    audio_frame: np.ndarray,
    sample_rate: int = 44100,
    n_bins: int = 256,
    max_freq: float = 4000.0,
) -> list[float]:
    """
    计算降采样后的 FFT 幅度频谱，用于前端频谱可视化。

    返回 n_bins 个 float，对应 0 ~ max_freq Hz 范围的幅度（归一化到 0-1）。
    """
    audio_frame = audio_frame.astype(np.float32)
    n = len(audio_frame)

    # 加 Hanning 窗减少频谱泄漏
    window = np.hanning(n)
    fft_result = np.abs(np.fft.rfft(audio_frame * window))

    # 只取 0 ~ max_freq Hz 的部分
    freqs = np.fft.rfftfreq(n, d=1.0 / sample_rate)
    max_bin = np.searchsorted(freqs, max_freq)
    fft_result = fft_result[:max_bin]

    # 降采样到 n_bins
    if len(fft_result) > n_bins:
        factor = len(fft_result) // n_bins
        fft_result = fft_result[: factor * n_bins].reshape(n_bins, factor).max(axis=1)
    elif len(fft_result) < n_bins:
        fft_result = np.pad(fft_result, (0, n_bins - len(fft_result)))

    # 归一化
    max_val = fft_result.max()
    if max_val > 0:
        fft_result = fft_result / max_val

    return [round(float(v), 4) for v in fft_result]
