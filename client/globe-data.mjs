export const TOPICS = ['economics', 'environment', 'politics', 'technology', 'science', 'health', 'business', 'sports', 'culture', 'world'];

// These coordinates match Three.js SphereGeometry's equirectangular UVs.
export function globePosition(lat, lng, radius = 1) {
    const phi = lat * Math.PI / 180;
    const theta = lng * Math.PI / 180;
    return [radius * Math.cos(phi) * Math.cos(theta), radius * Math.sin(phi), -radius * Math.cos(phi) * Math.sin(theta)];
}

export function aggregateLocations(rows, topic = 'all') {
    const locations = new Map();
    for (const row of rows) {
        if (typeof row.lat !== 'number' || typeof row.lng !== 'number' ||
            !Number.isFinite(row.lat) || !Number.isFinite(row.lng) ||
            Math.abs(row.lat) > 90 || Math.abs(row.lng) > 180 ||
            !Number.isSafeInteger(row.count) || row.count <= 0 || !Array.isArray(row.topics)) continue;
        const topics = [...new Set(row.topics.filter(t => TOPICS.includes(t)))];
        if (!topics.length || (topic !== 'all' && !topics.includes(topic))) continue;
        const key = JSON.stringify([row.name, row.country, row.level, row.lat, row.lng]);
        const location = locations.get(key) || {
            id: key, sourceName: row.name || '', name: row.name || row.country || 'Unnamed location', country: row.country || '',
            level: row.level === 'city' ? 'city' : 'country', lat: row.lat, lng: row.lng, count: 0, topics: {}
        };
        location.count += row.count;
        for (const label of topics) location.topics[label] = (location.topics[label] || 0) + row.count;
        locations.set(key, location);
    }
    return [...locations.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// Great-circle Gaussian kernels preserve distance near the poles and wrap at
// the date line. Overlapping kernels add, rather than covering one another.
export function createDensity(locations, width = 1024, height = 512) {
    const density = new Float32Array(width * height);
    const rad = Math.PI / 180;
    const sigma = 5 * rad;
    const cutoff = Math.cos(sigma * 3);
    const longitudes = Array.from({ length: width }, (_, x) => ((x + 0.5) / width * 360 - 180) * rad);
    for (const point of locations) {
        const latitude = point.lat * rad;
        const longitude = point.lng * rad;
        const minY = Math.max(0, Math.floor((90 - point.lat - 15) / 180 * height));
        const maxY = Math.min(height - 1, Math.ceil((90 - point.lat + 15) / 180 * height));
        const cosDelta = longitudes.map(value => Math.cos(value - longitude));
        for (let y = minY; y <= maxY; y++) {
            const lat = (90 - (y + 0.5) / height * 180) * rad;
            const a = Math.sin(lat) * Math.sin(latitude);
            const b = Math.cos(lat) * Math.cos(latitude);
            for (let x = 0; x < width; x++) {
                const cosine = a + b * cosDelta[x];
                if (cosine < cutoff) continue;
                const distance = Math.acos(Math.min(1, Math.max(-1, cosine)));
                density[y * width + x] += point.count * Math.exp(-distance * distance / (2 * sigma * sigma));
            }
        }
    }
    return density;
}

export function demoRows(cities, hours) {
    return cities.flatMap((city, index) => {
        const total = Math.max(4, Math.round((148 / (1 + index * 0.18)) * (hours === 24 ? 0.57 : 1)));
        const primary = TOPICS[[2, 0, 9, 3, 3, 1, 8, 5, 1, 6, 9, 6, 0, 3, 2, 5, 7, 4, 1, 8, 7, 2][index % 22]];
        const secondary = TOPICS[(index + 4) % TOPICS.length];
        return [
            { ...city, topics: [...new Set([primary, secondary])], count: Math.ceil(total * 0.6) },
            { ...city, topics: [primary], count: Math.floor(total * 0.4) }
        ];
    });
}
