"""
Vocal Tuner — FastAPI 后端
- WS  /ws/pitch             : 实时推送音高检测数据
- POST /api/pause           : 暂停推送
- POST /api/resume          : 恢复推送
- POST /api/analyze         : 上传音频文件并触发后台分析
- GET  /api/analyze/{job_id}: 查询分析任务进度与结果
- GET  /api/library         : 已持久化的歌曲元数据列表
- GET  /api/library/{job_id}: 获取完整分析数据（含 pitches）
- DELETE /api/library/{job_id}: 删除歌曲及音频文件
- GET  /                    : 静态服务前端 index.html
- GET  /api/devices         : 列出可用麦克风设备
"""

import asyncio
import json
import logging
import shutil
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Set

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from audio.capture import AudioCapture
from pitch.detector import detect_pitch, compute_fft, warmup
from pitch.music_theory import freq_to_note, is_in_tune
from pitch.smoother import PitchSmoother
from pitch.song_analyzer import analyze_audio_file
from pitch.analysis_store import AnalysisStore

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# ── 全局状态 ──────────────────────────────────────────────
capture  = AudioCapture()
smoother = PitchSmoother()               # 实时音高异常点过滤器
is_paused = False                        # 暂停标志
# 每个 WebSocket 连接对应一个私有队列，广播循环写入，连接读取
_ws_clients: Set[asyncio.Queue] = set()
# 歌曲分析独立线程池：最小风险策略下限制为 1，避免与实时麦克风检测抢占 CPU
_analysis_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="song-analysis")
SAMPLE_RATE = 44100
CHUNK_SIZE = 2048
FFT_SKIP = 5       # 每 N 帧发送一次 FFT（进一步降低实时 CPU 占用）

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
UPLOAD_DIR   = Path(__file__).parent / "uploads"

# ── 持久化存储 ────────────────────────────────────────────
store = AnalysisStore(UPLOAD_DIR)

# ── 分析任务状态字典 ──────────────────────────────────────
# job_id -> {
#   status:   'uploading' | 'analyzing' | 'done' | 'error'
#   filename: str
#   filepath: str
#   duration: float | None
#   fine_pitches:   list | None
#   rms:            list | None
#   error:          str  | None
# }
_jobs: dict[str, dict] = {}


# ── 单生产者广播循环 ──────────────────────────────────────
async def _pitch_broadcast_loop():
    """
    单一协程读取麦克风帧、检测音高，将结果广播给所有 WebSocket 连接。
    每帧只调用一次 detect_pitch / compute_fft，无论当前接入多少个客户端。
    """
    frame_count = 0
    while True:
        try:
            frame: np.ndarray | None = await capture.get_frame(timeout=0.5)

            if frame is None:
                # 超时心跳
                hb = json.dumps({"type": "heartbeat", "ts": time.time()})
                for q in list(_ws_clients):
                    try:
                        q.put_nowait(hb)
                    except asyncio.QueueFull:
                        pass
                continue

            if is_paused:
                await asyncio.sleep(0.05)
                continue

            frame_count += 1

            # 音高检测：只跑一次，结果广播给所有客户端
            raw_result = await asyncio.to_thread(
                detect_pitch, frame, SAMPLE_RATE, CHUNK_SIZE
            )
            # 在检测结果上附加时间戳，使 debounce 缓存帧保留原始时间
            raw_result["_ts"] = time.time()

            # FFT（每隔 FFT_SKIP 帧发一次）
            fft_data = None
            if frame_count % FFT_SKIP == 0:
                fft_data = await asyncio.to_thread(
                    compute_fft, frame, SAMPLE_RATE, 256, 4000.0
                )

            # ── 异常点过滤（置信度 + 跳变 + Debounce） ──────────
            # smoother.feed() 通常返回 1 帧；debounce 确认时可能返回多帧
            smoothed_frames = smoother.feed(raw_result)

            for pitch_result in smoothed_frames:
                frame_ts = pitch_result.pop("_ts", time.time())

                # 构建消息（在此处序列化一次，分发字节串，避免多次 json.dumps）
                msg: dict = {
                    "type":       "pitch",
                    "ts":         frame_ts,
                    "freq":       pitch_result["freq"],
                    "voiced":     pitch_result["voiced"],
                    "confidence": pitch_result["confidence"],
                    "rms":        pitch_result["rms"],
                    "suppressed": pitch_result.get("suppressed"),
                    "note_full":  None,
                    "note":       None,
                    "octave":     None,
                    "cents":      None,
                    "ref_freq":   None,
                    "tune_level": None,
                }

                if pitch_result["voiced"] and pitch_result["freq"] > 0:
                    note_info = freq_to_note(pitch_result["freq"])
                    if note_info:
                        msg.update({
                            "note_full":  note_info["note_full"],
                            "note":       note_info["note"],
                            "octave":     note_info["octave"],
                            "cents":      note_info["cents"],
                            "ref_freq":   note_info["ref_freq"],
                            "tune_level": is_in_tune(note_info["cents"]),
                        })

                # FFT 只附到第一帧（避免重复传输）
                if fft_data is not None:
                    msg["fft"] = fft_data
                    fft_data = None

                # JSON 序列化移出事件循环（防止大 payload 阻塞调度）
                payload = await asyncio.to_thread(json.dumps, msg)

                # 广播给所有已注册队列
                for q in list(_ws_clients):
                    try:
                        q.put_nowait(payload)
                    except asyncio.QueueFull:
                        pass  # 客户端消费太慢时静默丢帧，保护广播循环

        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"[broadcast] 广播异常：{e}")
            await asyncio.sleep(0.1)


