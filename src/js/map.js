// map.js — setupMap, setupLayers, updateMapData, setBaseMap, setDimensionMode, 3D terrain
//
// STRATEGIA DI FLUIDITÀ (per GPX enormi):
//
// 1. Dati originali (state.tracks) sono INTOCCATI — usati da grafico, export, editing.
// 2. Manteniamo una cache GeoJSON multi-LOD calcolata in modo "incrementale" e idle:
//    quando i dati cambiano marchiamo la cache come "sporca" e ricalcoliamo
//    SOLO il LOD corrente nel main thread; gli altri LOD vengono pre-calcolati
//    in background tramite requestIdleCallback (zero impatto sul pan/zoom).
// 3. `zoomend`/`moveend` invece di `zoom`: nessun lavoro JS durante l'inerzia del pan.
// 4. Il LOD viene scelto sul `zoomend` finale, NON su ogni delta di zoom.
// 5. MapLibre source `tolerance` ridotta al default per evitare flicker; il LOD
//    nostro si occupa già della riduzione punti pesante.

import {
    NEXTZEN_TERRAIN_SOURCE,
    map,
    is3D, setIs3D,
    currentStyle, setCurrentStyle,
    tracks,
    mapLoaded,
    activeTrackId,
    activeSegmentId,
    isDrawing
} from './state.js';

import { renderGisTree, showToast, isGisTreeVisible } from './ui.js';
import { updateStatsAndProfile } from './stats.js';
import { setupWaypointLayers, updateWaypointsOnMap, bindWaypointInteractions } from './waypoints.js';
import { schedulePersistAppSession } from './storage.js';

// ─── RDP iterativo (no ricorsione, no stack overflow) ─────────────────────────
function rdpIterative(points, tolerance) {
    const n = points.length;
    if (n <= 2) return points;
    const tol2 = tolerance * tolerance;
    const keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
        const [start, end] = stack.pop();
        const x1 = points[start].lon, y1 = points[start].lat;
        const x2 = points[end].lon,   y2 = points[end].lat;
        const dx = x2 - x1, dy = y2 - y1;
        const lenSq = dx * dx + dy * dy;
        let dmax = 0, index = start;
        for (let i = start + 1; i < end; i++) {
            const px = points[i].lon - x1, py = points[i].lat - y1;
            let d;
            if (lenSq === 0) {
                d = px * px + py * py;
            } else {
                const t = Math.max(0, Math.min(1, (px * dx + py * dy) / lenSq));
                const ex = px - t * dx, ey = py - t * dy;
                d = ex * ex + ey * ey;
            }
            if (d > dmax) { dmax = d; index = i; }
        }
        if (dmax > tol2) {
            keep[index] = 1;
            if (index - start > 1) stack.push([start, index]);
            if (end - index > 1)   stack.push([index, end]);
        }
    }
    // Bypass: se stiamo riducendo poco (es. <10%), restituiamo l'array originale
    // per evitare un'allocazione completa
    let kept = 0;
    for (let i = 0; i < n; i++) if (keep[i]) kept++;
    if (kept === n) return points;
    const result = new Array(kept);
    let j = 0;
    for (let i = 0; i < n; i++) if (keep[i]) result[j++] = points[i];
    return result;
}

// ─── Cache GeoJSON multi-LOD ──────────────────────────────────────────────────
// 5 livelli granulari: pan/zoom più fluido perché ogni transizione è piccola.
//
//   LOD 0 (z 0-7)   : tolleranza altissima — silhouette grossolana, ~50-200 pt
//   LOD 1 (z 7-10)  : tolleranza alta      — forma generale
//   LOD 2 (z 10-12) : tolleranza media     — discreta fedeltà
//   LOD 3 (z 12-14) : tolleranza fine      — alta fedeltà
//   LOD 4 (z 14+)   : nessuna decimazione  — tutti i punti

const LOD_LEVELS = [
    { tol: 0.005,    minZoom: 0  },
    { tol: 0.0015,   minZoom: 7  },
    { tol: 0.0005,   minZoom: 10 },
    { tol: 0.00015,  minZoom: 12 },
    { tol: 0,        minZoom: 14 }
];

