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
    MAPILLARY_GRAPH_URL,
    MAPILLARY_TILES_URL,
    MAPILLARY_TOKEN_KEY,
    map,
    is3D,
    setIs3D,
    currentStyle,
    setCurrentStyle,
    isMapillaryVisible,
    setIsMapillaryVisible,
    mapillaryToken,
    setMapillaryToken,
    tracks,
    mapLoaded,
    activeTrackId,
    activeSegmentId,
    isDrawing,
    isCutting,
    isBoxDeleting,
    isAddingWaypoint
} from './state.js';

import { renderGisTree, showToast, isGisTreeVisible, setSegmentActive, setTrackActive } from './ui.js';
import { updateStatsAndProfile } from './stats.js';
import { setupWaypointLayers, updateWaypointsOnMap, bindWaypointInteractions } from './waypoints.js';
import { schedulePersistAppSession, schedulePersistTracks } from './storage.js';
import { requireAuth, isAuthenticated } from './auth.js';

// ─── RDP iterativo (no ricorsione, no stack overflow) ─────────────────────────
function rdpIterative(points, tolerance) {
    const n = points.length;
    if (n <= 2) return points;
    const tol2 = tolerance * tolerance;
    const keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;
    const stack = [
        [0, n - 1]
    ];
    while (stack.length) {
        const [start, end] = stack.pop();
        const x1 = points[start].lon,
            y1 = points[start].lat;
        const x2 = points[end].lon,
            y2 = points[end].lat;
        const dx = x2 - x1,
            dy = y2 - y1;
        const lenSq = dx * dx + dy * dy;
        let dmax = 0,
            index = start;
        for (let i = start + 1; i < end; i++) {
            const px = points[i].lon - x1,
                py = points[i].lat - y1;
            let d;
            if (lenSq === 0) {
                d = px * px + py * py;
            } else {
                const t = Math.max(0, Math.min(1, (px * dx + py * dy) / lenSq));
                const ex = px - t * dx,
                    ey = py - t * dy;
                d = ex * ex + ey * ey;
            }
            if (d > dmax) { dmax = d;
                index = i; }
        }
        if (dmax > tol2) {
            keep[index] = 1;
            if (index - start > 1) stack.push([start, index]);
            if (end - index > 1) stack.push([index, end]);
        }
    }
    // Bypass: se stiamo riducendo poco (es. <10%), restituiamo l'array originale
    // per evitare un'allocazione completa
    let kept = 0;
    for (let i = 0; i < n; i++)
        if (keep[i]) kept++;
    if (kept === n) return points;
    const result = new Array(kept);
    let j = 0;
    for (let i = 0; i < n; i++)
        if (keep[i]) result[j++] = points[i];
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
    { tol: 0.005, minZoom: 0 },
    { tol: 0.0015, minZoom: 7 },
    { tol: 0.0005, minZoom: 10 },
    { tol: 0.00015, minZoom: 12 },
    { tol: 0, minZoom: 14 }
];

let _lodCache = new Array(LOD_LEVELS.length).fill(null);
let _currentLod = -1;
let _cacheDataVersion = 0; // incrementato ogni volta che i dati cambiano
let _cacheBuildVersion = -1; // versione che la cache ha attualmente
let _idleHandle = null;
let _mapillaryInteractionsBound = false;
let _mapillaryCurrentImageId = null;
let _mapillarySequenceId = null;
let _mapillarySequenceIds = [];
let _mapillaryCurrentIndex = -1;
let _mapillaryPlayTimer = null;
let _mapillaryRequestSerial = 0;
let _mapillaryJsViewer = null;
let _mapillaryJsResizeObserver = null;
let _mapillaryJsWindowResizeHandler = null;
let _mapillaryCurrentLngLat = null;
let _mapillaryCurrentBearing = 0;
let _mapillaryCurrentFov = 70;
let _trackInteractionsBound = false;
let _lodInteractionsBound = false;
let _styleReloadSerial = 0;
let _elevationHydrationTimer = null;
let _elevationHydrationRunning = false;
const _elevationLookupDone = new WeakSet();
const _terrainTileCache = new Map();
const _mapillarySequenceCache = new Map();
const APPLICATION_LAYER_ORDER = [
    'mapillary-sequences-layer',
    'mapillary-images-layer',
    'gpx-lines-layer',
    'box-delete-preview-fill',
    'box-delete-preview-line',
    'gpx-waypoints-cluster-halo-layer',
    'gpx-waypoints-cluster-layer',
    'gpx-waypoints-cluster-count-layer',
    'gpx-waypoints-hit-layer',
    'gpx-waypoints-circle-layer',
    'gpx-waypoints-ring-layer',
    'gpx-waypoints-symbol-layer',
    'gpx-edit-points-layer',
    'mapillary-current-fov-fill-layer',
    'mapillary-current-fov-line-layer',
    'mapillary-current-image-halo-layer',
    'mapillary-current-image-layer',
    'mapillary-current-image-direction-layer'
];

function ensureApplicationLayersAboveMap() {
    if (!mapLoaded) return;
    for (const layerId of APPLICATION_LAYER_ORDER) {
        if (map.getLayer(layerId)) map.moveLayer(layerId);
    }
}

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
                properties: { color, width, trackId: track.id, segmentId: seg.id },
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
    const lod = lodForZoom(zoom);
    if (!forceReload && lod === _currentLod && _cacheBuildVersion === _cacheDataVersion) return;
    _currentLod = lod;
    const data = ensureLodBuilt(lod);
    const src = map.getSource('gpx-lines');
    if (src) src.setData(data);
    schedulePrebuildOtherLods(lod);
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function terrainTileCoordinate(lon, lat) {
    const z = 14;
    const tileSize = 512;
    const safeLat = clamp(lat, -85.05112878, 85.05112878);
    const n = 2 ** z;
    const xFloat = ((lon + 180) / 360) * n;
    const latRad = safeLat * Math.PI / 180;
    const yFloat = (1 - Math.log(Math.tan(latRad) + (1 / Math.cos(latRad))) / Math.PI) / 2 * n;
    const x = clamp(Math.floor(xFloat), 0, n - 1);
    const y = clamp(Math.floor(yFloat), 0, n - 1);
    const pixelX = clamp(Math.floor((xFloat - x) * tileSize), 0, tileSize - 1);
    const pixelY = clamp(Math.floor((yFloat - y) * tileSize), 0, tileSize - 1);
    return { z, x, y, pixelX, pixelY };
}

