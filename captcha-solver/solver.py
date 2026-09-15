"""
Local CAPTCHA solver microservice for TikTok/Douyin secsdk CAPTCHAs.
Uses ddddocr for puzzle (slider) and OpenCV for rotation.
Runs on http://localhost:5001
"""

import base64
import io
import os
import sys

import cv2
import ddddocr
import numpy as np
from flask import Flask, jsonify, request
from PIL import Image

app = Flask(__name__)
_slide = ddddocr.DdddOcr(det=False, ocr=False, show_ad=False)


def b64_to_bytes(b64: str) -> bytes:
    return base64.b64decode(b64)


def bytes_to_cv2_gray(data: bytes) -> np.ndarray:
    arr = np.frombuffer(data, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError("Could not decode image")
    if img.ndim == 3 and img.shape[2] == 4:
        # Use alpha as mask — convert BGRA → grayscale weighted by alpha
        bgr = img[:, :, :3].astype(np.float32)
        alpha = img[:, :, 3:4].astype(np.float32) / 255.0
        gray = cv2.cvtColor((bgr * alpha).astype(np.uint8), cv2.COLOR_BGR2GRAY)
    elif img.ndim == 3:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    else:
        gray = img
    return gray


def _sample_ring_gray(img_gray: np.ndarray, cx: float, cy: float, r: float, n: int = 360) -> np.ndarray:
    """Sample n pixels on a circle, return 1-D grayscale float array."""
    h, w = img_gray.shape[:2]
    angles = np.linspace(0, 2 * np.pi, n, endpoint=False)
    xs = np.clip((cx + r * np.cos(angles)).astype(int), 0, w - 1)
    ys = np.clip((cy + r * np.sin(angles)).astype(int), 0, h - 1)
    return img_gray[ys, xs].astype(np.float64)


def solve_rotation_cv(outer_bytes: bytes, inner_bytes: bytes) -> int:
    arr_o = np.frombuffer(outer_bytes, np.uint8)
    arr_i = np.frombuffer(inner_bytes, np.uint8)
    outer = cv2.imdecode(arr_o, cv2.IMREAD_COLOR)
    inner = cv2.imdecode(arr_i, cv2.IMREAD_COLOR)

    h_o, w_o = outer.shape[:2]
    h_i, w_i = inner.shape[:2]
    cx_o, cy_o = w_o / 2.0, h_o / 2.0

    # The inner piece is designed to fill the hole: hole_r = inner_size / 2
    # Outer image and inner image may have different scale → normalise.
    hole_r = (w_i / 2.0) * (min(w_o, h_o) / min(w_o, h_o))  # = w_i/2 without scaling
    hole_r = w_i / 2.0  # simple and correct

    diam = int(hole_r * 2)
    inner_resized = cv2.resize(inner, (diam, diam))
    cx_i, cy_i = diam / 2.0, diam / 2.0

    # Convert both to grayscale for stable 1-D signals
    outer_g = cv2.cvtColor(outer, cv2.COLOR_BGR2GRAY).astype(np.float64)
    inner_g = cv2.cvtColor(inner_resized, cv2.COLOR_BGR2GRAY).astype(np.float64)

    N = 360
    # Accumulate cross-correlation across several radii near the boundary.
    # outer is sampled OUTSIDE the hole (hole_r + offset), inner INSIDE the disk
    # (hole_r - offset), so both contain photo content near the same boundary.
    xcorr_sum = np.zeros(N)
    for offset in (2, 5, 9, 13):
        r_o = np.clip(hole_r + offset, 1, min(w_o, h_o) / 2 - 1)
        r_i = np.clip(hole_r - offset, 1, diam / 2 - 1)

        sig_o = _sample_ring_gray(outer_g, cx_o, cy_o, r_o, N)
        sig_i = _sample_ring_gray(inner_g, cx_i, cy_i, r_i, N)

        sig_o -= sig_o.mean()
        sig_i -= sig_i.mean()
        fo = np.fft.rfft(sig_o)
        fi = np.fft.rfft(sig_i)
        xcorr_sum += np.fft.irfft(fo * np.conj(fi), n=N)

    angle = int(np.argmax(xcorr_sum)) % 360
    print(f"  [rotate] angle={angle}° hole_r={hole_r:.0f} peak={xcorr_sum.max():.1f}", flush=True)
    return angle


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/puzzle", methods=["POST"])
def puzzle():
    """
    Body: { "background": "<base64>", "piece": "<base64>" }
    Response: { "proportion": 0.0-1.0, "x": pixels }
    """
    import tempfile, os, time
    data = request.get_json(force=True)
    bg_bytes = b64_to_bytes(data["background"])
    piece_bytes = b64_to_bytes(data["piece"])

    # Save for debugging — check C:\Users\thanakit\AppData\Local\Temp\captcha_debug\
    debug_dir = os.path.join(tempfile.gettempdir(), "captcha_debug")
    os.makedirs(debug_dir, exist_ok=True)
    ts = int(time.time())
    with open(os.path.join(debug_dir, f"{ts}_bg.png"), "wb") as f: f.write(bg_bytes)
    with open(os.path.join(debug_dir, f"{ts}_piece.png"), "wb") as f: f.write(piece_bytes)
    print(f"  [puzzle] Saved debug images to {debug_dir}/{ts}_*.png", flush=True)

    bg_img = Image.open(io.BytesIO(bg_bytes))
    print(f"  [puzzle] bg size={bg_img.size} piece size={Image.open(io.BytesIO(piece_bytes)).size}", flush=True)

    # Try simple_target first, then regular
    result = _slide.slide_match(piece_bytes, bg_bytes, simple_target=True)
    target = result["target"]  # [x1, y1, x2, y2]
    x = target[0]
    proportion = x / bg_img.width

    print(f"  [puzzle] raw target={target} x={x}/{bg_img.width} proportion={proportion:.3f}", flush=True)
    return jsonify({"proportion": proportion, "x": x})


@app.route("/rotate", methods=["POST"])
def rotate():
    """
    Body: { "outer": "<base64>", "inner": "<base64>" }
    Response: { "angle": 0-359 }
    """
    data = request.get_json(force=True)
    outer_bytes = b64_to_bytes(data["outer"])
    inner_bytes = b64_to_bytes(data["inner"])

    angle = solve_rotation_cv(outer_bytes, inner_bytes)

    print(f"  [rotate] angle={angle}°", flush=True)
    return jsonify({"angle": angle})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5001
    # 127.0.0.1 on the host (default); the Docker container sets
    # CAPTCHA_SOLVER_HOST=0.0.0.0 so the scraper containers can reach it over
    # the compose network.
    host = os.environ.get("CAPTCHA_SOLVER_HOST", "127.0.0.1")
    print(f"CAPTCHA solver running on http://{host}:{port}", flush=True)
    app.run(host=host, port=port, debug=False)
