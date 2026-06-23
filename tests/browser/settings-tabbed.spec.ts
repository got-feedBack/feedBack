import { test, expect } from '@playwright/test';

// Verifies the v3 tabbed settings page (feat/v3-settings-tabbed): the tab bar
// renders, tabs switch panels, the active tab persists, existing controls
// still hydrate from /api/settings, the new countdown toggle persists, and the
// per-category reset hits /api/settings/reset.

interface SettingsPayload {
  dlc_dir: string;
  default_arrangement: string;
  demucs_server_url: string;
  master_difficulty: number;
  av_offset_ms: number;
  countdown_before_song: boolean;
  miss_penalty: string;
  fail_behavior: string;
}

const basePayload: SettingsPayload = {
  dlc_dir: '',
  default_arrangement: 'Rhythm',
  demucs_server_url: '',
  master_difficulty: 70,
  av_offset_ms: 0,
  countdown_before_song: false,
  miss_penalty: 'none',
  fail_behavior: 'continue',
};

// A fresh profile shows the blocking onboarding overlay; onboard via the API
// so the tab clicks below aren't intercepted (idempotent once onboarded).
test.beforeEach(async ({ request }) => {
  await request.post('/api/profile', { data: { display_name: 'Settings Tester' } });
  await request.post('/api/progression/paths', { data: { add: ['guitar'] } });
  await request.post('/api/progression/onboarding', { data: { action: 'skip' } });
});

// Open the v3 settings screen with the first-run onboarding overlay neutralised
// (the API skip in beforeEach handles the common path; this also hides the
// overlay element so a slow async profile render can't intercept tab clicks).
async function openSettings(page) {
  await page.goto('/');
  await page.waitForSelector('#settings-tabbar', { state: 'attached' });
  await page.addStyleTag({ content: '#v3-onboarding{display:none!important;pointer-events:none!important}' });
  await page.evaluate(() => (window as any).showScreen('settings'));
}

async function mockSettings(page, posts: any[], resets: any[]) {
  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: basePayload });
      return;
    }
    posts.push(route.request().postDataJSON());
    await route.fulfill({ json: { message: 'Settings saved' } });
  });
  await page.route('**/api/settings/reset', async route => {
    resets.push(route.request().postDataJSON());
    await route.fulfill({ json: { message: 'Settings reset', reset: [] } });
  });
}

test('tab bar renders the settings tabs and Gameplay is default', async ({ page }) => {
  await mockSettings(page, [], []);
  await openSettings(page);

  const tabs = await page.locator('#settings-tabbar .fb-tab').allTextContents();
  expect(tabs).toEqual(['Gameplay', 'Audio', 'Graphics', 'Keybinds', 'Progression', 'Mic', 'Plugins', 'System']);

  // Gameplay panel is active by default and its controls are present.
  await expect(page.locator('.fb-tabpanel[data-tab="gameplay"]')).toHaveClass(/active/);
  await expect(page.locator('#setting-lefty')).toBeAttached();
  await expect(page.locator('#setting-countdown-before-song')).toBeAttached();
});

test('clicking a tab switches the visible panel', async ({ page }) => {
  await mockSettings(page, [], []);
  await openSettings(page);

  await page.locator('#settings-tabbar .fb-tab[data-tab="audio"]').click();
  await expect(page.locator('.fb-tabpanel[data-tab="audio"]')).toHaveClass(/active/);
  await expect(page.locator('.fb-tabpanel[data-tab="gameplay"]')).not.toHaveClass(/active/);
  await expect(page.locator('#setting-live-guitar-tone-source')).toBeVisible();
});

test('active tab persists across reload', async ({ page }) => {
  await mockSettings(page, [], []);
  await openSettings(page);
  await page.locator('#settings-tabbar .fb-tab[data-tab="system"]').click();
  await expect(page.locator('.fb-tabpanel[data-tab="system"]')).toHaveClass(/active/);

  await page.reload();
  await page.waitForSelector('#settings-tabbar', { state: 'attached' });
  // Restored from localStorage even before navigating back to settings.
  await expect(page.locator('#settings-tabbar .fb-tab[data-tab="system"]')).toHaveClass(/active/);
});

test('existing controls hydrate from /api/settings', async ({ page }) => {
  await mockSettings(page, [], []);
  await openSettings(page);

  await expect(page.locator('#default-arrangement')).toHaveValue('Rhythm');
  // Note highway speed shares master_difficulty (70 in the mock).
  await expect(page.locator('#setting-highway-speed')).toHaveValue('70');
  await expect(page.locator('#setting-highway-speed-val')).toHaveText('70');  // span holds number; '%' is literal in markup
});

test('countdown toggle persists countdown_before_song', async ({ page }) => {
  const posts: any[] = [];
  await mockSettings(page, posts, []);
  await openSettings(page);

  await page.locator('label.fb-switch:has(#setting-countdown-before-song) .fb-switch-track').click();
  await expect.poll(() => posts.some(p => p && p.countdown_before_song === true)).toBe(true);
});

test('reset gameplay posts to /api/settings/reset', async ({ page }) => {
  const resets: any[] = [];
  await mockSettings(page, [], resets);
  await openSettings(page);

  await page.locator('[data-reset="gameplay"]').click();
  // _confirmDialog modal — confirm it.
  await page.locator('.slopsmith-modal [data-confirm]').click();

  await expect.poll(() => resets.length).toBeGreaterThan(0);
  expect(resets[0].keys).toContain('countdown_before_song');
  expect(resets[0].keys).toContain('master_difficulty');
});

test('keybinds tab renders the shortcut reference', async ({ page }) => {
  await mockSettings(page, [], []);
  await openSettings(page);

  await page.locator('#settings-tabbar .fb-tab[data-tab="keybinds"]').click();
  // Either real shortcuts (kbd chips) or the empty-state note — never blank.
  await expect(page.locator('#settings-keybinds')).not.toBeEmpty();
});
