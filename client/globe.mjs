import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { geoEquirectangular, geoPath } from 'd3-geo';
import { feature, mesh } from 'topojson-client';
import world from 'world-atlas/countries-110m.json';
import { TOPICS, aggregateLocations, globePosition } from './globe-data.mjs';

const $ = id => document.getElementById(id);
const format = new Intl.NumberFormat('en-US');
const titleCase = text => text.charAt(0).toUpperCase() + text.slice(1);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const state = { rows: [], locations: [], selected: null, articleRequest: null, request: null, renderer: null };

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function showSelection(location) {
    state.articleRequest?.abort();
    state.selected = location?.id || null;
    state.renderer?.select(location);
    $('globe-location').value = state.selected || '';
    for (const button of $('globe-locations').children) button.setAttribute('aria-pressed', String(button.dataset.location === state.selected));
    const panel = $('globe-selection');
    panel.replaceChildren(element('p', 'detail-eyebrow', 'A CLOSER LOOK'));
    panel.append(element('h3', '', location?.name || 'A world of perspectives'));
    if (!location) {
        panel.append(element('p', '', 'Select a location to read its articles.'));
        return;
    }
    panel.append(element('p', '', `${location.country} · ${format.format(location.count)} articles`));
    loadArticles(location);

}

function safeURL(value) {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; }
    catch { return null; }
}