async function loadTerrainTileImageData(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (_terrainTileCache.has(key)) return _terrainTileCache.get(key);

    const promise = (async() => {
        const url = NEXTZEN_TERRAIN_SOURCE
            .replace('{z}', z)
            .replace('{x}', x)
            .replace('{y}', y);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`DEM tile ${response.status}`);
        const blob = await response.blob();
        const canvas = document.createElement('canvas');
        let image = null;

        if (typeof createImageBitmap === 'function') {
            image = await createImageBitmap(blob);
            canvas.width = image.width;
            canvas.height = image.height;
        } else {
            image = await new Promise((resolve, reject) => {
                const img = new Image();
                const objectUrl = URL.createObjectURL(blob);
                img.onload = () => {
                    URL.revokeObjectURL(objectUrl);
                    resolve(img);
                };
                img.onerror = () => {
                    URL.revokeObjectURL(objectUrl);
                    reject(new Error('DEM image decode failed'));
                };
                img.src = objectUrl;
            });
            canvas.width = image.naturalWidth || image.width;
            canvas.height = image.naturalHeight || image.height;
        }

        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image, 0, 0);
        image.close?.();
        return {
            width: canvas.width,
            height: canvas.height,
            data: ctx.getImageData(0, 0, canvas.width, canvas.height).data
        };
    })().catch(err => {
        _terrainTileCache.delete(key);
        throw err;
    });

    _terrainTileCache.set(key, promise);
    return promise;
}

async function queryTerrariumElevation(lon, lat) {
    const tile = terrainTileCoordinate(lon, lat);
    const imageData = await loadTerrainTileImageData(tile.z, tile.x, tile.y);
    const px = clamp(tile.pixelX, 0, imageData.width - 1);
    const py = clamp(tile.pixelY, 0, imageData.height - 1);
    const idx = (py * imageData.width + px) * 4;
    const r = imageData.data[idx];
    const g = imageData.data[idx + 1];
    const b = imageData.data[idx + 2];
    return Math.round((r * 256 + g + b / 256) - 32768);
}

function segmentHasOnlyMissingElevation(segment) {
    const points = segment.points || [];
    if (points.length === 0) return false;
    for (let i = 0; i < points.length; i++) {
        const ele = Number(points[i].ele);
        if (Number.isFinite(ele) && Math.abs(ele) > 0.01) return false;
    }
    return true;
}

function collectMissingElevationPoints(limit = 120) {
    const candidates = [];
    for (let ti = 0; ti < tracks.length && candidates.length < limit; ti++) {
        const track = tracks[ti];
        if (track.visible === false) continue;
        for (let si = 0; si < track.segments.length && candidates.length < limit; si++) {
            const segment = track.segments[si];
            if (segment.visible === false) continue;
            const hydrateFlatSegment = track.localSource !== 'imported' && segmentHasOnlyMissingElevation(segment);
            const points = segment.points || [];
            for (let pi = 0; pi < points.length && candidates.length < limit; pi++) {
                const point = points[pi];
                if (_elevationLookupDone.has(point)) continue;
                const ele = Number(point.ele);
                const missing = !Number.isFinite(ele) || (Math.abs(ele) <= 0.01 && (point.needsElevation || point.isUserClicked || hydrateFlatSegment));
                if (missing && Number.isFinite(point.lon) && Number.isFinite(point.lat)) {
                    candidates.push(point);
                }
            }
        }
    }
    return candidates;
}

function scheduleMissingElevationHydration() {
    if (_elevationHydrationRunning || _elevationHydrationTimer !== null) return;
    if (collectMissingElevationPoints(1).length === 0) return;

    _elevationHydrationTimer = setTimeout(async() => {
        _elevationHydrationTimer = null;
        _elevationHydrationRunning = true;
        let updated = false;

        try {
            const candidates = collectMissingElevationPoints();
            for (let i = 0; i < candidates.length; i++) {
                const point = candidates[i];
                _elevationLookupDone.add(point);
                const ele = await queryElevation(point.lon, point.lat);
                if (Number.isFinite(ele)) {
                    point.ele = ele;
                    updated = true;
                }
                delete point.needsElevation;
            }
        } finally {
            _elevationHydrationRunning = false;
        }

        if (updated) {
            schedulePersistTracks(tracks);
            updateStatsAndProfile();
        }

        if (collectMissingElevationPoints(1).length > 0) {
            scheduleMissingElevationHydration();
        }
    }, 250);
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
    scheduleMissingElevationHydration();

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
    let initialGpxData = { type: 'FeatureCollection', features: [] };
    if (mapLoaded) {
        const zoom = map.getZoom();
        const lod = lodForZoom(zoom);
        initialGpxData = ensureLodBuilt(lod);
    }

    if (!map.getSource('gpx-lines')) {
        map.addSource('gpx-lines', {
            type: 'geojson',
            data: initialGpxData,
            // tolleranza interna MapLibre: lasciamo il default (0.375).
            // Il nostro LOD fa già il lavoro pesante; un valore alto qui causerebbe
            // ulteriori distorsioni a zoom alti (effetto "spigoli" visibili).
            buffer: 4,
            tolerance: 0.375
        });
    }

    if (!map.getLayer('gpx-lines-layer')) {
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
    }

    if (!_trackInteractionsBound) {
        _trackInteractionsBound = true;

        map.on('click', 'gpx-lines-layer', (e) => {
            const feature = e.features && e.features[0];
            const trackId = feature && feature.properties ? feature.properties.trackId : null;
            const segmentId = feature && feature.properties ? feature.properties.segmentId : null;
            if (!trackId || isDrawing || isCutting || isBoxDeleting || isAddingWaypoint) return;
            if (segmentId) {
                setSegmentActive(trackId, segmentId);
                return;
            }
            setTrackActive(trackId);
        });

        map.on('mouseenter', 'gpx-lines-layer', () => {
            if (!isDrawing && !isCutting && !isBoxDeleting && !isAddingWaypoint) {
                map.getCanvas().style.cursor = 'pointer';
            }
        });

        map.on('mouseleave', 'gpx-lines-layer', () => {
            if (!isDrawing && !isCutting && !isBoxDeleting && !isAddingWaypoint) {
                map.getCanvas().style.cursor = '';
            }
        });
    }

    let initialEditData = { type: 'FeatureCollection', features: [] };
    if (mapLoaded && isDrawing) {
        const pointsFeatures = [];
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
        initialEditData.features = pointsFeatures;
    }

    if (!map.getSource('gpx-edit-points')) {
        map.addSource('gpx-edit-points', {
            type: 'geojson',
            data: initialEditData
        });
    }

    if (!map.getLayer('gpx-edit-points-layer')) {
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
    }

    setupWaypointLayers();
    bindWaypointInteractions();
    setupMapillaryLayers();

    if (!map.getSource('box-delete-preview')) {
        map.addSource('box-delete-preview', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });
    }

    if (!map.getLayer('box-delete-preview-fill')) {
        map.addLayer({
            id: 'box-delete-preview-fill',
            type: 'fill',
            source: 'box-delete-preview',
            paint: {
                'fill-color': '#ef4444',
                'fill-opacity': 0.16
            }
        });
    }

    if (!map.getLayer('box-delete-preview-line')) {
        map.addLayer({
            id: 'box-delete-preview-line',
            type: 'line',
            source: 'box-delete-preview',
            paint: {
                'line-color': '#ef4444',
                'line-width': 2,
                'line-dasharray': [2, 1]
            }
        });
    }

    // Switch LOD solo al termine del gesto (no lavoro durante pan/zoom inerziale)
    // `zoomend` scatta quando l'utente smette di interagire e la mappa è stabile.
    if (!_lodInteractionsBound) {
        _lodInteractionsBound = true;
        map.on('zoomend', () => applyLodToMap());
    }

    // Sincronizza il LOD anche al primo idle (raro caso in cui zoomend non scatta)
    map.once('idle', () => applyLodToMap());

    ensureApplicationLayersAboveMap();
}

