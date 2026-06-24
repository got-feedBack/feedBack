import { test, expect } from '@playwright/test';

// Regression coverage for the list/tree view select-mode fix (PR #585, which
// re-lands a change that was reverted). The core bug: entering select mode
// re-renders the tree (setSelectMode -> reload -> loadTree), and the rebuild
// wiped every expanded <details>, collapsing the tree and making selection
// unusable. The fix captures the open artist groups before the wipe and
// restores them. We also cover: clicking a row in select mode selects instead
// of playing.
//
// Navigation uses programmatic element.click() rather than Playwright's
// actionability-gated click: this screen briefly re-renders its toolbar and
// the harness can show transient overlays, but element.click() still
// dispatches a real bubbling event through the capture-phase select handler.

const ARTISTS = {
  artists: [
    {
      name: 'Alpha Band',
      song_count: 2,
      albums: [{ name: 'First Album', songs: [
        { filename: 'alpha/one.sloppak', title: 'Alpha One', artist: 'Alpha Band', album: 'First Album' },
        { filename: 'alpha/two.sloppak', title: 'Alpha Two', artist: 'Alpha Band', album: 'First Album' },
      ] }],
    },
    {
      name: 'Beta Crew',
      song_count: 1,
      albums: [{ name: 'Beta LP', songs: [
        { filename: 'beta/solo.sloppak', title: 'Beta Solo', artist: 'Beta Crew', album: 'Beta LP' },
      ] }],
    },
  ],
  total_artists: 2,
};

test.beforeEach(async ({ page }) => {
  // Paged artists endpoint (used by both the tree and the artist catalog):
  // page 0 returns data, later pages return empty so the paging loop ends.
  await page.route('**/api/library/artists**', async route => {
    const pageNum = Number(new URL(route.request().url()).searchParams.get('page') || '0');
    await route.fulfill({ json: pageNum === 0 ? ARTISTS : { artists: [], total_artists: 2 } });
  });
  await page.route('**/api/library/providers', route => route.fulfill({ json: { providers: [{ id: 'local', label: 'My Library' }] } }));
  await page.route('**/api/library/tuning-names**', route => route.fulfill({ json: { tunings: [] } }));
  await page.route('**/api/stats/best', route => route.fulfill({ json: {} }));
  await page.route('**/api/library?**', route => route.fulfill({ json: { songs: [], total: 0, page: 0, size: 60 } }));
});

// Programmatic click — fires a real bubbling click through capture-phase
// handlers without Playwright's actionability gate.
async function clickSel(page, selector: string) {
  await page.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement | null;
    if (!el) throw new Error('not found: ' + s);
    el.click();
  }, selector);
}

async function openTree(page) {
  await page.goto('/');
  await page.waitForSelector('.screen.active', { timeout: 10000 });
  await page.evaluate(() => {
    // @ts-ignore — record playback so an accidental row-click is detectable.
    window.__played = 0;
    // @ts-ignore
    window.playSong = () => { window.__played++; return Promise.resolve(); };
    // @ts-ignore
    window.showScreen('v3-songs');
  });
  await page.waitForSelector('#v3-songs-tree-btn', { state: 'attached', timeout: 8000 });
  await clickSel(page, '#v3-songs-tree-btn');
  await page.waitForSelector('#v3-songs-tree details', { state: 'attached', timeout: 8000 });
}

// Returns the <details> whose <summary> names the given artist.
function group(page, artist: string) {
  return page.locator('#v3-songs-tree details', { has: page.locator('summary', { hasText: artist }) });
}

test('select mode keeps expanded artist groups open across the tree re-render (#585)', async ({ page }) => {
  await openTree(page);

  // Expand Alpha (the precondition the bug used to destroy on re-render).
  await page.evaluate(() => {
    const d = [...document.querySelectorAll('#v3-songs-tree details')]
      .find((el) => el.querySelector('summary')?.textContent?.includes('Alpha Band')) as HTMLDetailsElement;
    d.open = true;
  });
  await expect(group(page, 'Alpha Band')).toHaveAttribute('open', '');

  // Enter select mode → triggers the full tree re-render.
  await clickSel(page, '#v3-songs-select');
  await page.waitForSelector('#v3-songs-tree input[data-select]', { state: 'attached', timeout: 8000 });

  // The bug: Alpha collapses after the rebuild. The fix restores it.
  await expect(group(page, 'Alpha Band')).toHaveAttribute('open', '');
  // Beta was never opened — it must stay collapsed (no false restore).
  await expect(group(page, 'Beta Crew')).not.toHaveAttribute('open', '');
});

test('clicking a tree row in select mode selects it instead of playing (#585)', async ({ page }) => {
  await openTree(page);

  await page.evaluate(() => {
    const d = [...document.querySelectorAll('#v3-songs-tree details')]
      .find((el) => el.querySelector('summary')?.textContent?.includes('Alpha Band')) as HTMLDetailsElement;
    d.open = true;
  });

  await clickSel(page, '#v3-songs-select');
  await page.waitForSelector('#v3-songs-tree input[data-select]', { state: 'attached', timeout: 8000 });

  await clickSel(page, '#v3-songs-tree [data-fn="alpha/one.sloppak"]');

  await expect(page.locator('#v3-songs-tree [data-fn="alpha/one.sloppak"] input[data-select]')).toBeChecked();
  expect(await page.evaluate(() => (window as any).__played)).toBe(0);
});