let _lodCache = new Array(LOD_LEVELS.length).fill(null);
let _currentLod = -1;
let _cacheDataVersion = 0;   // incrementato ogni volta che i dati cambiano
let _cacheBuildVersion = -1; // versione che la cache ha attualmente
let _idleHandle = null;

function buildLodFeatures(lodIndex) {
    const tol = LOD_LEVELS[lodIndex].tol;
    const features = [];
    for (let ti = 0; ti < tracks.length; ti++) {
        const track = tracks[ti];
        if (track.visible === false) continue;
        const color = track.color || '#3b82f6';
        const width = track.width || 3;
        for (let si = 0; si < track.segments.length; si++) {
            const seg = track.segments[si];
            if (seg.visible === false) continue;
            const pts = seg.points;
            if (pts.length < 2) continue;
            const simplified = (tol === 0) ? pts : rdpIterative(pts, tol);
            const coords = new Array(simplified.length);
            for (let i = 0; i < simplified.length; i++) {
                const p = simplified[i];
                coords[i] = [p.lon, p.lat];
            }
            features.push({
                type: 'Feature',
                properties: { color, width },
                geometry: { type: 'LineString', coordinates: coords }
            });
        }
    }
    return { type: 'FeatureCollection', features };
}

function lodForZoom(zoom) {
    // Restituisce l'indice del LOD massimo il cui minZoom è <= zoom corrente
    let idx = 0;
    for (let i = LOD_LEVELS.length - 1; i >= 0; i--) {
        if (zoom >= LOD_LEVELS[i].minZoom) { idx = i; break; }
    }
    return idx;
}

// Costruisce un LOD specifico se non è già nella cache
function ensureLodBuilt(lodIndex) {
    if (_lodCache[lodIndex] && _cacheBuildVersion === _cacheDataVersion) {
        return _lodCache[lodIndex];
    }
    if (_cacheBuildVersion !== _cacheDataVersion) {
        // I dati sono cambiati — invalida tutta la cache
        _lodCache = new Array(LOD_LEVELS.length).fill(null);
        _cacheBuildVersion = _cacheDataVersion;
    }
    _lodCache[lodIndex] = buildLodFeatures(lodIndex);
    return _lodCache[lodIndex];
}

// Pre-calcola gli altri LOD in background (idle callback)
// Non bloccante: cede al browser tra un LOD e l'altro
function schedulePrebuildOtherLods(skipIndex) {
    if (_idleHandle !== null) {
        if (window.cancelIdleCallback) window.cancelIdleCallback(_idleHandle);
        else clearTimeout(_idleHandle);
    }
    const remaining = [];
    for (let i = 0; i < LOD_LEVELS.length; i++) {
        if (i !== skipIndex && (!_lodCache[i] || _cacheBuildVersion !== _cacheDataVersion)) {
            remaining.push(i);
        }
    }
    if (remaining.length === 0) return;

    const buildNext = (deadline) => {
        while (remaining.length > 0) {
            // Esci se siamo a corto di tempo idle
            if (deadline && typeof deadline.timeRemaining === 'function' && deadline.timeRemaining() < 5) break;
            const idx = remaining.shift();
            if (_cacheBuildVersion !== _cacheDataVersion) {
                _lodCache = new Array(LOD_LEVELS.length).fill(null);
                _cacheBuildVersion = _cacheDataVersion;
            }
            _lodCache[idx] = buildLodFeatures(idx);
        }
        if (remaining.length > 0) {
            if (window.requestIdleCallback) {
                _idleHandle = window.requestIdleCallback(buildNext, { timeout: 1500 });
            } else {
                _idleHandle = setTimeout(() => buildNext({ timeRemaining: () => 50 }), 50);
            }
        } else {
            _idleHandle = null;
        }
    };

    if (window.requestIdleCallback) {
        _idleHandle = window.requestIdleCallback(buildNext, { timeout: 1500 });
    } else {
        _idleHandle = setTimeout(() => buildNext({ timeRemaining: () => 50 }), 100);
    }
}

// Applica al map il LOD corretto per lo zoom corrente — chiamato su zoomend
function applyLodToMap(forceReload = false) {
    if (!mapLoaded) return;
    const zoom = map.getZoom();
    const lod  = lodForZoom(zoom);
    if (!forceReload && lod === _currentLod && _cacheBuildVersion === _cacheDataVersion) return;
    _currentLod = lod;
    const data = ensureLodBuilt(lod);
    const src  = map.getSource('gpx-lines');
    if (src) src.setData(data);
    schedulePrebuildOtherLods(lod);
}