export function updateBoxDeletePreview(startLngLat, endLngLat) {
    const src = mapLoaded ? map.getSource('box-delete-preview') : null;
    if (!src) return;

    if (!startLngLat || !endLngLat) {
        src.setData({ type: 'FeatureCollection', features: [] });
        return;
    }

    const minLng = Math.min(startLngLat.lng, endLngLat.lng);
    const maxLng = Math.max(startLngLat.lng, endLngLat.lng);
    const minLat = Math.min(startLngLat.lat, endLngLat.lat);
    const maxLat = Math.max(startLngLat.lat, endLngLat.lat);

    src.setData({
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'Polygon',
                coordinates: [
                    [
                        [minLng, minLat],
                        [maxLng, minLat],
                        [maxLng, maxLat],
                        [minLng, maxLat],
                        [minLng, minLat]
                    ]
                ]
            }
        }]
    });
}

function hasMapillaryToken() {
    return mapillaryToken.trim().length > 0;
}

function mapillaryVisibility() {
    return isMapillaryVisible && hasMapillaryToken() ? 'visible' : 'none';
}

function emptyMapillaryCurrentFeatureCollection() {
    return { type: 'FeatureCollection', features: [] };
}

function buildMapillaryCurrentFeatureCollection() {
    if (!_mapillaryCurrentLngLat) return emptyMapillaryCurrentFeatureCollection();
    return {
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            properties: {
                imageId: _mapillaryCurrentImageId || '',
                bearing: Number.isFinite(_mapillaryCurrentBearing) ? _mapillaryCurrentBearing : 0
            },
            geometry: { type: 'Point', coordinates: [_mapillaryCurrentLngLat.lng, _mapillaryCurrentLngLat.lat] }
        }]
    };
}

function mapillaryDestination(lngLat, bearingDeg, distanceMeters) {
    const radius = 6378137;
    const bearing = bearingDeg * Math.PI / 180;
    const lat1 = lngLat.lat * Math.PI / 180;
    const lon1 = lngLat.lng * Math.PI / 180;
    const angularDistance = distanceMeters / radius;
    const lat2 = Math.asin(
        Math.sin(lat1) * Math.cos(angularDistance) +
        Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
    );
    const lon2 = lon1 + Math.atan2(
        Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
        Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
    );
    return [lon2 * 180 / Math.PI, lat2 * 180 / Math.PI];
}

function getMapillaryHorizontalFov() {
    const verticalFov = Number.isFinite(_mapillaryCurrentFov) ? _mapillaryCurrentFov : 70;
    const container = document.getElementById('mapillary-js-viewer');
    const width = container?.offsetWidth || 1;
    const height = container?.offsetHeight || 1;
    const aspect = height === 0 ? 1 : width / height;
    const verticalRad = verticalFov * Math.PI / 180;
    return Math.atan(aspect * Math.tan(0.5 * verticalRad)) * 2 * 180 / Math.PI;
}

function buildMapillaryCurrentFovFeatureCollection() {
    if (!_mapillaryCurrentLngLat) return emptyMapillaryCurrentFeatureCollection();
    const bearing = Number.isFinite(_mapillaryCurrentBearing) ? _mapillaryCurrentBearing : 0;
    const fov = Math.min(140, Math.max(20, getMapillaryHorizontalFov()));
    const radius = 70;
    const start = bearing - fov / 2;
    const steps = 18;
    const coordinates = [
        [_mapillaryCurrentLngLat.lng, _mapillaryCurrentLngLat.lat]
    ];
    for (let i = 0; i <= steps; i++) {
        coordinates.push(mapillaryDestination(_mapillaryCurrentLngLat, start + (fov * i / steps), radius));
    }
    coordinates.push([_mapillaryCurrentLngLat.lng, _mapillaryCurrentLngLat.lat]);
    return {
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            properties: {
                imageId: _mapillaryCurrentImageId || '',
                bearing,
                fov
            },
            geometry: { type: 'Polygon', coordinates: [coordinates] }
        }]
    };
}

function refreshMapillaryCurrentSources() {
    const markerSource = mapLoaded ? map.getSource('mapillary-current-image') : null;
    if (markerSource) markerSource.setData(buildMapillaryCurrentFeatureCollection());
    const fovSource = mapLoaded ? map.getSource('mapillary-current-fov') : null;
    if (fovSource) fovSource.setData(buildMapillaryCurrentFovFeatureCollection());
}

function centerMapOnMapillaryIfNeeded(lngLat) {
    if (!mapLoaded || !lngLat || !Number.isFinite(lngLat.lng) || !Number.isFinite(lngLat.lat)) return;
    const bounds = map.getBounds?.();
    if (bounds && !bounds.contains([lngLat.lng, lngLat.lat])) {
        map.easeTo({ center: [lngLat.lng, lngLat.lat], duration: 450 });
    }
}

