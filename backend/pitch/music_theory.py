import math
from typing import Optional

# 12 个音名，升号用 #，降号兼容 b 表示
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# A4 = 69 (MIDI)，440 Hz
A4_MIDI = 69
A4_FREQ = 440.0


def freq_to_note(freq: float) -> Optional[dict]:
    """
    将频率（Hz）转换为音符信息。
    返回 dict 包含：note, octave, note_full, cents, ref_freq
    频率 <= 0 或超出人声范围时返回 None。
    """
    if freq <= 0 or freq < 50 or freq > 3000:
        return None

    # MIDI 浮点音符编号
    m = A4_MIDI + 12.0 * math.log2(freq / A4_FREQ)

    # 最近整数音符
    m_nearest = round(m)

    # 音分偏差 [-50, +50]
    cents = 100.0 * (m - m_nearest)

    # 音名
    note_index = m_nearest % 12
    note = NOTE_NAMES[note_index]

    # 八度（MIDI C4=60，八度 = 60//12 - 1 = 4）
    octave = (m_nearest // 12) - 1

    # 该音符的标准频率
    ref_freq = A4_FREQ * (2.0 ** ((m_nearest - A4_MIDI) / 12.0))

    return {
        "note": note,
        "octave": int(octave),
        "note_full": f"{note}{octave}",
        "cents": round(cents, 2),
        "ref_freq": round(ref_freq, 3),
        "midi": m_nearest,
    }


def is_in_tune(cents: float, threshold: float = 15.0) -> str:
    """
    根据音分偏差返回音准级别。
    返回 'good'（±15¢）、'close'（±30¢）、'off'（>±30¢）
    """
    abs_cents = abs(cents)
    if abs_cents <= threshold:
        return "good"
    elif abs_cents <= 30.0:
        return "close"
    else:
        return "off"


def note_to_freq(note_name: str, octave: int) -> float:
    """将音符名和八度转换为标准频率（Hz）。"""
    if note_name not in NOTE_NAMES:
        raise ValueError(f"未知音符：{note_name}")
    note_index = NOTE_NAMES.index(note_name)
    midi = (octave + 1) * 12 + note_index
    return A4_FREQ * (2.0 ** ((midi - A4_MIDI) / 12.0))
