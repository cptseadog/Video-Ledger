import io
import json
from pathlib import Path
import sqlite3
import struct
import tempfile
import unittest

from native.host import connect, handle, read_exact, serve


class HostTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = connect(Path(self.temp.name))
        self.start = {"kind": "start", "id": "start-1", "session_id": "session-1", "site": "youtube", "at": 1000}
        self.sample = {"kind": "sample", "id": "sample-1", "session_id": "session-1", "site": "youtube",
                       "start_ms": 1000, "end_ms": 11000, "foreground_ms": 8000, "playback_ms": 6000,
                       "background_ms": 2000, "video_id": "abc", "url": "https://www.youtube.com/watch?v=abc",
                       "title": "测试视频 🎬", "creator": "Creator", "duration_sec": 120}

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def ingest(self, *events):
        return handle(self.db, {"op": "ingest", "events": list(events)})

    def test_retry_is_idempotent(self):
        self.ingest(self.start, self.sample)
        result = self.ingest(self.start, self.sample)
        self.assertEqual(result["ack"], ["start-1", "sample-1"])
        self.assertEqual(self.db.execute("SELECT SUM(playback_ms) FROM samples").fetchone()[0], 6000)

    def test_invalid_batch_rolls_back_and_can_be_retried(self):
        with self.assertRaises(ValueError):
            self.ingest(self.start, {**self.sample, "playback_ms": 50000})
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0], 0)
        self.ingest(self.start, self.sample)

    def test_unknown_session_rejected(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.ingest(self.sample)

    def test_midnight_split_and_visits(self):
        self.ingest(self.start, self.sample)
        result = handle(self.db, {"op": "report", "buckets": [
            {"label": "day1", "start": 0, "end": 6000}, {"label": "day2", "start": 6000, "end": 12000}]})
        first, second = result["days"][0], result["days"][2]
        self.assertEqual(first["playback_ms"], 3000)
        self.assertEqual(second["playback_ms"], 3000)
        self.assertEqual(first["visits"], 1)
        self.assertEqual(second["visits"], 0)
        self.assertEqual(result["history"][0]["title"], "测试视频 🎬")

    def test_session_ends_and_remains_on_reopen(self):
        self.ingest(self.start, self.sample, {"kind": "end", "id": "end-1", "session_id": "session-1", "site": "youtube", "at": 12000, "reason": "closed"})
        self.db.close()
        self.db = connect(Path(self.temp.name))
        row = self.db.execute("SELECT * FROM sessions").fetchone()
        self.assertEqual(row["ended_ms"], 12000)

    def test_history_clips_range_and_uses_latest_title(self):
        self.ingest(self.start, self.sample, {**self.sample, "id": "sample-2", "title": "Actual title", "start_ms": 11000, "end_ms": 21000})
        result = handle(self.db, {"op": "report", "buckets": [{"label": "slice", "start": 6000, "end": 16000}]})
        self.assertEqual(result["history"][0]["playback_ms"], 6000)
        self.assertEqual(result["history"][0]["title"], "Actual title")

    def test_native_protocol_unicode_and_multiple_frames(self):
        def frame(message):
            encoded = json.dumps(message).encode()
            return struct.pack("<I", len(encoded)) + encoded
        source = io.BytesIO(frame({"op": "ingest", "events": [self.start, self.sample]}) + frame({"op": "ping"}))
        target = io.BytesIO()
        serve(self.db, source, target)
        target.seek(0)
        for _ in range(2):
            size = struct.unpack("<I", target.read(4))[0]
            self.assertTrue(json.loads(target.read(size))["ok"])
        self.assertEqual(target.read(), b"")

    def test_bad_operation_returns_protocol_error(self):
        payload = b'{"op":"bad"}'
        target = io.BytesIO()
        serve(self.db, io.BytesIO(struct.pack("<I", len(payload)) + payload), target)
        self.assertFalse(json.loads(target.getvalue()[4:])["ok"])

    def test_partial_stream_reads(self):
        class SmallReads(io.BytesIO):
            def read(self, size=-1):
                return super().read(min(size, 2))
        self.assertEqual(read_exact(SmallReads(b"abcdef"), 6), b"abcdef")

    def test_limits_and_unsafe_url(self):
        with self.assertRaises(ValueError):
            self.ingest(self.start, {**self.sample, "url": "javascript:alert(1)"})
        with self.assertRaises(ValueError):
            self.ingest({**self.start, "at": float("nan")})


if __name__ == "__main__":
    unittest.main()
