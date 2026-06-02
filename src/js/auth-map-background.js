// auth-map-background.js — sfondo MapLibre 3D animato per la pagina di login
//
// Mostra una vista satellitare orbitale di una traccia GPX reale (Sinnai - Cava
// Cagima Vecchia), con tratti offroad/asfalto colorati distintamente e DEM
// Terrarium per il terreno 3D. La mappa si avvia quando il gate auth viene
// mostrato e si distrugge quando il gate si chiude, in modo da non sprecare
// risorse durante l'uso normale dell'app.
//
// Fallback graceful: se MapLibre non è disponibile, se WebGL fallisce o se la
// rete blocca i tile, il container resta nascosto e l'esistente preview SVG
// (.auth-map-preview) rimane visibile sotto.

const TRACK_URL = 'src/assets/login-track.geojson';
const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const SATELLITE_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const SATELLITE_ATTRIBUTION = 'Tiles &copy; Esri';

let _state = null;
// Incrementato a ogni stop: se uno start in volo si trova con un epoch obsoleto,
// si annulla da solo (evita race condition con auto-login veloce).
let _epoch = 0;

function waitForMaplibre(timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
        if (window.maplibregl) return resolve(window.maplibregl);
        const deadline = Date.now() + timeoutMs;
        const tick = () => {
            if (window.maplibregl) return resolve(window.maplibregl);
            if (Date.now() > deadline) return reject(new Error('MapLibre non disponibile'));
            setTimeout(tick, 60);
        };
        tick();
    });
}

function prefersReducedMotion() {
    try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (_) {
        return false;
    }
}

function buildStyle() {
    return {
        version: 8,
        glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
        sources: {
            'sat': {
                type: 'raster',
                tiles: [SATELLITE_TILES],
                tileSize: 256,
                maxzoom: 19,
                attribution: SATELLITE_ATTRIBUTION
            },
            'terrain-dem': {
                type: 'raster-dem',
                tiles: [TERRAIN_TILES],
                tileSize: 256,
                encoding: 'terrarium',
                maxzoom: 14,
                attribution: '&copy; Mapzen / AWS Open Data'
            }
        },
        layers: [
            { id: 'bg', type: 'background', paint: { 'background-color': '#08111a' } },
            { id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-opacity': 0.92, 'raster-fade-duration': 250 } }
        ],
        terrain: { source: 'terrain-dem', exaggeration: 1.6 }
    };
}

async function loadTrackGeoJson() {
    const res = await fetch(TRACK_URL, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`Traccia non caricabile (${res.status})`);
    return await res.json();
}

function addTrackLayers(map, geojson) {
    if (map.getSource('login-track')) return;
    map.addSource('login-track', { type: 'geojson', data: geojson });

    // Casing scuro sotto entrambe le superfici per maggiore leggibilità
    map.addLayer({
        id: 'login-track-casing',
        type: 'line',
        source: 'login-track',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
            'line-color': '#020617',
            'line-width': 7,
            'line-opacity': 0.85
        }
    });

    // Tratto asfaltato: linea piena ciano luminoso
    map.addLayer({
        id: 'login-track-asfalto',
        type: 'line',
        source: 'login-track',
        filter: ['==', ['get', 'surface'], 'asfalto'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
            'line-color': '#38bdf8',
            'line-width': 3.2,
            'line-opacity': 0.95
        }
    });

    // Tratto offroad: linea tratteggiata ambra
    map.addLayer({
        id: 'login-track-offroad',
        type: 'line',
        source: 'login-track',
        filter: ['==', ['get', 'surface'], 'offroad'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
            'line-color': '#f59e0b',
            'line-width': 3.2,
            'line-opacity': 0.95,
            'line-dasharray': [1.6, 1.4]
        }
    });

    // Glow morbido per dare profondità
    map.addLayer({
        id: 'login-track-glow',
        type: 'line',
        source: 'login-track',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
            'line-color': '#7dd3fc',
            'line-width': 14,
            'line-opacity': 0.10,
            'line-blur': 6
        }
    }, 'login-track-casing');
}

