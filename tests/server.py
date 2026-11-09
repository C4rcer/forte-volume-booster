"""Local test server for Forte's E2E tests and screenshots (stdlib only).

Serves tests/ as static files plus:
  /tone.wav?hz=440&amp=0.1[&secs=20][&cors=1]
      a mono 16-bit sine tone, generated in memory, exact amplitude, Range
      requests supported; cors=1 adds Access-Control-Allow-Origin: *
  /redirect?to=<url>
      302 to <url> (a same-origin URL that lands on another origin)

Start two of these on different ports to get a cross-origin media host.
"""
import http.server
import math
import threading
from array import array
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
_cache = {}
_lock = threading.Lock()


def tone_wav(hz=440.0, amp=0.1, secs=20, sr=44100):
    key = (hz, amp, secs, sr)
    with _lock:
        if key in _cache:
            return _cache[key]
        n = int(sr * secs)
        step = 2 * math.pi * hz / sr
        pcm = array("h", (int(amp * 32767 * math.sin(step * i)) for i in range(n)))
        data = pcm.tobytes()
        hdr = (
            b"RIFF" + (36 + len(data)).to_bytes(4, "little") + b"WAVEfmt "
            + (16).to_bytes(4, "little") + (1).to_bytes(2, "little") + (1).to_bytes(2, "little")
            + sr.to_bytes(4, "little") + (sr * 2).to_bytes(4, "little")
            + (2).to_bytes(2, "little") + (16).to_bytes(2, "little")
            + b"data" + len(data).to_bytes(4, "little")
        )
        _cache[key] = hdr + data
        return _cache[key]


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(HERE), **k)

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if u.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", q.get("to", "/"))
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if u.path == "/tone.wav":
            data = tone_wav(float(q.get("hz", 440)), float(q.get("amp", 0.1)), int(q.get("secs", 20)))
            start, end = 0, len(data) - 1
            rng = self.headers.get("Range")
            if rng and rng.startswith("bytes="):
                a, _, b = rng[6:].partition("-")
                start = int(a or 0)
                end = min(int(b), len(data) - 1) if b else len(data) - 1
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {start}-{end}/{len(data)}")
            else:
                self.send_response(200)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Type", "audio/wav")
            if "cors" in q:
                self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(end - start + 1))
            self.end_headers()
            try:
                self.wfile.write(data[start:end + 1])
            except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
                pass
            return
        super().do_GET()


def serve(port, host="127.0.0.1"):
    httpd = http.server.ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd

