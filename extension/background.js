import { HOST, LAUNCHERS, siteOf, isLauncher } from './core.js';

let state, local, chain = Promise.resolve();
let lastAttempt = 0;
const uuid = () => crypto.randomUUID();
const navigationFilter = { url: [{ hostEquals: 'www.youtube.com', schemes: ['https'] }, { hostEquals: 'www.bilibili.com', schemes: ['https'] }] };

function serial(fn) {
  const next = chain.then(async () => { await init(); return fn(); });
  chain = next.catch(error => console.warn('Video Ledger:', error.message));
  return next;
}
async function init() {
  if (state) return;
  local = (await chrome.storage.local.get('ledger')).ledger || { outbox: [], active: {}, lastSaved: null, error: null };
  const saved = (await chrome.storage.session.get('tracking')).tracking;
  state = saved || { tabs: {}, sessions: {} };
  if (!saved) {
    // Browser restart / extension reload: tab IDs are not durable identities.
    for (const s of Object.values(local.active)) {
      local.outbox.push({ kind: 'end', id: uuid(), session_id: s.id, site: s.site, at: s.last_seen, reason: 'interrupted' });
    }
    local.active = {};
    await persist();
  }
}
async function persist() {
  await chrome.storage.local.set({ ledger: local });
  await chrome.storage.session.set({ tracking: state });
}
function touch(sessionId, at) {
  const s = state.sessions[sessionId];
  if (s) {
    s.last_seen = Math.max(s.last_seen, at);
    local.active[sessionId] = { ...s };
  }
}
async function flush(force = false) {
  if (!local.outbox.length || (!force && Date.now() - lastAttempt < 30000)) return;
  lastAttempt = Date.now();
  try {
    while (local.outbox.length) {
      const batch = local.outbox.slice(0, 100);
      const result = await chrome.runtime.sendNativeMessage(HOST, { op: 'ingest', events: batch });
      if (!result?.ok || result.ack?.length !== batch.length || batch.some(e => !result.ack.includes(e.id))) {
        throw new Error(result?.error || 'Helper did not acknowledge all records.');
      }
      local.outbox.splice(0, batch.length);
      local.lastSaved = Date.now();
      local.error = null;
      await persist();
    }
  } catch (error) {
    local.error = error.message;
    await persist();
  }
}
async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['metrics.js', 'collector.js'] });
  } catch { /* A tab may close or navigate before injection. */ }
}
async function start(tabId, site) {
  if (state.tabs[tabId]) return;
  const at = Date.now(), id = uuid();
  const session = { id, site, started: at, last_seen: at };
  state.sessions[id] = session;
  state.tabs[tabId] = { session: id, site };
  local.active[id] = { ...session };
  local.outbox.push({ kind: 'start', id: uuid(), session_id: id, site, at });
  await persist();
  await chrome.action.setBadgeText({ tabId, text: 'REC' });
  await flush();
}
async function detach(tabId, reason = 'closed') {
  const tracked = state.tabs[tabId];
  if (!tracked) return;
  delete state.tabs[tabId];
  if (!Object.values(state.tabs).some(t => t.session === tracked.session)) {
    const s = state.sessions[tracked.session];
    local.outbox.push({ kind: 'end', id: uuid(), session_id: s.id, site: s.site, at: Date.now(), reason });
    delete state.sessions[s.id];
    delete local.active[s.id];
  }
  await persist();
  await flush(true);
}
async function inherit(sourceTabId, targetTabId, url) {
  const parent = state.tabs[sourceTabId];
  if (!parent || state.tabs[targetTabId]) return;
  // about:blank can be a temporary child-tab URL; inject only after a supported navigation.
  if (url && url !== 'about:blank' && siteOf(url) !== parent.site) return;
  state.tabs[targetTabId] = { ...parent };
  await persist();
  await chrome.action.setBadgeText({ tabId: targetTabId, text: 'REC' }).catch(() => {});
  if (siteOf(url)) await inject(targetTabId);
}

chrome.webNavigation.onCommitted.addListener(details => {
  if (details.frameId !== 0) return;
  serial(async () => {
    // webNavigation exposes committed URLs without the broad tabs permission.
    // tabs.onUpdated can omit URLs when a tracked tab leaves our allowed hosts.
    if (state.tabs[details.tabId] && state.tabs[details.tabId].site !== siteOf(details.url)) {
      await detach(details.tabId, 'left_site');
      await chrome.action.setBadgeText({ tabId: details.tabId, text: '' }).catch(() => {});
    }
    if (isLauncher(details.url)) await start(details.tabId, siteOf(details.url));
    const tracked = state.tabs[details.tabId];
    if (tracked && tracked.site === siteOf(details.url)) await inject(details.tabId);
  });
});
chrome.webNavigation.onDOMContentLoaded.addListener(details => {
  if (details.frameId === 0) serial(async () => {
    if (state.tabs[details.tabId]?.site === siteOf(details.url)) await inject(details.tabId);
  });
}, navigationFilter);
chrome.webNavigation.onCreatedNavigationTarget.addListener(details => {
  serial(() => inherit(details.sourceTabId, details.tabId, details.url));
}, navigationFilter);
chrome.tabs.onCreated.addListener(tab => {
  if (tab.openerTabId !== undefined) serial(() => inherit(tab.openerTabId, tab.id, tab.pendingUrl || tab.url));
});
chrome.tabs.onRemoved.addListener(tabId => { serial(() => detach(tabId)); });
chrome.runtime.onStartup.addListener(() => { serial(() => flush(true)); });
chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') }));

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  serial(async () => {
    const tabId = sender.tab?.id;
    if (message.type === 'hello') {
      const tracked = state.tabs[tabId];
      return tracked && siteOf(sender.url) === tracked.site ? { ok: true, session: tracked.session } : { ok: false };
    }
    if (message.type === 'samples') {
      const tracked = state.tabs[tabId];
      if (!tracked || siteOf(sender.url) !== tracked.site || sender.frameId !== 0) return { ok: false };
      if (!Array.isArray(message.events) || message.events.length > 200) throw new Error('Invalid sample batch');
      const existing = new Set(local.outbox.map(e => e.id));
      for (const e of message.events) {
        if (e.kind !== 'sample' || e.session_id !== tracked.session || e.site !== tracked.site) continue;
        if (!existing.has(e.id)) { local.outbox.push(e); existing.add(e.id); }
        touch(tracked.session, e.end_ms);
      }
      await persist(); // Durable browser buffer before acknowledging the page.
      await flush();
      return { ok: true };
    }
    // Only our own dashboard can query SQLite or launch a session.
    if (sender.url !== chrome.runtime.getURL('dashboard.html')) throw new Error('Unknown sender');
    if (message.type === 'launch' && LAUNCHERS[message.site]) {
      await chrome.tabs.create({ url: LAUNCHERS[message.site] });
      return { ok: true };
    }
    if (message.type === 'status') {
      await flush(true);
      return { ok: true, buffered: local.outbox.length, active: Object.values(state.sessions), lastSaved: local.lastSaved, error: local.error };
    }
    if (message.type === 'report') {
      await flush(true);
      return await chrome.runtime.sendNativeMessage(HOST, { op: 'report', buckets: message.buckets, offset: message.offset || 0 });
    }
    throw new Error('Unknown request');
  }).then(respond, error => respond({ ok: false, error: error.message }));
  return true;
});
