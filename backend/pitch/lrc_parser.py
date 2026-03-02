"""
lrc_parser.py — LRC 歌词文件解析 + 音频元数据歌词提取

支持两种来源：
  1. 标准 LRC 文本文件（[mm:ss.xx] 歌词行）
  2. 音频文件内嵌元数据（MP3 ID3 SYLT 同步歌词标签）

LRC 格式：
  [00:12.54] 静静望着你离去
  [00:15.23] 没有什么话语
  [mm:ss.xx] 或 [mm:ss.xxx] 均支持

返回格式：list[dict]，每个元素：
  { "t": float,   # 时间戳（秒）
    "text": str } # 歌词文本（去除前后空白）
"""

import logging
import re
from pathlib import Path

logger = logging.getLogger(__name__)

# LRC 时间戳正则：[mm:ss.xx] 或 [mm:ss.xxx]
_LRC_TAG_RE = re.compile(
    r"\[(\d{1,2}):(\d{2})[\.,](\d{2,3})\]"
)


def parse_lrc(text: str) -> list[dict]:
    """
    解析 LRC 格式文本，返回 [{t: float, text: str}, ...] 列表。
    已按时间戳升序排序，过滤空行，过滤元数据行（[ti:], [ar:] 等）。
    """
    results: list[dict] = []

    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue

        # 可能有多个时间戳在同一行（如 [00:01.00][00:32.00] 歌词）
        tags = list(_LRC_TAG_RE.finditer(line))
        if not tags:
            continue

        # 提取歌词文本（最后一个时间戳之后的内容）
        last_tag = tags[-1]
        lyrics_text = line[last_tag.end():].strip()

        # 过滤 LRC 元数据行（如 [ti:歌名]、[ar:歌手]）和空歌词
        if not lyrics_text:
            continue

        # 为每个时间戳创建一条记录
        for m in tags:
            minutes  = int(m.group(1))
            seconds  = int(m.group(2))
            frac_str = m.group(3)
            # 统一转为毫秒精度
            if len(frac_str) == 2:
                frac = int(frac_str) / 100.0
            else:
                frac = int(frac_str) / 1000.0
            t = minutes * 60.0 + seconds + frac
            results.append({"t": round(t, 3), "text": lyrics_text})

    results.sort(key=lambda x: x["t"])
    return results


def extract_lyrics_from_audio(filepath: str) -> list[dict] | None:
    """
    尝试从音频文件元数据中提取同步歌词（SYLT）。
    目前支持 MP3 的 ID3 SYLT 标签。
    返回 None 表示未找到可用的同步歌词。

    注意：
    - USLT（非同步歌词）无时间戳，无法用于卡拉 OK 模式，故跳过。
    - FLAC/M4A 的歌词标签通常也是非同步的，故跳过。
    """
    try:
        from mutagen.id3 import ID3, SYLT
        from mutagen import MutagenError
    except ImportError:
        logger.warning("[LRC] mutagen 未安装，跳过元数据提取")
        return None

    path = Path(filepath)
    if path.suffix.lower() not in (".mp3",):
        return None  # 仅 MP3 有 SYLT 标签

    try:
        tags = ID3(filepath)
    except Exception as e:
        logger.debug(f"[LRC] 读取 ID3 失败（{path.name}）：{e}")
        return None

    # 查找所有 SYLT 帧（Synchronized Lyrics/Text）
    sylt_frames = tags.getall("SYLT")
    if not sylt_frames:
        logger.debug(f"[LRC] {path.name} 无 SYLT 标签")
        return None

    frame = sylt_frames[0]
    results: list[dict] = []

    for text, timestamp_ms in frame.text:
        text = text.strip()
        if not text:
            continue
        t = timestamp_ms / 1000.0
        results.append({"t": round(t, 3), "text": text})

    if not results:
        return None

    results.sort(key=lambda x: x["t"])
    logger.info(f"[LRC] 从 {path.name} 提取了 {len(results)} 行同步歌词（SYLT）")
    return results
