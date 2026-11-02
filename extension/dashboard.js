import { LAUNCHERS } from './core.js';
const $ = id => document.getElementById(id);
const label = site => site === 'youtube' ? 'YouTube' : 'Bilibili';
let offset = 0, buckets = [], busy = false;
const request = message => chrome.runtime.sendMessage(message);
const time = ms => {
  const seconds = Math.round((ms || 0) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
};
const dateTime = ms => ms == null ? '—' : new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const dayKey = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
function makeBuckets() {
  const end = new Date(); end.setHours(0,0,0,0);
  const start = new Date(end);
  if ($('period').value === 'custom') {
    if (!$('from').value || !$('to').value) throw new Error('Choose both dates.');
    start.setTime(new Date(`${$('from').value}T00:00:00`).getTime());
    end.setTime(new Date(`${$('to').value}T00:00:00`).getTime());
    if (start > end) throw new Error('Start date must precede the end date.');
  } else start.setDate(start.getDate() - Number($('period').value) + 1);
  end.setDate(end.getDate() + 1);
  const days = [];
  for (let cursor = new Date(start); cursor < end;) {
    const next = new Date(cursor); next.setDate(next.getDate() + 1);
    days.push({ label: dayKey(cursor), start: +cursor, end: +next });
    cursor = next;
    if (days.length > 366) throw new Error('Choose at most 366 days at a time.');
  }
  return days;
}
function cell(row, value) { const td = document.createElement('td'); td.textContent = value; row.append(td); return td; }
function drawReport(report, append) {
  if (!append) {
    const totals = report.days.reduce((a, d) => { for (const k of Object.keys(a)) a[k] += d[k]; return a; }, { foreground_ms: 0, playback_ms: 0, background_ms: 0, visits: 0 });
    $('foreground').textContent = time(totals.foreground_ms); $('playback').textContent = time(totals.playback_ms);
    $('background').textContent = time(totals.background_ms); $('visits').textContent = totals.visits;
    $('daily').replaceChildren(); $('chart').replaceChildren(); $('history').replaceChildren(); $('sessions').replaceChildren();
    const days = buckets.map(b => { const items = report.days.filter(d => d.day === b.label); return { label: b.label, items, total: items.reduce((n,d) => n + d.foreground_ms, 0) }; });
    const max = Math.max(1, ...days.map(d => d.total));
    for (const d of days) {
      const bar = document.createElement('div'); bar.className = 'day-bar';
      const stack = document.createElement('div'); stack.className = 'bar-stack';
      for (const entry of d.items) {
        const segment = document.createElement('div'); segment.className = `bar ${entry.site === 'youtube' ? 'yt' : 'bi'}`;
        segment.style.height = `${110 * entry.foreground_ms / max}px`; segment.title = `${d.label} · ${label(entry.site)}: ${time(entry.foreground_ms)}, ${entry.visits} visits`;
        stack.append(segment);
      }
      const caption = document.createElement('div'); caption.className = 'bar-label'; caption.textContent = d.label.slice(5);
      bar.append(stack, caption); $('chart').append(bar);
      const row = document.createElement('tr'); cell(row, d.label); cell(row, time(d.total));
      cell(row, time(d.items.reduce((n,i) => n+i.playback_ms,0))); cell(row, d.items.reduce((n,i) => n+i.visits,0)); $('daily').prepend(row);
    }
    for (const s of report.sessions) {
      const row = document.createElement('tr'); cell(row, label(s.site)); cell(row, dateTime(s.started_ms)); cell(row, dateTime(s.ended_ms));
      cell(row, s.end_reason === 'interrupted' ? 'Interrupted' : s.ended_ms ? 'Finished' : 'Open / last recorded'); $('sessions').append(row);
    }
  }
  for (const h of report.history) {
    const row = document.createElement('tr'), title = cell(row, '');
    const link = document.createElement('a'); link.textContent = h.title || h.video_id; link.href = h.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    const meta = document.createElement('div'); meta.className = 'video-meta'; meta.textContent = `${label(h.site)}${h.creator ? ` · ${h.creator}` : ''}`;
    title.append(link, meta); cell(row, dateTime(h.first_seen)); cell(row, h.duration_sec ? time(h.duration_sec*1000) : '—'); cell(row, time(h.playback_ms)); $('history').append(row);
  }
  $('history-empty').hidden = !!$('history').children.length;
  $('history-table').hidden = !$('history').children.length;
  $('more').hidden = !report.has_more;
}
async function refresh(append = false) {
  if (busy) return;
  busy = true; $('refresh').disabled = true; $('more').disabled = true;
  try {
    if (!append) { offset = 0; buckets = makeBuckets(); }
    const status = await request({ type: 'status' });
    if (!status.ok) throw new Error(status.error);
    $('status').classList.toggle('error', !!status.error);
    $('status').textContent = `${status.active.length} active session${status.active.length === 1 ? '' : 's'} · ${status.buffered} buffered records · ${status.lastSaved ? `Saved ${dateTime(status.lastSaved)}` : 'No records saved yet'}${status.error ? ` · ${status.error}` : ''}`;
    const report = await request({ type: 'report', buckets, offset });
    if (!report.ok) throw new Error(report.error);
    drawReport(report, append); offset += report.history.length;
  } catch (error) {
    $('status').textContent = `History unavailable: ${error.message}. Check helper setup; unsaved records remain buffered.`;
    $('status').classList.add('error'); $('setup').open = true;
  } finally { busy = false; $('refresh').disabled = false; $('more').disabled = false; }
}
for (const site of Object.keys(LAUNCHERS)) $(site + '-url').textContent = LAUNCHERS[site];
$('extension-id').textContent = chrome.runtime.id;
document.querySelectorAll('[data-launch]').forEach(button => button.addEventListener('click', () => request({ type: 'launch', site: button.dataset.launch })));
document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(LAUNCHERS[button.dataset.copy]); button.textContent = 'Copied'; setTimeout(() => { button.textContent = 'Copy URL'; }, 1500); }
  catch { button.textContent = 'Select URL to copy'; }
}));
$('refresh').addEventListener('click', () => refresh()); $('more').addEventListener('click', () => refresh(true));
$('period').addEventListener('change', () => { $('custom').hidden = $('period').value !== 'custom'; void refresh(); });
for (const id of ['from','to']) { $(id).value = dayKey(new Date()); $(id).addEventListener('change', () => refresh()); }
void refresh();