// ─── API pubblica ─────────────────────────────────────────────────────────────

// Debounce: se chiamato in sequenza rapida, esegue una volta sola
let _updateTimer = null;
export function updateMapData(immediate = false) {
    if (!mapLoaded) return;
    clearTimeout(_updateTimer);
    if (immediate) {
        _doUpdateMapData();
    } else {
        _updateTimer = setTimeout(_doUpdateMapData, 80);
    }
}

function _doUpdateMapData() {
    if (!mapLoaded) return;

    // 1. Marca la cache come sporca — la ricostruzione avviene on-demand sotto applyLodToMap()
    _cacheDataVersion++;

    // 2. Applica subito il LOD corrente (solo questo viene costruito sul main thread)
    applyLodToMap(true);

    // 3. Punti di editing (solo segmento attivo in draw mode)
    const pointsFeatures = [];
    if (isDrawing) {
        for (let ti = 0; ti < tracks.length; ti++) {
            const track = tracks[ti];
            if (track.id !== activeTrackId) continue;
            for (let si = 0; si < track.segments.length; si++) {
                const seg = track.segments[si];
                if (seg.id !== activeSegmentId) continue;
                const pts = seg.points;
                for (let i = 0; i < pts.length; i++) {
                    const p = pts[i];
                    if (p.isUserClicked) {
                        pointsFeatures.push({
                            type: 'Feature',
                            properties: { pointIndex: i, segmentId: seg.id, trackId: track.id },
                            geometry: { type: 'Point', coordinates: [p.lon, p.lat] }
                        });
                    }
                }
            }
        }
    }
    const editSrc = map.getSource('gpx-edit-points');
    if (editSrc) editSrc.setData({ type: 'FeatureCollection', features: pointsFeatures });

    // 4. UI: aggiorna solo se i pannelli sono effettivamente visibili
    //    (evita lavoro inutile su pannelli chiusi con file enormi)
    if (!isDrawing && (typeof isGisTreeVisible === 'function' ? isGisTreeVisible() : true)) {
        renderGisTree();
    }
    if (!isDrawing) {
        updateStatsAndProfile();
    }
    if (!isDrawing) {
        updateWaypointsOnMap();
    }
}

export function setupLayers() {
    map.addSource('gpx-lines', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        // tolleranza interna MapLibre: lasciamo il default (0.375).
        // Il nostro LOD fa già il lavoro pesante; un valore alto qui causerebbe
        // ulteriori distorsioni a zoom alti (effetto "spigoli" visibili).
        buffer: 4,
        tolerance: 0.375
    });

    map.addLayer({
        id: 'gpx-lines-layer',
        type: 'line',
        source: 'gpx-lines',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
            'line-color': ['get', 'color'],
            'line-width': ['get', 'width'],
            'line-opacity': 0.85
        }
    });

    map.addSource('gpx-edit-points', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });

    map.addLayer({
        id: 'gpx-edit-points-layer',
        type: 'circle',
        source: 'gpx-edit-points',
        paint: {
            'circle-radius': 5,
            'circle-color': '#ff3b30',
            'circle-stroke-width': 1.5,
            'circle-stroke-color': '#ffffff'
        }
    });

    setupWaypointLayers();
    bindWaypointInteractions();

    // Switch LOD solo al termine del gesto (no lavoro durante pan/zoom inerziale)
    // `zoomend` scatta quando l'utente smette di interagire e la mappa è stabile.
    map.on('zoomend', () => applyLodToMap());

    // Sincronizza il LOD anche al primo idle (raro caso in cui zoomend non scatta)
    map.once('idle', () => applyLodToMap());
}

