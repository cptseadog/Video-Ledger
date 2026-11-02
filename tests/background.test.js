import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { HOST, LAUNCHERS, siteOf, isLauncher } from '../extension/core.js';
const source = (await readFile(new URL('../extension/background.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/, '');
function harness(persisted = {}) {
  const events = {}, injections = [], saved = structuredClone(persisted);
  let nativeWorks = false;
  const register = name => ({ addListener(fn) { events[name] = fn; } });
  const area = key => ({
    async get(name) { return { [name]: structuredClone(saved[key]?.[name]) }; },
    async set(value) { saved[key] = { ...saved[key], ...structuredClone(value) }; },
  });
  const chrome = {
    storage: { local: area('local'), session: area('session') },
    scripting: { async executeScript(args) { injections.push(args); } },
    action: { async setBadgeText() {}, onClicked: register('action') },
    webNavigation: Object.fromEntries(['onCommitted','onDOMContentLoaded','onCreatedNavigationTarget'].map(k => [k, register(k)])),
    tabs: { onCreated: register('created'), onRemoved: register('removed'), onUpdated: register('updated'), async create() {} },
    runtime: { onStartup: register('startup'), onMessage: register('message'), getURL: p => `chrome-extension://test/${p}`,
      async sendNativeMessage(host, message) {
        assert.equal(host, HOST);
        if (!nativeWorks) throw new Error('Host not installed');
        return { ok: true, ack: message.events.map(e => e.id) };
      } },
  };
  const context = vm.createContext({ chrome, HOST, LAUNCHERS, siteOf, isLauncher, crypto: webcrypto, console, Date, URL });
  vm.runInContext(source, context);
  return { saved, injections, setNative(value) { nativeWorks = value; },
    async fire(name, ...args) { events[name](...args); await vm.runInContext('chain', context); },
    async message(message, sender = { url: 'chrome-extension://test/dashboard.html' }) { return new Promise(resolve => events.message(message, sender, resolve)); },
  };
}
const launch = { tabId: 1, frameId: 0, url: LAUNCHERS.youtube };
test('ordinary visits inject nothing; launcher starts one durable visit', async () => {
  const h = harness();
  await h.fire('onCommitted', { ...launch, url: 'https://www.youtube.com/' });
  assert.equal(h.injections.length, 0);
  await h.fire('onCommitted', launch);
  await h.fire('onCommitted', launch);
  assert.equal(h.saved.local.ledger.outbox.filter(e => e.kind === 'start').length, 1);
  assert.equal(Object.keys(h.saved.session.tracking.tabs).length, 1);
});
test('child tabs share a visit and only the last close ends it', async () => {
  const h = harness();
  await h.fire('onCommitted', launch);
  await h.fire('created', { id: 2, openerTabId: 1, url: 'https://www.youtube.com/watch?v=x' });
  await h.fire('removed', 1);
  assert.equal(h.saved.local.ledger.outbox.filter(e => e.kind === 'end').length, 0);
  await h.fire('removed', 2);
  assert.equal(h.saved.local.ledger.outbox.filter(e => e.kind === 'end').length, 1);
  assert.equal(Object.keys(h.saved.local.ledger.active).length, 0);
});
test('failed saves retain buffer until explicit acknowledgement', async () => {
  const h = harness();
  await h.fire('onCommitted', launch);
  assert.equal(h.saved.local.ledger.outbox.length, 1);
  assert.match(h.saved.local.ledger.error, /Host not installed/);
  h.setNative(true);
  const result = await h.message({ type: 'status' });
  assert.equal(result.buffered, 0);
  assert.ok(result.lastSaved);
});
test('leaving the allowed site ends tracking without tabs permission', async () => {
  const h = harness();
  await h.fire('onCommitted', launch);
  await h.fire('onCommitted', { tabId: 1, frameId: 0, url: 'https://example.com/' });
  assert.equal(Object.keys(h.saved.session.tracking.tabs).length, 0);
  assert.equal(h.saved.local.ledger.outbox.find(e => e.kind === 'end').reason, 'left_site');
  await h.fire('onCommitted', { tabId: 1, frameId: 0, url: 'https://www.youtube.com/' });
  assert.equal(Object.keys(h.saved.session.tracking.tabs).length, 0);
});
test('browser restart closes previous session at its last observation', async () => {
  const h = harness();
  await h.fire('onCommitted', launch);
  const previous = structuredClone(h.saved);
  delete previous.session;
  const restored = harness(previous);
  await restored.fire('startup');
  const end = restored.saved.local.ledger.outbox.find(e => e.kind === 'end');
  assert.equal(end.reason, 'interrupted');
  assert.equal(end.at, Object.values(previous.local.ledger.active)[0].last_seen);
  assert.equal(Object.keys(restored.saved.session.tracking.tabs).length, 0);
});
test('untracked tabs cannot submit records or ask the host for reports', async () => {
  const h = harness();
  const sender = { tab: { id: 9 }, frameId: 0, url: 'https://www.youtube.com/' };
  assert.equal((await h.message({ type: 'samples', events: [] }, sender)).ok, false);
  assert.equal((await h.message({ type: 'report', buckets: [] }, sender)).ok, false);
});