function normalizeMapillaryLngLat(value) {
    if (!value) return null;
    if (Array.isArray(value) && value.length >= 2) {
        return { lng: Number(value[0]), lat: Number(value[1]) };
    }
    if (Array.isArray(value.coordinates) && value.coordinates.length >= 2) {
        return { lng: Number(value.coordinates[0]), lat: Number(value.coordinates[1]) };
    }
    if (typeof value.lng === 'number' && typeof value.lat === 'number') {
        return { lng: value.lng, lat: value.lat };
    }
    if (typeof value.lon === 'number' && typeof value.lat === 'number') {
        return { lng: value.lon, lat: value.lat };
    }
    if (value.type === 'Point' && Array.isArray(value.coordinates) && value.coordinates.length >= 2) {
        return { lng: Number(value.coordinates[0]), lat: Number(value.coordinates[1]) };
    }
    return null;
}

function normalizeMapillaryBearing(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    return ((num % 360) + 360) % 360;
}

function getMapillaryImageLngLat(image) {
    return image?.lngLat ||
        image?.computedLngLat ||
        image?.originalLngLat ||
        image?.computed_geometry ||
        image?.computedGeometry ||
        image?.geometry;
}

function getMapillaryImageBearing(image) {
    return normalizeMapillaryBearing(
        image?.computed_compass_angle
        ?? image?.computedCompassAngle
        ?? image?.compass_angle
        ?? image?.compassAngle
        ?? image?.bearing
    );
}

function updateMapillaryCurrentMarker(value, imageId, bearing = null) {
    const lngLat = normalizeMapillaryLngLat(value);
    if (!lngLat || !Number.isFinite(lngLat.lng) || !Number.isFinite(lngLat.lat)) return;
    _mapillaryCurrentLngLat = lngLat;
    if (imageId) _mapillaryCurrentImageId = String(imageId);
    const normalizedBearing = normalizeMapillaryBearing(bearing);
    _mapillaryCurrentBearing = normalizedBearing !== null ? normalizedBearing : 0;
    refreshMapillaryCurrentSources();
    centerMapOnMapillaryIfNeeded(lngLat);
}

function updateMapillaryCurrentBearing(value) {
    const normalizedBearing = normalizeMapillaryBearing(value);
    if (normalizedBearing === null) return;
    _mapillaryCurrentBearing = normalizedBearing;
    refreshMapillaryCurrentSources();
}

function updateMapillaryCurrentFov(value) {
    const fov = Number(value);
    if (!Number.isFinite(fov)) return;
    _mapillaryCurrentFov = fov;
    refreshMapillaryCurrentSources();
}

function clearMapillaryCurrentMarker() {
    _mapillaryCurrentLngLat = null;
    _mapillaryCurrentBearing = 0;
    _mapillaryCurrentFov = 70;
    refreshMapillaryCurrentSources();
}

function setupMapillaryLayers() {
    if (!isAuthenticated()) return;
    if (!hasMapillaryToken()) return;

    if (!map.getSource('mapillary-images')) {
        map.addSource('mapillary-images', {
            type: 'vector',
            tiles: [MAPILLARY_TILES_URL + encodeURIComponent(mapillaryToken.trim())],
            minzoom: 6,
            maxzoom: 14,
            attribution: '<a href="https://www.mapillary.com/" target="_blank" rel="noopener">Mapillary</a>'
        });
    }

    if (!map.getLayer('mapillary-sequences-layer')) {
        map.addLayer({
            id: 'mapillary-sequences-layer',
            type: 'line',
            source: 'mapillary-images',
            'source-layer': 'sequence',
            minzoom: 6,
            layout: {
                visibility: mapillaryVisibility(),
                'line-join': 'round',
                'line-cap': 'round'
            },
            paint: {
                'line-color': '#05cb63',
                'line-width': ['interpolate', ['linear'],
                    ['zoom'], 6, 1.2, 14, 3
                ],
                'line-opacity': 0.72
            }
        });
    }

    if (!map.getLayer('mapillary-images-layer')) {
        map.addLayer({
            id: 'mapillary-images-layer',
            type: 'circle',
            source: 'mapillary-images',
            'source-layer': 'image',
            minzoom: 13,
            layout: { visibility: mapillaryVisibility() },
            paint: {
                'circle-radius': ['interpolate', ['linear'],
                    ['zoom'], 13, 2.5, 17, 5.5
                ],
                'circle-color': '#05cb63',
                'circle-stroke-color': '#042f1a',
                'circle-stroke-width': 1,
                'circle-opacity': 0.9
            }
        });
    }

    if (!map.getSource('mapillary-current-image')) {
        map.addSource('mapillary-current-image', {
            type: 'geojson',
            data: buildMapillaryCurrentFeatureCollection()
        });
    }

    if (!map.getSource('mapillary-current-fov')) {
        map.addSource('mapillary-current-fov', {
            type: 'geojson',
            data: buildMapillaryCurrentFovFeatureCollection()
        });
    }

    if (!map.getLayer('mapillary-current-fov-fill-layer')) {
        map.addLayer({
            id: 'mapillary-current-fov-fill-layer',
            type: 'fill',
            source: 'mapillary-current-fov',
            layout: { visibility: mapillaryVisibility() },
            paint: {
                'fill-color': '#facc15',
                'fill-opacity': 0.34
            }
        });
    }

    if (!map.getLayer('mapillary-current-fov-line-layer')) {
        map.addLayer({
            id: 'mapillary-current-fov-line-layer',
            type: 'line',
            source: 'mapillary-current-fov',
            layout: { visibility: mapillaryVisibility() },
            paint: {
                'line-color': '#111827',
                'line-width': 1.1,
                'line-opacity': 0.75
            }
        });
    }

    if (!map.getLayer('mapillary-current-image-halo-layer')) {
        map.addLayer({
            id: 'mapillary-current-image-halo-layer',
            type: 'circle',
            source: 'mapillary-current-image',
            layout: { visibility: mapillaryVisibility() },
            paint: {
                'circle-radius': 15,
                'circle-color': '#ffffff',
                'circle-opacity': 0.92,
                'circle-stroke-color': '#05cb63',
                'circle-stroke-width': 3
            }
        });
    }

    if (!map.getLayer('mapillary-current-image-layer')) {
        map.addLayer({
            id: 'mapillary-current-image-layer',
            type: 'circle',
            source: 'mapillary-current-image',
            layout: { visibility: mapillaryVisibility() },
            paint: {
                'circle-radius': 7,
                'circle-color': '#f97316',
                'circle-opacity': 1,
                'circle-stroke-color': '#111827',
                'circle-stroke-width': 1.5
            }
        });
    }

    if (!map.getLayer('mapillary-current-image-direction-layer')) {
        map.addLayer({
            id: 'mapillary-current-image-direction-layer',
            type: 'symbol',
            source: 'mapillary-current-image',
            layout: {
                visibility: mapillaryVisibility(),
                'text-field': '▲',
                'text-size': 24,
                'text-allow-overlap': true,
                'text-ignore-placement': true,
                'text-rotation-alignment': 'map',
                'text-pitch-alignment': 'map',
                'text-rotate': ['get', 'bearing'],
                'text-offset': [0, -1.05]
            },
            paint: {
                'text-color': '#f97316',
                'text-halo-color': '#111827',
                'text-halo-width': 1.4
            }
        });
    }

    bindMapillaryInteractions();
    ensureApplicationLayersAboveMap();
}

