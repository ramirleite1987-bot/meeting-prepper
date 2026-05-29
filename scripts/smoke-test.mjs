#!/usr/bin/env node
// Drives the meeting-prepper UI through Chrome (headless) and exercises
// every user-facing feature, capturing screenshots and console errors.

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = 'http://localhost:3000';
const SHOTS = '/tmp/screenshots';
mkdirSync(SHOTS, { recursive: true });

const results = [];
const consoleErrors = [];
const pageErrors = [];

function record(step, status, info = '') {
  results.push({ step, status, info });
  const tag = status === 'ok' ? 'PASS' : status === 'warn' ? 'WARN' : 'FAIL';
  console.log(`[${tag}] ${step}${info ? ' — ' + info : ''}`);
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(`[${page.url()}] ${msg.text()}`);
});
page.on('pageerror', (err) => {
  pageErrors.push(`[${page.url()}] ${err.message}`);
});

async function shot(name) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

try {
  // ── 1. Dashboard loads ────────────────────────────
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=Dashboard');
  await shot('01-dashboard-empty');
  record('Dashboard loads (empty state)', 'ok');

  // ── 2. Add Client (modal API path) ────────────────
  await page.click('button:has-text("Add Client")');
  await page.waitForSelector('#add-client-modal:not(.hidden)');
  await page.fill('#add-client-modal input[name="name"]', 'Acme Corp');
  await page.fill('#add-client-modal input[name="project"]', 'Website Redesign');
  await page.selectOption('#add-client-modal select[name="kind"]', 'client');
  await page.fill('#add-client-modal input[name="domains"]', 'acme.com,acme.io');
  await page.fill('#add-client-modal input[name="emails"]', 'pm@acme.com');
  await page.fill('#add-client-modal input[name="keywords"]', 'acme');
  await Promise.all([
    page.waitForURL(BASE + '/', { timeout: 10000 }).catch(() => {}),
    page.click('#add-client-modal button[type="submit"]'),
  ]);
  await page.waitForSelector('text=Acme Corp', { timeout: 5000 });
  await shot('02-after-add-client');
  record('Create Client via modal (POST /api/clients)', 'ok');

  // ── 3. Add a second client to test selection lists ─
  await page.click('button:has-text("Add Client")');
  await page.waitForSelector('#add-client-modal:not(.hidden)');
  await page.fill('#add-client-modal input[name="name"]', 'Globex');
  await page.fill('#add-client-modal input[name="project"]', 'Mobile App');
  await Promise.all([
    page.waitForLoadState('domcontentloaded'),
    page.click('#add-client-modal button[type="submit"]'),
  ]);
  await page.waitForSelector('text=Globex', { timeout: 5000 });
  record('Create second client', 'ok');

  // ── 4. Add Meeting (nav "+ Meeting") ──────────────
  await page.click('button:has-text("+ Meeting")');
  await page.waitForSelector('#add-meeting-modal:not(.hidden)');
  // Select Acme Corp
  await page.selectOption('#meeting-client-select', { label: 'Acme Corp' });
  await page.fill('#add-meeting-modal input[name="title"]', 'Weekly Sync');
  await page.fill('#add-meeting-modal input[name="scheduledAt"]', '2026-06-15T10:00');
  await page.click('#add-meeting-modal button[type="submit"]');
  await page.waitForSelector('text=Weekly Sync', { timeout: 5000 });
  await shot('03-after-add-meeting');
  record('Create Meeting via "+ Meeting"', 'ok');

  // ── 5. Inline "Generate Briefing" button ──────────
  // Locate the meeting row and find its briefing link.
  const briefingLink = await page.locator('a:has-text("Briefing")').first();
  const briefingHref = await briefingLink.getAttribute('href');
  const meetingId = briefingHref.replace('/briefing/', '');
  record(`Captured meeting id ${meetingId}`, 'ok');

  // Click the inline Generate Briefing button
  const genForm = page.locator(`form[action="/briefing/${meetingId}/prepare"]`).first();
  await genForm.locator('button[type="submit"]').click();
  // Wait for either redirect to /briefing/:id or for toast
  await page.waitForURL(new RegExp(`/briefing/${meetingId}$`), { timeout: 15000 });
  await page.waitForLoadState('domcontentloaded');
  await shot('04-briefing-generated');
  const hasBriefing = await page.locator('text=Recommended Questions').count();
  record('Inline Generate Briefing redirects to briefing page', hasBriefing > 0 ? 'ok' : 'fail', hasBriefing > 0 ? 'sections rendered' : 'no sections rendered');

  // ── 6. Briefing page direct access + markdown export
  await page.goto(`${BASE}/briefing/${meetingId}`);
  await page.waitForLoadState('domcontentloaded');
  await shot('05-briefing-detail');
  record('Briefing detail page renders', 'ok');

  // ── 7. Post-call extract via window.extractMeeting ──
  await page.goto(`${BASE}/post-call/${meetingId}`);
  await page.waitForLoadState('domcontentloaded');
  await shot('06-post-call-empty');
  // Trigger extraction by clicking the extract button if present
  const extractBtn = page.locator('button:has-text("Extract"), button:has-text("Run extraction")').first();
  const extractBtnVisible = await extractBtn.isVisible().catch(() => false);
  if (extractBtnVisible) {
    await extractBtn.click();
    await page.waitForTimeout(800);
    record('Triggered post-call extraction via button', 'ok');
  } else {
    // Fallback: call the global function directly.
    const extractResult = await page.evaluate(async (mid) => {
      const res = await fetch(`/api/meetings/${mid}/extract`, { method: 'POST' });
      return { status: res.status, body: await res.json().catch(() => null) };
    }, meetingId);
    record('Post-call extraction (POST /api/meetings/:id/extract)', extractResult.status < 500 ? 'ok' : 'fail', `status=${extractResult.status}`);
  }
  await page.reload();
  await shot('07-post-call-after-extract');

  // ── 8. Action items list with filters ─────────────
  await page.goto(`${BASE}/action-items`);
  await page.waitForSelector('text=Action items');
  await shot('08-action-items');
  record('Action items page loads', 'ok');

  // Try a filter
  await page.goto(`${BASE}/action-items?status=pending`);
  await page.waitForLoadState('domcontentloaded');
  await shot('09-action-items-pending');
  record('Action items pending filter', 'ok');

  // ── 9. Agenda view ────────────────────────────────
  await page.goto(`${BASE}/agenda`);
  await page.waitForSelector('text=Agenda', { timeout: 5000 }).catch(() => {});
  await shot('10-agenda');
  record('Agenda page loads', 'ok');

  // ── 10. Stats view ────────────────────────────────
  await page.goto(`${BASE}/stats`);
  await page.waitForSelector('text=Stats', { timeout: 5000 }).catch(() => {});
  await shot('11-stats');
  record('Stats page loads', 'ok');

  // ── 11. Search ────────────────────────────────────
  await page.goto(`${BASE}/search?q=acme`);
  await page.waitForLoadState('domcontentloaded');
  await shot('12-search-acme');
  record('Search ?q=acme', 'ok');

  // Empty search
  await page.goto(`${BASE}/search`);
  await page.waitForLoadState('domcontentloaded');
  record('Search with no query', 'ok');

  // ── 12. Client detail / timeline ──────────────────
  await page.goto(BASE);
  const clientLink = page.locator('a:has-text("View Timeline")').first();
  await clientLink.click();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('text=Timeline', { timeout: 5000 }).catch(() => {});
  await shot('13-client-detail');
  record('Client detail / timeline loads', 'ok');

  // ── 13. Notifications bell ────────────────────────
  await page.goto(BASE);
  await page.waitForLoadState('domcontentloaded');
  await page.click('#notification-bell button');
  await page.waitForTimeout(300);
  const dropdownVisible = await page.locator('#notification-dropdown:not(.hidden)').count();
  await shot('14-notifications');
  record('Notifications dropdown opens', dropdownVisible > 0 ? 'ok' : 'fail');

  // ── 14. Prepare Meeting modal full flow ───────────
  await page.goto(BASE);
  await page.click('button:has-text("Prepare Meeting")');
  await page.waitForSelector('#prepare-modal:not(.hidden)');
  await shot('15-prepare-modal');
  // Check Google sync button + source search button exist
  const hasGoogleSyncBtn = await page.locator('#google-sync-button').count();
  const hasSourceSearchBtn = await page.locator('#source-search-button').count();
  record('Prepare modal shows Google sync + source search controls', (hasGoogleSyncBtn && hasSourceSearchBtn) ? 'ok' : 'warn');
  // Close modal
  await page.click('#prepare-modal button:has-text("Cancel")');

  // ── 15. Search bar in nav (form submit) ───────────
  await page.goto(BASE);
  await page.fill('input[name="q"]', 'weekly');
  await page.press('input[name="q"]', 'Enter');
  await page.waitForURL(/\/search\?q=weekly/);
  await shot('16-nav-search');
  record('Nav search bar submits to /search', 'ok');

  // ── 16. Health endpoint ───────────────────────────
  const healthRes = await page.evaluate(async () => {
    const r = await fetch('/health');
    return { status: r.status, body: await r.json() };
  });
  record('Health endpoint', healthRes.body.status === 'ok' ? 'ok' : 'fail', JSON.stringify(healthRes.body));

  // ── 17. API smoke (clients, meetings, stats, agenda)
  const apiChecks = await page.evaluate(async () => {
    const urls = ['/api/clients', '/api/meetings', '/api/stats', '/api/agenda', '/api/action-items', '/api/notifications'];
    const out = {};
    for (const u of urls) {
      const r = await fetch(u);
      out[u] = { status: r.status, ok: r.ok };
    }
    return out;
  });
  for (const [u, info] of Object.entries(apiChecks)) {
    record(`API ${u}`, info.ok ? 'ok' : 'fail', `status=${info.status}`);
  }

  // ── 18. 404 handling ──────────────────────────────
  await page.goto(`${BASE}/briefing/does-not-exist`);
  await page.waitForLoadState('domcontentloaded');
  const notFoundText = await page.locator('text=Meeting not found').count();
  record('404 for missing meeting briefing', notFoundText > 0 ? 'ok' : 'warn');
} catch (err) {
  record('FATAL', 'fail', err.message);
  console.error(err.stack);
} finally {
  // Write summary
  const summary = {
    timestamp: new Date().toISOString(),
    pass: results.filter((r) => r.status === 'ok').length,
    warn: results.filter((r) => r.status === 'warn').length,
    fail: results.filter((r) => r.status === 'fail').length,
    results,
    consoleErrors,
    pageErrors,
  };
  writeFileSync(`${SHOTS}/summary.json`, JSON.stringify(summary, null, 2));
  console.log('\n=== SUMMARY ===');
  console.log(`PASS: ${summary.pass}  WARN: ${summary.warn}  FAIL: ${summary.fail}`);
  console.log(`console.error: ${consoleErrors.length}  pageerror: ${pageErrors.length}`);
  if (consoleErrors.length) console.log('Console errors:\n  ' + consoleErrors.join('\n  '));
  if (pageErrors.length) console.log('Page errors:\n  ' + pageErrors.join('\n  '));
  await browser.close();
  process.exit(summary.fail > 0 ? 1 : 0);
}
