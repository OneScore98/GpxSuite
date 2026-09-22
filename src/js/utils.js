// utils.js — funzioni di utilità pure senza dipendenze da altri moduli

const _resourcePromises = new Map();
const LUCIDE_URL = 'https://unpkg.com/lucide@1.16.0/dist/umd/lucide.min.js';

// Profilo prudente per l'export GPX: una tolleranza di 100 m assorbe il
// normale rumore del fix, mentre 300 km/h evita di scartare percorsi registrati
// su mezzi veloci. Dopo 60 s un punto puo' rappresentare una riacquisizione GPS.
const GPX_EXPORT_BASE_TOLERANCE_M = 100;
const GPX_EXPORT_MAX_SPEED_MPS = 300 / 3.6;
const GPX_EXPORT_REACQUIRE_AFTER_MS = 60000;
const GPX_EXPORT_GEOMETRIC_SPIKE_M = 5000;
const GPX_EXPORT_GEOMETRIC_BRIDGE_M = 1000;

export function escapeXml(unsafe) {
    return String(unsafe ?? '').replace(/[<>&'"]/g, function(c) {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
        }
    });
}

export function isGpxCoordinateValid(point) {
    const lat = Number(point?.lat);
    const lon = Number(point?.lon);
    return Number.isFinite(lat) && Number.isFinite(lon) &&
        lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function gpxPointTimeMs(point) {
    if (typeof point?.time === 'number') return Number.isFinite(point.time) ? point.time : NaN;
    if (point?.time instanceof Date) return point.time.getTime();
    const parsed = typeof point?.time === 'string' ? Date.parse(point.time) : NaN;
    return Number.isFinite(parsed) ? parsed : NaN;
}

function gpxPointDistanceMeters(first, second) {
    const toRad = Math.PI / 180;
    const firstLat = Number(first.lat) * toRad;
    const secondLat = Number(second.lat) * toRad;
    const dLat = secondLat - firstLat;
    const dLon = (Number(second.lon) - Number(first.lon)) * toRad;
    const sinLat = Math.sin(dLat / 2);
    const sinLon = Math.sin(dLon / 2);
    const value = sinLat * sinLat + Math.cos(firstLat) * Math.cos(secondLat) * sinLon * sinLon;
    return 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, value)));
}

// true/false quando i timestamp permettono il controllo; null se manca il tempo.
function gpxTimedTransitionPlausible(first, second) {
    const firstTime = gpxPointTimeMs(first);
    const secondTime = gpxPointTimeMs(second);
    if (!Number.isFinite(firstTime) || !Number.isFinite(secondTime)) return null;
    const elapsedMs = secondTime - firstTime;
    if (elapsedMs < 0) return false;
    if (elapsedMs >= GPX_EXPORT_REACQUIRE_AFTER_MS) return true;
    const allowedMeters = GPX_EXPORT_BASE_TOLERANCE_M +
        GPX_EXPORT_MAX_SPEED_MPS * elapsedMs / 1000;
    return gpxPointDistanceMeters(first, second) <= allowedMeters;
}

function gpxGeometricSpike(prev, curr, next) {
    const before = gpxPointDistanceMeters(prev, curr);
    const after = gpxPointDistanceMeters(curr, next);
    const bridge = gpxPointDistanceMeters(prev, next);
    return before > GPX_EXPORT_GEOMETRIC_SPIKE_M &&
        after > GPX_EXPORT_GEOMETRIC_SPIKE_M &&
        bridge <= Math.max(GPX_EXPORT_GEOMETRIC_BRIDGE_M, Math.min(before, after) * 0.1);
}

function gpxIsolatedSpike(prev, curr, next) {
    const before = gpxTimedTransitionPlausible(prev, curr);
    const after = gpxTimedTransitionPlausible(curr, next);
    const bridge = gpxTimedTransitionPlausible(prev, next);
    if (before !== null && after !== null && bridge !== null) {
        return before === false && after === false && bridge === true;
    }
    return gpxGeometricSpike(prev, curr, next);
}

