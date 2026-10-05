#!/usr/bin/env python3
"""In-memory stand-in for the lobby log Worker ("Lobby log API" in dev/DATA-CONTRACT.md).

Stdlib only. Nothing is saved: restart it to clear the log.

    python3 dev/mock_api.py                     # http://localhost:8787, squad code "test-code"
    python3 dev/mock_api.py --seed-taps 40      # start with 40 made-up taps from the last 2 weeks
    python3 dev/mock_api.py --delay 1500        # answer slowly, to see the buttons' busy state
    python3 dev/mock_api.py --unconfigured      # no squad code on the server: every call gets 503

Then serve the repo root (python3 -m http.server 8000) and open
    http://localhost:8000/docs/?data=../dev/fixture/&api=http://localhost:8787

It is stricter than it needs to be on purpose: a POST body must have exactly
the contract's fields, so the page can't drift from the contract unnoticed.
The request log never prints the X-Squad-Code header.
"""

import argparse
import json
import random
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

ORIGIN_OK = re.compile(r"^(https://natanforestree\.github\.io|http://(localhost|127\.0\.0\.1)(:\d{1,5})?)$")
FIELDS = {"who", "result", "verdict", "view", "share", "globalShare", "amShare", "lbUpdatedAt"}
RESULTS = {"sweaty", "normal"}
VERDICTS = {"queue", "coin", "wait", "calibrating", "stale", "unknown"}
VIEWS = {"am", "global"}
CONTROL = re.compile(r"[\x00-\x1f\x7f]")


class Log:
    def __init__(self):
        self.lock = threading.Lock()
        self.rows = []
        self.next_id = 1
        self.last_post = {}            # who (lowercased) -> server time of their last tap

    def add(self, row, t):
        with self.lock:
            row = {"id": self.next_id, "t": t, **row}
            self.next_id += 1
            self.rows.append(row)
            self.rows.sort(key=lambda r: (r["t"], r["id"]))
            return row


LOG = Log()
CONFIG = {"code": "test-code", "rate": 30, "delay": 0}


def check_row(body):
    """Return an error string, or None if the body matches the contract."""
    if not isinstance(body, dict):
        return "body must be a JSON object"
    missing = FIELDS - body.keys()
    extra = body.keys() - FIELDS
    if missing:
        return "missing " + ", ".join(sorted(missing))
    if extra:
        return "unexpected " + ", ".join(sorted(extra))
    who = body["who"]
    if not isinstance(who, str) or not 1 <= len(who.strip()) <= 24 or CONTROL.search(who):
        return "who must be 1-24 characters"
    if body["result"] not in RESULTS:
        return "bad result"
    if body["verdict"] not in VERDICTS:
        return "bad verdict"
    if body["view"] not in VIEWS:
        return "bad view"
    for key in ("share", "globalShare", "amShare"):
        v = body[key]
        if v is not None and (isinstance(v, bool) or not isinstance(v, (int, float)) or not 0 <= v <= 1):
            return f"{key} must be a number from 0 to 1, or null"
    lb = body["lbUpdatedAt"]
    if lb is not None and (not isinstance(lb, str) or len(lb) > 40):
        return "lbUpdatedAt must be a short string or null"
    return None


