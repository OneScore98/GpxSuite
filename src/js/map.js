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
    is3D, setIs3D,
    currentStyle, setCurrentStyle,
    isMapillaryVisible, setIsMapillaryVisible,
    mapillaryToken, setMapillaryToken,
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
let _mapillaryInteractionsBound = false;
let _mapillaryViewerControlsBound = false;
let _mapillaryCurrentImageId = null;
let _mapillarySequenceId = null;
let _mapillarySequenceIds = [];
let _mapillaryCurrentIndex = -1;
let _mapillaryPlayTimer = null;
let _mapillaryRequestSerial = 0;
let _mapillaryJsViewer = null;
let _mapillaryJsResizeObserver = null;
let _mapillaryCurrentLngLat = null;
let _mapillaryCurrentBearing = 0;
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
    setupMapillaryLayers();

    map.addSource('box-delete-preview', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });

    map.addLayer({
        id: 'box-delete-preview-fill',
        type: 'fill',
        source: 'box-delete-preview',
        paint: {
            'fill-color': '#ef4444',
            'fill-opacity': 0.16
        }
    });

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

    // Switch LOD solo al termine del gesto (no lavoro durante pan/zoom inerziale)
    // `zoomend` scatta quando l'utente smette di interagire e la mappa è stabile.
    map.on('zoomend', () => applyLodToMap());

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
                coordinates: [[
                    [minLng, minLat],
                    [maxLng, minLat],
                    [maxLng, maxLat],
                    [minLng, maxLat],
                    [minLng, minLat]
                ]]
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
    return image?.lngLat
        || image?.computedLngLat
        || image?.originalLngLat
        || image?.computed_geometry
        || image?.computedGeometry
        || image?.geometry;
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
    const source = mapLoaded ? map.getSource('mapillary-current-image') : null;
    if (source) source.setData(buildMapillaryCurrentFeatureCollection());
}

function clearMapillaryCurrentMarker() {
    _mapillaryCurrentLngLat = null;
    _mapillaryCurrentBearing = 0;
    const source = mapLoaded ? map.getSource('mapillary-current-image') : null;
    if (source) source.setData(emptyMapillaryCurrentFeatureCollection());
}

function setupMapillaryLayers() {
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
                'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.2, 14, 3],
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
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2.5, 17, 5.5],
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
        attribution: true,
        bearing: true,
        cache: {
            depth: {
                sequence: 4,
                spherical: 2,
                step: 3,
                turn: 1
            }
        },
        cover: false,
        direction: true,
        fallback: {
            image: true,
            navigation: true
        },
        image: true,
        keyboard: true,
        marker: true,
        pointer: true,
        popup: true,
        sequence: {
            maxWidth: 180,
            minWidth: 96,
            playing: false,
            visible: true
        },
        slider: true,
        spatial: true,
        tag: true,
        zoom: true
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

function bindMapillaryJsEvents() {
    if (!_mapillaryJsViewer || _mapillaryJsViewer._gpxSuiteEventsBound) return;
    _mapillaryJsViewer._gpxSuiteEventsBound = true;
    _mapillaryJsViewer.on('image', async() => {
        try {
            const image = await _mapillaryJsViewer.getImage();
            updateMapillaryViewerHeader(image?.id || _mapillaryCurrentImageId);
            updateMapillaryCurrentMarker(
                getMapillaryImageLngLat(image),
                image?.id,
                getMapillaryImageBearing(image)
            );
        } catch {
            // MapillaryJS può emettere eventi intermedi durante il cambio immagine.
        }
    });
}

