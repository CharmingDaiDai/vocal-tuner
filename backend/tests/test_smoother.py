"""
PitchSmoother 单元测试

运行方式：
    cd backend
    python -m pytest tests/test_smoother.py -v
"""

import sys
import math
import os

# 确保 backend 根目录在 PYTHONPATH 中
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from pitch.smoother import PitchSmoother


# ── 辅助函数 ───────────────────────────────────────────────

def _midi_to_freq(midi: float) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12)


def _voiced(freq: float, conf: float = 0.9, rms: float = 0.05) -> dict:
    """构造一个 voiced=True 的原始检测帧"""
    return {"freq": freq, "voiced": True, "confidence": conf, "rms": rms}


def _silence() -> dict:
    """构造一个静默（voiced=False）帧"""
    return {"freq": 0.0, "voiced": False, "confidence": 0.0, "rms": 0.001}


def _collect(smoother: PitchSmoother, frames: list[dict]) -> list[dict]:
    """依次 feed 所有帧，收集所有输出"""
    out = []
    for f in frames:
        out.extend(smoother.feed(f))
    return out


# ── 层 1：置信度门控 ──────────────────────────────────────

class TestConfidenceGate:
    def test_low_confidence_suppressed(self):
        s = PitchSmoother()
        frames = [_voiced(440.0, conf=0.30)] * 5   # conf < 0.55
        out = _collect(s, frames)
        voiced_out = [f for f in out if f["voiced"]]
        assert len(voiced_out) == 0

    def test_high_confidence_passes_after_debounce(self):
        s = PitchSmoother()
        frames = [_voiced(440.0, conf=0.90)] * 5   # conf > 0.55
        out = _collect(s, frames)
        voiced_out = [f for f in out if f["voiced"]]
        assert len(voiced_out) == 3   # 5 frames - 2 buffered for debounce onset

    def test_suppressed_field_set_to_conf(self):
        s = PitchSmoother()
        out = s.feed(_voiced(440.0, conf=0.20))
        # low-conf frame goes into debounce pending but voiced=False, so emitted immediately
        # after one silence:
        out2 = s.feed(_silence())
        suppressed = [f for f in out2 if f.get("suppressed") == "conf"]
        # the pending frame had suppressed="conf" before debounce flush
        assert any(f.get("suppressed") == "conf" for f in out + out2)


# ── 层 2：跳变检测 ────────────────────────────────────────

class TestSpikeFilter:
    def _stable_run(self, smoother: PitchSmoother, n: int = 5, midi: float = 60.0):
        """先跑 n 帧稳定 voiced 建立历史"""
        freq = _midi_to_freq(midi)
        for _ in range(n):
            smoother.feed(_voiced(freq))

    def test_spike_above_threshold_suppressed(self):
        s = PitchSmoother()
        self._stable_run(s, n=5, midi=60.0)   # 建立 C4 历史
        spike_freq = _midi_to_freq(60 + 12)   # C5，跳跃 12 半音 > 9
        out = s.feed(_voiced(spike_freq))
        voiced_out = [f for f in out if f["voiced"]]
        assert len(voiced_out) == 0, "单帧大跳变应被抑制"

    def test_spike_below_threshold_passes(self):
        s = PitchSmoother()
        self._stable_run(s, n=5, midi=60.0)   # C4
        small_jump_freq = _midi_to_freq(60 + 5)  # F4，跳跃 5 半音 < 9
        out = s.feed(_voiced(small_jump_freq))
        voiced_out = [f for f in out if f["voiced"]]
        assert len(voiced_out) == 1, "小跳变应通过"

    def test_sustained_jump_not_suppressed(self):
        """连续多帧保持在新音高 → 第2/3帧不应再被视为 spike"""
        s = PitchSmoother()
        self._stable_run(s, n=5, midi=60.0)
        high_freq = _midi_to_freq(60 + 12)
        frames = [_voiced(high_freq)] * 6
        out = _collect(s, frames)
        voiced_out = [f for f in out if f["voiced"]]
        # 第 1 帧被 spike 抑制，随后帧的历史更新为新音高，后续应通过
        assert len(voiced_out) >= 3, "持续大跳变不应被无限抑制"


# ── 层 3：Onset Debounce ──────────────────────────────────

class TestOnsetDebounce:
    def test_single_voiced_frame_suppressed(self):
        s = PitchSmoother()
        out = []
        out.extend(s.feed(_voiced(440.0)))   # voiced 1 — buffered
        out.extend(s.feed(_silence()))       # unvoiced — flush as suppressed
        voiced_out = [f for f in out if f["voiced"]]
        assert len(voiced_out) == 0, "单帧 voiced 应被 debounce 抑制"

    def test_two_voiced_frames_suppressed(self):
        s = PitchSmoother()
        out = []
        out.extend(s.feed(_voiced(440.0)))   # 1
        out.extend(s.feed(_voiced(440.0)))   # 2 (still pending)
        out.extend(s.feed(_silence()))       # flush — too short
        voiced_out = [f for f in out if f["voiced"]]
        assert len(voiced_out) == 0

    def test_three_voiced_frames_confirmed(self):
        s = PitchSmoother()
        out = []
        out.extend(s.feed(_voiced(440.0)))   # 1 — pending
        out.extend(s.feed(_voiced(440.0)))   # 2 — pending
        out.extend(s.feed(_voiced(440.0)))   # 3 — CONFIRM, flush all 3
        voiced_out = [f for f in out if f["voiced"]]
        assert len(voiced_out) == 3, "3 帧连续 voiced 应被确认并整体输出"

    def test_long_voiced_segment_all_emitted(self):
        s = PitchSmoother()
        frames = [_voiced(440.0)] * 10
        out = _collect(s, frames)
        voiced_out = [f for f in out if f["voiced"]]
        assert len(voiced_out) == 10 - (s._min_voiced - 1), \
            "确认后所有帧应输出，仅前 min_voiced-1 帧有延迟"

    def test_suppressed_field_debounce(self):
        s = PitchSmoother()
        s.feed(_voiced(440.0))
        out = s.feed(_silence())
        debounced = [f for f in out if f.get("suppressed") == "debounce"]
        assert len(debounced) == 1


# ── 组合场景 ──────────────────────────────────────────────

class TestCombinedScenarios:
    def test_silence_between_notes_separates_segments(self):
        s = PitchSmoother()
        note_a = [_voiced(440.0)] * 5    # A4，稳定确认
        gap    = [_silence()] * 2
        note_b = [_voiced(523.25)] * 5   # C5，稳定确认
        out = _collect(s, note_a + gap + note_b)
        voiced_out = [f for f in out if f["voiced"]]
        # note_a: 5 - 2 = 3 voiced; note_b: 5 - 2 = 3 voiced
        assert len(voiced_out) == 6

    def test_stats_tracking(self):
        s = PitchSmoother()
        _collect(s, [_voiced(440.0, conf=0.2)] * 3)  # conf suppressed
        _collect(s, [_silence()])
        assert s.stats["conf"] > 0

    def test_reset_clears_state(self):
        s = PitchSmoother()
        s.feed(_voiced(440.0))   # put one frame in pending
        s.reset()
        out = s.feed(_silence())
        # after reset there's no pending, silence just outputs silence
        assert len(out) == 1
        assert not out[0]["voiced"]
