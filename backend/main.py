"""
Vocal Tuner — FastAPI 后端
- WS  /ws/pitch   : 实时推送音高检测数据
- POST /api/pause : 暂停推送
- POST /api/resume: 恢复推送
- GET  /          : 静态服务前端 index.html
- GET  /api/devices: 列出可用麦克风设备
"""

import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Set

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from audio.capture import AudioCapture
from pitch.detector import detect_pitch, compute_fft, warmup
from pitch.music_theory import freq_to_note, is_in_tune

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# ── 全局状态 ──────────────────────────────────────────────
capture = AudioCapture()
is_paused = False                        # 暂停标志
active_ws: Set[WebSocket] = set()        # 当前所有 WebSocket 连接

SAMPLE_RATE = 44100
CHUNK_SIZE = 2048
FFT_SKIP = 3       # 每 N 帧发送一次 FFT（降低带宽）

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"


# ── 生命周期 ──────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    loop = asyncio.get_event_loop()

    # 预热 librosa numba JIT（消除首帧延迟）
    await asyncio.to_thread(warmup, SAMPLE_RATE, CHUNK_SIZE)

    # 启动麦克风采集
    capture.start(loop)

    yield

    # 关闭麦克风
    capture.stop()


app = FastAPI(title="Vocal Tuner", lifespan=lifespan)


# ── 静态文件 ──────────────────────────────────────────────
if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


@app.get("/")
async def serve_index():
    index = FRONTEND_DIR / "index.html"
    if index.exists():
        return FileResponse(str(index))
    return JSONResponse({"error": "frontend/index.html 不存在"}, status_code=404)


@app.get("/js/{path:path}")
async def serve_js(path: str):
    file = FRONTEND_DIR / "js" / path
    if file.exists():
        return FileResponse(str(file))
    return JSONResponse({"error": "文件不存在"}, status_code=404)


@app.get("/css/{path:path}")
async def serve_css(path: str):
    file = FRONTEND_DIR / "css" / path
    if file.exists():
        return FileResponse(str(file))
    return JSONResponse({"error": "文件不存在"}, status_code=404)


# ── REST 控制 API ─────────────────────────────────────────
@app.post("/api/pause")
async def pause():
    global is_paused
    is_paused = True
    logger.info("推送已暂停")
    return {"status": "paused"}


@app.post("/api/resume")
async def resume():
    global is_paused
    is_paused = False
    logger.info("推送已恢复")
    return {"status": "recording"}


@app.get("/api/status")
async def get_status():
    devices     = capture.list_devices()
    active_dev  = next((d for d in devices if d["is_active"]), None)
    return {
        "paused":         is_paused,
        "connections":    len(active_ws),
        "sample_rate":    SAMPLE_RATE,
        "chunk_size":     CHUNK_SIZE,
        "current_device": active_dev,
    }


class DeviceRequest(BaseModel):
    device_id: int | None = None  # None = 系统默认


@app.post("/api/device")
async def switch_device(req: DeviceRequest):
    loop = asyncio.get_event_loop()
    try:
        await asyncio.to_thread(capture.switch_device, loop, req.device_id)
        dev_name = capture._get_device_name(req.device_id)
        logger.info(f"切换设备 → {dev_name}")
        return {"status": "ok", "device_id": req.device_id, "device_name": dev_name}
    except Exception as e:
        logger.error(f"切换设备失败：{e}")
        return JSONResponse({"status": "error", "message": str(e)}, status_code=400)


@app.get("/api/devices")
async def list_devices():
    return {"devices": capture.list_devices()}


# ── WebSocket 端点 ────────────────────────────────────────
@app.websocket("/ws/pitch")
async def websocket_pitch(ws: WebSocket):
    await ws.accept()
    active_ws.add(ws)
    logger.info(f"WebSocket 连接：{ws.client}（当前 {len(active_ws)} 个连接）")

    # 发送初始状态
    await ws.send_text(json.dumps({
        "type": "status",
        "state": "paused" if is_paused else "recording",
        "sample_rate": SAMPLE_RATE,
    }))

    frame_count = 0

    try:
        while True:
            # 读取音频帧
            frame: np.ndarray | None = await capture.get_frame(timeout=0.5)

            if frame is None:
                # 超时心跳，让前端知道连接还活着
                await ws.send_text(json.dumps({"type": "heartbeat", "ts": time.time()}))
                continue

            if is_paused:
                # 暂停中：丢帧但保持心跳
                await asyncio.sleep(0.05)
                continue

            frame_count += 1

            # 音高检测（在线程池中运行，避免阻塞事件循环）
            pitch_result = await asyncio.to_thread(
                detect_pitch, frame, SAMPLE_RATE, CHUNK_SIZE
            )

            # FFT（每隔 FFT_SKIP 帧发一次，减少带宽）
            fft_data = None
            if frame_count % FFT_SKIP == 0:
                fft_data = await asyncio.to_thread(
                    compute_fft, frame, SAMPLE_RATE, 256, 4000.0
                )

            # 构建消息
            msg: dict = {
                "type": "pitch",
                "ts": time.time(),
                "freq": pitch_result["freq"],
                "voiced": pitch_result["voiced"],
                "confidence": pitch_result["confidence"],
                "rms": pitch_result["rms"],
                "note_full": None,
                "note": None,
                "octave": None,
                "cents": None,
                "ref_freq": None,
                "tune_level": None,
            }

            if pitch_result["voiced"] and pitch_result["freq"] > 0:
                note_info = freq_to_note(pitch_result["freq"])
                if note_info:
                    msg.update({
                        "note_full": note_info["note_full"],
                        "note": note_info["note"],
                        "octave": note_info["octave"],
                        "cents": note_info["cents"],
                        "ref_freq": note_info["ref_freq"],
                        "tune_level": is_in_tune(note_info["cents"]),
                    })

            if fft_data is not None:
                msg["fft"] = fft_data

            await ws.send_text(json.dumps(msg))

    except WebSocketDisconnect:
        logger.info(f"WebSocket 断开：{ws.client}")
    except Exception as e:
        logger.error(f"WebSocket 异常：{e}")
    finally:
        active_ws.discard(ws)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
