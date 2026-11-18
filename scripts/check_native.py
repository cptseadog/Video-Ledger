"""Verify the exact generated launcher and native framing, without recording a visit."""
import json
from pathlib import Path
import struct
import subprocess
import queue
import threading

root = Path(__file__).resolve().parent.parent
manifest_path = root / "native/generated/check/com.seadog.video_ledger.json"
if not manifest_path.is_file():
    raise SystemExit("Run scripts/install.ps1 -PrepareOnly before checking the native launcher.")
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
payload = b'{"op":"ping"}'
try:
    process = subprocess.Popen(
        [manifest["path"]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
except OSError as error:
    raise SystemExit(f"Could not start the prepared native launcher: {error}") from error
responses = queue.Queue()
def reader():
    try:
        for _ in range(2):
            length = struct.unpack("<I", process.stdout.read(4))[0]
            responses.put(json.loads(process.stdout.read(length)))
    except Exception as error:
        responses.put(error)
threading.Thread(target=reader, daemon=True).start()
try:
    for _ in range(2):
        process.stdin.write(struct.pack("<I", len(payload)) + payload)
        process.stdin.flush()
        # Keep stdin open, exactly as Chrome does while waiting for the response.
        assert responses.get(timeout=15) == {"ok": True, "version": 1}
    process.stdin.close()
    assert process.wait(timeout=5) == 0, process.stderr.read().decode(errors="replace")
finally:
    if process.poll() is None:
        process.kill()
        process.wait(timeout=5)
print("PASS: generated Windows launcher, interactive native framing, and clean shutdown")
