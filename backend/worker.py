"""
Worker module — runs in ProcessPoolExecutor child processes.

Each worker process:
  1. Calls warmup() on init to pre-compile numba JIT
  2. Exposes analyze_task() — a pure synchronous function that runs the full
     librosa analysis and writes progress to a shared multiprocessing.Value

Using a process pool (instead of a thread pool) means librosa/numpy compute
runs in a separate OS process, so it can NEVER block the main asyncio event
loop or compete for the GIL with the real-time pitch detection thread.
"""

import multiprocessing as mp
import logging

from pitch.detector import warmup
from pitch.song_analyzer import analyze_audio_file

logger = logging.getLogger(__name__)


def worker_init(sample_rate: int, chunk_size: int):
    """ProcessPoolExecutor initializer: warm up numba JIT in each worker."""
    import logging
    logging.basicConfig(level=logging.INFO)
    logger = logging.getLogger("worker")
    logger.info("[worker] Warming up numba JIT...")
    try:
        warmup(sample_rate, chunk_size)
        logger.info("[worker] Warm-up complete.")
    except Exception as e:
        logger.warning(f"[worker] Warm-up failed (non-fatal): {e}")


def analyze_task(filepath: str, progress_value) -> dict:
    """
    Runs analyze_audio_file() and writes progress to a shared mp.Value('d').
    Called inside a worker process via loop.run_in_executor().

    Args:
        filepath:       Path to the audio file.
        progress_value: multiprocessing.Value('d', 0.0) — shared with main process.

    Returns:
        Analysis result dict from analyze_audio_file().
    """
    def _on_progress(pct: float):
        try:
            progress_value.value = pct
        except Exception:
            pass

    return analyze_audio_file(filepath, _on_progress)
