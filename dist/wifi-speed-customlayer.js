/*!
 * wifi-speed-customlayer
 * Wi-Fi speed layer for MapLibre GL JS (CustomLayerInterface, one addLayer call).
 * Data: https://wifi.pancake-trail.site/
 *
 * License: CC0 1.0 Universal (Public Domain) - https://creativecommons.org/publicdomain/zero/1.0/
 *
 * Usage (script tag):
 *   <script src="https://unpkg.com/wifi-speed-customlayer"></script>
 *   map.on('load', () => {
 *     map.addLayer(new WifiSpeedLayer({ language: 'auto', controlPosition: 'top-right' }));
 *   });
 *
 * Usage (bundler / CommonJS):
 *   import WifiSpeedLayer from 'wifi-speed-customlayer';
 *   map.addLayer(new WifiSpeedLayer({ maplibregl }));   // pass maplibregl when it is not a global
 *
 * Registration and deletion are done on wifi.pancake-trail.site.
 * This library only opens a link there (fixed origin, numeric/enum params only). No API key, no POST.
 */
(function (root, factory) {
    if (typeof define === 'function' && define.amd) define([], factory);
    else if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.WifiSpeedLayer = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /* ---------- constants (fixed on purpose) ---------- */
    const SITE_ORIGIN = 'https://wifi.pancake-trail.site';
    const SITE_URL = SITE_ORIGIN + '/';
    const THEME_BASE = SITE_ORIGIN + '/wp-content/themes/pancake-trail/';
    const DEFAULT_MESH_BASE = THEME_BASE + 'pancake-trail_wifijson/';
    const DEFAULT_CLUSTER_URL = THEME_BASE + 'pancake-trail_json/wifi_cluster_latitude_and_longitude.json';
    const SWITCH_ZOOM = 11;            // cluster (< 11) <-> mesh points (>= 11)
    const PARAM_PREFIX = 'ptw_';       // prefix to avoid clashing with WordPress query vars
    const MAX_BYTES = 2 * 1024 * 1024; // max JSON text size per request
    const MAX_FEATURES = 5000;         // max features per mesh
    const MAX_MESHES = 400;            // max meshes requested at once
    const CONCURRENCY = 6;             // max simultaneous requests
    const POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

    const STRINGS = {
        en: {
            register: 'Register a Wi-Fi spot (opens wifi.pancake-trail.site)',
            del: 'Delete this Wi-Fi spot (opens wifi.pancake-trail.site)',
            speed: 'Wi-Fi speed',
            gmap: 'Open in Google Maps'
        },
        ja: {
            register: 'Wi-Fi スポットを登録（wifi.pancake-trail.site を開きます）',
            del: 'このWi-Fi スポットを削除（wifi.pancake-trail.site を開きます）',
            speed: 'Wi-Fi 速度',
            gmap: 'Google マップで開く'
        }
    };

    // 20x20 line icons (same stroke style as MapLibre's built-in controls): a map pin with + / -
    const PIN = 'M10 17.5c-3-2.9-5.5-5.6-5.5-9a5.5 5.5 0 0 1 11 0c0 3.4-2.5 6.1-5.5 9z';
    const ICON_ADD = [PIN, 'M10 6v5M7.5 8.5h5'];
    const ICON_REMOVE = [PIN, 'M7.5 8.5h5'];

    /* ---------- helpers ---------- */
    const isNum = v => typeof v === 'number' && Number.isFinite(v);
    const wrapLon = lon => ((lon + 180) % 360 + 360) % 360 - 180;
    const abortError = () => { const e = new Error('Aborted'); e.name = 'AbortError'; return e; };

    // The server stores descriptions with esc_attr (&amp; &quot; &#039; ...). We render with textContent only,
    // so decode the common entities once, here, as plain text (never as HTML).
    const ENTITIES = { '&#039;': "'", '&#39;': "'", '&apos;': "'", '&quot;': '"', '&lt;': '<', '&gt;': '>', '&amp;': '&' };
    function decodeEntities(s) {
        return String(s).replace(/&(?:#0?39|apos|quot|lt|gt|amp);/g, m => ENTITIES[m]);
    }

    function resolveLang(v) {
        if (v === 'en' || v === 'ja') return v;
        const l = (navigator.languages && navigator.languages[0]) || navigator.language || '';
        return String(l).toLowerCase().startsWith('ja') ? 'ja' : 'en';
    }

    // https only (http is allowed for localhost during development), no embedded credentials
    function safeUrl(value, name) {
        let u;
        try { u = new URL(String(value), location.href); } catch (e) { throw new Error(`${name} is not a valid URL`); }
        const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
        if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local))) throw new Error(`${name} must be https`);
        if (u.username || u.password) throw new Error(`${name} must not contain credentials`);
        return u.href;
    }

    function pick(value, allowed, fallback) {
        return allowed.indexOf(value) !== -1 ? value : fallback;
    }

    function clampNum(v, min, max, fallback) {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    }

    // Rebuild GeoJSON from scratch; never trust the shape or content of remote data
    function sanitizePoints(json) {
        const out = [];
        if (!json || json.type !== 'FeatureCollection' || !Array.isArray(json.features)) return out;
        for (const f of json.features.slice(0, MAX_FEATURES)) {
            const g = f && f.geometry;
            const p = (f && f.properties) || {};
            if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates)) continue;
            const lng = g.coordinates[0], lat = g.coordinates[1];
            if (!isNum(lng) || !isNum(lat) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
            const speed = Number(p.wifi_speed);
            const id = String(p.id == null ? '' : p.id);
            if (!Number.isFinite(speed) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue;
            const description = decodeEntities(String(p.description == null ? '' : p.description)
                .replace(/\\?&#0?39;/g, "'")).slice(0, 200);
            out.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [lng, lat] },
                properties: { id, description, wifi_speed: speed }
            });
        }
        return out;
    }

    function sanitizeClusters(json) {
        const out = [];
        if (!json || json.type !== 'FeatureCollection' || !Array.isArray(json.features)) return out;
        for (const f of json.features.slice(0, 20000)) {
            const g = f && f.geometry;
            const p = (f && f.properties) || {};
            if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates)) continue;
            const lng = g.coordinates[0], lat = g.coordinates[1];
            const count = Number(p.count);
            if (!isNum(lng) || !isNum(lat) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
            if (!Number.isFinite(count) || count < 0) continue;
            out.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [lng, lat] },
                properties: { count: Math.floor(count) }
            });
        }
        return out;
    }

    function makeSvg(paths) {
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', '0 0 20 20');
        svg.setAttribute('width', '20');
        svg.setAttribute('height', '20');
        svg.setAttribute('aria-hidden', 'true');
        svg.style.display = 'block';
        paths.forEach(d => {
            const p = document.createElementNS(NS, 'path');
            p.setAttribute('d', d);
            p.setAttribute('fill', 'none');
            p.setAttribute('stroke', '#333');
            p.setAttribute('stroke-width', '1.8');
            p.setAttribute('stroke-linecap', 'round');
            p.setAttribute('stroke-linejoin', 'round');
            svg.appendChild(p);
        });
        return svg;
    }

    // Reuse a plain text-font stack already used by the style's own symbol layers,
    // so the labels use the glyphs endpoint of the style.json as-is.
    function styleTextFont(map) {
        const style = map.getStyle();
        const layers = (style && style.layers) || [];
        for (const l of layers) {
            if (l.type !== 'symbol') continue;
            const f = l.layout && l.layout['text-font'];
            if (Array.isArray(f) && f.length && f.every(x => typeof x === 'string')) return f.slice();
        }
        return null; // fall back to MapLibre's default font stack
    }

    /* ---------- UI control (same look as MapLibre's control group) ---------- */
    class Control {
        constructor(owner) { this._o = owner; this._c = null; }

        onAdd() {
            const c = document.createElement('div');
            c.className = 'maplibregl-ctrl maplibregl-ctrl-group';
            this._reg = this._btn(ICON_ADD, () => this._o._openRegister());
            this._del = this._btn(ICON_REMOVE, () => this._o._openDelete());
            this._c = c;
            this.update();
            return c;
        }

        onRemove() {
            if (this._c && this._c.parentNode) this._c.parentNode.removeChild(this._c);
            this._c = null;
        }

        // Same markup as MapLibre's own controls: <button><span class="maplibregl-ctrl-icon">…</span></button>
        _btn(icon, handler) {
            const b = document.createElement('button');
            b.type = 'button';
            const span = document.createElement('span');
            span.className = 'maplibregl-ctrl-icon';
            span.setAttribute('aria-hidden', 'true');
            span.style.display = 'flex';
            span.style.alignItems = 'center';
            span.style.justifyContent = 'center';
            span.appendChild(makeSvg(icon));
            b.appendChild(span);
            b.addEventListener('click', handler);
            return b;
        }

        update() {
            if (!this._c) return;
            const o = this._o;
            const t = STRINGS[o._lang];
            this._reg.title = t.register;
            this._reg.setAttribute('aria-label', t.register);
            this._del.title = t.del;
            this._del.setAttribute('aria-label', t.del);

            // Only visible buttons stay in the DOM. MapLibre's CSS rounds the corners with
            // :first-child / :last-child / :only-child, which would count hidden buttons too.
            const visible = [];
            if (o._opt.showRegister && o._pick) visible.push(this._reg);
            if (o._opt.showDelete && o._selected) visible.push(this._del);
            const same = visible.length === this._c.children.length &&
                visible.every((b, i) => this._c.children[i] === b);
            if (!same) this._c.replaceChildren(...visible);
            this._c.style.display = visible.length ? '' : 'none';
        }
    }

    /* ---------- the layer ---------- */
    class WifiSpeedLayer {
        /**
         * @param {Object}  [options]
         * @param {string}  [options.id='wifi-speed']
         * @param {'top-left'|'top-right'|'bottom-left'|'bottom-right'} [options.controlPosition='top-right']
         * @param {'auto'|'en'|'ja'} [options.language='auto']
         * @param {boolean} [options.showRegister=true]         false: no Register button and no green pin on empty-map clicks
         * @param {boolean} [options.showDelete=true]
         * @param {number}  [options.clusterRadius=60]
         * @param {number[]} [options.speedRange=[0, 50]]        Mbps range for the color ramp
         * @param {string[]} [options.colors=['#0000FF','#FF0000']] [slow, fast]
         * @param {number}  [options.refreshInterval=0]          ms, 0 = off, min 30000
         * @param {boolean} [options.refreshOnFocus=true]        reload when the tab becomes visible again
         * @param {string}  [options.beforeId]                   insert the internal layers below this layer
         * @param {Object}  [options.maplibregl]                 needed only when maplibregl is not a global
         * @param {string}  [options.meshBaseUrl]                https only
         * @param {string}  [options.clusterUrl]                 https only
         */
        constructor(options) {
            const o = options || {};
            const range = Array.isArray(o.speedRange) ? o.speedRange : [0, 50];
            const min = clampNum(range[0], -1e6, 1e6, 0);
            let max = clampNum(range[1], -1e6, 1e6, 50);
            if (max <= min) max = min + 1;
            const colors = Array.isArray(o.colors) && o.colors.length >= 2 ? o.colors : ['#0000FF', '#FF0000'];

            this._opt = {
                controlPosition: pick(o.controlPosition, POSITIONS, 'top-right'),
                showRegister: o.showRegister !== false,
                showDelete: o.showDelete !== false,
                clusterRadius: clampNum(o.clusterRadius, 10, 200, 60),
                min, max,
                lowColor: String(colors[0]),
                highColor: String(colors[1]),
                refreshInterval: o.refreshInterval ? Math.max(30000, Number(o.refreshInterval) || 0) : 0,
                refreshOnFocus: o.refreshOnFocus !== false,
                beforeId: o.beforeId ? String(o.beforeId) : undefined,
                meshBase: safeUrl(o.meshBaseUrl || DEFAULT_MESH_BASE, 'meshBaseUrl'),
                clusterUrl: safeUrl(o.clusterUrl || DEFAULT_CLUSTER_URL, 'clusterUrl')
            };
            if (!this._opt.meshBase.endsWith('/')) this._opt.meshBase += '/';

            const base = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(o.id || '') ? o.id : 'wifi-speed';
            this.id = base;
            this.type = 'custom';
            this.renderingMode = '2d';

            this._ml = o.maplibregl || (typeof maplibregl !== 'undefined' ? maplibregl : null);
            this._langSetting = pick(o.language, ['auto', 'en', 'ja'], 'auto');
            this._lang = resolveLang(this._langSetting);
            this._ids = {
                points: `${base}-points`, pointsSrc: `${base}-points-src`,
                pick: `${base}-pick`, pickSrc: `${base}-pick-src`,
                cluster: `${base}-cluster`, clusterCount: `${base}-cluster-count`, clusterSrc: `${base}-cluster-src`
            };

            this._map = null;
            this._alive = false;
            this._meshes = new Map();
            this._clusterCtl = null;
            this._active = 0;
            this._queue = [];
            this._pick = null;
            this._selected = null;
            this._popup = null;
            this._ctrl = new Control(this);
            this._flushQueued = false;
            this._lastRefresh = 0;
            this._timer = null;
            this._handlers = {};
        }

        /* ----- CustomLayerInterface ----- */
        onAdd(map) {
            if (!this._ml || !this._ml.Popup) throw new Error('WifiSpeedLayer: maplibregl was not found. Pass { maplibregl } in the options.');
            this._map = map;
            this._alive = true;
            // Wait one tick: the custom layer must be fully registered before internal layers are added
            Promise.resolve().then(() => { if (this._alive) this._setup(); });
        }

        onRemove() {
            this._alive = false;
            const map = this._map;
            if (!map) return;
            clearInterval(this._timer);
            document.removeEventListener('visibilitychange', this._handlers.visibility);
            if (this._handlers.click) {
                map.off('click', this._handlers.click);
                map.off('moveend', this._handlers.moveend);
                map.off('mouseenter', this._ids.points, this._handlers.enter);
                map.off('mouseleave', this._ids.points, this._handlers.leave);
            }
            this._meshes.forEach(m => m.ctrl.abort());
            this._meshes.clear();
            if (this._clusterCtl) this._clusterCtl.abort();
            this._queue.length = 0;
            this._closePopup();
            try { map.removeControl(this._ctrl); } catch (e) { /* already removed */ }
            const i = this._ids;
            [i.clusterCount, i.cluster, i.pick, i.points].forEach(l => { if (map.getLayer(l)) map.removeLayer(l); });
            [i.clusterSrc, i.pickSrc, i.pointsSrc].forEach(s => { if (map.getSource(s)) map.removeSource(s); });
            this._map = null;
        }

        render() { /* drawing is delegated to standard MapLibre layers */ }

        /* ----- public API ----- */
        setLanguage(lang) {
            this._langSetting = pick(lang, ['auto', 'en', 'ja'], 'auto');
            this._lang = resolveLang(this._langSetting);
            this._ctrl.update();
        }

        refresh() {
            if (!this._alive || !this._map) return;
            this._lastRefresh = Date.now();
            this._syncMeshes(true);
            this._loadClusters(true);
        }

        clearSelection() {
            this._pick = null;
            this._selected = null;
            this._closePopup();
            this._setPick(null);
            this._ctrl.update();
        }

        /* ----- setup ----- */
        _setup() {
            const map = this._map;
            const i = this._ids;
            const o = this._opt;
            const empty = { type: 'FeatureCollection', features: [] };
            const before = o.beforeId && map.getLayer(o.beforeId) ? o.beforeId : undefined;

            map.addSource(i.pointsSrc, { type: 'geojson', data: empty });
            map.addSource(i.pickSrc, { type: 'geojson', data: empty });
            map.addSource(i.clusterSrc, {
                type: 'geojson', data: empty, cluster: true, clusterRadius: o.clusterRadius,
                clusterProperties: { count_sum: ['+', ['get', 'count']] }
            });

            map.addLayer({
                id: i.cluster, type: 'circle', source: i.clusterSrc, minzoom: 0, maxzoom: SWITCH_ZOOM,
                paint: { 'circle-color': '#0000FF', 'circle-radius': 25, 'circle-opacity': 0.8 }
            }, before);

            // Cluster counts use the glyphs endpoint of the style.json. If the style has none, skip the labels.
            const glyphs = map.getStyle() && map.getStyle().glyphs;
            if (glyphs) {
                const layout = {
                    'text-field': ['to-string', ['case', ['has', 'point_count'], ['get', 'count_sum'], ['get', 'count']]],
                    'text-size': 14,
                    'text-allow-overlap': true
                };
                const font = styleTextFont(map);
                if (font) layout['text-font'] = font; // otherwise MapLibre's default stack
                map.addLayer({
                    id: i.clusterCount, type: 'symbol', source: i.clusterSrc, minzoom: 0, maxzoom: SWITCH_ZOOM,
                    layout,
                    paint: { 'text-color': '#ffffff' }
                }, before);
            }

            map.addLayer({
                id: i.points, type: 'circle', source: i.pointsSrc, minzoom: SWITCH_ZOOM, maxzoom: 24,
                paint: {
                    'circle-color': ['interpolate', ['linear'], ['get', 'wifi_speed'], o.min, o.lowColor, o.max, o.highColor],
                    'circle-radius': 10,
                    'circle-stroke-color': '#000',
                    'circle-stroke-width': 2
                }
            }, before);

            map.addLayer({
                id: i.pick, type: 'circle', source: i.pickSrc, minzoom: SWITCH_ZOOM, maxzoom: 24,
                paint: { 'circle-radius': 10, 'circle-color': '#00FF00', 'circle-stroke-color': '#000', 'circle-stroke-width': 2 }
            }, before);

            map.addControl(this._ctrl, o.controlPosition);

            this._handlers = {
                click: e => this._onClick(e),
                moveend: () => this._onMove(),
                enter: () => { map.getCanvas().style.cursor = 'pointer'; },
                leave: () => { map.getCanvas().style.cursor = ''; },
                visibility: () => {
                    if (o.refreshOnFocus && document.visibilityState === 'visible' && Date.now() - this._lastRefresh > 5000) this.refresh();
                }
            };
            map.on('click', this._handlers.click);
            map.on('moveend', this._handlers.moveend);
            map.on('mouseenter', i.points, this._handlers.enter);
            map.on('mouseleave', i.points, this._handlers.leave);
            document.addEventListener('visibilitychange', this._handlers.visibility);
            if (o.refreshInterval) this._timer = setInterval(() => this.refresh(), o.refreshInterval);

            this._lastRefresh = Date.now();
            this._loadClusters(false);
            this._syncMeshes(false);
        }

        /* ----- network (limited concurrency, size cap, abortable) ----- */
        _pump() {
            while (this._active < CONCURRENCY && this._queue.length) this._queue.shift()();
        }

        _acquire(signal) {
            return new Promise((resolve, reject) => {
                this._queue.push(() => {
                    if (signal.aborted) { reject(abortError()); return; }
                    this._active++;
                    resolve();
                });
                this._pump();
            });
        }

        async _fetchJson(url, signal, force) {
            await this._acquire(signal);
            try {
                const res = await fetch(url, {
                    signal, credentials: 'omit', referrerPolicy: 'no-referrer',
                    cache: force ? 'no-cache' : 'default'
                });
                if (res.status === 404) return null;
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const len = Number(res.headers.get('content-length'));
                if (len > MAX_BYTES) throw new Error('Response too large');
                const text = await res.text();
                if (text.length > MAX_BYTES) throw new Error('Response too large');
                return JSON.parse(text);
            } finally {
                this._active--;
                this._pump();
            }
        }

        _loadClusters(force) {
            if (this._clusterCtl) this._clusterCtl.abort();
            const ctl = this._clusterCtl = new AbortController();
            this._fetchJson(this._opt.clusterUrl, ctl.signal, force).then(json => {
                if (!this._alive || this._clusterCtl !== ctl) return;
                const src = this._map.getSource(this._ids.clusterSrc);
                if (src) src.setData({ type: 'FeatureCollection', features: sanitizeClusters(json) });
            }).catch(err => { if (err.name !== 'AbortError') console.warn('[WifiSpeedLayer] cluster load failed', err); });
        }

        _meshKeys(bounds) {
            const keys = [];
            const minLat = Math.max(-90, Math.floor(bounds.getSouth()));
            const maxLat = Math.min(89, Math.floor(bounds.getNorth()));
            const minLon = Math.floor(bounds.getWest());
            const maxLon = Math.floor(bounds.getEast());
            const lonCount = Math.min(360, maxLon - minLon + 1);
            for (let lat = minLat; lat <= maxLat; lat++) {
                for (let n = 0; n < lonCount; n++) {
                    if (keys.length >= MAX_MESHES) return keys;
                    keys.push(`${lat}_${wrapLon(minLon + n)}`);
                }
            }
            return keys;
        }

        _loadMesh(key, force, prev) {
            const ctl = new AbortController();
            const entry = { ctrl: ctl, features: prev ? prev.features : [] };
            this._meshes.set(key, entry);
            const url = `${this._opt.meshBase}wifi_${key}.json`;
            this._fetchJson(url, ctl.signal, force).then(json => {
                if (!this._alive || this._meshes.get(key) !== entry) return;
                entry.features = sanitizePoints(json);
                this._scheduleFlush();
            }).catch(err => {
                if (err.name === 'AbortError') return;
                if (this._meshes.get(key) === entry) this._meshes.delete(key); // retried on the next move
                console.warn('[WifiSpeedLayer] mesh load failed', key, err);
            });
        }

        _syncMeshes(force) {
            const map = this._map;
            if (!map) return;
            if (map.getZoom() < SWITCH_ZOOM) {
                if (this._meshes.size) {
                    this._meshes.forEach(m => m.ctrl.abort());
                    this._meshes.clear();
                    this._scheduleFlush();
                }
                return;
            }
            const wanted = new Set(this._meshKeys(map.getBounds()));
            let changed = false;
            for (const [key, m] of this._meshes) {
                if (!wanted.has(key)) { m.ctrl.abort(); this._meshes.delete(key); changed = true; }
            }
            wanted.forEach(key => {
                const cur = this._meshes.get(key);
                if (!cur) this._loadMesh(key, force, null);
                else if (force) { cur.ctrl.abort(); this._loadMesh(key, true, cur); }
            });
            if (changed) this._scheduleFlush();
        }

        _scheduleFlush() {
            if (this._flushQueued) return;
            this._flushQueued = true;
            requestAnimationFrame(() => {
                this._flushQueued = false;
                if (!this._alive || !this._map) return;
                const src = this._map.getSource(this._ids.pointsSrc);
                if (!src) return;
                const features = [];
                this._meshes.forEach(m => { for (const f of m.features) features.push(f); });
                src.setData({ type: 'FeatureCollection', features });
            });
        }

        /* ----- interaction ----- */
        _onMove() {
            if (this._map.getZoom() < SWITCH_ZOOM && (this._pick || this._selected)) this.clearSelection();
            this._syncMeshes(false);
        }

        _onClick(e) {
            const map = this._map;
            if (map.getZoom() < SWITCH_ZOOM) return;
            const hits = map.getLayer(this._ids.points)
                ? map.queryRenderedFeatures(e.point, { layers: [this._ids.points] }) : [];
            if (hits.length) this._select(hits[0]);
            else this._placePick(e.lngLat);
        }

        _setPick(lngLat) {
            const src = this._map && this._map.getSource(this._ids.pickSrc);
            if (!src) return;
            src.setData({
                type: 'FeatureCollection',
                features: lngLat ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: [lngLat.lng, lngLat.lat] }, properties: {} }] : []
            });
        }

        _placePick(lngLat) {
            // Register button disabled: no pin. Clicking empty map still clears the current selection / popup.
            if (!this._opt.showRegister) { this.clearSelection(); return; }
            const lat = lngLat.lat, lng = wrapLon(lngLat.lng);
            if (!isNum(lat) || !isNum(lng)) return;
            this._closePopup();
            this._selected = null;
            this._pick = { lat, lng };
            this._setPick({ lat, lng });
            this._ctrl.update();
        }

        _select(feature) {
            const c = feature.geometry && feature.geometry.coordinates;
            const p = feature.properties || {};
            if (!c || !isNum(c[0]) || !isNum(c[1])) return;
            const id = String(p.id);
            if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return;
            const lat = c[1], lng = wrapLon(c[0]);
            const speed = Number(p.wifi_speed);

            this._closePopup();
            this._pick = null;
            this._setPick(null);
            this._selected = { id, lat, lng };

            const t = STRINGS[this._lang];
            const box = document.createElement('div');
            box.style.fontSize = '14px';
            const name = document.createElement('div');
            name.style.fontWeight = 'bold';
            name.textContent = String(p.description || '');            // textContent: never HTML
            const sp = document.createElement('div');
            sp.textContent = `${t.speed}: ${Number.isFinite(speed) ? speed.toFixed(4) : '-'} Mbps`;
            const a = document.createElement('a');
            a.href = `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(7)},${lng.toFixed(7)}`;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = t.gmap;
            box.append(name, sp, a);

            const popup = new this._ml.Popup({ closeOnClick: false, maxWidth: '280px' })
                .setLngLat([lng, lat]).setDOMContent(box).addTo(this._map);
            popup.on('close', () => {
                if (this._popup === popup) { this._popup = null; this._selected = null; this._ctrl.update(); }
            });
            this._popup = popup;
            this._ctrl.update();
        }

        _closePopup() {
            const p = this._popup;
            this._popup = null;
            if (p) p.remove();
        }

        /* ----- hand-off to wifi.pancake-trail.site (fixed origin, validated numeric/enum params only) ----- */
        _openSite(action, params) {
            const u = new URL(SITE_URL);
            u.searchParams.set(PARAM_PREFIX + 'action', action);
            Object.keys(params).forEach(k => u.searchParams.set(PARAM_PREFIX + k, params[k]));
            u.searchParams.set(PARAM_PREFIX + 'lang', this._lang);
            if (u.origin !== SITE_ORIGIN) return;
            window.open(u.href, '_blank', 'noopener,noreferrer');
        }

        _zoomParam() {
            return String(Math.round(clampNum(this._map.getZoom(), 0, 24, 17) * 100) / 100);
        }

        _openRegister() {
            const p = this._pick;
            if (!p || !isNum(p.lat) || !isNum(p.lng)) return;
            this._openSite('register', { lat: p.lat.toFixed(7), lng: p.lng.toFixed(7), zoom: this._zoomParam() });
        }

        _openDelete() {
            const s = this._selected;
            if (!s || !/^[A-Za-z0-9_-]{1,64}$/.test(s.id)) return;
            this._openSite('delete', { id: s.id, lat: s.lat.toFixed(7), lng: s.lng.toFixed(7), zoom: this._zoomParam() });
        }
    }

    WifiSpeedLayer.version = '1.0.2';
    WifiSpeedLayer.WifiSpeedLayer = WifiSpeedLayer;
    WifiSpeedLayer.default = WifiSpeedLayer;
    return WifiSpeedLayer;
}));
