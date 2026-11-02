# Video Ledger

A local Chrome extension for intentional YouTube and Bilibili sessions. Launch a site through its New Tab shortcut, browse normally, and close its last tracked tab to end the visit. Opening a site through an ordinary URL does not start tracking.

## Install on this Windows computer

1. In PowerShell, run:

   ```powershell
   Set-Location 'D:\dev\Documents\seadog\browse-history-tracker'
   .\scripts\install.ps1
   ```

   This uses `uv` to create a Python 3.12 environment, compiles a tiny native messaging launcher with Windows' built-in .NET Framework compiler, creates the database if absent, and registers **only this helper** under the current user's Chrome native-messaging registry key. Administrator privileges are not needed. No Python dependencies or persistent server are required. The extension has a fixed public key, so its ID remains stable if the source folder moves.

2. Open `chrome://extensions` in Chrome, enable **Developer mode**, select **Load unpacked**, and choose:

   ```text
   D:\dev\Documents\seadog\browse-history-tracker\extension
   ```

   Expected extension ID: `lmnpejcbbmondenejkiacaamgdpjblha`. Allow access to the two supported sites; otherwise Chrome cannot inject the recorder.

3. On Chrome's New Tab page, choose **Add shortcut** and add:

   | Name | URL |
   | --- | --- |
   | YouTube | `https://www.youtube.com/?bht_launch=1` |
   | Bilibili | `https://www.bilibili.com/?bht_launch=1` |

   If Add shortcut is hidden, use **Customize Chrome → Shortcuts → My shortcuts**. The extension does not replace your New Tab page or automatically edit its shortcut list.

4. Pin **Video Ledger** from Chrome's Extensions menu. Clicking its toolbar icon opens the history dashboard, with the same two launch buttons and copyable shortcut URLs.

5. Open a launcher, watch a regular video for 15–30 seconds, close its tab, and open the dashboard. The visit and video should appear with **0 buffered records**. A helper error instead means records remain safely buffered until setup is repaired. Click **Refresh** to retry.

The `REC` badge identifies tracked tabs. Reloading the extension or restarting the browser ends existing tracking; use a launcher again. Reloading a tracked website tab preserves its session.

## What gets measured

- **Visits:** one new launcher session. Same-site child tabs opened from a tracked tab inherit that session and do not add another visit. Closing the last tracked tab ends it. Navigating a tracked tab to another site removes it from the session. A cross-site link does not activate the other site's tracker.
- **Website time:** time the tracked page is visible and focused, including recommendations and comments. After five minutes without input, time stops if no supported video is playing. Only the focused page contributes foreground time.
- **Playback:** actual elapsed time with regular video progress. A 20-minute video watched at 2× contributes about 10 minutes. Pauses, buffering, and seeking do not add artificial playback. Replays do add time.
- **Background playback:** the part of playback outside the focused page, including picture-in-picture. It is already included in playback. Multiple simultaneous videos count separately, so playback can exceed elapsed wall time.
- **Video history:** title, creator when available, canonical URL, nominal duration, first/last observation, and playback totals per video per visit. Bilibili multipart videos use separate part IDs. Shorts, live streams, and Bilibili series pages are outside initial video-metadata support; their foreground website time can still count in a tracked session.

Website time and playback overlap. Do not add them together. The dashboard has today, seven-day, thirty-day, and custom date ranges (up to 366 days), daily totals, per-site chart tooltips, video-history pagination, and the latest 100 session starts. Dates follow the browser's local timezone, including daylight-saving transitions.

## Storage and resource use

The database lives at:

```text
D:\dev\Documents\Ivan\data\browse-history-tracker\history.sqlite3
```

Data flows from the injected recorder to a persistent `chrome.storage.local` outbox, then through Chrome native messaging to Python/SQLite. SQLite commits a batch before returning acknowledgements. Unique event IDs make retries safe. No browsing data is sent to a cloud service, no local network port is opened, and no external assets or analytics are loaded by the dashboard.

