// auth-map-background.js — sfondo MapLibre 3D animato per la pagina di login
//
// Mostra una vista 3D orbitale ravvicinata sulla zona rocciosa di transizione
// offroad ↔ asfalto (waypoint "5° fine sterrato", Monte Serpeddì - Sardegna)
// della traccia GPX reale Sinnai - Cava Cagima Vecchia. Durante l'orbita
// (un giro ogni 90s) i basemap si alternano in crossfade continuo:
//   satellite Esri (+ overlay strade/etichette) → topografico OpenTopoMap → OSM.
//
// La mappa si avvia quando il gate auth viene mostrato e si distrugge quando il
// gate si chiude, in modo da non sprecare risorse durante l'uso normale.
//
// Fallback graceful: se MapLibre non è disponibile, se WebGL fallisce o se la
// rete blocca i tile, il container resta nascosto e l'esistente preview SVG
// (.auth-map-preview) rimane visibile sotto.

const TRACK_URL = 'src/assets/login-track.geojson';
const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const SATELLITE_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const SATELLITE_REF_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}';
const SATELLITE_ATTRIBUTION = 'Tiles &copy; Esri';
const TOPO_TILES = 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png';
const TOPO_ATTRIBUTION = '&copy; OpenTopoMap (CC-BY-SA)';
const OSM_TILES = 'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION = '&copy; OpenStreetMap contributors';

// Centro orbitale: waypoint "5° fine sterrato" — passaggio offroad→asfalto
// in zona Monte Serpeddì (Sardegna), terreno roccioso/montano.
const ROCKY_TRANSITION_CENTER = [9.307478, 39.421660];

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
            'sat-ref': {
                type: 'raster',
                tiles: [SATELLITE_REF_TILES],
                tileSize: 256,
                maxzoom: 19,
                attribution: SATELLITE_ATTRIBUTION
            },
            'topo': {
                type: 'raster',
                tiles: [TOPO_TILES],
                tileSize: 256,
                maxzoom: 17,
                attribution: TOPO_ATTRIBUTION
            },
            'osm': {
                type: 'raster',
                tiles: [OSM_TILES],
                tileSize: 256,
                maxzoom: 19,
                attribution: OSM_ATTRIBUTION
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
            // Stack basemap (ordine alto = sopra): osm in fondo, poi topo, poi sat,
            // infine overlay strade Esri. Le opacità sono pilotate dal ciclo orbitale.
            { id: 'lyr-osm', type: 'raster', source: 'osm', paint: { 'raster-opacity': 0, 'raster-fade-duration': 250 } },
            { id: 'lyr-topo', type: 'raster', source: 'topo', paint: { 'raster-opacity': 0, 'raster-fade-duration': 250 } },
            { id: 'lyr-sat', type: 'raster', source: 'sat', paint: { 'raster-opacity': 1, 'raster-fade-duration': 250 } },
            { id: 'lyr-sat-ref', type: 'raster', source: 'sat-ref', paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 250 } }
        ],
        terrain: { source: 'terrain-dem', exaggeration: 1.4 }
    };
}

async function loadTrackGeoJson() {
    try {
        const res = await fetch(TRACK_URL, { cache: 'force-cache' });
        if (!res.ok) throw new Error(`Traccia non caricabile (${res.status})`);
        return await res.json();
    } catch (err) {
        console.warn('[auth-bg] Fetch traccia fallito, uso fallback inline:', err.message);
        // Fallback inline track (Monte Serpeddì - Transizione asfalto/sterrato)
        return {
            "type": "FeatureCollection",
            "features": [{
                    "type": "Feature",
                    "properties": { "surface": "asfalto" },
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [
                            [9.303, 39.418],
                            [9.304, 39.419],
                            [9.305, 39.420],
                            [9.307478, 39.421660]
                        ]
                    }
                },
                {
                    "type": "Feature",
                    "properties": { "surface": "offroad" },
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [
                            [9.307478, 39.421660],
                            [9.308, 39.422],
                            [9.309, 39.423],
                            [9.310, 39.424],
                            [9.312, 39.425]
                        ]
                    }
                }
            ]
        };
    }
}

function addTrackLayers(map, geojson) {
    if (map.getSource('login-track')) return;
    map.addSource('login-track', { type: 'geojson', data: geojson });

    // Glow morbido sotto, dà profondità (sotto al casing)
    map.addLayer({
        id: 'login-track-glow',
        type: 'line',
        source: 'login-track',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
            'line-color': '#7dd3fc',
            'line-width': 18,
            'line-opacity': 0.12,
            'line-blur': 8
        }
    });

    // Casing scuro sotto entrambe le superfici per maggiore leggibilità
    map.addLayer({
        id: 'login-track-casing',
        type: 'line',
        source: 'login-track',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
            'line-color': '#020617',
            'line-width': 8,
            'line-opacity': 0.88
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
            'line-width': 3.6,
            'line-opacity': 0.96
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
            'line-width': 3.6,
            'line-opacity': 0.96,
            'line-dasharray': [1.6, 1.4]
        }
    });
}

