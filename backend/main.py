"""
Vocal Tuner — FastAPI 后端 v2

架构改进：
- ProcessPoolExecutor 替代 ThreadPoolExecutor 用于歌曲分析，绕过 GIL，
  分析期间不影响实时音高检测和 WebSocket 推流
- Per-client PitchSmoother：每个 WebSocket 连接独立实例，局域网多设备互不干扰
- multiprocessing.Value 进度共享：主进程定时轮询，真正异步更新进度
- Pydantic v2 统一响应模型
- CORS + 0.0.0.0 绑定，支持局域网多台设备访问
- /api/server-info 返回局域网 IP，方便前端提示
"""

import asyncio
import json
import logging
import multiprocessing as mp
import shutil
import socket
import time
import uuid
from concurrent.futures import ProcessPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from audio.capture import AudioCapture
from pitch.detector import detect_pitch, compute_fft, warmup
from pitch.music_theory import freq_to_note, is_in_tune
from pitch.smoother import PitchSmoother, _CONF_THRESH
from pitch.analysis_store import AnalysisStore
from worker import worker_init, analyze_task

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# ── Constants ─────────────────────────────────────────────
SAMPLE_RATE      = 44100
CHUNK_SIZE       = 2048
FFT_SKIP         = 5
JOB_TTL_SECONDS  = 600
PROGRESS_POLL_MS = 300
WORKER_PROCESSES = 2

BACKEND_DIR  = Path(__file__).parent
STATIC_DIR   = BACKEND_DIR / "static"
UPLOAD_DIR   = BACKEND_DIR / "uploads"

# ── Global shared state ───────────────────────────────────
capture   = AudioCapture()
is_paused = False
_global_conf_thresh: float = _CONF_THRESH  # runtime-adjustable via /api/settings
store     = AnalysisStore(UPLOAD_DIR)
_jobs: Dict[str, dict] = {}


# ── Per-client session ────────────────────────────────────
@dataclass
class ClientSession:
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=10))
    smoother: PitchSmoother = field(default_factory=PitchSmoother)


_ws_clients: Dict[str, ClientSession] = {}

# ── ProcessPool for song analysis ────────────────────────
_analysis_executor: Optional[ProcessPoolExecutor] = None


def _get_local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


# ── Broadcast loop ────────────────────────────────────────
async def _pitch_broadcast_loop():
    """
    Single-producer coroutine: reads mic frames, runs detect_pitch ONCE,
    then lets each client session run its own smoother.
    """
    frame_count = 0
    while True:
        try:
            frame: Optional[np.ndarray] = await capture.get_frame(timeout=0.5)

            if frame is None:
                hb = json.dumps({"type": "heartbeat", "ts": time.time()})
                for sess in list(_ws_clients.values()):
                    try:
                        sess.queue.put_nowait(hb)
                    except asyncio.QueueFull:
                        pass
                continue

            if is_paused:
                await asyncio.sleep(0.05)
                continue

            frame_count += 1

            raw_result = await asyncio.to_thread(
                detect_pitch, frame, SAMPLE_RATE, CHUNK_SIZE
            )
            raw_result["_ts"] = time.time()

            fft_data = None
            if frame_count % FFT_SKIP == 0:
                fft_data = await asyncio.to_thread(
                    compute_fft, frame, SAMPLE_RATE, 256, 4000.0
                )

            for sess in list(_ws_clients.values()):
                smoothed_frames = sess.smoother.feed(dict(raw_result))

                first_frame = True
                for pitch_result in smoothed_frames:
                    frame_ts = pitch_result.pop("_ts", time.time())

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

                    if fft_data is not None and first_frame:
                        msg["fft"] = fft_data
                        first_frame = False

                    payload = await asyncio.to_thread(json.dumps, msg)
                    try:
                        sess.queue.put_nowait(payload)
                    except asyncio.QueueFull:
                        pass

        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"[broadcast] 广播异常：{e}")
            await asyncio.sleep(0.1)


# ── Lifespan ──────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    global _analysis_executor

    UPLOAD_DIR.mkdir(exist_ok=True)

    await asyncio.to_thread(warmup, SAMPLE_RATE, CHUNK_SIZE)

    _analysis_executor = ProcessPoolExecutor(
        max_workers=WORKER_PROCESSES,
        initializer=worker_init,
        initargs=(SAMPLE_RATE, CHUNK_SIZE),
        mp_context=mp.get_context("spawn"),
    )

    capture.start(asyncio.get_running_loop())
    broadcast_task = asyncio.create_task(_pitch_broadcast_loop(), name="pitch-broadcast")

    ip = _get_local_ip()
    logger.info(f"服务已启动 — 局域网访问地址: http://{ip}:8000")

    yield

    broadcast_task.cancel()
    try:
        await broadcast_task
    except asyncio.CancelledError:
        pass
    capture.stop()
    if _analysis_executor:
        _analysis_executor.shutdown(wait=False)


