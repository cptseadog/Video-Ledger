import test from 'node:test';
import assert from 'node:assert/strict';
import { siteOf, isLauncher, videoOf, playbackDelta } from '../extension/core.js';
test('only exact supported HTTPS hosts can start tracking', () => {
  assert.equal(siteOf('https://www.youtube.com/watch?v=abc'), 'youtube');
  assert.equal(siteOf('https://www.youtube.com.evil.test/'), null);
  assert.equal(siteOf('http://www.youtube.com/'), null);
  assert.equal(isLauncher('https://www.bilibili.com/?bht_launch=1'), true);
  assert.equal(isLauncher('https://www.bilibili.com/'), false);
  assert.equal(isLauncher('https://www.bilibili.com/?bht_launch=0'), false);
});
test('regular videos and Bilibili parts have stable identities', () => {
  assert.equal(videoOf('https://www.youtube.com/shorts/abc'), null);
  assert.deepEqual(videoOf('https://www.youtube.com/watch?v=abc&list=x'), { id: 'abc', url: 'https://www.youtube.com/watch?v=abc' });
  assert.equal(videoOf('https://www.bilibili.com/video/BV123/?p=2').id, 'BV123:p2');
});
test('playback measures real time, excludes seeks, pauses and sleep', () => {
  const base = { elapsed: 1000, before: 10, after: 12, rate: 2, playing: true, seeking: false };
  assert.equal(playbackDelta(base), 1000);
  assert.equal(playbackDelta({ ...base, after: 80 }), 0);
  assert.equal(playbackDelta({ ...base, playing: false }), 0);
  assert.equal(playbackDelta({ ...base, seeking: true }), 0);
  assert.equal(playbackDelta({ ...base, elapsed: 60000 }), 0);
});