/**
 * Restituisce i punti esportabili senza modificare la traccia in memoria.
 * Scarta coordinate non finite/fuori WGS84, picchi GPS isolati e transizioni
 * temporalmente impossibili. Senza timestamp applica solo il controllo
 * geometrico molto conservativo, così non danneggia percorsi disegnati a mano.
 */
export function filterGpxExportPoints(points = []) {
    const valid = Array.isArray(points) ? points.filter(isGpxCoordinateValid) : [];
    if (valid.length < 2) return valid;

    let start = 0;
    let end = valid.length;
    if (valid.length >= 3) {
        const firstJump = gpxTimedTransitionPlausible(valid[0], valid[1]);
        const followingStep = gpxTimedTransitionPlausible(valid[1], valid[2]);
        if ((firstJump === false && followingStep === true) ||
            (firstJump === null && followingStep === null &&
                gpxPointDistanceMeters(valid[0], valid[1]) > GPX_EXPORT_GEOMETRIC_SPIKE_M &&
                gpxPointDistanceMeters(valid[1], valid[2]) <= GPX_EXPORT_GEOMETRIC_BRIDGE_M)) {
            start = 1;
        }

        const previousStep = gpxTimedTransitionPlausible(valid[valid.length - 3], valid[valid.length - 2]);
        const lastJump = gpxTimedTransitionPlausible(valid[valid.length - 2], valid[valid.length - 1]);
        if ((previousStep === true && lastJump === false) ||
            (previousStep === null && lastJump === null &&
                gpxPointDistanceMeters(valid[valid.length - 3], valid[valid.length - 2]) <= GPX_EXPORT_GEOMETRIC_BRIDGE_M &&
                gpxPointDistanceMeters(valid[valid.length - 2], valid[valid.length - 1]) > GPX_EXPORT_GEOMETRIC_SPIKE_M)) {
            end--;
        }
    }

    const withoutSpikes = [];
    for (let i = start; i < end; i++) {
        if (i > start && i + 1 < end && gpxIsolatedSpike(valid[i - 1], valid[i], valid[i + 1])) continue;
        withoutSpikes.push(valid[i]);
    }

    const filtered = [];
    for (const point of withoutSpikes) {
        const previous = filtered[filtered.length - 1];
        const plausible = previous ? gpxTimedTransitionPlausible(previous, point) : true;
        if (plausible !== false) filtered.push(point);
    }
    return filtered;
}

export function loadScriptOnce(url, options = {}) {
    const key = `script:${url}`;
    if (_resourcePromises.has(key)) return _resourcePromises.get(key);

    const existing = document.querySelector(`script[src="${url}"]`);
    if (existing?.dataset.loaded === 'true') return Promise.resolve(existing);

    const promise = new Promise((resolve, reject) => {
        const script = existing || document.createElement('script');
        script.src = url;
        script.async = options.async !== false;
        if (options.defer) script.defer = true;
        if (options.crossOrigin) script.crossOrigin = options.crossOrigin;
        if (options.id) script.id = options.id;
        script.onload = () => {
            script.dataset.loaded = 'true';
            resolve(script);
        };
        script.onerror = () => {
            _resourcePromises.delete(key);
            reject(new Error(`Impossibile caricare ${url}`));
        };
        if (!existing) document.head.appendChild(script);
    });

    _resourcePromises.set(key, promise);
    return promise;
}

export function loadStylesheetOnce(url, options = {}) {
    const key = `style:${url}`;
    if (_resourcePromises.has(key)) return _resourcePromises.get(key);

    const existing = document.querySelector(`link[href="${url}"]`);
    if (existing?.dataset.loaded === 'true') return Promise.resolve(existing);

    const promise = new Promise((resolve, reject) => {
        const link = existing || document.createElement('link');
        link.rel = 'stylesheet';
        link.href = url;
        if (options.crossOrigin) link.crossOrigin = options.crossOrigin;
        if (options.id) link.id = options.id;
        link.onload = () => {
            link.dataset.loaded = 'true';
            resolve(link);
        };
        link.onerror = () => {
            _resourcePromises.delete(key);
            reject(new Error(`Impossibile caricare ${url}`));
        };
        if (!existing) document.head.appendChild(link);
    });

    _resourcePromises.set(key, promise);
    return promise;
}