# ── 生命周期 ──────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    loop = asyncio.get_running_loop()

    # 确保上传目录存在
    UPLOAD_DIR.mkdir(exist_ok=True)

    # 预热 librosa numba JIT（消除首帧延迟）
    await asyncio.to_thread(warmup, SAMPLE_RATE, CHUNK_SIZE)

    # 启动麦克风采集
    capture.start(loop)

    # 启动单生产者广播循环
    broadcast_task = asyncio.create_task(_pitch_broadcast_loop(), name="pitch-broadcast")

    yield

    # 清理
    broadcast_task.cancel()
    try:
        await broadcast_task
    except asyncio.CancelledError:
        pass
    capture.stop()
    _analysis_executor.shutdown(wait=False)


app = FastAPI(title="Vocal Tuner", lifespan=lifespan)


# ── 静态文件 ──────────────────────────────────────────────
if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")

# 上传音频文件目录（运行时挂载，确保目录存在后才能挂载）
UPLOAD_DIR.mkdir(exist_ok=True)
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")


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
        "connections":    len(_ws_clients),
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
    devices = await asyncio.to_thread(capture.list_devices)
    return {"devices": devices}


# ── 歌曲分析 API ──────────────────────────────────────────

@app.post("/api/analyze")
async def upload_and_analyze(file: UploadFile = File(...)):
    """上传音频文件，触发后台两阶段分析，立即返回 job_id。"""
    # 生成唯一 job id 与安全文件名
    job_id    = str(uuid.uuid4())[:8]
    suffix    = Path(file.filename or "audio").suffix.lower() or ".mp3"
    safe_name = f"{job_id}{suffix}"
    filepath  = UPLOAD_DIR / safe_name

    # 保存上传文件（在线程中执行，避免大文件写盘阻塞事件循环）
    def _save_upload():
        with filepath.open("wb") as f:
            shutil.copyfileobj(file.file, f)

    await asyncio.to_thread(_save_upload)

    _jobs[job_id] = {
        "status":        "analyzing",
        "filename":      safe_name,
        "original_name": file.filename,
        "filepath":      str(filepath),
        "duration":      None,
        "fine_pitches":  None,
        "rms":           None,
        "error":         None,
        "progress":      0.0,   # 0.0 ~ 1.0，分段分析时逐步更新
    }

    logger.info(f"[Analyze] 任务 {job_id} 开始，文件：{file.filename}")

    async def _run_analysis():
        loop = asyncio.get_running_loop()
        try:
            # 进度回调：在分析线程中调用，通过 call_soon_threadsafe 安全更新 _jobs
            def _on_progress(pct: float):
                job = _jobs.get(job_id)
                if job:
                    job["progress"] = round(pct, 3)
                    loop.call_soon_threadsafe(lambda: None)  # 唤醒事件循环（可选）

            # 运行在独立线程池，不占用 detect_pitch 的默认线程池
            result = await loop.run_in_executor(
                _analysis_executor,
                analyze_audio_file,
                str(filepath),
                _on_progress,
            )
            job = _jobs.get(job_id)
            if job:
                job["status"]       = "done"
                job["fine_pitches"] = result["fine_pitches"]
                job["duration"]     = result["duration"]
                job["rms"]          = result["rms"]
                logger.info(f"[Analyze] {job_id} 分析完成，duration={result['duration']:.1f}s")
                save_payload = {
                    "original_name": job["original_name"],
                    "filename":      job["filename"],
                    "duration":      job["duration"],
                    "sr":            result.get("sr", 22050),
                    "created_at":    datetime.now().isoformat(timespec="seconds"),
                    "rms":           job["rms"],
                    "fine_pitches":  job["fine_pitches"],
                }
                # JSON 序列化 + 写盘均在独立线程执行，不阻塞事件循环
                await asyncio.to_thread(store.save, job_id, save_payload)
        except Exception as e:
            logger.error(f"[Analyze] {job_id} 失败：{e}")
            job = _jobs.get(job_id)
            if job:
                job["status"] = "error"
                job["error"]  = str(e)

    asyncio.create_task(_run_analysis())

    return {
        "job_id":        job_id,
        "filename":      safe_name,
        "original_name": file.filename,
        "audio_url":     f"/uploads/{safe_name}",
    }



