"""
PitchSmoother — 实时音高流异常点过滤器

三层门控（无需外部依赖，纯 Python 标准库）：

  层 1 — 置信度门控（Confidence Gate）
    confidence < adaptive_thresh → voiced=False
    自适应阈值：跟踪最近 20 帧置信度中值 × 0.60（下限 0.30，上限用户设置值）。
    连续性奖励：当前音高与近期音高相差 ≤1.5 个半音时，有效置信度 +0.05，
    防止持续演唱中因单帧置信度轻微下降而被误过滤。

  层 2 — 跳变检测（Spike Filter）
    与最近 7 个 voiced 帧的中位 MIDI 音高相差 > PITCH_JUMP_THRESH 个半音
    （默认 9，约小七度）→ voiced=False
    针对爆破音/气声/换气造成的孤立跳变

  层 3 — 短爆音抑制（Onset Debounce）带微停顿容忍
    连续 voiced 帧数 < PITCH_MIN_VOICED_FRAMES (默认 3 帧, ≈138 ms)
    时推迟确认；unvoiced 帧到来后，若该段过短则整段追溯压制。
    微停顿容忍：若上一段 voiced 持续 ≥10 帧（460ms）且中断仅 1 帧，
    则跳过去抖动等待，直接延续输出——消除持续演唱中偶发的单帧空洞。

阈值均可通过环境变量覆盖：
  PITCH_CONF_THRESH=0.40
  PITCH_JUMP_THRESH=9
  PITCH_MIN_VOICED_FRAMES=3
"""

import logging
import math
import os
import statistics
from collections import deque
from copy import copy
from typing import Optional

logger = logging.getLogger(__name__)

# 从环境变量读取阈值（支持运行时覆盖）
_CONF_THRESH        = float(os.getenv("PITCH_CONF_THRESH",        "0.15"))  # 降低默认阈值提升灵敏度
_JUMP_THRESH_ST     = float(os.getenv("PITCH_JUMP_THRESH",        "9"))    # 半音
_MIN_VOICED_FRAMES  = int(  os.getenv("PITCH_MIN_VOICED_FRAMES",  "3"))

# 微停顿容忍：上一段voiced至少持续多少帧才激活
_CONTINUATION_MIN_RUN = 10   # ≈460ms @ 46ms/帧

