import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../scripts/spotlight/spotlight.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../scripts/spotlight/spotlight.css', import.meta.url), 'utf8');
const loader = await readFile(new URL('../scripts/spotlight/spotlight-loader.js', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

const now = Date.parse('2026-10-06T12:00:00Z');
const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

function spotlightFetcher(fetchJson) {
  const functions = script.slice(
    script.indexOf('async function fetchRecentItems('),
    script.indexOf('function stopAuto(')
  );
  const context = vm.createContext({
    base: 'http://jellyfin.test',
    userId: 'user',
    FIELDS: 'Overview',
    fetchJson,
    DOMException,
    Date: class extends Date { static now() { return now; } }
  });
  return new vm.Script(`${functions}\nfetchItems;`).runInContext(context);
}

function recentItem(Id, Type = 'Movie', timestamp = now) {
  return { Id, Type, DateCreated: new Date(timestamp).toISOString() };
}

test('spotlight includes weekly movies and shows even with a full Continue Watching list', async () => {
  const resume = [{ Id: 'resume' }, { Id: 'shared' }, { Id: 'third' }];
  const nextUp = Array.from({ length: 5 }, (_, index) => ({ Id: `episode-${index}` }));
  const fetchItems = spotlightFetcher(async url => {
    if (url.includes('/Resume?')) return { Items: resume };
    if (url.includes('/NextUp?')) return { Items: nextUp };
    const query = new URL(url).searchParams;
    assert.equal(query.get('IncludeItemTypes'), 'Movie,Series');
    assert.equal(query.get('SortBy'), 'DateCreated');
    assert.equal(query.get('SortOrder'), 'Descending');
    assert.ok(query.get('Fields').split(',').includes('DateCreated'));
    return { Items: [recentItem('shared'), recentItem('movie'), recentItem('show', 'Series')] };
  });
  const items = await fetchItems(new AbortController().signal);
  assert.equal(items.length, 10);
  assert.deepEqual(Array.from(items, item => item.Id), [
    'resume', 'shared', 'third', ...nextUp.map(item => item.Id), 'movie', 'show'
  ]);
  assert.equal(items.find(item => item.Id === 'shared')._source, 'resume');
  assert.equal(items.find(item => item.Id === 'movie')._source, 'recent-movie');
  assert.equal(items.find(item => item.Id === 'show')._source, 'recent-show');
});

test('spotlight uses an inclusive rolling seven-day cutoff without older filler', async () => {
  const fetchItems = spotlightFetcher(async url => {
    if (!url.includes('StartIndex=')) return { Items: [] };
    return { Items: [
      recentItem('new'),
      { Id: 'missing-date' },
      { Id: 'invalid-date', DateCreated: 'invalid' },
      recentItem('boundary', 'Series', weekAgo),
      recentItem('old', 'Movie', weekAgo - 1)
    ] };
  });
  assert.deepEqual(Array.from(await fetchItems(new AbortController().signal), item => item.Id), ['new', 'boundary']);
});

test('spotlight paginates weekly additions and stops at the first older item', async () => {
  const requested = [];
  const fetchItems = spotlightFetcher(async url => {
    if (!url.includes('StartIndex=')) return { Items: [] };
    const offset = Number(new URL(url).searchParams.get('StartIndex'));
    requested.push(offset);
    const Items = Array.from({ length: 100 }, (_, index) => recentItem(`movie-${offset + index}`));
    if (offset === 100) Items[2] = recentItem('old', 'Movie', weekAgo - 1);
    return { Items, TotalRecordCount: 1000 };
  });
  const items = await fetchItems(new AbortController().signal);
  assert.equal(items.length, 102);
  assert.deepEqual(requested, [0, 100]);
});

test('spotlight stops pagination at the reported total', async () => {
  let requests = 0;
  const fetchItems = spotlightFetcher(async url => {
    if (!url.includes('StartIndex=')) return { Items: [] };
    requests++;
    return { Items: Array.from({ length: 100 }, (_, index) => recentItem(`movie-${index}`)), TotalRecordCount: 100 };
  });
  assert.equal((await fetchItems(new AbortController().signal)).length, 100);
  assert.equal(requests, 1);
});

test('spotlight keeps Continue Watching when recent additions fail', async () => {
  const fetchItems = spotlightFetcher(async url => {
    if (url.includes('/Resume?')) return { Items: [{ Id: 'resume' }] };
    if (url.includes('/NextUp?')) return { Items: [{ Id: 'nextup' }] };
    throw new Error('unavailable');
  });
  assert.deepEqual(Array.from(await fetchItems(new AbortController().signal), item => item.Id), ['resume', 'nextup']);
});

test('spotlight keeps recent additions when Continue Watching fails', async () => {
  const fetchItems = spotlightFetcher(async url => {
    if (url.includes('StartIndex=')) return { Items: [recentItem('movie')] };
    throw new Error('unavailable');
  });
  assert.deepEqual(Array.from(await fetchItems(new AbortController().signal), item => item.Id), ['movie']);
});

test('spotlight preserves cancellation while fetching weekly additions', async () => {
  const controller = new AbortController();
  const fetchItems = spotlightFetcher(async (url, signal) => {
    assert.equal(signal, controller.signal);
    if (url.includes('StartIndex=')) controller.abort();
    return { Items: [] };
  });
  await assert.rejects(fetchItems(controller.signal), { name: 'AbortError' });
});

test('spotlight inline script parses', () => {
  assert.ok(script, 'inline script should exist');
  assert.doesNotThrow(() => new vm.Script(script));
});

test('carousel renders are cancellable and self-scheduled', () => {
  assert.doesNotMatch(script, /setInterval\s*\(/);
  assert.match(script, /AbortController/);
  assert.match(script, /renderSequence/);
});

test('spotlight lifecycle pauses hidden work', () => {
  assert.match(script, /visibilitychange/);
  assert.match(script, /pagehide/);
  assert.match(script, /action === 'pause'/);
  assert.match(loader, /postMessage/);
  assert.match(loader, /indexPage/);
  assert.match(loader, /isRouteVisible/);
  assert.match(loader, /favoritesActive/);
  assert.match(loader, /isConnected/);
  assert.match(loader, /abyss-spotlight-visible/);
  assert.match(loader, /if \(!iframe \|\| !iframe\.isConnected\) \{\s*clearSpotlightLifecycle\(\)/);
  assert.match(loader, /var ancestor = indexPage\.parentElement/);
  assert.match(loader, /function clearSpotlightLifecycle\(\)/);
  assert.match(loader, /if \(!indexPage\) \{\s*clearSpotlightLifecycle\(\)/);
});

test('spotlight does not override Jellyfin theme storage', () => {
  assert.doesNotMatch(loader, /Storage\.prototype\.setItem/);
  assert.doesNotMatch(loader, /forceDarkTheme/);
});

test('image requests are bounded and cached', () => {
  assert.match(script, /maxWidth=/);
  assert.match(script, /maxHeight=/);
  assert.match(script, /imageCache/);
});

test('spotlight avoids known paint and accessibility regressions', () => {
  assert.doesNotMatch(css, /transition:\s*all/);
  assert.doesNotMatch(css, /--webkit-backdrop-filter/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(html, /id="clickzone"[^>]*aria-label=/);
});