# ── App ───────────────────────────────────────────────────
app = FastAPI(title="Vocal Tuner", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Static files ──────────────────────────────────────────
UPLOAD_DIR.mkdir(exist_ok=True)
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")

_assets_src = STATIC_DIR / "assets"
if _assets_src.exists():
    app.mount("/assets", StaticFiles(directory=str(_assets_src)), name="assets")


@app.get("/")
async def serve_index():
    idx = STATIC_DIR / "index.html"
    if idx.exists():
        return FileResponse(str(idx))
    return JSONResponse({"error": "index.html 不存在，请先运行 npm run build"}, status_code=404)


# NOTE: This catch-all must come AFTER all /api routes
# It is registered after the API routes so FastAPI matching order works correctly.


# ── REST — control ────────────────────────────────────────
@app.post("/api/pause")
async def pause():
    global is_paused
    is_paused = True
    return {"status": "paused"}


@app.post("/api/resume")
async def resume():
    global is_paused
    is_paused = False
    return {"status": "recording"}


@app.get("/api/status")
async def get_status():
    devices    = capture.list_devices()
    active_dev = next((d for d in devices if d["is_active"]), None)
    return {
        "paused":         is_paused,
        "connections":    len(_ws_clients),
        "sample_rate":    SAMPLE_RATE,
        "chunk_size":     CHUNK_SIZE,
        "current_device": active_dev,
    }


@app.get("/api/server-info")
async def server_info():
    return {"local_ip": _get_local_ip(), "port": 8000}


# ── REST — settings ───────────────────────────────────────
class SettingsRequest(BaseModel):
    conf_thresh: Optional[float] = None


@app.get("/api/settings")
async def get_settings():
    return {"conf_thresh": _global_conf_thresh}


@app.post("/api/settings")
async def update_settings(req: SettingsRequest):
    global _global_conf_thresh
    if req.conf_thresh is not None:
        _global_conf_thresh = max(0.0, min(1.0, req.conf_thresh))
        # 实时更新所有已连接客户端的平滑器
        for sess in list(_ws_clients.values()):
            sess.smoother.set_conf_thresh(_global_conf_thresh)
    return {"conf_thresh": _global_conf_thresh}


class DeviceRequest(BaseModel):
    device_id: Optional[int] = None


@app.post("/api/device")
async def switch_device(req: DeviceRequest):
    loop = asyncio.get_running_loop()
    try:
        await asyncio.to_thread(capture.switch_device, loop, req.device_id)
        dev_name = capture._get_device_name(req.device_id)
        return {"status": "ok", "device_id": req.device_id, "device_name": dev_name}
    except Exception as e:
        return JSONResponse({"status": "error", "message": str(e)}, status_code=400)


@app.get("/api/devices")
async def list_devices():
    devices = await asyncio.to_thread(capture.list_devices)
    return {"devices": devices}


# ── REST — library ────────────────────────────────────────
@app.get("/api/library")
async def list_library():
    songs = await asyncio.to_thread(store.list_all)
    return {"songs": songs}


@app.get("/api/library/{job_id}")
async def get_library_item(job_id: str):
    data = await asyncio.to_thread(store.load, job_id)
    if data is None:
        return JSONResponse({"error": "歌曲不存在"}, status_code=404)
    data["audio_url"] = f"/uploads/{data.get('filename', '')}"
    return data


@app.delete("/api/library/{job_id}")
async def delete_library_item(job_id: str):
    ok = store.delete(job_id, UPLOAD_DIR)
    if not ok:
        return JSONResponse({"error": "歌曲不存在"}, status_code=404)
    _jobs.pop(job_id, None)
    return {"status": "deleted", "job_id": job_id}


# ── REST — analysis ───────────────────────────────────────
@app.post("/api/analyze")
async def upload_and_analyze(file: UploadFile = File(...)):
    job_id    = str(uuid.uuid4())[:8]
    suffix    = Path(file.filename or "audio").suffix.lower() or ".mp3"
    safe_name = f"{job_id}{suffix}"
    filepath  = UPLOAD_DIR / safe_name

    def _save_upload():
        with filepath.open("wb") as f:
            shutil.copyfileobj(file.file, f)

    await asyncio.to_thread(_save_upload)

    progress_val = mp.Value("d", 0.0)

    _jobs[job_id] = {
        "status":        "analyzing",
        "filename":      safe_name,
        "original_name": file.filename,
        "filepath":      str(filepath),
        "duration":      None,
        "fine_pitches":  None,
        "rms":           None,
        "error":         None,
        "progress":      0.0,
        "_progress_val": progress_val,
    }

    logger.info(f"[Analyze] 任务 {job_id} 开始，文件：{file.filename}")

    async def _run_analysis():
        loop = asyncio.get_running_loop()
        try:
            poll_task = asyncio.create_task(_poll_progress(job_id, progress_val))

            result = await loop.run_in_executor(
                _analysis_executor,
                analyze_task,
                str(filepath),
                progress_val,
            )

            poll_task.cancel()

            job = _jobs.get(job_id)
            if job:
                job["status"]       = "done"
                job["fine_pitches"] = result["fine_pitches"]
                job["duration"]     = result["duration"]
                job["rms"]          = result["rms"]
                job["progress"]     = 1.0
                job["completed_at"] = time.time()
                logger.info(f"[Analyze] {job_id} 完成，duration={result['duration']:.1f}s")

                save_payload = {
                    "original_name": job["original_name"],
                    "filename":      job["filename"],
                    "duration":      job["duration"],
                    "sr":            result.get("sr", 22050),
                    "created_at":    datetime.now().isoformat(timespec="seconds"),
                    "rms":           job["rms"],
                    "fine_pitches":  job["fine_pitches"],
                }
                await asyncio.to_thread(store.save, job_id, save_payload)
        except Exception as e:
            logger.error(f"[Analyze] {job_id} 失败：{e}", exc_info=True)
            job = _jobs.get(job_id)
            if job:
                job["status"]       = "error"
                job["error"]        = str(e)
                job["completed_at"] = time.time()

    asyncio.create_task(_run_analysis())

    return {
        "job_id":        job_id,
        "filename":      safe_name,
        "original_name": file.filename,
        "audio_url":     f"/uploads/{safe_name}",
    }


async def _poll_progress(job_id: str, progress_val: mp.Value):
    while True:
        await asyncio.sleep(PROGRESS_POLL_MS / 1000)
        job = _jobs.get(job_id)
        if not job or job["status"] != "analyzing":
            break
        try:
            job["progress"] = round(progress_val.value, 3)
        except Exception:
            pass


@app.get("/api/analyze/{job_id}")
async def get_analysis(job_id: str):
    now_ts = time.time()
    stale = [
        jid for jid, j in list(_jobs.items())
        if j.get("status") in ("done", "error") and
           now_ts - j.get("completed_at", now_ts) > JOB_TTL_SECONDS
    ]
    for jid in stale:
        _jobs.pop(jid, None)

    job = _jobs.get(job_id)

    if job is None:
        meta = await asyncio.to_thread(store.load, job_id)
        if meta is None:
            return JSONResponse({"error": "任务不存在"}, status_code=404)
        return {
            "job_id":        job_id,
            "status":        "done",
            "filename":      meta.get("filename", ""),
            "original_name": meta.get("original_name"),
            "duration":      meta.get("duration"),
            "audio_url":     f"/uploads/{meta.get('filename', '')}",
            "progress":      1.0,
        }

    resp: dict = {
        "job_id":        job_id,
        "status":        job["status"],
        "filename":      job["filename"],
        "original_name": job.get("original_name"),
        "duration":      job["duration"],
        "audio_url":     f"/uploads/{job['filename']}",
        "progress":      job.get("progress", 0.0),
    }
    if job["status"] == "error":
        resp["error"] = job.get("error")

    return resp


# ── WebSocket ─────────────────────────────────────────────
@app.websocket("/ws/pitch")
async def websocket_pitch(ws: WebSocket):
    await ws.accept()

    client_id = str(uuid.uuid4())[:8]
    session   = ClientSession()
    session.smoother.set_conf_thresh(_global_conf_thresh)  # apply current global threshold
    _ws_clients[client_id] = session
    logger.info(f"WebSocket 连接 [{client_id}]（共 {len(_ws_clients)} 个）")

    await ws.send_text(json.dumps({
        "type":        "status",
        "state":       "paused" if is_paused else "recording",
        "sample_rate": SAMPLE_RATE,
    }))

    try:
        while True:
            try:
                payload = await asyncio.wait_for(session.queue.get(), timeout=2.0)
            except asyncio.TimeoutError:
                await ws.send_text(json.dumps({"type": "heartbeat", "ts": time.time()}))
                continue
            await ws.send_text(payload)

    except WebSocketDisconnect:
        logger.info(f"WebSocket 断开 [{client_id}]")
    except Exception as e:
        logger.error(f"WebSocket 异常 [{client_id}]：{e}")
    finally:
        _ws_clients.pop(client_id, None)
        session.smoother.reset()


# ── SPA fallback (must be last) ───────────────────────────
@app.get("/{path:path}")
async def serve_spa(path: str):
    f = STATIC_DIR / path
    if f.exists() and f.is_file():
        return FileResponse(str(f))
    idx = STATIC_DIR / "index.html"
    if idx.exists():
        return FileResponse(str(idx))
    return JSONResponse({"error": "not found"}, status_code=404)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