function applyMapillaryLayerVisibility() {
    if (!mapLoaded) return;
    const visibility = mapillaryVisibility();
    [
        'mapillary-sequences-layer',
        'mapillary-images-layer',
        'mapillary-current-fov-fill-layer',
        'mapillary-current-fov-line-layer',
        'mapillary-current-image-halo-layer',
        'mapillary-current-image-layer',
        'mapillary-current-image-direction-layer'
    ].forEach(layerId => {
        if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', visibility);
    });
}

function bindMapillaryInteractions() {
    if (_mapillaryInteractionsBound) return;
    _mapillaryInteractionsBound = true;

    map.on('mouseenter', 'mapillary-images-layer', () => {
        if (!isDrawing && !isCutting && !isBoxDeleting && !isAddingWaypoint) {
            map.getCanvas().style.cursor = 'pointer';
        }
    });

    map.on('mouseleave', 'mapillary-images-layer', () => {
        if (!isDrawing && !isCutting && !isBoxDeleting && !isAddingWaypoint) {
            map.getCanvas().style.cursor = '';
        }
    });

    map.on('click', 'mapillary-images-layer', (e) => {
        if (!isMapillaryVisible || isDrawing || isCutting || isBoxDeleting || isAddingWaypoint) return;
        if (!requireAuth("Mapillary")) return;
        const feature = e.features && e.features[0];
        const imageId = feature?.properties?.id || feature?.properties?.image_id || feature?.properties?.key;
        if (!imageId) {
            showToast("Immagine Mapillary senza ID interrogabile", "error");
            return;
        }
        e.preventDefault();
        updateMapillaryCurrentMarker(feature.geometry, imageId, feature.properties?.computed_compass_angle || feature.properties?.compass_angle);
        openMapillaryImage(String(imageId));
    });
}

function getMapillaryJsApi() {
    return window.mapillary?.Viewer ? window.mapillary : (window.Mapillary?.Viewer ? window.Mapillary : null);
}

function getMapillaryComponentOptions() {
    return {
        cover: false
    };
}

function updateMapillaryViewerHeader(imageId, options = {}) {
    const id = String(imageId || '');
    if (!id) return;
    document.getElementById('mapillary-title').textContent = `Mapillary ${id}`;
    document.getElementById('mapillary-date').textContent = options.dateText || '';
    document.getElementById('mapillary-author').textContent = options.authorText || '';
    document.getElementById('mapillary-open-link').href = `https://www.mapillary.com/app/?pKey=${encodeURIComponent(id)}`;
    _mapillaryCurrentImageId = id;
}

function setMapillaryViewerOpen(isOpen) {
    document.body.classList.toggle('mapillary-viewer-open', Boolean(isOpen));
}

function resetMapillaryJsViewer() {
    if (_mapillaryJsResizeObserver) {
        _mapillaryJsResizeObserver.disconnect();
        _mapillaryJsResizeObserver = null;
    }
    if (_mapillaryJsWindowResizeHandler) {
        window.removeEventListener('resize', _mapillaryJsWindowResizeHandler);
        _mapillaryJsWindowResizeHandler = null;
    }
    if (_mapillaryJsViewer && typeof _mapillaryJsViewer.remove === 'function') {
        try { _mapillaryJsViewer.remove(); } catch (err) { console.error('Errore chiusura MapillaryJS:', err); }
    }
    _mapillaryJsViewer = null;
    const container = document.getElementById('mapillary-js-viewer');
    if (container) {
        container.replaceChildren();
        container.classList.add('hidden');
    }
}

function ensureMapillaryJsResizeObserver() {
    if (_mapillaryJsResizeObserver) return;
    const panel = document.getElementById('panel-mapillary-viewer');
    if (!panel) return;
    _mapillaryJsResizeObserver = new ResizeObserver(() => {
        if (_mapillaryJsViewer && typeof _mapillaryJsViewer.resize === 'function') {
            _mapillaryJsViewer.resize();
        }
    });
    _mapillaryJsResizeObserver.observe(panel);
}

async function syncMapillaryViewerImage(image = null) {
    if (!_mapillaryJsViewer) return;
    try {
        const currentImage = image || await _mapillaryJsViewer.getImage();
        updateMapillaryViewerHeader(currentImage?.id || _mapillaryCurrentImageId);
        updateMapillaryCurrentMarker(
            getMapillaryImageLngLat(currentImage),
            currentImage?.id,
            getMapillaryImageBearing(currentImage)
        );
    } catch {
        // MapillaryJS può emettere eventi intermedi durante il cambio immagine.
    }
}

async function syncMapillaryViewerPosition() {
    if (!_mapillaryJsViewer || typeof _mapillaryJsViewer.getPosition !== 'function') return;
    try {
        const position = await _mapillaryJsViewer.getPosition();
        updateMapillaryCurrentMarker(position, _mapillaryCurrentImageId, _mapillaryCurrentBearing);
    } catch {
        // La posizione non è disponibile finché il viewer non è navigabile.
    }
}

async function syncMapillaryViewerPov() {
    if (!_mapillaryJsViewer || typeof _mapillaryJsViewer.getPointOfView !== 'function') return;
    try {
        const pov = await _mapillaryJsViewer.getPointOfView();
        updateMapillaryCurrentBearing(pov?.bearing);
    } catch {
        // Il punto di vista non è disponibile durante alcune transizioni.
    }
}

