const test = require('node:test');
const assert = require('node:assert/strict');
const { createNewsRouter } = require('../routes/news');
const { createPublicRouter } = require('../routes/public');

async function requestGlobe(query = {}, rows = []) {
    const calls = [];
    const router = createNewsRouter({ query: async (sql, values) => { calls.push({ sql, values }); return { rows }; } });
    const route = router.stack.find(item => item.route?.path === '/globe');
    const response = { statusCode: 200, headers: {},
        status(code) { this.statusCode = code; return this; },
        set(key, value) { this.headers[key] = value; return this; },
        json(body) { this.body = body; return this; } };
    await route.route.stack[0].handle({ query }, response);
    return { ...response, calls };
}

test('globe API uses bounded dates, valid coordinates, and all original topic labels', async () => {
    const rows = [{ name: 'London', lat: 51.5, lng: -0.1, topics: ['politics', 'economics'], count: 3 }];
    for (const hours of ['24', '48']) {
        const response = await requestGlobe({ hours }, rows);
        assert.deepEqual(response.body.locations, rows);
        assert.equal(response.body.mode, 'live');
        assert.equal(Date.parse(response.body.end) - Date.parse(response.body.start), Number(hours) * 3600000);
        assert.deepEqual(response.calls[0].values, [response.body.start, response.body.end]);
        assert.match(response.calls[0].sql, /cardinality\(topics\) > 0/);
        assert.match(response.calls[0].sql, /location_lat BETWEEN -90 AND 90/);
        assert.match(response.calls[0].sql, /location_lng BETWEEN -180 AND 180/);
        assert.doesNotMatch(response.calls[0].sql, /UNNEST/i);
    }
    assert.deepEqual((await requestGlobe()).body.locations, []);
});

test('globe API rejects malformed, repeated and unbounded time ranges before querying', async () => {
    for (const hours of ['', '0', '168', '24 OR true', ['24', '48'], 24]) {
        const response = await requestGlobe({ hours });
        assert.equal(response.statusCode, 400);
        assert.equal(response.calls.length, 0);
    }
});

test('multi-label story counts stay unique, filters retain labels, and invalid locations are omitted', async () => {
    const { aggregateLocations } = await import('../client/globe-data.mjs');
    const london = { name: 'London', country: 'UK', level: 'city', lat: 51.5, lng: -0.1 };
    const rows = [
        { ...london, topics: ['politics', 'economics', 'politics'], count: 5 },
        { ...london, topics: ['economics'], count: 3 },
        { ...london, topics: [], count: 50 },
        { ...london, topics: ['politics'], lat: null, count: 50 },
        { ...london, topics: ['politics'], lng: Infinity, count: 50 },
        { ...london, topics: ['politics'], lat: 91, count: 50 },
        { ...london, topics: ['politics'], count: -2 }
    ];
    assert.equal(aggregateLocations(rows)[0].count, 8);
    assert.deepEqual(aggregateLocations(rows)[0].topics, { politics: 5, economics: 8 });
    assert.equal(aggregateLocations(rows, 'politics')[0].count, 5);
    assert.deepEqual(aggregateLocations(rows, 'science'), []);
});

test('spherical heatmap wraps across the date line and adds overlapping stories', async () => {
    const { createDensity, globePosition } = await import('../client/globe-data.mjs');
    const one = createDensity([{ lat: 0, lng: 180, count: 10 }], 360, 180);
    assert.ok(one[90 * 360] > 9);
    assert.ok(Math.abs(one[90 * 360] - one[90 * 360 + 359]) < 0.0001);
    assert.equal(one[90 * 360 + 180], 0);
    const two = createDensity([{ lat: 0, lng: 180, count: 20 }], 360, 180);
    assert.equal(two[90 * 360], one[90 * 360] * 2);
    const poles = createDensity([{ lat: 90, lng: 0, count: 1 }], 360, 180);
    assert.ok(Math.abs(poles[0] - poles[180]) < 0.0001);
    assert.deepEqual(globePosition(0, 0), [1, 0, -0]);
    assert.ok(Math.abs(globePosition(0, 90)[2] + 1) < 0.0001);
});

test('homepage keeps the globe and briefing fallback available during a database failure', async () => {
    const router = createPublicRouter({ query: async () => { throw new Error('Test database failure'); } });
    const route = router.stack.find(item => item.route?.path === '/');
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; },
        render(template, data) { this.template = template; this.data = data; return this; } };
    await route.route.stack[0].handle({}, response);
    assert.equal(response.statusCode, 503);
    assert.equal(response.template, 'index.njk');
    assert.deepEqual(response.data.topics, []);
});

test('location articles validate filters and return bounded article pages', async () => {
    const calls = [];
    const router = createNewsRouter({ query: async (sql, values) => {
        calls.push({ sql, values });
        return { rows: Array.from({ length: 51 }, (_, id) => ({ id: String(id) })) };
    } });
    const route = router.stack.find(item => item.route?.path === '/globe/articles');
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    const query = { name: 'London', country: 'United Kingdom', level: 'city', lat: '51.5', lng: '-0.12', topic: 'economics', hours: '24' };
    await route.route.stack[0].handle({ query }, response);
    assert.equal(response.body.articles.length, 50);
    assert.equal(response.body.next_offset, 50);
    assert.deepEqual(calls[0].values.slice(0, 6), ['London', 'United Kingdom', 'city', 51.5, -0.12, 'economics']);
    await route.route.stack[0].handle({ query: { ...query, lat: '91' } }, response);
    assert.equal(response.statusCode, 400);
    assert.equal(calls.length, 1);
});