async function openMapillaryJsViewer(imageId) {
    const api = getMapillaryJsApi();
    if (!api?.Viewer) throw new Error('MapillaryJS non disponibile');

    const panel = document.getElementById('panel-mapillary-viewer');
    const jsContainer = document.getElementById('mapillary-js-viewer');
    const image = document.getElementById('mapillary-image');
    const placeholder = document.getElementById('mapillary-placeholder');
    const fallbackControls = document.getElementById('mapillary-fallback-controls');
    if (!panel || !jsContainer) throw new Error('Container MapillaryJS non disponibile');

    panel.classList.remove('hidden');
    setMapillaryViewerOpen(true);
    jsContainer.classList.remove('hidden');
    image?.classList.add('hidden');
    placeholder?.classList.add('hidden');
    fallbackControls?.classList.add('hidden');
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

function updateMapillaryPlayIcon() {
    const playBtn = document.getElementById('btn-mapillary-play');
    if (!playBtn) return;
    playBtn.innerHTML = _mapillaryPlayTimer
        ? '<i data-lucide="pause" class="w-4 h-4"></i>'
        : '<i data-lucide="play" class="w-4 h-4"></i>';
    playBtn.title = _mapillaryPlayTimer ? 'Metti in pausa' : 'Riproduci sequenza';
    if (window.lucide) window.lucide.createIcons();
}

function stopMapillaryPlayback() {
    if (_mapillaryPlayTimer) {
        clearInterval(_mapillaryPlayTimer);
        _mapillaryPlayTimer = null;
    }
    updateMapillaryPlayIcon();
}

function updateMapillaryControls() {
    const prevBtn = document.getElementById('btn-mapillary-prev');
    const nextBtn = document.getElementById('btn-mapillary-next');
    const playBtn = document.getElementById('btn-mapillary-play');
    const status = document.getElementById('mapillary-sequence-status');
    const total = _mapillarySequenceIds.length;
    const hasSequence = total > 1 && _mapillaryCurrentIndex >= 0;

    if (prevBtn) prevBtn.disabled = !hasSequence || _mapillaryCurrentIndex <= 0;
    if (nextBtn) nextBtn.disabled = !hasSequence || _mapillaryCurrentIndex >= total - 1;
    if (playBtn) playBtn.disabled = !hasSequence;

    if (status) {
        if (!_mapillarySequenceId) {
            status.textContent = 'Sequenza non disponibile';
        } else if (total === 0) {
            status.textContent = 'Caricamento sequenza...';
        } else if (!hasSequence) {
            status.textContent = 'Singola foto';
        } else {
            status.textContent = `${_mapillaryCurrentIndex + 1} / ${total}`;
        }
    }
    updateMapillaryPlayIcon();
}

function bindMapillaryViewerControls() {
    if (_mapillaryViewerControlsBound) return;
    _mapillaryViewerControlsBound = true;

    document.getElementById('btn-mapillary-prev')?.addEventListener('click', () => {
        stopMapillaryPlayback();
        openMapillarySequenceOffset(-1);
    });
    document.getElementById('btn-mapillary-next')?.addEventListener('click', () => {
        stopMapillaryPlayback();
        openMapillarySequenceOffset(1);
    });
    document.getElementById('btn-mapillary-play')?.addEventListener('click', toggleMapillaryPlayback);
}

function openMapillarySequenceOffset(offset, options = {}) {
    const nextIndex = _mapillaryCurrentIndex + offset;
    if (nextIndex < 0 || nextIndex >= _mapillarySequenceIds.length) {
        if (_mapillaryPlayTimer) stopMapillaryPlayback();
        return;
    }
    openMapillaryImage(_mapillarySequenceIds[nextIndex], { keepPlayback: options.keepPlayback === true });
}

function toggleMapillaryPlayback() {
    if (_mapillaryPlayTimer) {
        stopMapillaryPlayback();
        return;
    }
    if (_mapillarySequenceIds.length < 2 || _mapillaryCurrentIndex < 0) return;
    _mapillaryPlayTimer = setInterval(() => {
        if (_mapillaryCurrentIndex >= _mapillarySequenceIds.length - 1) {
            stopMapillaryPlayback();
            return;
        }
        openMapillarySequenceOffset(1, { keepPlayback: true });
    }, 1600);
    updateMapillaryPlayIcon();
}

function setMapillarySequenceState(sequenceId, ids, imageId) {
    _mapillarySequenceId = sequenceId || null;
    _mapillarySequenceIds = Array.isArray(ids) ? ids.map(String) : [];
    _mapillaryCurrentIndex = _mapillarySequenceIds.indexOf(String(imageId));
    updateMapillaryControls();
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
    bindMapillaryViewerControls();
    panel.classList.remove('hidden');
    setMapillaryViewerOpen(true);
    document.getElementById('mapillary-js-viewer')?.classList.add('hidden');
    document.getElementById('mapillary-fallback-controls')?.classList.remove('hidden');
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
    updateMapillaryControls();
    if (keepCurrentVisible) {
        const status = document.getElementById('mapillary-sequence-status');
        if (status) status.textContent = 'Caricamento foto...';
    }
}

async function openMapillaryImageFallback(imageId, options = {}) {
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
            updateMapillaryControls();
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

export function configureMapillaryToken(token) {
    const cleanToken = (token || '').trim();
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

        setupLayers();

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
