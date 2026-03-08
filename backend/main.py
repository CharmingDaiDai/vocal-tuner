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
from pitch.lrc_parser import parse_lrc, extract_lyrics_from_audio
from pitch.session_store import SessionStore
from pitch.vibrato import VibratoDetector
from worker import worker_init, analyze_task

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# ── Constants ─────────────────────────────────────────────
SAMPLE_RATE      = 44100
CHUNK_SIZE       = 2048   # 实时采集帧长（~46ms，与 pYIN frame_length=2048 对齐）
WORKER_CHUNK_SIZE = 2048  # 离线分析保持高精度
FFT_SKIP         = 3      # 每3帧计算一次FFT（原5，约70ms更新率更流畅）
JOB_TTL_SECONDS  = 600
PROGRESS_POLL_MS = 300
WORKER_PROCESSES = 2

BACKEND_DIR  = Path(__file__).parent
STATIC_DIR   = BACKEND_DIR / "static"
UPLOAD_DIR   = BACKEND_DIR / "uploads"
SESSION_DIR  = BACKEND_DIR / "sessions"

# ── Global shared state ───────────────────────────────────
capture      = AudioCapture()
is_paused    = False
_global_conf_thresh: float = _CONF_THRESH  # runtime-adjustable via /api/settings
store        = AnalysisStore(UPLOAD_DIR)
session_store = SessionStore(SESSION_DIR)
_jobs: Dict[str, dict] = {}


# ── Per-client session ────────────────────────────────────
@dataclass
class ClientSession:
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=10))
    smoother: PitchSmoother = field(default_factory=PitchSmoother)
    vibrato: VibratoDetector = field(default_factory=VibratoDetector)


_ws_clients: Dict[str, ClientSession] = {}

