/* Run with PLAYWRIGHT_MODULE and BROWSER_EXECUTABLE pointing to local installations. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const results = path.join(root, 'test-results');
fs.mkdirSync(results, { recursive: true });

(async () => {
  const profile = fs.mkdtempSync(path.join(results, 'browser-'));
  const extension = path.join(root, 'extension');
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.BROWSER_EXECUTABLE,
    headless: true, viewport: { width: 1360, height: 1000 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
    const id = new URL(worker.url()).hostname;
    console.log('Extension loaded:', id);
    if (process.env.VERIFY_NATIVE === '1') {
      const ping = await worker.evaluate(() => chrome.runtime.sendNativeMessage('com.seadog.video_ledger', { op: 'ping' }));
      assert.equal(ping.ok, true);
      console.log('PASS: real browser-to-native-helper connection');
    }
    // Never save fixture visits into the user's real database, even if the host is installed.
    await worker.evaluate(() => { chrome.runtime.sendNativeMessage = async () => { throw new Error('Fixture: helper offline'); }; });
    const errors = [];
    context.on('weberror', error => errors.push(error.error().message));
    // A real, silent media stream exercises playback in the isolated content-script world.
    const wav = Buffer.alloc(44 + 8000 * 30, 128);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
    wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
    const fixture = `<!doctype html><title>Fixture Video - YouTube</title>
      <h1 class="title">Fixture video</h1><div id="owner"><div id="channel-name"><a>Fixture creator</a></div></div>
      <div id="movie_player"><video autoplay muted loop src="data:audio/wav;base64,${wav.toString('base64')}"></video></div><a id="child" href="https://www.youtube.com/watch?v=child" target="_blank">Child video</a>`;
    await context.route('https://www.youtube.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture }));
    await context.route('https://www.bilibili.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><title>Bilibili fixture</title><h1 class="video-title">测试视频</h1><a class="up-name">测试作者</a><div class="bpx-player-video-wrap"><video autoplay muted loop src="data:audio/wav;base64,${wav.toString('base64')}"></video></div>` }));
    const read = () => worker.evaluate(async () => (await chrome.storage.local.get('ledger')).ledger);
    const page = await context.newPage();
    await page.goto('https://www.youtube.com/watch?v=ordinary');
    const regularTabId = await worker.evaluate(async () => (await chrome.tabs.query({})).find(t => t.url?.includes('v=ordinary')).id);
    assert.equal(await worker.evaluate(async tabId => (await chrome.scripting.executeScript({ target: { tabId }, func: () => !!globalThis.__videoLedger }))[0].result, regularTabId), false);
    let data = await read();
    assert.equal(Object.keys(data?.active || {}).length, 0);
    await page.goto('https://www.youtube.com/?bht_launch=1');
    await page.waitForFunction(() => !location.search.includes('bht_launch'));
    data = await read();
    assert.equal(Object.keys(data.active).length, 1);
    await page.goto('https://www.youtube.com/watch?v=parent');
    const childPromise = context.waitForEvent('page');
    await page.locator('#child').click();
    const child = await childPromise;
    await child.waitForLoadState();
    await child.waitForTimeout(12000);
    data = await read();
    assert.ok(data.outbox.some(e => e.kind === 'sample' && e.video_id === 'child' && e.playback_ms > 0), 'Child video playback recorded');
    assert.ok(data.outbox.some(e => e.kind === 'sample' && e.foreground_ms > 0), 'Foreground website time recorded');
    assert.equal(data.outbox.filter(e => e.kind === 'start').length, 1, 'Child tab does not increment visits');
    await page.close();
    await child.waitForTimeout(400);
    assert.equal(Object.keys((await read()).active).length, 1, 'Child keeps session alive');
    await child.close();
    await new Promise(resolve => setTimeout(resolve, 500));
    data = await read();
    assert.equal(Object.keys(data.active).length, 0);
    assert.equal(data.outbox.filter(e => e.kind === 'end').length, 1);
    const bilibili = await context.newPage();
    await bilibili.goto('https://www.bilibili.com/?bht_launch=1');
    await bilibili.waitForFunction(() => !location.search.includes('bht_launch'));
    assert.equal(Object.values((await read()).active)[0].site, 'bilibili');
    await bilibili.goto('https://www.bilibili.com/video/BV123456/?p=2');
    await bilibili.waitForTimeout(12000);
    const biliSample = (await read()).outbox.find(e => e.kind === 'sample' && e.video_id === 'BV123456:p2');
    assert.ok(biliSample?.playback_ms > 0, 'Bilibili playback recorded');
    assert.equal(biliSample.title, '测试视频');
    assert.equal(biliSample.creator, '测试作者');
    assert.equal(biliSample.duration_sec, 30);
    await bilibili.goto('about:blank');
    await bilibili.waitForTimeout(400);
    assert.equal(Object.keys((await read()).active).length, 0, 'Leaving the website ends tracking');
    await bilibili.goto('https://www.bilibili.com/');
    assert.equal(Object.keys((await read()).active).length, 0, 'Returning without the launcher stays untracked');
    await bilibili.close();
    // Exercise the real dashboard with a deterministic local native-host stand-in.
    await worker.evaluate(() => {
      chrome.runtime.sendNativeMessage = async (_host, message) => {
        if (message.op === 'ingest') return { ok: true, ack: message.events.map(e => e.id) };
        return { ok: true, days: message.buckets.flatMap((b,i) => ['youtube','bilibili'].map((site,j) => ({ day:b.label,site,visits:i+1,foreground_ms:(i+1)*60000*(j+1),playback_ms:(i+1)*45000,background_ms:10000 }))),
          history:[{session_id:'fixture',site:'youtube',video_id:'parent',title:'A sample video — dashboard layout check',creator:'Example creator',url:'https://www.youtube.com/watch?v=parent',first_seen:Date.now(),duration_sec:120,playback_ms:65000}],sessions:[],has_more:false };
      };
    });
    const dashboard = await context.newPage();
    await dashboard.goto(`chrome-extension://${id}/dashboard.html`);
    await dashboard.locator('#foreground').filter({ hasText: /\d/ }).waitFor();
    assert.equal(await dashboard.locator('#history tr').count(), 1);
    await dashboard.screenshot({ path: path.join(results, 'dashboard-desktop.png'), fullPage: true });
    await dashboard.setViewportSize({ width: 600, height: 950 });
    await dashboard.screenshot({ path: path.join(results, 'dashboard-narrow.png'), fullPage: true });
    assert.equal(await dashboard.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'No page overflow');
    assert.deepEqual(errors, []);
    console.log('PASS: launcher-only tracking, child tab lifecycle, playback buffering, Bilibili launcher, dashboard rendering.');
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
