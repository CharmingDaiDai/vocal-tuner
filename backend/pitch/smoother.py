"""
PitchSmoother — 实时音高流异常点过滤器

三层门控（无需外部依赖，纯 Python 标准库）：

  层 1 — 置信度门控（Confidence Gate）
    confidence < PITCH_CONF_THRESH (默认 0.45) → voiced=False
    消除 pYIN 低置信度的误检帧（detector 已修复为取最高置信度帧，
    正常人声通常 ≥ 0.60，0.45 可有效过滤 HMM 极度不确定的帧）

  层 2 — 跳变检测（Spike Filter）
    与最近 3 个 voiced 帧的中位 MIDI 音高相差 > PITCH_JUMP_THRESH 个半音
    （默认 9，约小七度）→ voiced=False
    针对爆破音/气声/换气造成的孤立跳变

  层 3 — 短爆音抑制（Onset Debounce）
    连续 voiced 帧数 < PITCH_MIN_VOICED_FRAMES (默认 3 帧, ≈138 ms)
    时推迟确认；unvoiced 帧到来后，若该段过短则整段追溯压制
    引入最多 3 帧(≈138 ms)延迟，对实时调音感知影响可忽略

阈值均可通过环境变量覆盖：
  PITCH_CONF_THRESH=0.55
  PITCH_JUMP_THRESH=9
  PITCH_MIN_VOICED_FRAMES=3
"""

import logging
import math
import os
import statistics
from collections import deque
from copy import copy

logger = logging.getLogger(__name__)

# 从环境变量读取阈值（支持运行时覆盖）
# 注意：detector.py 已修复为取"最高置信度帧"而非"末帧"，
# 纯正弦波下 max_prob ≈ 0.95，正常人声下通常 ≥ 0.60，
# 因此 0.45 是合理下限（过滤 HMM 极度不确定的帧）。
_CONF_THRESH        = float(os.getenv("PITCH_CONF_THRESH",        "0.05"))
_JUMP_THRESH_ST     = float(os.getenv("PITCH_JUMP_THRESH",        "9"))    # 半音
_MIN_VOICED_FRAMES  = int(  os.getenv("PITCH_MIN_VOICED_FRAMES",  "3"))


def _freq_to_midi(freq: float) -> float:
    """频率 (Hz) → 连续 MIDI 音高"""
    return 69.0 + 12.0 * math.log2(freq / 440.0)


class PitchSmoother:
    """
    有状态的逐帧音高过滤器。

    用法::

        smoother = PitchSmoother()
        frames_to_emit = smoother.feed(raw_pitch_result)
        for frame in frames_to_emit:
            # broadcast frame ...

    feed() 返回 list[dict]，通常含 0 或 1 个元素；
    仅在 Onset Debounce 确认阶段会一次性返回多个帧（积压帧批量释放）。
    """

    def __init__(self):
        self._conf_thresh   = _CONF_THRESH
        self._jump_thresh   = _JUMP_THRESH_ST
        self._min_voiced    = _MIN_VOICED_FRAMES

        # 最近 3 帧已确认 voiced 的 MIDI 值，用于 spike 检测
        self._recent_midi: deque[float] = deque(maxlen=3)

        # debounce 状态
        self._voiced_count: int   = 0          # 当前连续 voiced 帧计数
        self._pending: list[dict] = []          # 尚未确认的 voiced 帧缓冲

        # 统计（每 200 帧打印一次）
        self._total            = 0
        self._n_conf           = 0
        self._n_spike          = 0
        self._n_debounce       = 0

    # ────────────────────────────────────────────────────────
    def feed(self, raw: dict) -> list[dict]:
        """
        输入一帧原始检测结果（来自 detect_pitch()），
        返回待广播的帧列表（0-N 个）。
        """
        self._total += 1
        frame = copy(raw)          # 浅拷贝，避免篡改调用方数据
        frame.setdefault("suppressed", None)

        # ── 层 1：置信度门控 ─────────────────────────────────
        if frame.get("voiced") and frame.get("confidence", 1.0) < self._conf_thresh:
            frame["voiced"]     = False
            frame["freq"]       = 0.0
            frame["suppressed"] = "conf"
            self._n_conf += 1

        # ── 层 2：跳变检测（Spike Filter） ───────────────────
        if frame.get("voiced") and frame.get("freq", 0) > 0:
            midi = _freq_to_midi(frame["freq"])
            if len(self._recent_midi) >= 2:
                med = statistics.median(self._recent_midi)
                if abs(midi - med) > self._jump_thresh:
                    frame["voiced"]     = False
                    frame["freq"]       = 0.0
                    frame["suppressed"] = frame["suppressed"] or "spike"
                    self._n_spike += 1

        # 记录已确认 voiced 帧的 MIDI（仅通过层 1+2 的才计入）
        if frame.get("voiced") and frame.get("freq", 0) > 0:
            self._recent_midi.append(_freq_to_midi(frame["freq"]))

        # ── 层 3：Onset Debounce ─────────────────────────────
        output: list[dict] = []

        if frame.get("voiced"):
            self._voiced_count += 1

            if self._voiced_count < self._min_voiced:
                # 未达确认阈值，先缓存
                self._pending.append(frame)
                # 不输出任何帧（产生最多 _min_voiced-1 帧延迟）

            elif self._voiced_count == self._min_voiced:
                # 刚达到阈值：释放所有积压帧 + 当前帧
                output.extend(self._pending)
                output.append(frame)
                self._pending.clear()

            else:
                # 已确认的持续段：直接输出
                output.append(frame)

        else:  # voiced=False
            if self._pending:
                # 积压帧不足 _min_voiced → 整段标记为 debounce 抑制
                for pf in self._pending:
                    pf = copy(pf)
                    pf["voiced"]     = False
                    pf["freq"]       = 0.0
                    pf["suppressed"] = pf["suppressed"] or "debounce"
                    self._n_debounce += 1
                    output.append(pf)
                self._pending.clear()

            self._voiced_count = 0
            output.append(frame)

        # ── 定期统计日志 ──────────────────────────────────────
        if self._total % 200 == 0:
            rate = (self._n_conf + self._n_spike + self._n_debounce) / self._total * 100
            logger.info(
                "[smoother] total=%d  conf=%d  spike=%d  debounce=%d  suppress_rate=%.1f%%",
                self._total, self._n_conf, self._n_spike, self._n_debounce, rate,
            )

        return output

    # ── 便于单元测试的属性 ─────────────────────────────────
    @property
    def stats(self) -> dict:
        return {
            "total":    self._total,
            "conf":     self._n_conf,
            "spike":    self._n_spike,
            "debounce": self._n_debounce,
        }

    def reset(self):
        """重置内部状态（换歌/重新连接时调用）"""
        self._recent_midi.clear()
        self._voiced_count = 0
        self._pending.clear()
