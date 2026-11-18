"""Standard-library-only native host. stdout is exclusively Chrome's framed protocol."""
from __future__ import annotations

import argparse
from contextlib import closing
import json
import math
import os
from pathlib import Path
import sqlite3
import struct
import sys

LOCAL_DATA = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
DEFAULT_DATA = LOCAL_DATA / "Video Ledger"
MAX_MESSAGE = 1_000_000
SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS sessions (
 id TEXT PRIMARY KEY, site TEXT NOT NULL, started_ms INTEGER NOT NULL,
 ended_ms INTEGER, last_seen_ms INTEGER NOT NULL, end_reason TEXT
);
CREATE TABLE IF NOT EXISTS samples (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), site TEXT NOT NULL,
 start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
 foreground_ms INTEGER NOT NULL, playback_ms INTEGER NOT NULL, background_ms INTEGER NOT NULL,
 video_id TEXT, url TEXT, title TEXT NOT NULL, creator TEXT NOT NULL, duration_sec REAL
);
CREATE INDEX IF NOT EXISTS samples_time ON samples(start_ms, end_ms);
CREATE INDEX IF NOT EXISTS samples_session ON samples(session_id);
CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY);
PRAGMA user_version=1;
"""


def connect(data_dir: Path) -> sqlite3.Connection:
    data_dir.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(data_dir / "history.sqlite3", timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript(SCHEMA)
    return db


def number(value, minimum=0, maximum=10**15):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError("Invalid number")
    return value


def string(value, limit=1000):
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError("Invalid text")
    return value


def ingest(db, events):
    if not isinstance(events, list) or not 1 <= len(events) <= 100:
        raise ValueError("Expected 1–100 events")
    ack = []
    with db:
        for event in events:
            event_id = string(event["id"], 200)
            ack.append(event_id)
            if db.execute("SELECT 1 FROM receipts WHERE id=?", (event_id,)).fetchone():
                continue
            session_id = string(event["session_id"], 100)
            site = event["site"]
            if site not in ("youtube", "bilibili"):
                raise ValueError("Unsupported site")
            kind = event["kind"]
            if kind == "start":
                at = number(event["at"])
                db.execute("INSERT OR IGNORE INTO sessions(id,site,started_ms,last_seen_ms) VALUES(?,?,?,?)", (session_id, site, at, at))
            elif kind == "end":
                at = number(event["at"])
                if not db.execute("SELECT 1 FROM sessions WHERE id=?", (session_id,)).fetchone():
                    raise ValueError("Unknown session")
                db.execute("UPDATE sessions SET ended_ms=MAX(started_ms,?),end_reason=? WHERE id=?", (at, string(event["reason"], 40), session_id))
            elif kind == "sample":
                session = db.execute("SELECT site FROM sessions WHERE id=?", (session_id,)).fetchone()
                if session is not None and session["site"] != site:
                    raise ValueError("Sample site does not match its session")
                start, end = number(event["start_ms"]), number(event["end_ms"])
                span = number(end - start, 0, 60000)
                foreground = number(event["foreground_ms"], 0, span + 100)
                playback = number(event["playback_ms"], 0, span + 100)
                background = number(event["background_ms"], 0, playback)
                video_id = string(event["video_id"], 200) if event.get("video_id") else None
                url = string(event["url"], 2000) if event.get("url") else None
                # URLs are metadata, never commands or file paths.
                prefix = "https://www.youtube.com/watch?" if site == "youtube" else "https://www.bilibili.com/video/"
                if url and not url.startswith(prefix):
                    raise ValueError("Unexpected video URL")
                duration = number(event["duration_sec"], 0, 10**9) if event.get("duration_sec") is not None else None
                db.execute("INSERT INTO samples VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (
                    event_id, session_id, site, start, end, round(foreground), round(playback), round(background),
                    video_id, url, string(event.get("title", "")), string(event.get("creator", "")), duration,
                ))
                db.execute("UPDATE sessions SET last_seen_ms=MAX(last_seen_ms,?) WHERE id=?", (end, session_id))
            else:
                raise ValueError("Unknown event kind")
            db.execute("INSERT INTO receipts VALUES(?)", (event_id,))
    return {"ok": True, "ack": ack}


def report(db, buckets, offset=0):
    if not isinstance(buckets, list) or not 1 <= len(buckets) <= 366:
        raise ValueError("Expected 1–366 day buckets")
    days = []
    for bucket in buckets:
        start, end = number(bucket["start"]), number(bucket["end"])
        number(end - start, 1, 27 * 3600000)
        label = string(bucket["label"], 30)
        for site in ("youtube", "bilibili"):
            # Proportionally split a checkpoint straddling midnight / date boundaries.
            row = db.execute("""
                SELECT COALESCE(SUM(foreground_ms * 1.0 * (MIN(end_ms,?)-MAX(start_ms,?))/MAX(1,end_ms-start_ms)),0) foreground_ms,
                       COALESCE(SUM(playback_ms * 1.0 * (MIN(end_ms,?)-MAX(start_ms,?))/MAX(1,end_ms-start_ms)),0) playback_ms,
                       COALESCE(SUM(background_ms * 1.0 * (MIN(end_ms,?)-MAX(start_ms,?))/MAX(1,end_ms-start_ms)),0) background_ms
                FROM samples WHERE site=? AND end_ms>? AND start_ms<?
            """, (end, start, end, start, end, start, site, start, end)).fetchone()
            visits = db.execute("SELECT COUNT(*) FROM sessions WHERE site=? AND started_ms>=? AND started_ms<?", (site, start, end)).fetchone()[0]
            days.append({"day": label, "site": site, "visits": visits, **dict(row)})
    start = min(b["start"] for b in buckets)
    end = max(b["end"] for b in buckets)
    offset = int(number(offset, 0, 10**7))
    history = db.execute("""
        SELECT s.session_id, s.site, s.video_id,
               (SELECT m.title FROM samples m WHERE m.session_id=s.session_id AND m.video_id=s.video_id
                AND m.title!='' ORDER BY m.end_ms DESC LIMIT 1) title,
               (SELECT m.creator FROM samples m WHERE m.session_id=s.session_id AND m.video_id=s.video_id
                AND m.creator!='' ORDER BY m.end_ms DESC LIMIT 1) creator,
               MAX(s.url) url, MAX(s.duration_sec) duration_sec,
               MAX(MIN(s.start_ms),?) first_seen, MIN(MAX(s.end_ms),?) last_seen,
               SUM(s.playback_ms * 1.0 * (MIN(s.end_ms,?)-MAX(s.start_ms,?))/MAX(1,s.end_ms-s.start_ms)) playback_ms,
               SUM(s.background_ms * 1.0 * (MIN(s.end_ms,?)-MAX(s.start_ms,?))/MAX(1,s.end_ms-s.start_ms)) background_ms
        FROM samples s WHERE s.video_id IS NOT NULL AND s.end_ms>? AND s.start_ms<?
        GROUP BY s.session_id,s.site,s.video_id ORDER BY first_seen DESC LIMIT 101 OFFSET ?
    """, (start, end, end, start, end, start, start, end, offset)).fetchall()
    sessions = db.execute("""SELECT * FROM sessions WHERE started_ms>=? AND started_ms<?
        ORDER BY started_ms DESC LIMIT 100""", (start, end)).fetchall()
    return {"ok": True, "days": days, "history": [dict(r) for r in history[:100]], "has_more": len(history) > 100,
            "sessions": [dict(r) for r in sessions]}


def handle(db, message):
    if message.get("op") == "ingest":
        return ingest(db, message.get("events"))
    if message.get("op") == "report":
        return report(db, message.get("buckets"), message.get("offset", 0))
    if message.get("op") == "ping":
        return {"ok": True, "version": 1}
    raise ValueError("Unknown operation")


def read_exact(stream, size):
    result = bytearray()
    while len(result) < size:
        chunk = stream.read(size - len(result))
        if not chunk:
            raise EOFError("Incomplete native message")
        result.extend(chunk)
    return bytes(result)


def serve(db, source, target):
    while True:
        header = source.read(4)
        if not header:
            return
        if len(header) < 4:
            header += read_exact(source, 4 - len(header))
        size = struct.unpack("<I", header)[0]
        if size > MAX_MESSAGE:
            raise ValueError("Native message too large")
        try:
            result = handle(db, json.loads(read_exact(source, size)))
        except (ValueError, TypeError, KeyError, sqlite3.Error) as error:
            result = {"ok": False, "error": str(error)}
        output = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(output) > MAX_MESSAGE:
            output = b'{"ok":false,"error":"Response exceeds native message limit"}'
        target.write(struct.pack("<I", len(output)) + output)
        target.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--check", action="store_true")
    args, _ = parser.parse_known_args()  # Chrome appends extension origin / parent-window arguments.
    if sys.platform == "win32":
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    with closing(connect(args.data_dir)) as db:
        if args.check:
            print(json.dumps({"ok": True, "database": str(args.data_dir / "history.sqlite3")}))
        else:
            serve(db, sys.stdin.buffer, sys.stdout.buffer)


if __name__ == "__main__":
    main()
