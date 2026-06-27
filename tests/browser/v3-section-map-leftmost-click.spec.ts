import { test, expect } from '@playwright/test';

// Regression coverage for the v3 Section Map "leftmost section unclickable" bug.
//
// The Section Map plugin pins a ~20px clickable bar (#section-map, z-index:5)
// to the very top of #player. The v3 chrome has a full-height invisible rail
// "catcher" (.v3-railzone::before, z-index:30, width:96px, pinned left/top:0)
// that reveals the hover rail. Because the catcher sat at top:0 and outranks
// the bar, its top-left corner swallowed every click on the section map's first
// section. Fix (static/v3/v3.css): `#section-map ~ #v3-railzone::before { top: 20px }`
// drops the catcher below the bar when the section map is present.
//
// We reproduce the plugin's bar exactly (first child of #player, the rendered
// position:relative / z-index:5 / 20px-tall state) and hit-test the top-left
// corner with elementFromPoint — that is precisely what a real click resolves
// against. A negative control re-raises the catcher to prove the test catches
// the bug.

// A fresh profile shows the blocking onboarding overlay; onboard via the API so
// it isn't (re)created over the player. Idempotent once onboarded.
test.beforeEach(async ({ request }) => {
  await request.post('/api/profile', { data: { display_name: 'Section Map Tester' } });
  await request.post('/api/progression/paths', { data: { add: ['guitar'] } });
  await request.post('/api/progression/onboarding', { data: { action: 'skip' } });
});

async function openPlayerWithSectionMap(page) {
  await page.goto('/');
  await page.waitForSelector('.screen.active', { timeout: 10000 });
  // The bug affects an already-onboarded user mid-song. The API skip above
  // handles the common path; this persistent hide also covers a slow async
  // profile render that could otherwise re-create the full-screen overlay and
  // intercept the top-left hit-test (mirrors settings-tabbed.spec.ts).
  await page.addStyleTag({ content: '#v3-onboarding{display:none!important;pointer-events:none!important}' });
  await page.evaluate(() => {
    // @ts-ignore — show the player screen (static #v3-railzone markup lives here).
    window.showScreen('player');
    const player = document.getElementById('player');
    if (!player) throw new Error('#player missing');

    // Reproduce the section_map plugin's rendered bar: first child of #player,
    // 20px tall, full width, z-index:5, position:relative (its post-_smRender
    // state), with a left-edge "first section" block at left:0.
    const bar = document.createElement('div');
    bar.id = 'section-map';
    bar.style.cssText =
      'position:relative;top:0;left:0;right:0;z-index:5;height:20px;background:rgba(8,8,16,0.7);cursor:pointer;';
    const block = document.createElement('div');
    block.id = 'sm-first-block';
    block.style.cssText =
      'position:absolute;left:0;width:30%;top:0;bottom:0;background:#3b82f6;';
    bar.appendChild(block);
    player.insertBefore(bar, player.firstChild);
  });
  await page.waitForSelector('#section-map', { state: 'attached', timeout: 5000 });
  await page.waitForSelector('#v3-railzone', { state: 'attached', timeout: 5000 });
}

// What element does a click at the top-left strip land on? (x within the 96px
// catcher, y within the 20px bar.)
function hitTopLeft(page, x = 10, y = 8) {
  return page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    return el ? { id: el.id, cls: el.className, tag: el.tagName } : null;
  }, { x, y });
}

test('top-left of the section map receives clicks, not the rail catcher (fix present)', async ({ page }) => {
  await openPlayerWithSectionMap(page);

  const hit = await hitTopLeft(page);
  // Click must resolve to the section map (the bar or its first-section block),
  // never the rail hover-zone.
  expect(hit).not.toBeNull();
  expect(hit!.id).not.toBe('v3-railzone');
  expect(['section-map', 'sm-first-block']).toContain(hit!.id);
});

test('negative control: re-raising the catcher to top:0 reproduces the bug', async ({ page }) => {
  await openPlayerWithSectionMap(page);

  // Undo the fix at runtime (highest-specificity inline-ish override) so the
  // catcher again covers the bar's top-left — this is the pre-fix layout.
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = '#section-map ~ #v3-railzone::before { top: 0 !important; }';
    document.head.appendChild(style);
  });

  const hit = await hitTopLeft(page);
  // Without the fix, the rail catcher swallows the click.
  expect(hit!.id).toBe('v3-railzone');
});