export function refreshLucideIcons() {
    if (window.lucide?.createIcons) {
        window.lucide.createIcons();
    }
}

export function ensureLucideIcons() {
    if (window.lucide?.createIcons) {
        refreshLucideIcons();
        return Promise.resolve(window.lucide);
    }

    return loadScriptOnce(LUCIDE_URL, { id: 'lucide-icons-cdn' })
        .then(() => {
            refreshLucideIcons();
            return window.lucide;
        })
        .catch(err => {
            console.error('Errore caricamento icone Lucide:', err);
            return null;
        });
}

export function vibrationLevelRatio(level, max = 20) {
    const numeric = Number(level);
    const upper = Math.max(1, Number(max) || 20);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.min(1, (numeric - 1) / (upper - 1 || 1)));
}

export function vibrationLevelColor(level, options = {}) {
    const ratio = vibrationLevelRatio(level, options.max || 20);
    const saturation = options.saturation ?? 92;
    const lightness = options.lightness ?? 56;
    if (ratio <= 0.18) {
        return options.lowColor || 'rgba(148, 163, 184, 0.22)';
    }
    if (ratio <= 0.58) {
        const warmRatio = (ratio - 0.18) / 0.4;
        const hue = Math.round(52 - warmRatio * 28);
        return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
    }
    const alarmRatio = (ratio - 0.58) / 0.42;
    const hue = Math.round(24 - alarmRatio * 24);
    const alarmLightness = Math.max(48, lightness - alarmRatio * 6);
    return `hsl(${hue}, ${saturation}%, ${alarmLightness}%)`;
}

export function perpendicularDistance(p, p1, p2) {
    const x = p.lon, y = p.lat;
    const x1 = p1.lon, y1 = p1.lat;
    const x2 = p2.lon, y2 = p2.lat;

    const A = x - x1;
    const B = y - y1;
    const C = x2 - x1;
    const D = y2 - y1;

    const dot = A * C + B * D;
    const lenSq = C * C + D * D;
    let param = -1;
    if (lenSq !== 0) param = dot / lenSq;

    let xx, yy;

    if (param < 0) {
        xx = x1;
        yy = y1;
    } else if (param > 1) {
        xx = x2;
        yy = y2;
    } else {
        xx = x1 + param * C;
        yy = y1 + param * D;
    }

    const dx = x - xx;
    const dy = y - yy;
    return Math.sqrt(dx * dx + dy * dy);
}

export function generateDistinctTrackColor(existingColors = []) {
    const used = new Set(existingColors.map(color => String(color || '').toLowerCase()));

    for (let attempt = 0; attempt < 24; attempt++) {
        const hue = Math.floor(Math.random() * 360);
        const saturation = 72 + Math.floor(Math.random() * 18);
        const lightness = 48 + Math.floor(Math.random() * 10);
        const color = hslToHex(hue, saturation, lightness);
        if (!used.has(color.toLowerCase())) return color;
    }

    return '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
}

function hslToHex(h, s, l) {
    const sat = s / 100;
    const light = l / 100;
    const c = (1 - Math.abs(2 * light - 1)) * sat;
    const hp = h / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r = 0;
    let g = 0;
    let b = 0;

    if (hp >= 0 && hp < 1) [r, g, b] = [c, x, 0];
    else if (hp < 2) [r, g, b] = [x, c, 0];
    else if (hp < 3) [r, g, b] = [0, c, x];
    else if (hp < 4) [r, g, b] = [0, x, c];
    else if (hp < 5) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];

    const m = light - c / 2;
    const toHex = (value) => Math.round((value + m) * 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