export function setBaseMap(style) {
    setCurrentStyle(style);
    if (!mapLoaded) return;

    const isHybrid = document.getElementById('toggle-hybrid').checked;

    if (style === 'osm') {
        map.setStyle({
            version: 8,
            glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
            sources: {
                'osm-raster': {
                    type: 'raster',
                    tiles: ['https://a.tile.openstreetmap.org/{z}/{x}/{y}.png'],
                    tileSize: 256,
                    attribution: '&copy; OpenStreetMap contributors'
                }
            },
            layers: [{ id: 'osm-layer', type: 'raster', source: 'osm-raster' }]
        });
    } else if (style === 'sat') {
        const sources = {
            'sat-raster': {
                type: 'raster',
                tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
                tileSize: 256,
                attribution: 'Tiles &copy; Esri'
            }
        };
        const layers = [{ id: 'sat-layer', type: 'raster', source: 'sat-raster' }];
        if (isHybrid) {
            sources['hybrid-ref'] = {
                type: 'raster',
                tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
                tileSize: 256
            };
            layers.push({ id: 'hybrid-ref-layer', type: 'raster', source: 'hybrid-ref' });
        }
        map.setStyle({
            version: 8,
            glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
            sources,
            layers
        });
    } else if (style === 'topo') {
        map.setStyle({
            version: 8,
            glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
            sources: {
                'topo-raster': {
                    type: 'raster',
                    tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png'],
                    tileSize: 256,
                    attribution: 'Map data &copy; OpenTopoMap'
                }
            },
            layers: [{ id: 'topo-layer', type: 'raster', source: 'topo-raster' }]
        });
    }

    map.once('style.load', () => {
        setupLayers();

        map.addSource('terrain-nextzen', {
            type: 'raster-dem',
            tiles: [NEXTZEN_TERRAIN_SOURCE],
            tileSize: 512,
            maxzoom: 14,
            encoding: 'terrarium'
        });

        map.addSource('waymarked-hiking', {
            type: 'raster',
            tiles: ['https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png'],
            tileSize: 256
        });
        map.addLayer({
            id: 'hiking-trails-layer',
            type: 'raster',
            source: 'waymarked-hiking',
            paint: { 'raster-opacity': 0.8 },
            layout: { visibility: document.getElementById('toggle-hiking-trails').checked ? 'visible' : 'none' }
        });

        if (is3D) {
            map.setTerrain({ source: 'terrain-nextzen', exaggeration: 1.2 });
        }

        updateMapData(true);
    });

    ['osm', 'sat', 'topo'].forEach(s => {
        const el = document.getElementById(`map-style-${s}`);
        el.className = s === style
            ? "text-[10px] font-bold py-1.5 px-1 rounded-md text-center bg-blue-600 text-white transition-all"
            : "text-[10px] font-medium py-1.5 px-1 rounded-md text-center text-gray-400 hover:text-white transition-all";
    });

    document.getElementById('sat-options-container').className =
        style === 'sat' ? "pt-1.5 flex items-center justify-between" : "hidden";

    schedulePersistAppSession();
}

export function setDimensionMode(enable3D, options = {}) {
    setIs3D(enable3D);
    if (!mapLoaded) return;

    if (enable3D) {
        if (!map.getSource('terrain-nextzen')) {
            if (!options.silent) {
                showToast("Sorgente terreno non ancora pronta, riprova tra un momento.", "info");
            }
            setIs3D(false);
            return;
        }
        map.setTerrain({ source: 'terrain-nextzen', exaggeration: 1.2 });
        map.easeTo({ pitch: 55, duration: 1000 });
        if (!options.silent) {
            showToast("Terreno 3D Attivato! Trascina con tasto destro per inclinare.", "info");
        }
    } else {
        map.setTerrain(null);
        map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
    }

    document.getElementById('view-mode-2d').className = !enable3D
        ? "text-xs font-medium py-1 px-2 rounded bg-blue-600 text-white"
        : "text-xs font-medium py-1 px-2 rounded text-gray-400 hover:text-white";
    document.getElementById('view-mode-3d').className = enable3D
        ? "text-xs font-medium py-1 px-2 rounded bg-blue-600 text-white"
        : "text-xs font-medium py-1 px-2 rounded text-gray-400 hover:text-white";

    schedulePersistAppSession();
}

export function flyToPOI(lon, lat, alt, pitch, bearing) {
    if (!mapLoaded) return;
    setDimensionMode(true);
    map.flyTo({ center: [lon, lat], zoom: 12.5, pitch, bearing, duration: 3000 });
}

export async function queryElevation(lon, lat) {
    if (!mapLoaded) return 0;
    try {
        const ele = map.queryTerrainElevation([lon, lat]);
        return ele !== null ? Math.round(ele) : 0;
    } catch { return 0; }
}
