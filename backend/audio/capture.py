import asyncio
import io
import logging
import numpy as np
import sounddevice as sd
import scipy.io.wavfile as wav_io
from typing import Optional

logger = logging.getLogger(__name__)

SAMPLE_RATE = 44100
CHUNK_SIZE  = 2048   # pYIN 分析窗口大小（与 PYIN_FRAME_LENGTH 对齐）
HOP_SIZE    = 1024   # 每次步进的新采样数（50% 重叠）→ 更新率 ~43Hz，曲线更平滑
CHANNELS    = 1


class AudioCapture:
    """
    封装 sounddevice 麦克风采集，通过 asyncio.Queue 桥接音频线程与 asyncio 事件循环。
    注意：sounddevice 的回调在独立线程中执行，不能直接调用 asyncio API，
    必须使用 loop.call_soon_threadsafe 或 queue.put_nowait。

    同时支持 WAV 录制：调用 start_recording() / stop_recording() 控制录制状态，
    stop_recording() 返回完整的 WAV 字节流（bytes）。
    """

    def __init__(
        self,
        sample_rate: int = SAMPLE_RATE,
        chunk_size: int = CHUNK_SIZE,
        loop: Optional[asyncio.AbstractEventLoop] = None,
    ):
        self.sample_rate = sample_rate
        self.chunk_size = chunk_size
        self._loop = loop
        # 单生产者广播架构下只有一个消费者，Queue 稍大以吸收重叠帧突发
        # HOP_SIZE=1024 → 每 23ms 产一帧，maxsize=8 提供 ~184ms 缓冲
        self._queue: asyncio.Queue[np.ndarray] = asyncio.Queue(maxsize=8)
        self._stream: Optional[sd.InputStream] = None
        self._buffer = np.zeros(0, dtype=np.float32)
        self.current_device_id: Optional[int] = None  # None = 系统默认

        # WAV 录制状态
        self._recording: bool = False
        self._rec_buffer: list[np.ndarray] = []

    @staticmethod
    def _safe_put(q: asyncio.Queue, item) -> None:
        """在事件循环线程中安全地入队，队列满时静默丢弃（不抛异常）。"""
        try:
            q.put_nowait(item)
        except asyncio.QueueFull:
            pass

    def _callback(self, indata: np.ndarray, frames: int, time, status):
        """sounddevice 回调（在单独线程中执行）"""
        if status:
            # InputOverflow 在 CPU 繁忙时（如歌曲分析期间）属正常现象，降为 DEBUG 避免刷屏
            if status.input_overflow:
                logger.debug(f"sounddevice input overflow（帧已丢弃）")
            else:
                logger.warning(f"sounddevice 状态：{status}")

        # 单声道：取第一通道
        mono = indata[:, 0].copy()

        # WAV 录制：将原始 PCM 写入内存缓冲
        if self._recording:
            self._rec_buffer.append(mono)

        # 累积缓冲：新音频追加进来后，每移动 HOP_SIZE 个采样就发出一个
        # CHUNK_SIZE 大小的分析窗口（50% 重叠），确保 pYIN 始终有完整的实音输入
        self._buffer = np.concatenate([self._buffer, mono])

        while len(self._buffer) >= self.chunk_size:
            frame = self._buffer[: self.chunk_size].copy()
            self._buffer = self._buffer[HOP_SIZE :]   # 步进 HOP_SIZE，不是整帧

            # 线程安全地将帧推入 asyncio 队列
            # 用 _safe_put 包裹，保证队列满时不在事件循环中抛出未捕获异常
            if self._loop is not None:
                self._loop.call_soon_threadsafe(
                    self._safe_put, self._queue, frame
                )

    def start(
        self,
        loop: asyncio.AbstractEventLoop,
        device_id: Optional[int] = None,
    ):
        """启动麦克风流。device_id=None 使用系统默认设备。"""
        self._loop = loop
        self._buffer = np.zeros(0, dtype=np.float32)
        self.current_device_id = device_id
        # 清空旧队列中的残留帧
        while not self._queue.empty():
            try:
                self._queue.get_nowait()
            except Exception:
                break
        self._stream = sd.InputStream(
            device=device_id,
            samplerate=self.sample_rate,
            channels=CHANNELS,
            dtype="float32",
            # blocksize=HOP_SIZE：每次 callback 交付 HOP_SIZE 个新样本（1024 = ~23ms）
            # 配合 _callback 中的滑动窗口，实现 CHUNK_SIZE=2048 的分析窗口以 50% 重叠滑动
            blocksize=HOP_SIZE,
            callback=self._callback,
        )
        self._stream.start()
        dev_name = self._get_device_name(device_id)
        logger.info(f"麦克风已启动：设备={dev_name}，{self.sample_rate} Hz")

    def stop(self):
        """停止麦克风流。"""
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None
            logger.info("麦克风已停止")

    def switch_device(self, loop: asyncio.AbstractEventLoop, device_id: Optional[int]):
        """热切换麦克风设备：先停止旧流，再用新设备启动。"""
        self.stop()
        self.start(loop, device_id)

    async def get_frame(self, timeout: float = 1.0) -> Optional[np.ndarray]:
        """异步等待下一帧，超时返回 None。"""
        try:
            return await asyncio.wait_for(self._queue.get(), timeout=timeout)
        except asyncio.TimeoutError:
            return None

    # ── WAV 录制接口 ─────────────────────────────────────────

    def start_recording(self) -> None:
        """开始将原始 PCM 音频写入内存缓冲（线程安全，可在任何线程调用）。"""
        if self._recording:
            logger.debug("start_recording 被重复调用，忽略")
            return
        self._rec_buffer.clear()
        self._recording = True
        logger.info("WAV 录制已开始")

    def stop_recording(self) -> Optional[bytes]:
        """
        停止录制，将缓冲中的 PCM 数据编码为 WAV 字节流并返回。
        若未在录制中，返回 None。
        """
        if not self._recording:
            return None
        self._recording = False

        if not self._rec_buffer:
            return None

        audio_data = np.concatenate(self._rec_buffer).astype(np.float32)
        # 转为 16-bit PCM（WAV 兼容性最好）
        audio_int16 = (audio_data * 32767).clip(-32768, 32767).astype(np.int16)

        buf = io.BytesIO()
        wav_io.write(buf, self.sample_rate, audio_int16)
        wav_bytes = buf.getvalue()

        self._rec_buffer.clear()
        logger.info(f"WAV 录制已停止，共 {len(audio_data) / self.sample_rate:.1f}s，"
                    f"{len(wav_bytes) // 1024} KB")
        return wav_bytes

    # ── 设备列表 ─────────────────────────────────────────────

    def list_devices(self) -> list[dict]:
        """列出所有可用音频输入设备，标注默认设备和当前使用设备。"""
        devices  = sd.query_devices()
        try:
            default_in = sd.default.device[0]  # 系统默认输入设备 id
        except Exception:
            default_in = None

        result = []
        for i, d in enumerate(devices):
            if d["max_input_channels"] > 0:
                result.append({
                    "id":       i,
                    "name":     d["name"],
                    "channels": d["max_input_channels"],
                    "is_default": i == default_in,
                    "is_active":  i == self.current_device_id
                             or (self.current_device_id is None and i == default_in),
                })
        return result

    def _get_device_name(self, device_id: Optional[int]) -> str:
        if device_id is None:
            return "系统默认"
        try:
            return sd.query_devices(device_id)["name"]
        except Exception:
            return str(device_id)
