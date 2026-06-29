import { test, expect } from '@playwright/test';

// Pins the bounded-DOM invariant of the windowed v3 Songs grid (#636 item 3
// stage 2). Before virtualization the grid appended every scrolled page, so for
// a 2000-song library the card-node count grew unbounded (24 → 624 → 2001).
// Now only the visible window (± overscan) is ever in the DOM while a sizer
// element gives the scrollbar the full-library geometry.
//
// Route-mocked (same strategy as v3-tree-select.spec.ts) so the invariant is
// deterministic in CI without a seeded 2000-row library: /api/library serves a
// synthetic page from the page/after param with total 2001, and the keyset
// cursor is mocked as the next absolute offset.

const TOTAL = 2001;
const PAGE_SIZE = 24;
const COLS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Same bucketing as the seed/server: index % 26 → a first letter, so the A–Z
// rail has real buckets and a jump has somewhere to land.
function songAt(i: number) {
  const letter = COLS[i % 26];
  return {
    filename: `seed/${String(i).padStart(5, '0')}.sloppak`,
    title: `Song ${String(i).padStart(4, '0')}`,
    artist: `${letter}Band ${String(i).padStart(4, '0')}`,
    album: `${letter} Album`,
    format: 'sloppak',
    arrangements: [{ index: 0, name: 'Lead' }, { index: 1, name: 'Rhythm' }],
  };
}

// sort_letters song-counts per bucket for index%26 over [0, TOTAL).
function sortLetters() {
  const m: Record<string, number> = {};
  for (let i = 0; i < TOTAL; i++) { const L = COLS[i % 26]; m[L] = (m[L] || 0) + 1; }
  return m;
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/library?**', async (route) => {
    const url = new URL(route.request().url());
    const after = url.searchParams.get('after');
    const size = Number(url.searchParams.get('size') || PAGE_SIZE);
    const offset = after != null ? Number(after) : Number(url.searchParams.get('page') || '0') * size;
    const songs = [];
    for (let i = offset; i < Math.min(TOTAL, offset + size); i++) songs.push(songAt(i));
    const nextOffset = offset + size;
    await route.fulfill({
      json: {
        songs, total: TOTAL, page: Math.floor(offset / size), size,
        next_cursor: nextOffset < TOTAL ? String(nextOffset) : null,
      },
    });
  });
  await page.route('**/api/library/stats**', (route) => {
    const url = new URL(route.request().url());
    const body: any = { total_songs: TOTAL, total: TOTAL, letters: {} };
    if (url.searchParams.get('sort_letters')) body.sort_letters = sortLetters();
    return route.fulfill({ json: body });
  });
  await page.route('**/api/library/artists**', (route) => route.fulfill({ json: { artists: [], total_artists: 0 } }));
  await page.route('**/api/library/providers', (route) => route.fulfill({ json: { providers: [{ id: 'local', label: 'My Library' }] } }));
  await page.route('**/api/library/tuning-names**', (route) => route.fulfill({ json: { tunings: [] } }));
  await page.route('**/api/stats/best', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/stats/recent**', (route) => route.fulfill({ json: [] }));
});

async function openSongs(page) {
  await page.goto('/');
  await page.waitForSelector('.screen.active', { timeout: 10000 });
  await page.evaluate(() => {
    // @ts-ignore — neutralize playback so a stray click can't navigate away.
    window.playSong = () => Promise.resolve();
    // @ts-ignore
    window.showScreen('v3-songs');
  });
  await page.waitForSelector('#v3-songs-grid [data-fn]', { state: 'attached', timeout: 10000 });
}

test('the grid keeps a bounded number of card nodes while scrolling a 2001-song library', async ({ page }) => {
  await openSongs(page);

  // The count reflects the FULL library even though only a window is rendered.
  await expect(page.locator('#v3-songs-count')).toHaveText('2001 songs');

  // The sizer reserves the full scroll height (so the scrollbar is library-wide).
  const scrollHeight = await page.evaluate(() => document.getElementById('v3-main')!.scrollHeight);
  expect(scrollHeight).toBeGreaterThan(20000);

  // Scroll the whole library; the in-DOM card count must stay bounded throughout.
  const CAP = 150;
  let maxNodes = await page.locator('#v3-songs-grid [data-fn]').count();
  for (let s = 0; s < 50; s++) {
    await page.evaluate(() => { const m = document.getElementById('v3-main')!; m.scrollTop += m.clientHeight * 0.85; });
    await page.waitForTimeout(60);
    const n = await page.locator('#v3-songs-grid [data-fn]').count();
    maxNodes = Math.max(maxNodes, n);
    expect(n).toBeLessThanOrEqual(CAP);
  }
  // Sanity: we actually rendered a window (not zero), and stayed well under the
  // unbounded 2001 the old append-everything grid would have produced.
  expect(maxNodes).toBeGreaterThan(0);
  expect(maxNodes).toBeLessThanOrEqual(CAP);

  // The count is still correct after scrolling to the end.
  await expect(page.locator('#v3-songs-count')).toHaveText('2001 songs');
});

test('the A–Z rail jumps directly to a letter without loading every page', async ({ page }) => {
  await openSongs(page);
  await page.waitForSelector('.v3-azrail-letter', { state: 'attached', timeout: 10000 });

  // Jump to 'M'; the window scrolls to the row holding the first 'M' card.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.v3-azrail-letter')]
      .find((x) => x.getAttribute('data-letter') === 'M' && !(x as HTMLButtonElement).disabled) as HTMLElement | undefined;
    if (!b) throw new Error('no M rail letter'); b.click();
  });

  // After the jump+window render, an 'M' card is present near the top of the
  // viewport (the jump is O(1) via sort_letters, not a full page-through).
  await expect.poll(async () => page.evaluate(() => {
    const main = document.getElementById('v3-main')!;
    const top = main.getBoundingClientRect().top + (document.getElementById('v3-songs-toolbar')?.offsetHeight || 0);
    return [...document.querySelectorAll('#v3-songs-grid [data-fn]')].some((c) => {
      const r = c.getBoundingClientRect();
      return c.getAttribute('data-letter') === 'M' && r.top >= top - 4 && r.top < top + 320;
    });
  }), { timeout: 5000 }).toBe(true);
});