function computeCenter(geojson) {
    const bbox = geojson.bbox;
    if (bbox && bbox.length >= 4) {
        return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
    }
    return [9.3748, 39.4019];
}

function startOrbit(state) {
    const { map } = state;
    const center = state.center;
    const start = performance.now();
    const periodMs = 60000; // un giro ogni 60s
    const reducedMotion = prefersReducedMotion();

    state.startBearing = (Math.random() * 360);
    state.basePitch = 64;
    state.baseZoom = 9.05;

    const animate = (now) => {
        if (!state.running) return;
        const elapsed = (now - start) / periodMs;
        const bearing = (state.startBearing + (reducedMotion ? 0 : elapsed * 360)) % 360;
        // leggera oscillazione di pitch e zoom per dare "respiro" alla scena
        const t = (now - start) / 1000;
        const pitchOsc = reducedMotion ? 0 : Math.sin(t * 0.18) * 3.2;
        const zoomOsc = reducedMotion ? 0 : Math.sin(t * 0.12) * 0.18;
        try {
            map.jumpTo({
                center,
                bearing,
                pitch: state.basePitch + pitchOsc,
                zoom: state.baseZoom + zoomOsc
            });
        } catch (_) { /* il map può essere stato distrutto */ }
        state.rafId = requestAnimationFrame(animate);
    };

    state.rafId = requestAnimationFrame(animate);
}

function stopOrbit(state) {
    state.running = false;
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = null;
}

export async function startAuthMapBackground() {
    if (_state && _state.map) return _state;

    const container = document.getElementById('auth-map-bg');
    if (!container) return null;

    const myEpoch = _epoch;

    let maplibregl;
    try {
        maplibregl = await waitForMaplibre();
    } catch (err) {
        console.warn('[auth-bg] MapLibre non caricato:', err.message);
        return null;
    }
    if (myEpoch !== _epoch) return null; // stop chiamato nel frattempo

    let geojson;
    try {
        geojson = await loadTrackGeoJson();
    } catch (err) {
        console.warn('[auth-bg] Traccia non disponibile:', err.message);
        return null;
    }
    if (myEpoch !== _epoch) return null; // stop chiamato nel frattempo

    const center = computeCenter(geojson);
    container.style.display = 'block';

    let map;
    try {
        map = new maplibregl.Map({
            container,
            style: buildStyle(),
            center,
            zoom: 9.05,
            pitch: 64,
            bearing: 30,
            interactive: false,
            attributionControl: false,
            preserveDrawingBuffer: false,
            antialias: true,
            fadeDuration: 200
        });
    } catch (err) {
        console.warn('[auth-bg] Creazione MapLibre fallita:', err.message);
        container.style.display = 'none';
        return null;
    }

    _state = { map, container, center, running: true, rafId: null };

    map.once('load', () => {
        try {
            // attribuzione minimale, fuori dal flusso visivo (Esri/Mapzen)
            map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
            addTrackLayers(map, geojson);
            // dissolvenza in: il container parte trasparente e fade-in via CSS
            container.classList.add('is-ready');
            startOrbit(_state);
        } catch (err) {
            console.warn('[auth-bg] Errore inizializzazione layer:', err);
        }
    });

    map.on('error', (e) => {
        // tile o sorgente esterna non disponibile: non mostriamo nulla all'utente
        if (e && e.error) console.debug('[auth-bg] map error:', e.error.message || e.error);
    });

    return _state;
}

export function stopAuthMapBackground() {
    _epoch++; // invalida start in volo
    if (!_state) return;
    stopOrbit(_state);
    try { _state.map.remove(); } catch (_) {}
    if (_state.container) {
        _state.container.classList.remove('is-ready');
        _state.container.style.display = 'none';
    }
    _state = null;
}
