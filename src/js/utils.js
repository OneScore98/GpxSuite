// utils.js — funzioni di utilità pure senza dipendenze da altri moduli

const _resourcePromises = new Map();
const LUCIDE_URL = 'https://unpkg.com/lucide@1.16.0/dist/umd/lucide.min.js';

export function escapeXml(unsafe) {
    return unsafe.replace(/[<>&'"]/g, function(c) {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
        }
    });
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