# ── ProcessPool for song analysis ────────────────────────
_analysis_executor: Optional[ProcessPoolExecutor] = None
# Manager 用于创建可跨 spawn 进程 pickle 的进度代理对象
# 注意：mp.Value() 无法在 spawn 方式下 pickle，需要 Manager().Value() 代替
_mp_manager = None  # type: ignore  # multiprocessing.managers.SyncManager


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
                        ref_midi = pitch_result.get("_ref_midi")
                        if ref_midi is not None:
                            # 磁吸模式：音符名取自 committed semitone（稳定），
                            # cents 取自实际频率 vs committed 半音中心（反映真实偏差）
                            ref_freq_hz = 440.0 * (2.0 ** ((ref_midi - 69) / 12.0))
                            cents_val = 1200.0 * np.log2(pitch_result["freq"] / ref_freq_hz)
                            note_idx = ref_midi % 12
                            note_names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"]
                            note_name = note_names[note_idx]
                            octave_val = (ref_midi // 12) - 1
                            msg.update({
                                "note_full":  f"{note_name}{octave_val}",
                                "note":       note_name,
                                "octave":     int(octave_val),
                                "cents":      round(float(cents_val), 2),
                                "ref_freq":   round(ref_freq_hz, 3),
                                "tune_level": is_in_tune(float(cents_val)),
                            })
                        else:
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
                        # Vibrato detection (only on voiced frames)
                        midi_val = 69 + 12 * np.log2(pitch_result["freq"] / 440) if pitch_result["freq"] > 0 else None
                        vib = sess.vibrato.feed(midi_val, True)
                        msg["vibrato"] = vib
                    else:
                        sess.vibrato.feed(None, False)

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


def _cleanup_orphan_wavs():
    """删除 sessions/ 中超过 1 小时且无对应 session JSON 的孤儿 WAV 文件。"""
    import time as _time
    now = _time.time()
    count = 0
    for wav in SESSION_DIR.glob("*.wav"):
        sid = wav.stem
        has_session = (SESSION_DIR / f"{sid}.json").exists() or \
                      (SESSION_DIR / f"{sid}.meta.json").exists()
        if not has_session and (now - wav.stat().st_mtime) > 3600:
            wav.unlink()
            count += 1
    if count:
        logger.info(f"清理了 {count} 个孤儿 WAV 文件")


# ── Lifespan ──────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    global _analysis_executor, _mp_manager

    UPLOAD_DIR.mkdir(exist_ok=True)
    SESSION_DIR.mkdir(exist_ok=True)

    # 清理孤儿 WAV（有临时 WAV 但无对应 session，且超过 1 小时）
    _cleanup_orphan_wavs()

    await asyncio.to_thread(warmup, SAMPLE_RATE, CHUNK_SIZE)

    # Manager 必须在 ProcessPoolExecutor 之前启动
    # Manager().Value() 创建的代理对象可以 pickle 传递给 spawn 子进程
    _mp_manager = mp.Manager()

    _analysis_executor = ProcessPoolExecutor(
        max_workers=WORKER_PROCESSES,
        initializer=worker_init,
        initargs=(SAMPLE_RATE, WORKER_CHUNK_SIZE),  # 离线分析用更大帧长
        mp_context=mp.get_context("spawn"),
    )

    capture.start(asyncio.get_running_loop())
    broadcast_task = asyncio.create_task(_pitch_broadcast_loop(), name="pitch-broadcast")

    ip = _get_local_ip()
    logger.info(f"服务已启动 — 局域网访问地址: http://{ip}:9000")

    yield

    broadcast_task.cancel()
    try:
        await broadcast_task
    except asyncio.CancelledError:
        pass
    capture.stop()
    if _analysis_executor:
        _analysis_executor.shutdown(wait=False)
    if _mp_manager:
        _mp_manager.shutdown()


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
SESSION_DIR.mkdir(exist_ok=True)
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")
app.mount("/sessions", StaticFiles(directory=str(SESSION_DIR)), name="sessions")

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
    return {"local_ip": _get_local_ip(), "port": 9000}


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
    if data.get("original_filename"):
        data["original_url"] = f"/uploads/{data['original_filename']}"
    return data


@app.delete("/api/library/{job_id}")
async def delete_library_item(job_id: str):
    ok = store.delete(job_id, UPLOAD_DIR)
    if not ok:
        return JSONResponse({"error": "歌曲不存在"}, status_code=404)
    _jobs.pop(job_id, None)
    return {"status": "deleted", "job_id": job_id}


# ── REST — lyrics ──────────────────────────────────────────
@app.post("/api/library/{job_id}/lyrics")
async def upload_lyrics(job_id: str, file: UploadFile = File(...)):
    """上传 .lrc 歌词文件，解析后保存为 {job_id}.lrc.json。"""
    if not store.exists(job_id):
        return JSONResponse({"error": "歌曲不存在"}, status_code=404)

    raw = await file.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("gbk", errors="replace")

    lyrics = parse_lrc(text)
    if not lyrics:
        return JSONResponse({"error": "未能解析到有效歌词，请检查 LRC 格式"}, status_code=400)

    await asyncio.to_thread(store.save_lyrics, job_id, lyrics)
    return {"job_id": job_id, "count": len(lyrics)}


@app.delete("/api/library/{job_id}/lyrics")
async def delete_lyrics(job_id: str):
    """删除歌词文件。"""
    lrc_path = UPLOAD_DIR / f"{job_id}.lrc.json"
    if not lrc_path.exists():
        return JSONResponse({"error": "歌词不存在"}, status_code=404)
    lrc_path.unlink()
    return {"status": "deleted", "job_id": job_id}


# ── REST — original track ─────────────────────────────────
@app.post("/api/library/{job_id}/original")
async def upload_original(job_id: str, file: UploadFile = File(...)):
    """上传或替换原文件（用于跟唱模式播放）。
    同时尝试从原文件中自动提取 SYLT 内嵌歌词。
    """
    if not store.exists(job_id):
        return JSONResponse({"error": "歌曲不存在"}, status_code=404)

    suffix    = Path(file.filename or "audio").suffix.lower() or ".mp3"
    orig_name = f"{job_id}_original{suffix}"
    orig_path = UPLOAD_DIR / orig_name

    # 删除旧的原文件（如有，扩展名可能不同）
    for old in UPLOAD_DIR.glob(f"{job_id}_original.*"):
        old.unlink(missing_ok=True)

    # 保存新文件
    contents = await file.read()
    orig_path.write_bytes(contents)

    # 更新元数据（加载完整数据后合并写回）
    data = await asyncio.to_thread(store.load, job_id)
    if data is None:
        return JSONResponse({"error": "歌曲不存在"}, status_code=404)
    data["original_filename"]   = orig_name
    data["original_track_name"] = file.filename
    await asyncio.to_thread(store.save, job_id, data)

    # 尝试自动提取 SYLT 歌词（仅在当前无歌词时）
    lyrics_auto = False
    if store.load_lyrics(job_id) is None:
        try:
            lyrics = await asyncio.to_thread(extract_lyrics_from_audio, str(orig_path))
            if lyrics:
                await asyncio.to_thread(store.save_lyrics, job_id, lyrics)
                lyrics_auto = True
                logger.info(f"[Original] 自动提取歌词 {job_id}（{len(lyrics)} 行）")
        except Exception as e:
            logger.warning(f"[Original] 自动提取歌词失败（{job_id}）：{e}")

    return {
        "job_id":       job_id,
        "original_url": f"/uploads/{orig_name}",
        "lyrics_auto":  lyrics_auto,
    }


@app.delete("/api/library/{job_id}/original")
async def delete_original(job_id: str):
    """删除原文件。"""
    if not store.exists(job_id):
        return JSONResponse({"error": "歌曲不存在"}, status_code=404)

    deleted = False
    for f in UPLOAD_DIR.glob(f"{job_id}_original.*"):
        f.unlink(missing_ok=True)
        deleted = True

    if not deleted:
        return JSONResponse({"error": "原文件不存在"}, status_code=404)

    # 从元数据中移除原文件字段
    data = await asyncio.to_thread(store.load, job_id)
    if data:
        data.pop("original_filename", None)
        data.pop("original_track_name", None)
        await asyncio.to_thread(store.save, job_id, data)

    return {"status": "deleted", "job_id": job_id}



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

    # Manager().Value() 可以 pickle，可安全跨 spawn 子进程传递；
    # mp.Value() 使用共享内存+同步锁，Windows spawn 下无法序列化，会抛 RuntimeError
    progress_val = _mp_manager.Value("d", 0.0)

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

                # 尝试从音频元数据提取同步歌词（SYLT）
                try:
                    auto_lyrics = await asyncio.to_thread(
                        extract_lyrics_from_audio, str(filepath)
                    )
                    if auto_lyrics:
                        await asyncio.to_thread(store.save_lyrics, job_id, auto_lyrics)
                        logger.info(f"[Analyze] {job_id} 自动提取歌词 {len(auto_lyrics)} 行")
                except Exception as e:
                    logger.debug(f"[Analyze] {job_id} 歌词提取失败（非关键）：{e}")
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
        session.vibrato.reset()


# ── REST — sessions ───────────────────────────────────────
class SaveSessionRequest(BaseModel):
    frames: list[dict]
    name: Optional[str] = None
    song_job_id: Optional[str] = None
    duration: Optional[float] = None
    wav_session_id: Optional[str] = None  # 如果有WAV录音，传入stop-recording返回的session_id


@app.post("/api/sessions")
async def save_session(req: SaveSessionRequest):
    """保存当前练习会话的音高帧数据。若 wav_session_id 不为 None，
    会将对应的临时 WAV 文件合并到新会话中。"""
    session_id = str(uuid.uuid4())[:8]
    # 只保留 voiced 帧（过滤静默帧，减小文件体积）
    voiced_frames = [f for f in req.frames if f.get("voiced")]

    # 计算实际时长
    duration = req.duration
    if not duration and voiced_frames:
        ts_list = [f.get("ts", 0) for f in voiced_frames]
        duration = max(ts_list) - min(ts_list)

    # 链接临时 WAV 录音（若有）
    has_audio = False
    if req.wav_session_id:
        old_wav = SESSION_DIR / f"{req.wav_session_id}.wav"
        if old_wav.exists():
            new_wav = SESSION_DIR / f"{session_id}.wav"
            old_wav.rename(new_wav)
            has_audio = True
        else:
            logger.warning(
                "WAV link failed: %s.wav not found (session %s)",
                req.wav_session_id, session_id,
            )
        # 清理临时会话的 meta/json 文件（若存在）
        for ext in (".json", ".meta.json"):
            old_file = SESSION_DIR / f"{req.wav_session_id}{ext}"
            if old_file.exists():
                old_file.unlink()

    meta = {
        "name":        req.name or f"练习 {datetime.now().isoformat(timespec='seconds')[:10]}",
        "song_job_id": req.song_job_id,
        "duration":    round(duration or 0.0, 1),
        "created_at":  datetime.now().isoformat(timespec="seconds"),
        "has_audio":   has_audio,
    }
    await asyncio.to_thread(session_store.save, session_id, meta, voiced_frames)
    return {"session_id": session_id, "frame_count": len(voiced_frames), "has_audio": has_audio}


@app.get("/api/sessions")
async def list_sessions():
    sessions = await asyncio.to_thread(session_store.list_all)
    return {"sessions": sessions}


@app.get("/api/sessions/{session_id}")
async def get_session(session_id: str):
    data = await asyncio.to_thread(session_store.load, session_id)
    if data is None:
        return JSONResponse({"error": "会话不存在"}, status_code=404)
    return data


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str):
    ok = await asyncio.to_thread(session_store.delete, session_id)
    if not ok:
        return JSONResponse({"error": "会话不存在"}, status_code=404)
    return {"status": "deleted", "session_id": session_id}