Tracked pages checkpoint around every 10 seconds and on lifecycle/media transitions. The worker batches saves about every 30 seconds during activity, and also on tab closure or dashboard refresh. The Python helper starts for a request and exits; it is not a background service. The extension has no timer or content script running on unrelated pages. Lightweight browser-event listeners can briefly wake its worker during ordinary browsing, so overhead is small rather than literally zero.

If the helper is missing, records remain in the browser buffer. Retry happens on later recording activity, tab closure, browser startup, or dashboard refresh. There is no perpetual retry timer. Removing the extension deletes this buffer and settings, **not the SQLite file**. Confirm a successful save and zero buffered records before removing the extension.

After a crash, the last uncheckpointed seconds may be missing (normally up to about 10 seconds per tab). Severe background timer throttling and sleep gaps are conservatively discarded, so playback is an estimate. The recorder measures browser activity, not whether a person was actually paying attention. Live site layouts can change; title/creator selectors may require updates.

For backups, close tracked tabs and the dashboard, then copy `history.sqlite3` and any adjacent `-wal` / `-shm` files together, or use SQLite's backup API. Keep the database separate from the extension source. The installer accepts `-DataDir` for a different database directory; the dashboard's explanatory default-path text would also need updating.

## Development and verification

Production code has no Node build step and no third-party Python packages.

```powershell
.\scripts\test.ps1
.\scripts\install.ps1 -PrepareOnly
uv run python scripts/check_native.py
```

`-PrepareOnly` prepares files and checks the database without writing the registry. `check_native.py` verifies the actual generated Windows launcher and binary messaging protocol with a ping; it adds no browsing records.

The deterministic suite covers URL scoping, playback speed/seeks, child-tab session lifetime, buffer recovery, restart recovery, unauthorized messages, SQLite retry deduplication, transaction rollback, Unicode protocol messages, date-boundary splitting, and durable history.

`tests/browser.cjs` additionally loads the unpacked extension in an isolated temporary Chromium/Edge profile and exercises real media-element playback on controlled YouTube/Bilibili fixtures, ordinary untracked visits, child tabs, and the dashboard at desktop/narrow sizes. It requires a locally installed Playwright module and an extension-capable browser:

```powershell
$env:PLAYWRIGHT_MODULE = 'C:\path\to\node_modules\playwright'
$env:BROWSER_EXECUTABLE = 'C:\path\to\msedge.exe'
node --preserve-symlinks --preserve-symlinks-main tests/browser.cjs
```

Screenshots and disposable browser profiles are written under `test-results/`. Browser tests use fixture data and a mocked native response for dashboard rendering; they do not prove compatibility with every current live-site layout or Chrome profile configuration. A manual live-site check from step 5 remains part of installation.

## Uninstall / troubleshooting

- Remove Video Ledger from `chrome://extensions` to stop recording.
- Run `scripts/unregister.ps1` to remove only the native helper's registry registration. The SQLite history, environment, and source files remain.
- For **Specified native messaging host not found**, rerun `scripts/install.ps1` as the same Windows user who runs Chrome.
- For **Access to the specified native messaging host is forbidden**, verify the extension ID matches the one above and reload the intended extension folder.
- If the project folder moves, rerun the installer so its launcher paths are updated.
- If website time remains zero, check the `REC` badge and confirm you used the marked launcher URL with site access enabled.
- Chrome restart/reload does not silently start tracking restored tabs; open a launcher for a new session.

## Files

- `extension/background.js`: session membership, restricted injection, persistent outbox, native messaging.
- `extension/collector.js`, `metrics.js`: page/video observations and elapsed-time accounting.
- `extension/dashboard.*`: local history, totals, date ranges, and setup.
- `native/host.py`: framed native protocol, SQLite schema, ingestion, reports.
- `native/Launcher.cs`: small Windows executable bridging Chrome's binary pipes to Python without a console window.
- `scripts/`: Windows setup, host check, and test runner.