async function loadArticles(location, offset = 0) {
    state.articleRequest?.abort();
    const controller = new AbortController();
    state.articleRequest = controller;
    const panel = $('globe-selection');
    const status = element('p', '', 'Loading articles…');
    panel.append(status);
    const params = new URLSearchParams({ name: location.sourceName, country: location.country, level: location.level,
        lat: location.lat, lng: location.lng, topic: $('globe-topic').value, hours: $('globe-period').value, offset });
    try {
        const response = await fetch(`/api/globe/articles?${params}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
        if (!response.ok) throw new Error('Articles unavailable');
        const data = await response.json();
        if (state.articleRequest !== controller) return;
        status.remove();
        for (const article of data.articles) {
            const card = element('article', 'news-card globe-article-card');
            const heading = element('h4', 'news-card-title');
            const link = safeURL(article.link);
            const title = element(link ? 'a' : 'span', '', article.title || 'Untitled article');
            if (link) { title.href = link; title.target = '_blank'; title.rel = 'noopener noreferrer'; }
            heading.append(title);
            card.append(heading);
            const date = new Date(article.publication_date);
            card.append(element('p', 'news-card-meta', `${article.publisher || ''} · ${Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-US', { timeZone: 'UTC' })} UTC`));
            card.append(element('p', 'article-topics', `Topics: ${(article.topics || []).map(titleCase).join(' · ')}`));
            const list = element('ul', 'news-card-summary');
            for (const bullet of article.summary || []) if (typeof bullet === 'string' && bullet.trim()) list.append(element('li', '', bullet));
            if (list.children.length) card.append(list);
            const images = element('div', 'article-images');
            for (const value of (article.images || []).slice(0, 3)) {
                const url = safeURL(typeof value === 'string' ? value : value?.url);
                if (!url) continue;
                const image = element('img'); image.src = url; image.alt = 'Image from the article'; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
                images.append(image);
            }
            if (images.children.length) card.append(images);
            const selectedTopic = $('globe-topic').value;
            const topics = [...new Set((article.topics || []).filter(topic => TOPICS.includes(topic)))].sort();
            for (const topic of selectedTopic === 'all' ? topics : topics.filter(topic => topic === selectedTopic)) {
                let group = [...panel.querySelectorAll('.location-topic-group')].find(node => node.dataset.topic === topic);
                if (!group) {
                    group = element('section', 'location-topic-group'); group.dataset.topic = topic;
                    group.append(element('h4', 'location-topic-title', titleCase(topic)));
                    panel.append(group);
                }
                group.append(card.cloneNode(true));
            }
        }
        if (!data.articles.length && offset === 0) panel.append(element('p', '', 'No articles match these filters.'));
        if (data.next_offset !== null) {
            const more = element('button', 'article-more', 'More articles'); more.type = 'button';
            more.addEventListener('click', () => { more.remove(); loadArticles(location, data.next_offset); }); panel.append(more);
        }
    } catch {
        if (state.articleRequest === controller) status.textContent = 'Could not load articles. Select the location again to retry.';
    }
}

function selectLocation(location) {
    showSelection(location);
    if (location) state.renderer?.focus(location);
}

function refreshLocations() {
    state.locations = aggregateLocations(state.rows, $('globe-topic').value);
    const total = state.locations.reduce((sum, location) => sum + location.count, 0);
    $('globe-story-count').textContent = format.format(total);
    $('globe-location-count').textContent = format.format(state.locations.length);
    $('globe-location').replaceChildren(new Option('Choose a location', ''));
    for (const location of [...state.locations].sort((a, b) => a.name.localeCompare(b.name))) {
        $('globe-location').append(new Option(`${location.name} · ${format.format(location.count)}`, location.id));
    }
    $('globe-location').disabled = !state.locations.length;
    const list = $('globe-locations');
    list.replaceChildren();
    state.locations.forEach((location, index) => {
        const button = element('button', 'hotspot');
        button.type = 'button';
        button.dataset.location = location.id;
        button.setAttribute('aria-pressed', 'false');
        button.setAttribute('aria-label', `${location.name}, ${format.format(location.count)} stories`);
        button.append(element('span', 'hotspot-rank', String(index + 1).padStart(2, '0')),
            element('span', 'hotspot-name', location.name), element('span', 'hotspot-count', format.format(location.count)));
        button.addEventListener('click', () => selectLocation(location));
        list.append(button);
    });
    if (!state.locations.length) list.append(element('p', 'hotspot-empty', 'No mapped stories match this topic and time period. Try another filter.'));
    showSelection(state.locations.find(location => location.id === state.selected));
    state.renderer?.update(state.locations);
}

async function loadStories() {
    state.request?.abort();
    const controller = new AbortController();
    state.request = controller;
    $('globe-app').setAttribute('aria-busy', 'true');
    $('globe-data-status').textContent = 'Loading articles';
    const timeout = setTimeout(() => controller.abort(), 10000);
    let failed = false;
    try {
        const response = await fetch(`/api/globe?hours=${$('globe-period').value}`, { signal: controller.signal });
        if (!response.ok) throw new Error('Articles unavailable');
        const data = await response.json();
        if (!Array.isArray(data.locations)) throw new Error('Invalid locations');
        state.rows = data.locations;
    } catch {
        if (state.request !== controller) return;
        state.rows = [];
        failed = true;
    } finally { clearTimeout(timeout); }
    if (state.request !== controller) return;
    $('globe-data-status').textContent = failed ? 'Articles unavailable. Change the date filter to retry.' : 'Latest articles';
    $('globe-app').setAttribute('aria-busy', 'false');
    refreshLocations();
}

function makeMapTexture(dark = document.documentElement.dataset.theme === 'dark') {
    const canvas = document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = 1024;
    const context = canvas.getContext('2d');
    const projection = geoEquirectangular().translate([1024, 512]).scale(2048 / (2 * Math.PI));
    const path = geoPath(projection, context);
    context.fillStyle = dark ? '#212121' : '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.beginPath();
    path(feature(world, world.objects.land));
    context.fillStyle = dark ? '#212121' : '#ffffff';
    context.fill();
    context.strokeStyle = dark ? '#ffffff' : '#000000';
    context.lineWidth = 3.6;
    context.stroke();
    context.beginPath();
    path(mesh(world, world.objects.countries, (a, b) => a !== b));
    context.strokeStyle = dark ? '#ffffff' : '#000000';
    context.lineWidth = 1.6;
    context.stroke();
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

function makeGlobe() {
    const container = $('globe-canvas');
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(39, 1, 0.1, 40);
    const initialPosition = new THREE.Vector3(...globePosition(23, -22, 3.5));
    camera.position.copy(initialPosition);
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0xffffff, 0);
    container.append(renderer.domElement);
    const canvas = renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', '3D globe of story locations. Drag to rotate, scroll to zoom, or use arrow keys and plus or minus. Choose a location in the list for story counts.');
    const controls = new OrbitControls(camera, canvas);
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.rotateSpeed = 0.6;
    controls.zoomSpeed = 0.6;
    controls.minDistance = 1.7;
    controls.maxDistance = 5;
    controls.minPolarAngle = 0.12;
    controls.maxPolarAngle = Math.PI - 0.12;
    controls.autoRotateSpeed = 0.3;

    const sphereGeometry = new THREE.SphereGeometry(1, 96, 64);
    const earth = new THREE.Mesh(sphereGeometry, new THREE.MeshBasicMaterial({ map: makeMapTexture() }));
    scene.add(earth);
    // Back-facing shell draws a crisp silhouette without covering the map.
    const outline = new THREE.Mesh(sphereGeometry,
        new THREE.MeshBasicMaterial({ color: '#000000', side: THREE.BackSide }));
    outline.scale.setScalar(1.022);
    scene.add(outline);
    const markers = new THREE.Group();
    const columns = new THREE.Group();
    scene.add(markers, columns);
    const selectionRing = new THREE.Mesh(new THREE.RingGeometry(0.018, 0.025, 40),
        new THREE.MeshBasicMaterial({ color: '#000000', side: THREE.DoubleSide, depthWrite: false }));
    selectionRing.visible = false;
    scene.add(selectionRing);
    const dotGeometry = new THREE.SphereGeometry(0.008, 10, 8);
    const dotMaterial = new THREE.MeshBasicMaterial({ color: '#000000' });
    const columnGeometry = new THREE.CylinderGeometry(0.0045, 0.009, 1, 8);
    const columnMaterial = new THREE.MeshBasicMaterial({ color: '#777777' });
    function updateTheme() {
        const dark = document.documentElement.dataset.theme === 'dark';
        const previous = earth.material.map;
        earth.material.map = makeMapTexture(dark);
        earth.material.needsUpdate = true;
        previous.dispose();
        outline.material.color.set(dark ? '#ffffff' : '#000000');
        dotMaterial.color.set(dark ? '#ffffff' : '#000000');
        selectionRing.material.color.set(dark ? '#ffffff' : '#000000');
    }
    const themeObserver = new MutationObserver(updateTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    updateTheme();
    const pointer = new THREE.Vector2();
    const raycaster = new THREE.Raycaster();
    const direction = new THREE.Vector3(0, 1, 0);
    let flight = null;
    let disposed = false;
    let visible = true;
    let frame = null;
    let lastTime = 0;

    function setRotation(enabled) {
        controls.autoRotate = enabled;
        $('globe-rotate').setAttribute('aria-pressed', String(enabled));
    }
    function stopMotion() {
        flight = null;
        setRotation(false);
        $('globe-tooltip').hidden = true;
    }
    controls.addEventListener('start', stopMotion);
    function resize() {
        const { width, height } = container.getBoundingClientRect();
        if (!width || !height) return;
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height);
        // Keep the globe inside narrow canvases, including portrait phones.
        controls.minDistance = Math.max(1.7, 1.2 / (Math.tan(THREE.MathUtils.degToRad(19.5)) * Math.min(camera.aspect, 1)));
        controls.minDistance = Math.min(4.5, controls.minDistance * 0.65);
        if (camera.position.length() < controls.minDistance) camera.position.setLength(controls.minDistance);
    }
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();
    function animate(time) {
        frame = null;
        if (disposed || !visible || document.hidden) return;
        const delta = Math.min((time - lastTime) / 1000, 0.1);
        lastTime = time;
        if (flight) {
            const t = Math.min(1, (time - flight.time) / 1000);
            const smooth = t * t * (3 - 2 * t);
            const turn = new THREE.Quaternion().slerp(flight.rotation, smooth);
            camera.position.copy(flight.start).applyQuaternion(turn);
            if (t === 1) flight = null;
        }
        controls.update(delta);
        renderer.render(scene, camera);
        frame = requestAnimationFrame(animate);
    }
    function resume() { if (frame === null && !disposed && visible && !document.hidden) frame = requestAnimationFrame(animate); }
    const intersection = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; resume(); });
    intersection.observe(container);
    document.addEventListener('visibilitychange', resume);
    resume();

    function pick(event) {
        const box = canvas.getBoundingClientRect();
        pointer.set((event.clientX - box.left) / box.width * 2 - 1, -((event.clientY - box.top) / box.height) * 2 + 1);
        raycaster.setFromCamera(pointer, camera);
        // First intersect the surface, so the back side is never selectable.
        const hit = raycaster.intersectObject(earth)[0];
        if (!hit) return null;
        const normal = hit.point.normalize();
        let closest = null;
        let best = 0.994;
        for (const location of state.locations) {
            const dot = normal.dot(new THREE.Vector3(...globePosition(location.lat, location.lng)));
            if (dot > best) { closest = location; best = dot; }
        }
        return closest;
    }
    let pointerStart = null;
    canvas.addEventListener('pointerdown', event => { pointerStart = [event.clientX, event.clientY]; });
    canvas.addEventListener('pointerup', event => {
        if (pointerStart && Math.hypot(event.clientX - pointerStart[0], event.clientY - pointerStart[1]) < 5) {
            const location = pick(event);
            if (location) selectLocation(location);
        }
        pointerStart = null;
    });
    canvas.addEventListener('pointermove', event => {
        if (event.buttons) return;
        const location = pick(event);
        const tooltip = $('globe-tooltip');
        tooltip.hidden = !location;
        canvas.style.cursor = location ? 'pointer' : 'grab';
        if (location) {
            tooltip.textContent = `${location.name} · ${format.format(location.count)} stories`;
            const box = container.parentElement.getBoundingClientRect();
            tooltip.style.left = `${Math.max(10, Math.min(event.clientX - box.left + 14, box.width - 224))}px`;
            tooltip.style.top = `${Math.max(10, event.clientY - box.top - 42)}px`;
        }
    });
    canvas.addEventListener('pointerleave', () => { $('globe-tooltip').hidden = true; });
    canvas.addEventListener('pointercancel', () => { pointerStart = null; });
    function zoom(factor) {
        stopMotion();
        camera.position.setLength(THREE.MathUtils.clamp(camera.position.length() * factor, controls.minDistance, controls.maxDistance));
        controls.update();
    }
    $('globe-zoom-in').addEventListener('click', () => zoom(0.85));
    $('globe-zoom-out').addEventListener('click', () => zoom(1.15));
    $('globe-reset').addEventListener('click', () => {
        stopMotion();
        controls.reset();
        camera.position.copy(initialPosition);
        controls.update();
        showSelection(null);
    });
    $('globe-rotate').addEventListener('click', () => { flight = null; setRotation(!controls.autoRotate); });
    const onMotionPreference = () => { if (reducedMotion.matches) stopMotion(); };
    reducedMotion.addEventListener('change', onMotionPreference);
    canvas.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-'].includes(event.key)) return;
        event.preventDefault();
        stopMotion();
        if (['+', '=', '-'].includes(event.key)) return zoom(event.key === '-' ? 1.15 : 0.85);
        const spherical = new THREE.Spherical().setFromVector3(camera.position);
        if (event.key === 'ArrowLeft') spherical.theta -= 0.12;
        if (event.key === 'ArrowRight') spherical.theta += 0.12;
        if (event.key === 'ArrowUp') spherical.phi -= 0.12;
        if (event.key === 'ArrowDown') spherical.phi += 0.12;
        spherical.phi = THREE.MathUtils.clamp(spherical.phi, controls.minPolarAngle, controls.maxPolarAngle);
        camera.position.setFromSpherical(spherical);
        controls.update();
    });
    canvas.addEventListener('webglcontextlost', event => {
        event.preventDefault();
        dispose();
        showFallback();
    });

    function update(locations) {
        if (disposed) return;
        markers.clear();
        columns.clear();
        const peak = Math.max(1, ...locations.map(location => location.count));
        for (const location of locations) {
            const normal = new THREE.Vector3(...globePosition(location.lat, location.lng));
            const dot = new THREE.Mesh(dotGeometry, dotMaterial);
            dot.position.copy(normal).multiplyScalar(1.009);
            markers.add(dot);
            const height = 0.02 + 0.28 * location.count / peak;
            const bar = new THREE.Mesh(columnGeometry, columnMaterial);
            bar.scale.y = height;
            bar.position.copy(normal).multiplyScalar(1 + height / 2);
            bar.quaternion.setFromUnitVectors(direction, normal);
            columns.add(bar);
        }
    }
    function focus(location) {
        if (disposed) return;
        stopMotion();
        controls.update();
        const start = camera.position.clone();
        const target = new THREE.Vector3(...globePosition(location.lat, location.lng));
        if (reducedMotion.matches) camera.position.copy(target).multiplyScalar(start.length());
        else flight = { start, rotation: new THREE.Quaternion().setFromUnitVectors(start.clone().normalize(), target), time: performance.now() };
        controls.update();
    }
    function select(location) {
        selectionRing.visible = Boolean(location);
        if (location) {
            const normal = new THREE.Vector3(...globePosition(location.lat, location.lng));
            selectionRing.position.copy(normal).multiplyScalar(1.015);
            selectionRing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
        }
    }
    function dispose() {
        if (disposed) return;
        disposed = true;
        if (frame !== null) cancelAnimationFrame(frame);
        resizeObserver.disconnect();
        intersection.disconnect();
        document.removeEventListener('visibilitychange', resume);
        reducedMotion.removeEventListener('change', onMotionPreference);
        themeObserver.disconnect();
        controls.dispose();
        const geometries = new Set();
        const materials = new Set();
        scene.traverse(object => { if (object.geometry) geometries.add(object.geometry); if (object.material) materials.add(object.material); });
        for (const geometry of geometries) geometry.dispose();
        for (const material of materials) { material.map?.dispose(); material.dispose(); }
        dotGeometry.dispose();
        dotMaterial.dispose();
        columnGeometry.dispose();
        columnMaterial.dispose();
        renderer.dispose();
    }
    // A page retained in the back/forward cache must keep its WebGL resources.
    window.addEventListener('pagehide', event => { if (!event.persisted) dispose(); });
    $('globe-loading').hidden = true;
    return { update, focus, select };
}

function showFallback() {
    $('globe-loading').hidden = true;
    $('globe-fallback').hidden = false;
    $('globe-canvas').hidden = true;
    document.querySelectorAll('.globe-controls button').forEach(button => { button.disabled = true; });
}

for (const topic of [...TOPICS].sort()) $('globe-topic').append(new Option(titleCase(topic), topic));
$('globe-topic').addEventListener('change', refreshLocations);
$('globe-period').addEventListener('change', loadStories);
$('globe-location').addEventListener('change', event => selectLocation(state.locations.find(location => location.id === event.target.value)));
try { state.renderer = makeGlobe(); } catch (error) { console.warn('Globe rendering unavailable:', error.message); showFallback(); }
loadStories();
