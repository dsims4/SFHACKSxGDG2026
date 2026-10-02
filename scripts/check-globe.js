// Browser integration checks. Run the app first; set GLOBE_TEST_URL to its URL.
// Chrome uses a fresh temporary profile. News responses are local test fixtures.
const assert = require('node:assert/strict');
const { mkdir } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright-core');

const baseURL = process.env.GLOBE_TEST_URL || 'http://localhost:3000';
const screenshots = path.join(os.tmpdir(), 'newstralizer-globe-check');
const london = { name: 'London', country: 'United Kingdom', level: 'city', lat: 51.5, lng: -0.12 };
const rows = [
    { ...london, count: 5, topics: ['politics', 'economics'] },
    { ...london, count: 3, topics: ['economics'] },
    { name: 'Tokyo', country: 'Japan', level: 'city', lat: 35.68, lng: 139.65, count: 2, topics: ['science', 'technology'] },
    { name: 'Brazil', country: 'Brazil', level: 'country', lat: -14.23, lng: -51.92, count: 4, topics: ['environment'] }
];

async function check() {
    await mkdir(screenshots, { recursive: true });
    const browser = await chromium.launch({
        ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
        headless: true,
        args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    });
    try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
        const page = await context.newPage();
        const pageErrors = [];
        const externalRequests = [];
        page.on('pageerror', error => pageErrors.push(error.message));
        page.on('request', request => { if (new URL(request.url()).origin !== new URL(baseURL).origin) externalRequests.push(request.url()); });
        let feedMode = 'live';
        await page.route('**/api/globe?*', route => {
            if (feedMode === 'offline') return route.fulfill({ status: 503, json: { error: 'Test feed unavailable' } });
            const locations = feedMode === 'empty' ? [] : new URL(route.request().url()).searchParams.get('hours') === '24' ? [rows[0], rows[2]] : rows;
            return route.fulfill({ json: { mode: 'live', locations, end: new Date().toISOString() } });
        });
        await context.route('**/api/globe/articles?*', route => {
            const query = new URL(route.request().url()).searchParams;
            assert(['all', 'economics', 'politics', 'sports'].includes(query.get('topic')));
            return route.fulfill({ json: { articles: [{ id: '1', title: 'Test article', publisher: 'Test publisher', publication_date: new Date().toISOString(), topics: ['economics'], summary: ['A supported fact'], images: [], link: 'https://example.com/story' }], next_offset: null } });
        });
        await page.goto(baseURL);
        await page.waitForFunction(() => document.querySelector('#globe-app')?.getAttribute('aria-busy') === 'false');
        assert.equal(await page.locator('#globe-fallback').isVisible(), false);
        assert.equal(await page.locator('#globe-source').count(), 0);
        assert.equal(await page.locator('.globe-caption').count(), 0);
        await page.screenshot({ path: path.join(screenshots, 'desktop.png'), fullPage: true });

        const globe = page.locator('#globe-canvas canvas');
        const before = await globe.screenshot();
        const box = await globe.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 150, box.y + box.height / 2 + 40, { steps: 15 });
        await page.mouse.up();
        assert.notDeepEqual(await globe.screenshot(), before, 'Dragging must rotate the globe');
        await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
        await globe.focus();
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('-');
        await page.getByRole('button', { name: 'Toggle globe rotation', exact: true }).click();
        assert.equal(await page.locator('#globe-rotate').getAttribute('aria-pressed'), 'true');
        await page.getByRole('button', { name: 'Reset globe view', exact: true }).click();
        assert.equal(await page.locator('#globe-rotate').getAttribute('aria-pressed'), 'false');

        assert.equal(await page.locator('[data-layer]').count(), 0);
        assert.equal(await page.locator('.heat-legend').count(), 0);
        await page.getByRole('button', { name: 'London, 8 stories', exact: true }).click();
        await page.waitForSelector('.globe-article-card');
        assert.match(await page.locator('#globe-selection').innerText(), /Test article/);
        assert.equal(await page.locator('.location-topic-title').innerText(), 'Economics');
        await page.locator('#globe-topic').selectOption('economics');
        assert.equal(await page.locator('#globe-story-count').innerText(), '8');
        await page.locator('#globe-topic').selectOption('politics');
        assert.equal(await page.locator('#globe-story-count').innerText(), '5');
        await page.locator('#globe-topic').selectOption('sports');
        assert.equal(await page.locator('#globe-story-count').innerText(), '0');
        assert.match(await page.locator('#globe-locations').innerText(), /No mapped stories/);
        await page.locator('#globe-topic').selectOption('all');
        await page.locator('#globe-period').selectOption('24');
        await page.waitForFunction(() => document.querySelector('#globe-story-count').textContent === '7');
        await page.locator('#globe-period').selectOption('48');
        await page.waitForFunction(() => document.querySelector('#globe-story-count').textContent === '14');
        await page.getByRole('button', { name: 'Brazil, 4 stories', exact: true }).click();
        assert.equal(await page.locator('#globe-selection h3').innerText(), 'Brazil');

        feedMode = 'offline';
        await page.locator('#globe-period').selectOption('24');
        await page.waitForFunction(() => document.querySelector('#globe-data-status').textContent.includes('unavailable'));
        assert.equal(await page.locator('#globe-story-count').innerText(), '0');
        feedMode = 'empty';
        await page.locator('#globe-period').selectOption('48');
        await page.locator('#globe-period').selectOption('24');
        await page.waitForFunction(() => document.querySelector('#globe-story-count').textContent === '0');
        feedMode = 'live';
        await page.locator('#globe-period').selectOption('48');
        await page.waitForFunction(() => document.querySelector('#globe-story-count').textContent === '14');
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(() => window.scrollTo(0, 0));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'Mobile layout must not overflow');
        await page.screenshot({ path: path.join(screenshots, 'mobile.png'), fullPage: true });
        await page.getByRole('button', { name: 'Tokyo, 2 stories', exact: true }).click();
        assert.equal(await page.locator('#globe-selection h3').innerText(), 'Tokyo');
        assert.deepEqual(pageErrors, []);
        assert.deepEqual(externalRequests, [], 'No external map, tile, font, or CDN requests');

        const fallback = await context.newPage();
        await fallback.addInitScript(() => {
            const getContext = HTMLCanvasElement.prototype.getContext;
            HTMLCanvasElement.prototype.getContext = function (type, ...args) {
                return type.startsWith('webgl') ? null : getContext.call(this, type, ...args);
            };
        });
        await fallback.route('**/api/globe?*', route => route.fulfill({ json: { mode: 'live', locations: rows, end: new Date().toISOString() } }));
        await fallback.goto(baseURL);
        await fallback.waitForFunction(() => document.querySelector('#globe-app')?.getAttribute('aria-busy') === 'false');
        assert.equal(await fallback.locator('#globe-fallback').isVisible(), true);
        await fallback.getByRole('button', { name: 'London, 8 stories', exact: true }).click();
        assert.equal(await fallback.locator('#globe-selection h3').innerText(), 'London');
        console.log('Globe checks passed: rendering, rotation, zoom, layers, locations, filters, live/empty/offline feeds, mobile, WebGL fallback, and zero external requests.');
        console.log(`Screenshots: ${screenshots}`);
    } finally {
        await browser.close();
    }
}

check().catch(error => { console.error(error); process.exitCode = 1; });
