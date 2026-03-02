"""
音高检测器 — 封装 librosa.pyin，提供统一的逐帧检测接口。
采用 pYIN（概率 YIN）算法，专为人声设计，内置 voiced/unvoiced 区分。
"""
import numpy as np
import librosa
import logging
from scipy.signal import butter, sosfiltfilt

logger = logging.getLogger(__name__)

# ── 低通滤波器（模块级，只计算一次）──────────────────────
# 截止频率 1400 Hz：覆盖全音域基频（女高音最高 C6=1046Hz，有余量）
# 滤除高频谐波、咝声（s/sh/ts）、气息噪声，减少 pYIN 的 voiced 误判
# 4 阶 Butterworth + sosfiltfilt（零相移双向滤波）
_LP_SOS = butter(4, 1400.0, btype="low", fs=44100, output="sos")

# 预热标志，避免首帧因 numba JIT 阻塞
_warmed_up = False


def warmup(sample_rate: int = 44100, chunk_size: int = 2048) -> None:
    """
    在服务启动时预热 librosa numba JIT 编译，消除首帧 2-5 秒延迟。
    传一段静默音频触发编译，参数与 detect_pitch 实际使用保持一致。
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
            frame_length=2048,
            hop_length=1024,
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
        chunk_size: 音频帧的实际采样数（与 pYIN frame_length 解耦）

    返回 dict：
        freq (float)      — 检测到的基频（Hz），0.0 表示无声
        voiced (bool)     — 是否检测到有效音高
        confidence (float)— 置信度 [0, 1]
    """
    # pYIN 分析帧长固定为 2048（保证检测精度）；
    # 与音频采集帧长（chunk_size）解耦——即使传入的帧只有 1024 个样本，
    # librosa center=True 填充后 pYIN 依然可以得到足够的上下文。
    PYIN_FRAME_LENGTH = 2048
    PYIN_HOP_LENGTH   = 1024

    # 如果帧长不足，补零（librosa center 填充会额外处理，这里仅防止异常）
    if len(audio_frame) < chunk_size:
        audio_frame = np.pad(audio_frame, (0, chunk_size - len(audio_frame)))

    audio_frame = audio_frame.astype(np.float32)

    # 静默检测：RMS < 阈值则直接返回无声（用原始信号，确保安静时噪声不误判）
    rms = float(np.sqrt(np.mean(audio_frame ** 2)))
    if rms < 0.002:
        return {"freq": 0.0, "voiced": False, "confidence": 0.0, "rms": rms}

    # 低通滤波：去除咝音（s/sh/ts）、气息噪声、高频泛音
    # sosfiltfilt = 零相移双向滤波，不引入相位偏移，适合 pYIN 的周期性分析
    audio_filtered = sosfiltfilt(_LP_SOS, audio_frame).astype(np.float32)

    try:
        f0, voiced_flag, voiced_prob = librosa.pyin(
            audio_filtered,
            fmin=librosa.note_to_hz("C2"),   # ~65 Hz，人声最低限
            fmax=librosa.note_to_hz("C7"),   # ~2093 Hz，人声最高限
            sr=sample_rate,
            frame_length=PYIN_FRAME_LENGTH,
            hop_length=PYIN_HOP_LENGTH,
        )

        # pYIN 返回多帧；取"置信度最高"的 voiced 帧（而非最后一帧）。
        # 原因：pYIN HMM 存在边缘效应——chunk 首尾两帧因上下文不足，
        # local voiced_prob 偏低（实测首帧可低至 0.48），但 Viterbi 仍判
        # voiced。取最高置信度帧可同时得到最准确的 f0 和最可靠的 confidence。
        valid_indices = np.where(voiced_flag)[0]
        if len(valid_indices) == 0:
            return {"freq": 0.0, "voiced": False, "confidence": 0.0, "rms": rms}

        best_in_valid = int(np.argmax(voiced_prob[valid_indices]))
        idx = valid_indices[best_in_valid]
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