@app.get("/api/library")
async def list_library():
    """返回所有已持久化歌曲的元数据列表（不含 pitches）。"""
    songs = await asyncio.to_thread(store.list_all)
    return {"songs": songs}


@app.get("/api/library/{job_id}")
async def get_library_item(job_id: str):
    """返回完整歌曲数据（含 fine_pitches / rms），用于跟唱模式加载。"""
    data = await asyncio.to_thread(store.load, job_id)
    if data is None:
        return JSONResponse({"error": "歌曲不存在"}, status_code=404)
    data["audio_url"] = f"/uploads/{data.get('filename', '')}"
    return data


@app.delete("/api/library/{job_id}")
async def delete_library_item(job_id: str):
    """删除歌曲记录及对应音频文件。"""
    ok = store.delete(job_id, UPLOAD_DIR)
    if not ok:
        return JSONResponse({"error": "歌曲不存在"}, status_code=404)
    # 同时从内存 job 表清理（若分析任务还在）
    _jobs.pop(job_id, None)
    return {"status": "deleted", "job_id": job_id}


@app.get("/api/analyze/{job_id}")
async def get_analysis(job_id: str):
    """查询分析任务进度。
    status 枚举：analyzing | done | error
    done 时返回 fine_pitches、duration、rms。
    """
    job = _jobs.get(job_id)
    if job is None:
        return JSONResponse({"error": "任务不存在"}, status_code=404)

    resp: dict = {
        "job_id":        job_id,
        "status":        job["status"],
        "filename":      job["filename"],
        "original_name": job.get("original_name"),
        "duration":      job["duration"],
        "audio_url":     f"/uploads/{job['filename']}",
        "progress":      job.get("progress", 0.0),
    }

    # 轮询接口仅返回进度状态和元数据，不包含 pitch 数据体（避免大量 JSON 序列化阻塞事件循环）
    # 需要 fine_pitches 请调用 GET /api/library/{job_id}
    if job["status"] == "error":
        resp["error"] = job["error"]

    return resp


# ── WebSocket 端点 ────────────────────────────────────────
@app.websocket("/ws/pitch")
async def websocket_pitch(ws: WebSocket):
    await ws.accept()

    # 为每个连接创建私有队列；广播循环向此队列投递序列化好的 JSON 字节串
    q: asyncio.Queue[str] = asyncio.Queue(maxsize=10)
    _ws_clients.add(q)
    logger.info(f"WebSocket 连接：{ws.client}（当前 {len(_ws_clients)} 个连接）")

    # 发送初始状态
    await ws.send_text(json.dumps({
        "type": "status",
        "state": "paused" if is_paused else "recording",
        "sample_rate": SAMPLE_RATE,
    }))

    try:
        while True:
            # 等待广播循环投递数据，带超时防止永久阻塞
            try:
                payload = await asyncio.wait_for(q.get(), timeout=2.0)
            except asyncio.TimeoutError:
                # 超时但连接还活着：发一个心跳
                await ws.send_text(json.dumps({"type": "heartbeat", "ts": time.time()}))
                continue
            await ws.send_text(payload)

    except WebSocketDisconnect:
        logger.info(f"WebSocket 断开：{ws.client}")
    except Exception as e:
        logger.error(f"WebSocket 异常：{e}")
    finally:
        _ws_clients.discard(q)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
