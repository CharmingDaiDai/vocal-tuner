"""
Vibrato detector — real-time analysis of pitch oscillations.

Analyzes a rolling window (~1.5 s) of voiced MIDI values for periodic vibrato
oscillations in the 4–8 Hz range typical of classical/operatic singing.

Output per frame:
  {
    "is_vibrato": bool,
    "rate_hz":    float,  # dominant frequency in 4–8 Hz band
    "depth_cents": float, # half-amplitude (peak-to-center) in cents
  }
"""

from collections import deque
import numpy as np


class VibratoDetector:
    # Vibrato is typically 4–8 Hz, 25–150 ¢ depth
    MIN_RATE_HZ = 4.0
    MAX_RATE_HZ = 8.0
    MIN_DEPTH_CENTS = 20.0  # below this → not vibrato

    def __init__(self, frame_rate_hz: float = 43.1):
        """frame_rate_hz: how many voiced frames per second (~44100/1024 ≈ 43.1)."""
        self._fps = frame_rate_hz
        self._buf: deque[float] = deque(maxlen=int(frame_rate_hz * 1.5))  # ~65 frames
        self._gap = 0  # consecutive unvoiced frames
        self._result: dict = {"is_vibrato": False, "rate_hz": 0.0, "depth_cents": 0.0}

    def feed(self, midi: float | None, voiced: bool) -> dict:
        """Feed one pitch frame; returns current vibrato state."""
        if not voiced or midi is None:
            self._gap += 1
            if self._gap > 5:  # >5 unvoiced frames → note ended, clear buffer
                self._buf.clear()
                self._result = {"is_vibrato": False, "rate_hz": 0.0, "depth_cents": 0.0}
            return self._result

        self._gap = 0
        self._buf.append(midi)

        # Need at least 20 frames (~0.5 s) for meaningful analysis
        if len(self._buf) < 20:
            return self._result

        buf = np.array(self._buf, dtype=float)
        n = len(buf)

        # Remove linear trend (pitch drift / glide)
        x = np.arange(n)
        coeffs = np.polyfit(x, buf, 1)
        detrended = buf - np.polyval(coeffs, x)

        # Real FFT
        fft_mag = np.abs(np.fft.rfft(detrended))
        freqs = np.fft.rfftfreq(n, d=1.0 / self._fps)

        # Look only in the vibrato band
        mask = (freqs >= self.MIN_RATE_HZ) & (freqs <= self.MAX_RATE_HZ)
        if not np.any(mask):
            return self._result

        sub_mag = fft_mag[mask]
        sub_freq = freqs[mask]
        peak_idx = int(np.argmax(sub_mag))
        peak_freq = float(sub_freq[peak_idx])
        peak_mag = float(sub_mag[peak_idx])

        # Half-amplitude in MIDI units → cents (1 MIDI unit = 100 cents)
        half_amplitude_midi = peak_mag / (n / 2)
        depth_cents = half_amplitude_midi * 100.0

        is_vibrato = depth_cents >= self.MIN_DEPTH_CENTS
        self._result = {
            "is_vibrato": is_vibrato,
            "rate_hz": round(peak_freq, 1),
            "depth_cents": round(depth_cents, 1),
        }
        return self._result

    def reset(self) -> None:
        self._buf.clear()
        self._gap = 0
        self._result = {"is_vibrato": False, "rate_hz": 0.0, "depth_cents": 0.0}