# ── REST — WAV 录音 ───────────────────────────────────────
@app.post("/api/sessions/start-recording")
async def start_recording():
    """开始录制麦克风 WAV 音频。"""
    await asyncio.to_thread(capture.start_recording)
    return {"status": "recording"}


@app.post("/api/sessions/stop-recording")
async def stop_recording():
    """停止录制，保存 WAV 文件到临时位置（无 meta），
    返回 wav_session_id 供后续 POST /api/sessions 时链接。"""
    wav_bytes = await asyncio.to_thread(capture.stop_recording)
    if wav_bytes is None:
        # 返回 200 但 session_id=null，让前端区分"没在录"和真正出错
        return {"session_id": None, "audio_url": None}

    session_id = str(uuid.uuid4())[:8]
    wav_path = SESSION_DIR / f"{session_id}.wav"
    await asyncio.to_thread(wav_path.write_bytes, wav_bytes)

    return {"session_id": session_id, "audio_url": f"/sessions/{session_id}.wav"}


@app.get("/api/sessions/{session_id}/audio")
async def get_session_audio(session_id: str):
    wav_path = session_store.wav_path(session_id)
    if not wav_path.exists():
        return JSONResponse({"error": "录音文件不存在"}, status_code=404)
    return FileResponse(str(wav_path), media_type="audio/wav")


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
    uvicorn.run("main:app", host="0.0.0.0", port=9000, reload=True)