# 音符磁吸：候选新半音需连续出现几帧才切换（防止半音边界闪烁）
_HYSTERESIS_FRAMES = 2       # 2 帧 ≈ 46ms，平衡响应速度与稳定性


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

        # 最近 7 帧已确认 voiced 的 MIDI 值，用于 spike 检测和连续性判断
        self._recent_midi: deque[float] = deque(maxlen=7)

        # 最近 20 帧已确认 voiced 的置信度，用于自适应阈值
        self._conf_history: deque[float] = deque(maxlen=20)

        # debounce 状态
        self._voiced_count: int   = 0          # 当前连续 voiced 帧计数
        self._pending: list[dict] = []          # 尚未确认的 voiced 帧缓冲

        # 微停顿容忍状态
        self._prev_voiced_run: int   = 0        # 上一段 voiced 连续帧数
        self._gap_frames: int        = 0        # 当前 unvoiced 间隔帧数
        self._in_continuation: bool  = False    # 下一 voiced 帧是否跳过去抖动

        # 音符磁吸（Hysteresis）：防止在半音边界来回闪烁
        # 只有连续 ≥ _HYSTERESIS_FRAMES 帧落入同一个整数半音，才算"切换"
        self._committed_semitone: Optional[int] = None  # 当前已确认显示的半音（圆整）
        self._candidate_semitone: Optional[int] = None  # 候选新半音
        self._candidate_count:    int = 0               # 候选半音的连续帧计数

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

        # ── 层 1：置信度门控（自适应 + 连续性奖励）─────────
        if frame.get("voiced"):
            raw_conf = frame.get("confidence", 1.0)

            # 自适应阈值：以用户设置的 conf_thresh 为上限（天花板），
            # 当近期置信度整体偏低时自动降低门限（下沉帮助安静演唱通过）。
            # 修复：原 max(0.30, ...) 导致两个问题：
            #   1. conf_thresh=0 时门限仍强制 ≥0.30，完全无法关闭过滤；
            #   2. 唱得越好 median 越高，门限反而越严（逻辑反转）。
            if len(self._conf_history) >= 10 and self._conf_thresh > 0:
                typical = statistics.median(self._conf_history)
                # 允许：置信度达到近期典型值 65% 即视为有效（宽松一些以兼容轻声演唱）
                adaptive_thresh = min(self._conf_thresh, typical * 0.65)
            else:
                # 历史不足或用户设为 0 → 直接用用户阈值（0 = 完全放开）
                adaptive_thresh = self._conf_thresh

            # 连续性奖励：当前音高与近期音高相差≤1.5个半音时 +0.05
            bonus = 0.0
            if frame.get("freq", 0) > 0 and len(self._recent_midi) >= 1:
                curr_midi = _freq_to_midi(frame["freq"])
                med = statistics.median(self._recent_midi)
                if abs(curr_midi - med) <= 1.5:
                    bonus = 0.05

            if raw_conf + bonus < adaptive_thresh:
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

        # 记录已确认 voiced 帧的数据（仅通过层 1+2 的才计入）
        if frame.get("voiced") and frame.get("freq", 0) > 0:
            midi_val = _freq_to_midi(frame["freq"])
            self._recent_midi.append(midi_val)
            self._conf_history.append(frame.get("confidence", 1.0))

        # ── 层 2.5：音符磁吸（Note Hysteresis）──────────────────
        # 问题：歌手在 C4/C#4 边界来回游走时，freq 在两音之间快速切换，UI 闪烁。
        # 解法：只有候选新半音连续出现 ≥ _HYSTERESIS_FRAMES 帧时，才更新 committed_semitone。
        # 输出频率始终是"已确认半音"对应的精确 440×2^((n-69)/12) Hz，消除边界抖动。
        if frame.get("voiced") and frame.get("freq", 0) > 0:
            raw_midi     = _freq_to_midi(frame["freq"])
            raw_semitone = round(raw_midi)   # 圆整到最近整数半音

            if raw_semitone == self._committed_semitone:
                # 仍在同一个半音内 → 重置候选计数，保持 committed
                self._candidate_semitone = None
                self._candidate_count    = 0
            elif raw_semitone == self._candidate_semitone:
                # 连续出现同一个候选半音
                self._candidate_count += 1
                if self._candidate_count >= _HYSTERESIS_FRAMES:
                    # 已稳定足够久 → 正式切换
                    self._committed_semitone = self._candidate_semitone
                    self._candidate_semitone = None
                    self._candidate_count    = 0
            else:
                # 新的候选半音出现，重新计数
                self._candidate_semitone = raw_semitone
                self._candidate_count    = 1

            # 将已确认半音的参考 MIDI 写入 frame，供 main.py 做音符显示 + cents 计算
            # 注意：不修改 frame["freq"]，保留实际检测频率以反映真实 cents 偏差
            if self._committed_semitone is None:
                self._committed_semitone = raw_semitone
            frame["_ref_midi"] = self._committed_semitone
        else:
            # unvoiced → 清除候选状态（不清除 committed，防止短暂间隙触发重置）
            self._candidate_semitone = None
            self._candidate_count    = 0

        # ── 层 3：Onset Debounce（含微停顿容忍）───────────────
        output: list[dict] = []

        if frame.get("voiced"):
            # 进入新的voiced段时，重置gap计数器
            self._gap_frames = 0

            if self._in_continuation:
                # 微停顿容忍：跳过去抖动等待，直接以"已确认"状态输出
                self._in_continuation = False
                # 将voiced_count设为min_voiced，后续帧直接走"持续段"路径
                self._voiced_count = self._min_voiced
                output.append(frame)

            elif self._voiced_count < self._min_voiced:
                self._voiced_count += 1
                if self._voiced_count < self._min_voiced:
                    # 未达确认阈值，先缓存
                    self._pending.append(frame)
                else:
                    # 刚达到阈值：释放所有积压帧 + 当前帧
                    output.extend(self._pending)
                    output.append(frame)
                    self._pending.clear()

            else:
                # 已确认的持续段：直接输出
                self._voiced_count += 1
                output.append(frame)

        else:  # voiced=False
            # 记录上一段voiced长度，更新gap计数
            if self._voiced_count > 0:
                self._prev_voiced_run = self._voiced_count
            self._gap_frames += 1

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

            # 判断是否启用微停顿容忍（gap=1帧 且 上段voiced≥10帧）
            if self._gap_frames == 1 and self._prev_voiced_run >= _CONTINUATION_MIN_RUN:
                self._in_continuation = True
            elif self._gap_frames > 1:
                # gap超过1帧，取消容忍
                self._in_continuation = False

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

    def set_conf_thresh(self, v: float) -> None:
        """运行时更新置信度门控阈值（0.0–1.0）。"""
        self._conf_thresh = max(0.0, min(1.0, v))

    def reset(self):
        """重置内部状态（换歌/重新连接时调用）"""
        self._recent_midi.clear()
        self._conf_history.clear()
        self._voiced_count = 0
        self._pending.clear()
        self._prev_voiced_run = 0
        self._gap_frames = 0
        self._in_continuation = False
        self._committed_semitone = None
        self._candidate_semitone = None
        self._candidate_count    = 0