async function syncMapillaryViewerFov() {
    if (!_mapillaryJsViewer || typeof _mapillaryJsViewer.getFieldOfView !== 'function') return;
    try {
        const fov = await _mapillaryJsViewer.getFieldOfView();
        updateMapillaryCurrentFov(fov);
    } catch {
        // Il field-of-view viene aggiornato appena MapillaryJS lo rende disponibile.
    }
}

async function syncMapillaryViewerToMap(image = null) {
    await syncMapillaryViewerImage(image);
    await syncMapillaryViewerFov();
    await syncMapillaryViewerPov();
    await syncMapillaryViewerPosition();
}

function bindMapillaryJsEvents() {
    if (!_mapillaryJsViewer || _mapillaryJsViewer._gpxSuiteEventsBound) return;
    _mapillaryJsViewer._gpxSuiteEventsBound = true;
    _mapillaryJsViewer.on('load', () => { syncMapillaryViewerToMap(); });
    _mapillaryJsViewer.on('image', event => { syncMapillaryViewerToMap(event?.image); });
    _mapillaryJsViewer.on('position', syncMapillaryViewerPosition);
    _mapillaryJsViewer.on('pov', syncMapillaryViewerPov);
    _mapillaryJsViewer.on('fov', syncMapillaryViewerFov);
    _mapillaryJsWindowResizeHandler = () => { syncMapillaryViewerFov(); };
    window.addEventListener('resize', _mapillaryJsWindowResizeHandler);
}

async function openMapillaryJsViewer(imageId) {
    const api = getMapillaryJsApi();
    if (!api?.Viewer) throw new Error('MapillaryJS non disponibile');

    const panel = document.getElementById('panel-mapillary-viewer');
    const jsContainer = document.getElementById('mapillary-js-viewer');
    const image = document.getElementById('mapillary-image');
    const placeholder = document.getElementById('mapillary-placeholder');
    if (!panel || !jsContainer) throw new Error('Container MapillaryJS non disponibile');

    panel.classList.remove('hidden');
    setMapillaryViewerOpen(true);
    jsContainer.classList.remove('hidden');
    image?.classList.add('hidden');
    placeholder?.classList.add('hidden');
    updateMapillaryViewerHeader(imageId);

    if (!_mapillaryJsViewer) {
        jsContainer.replaceChildren();
        _mapillaryJsViewer = new api.Viewer({
            accessToken: mapillaryToken.trim(),
            container: jsContainer,
            imageId: null,
            component: getMapillaryComponentOptions(),
            trackResize: true
        });
        bindMapillaryJsEvents();
        ensureMapillaryJsResizeObserver();
    } else if (typeof _mapillaryJsViewer.setAccessToken === 'function') {
        await _mapillaryJsViewer.setAccessToken(mapillaryToken.trim()).catch(() => {});
    }

    await _mapillaryJsViewer.moveTo(String(imageId));
    updateMapillaryViewerHeader(imageId);
    try {
        const image = await _mapillaryJsViewer.getImage();
        updateMapillaryCurrentMarker(
            getMapillaryImageLngLat(image),
            image?.id || imageId,
            getMapillaryImageBearing(image)
        );
    } catch {
        // L'evento `image` aggiornerà comunque il marker appena disponibile.
    }
    if (typeof _mapillaryJsViewer.resize === 'function') {
        _mapillaryJsViewer.resize();
    }
}

function formatMapillaryDate(value) {
    if (!value) return 'Data non disponibile';
    const date = new Date(Number(value));
    if (Number.isNaN(date.getTime())) return 'Data non disponibile';
    return date.toLocaleDateString('it-IT', { year: 'numeric', month: 'short', day: '2-digit' });
}

function stopMapillaryPlayback() {
    if (_mapillaryPlayTimer) {
        clearInterval(_mapillaryPlayTimer);
        _mapillaryPlayTimer = null;
    }
}

function setMapillarySequenceState(sequenceId, ids, imageId) {
    _mapillarySequenceId = sequenceId || null;
    _mapillarySequenceIds = Array.isArray(ids) ? ids.map(String) : [];
    _mapillaryCurrentIndex = _mapillarySequenceIds.indexOf(String(imageId));
}