class Handler(BaseHTTPRequestHandler):
    server_version = "RubyRadarMock/1"
    protocol_version = "HTTP/1.1"

    # -- plumbing
    def log_message(self, fmt, *args):
        # The default log prints only the request line and status; no headers.
        print(f"[mock] {self.address_string()} {fmt % args}", flush=True)

    def cors(self):
        origin = self.headers.get("Origin", "")
        if ORIGIN_OK.match(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Squad-Code")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
            self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Vary", "Origin")

    def reply(self, status, obj, extra=None):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def slow(self):
        if CONFIG["delay"]:
            time.sleep(CONFIG["delay"] / 1000)

    def authed(self):
        if not CONFIG["code"]:          # like the Worker without its SQUAD_CODE secret
            self.reply(503, {"error": "squad code not set on the server"})
            return False
        if self.headers.get("X-Squad-Code") != CONFIG["code"]:
            self.reply(401, {"error": "bad squad code"})
            return False
        return True

    # -- routes
    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        self.slow()
        url = urlsplit(self.path)
        if url.path not in ("/api/ping", "/api/lobbies"):
            return self.reply(404, {"error": "not found"})
        if not self.authed():
            return
        if url.path == "/api/ping":
            return self.reply(200, {"ok": True})
        since = parse_qs(url.query).get("since", ["0"])[0]
        try:
            since = int(since)
        except ValueError:
            return self.reply(400, {"error": "since must be unix seconds"})
        with LOG.lock:
            rows = [r for r in LOG.rows if r["t"] >= since]
        self.reply(200, {"lobbies": rows})

    def do_POST(self):
        self.slow()
        if urlsplit(self.path).path != "/api/lobby":
            return self.reply(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(min(length, 8192)) if length else b""
        if not self.authed():
            return
        if length > 2048:
            return self.reply(413, {"error": "body too large"})
        try:
            body = json.loads(raw or b"null")
        except ValueError:
            return self.reply(400, {"error": "body isn't JSON"})
        problem = check_row(body)
        if problem:
            return self.reply(400, {"error": problem})
        now = int(time.time())
        key = body["who"].strip().lower()
        with LOG.lock:
            last = LOG.last_post.get(key)
            if last is not None and now - last < CONFIG["rate"]:
                wait = CONFIG["rate"] - (now - last)
                return self.reply(429, {"error": "too soon", "retryAfter": wait}, {"Retry-After": str(wait)})
            LOG.last_post[key] = now
        row = LOG.add({**body, "who": body["who"].strip()}, now)
        self.reply(201, {"id": row["id"], "t": row["t"]})

    def do_DELETE(self):
        self.slow()
        m = re.fullmatch(r"/api/lobby/(\d+)", urlsplit(self.path).path)
        if not m:
            return self.reply(404, {"error": "not found"})
        if not self.authed():
            return
        lobby_id = int(m.group(1))
        with LOG.lock:
            for i, r in enumerate(LOG.rows):
                if r["id"] == lobby_id:
                    del LOG.rows[i]
                    # An undo frees the tapper to log again straight away.
                    LOG.last_post.pop(r["who"].lower(), None)
                    break
            else:
                return self.reply(404, {"error": "no such lobby"})
        self.reply(200, {"ok": True})


def seed(n, rng):
    """Made-up taps over the last 14 days, mostly in the NA evening.

    WAIT really does mean sweatier lobbies here, so the panel has a story."""
    sweaty_odds = {"queue": 0.25, "coin": 0.45, "wait": 0.72, "calibrating": 0.5, "stale": 0.5, "unknown": 0.5}
    verdicts = ["queue"] * 5 + ["coin"] * 6 + ["wait"] * 5 + ["calibrating"] * 2 + ["stale"]
    people = ["Nathan"] * 6 + ["Kai"] * 5 + ["<img src=x onerror=1>"]   # the last one checks escaping
    now = int(time.time())
    taps = []
    for _ in range(n):
        day = rng.randint(0, 13)
        hour = rng.choice([0, 1, 1, 2, 2, 3, 3, 4, 22, 23, 23])     # UTC: NA evenings
        day_start = (now // 86400 - day) * 86400
        t = min(day_start + hour * 3600 + rng.randint(0, 3599), now - 3600)
        verdict = rng.choice(verdicts)
        g = round(rng.uniform(0.02, 0.07), 4)
        a = round(rng.uniform(0.02, 0.09), 4)
        view = "am" if rng.random() < 0.8 else "global"
        lb = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t - rng.randint(300, 1800)))
        taps.append((t, {
            "who": rng.choice(people),
            "result": "sweaty" if rng.random() < sweaty_odds[verdict] else "normal",
            "verdict": verdict,
            "view": view,
            "share": (a if view == "am" else g) if verdict in ("queue", "coin", "wait") else None,
            "globalShare": g,
            "amShare": a,
            "lbUpdatedAt": lb,
        }))
    for t, row in sorted(taps, key=lambda x: x[0]):   # ids follow time, like the Worker's
        LOG.add(row, t)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--code", default="test-code", help="the squad code (default: test-code)")
    ap.add_argument("--seed-taps", type=int, default=0, help="start with this many made-up taps")
    ap.add_argument("--rate", type=int, default=30, help="seconds between taps from the same name")
    ap.add_argument("--delay", type=int, default=0, help="milliseconds to wait before answering")
    ap.add_argument("--unconfigured", action="store_true", help="act like a Worker with no squad code set (503)")
    args = ap.parse_args()
    CONFIG.update(code="" if args.unconfigured else args.code, rate=args.rate, delay=args.delay)
    if args.seed_taps:
        seed(args.seed_taps, random.Random(5))
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[mock] lobby log on http://localhost:{args.port} ({len(LOG.rows)} taps; Ctrl-C to stop)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