// Triangolare circolare: per ogni "centro" nello spazio [0,1), restituisce
// 1 quando phase==center, 0 quando phase si trova a distanza >= window/2.
// windowWidth = 1/N produce un crossfade continuo fra N layer equispaziati.
function triangularPulse(phase, center, windowHalfWidth) {
    let d = Math.abs(phase - center);
    if (d > 0.5) d = 1 - d; // wrap circolare
    if (d >= windowHalfWidth) return 0;
    return 1 - d / windowHalfWidth;
}

function setLayerOpacity(map, layerId, opacity) {
    const op = Math.max(0, Math.min(1, opacity));
    try {
        if (op < 0.02) {
            if (map.getLayoutProperty(layerId, 'visibility') !== 'none') {
                map.setLayoutProperty(layerId, 'visibility', 'none');
            }
        } else {
            if (map.getLayoutProperty(layerId, 'visibility') === 'none') {
                map.setLayoutProperty(layerId, 'visibility', 'visible');
            }
            map.setPaintProperty(layerId, 'raster-opacity', op);
        }
    } catch (_) { /* layer non ancora pronto */ }
}

function startOrbit(state) {
    const { map } = state;
    const center = state.center;
    const start = performance.now();
    const orbitPeriodMs = 90000; // un giro completo ogni 90s
    const basemapCyclePeriodMs = 90000; // anche il ciclo basemap dura 90s (3 slot da 30s)
    const reducedMotion = prefersReducedMotion();

    state.startBearing = (Math.random() * 360);
    state.basePitch = 66;
    state.baseZoom = 13.2;

    // Throttling: aggiornamento camera ogni frame, opacità basemap al massimo 8 volte/sec
    let lastOpacityUpdate = 0;

    const animate = (now) => {
        if (!state.running) return;
        const elapsed = (now - start);
        const orbitPhase = (elapsed / orbitPeriodMs);
        const bearing = (state.startBearing + (reducedMotion ? 0 : orbitPhase * 360)) % 360;
        const t = elapsed / 1000;
        // Leggera oscillazione pitch/zoom per "respiro" cinematografico
        const pitchOsc = reducedMotion ? 0 : Math.sin(t * 0.18) * 2.8;
        const zoomOsc = reducedMotion ? 0 : Math.sin(t * 0.12) * 0.20;
        try {
            map.jumpTo({
                center,
                bearing,
                pitch: state.basePitch + pitchOsc,
                zoom: state.baseZoom + zoomOsc
            });
        } catch (_) {}

        // Crossfade basemap: phase ciclico [0,1) → 3 slot
        if (now - lastOpacityUpdate > 120) {
            lastOpacityUpdate = now;
            const bmPhase = (elapsed % basemapCyclePeriodMs) / basemapCyclePeriodMs;
            // window half = 1/3 → triangolare con somma sempre ~1 (overlap perfetto)
            const w = 1 / 3;
            const satOp = triangularPulse(bmPhase, 0, w);
            const topoOp = triangularPulse(bmPhase, 1 / 3, w);
            const osmOp = triangularPulse(bmPhase, 2 / 3, w);
            setLayerOpacity(map, 'lyr-sat', satOp);
            // overlay strade visibile solo quando il satellite è dominante
            setLayerOpacity(map, 'lyr-sat-ref', satOp * 0.85);
            setLayerOpacity(map, 'lyr-topo', topoOp);
            setLayerOpacity(map, 'lyr-osm', osmOp);
        }

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
    if (myEpoch !== _epoch) return null;

    let geojson;
    try {
        geojson = await loadTrackGeoJson();
    } catch (err) {
        console.warn('[auth-bg] Traccia non disponibile:', err.message);
        return null;
    }
    if (myEpoch !== _epoch) return null;

    const center = ROCKY_TRANSITION_CENTER.slice();
    container.style.display = 'block';

    let map;
    try {
        map = new maplibregl.Map({
            container,
            style: buildStyle(),
            center,
            zoom: 13.2,
            pitch: 66,
            maxPitch: 85,
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
            map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
            addTrackLayers(map, geojson);
            container.classList.add('is-ready');
            startOrbit(_state);
        } catch (err) {
            console.warn('[auth-bg] Errore inizializzazione layer:', err);
        }
    });

    map.on('error', (e) => {
        if (e && e.error) console.debug('[auth-bg] map error:', e.error.message || e.error);
    });

    return _state;
}

export function stopAuthMapBackground() {
    _epoch++;
    if (!_state) return;
    stopOrbit(_state);
    try { _state.map.remove(); } catch (_) {}
    if (_state.container) {
        _state.container.classList.remove('is-ready');
        _state.container.style.display = 'none';
    }
    _state = null;
}