async function fetchMapillarySequenceIds(sequenceId) {
    if (!sequenceId) return [];
    if (_mapillarySequenceCache.has(sequenceId)) return _mapillarySequenceCache.get(sequenceId);

    let url = `${MAPILLARY_GRAPH_URL}image_ids?sequence_id=${encodeURIComponent(sequenceId)}`;
    const ids = [];
    for (let page = 0; page < 8 && url; page++) {
        const response = await fetch(url, {
            headers: { Authorization: `OAuth ${mapillaryToken.trim()}` }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (Array.isArray(data.data)) {
            for (let i = 0; i < data.data.length; i++) {
                const id = data.data[i]?.id || data.data[i]?.image_id;
                if (id) ids.push(String(id));
            }
        }
        url = data.paging?.next || '';
    }

    _mapillarySequenceCache.set(sequenceId, ids);
    return ids;
}

async function loadMapillarySequence(sequenceId, imageId, requestSerial) {
    setMapillarySequenceState(sequenceId, [], imageId);
    if (!sequenceId) return;
    try {
        const ids = await fetchMapillarySequenceIds(sequenceId);
        if (requestSerial !== _mapillaryRequestSerial) return;
        setMapillarySequenceState(sequenceId, ids, imageId);
    } catch (err) {
        console.error('Errore sequenza Mapillary:', err);
        if (requestSerial === _mapillaryRequestSerial) {
            setMapillarySequenceState(sequenceId, [imageId], imageId);
        }
    }
}

function preloadMapillaryImage(imageUrl) {
    return new Promise((resolve, reject) => {
        const preload = new Image();
        preload.onload = () => resolve(imageUrl);
        preload.onerror = () => reject(new Error('Mapillary image preload failed'));
        preload.src = imageUrl;
    });
}

function setMapillaryPanelLoading(imageId, options = {}) {
    const panel = document.getElementById('panel-mapillary-viewer');
    if (!panel) return;
    panel.classList.remove('hidden');
    setMapillaryViewerOpen(true);
    document.getElementById('mapillary-js-viewer')?.classList.add('hidden');
    const image = document.getElementById('mapillary-image');
    const placeholder = document.getElementById('mapillary-placeholder');
    const keepCurrentVisible = options.keepCurrentVisible === true && image?.src && !image.classList.contains('hidden');

    if (keepCurrentVisible) {
        placeholder.classList.add('hidden');
    } else {
        image.classList.add('hidden');
        placeholder.classList.remove('hidden');
        placeholder.textContent = 'Caricamento immagine Mapillary...';
        document.getElementById('mapillary-title').textContent = `Mapillary ${imageId}`;
        document.getElementById('mapillary-date').textContent = '...';
        document.getElementById('mapillary-author').textContent = '';
        document.getElementById('mapillary-open-link').href = `https://www.mapillary.com/app/?pKey=${encodeURIComponent(imageId)}`;
        _mapillaryCurrentImageId = null;
        _mapillarySequenceId = null;
        _mapillarySequenceIds = [];
        _mapillaryCurrentIndex = -1;
    }
}

async function openMapillaryImageFallback(imageId, options = {}) {
    if (!requireAuth("Mapillary")) return;
    if (!hasMapillaryToken()) {
        showToast("Inserisci prima il token Mapillary.", "error");
        return;
    }
    if (!options.keepPlayback) stopMapillaryPlayback();

    const stringImageId = String(imageId);
    const keepCurrentVisible = _mapillarySequenceIds.includes(stringImageId) || options.keepPlayback === true;
    setMapillaryPanelLoading(stringImageId, { keepCurrentVisible });
    const requestSerial = ++_mapillaryRequestSerial;
    const fields = 'id,captured_at,thumb_1024_url,thumb_2048_url,computed_geometry,geometry,computed_compass_angle,compass_angle,creator,sequence';
    try {
        const response = await fetch(`${MAPILLARY_GRAPH_URL}${encodeURIComponent(imageId)}?fields=${fields}`, {
            headers: { Authorization: `OAuth ${mapillaryToken.trim()}` }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (requestSerial !== _mapillaryRequestSerial) return;
        const imageUrl = data.thumb_2048_url || data.thumb_1024_url;
        const image = document.getElementById('mapillary-image');
        const placeholder = document.getElementById('mapillary-placeholder');
        if (imageUrl) {
            await preloadMapillaryImage(imageUrl);
            if (requestSerial !== _mapillaryRequestSerial) return;
            image.src = imageUrl;
            image.alt = `Immagine Mapillary ${imageId}`;
            image.classList.remove('hidden');
            placeholder.classList.add('hidden');
            _mapillaryCurrentImageId = String(data.id || imageId);
            updateMapillaryCurrentMarker(data.computed_geometry || data.geometry, data.id || imageId, data.computed_compass_angle ?? data.compass_angle);
        } else {
            image.classList.add('hidden');
            placeholder.classList.remove('hidden');
            placeholder.textContent = 'Anteprima non disponibile per questa immagine.';
            _mapillaryCurrentImageId = String(data.id || imageId);
            updateMapillaryCurrentMarker(data.computed_geometry || data.geometry, data.id || imageId, data.computed_compass_angle ?? data.compass_angle);
        }
        document.getElementById('mapillary-title').textContent = `Mapillary ${data.id || imageId}`;
        document.getElementById('mapillary-date').textContent = formatMapillaryDate(data.captured_at);
        document.getElementById('mapillary-author').textContent = data.creator?.username ? `di ${data.creator.username}` : '';
        document.getElementById('mapillary-open-link').href = `https://www.mapillary.com/app/?pKey=${encodeURIComponent(data.id || imageId)}`;
        await loadMapillarySequence(data.sequence, String(data.id || imageId), requestSerial);
    } catch (err) {
        console.error('Errore Mapillary:', err);
        if (requestSerial !== _mapillaryRequestSerial) return;
        const placeholder = document.getElementById('mapillary-placeholder');
        if (keepCurrentVisible) {
            placeholder.classList.add('hidden');
        } else {
            document.getElementById('mapillary-image').classList.add('hidden');
            placeholder.classList.remove('hidden');
            placeholder.textContent = 'Impossibile caricare i dati Mapillary. Verifica token e rete.';
            setMapillarySequenceState(null, [], imageId);
        }
        showToast("Errore nel caricamento Mapillary", "error");
    }
}

async function openMapillaryImage(imageId, options = {}) {
    if (!requireAuth("Mapillary")) return;
    if (!hasMapillaryToken()) {
        showToast("Inserisci prima il token Mapillary.", "error");
        return;
    }

    if (!options.forceFallback && getMapillaryJsApi()?.Viewer) {
        try {
            stopMapillaryPlayback();
            await openMapillaryJsViewer(imageId);
            return;
        } catch (err) {
            console.error('Errore MapillaryJS:', err);
            showToast("Viewer Mapillary ufficiale non disponibile, uso anteprima base.", "info");
        }
    }

    await openMapillaryImageFallback(imageId, options);
}

export function configureMapillaryToken(token, options = {}) {
    const cleanToken = (token || '').trim();
    if (cleanToken && !options.allowUnauthenticated && !requireAuth("Mapillary")) {
        const input = document.getElementById('input-mapillary-token');
        if (input) input.value = '';
        return;
    }
    const previousToken = mapillaryToken;
    setMapillaryToken(cleanToken);
    if (previousToken !== cleanToken) {
        resetMapillaryJsViewer();
        clearMapillaryCurrentMarker();
    }
    if (cleanToken) {
        localStorage.setItem(MAPILLARY_TOKEN_KEY, cleanToken);
    } else {
        localStorage.removeItem(MAPILLARY_TOKEN_KEY);
        setIsMapillaryVisible(false);
    }

    if (mapLoaded) {
        if (map.getLayer('mapillary-images-layer')) map.removeLayer('mapillary-images-layer');
        if (map.getLayer('mapillary-sequences-layer')) map.removeLayer('mapillary-sequences-layer');
        if (map.getSource('mapillary-images')) map.removeSource('mapillary-images');
        setupMapillaryLayers();
        applyMapillaryLayerVisibility();
    }

    const input = document.getElementById('input-mapillary-token');
    if (input) input.value = cleanToken;
    const toggle = document.getElementById('toggle-mapillary');
    if (toggle) toggle.checked = isMapillaryVisible && hasMapillaryToken();
    schedulePersistAppSession();
}

export function setMapillaryCoverageVisible(visible, options = {}) {
    if (visible && !options.allowUnauthenticated && !requireAuth("Mapillary")) {
        const toggle = document.getElementById('toggle-mapillary');
        if (toggle) toggle.checked = false;
        return;
    }
    if (visible && !hasMapillaryToken()) {
        const toggle = document.getElementById('toggle-mapillary');
        if (toggle) toggle.checked = false;
        if (!options.silent) {
            showToast("Inserisci il client token Mapillary prima di attivare il layer.", "error");
        }
        return;
    }
    setIsMapillaryVisible(Boolean(visible));
    setupMapillaryLayers();
    applyMapillaryLayerVisibility();
    schedulePersistAppSession();
    if (!options.silent) {
        showToast(isMapillaryVisible ? "Copertura Mapillary visibile" : "Copertura Mapillary nascosta", "success");
    }
}

export function closeMapillaryViewer() {
    stopMapillaryPlayback();
    clearMapillaryCurrentMarker();
    setMapillaryViewerOpen(false);
    const panel = document.getElementById('panel-mapillary-viewer');
    if (panel) panel.classList.add('hidden');
}

function createBaseMapStyle(style, isHybrid) {
    const baseStyle = {
        version: 8,
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources: {},
        layers: []
    };

    if (style === 'sat') {
        baseStyle.sources['sat-raster'] = {
            type: 'raster',
            tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
            tileSize: 256,
            attribution: 'Tiles &copy; Esri'
        };
        baseStyle.layers.push({ id: 'sat-layer', type: 'raster', source: 'sat-raster' });

        if (isHybrid) {
            baseStyle.sources['hybrid-ref'] = {
                type: 'raster',
                tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
                tileSize: 256
            };
            baseStyle.layers.push({ id: 'hybrid-ref-layer', type: 'raster', source: 'hybrid-ref' });
        }
        return baseStyle;
    }

    if (style === 'topo') {
        baseStyle.sources['topo-raster'] = {
            type: 'raster',
            tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: 'Map data &copy; OpenTopoMap'
        };
        baseStyle.layers.push({ id: 'topo-layer', type: 'raster', source: 'topo-raster' });
        return baseStyle;
    }

    baseStyle.sources['osm-raster'] = {
        type: 'raster',
        tiles: ['https://a.tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: '&copy; OpenStreetMap contributors'
    };
    baseStyle.layers.push({ id: 'osm-layer', type: 'raster', source: 'osm-raster' });
    return baseStyle;
}

function setupStyleDependentLayers() {
    if (!map.getSource('terrain-nextzen')) {
        map.addSource('terrain-nextzen', {
            type: 'raster-dem',
            tiles: [NEXTZEN_TERRAIN_SOURCE],
            tileSize: 512,
            maxzoom: 14,
            encoding: 'terrarium'
        });
    }

    if (!map.getSource('waymarked-hiking')) {
        map.addSource('waymarked-hiking', {
            type: 'raster',
            tiles: ['https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png'],
            tileSize: 256
        });
    }

    if (!map.getLayer('hiking-trails-layer')) {
        const hikingToggle = document.getElementById('toggle-hiking-trails');
        map.addLayer({
            id: 'hiking-trails-layer',
            type: 'raster',
            source: 'waymarked-hiking',
            paint: { 'raster-opacity': 0.8 },
            layout: { visibility: hikingToggle?.checked ? 'visible' : 'none' }
        });
    }
}

function restoreApplicationLayersAfterStyleLoad(reloadSerial) {
    if (reloadSerial !== _styleReloadSerial) return;

    setupStyleDependentLayers();
    setupLayers();

    if (is3D && map.getSource('terrain-nextzen')) {
        map.setTerrain({ source: 'terrain-nextzen', exaggeration: 1.2 });
    }

    // Timeout necessario per aggirare la race condition di MapLibre WebWorker 
    // dove le chiamate a setData sincrone dopo addSource vengono scartate
    setTimeout(() => {
        if (reloadSerial === _styleReloadSerial) {
            updateMapData(true);
        }
    }, 50);
}

export function setBaseMap(style) {
    setCurrentStyle(style);
    if (!mapLoaded) return;

    const isHybrid = document.getElementById('toggle-hybrid').checked;
    const reloadSerial = ++_styleReloadSerial;

    map.once('style.load', () => restoreApplicationLayersAfterStyleLoad(reloadSerial));
    map.setStyle(createBaseMapStyle(style, isHybrid), { diff: false });

    ['osm', 'sat', 'topo'].forEach(s => {
        const el = document.getElementById(`map-style-${s}`);
        el.className = s === style ?
            "text-[10px] font-bold py-1.5 px-1 rounded-md text-center bg-blue-600 text-white transition-all" :
            "text-[10px] font-medium py-1.5 px-1 rounded-md text-center text-gray-400 hover:text-white transition-all";
    });

    document.getElementById('sat-options-container').className =
        style === 'sat' ? "pt-1.5 flex items-center justify-between" : "hidden";

    schedulePersistAppSession();
}

export function setDimensionMode(enable3D, options = {}) {
    if (enable3D && !options.allowUnauthenticated && !requireAuth("la vista 3D")) return;
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
        if (!options.preserveCamera) {
            map.easeTo({ pitch: 55, duration: 1000 });
        }
        if (!options.silent) {
            showToast("Terreno 3D attivato! Su PC usa Ctrl + trascinamento, su telefono trascina con due dita.", "info");
        }
    } else {
        map.setTerrain(null);
        map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
    }

    document.getElementById('view-mode-2d').className = !enable3D ?
        "text-xs font-medium py-1 px-2 rounded bg-blue-600 text-white" :
        "text-xs font-medium py-1 px-2 rounded text-gray-400 hover:text-white";
    document.getElementById('view-mode-3d').className = enable3D ?
        "text-xs font-medium py-1 px-2 rounded bg-blue-600 text-white" :
        "text-xs font-medium py-1 px-2 rounded text-gray-400 hover:text-white";

    schedulePersistAppSession();
}

export function flyToPOI(lon, lat, alt, pitch, bearing) {
    if (!mapLoaded) return;
    if (!requireAuth("la vista 3D")) return;
    setDimensionMode(true);
    map.flyTo({ center: [lon, lat], zoom: 12.5, pitch, bearing, duration: 3000 });
}

export async function queryElevation(lon, lat) {
    if (!mapLoaded) return 0;
    try {
        const ele = map.queryTerrainElevation([lon, lat]);
        if (Number.isFinite(ele) && Math.abs(ele) > 0.01) return Math.round(ele);
    } catch {}

    try {
        return await queryTerrariumElevation(lon, lat);
    } catch {
        return 0;
    }
}
