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
import { updateStatsAndProfile, haversineDistance } from './stats.js';
import { setupWaypointLayers, updateWaypointsOnMap, bindWaypointInteractions, refreshPinImages } from './waypoints.js';
import { schedulePersistAppSession, schedulePersistTracks } from './storage.js';
import { loadScriptOnce, loadStylesheetOnce } from './utils.js';

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
            if (d > dmax) {
                dmax = d;
                index = i;
            }
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
let _mapillaryAssetsPromise = null;
let _mapillaryCurrentLngLat = null;
let _mapillaryCurrentBearing = 0;
let _mapillaryCurrentFov = 70;
let _trackInteractionsBound = false;
let _lodInteractionsBound = false;
let _coloredTrackMode = null; // null | 'altitude' | 'speed' | 'slope' | 'tilt' | 'vibration'
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
    'gpx-lines-colored-layer',
    'box-delete-preview-fill',
    'box-delete-preview-line',
    'gpx-waypoints-cluster-halo-layer',
    'gpx-waypoints-cluster-layer',
    'gpx-waypoints-cluster-count-layer',
    'gpx-waypoints-hit-layer',
    'gpx-waypoints-marker-layer',
    'gpx-waypoints-label-layer',
    'gpx-edit-points-layer',
    'chart-hover-marker-halo',
    'chart-hover-marker-dot',
    'mapillary-current-fov-fill-layer',
    'mapillary-current-fov-line-layer',
    'mapillary-current-image-halo-layer',
    'mapillary-current-image-layer',
    'mapillary-current-image-direction-layer',
    // Localizzazione dispositivo: sempre sopra tutto il resto
    'device-location-halo-layer',
    'device-location-heading-layer',
    'device-location-dot-layer'
];

// Hook opzionale richiamato dopo ogni style.load per permettere ai moduli
// che gestiscono overlay live (registrazione, localizzazione) di ricreare
// sorgenti/layer perduti durante il cambio basemap.
let _onStyleRestoredHook = null;
export function setStyleRestoredHook(handler) {
    _onStyleRestoredHook = typeof handler === 'function' ? handler : null;
}
const MAPILLARY_JS_URL = 'https://unpkg.com/mapillary-js@4.1.2/dist/mapillary.js';
const MAPILLARY_CSS_URL = 'https://unpkg.com/mapillary-js@4.1.2/dist/mapillary.css';
const BASE_MAP_STYLES = ['osm', 'sat', 'topo', 'acqua', 'outdoor'];

function normalizeBaseMapStyle(style) {
    return BASE_MAP_STYLES.includes(style) ? style : 'osm';
}

function createHydroBaseMapStyle() {
    return {
        version: 8,
        sprite: 'https://tiles.openfreemap.org/sprites/ofm_f384/ofm',
        glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
        sources: {
            'idro-shaded': {
                type: 'raster',
                tiles: ['https://tiles.openfreemap.org/natural_earth/ne2sr/{z}/{x}/{y}.png'],
                tileSize: 256,
                maxzoom: 6
            },
            'openmaptiles': {
                type: 'vector',
                url: 'https://tiles.openfreemap.org/planet'
            }
        },
        layers: [
            {
                id: 'idro-background',
                type: 'background',
                paint: { 'background-color': '#f7f4ec' }
            },
            {
                id: 'idro-shaded',
                type: 'raster',
                source: 'idro-shaded',
                maxzoom: 7,
                paint: {
                    'raster-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.14, 6, 0.03],
                    'raster-saturation': -0.25
                }
            },
            {
                id: 'idro-landuse-residential',
                type: 'fill',
                source: 'openmaptiles',
                'source-layer': 'landuse',
                filter: ['match', ['get', 'class'], ['residential', 'neighbourhood', 'suburb'], true, false],
                paint: { 'fill-color': '#efe7dd', 'fill-opacity': 0.52 }
            },
            {
                id: 'idro-landuse-muted',
                type: 'fill',
                source: 'openmaptiles',
                'source-layer': 'landuse',
                filter: ['match', ['get', 'class'], ['commercial', 'industrial', 'railway', 'school', 'hospital'], true, false],
                paint: {
                    'fill-color': ['match', ['get', 'class'],
                        ['commercial'], '#f0d8d6',
                        ['industrial', 'railway'], '#eadfb9',
                        ['school'], '#ece8bd',
                        ['hospital'], '#f4d8e8',
                        '#e8dfd4'
                    ],
                    'fill-opacity': 0.48
                }
            },
            {
                id: 'idro-landuse-agricultural',
                type: 'fill',
                source: 'openmaptiles',
                'source-layer': 'landuse',
                filter: ['match', ['get', 'class'], ['farmland', 'farm', 'orchard', 'vineyard', 'meadow', 'allotments'], true, false],
                paint: {
                    'fill-color': ['match', ['get', 'class'],
                        ['orchard', 'vineyard'], '#d8d99a',
                        ['meadow'], '#cfe6b2',
                        '#e6dcae'
                    ],
                    'fill-opacity': 0.5
                }
            },
            {
                id: 'idro-park',
                type: 'fill',
                source: 'openmaptiles',
                'source-layer': 'park',
                filter: ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false],
                paint: { 'fill-color': '#cfe8bd', 'fill-opacity': 0.58 }
            },
            {
                id: 'idro-landcover-wood',
                type: 'fill',
                source: 'openmaptiles',
                'source-layer': 'landcover',
                filter: ['==', ['get', 'class'], 'wood'],
                paint: { 'fill-color': '#9ecb82', 'fill-opacity': 0.58 }
            },
            {
                id: 'idro-landcover-grass',
                type: 'fill',
                source: 'openmaptiles',
                'source-layer': 'landcover',
                filter: ['==', ['get', 'class'], 'grass'],
                paint: { 'fill-color': '#d3e9bd', 'fill-opacity': 0.62 }
            },
            {
                id: 'idro-landcover-sand',
                type: 'fill',
                source: 'openmaptiles',
                'source-layer': 'landcover',
                filter: ['==', ['get', 'class'], 'sand'],
                paint: { 'fill-color': '#f2df92', 'fill-opacity': 0.72 }
            },
            {
                id: 'idro-landcover-earth',
                type: 'fill',
                source: 'openmaptiles',
                'source-layer': 'landcover',
                filter: ['match', ['get', 'class'], ['scrub', 'heath', 'bare_rock', 'rock', 'scree'], true, false],
                paint: {
                    'fill-color': ['match', ['get', 'class'],
                        ['scrub', 'heath'], '#c8d59a',
                        '#d7c2a2'
                    ],
                    'fill-opacity': 0.54
                }
            },
            {
                id: 'idro-landcover-wetland',
                type: 'fill',
                source: 'openmaptiles',
                'source-layer': 'landcover',
                filter: ['==', ['get', 'class'], 'wetland'],
                paint: { 'fill-color': '#bcdcc7', 'fill-opacity': 0.54 }
            },
            {
                id: 'idro-building',
                type: 'fill',
                source: 'openmaptiles',
                'source-layer': 'building',
                minzoom: 14,
                paint: {
                    'fill-color': '#ded8cf',
                    'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0.22, 17, 0.42],
                    'fill-outline-color': 'rgba(156, 148, 136, 0.28)'
                }
            },
            {
                id: 'idro-road-major-casing',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'transportation',
                filter: ['all',
                    ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false],
                    ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'], true, false],
                    ['!=', ['get', 'brunnel'], 'tunnel']
                ],
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: {
                    'line-color': '#d1d2ca',
                    'line-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.22, 13, 0.46],
                    'line-width': ['interpolate', ['exponential', 1.2], ['zoom'], 6, 0.5, 12, 2.5, 18, 11]
                }
            },
            {
                id: 'idro-road-major',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'transportation',
                filter: ['all',
                    ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false],
                    ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'], true, false],
                    ['!=', ['get', 'brunnel'], 'tunnel']
                ],
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: {
                    'line-color': '#f5f4ee',
                    'line-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.18, 13, 0.54],
                    'line-width': ['interpolate', ['exponential', 1.2], ['zoom'], 7, 0.25, 12, 1.4, 18, 7]
                }
            },
            {
                id: 'idro-road-minor',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'transportation',
                minzoom: 12,
                filter: ['all',
                    ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false],
                    ['match', ['get', 'class'], ['minor', 'service', 'track', 'path'], true, false],
                    ['!=', ['get', 'brunnel'], 'tunnel']
                ],
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: {
                    'line-color': '#f7f7f2',
                    'line-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0.16, 16, 0.42],
                    'line-width': ['interpolate', ['exponential', 1.25], ['zoom'], 12, 0.25, 16, 2.5, 20, 8]
                }
            },
            {
                id: 'idro-boundary',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'boundary',
                filter: ['all', ['!=', ['get', 'maritime'], 1], ['<=', ['get', 'admin_level'], 4]],
                paint: {
                    'line-color': '#b9bab3',
                    'line-opacity': 0.34,
                    'line-dasharray': [1.5, 2],
                    'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.6, 10, 1.4]
                }
            },
            {
                id: 'idro-water-glow',
                type: 'fill',
                source: 'openmaptiles',
                'source-layer': 'water',
                filter: ['!=', ['get', 'brunnel'], 'tunnel'],
                paint: {
                    'fill-color': '#d9f6ff',
                    'fill-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.72, 12, 0.42]
                }
            },
            {
                id: 'idro-water',
                type: 'fill',
                source: 'openmaptiles',
                'source-layer': 'water',
                filter: ['all', ['!=', ['get', 'brunnel'], 'tunnel'], ['!=', ['get', 'intermittent'], 1]],
                paint: {
                    'fill-color': ['match', ['get', 'class'],
                        ['river'], '#65c7f4',
                        ['lake', 'reservoir'], '#91dcff',
                        ['ocean', 'sea'], '#b8ecff',
                        '#a3e1ff'
                    ],
                    'fill-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.86, 13, 0.94]
                }
            },
            {
                id: 'idro-water-intermittent',
                type: 'fill',
                source: 'openmaptiles',
                'source-layer': 'water',
                filter: ['==', ['get', 'intermittent'], 1],
                paint: { 'fill-color': '#bfeaff', 'fill-opacity': 0.48 }
            },
            {
                id: 'idro-water-outline',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'water',
                filter: ['!=', ['get', 'brunnel'], 'tunnel'],
                paint: {
                    'line-color': '#45b6ea',
                    'line-opacity': 0,
                    'line-width': ['interpolate', ['exponential', 1.2], ['zoom'], 7, 0.25, 14, 1.2, 18, 2.4]
                }
            },
            {
                // Fiumi — glow nascosto: ridondante sui fiumi con fill poligonale
                id: 'idro-waterway-river-glow',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'waterway',
                filter: ['all', ['==', ['get', 'class'], 'river'], ['!=', ['get', 'brunnel'], 'tunnel']],
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: {
                    'line-color': '#b8e8fa',
                    'line-opacity': 0,
                    'line-width': ['interpolate', ['exponential', 1.2], ['zoom'], 4, 2, 7, 6, 10, 14, 14, 22, 19, 32]
                }
            },
            {
                // Fiumi — halo nascosto: ridondante sui fiumi con fill poligonale
                id: 'idro-waterway-river-halo',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'waterway',
                filter: ['all', ['==', ['get', 'class'], 'river'], ['!=', ['get', 'brunnel'], 'tunnel']],
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: {
                    'line-color': '#5ab8e8',
                    'line-opacity': 0,
                    'line-width': ['interpolate', ['exponential', 1.2], ['zoom'], 4, 1, 7, 3.5, 10, 8, 14, 14, 19, 22]
                }
            },
            {
                id: 'idro-waterway-river-intermittent',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'waterway',
                filter: ['all', ['==', ['get', 'class'], 'river'], ['!=', ['get', 'brunnel'], 'tunnel'], ['==', ['get', 'intermittent'], 1]],
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: {
                    'line-color': '#0565a8',
                    'line-dasharray': [3, 2.2],
                    'line-opacity': 0.7,
                    'line-width': ['interpolate', ['exponential', 1.2], ['zoom'], 7, 0.25, 13, 2.8, 19, 5.5]
                }
            },
            {
                // Canali — blu medio/reale, visibili da zoom 5
                id: 'idro-waterway-canal-glow',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'waterway',
                minzoom: 5,
                filter: ['all', ['==', ['get', 'class'], 'canal'], ['!=', ['get', 'brunnel'], 'tunnel']],
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: {
                    'line-color': '#b2e0f7',
                    'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.38, 10, 0.62, 14, 0.86],
                    'line-width': ['interpolate', ['exponential', 1.25], ['zoom'], 5, 0.3, 8, 0.75, 14, 7, 19, 14]
                }
            },
            {
                id: 'idro-waterway-canal-core',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'waterway',
                minzoom: 5,
                filter: ['all', ['==', ['get', 'class'], 'canal'], ['!=', ['get', 'brunnel'], 'tunnel']],
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: {
                    'line-color': '#1480c2',
                    'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.48, 10, 0.68, 14, 0.92],
                    'line-width': ['interpolate', ['exponential', 1.25], ['zoom'], 5, 0.12, 8, 0.28, 14, 2.8, 19, 5.8]
                }
            },
            {
                // Torrenti/ruscelli — azzurro vivo, visibili da zoom 7
                id: 'idro-waterway-stream-glow',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'waterway',
                minzoom: 7,
                filter: ['all', ['==', ['get', 'class'], 'stream'], ['!=', ['get', 'brunnel'], 'tunnel']],
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: {
                    'line-color': '#caeffe',
                    'line-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0.32, 11, 0.58, 15, 0.88],
                    'line-width': ['interpolate', ['exponential', 1.25], ['zoom'], 7, 0.25, 10, 0.55, 15, 4.5, 19, 9]
                }
            },
            {
                id: 'idro-waterway-stream-core',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'waterway',
                minzoom: 7,
                filter: ['all', ['==', ['get', 'class'], 'stream'], ['!=', ['get', 'brunnel'], 'tunnel'], ['!=', ['get', 'intermittent'], 1]],
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: {
                    'line-color': '#1aace0',
                    'line-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0.44, 11, 0.68, 15, 0.94],
                    'line-width': ['interpolate', ['exponential', 1.25], ['zoom'], 7, 0.1, 10, 0.22, 15, 1.8, 19, 3.8]
                }
            },
            {
                id: 'idro-waterway-stream-intermittent',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'waterway',
                minzoom: 7.5,
                filter: ['all', ['==', ['get', 'class'], 'stream'], ['!=', ['get', 'brunnel'], 'tunnel'], ['==', ['get', 'intermittent'], 1]],
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: {
                    'line-color': '#1aace0',
                    'line-dasharray': [2, 2],
                    'line-opacity': 0.58,
                    'line-width': ['interpolate', ['exponential', 1.25], ['zoom'], 7.5, 0.1, 10, 0.2, 15, 1.6, 19, 3.3]
                }
            },
            {
                // Fossi e canali minori — azzurro chiaro/turchese, visibili da zoom 8
                id: 'idro-waterway-minor-glow',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'waterway',
                minzoom: 8,
                filter: ['all', ['match', ['get', 'class'], ['ditch', 'drain'], true, false], ['!=', ['get', 'brunnel'], 'tunnel']],
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: {
                    'line-color': '#c6f4f4',
                    'line-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0.32, 12, 0.56, 15, 0.80],
                    'line-width': ['interpolate', ['exponential', 1.25], ['zoom'], 8, 0.22, 11, 0.42, 15, 3.7, 19, 7.2]
                }
            },
            {
                id: 'idro-waterway-minor-core',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'waterway',
                minzoom: 8,
                filter: ['all', ['match', ['get', 'class'], ['ditch', 'drain'], true, false], ['!=', ['get', 'brunnel'], 'tunnel'], ['!=', ['get', 'intermittent'], 1]],
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: {
                    'line-color': '#28c0cc',
                    'line-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0.42, 12, 0.62, 15, 0.88],
                    'line-width': ['interpolate', ['exponential', 1.25], ['zoom'], 8, 0.08, 11, 0.16, 15, 1.25, 19, 2.9]
                }
            },
            {
                id: 'idro-waterway-minor-intermittent',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'waterway',
                minzoom: 8.5,
                filter: ['all', ['match', ['get', 'class'], ['ditch', 'drain'], true, false], ['!=', ['get', 'brunnel'], 'tunnel'], ['==', ['get', 'intermittent'], 1]],
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: {
                    'line-color': '#28c0cc',
                    'line-dasharray': [1.6, 1.8],
                    'line-opacity': 0.52,
                    'line-width': ['interpolate', ['exponential', 1.25], ['zoom'], 8.5, 0.08, 11, 0.16, 15, 1.1, 19, 2.6]
                }
            },
            {
                id: 'idro-waterway-tunnel',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'waterway',
                minzoom: 12,
                filter: ['==', ['get', 'brunnel'], 'tunnel'],
                paint: {
                    'line-color': '#4db9e8',
                    'line-dasharray': [1.5, 2.5],
                    'line-opacity': 0.52,
                    'line-width': ['interpolate', ['exponential', 1.2], ['zoom'], 12, 0.5, 18, 4]
                }
            },
            {
                // Ponti — bordo bianco (outline, stile classico stradale)
                id: 'idro-bridge-casing',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'transportation',
                filter: ['all',
                    ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false],
                    ['==', ['get', 'brunnel'], 'bridge']
                ],
                layout: { 'line-cap': 'butt', 'line-join': 'round' },
                paint: {
                    'line-color': '#c8bfb0',
                    'line-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.85, 14, 1.0],
                    'line-width': ['interpolate', ['exponential', 1.2], ['zoom'], 10, 4.5, 12, 9, 16, 22]
                }
            },
            {
                // Ponti — superficie stradale (stesso colore delle strade normali)
                id: 'idro-bridge-road',
                type: 'line',
                source: 'openmaptiles',
                'source-layer': 'transportation',
                filter: ['all',
                    ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false],
                    ['==', ['get', 'brunnel'], 'bridge']
                ],
                layout: { 'line-cap': 'butt', 'line-join': 'round' },
                paint: {
                    'line-color': '#f5f4ee',
                    'line-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.95, 14, 1.0],
                    'line-width': ['interpolate', ['exponential', 1.2], ['zoom'], 10, 2.5, 12, 6, 16, 16]
                }
            },
            {
                // POI importanti visibili già da zoom 10 (porto, traghetto, picnic, ristorante, rifugio, panorama)
                id: 'idro-river-poi-lowzoom',
                type: 'symbol',
                source: 'openmaptiles',
                'source-layer': 'poi',
                minzoom: 10,
                maxzoom: 14,
                filter: ['all',
                    ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false],
                    ['match', ['get', 'subclass'], [
                        'ferry_terminal', 'ferry',
                        'marina', 'harbor', 'boat_rental',
                        'picnic_site', 'bbq',
                        'viewpoint',
                        'camp_site', 'campsite',
                        'shelter',
                        'restaurant', 'cafe',
                        'drinking_water',
                        'information'
                    ], true, false]
                ],
                layout: {
                    'icon-image': ['match', ['get', 'subclass'],
                        ['ferry_terminal', 'ferry'], 'ferry',
                        ['marina', 'boat_rental', 'harbor'], 'harbor',
                        ['picnic_site', 'bbq'], 'picnic_site',
                        ['viewpoint'], 'mountain',
                        ['camp_site', 'campsite'], 'campsite',
                        ['shelter'], 'shelter',
                        ['restaurant'], 'restaurant',
                        ['cafe'], 'cafe',
                        ['drinking_water'], 'drinking_water',
                        ['information'], 'information',
                        'circle'
                    ],
                    'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.9, 12, 1.1, 14, 1.3],
                    'icon-allow-overlap': false,
                    'icon-ignore-placement': false,
                    'icon-padding': 2,
                    'text-field': ''
                },
                paint: {
                    'icon-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.9, 13, 1.0]
                }
            },
            {
                id: 'idro-river-poi',
                type: 'symbol',
                source: 'openmaptiles',
                'source-layer': 'poi',
                minzoom: 14,
                filter: ['all',
                    ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false],
                    ['match', ['get', 'subclass'], [
                        'waterfall',
                        'spring',
                        'viewpoint',
                        'picnic_site',
                        'camp_site',
                        'campsite',
                        'bbq',
                        'information',
                        'drinking_water',
                        'ferry_terminal',
                        'ferry',
                        'marina',
                        'boat_rental',
                        'harbor',
                        'swimming',
                        'toilets',
                        'parking',
                        'restaurant',
                        'cafe',
                        'bar'
                    ], true, false]
                ],
                layout: {
                    'icon-image': ['match', ['get', 'subclass'],
                        ['waterfall', 'spring'], 'water',
                        ['viewpoint'], 'mountain',
                        ['picnic_site', 'bbq'], 'picnic_site',
                        ['camp_site', 'campsite'], 'campsite',
                        ['information'], 'information',
                        ['drinking_water'], 'drinking_water',
                        ['ferry_terminal', 'ferry'], 'ferry',
                        ['marina', 'boat_rental', 'harbor'], 'harbor',
                        ['swimming'], 'swimming',
                        ['toilets'], 'toilets',
                        ['parking'], 'parking',
                        ['restaurant'], 'restaurant',
                        ['cafe'], 'cafe',
                        ['bar'], 'bar',
                        'circle'
                    ],
                    'icon-size': ['interpolate', ['linear'], ['zoom'], 14, 1.1, 17, 1.4],
                    'icon-padding': 2,
                    'icon-allow-overlap': false,
                    'text-anchor': 'top',
                    'text-field': ['step', ['zoom'], '', 16, ['coalesce', ['get', 'name:it'], ['get', 'name'], ['get', 'name_en']]],
                    'text-font': ['Noto Sans Regular'],
                    'text-max-width': 8,
                    'text-offset': [0, 0.75],
                    'text-optional': true,
                    'text-size': ['interpolate', ['linear'], ['zoom'], 16, 10, 18, 11]
                },
                paint: {
                    'icon-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0.72, 16, 0.9],
                    'text-color': '#53615b',
                    'text-halo-color': 'rgba(247, 244, 236, 0.92)',
                    'text-halo-width': 1.2
                }
            },
            {
                // POI standard: distributori, supermercati, farmacie, ospedali, scuole, banche, ecc.
                id: 'idro-standard-poi',
                type: 'symbol',
                source: 'openmaptiles',
                'source-layer': 'poi',
                minzoom: 14,
                filter: ['all',
                    ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false],
                    ['match', ['get', 'subclass'], [
                        'fuel',
                        'supermarket',
                        'convenience',
                        'pharmacy',
                        'hospital',
                        'clinic',
                        'doctors',
                        'dentist',
                        'school',
                        'kindergarten',
                        'college',
                        'university',
                        'bank',
                        'atm',
                        'post_office',
                        'fire_station',
                        'police',
                        'fast_food',
                        'hotel',
                        'hostel',
                        'motel',
                        'guest_house',
                        'museum',
                        'cinema',
                        'theatre',
                        'bicycle_rental',
                        'hairdresser',
                        'laundry',
                        'bakery',
                        'butcher',
                        'clothes',
                        'playground',
                        'shelter',
                        'lighthouse',
                        'place_of_worship',
                        'church',
                        'mosque',
                        'synagogue'
                    ], true, false]
                ],
                layout: {
                    'icon-image': ['match', ['get', 'subclass'],
                        ['fuel'], 'fuel',
                        ['supermarket', 'convenience'], 'grocery',
                        ['pharmacy'], 'pharmacy',
                        ['hospital', 'clinic', 'doctors'], 'hospital',
                        ['dentist'], 'dentist',
                        ['school', 'kindergarten', 'college', 'university'], 'school',
                        ['bank', 'atm'], 'bank',
                        ['post_office'], 'post',
                        ['fire_station'], 'fire_station',
                        ['police'], 'police',
                        ['fast_food'], 'fast_food',
                        ['hotel', 'hostel', 'motel', 'guest_house'], 'lodging',
                        ['museum'], 'museum',
                        ['cinema'], 'cinema',
                        ['theatre'], 'theatre',
                        ['bicycle_rental'], 'bicycle_rental',
                        ['hairdresser'], 'hairdresser',
                        ['laundry'], 'laundry',
                        ['bakery'], 'bakery',
                        ['butcher'], 'butcher',
                        ['clothes'], 'clothing_store',
                        ['playground'], 'playground',
                        ['shelter'], 'shelter',
                        ['lighthouse'], 'lighthouse',
                        ['place_of_worship', 'church'], 'place_of_worship',
                        ['mosque'], 'religious_muslim',
                        ['synagogue'], 'religious_jewish',
                        'circle'
                    ],
                    'icon-size': ['interpolate', ['linear'], ['zoom'], 14, 1.0, 17, 1.3],
                    'icon-padding': 2,
                    'icon-allow-overlap': false,
                    'text-anchor': 'top',
                    'text-field': ['step', ['zoom'], '', 16, ['coalesce', ['get', 'name:it'], ['get', 'name'], ['get', 'name_en']]],
                    'text-font': ['Noto Sans Regular'],
                    'text-max-width': 8,
                    'text-offset': [0, 0.75],
                    'text-optional': true,
                    'text-size': ['interpolate', ['linear'], ['zoom'], 16, 10, 18, 11]
                },
                paint: {
                    'icon-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0.68, 16, 0.88],
                    'text-color': '#53615b',
                    'text-halo-color': 'rgba(247, 244, 236, 0.92)',
                    'text-halo-width': 1.2
                }
            },
            {
                id: 'idro-road-label',
                type: 'symbol',
                source: 'openmaptiles',
                'source-layer': 'transportation_name',
                minzoom: 13,
                filter: ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false],
                layout: {
                    'symbol-placement': 'line',
                    'text-field': ['coalesce', ['get', 'name'], ['get', 'ref']],
                    'text-font': ['Noto Sans Regular'],
                    'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 17, 12],
                    'text-rotation-alignment': 'map'
                },
                paint: {
                    'text-color': '#8b8d86',
                    'text-opacity': 0.48,
                    'text-halo-color': '#eef2ef',
                    'text-halo-width': 1
                }
            },
            {
                id: 'idro-place-label',
                type: 'symbol',
                source: 'openmaptiles',
                'source-layer': 'place',
                filter: ['match', ['get', 'class'], ['city', 'town', 'village', 'state', 'country'], true, false],
                layout: {
                    'text-field': ['coalesce', ['get', 'name:it'], ['get', 'name'], ['get', 'name_en']],
                    'text-font': ['Noto Sans Regular'],
                    'text-size': ['interpolate', ['linear'], ['zoom'], 3, 10, 8, 13, 13, 16],
                    'text-max-width': 8
                },
                paint: {
                    'text-color': '#61655f',
                    'text-opacity': ['interpolate', ['linear'], ['zoom'], 3, 0.48, 12, 0.68],
                    'text-halo-color': '#eef2ef',
                    'text-halo-width': 1.2
                }
            },
            {
                id: 'idro-waterway-label',
                type: 'symbol',
                source: 'openmaptiles',
                'source-layer': 'waterway',
                minzoom: 9,
                filter: ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false],
                layout: {
                    'symbol-placement': 'line',
                    'symbol-spacing': 280,
                    'text-field': ['coalesce', ['get', 'name:it'], ['get', 'name'], ['get', 'name_en']],
                    'text-font': ['Noto Sans Italic'],
                    'text-size': ['interpolate', ['linear'], ['zoom'], 9, 11, 12, 13, 15, 16],
                    'text-max-width': 8
                },
                paint: {
                    'text-color': '#1a5f8a',
                    'text-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.8, 11, 1.0],
                    'text-halo-color': 'rgba(240, 248, 255, 0.96)',
                    'text-halo-width': 2.0
                }
            },
            {
                id: 'idro-water-name-point-label',
                type: 'symbol',
                source: 'openmaptiles',
                'source-layer': 'water_name',
                filter: ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false],
                layout: {
                    'text-field': ['coalesce', ['get', 'name:it'], ['get', 'name'], ['get', 'name_en']],
                    'text-font': ['Noto Sans Italic'],
                    'text-size': ['interpolate', ['linear'], ['zoom'], 5, 10, 12, 15],
                    'text-max-width': 7
                },
                paint: {
                    'text-color': '#075f99',
                    'text-halo-color': 'rgba(236, 251, 255, 0.92)',
                    'text-halo-width': 1.7
                }
            },
            {
                id: 'idro-water-name-line-label',
                type: 'symbol',
                source: 'openmaptiles',
                'source-layer': 'water_name',
                filter: ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false],
                layout: {
                    'symbol-placement': 'line',
                    'symbol-spacing': 360,
                    'text-field': ['coalesce', ['get', 'name:it'], ['get', 'name'], ['get', 'name_en']],
                    'text-font': ['Noto Sans Italic'],
                    'text-size': ['interpolate', ['linear'], ['zoom'], 5, 10, 12, 15],
                    'text-max-width': 7
                },
                paint: {
                    'text-color': '#075f99',
                    'text-halo-color': 'rgba(236, 251, 255, 0.92)',
                    'text-halo-width': 1.7
                }
            }
        ]
    };
}

function createOutdoorBaseMapStyle() {
    const style = createHydroBaseMapStyle();
    style.sources['outdoor-topo-raster'] = {
        type: 'raster',
        tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 17,
        attribution: 'Map data &copy; OpenTopoMap'
    };

    const colorePistaOsmAnd = ['step', ['zoom'], '#663300', 13, '#996600'];
    const coloreCheminOsmAnd = ['step', ['zoom'], '#558855', 14, '#008800'];
    const coloreSentierOsmAnd = ['step', ['zoom'], '#444444', 15, '#000000'];
    const coloreDivietoOsmAnd = '#ff3333';
    const larghezzaPistaOsmAnd = ['interpolate', ['linear'], ['zoom'], 9, 0.6, 10, 0.9, 12, 1.25, 13, 1.5, 14, 2, 15, 2.5, 16, 3, 17, 3.5, 18, 4];
    const larghezzaCheminOsmAnd = ['interpolate', ['linear'], ['zoom'], 9, 0.65, 10, 0.95, 12, 1.25, 13, 1.5, 14, 2, 15, 2.5, 16, 3, 17, 3.5, 18, 4];
    const larghezzaSentierOsmAnd = ['interpolate', ['linear'], ['zoom'], 10, 0.5, 12, 0.8, 13, 1, 14, 1.5, 15, 1.75, 16, 2, 17, 2.25, 18, 2.5];
    // Tratteggi per categoria — usare con line-cap:'butt' (non 'round')
    // Con cap round i cap arrotondati riempiono i gap e il tratteggio sparisce
    const trattinoPistaOsmAnd = [7, 4];     // rough: dash lunghi, gap chiari
    const trattinoCheminOsmAnd = [4, 4];    // ground: dash/gap uguali, aspetto puntinato
    const trattinoSentierOsmAnd = [1, 1];   // sentieri: puntinato (con cap round → pallini)
    // Solo highway=track (class=track in OpenMapTiles) per la classificazione offroad OsmAnd
    // I service road (vialetti, parcheggi) sono esclusi: non fanno parte della gerarchia dei sentieri
    const trackRoadClassFilter = ['==', ['get', 'class'], 'track'];
    const outdoorWayClassFilter = ['match', ['get', 'class'], ['track', 'service', 'path', 'pedestrian', 'footway', 'cycleway'], true, false];

    // --- Gerarchia offroad OsmAnd: predicati base (senza esclusioni) ---
    //
    // NOTA SCHEMA OpenMapTiles (usato da OpenFreeMap):
    // - `tracktype`: grade1–grade5 presenti per class=track ✓
    // - `surface`: SOLO 'paved' o 'unpaved' (i valori OSM originali asphalt/gravel/dirt/ecc.
    //   vengono semplificati durante la generazione dei tile)
    // - `smoothness`: NON presente nel layer transportation
    // - `ford`: NON è una proprietà separata — è un valore di `brunnel` (brunnel='ford')
    //
    // Conseguenza pratica: la classificazione affidabile avviene principalmente tramite
    // `tracktype`. La `surface` permette solo di distinguere paved (→ easy) da unpaved (→ ground).
    // Tracks con surface=gravel/rock senza tracktype appaiono come ground (verde tratteggiato):
    // classificazione conservativa/prudente per uso sul campo.

    // Categoria 1: carrossabile solido — marrone pieno
    // grade1/grade2 oppure superficie pavimentata
    const easyPredicate = ['any',
        ['match', ['get', 'tracktype'], ['grade1', 'grade2'], true, false],
        ['==', ['get', 'surface'], 'paved']
    ];
    // Categoria 2: carrossabile grossier — marrone tratteggiato
    // grade3 (ghiaia/ciottoli/roccia non distinguibili da 'unpaved' → solo tracktype)
    const roughPredicate = ['match', ['get', 'tracktype'], ['grade3'], true, false];
    // Categoria 3: secondo meteo — verde pieno
    // grade4
    const weatherPredicate = ['match', ['get', 'tracktype'], ['grade4'], true, false];
    // Categoria 4: sol nu — verde tratteggiato
    // grade5, superficie non pavimentata, ford (via campo brunnel)
    const groundPredicate = ['any',
        ['==', ['get', 'brunnel'], 'ford'],
        ['match', ['get', 'tracktype'], ['grade5'], true, false],
        ['==', ['get', 'surface'], 'unpaved']
    ];

    // Filtri layer con esclusioni in cascata (priorità decrescente: easy > rough > weather > ground)
    // Ogni categoria esclude quelle con priorità maggiore per evitare sovrapposizioni
    const easyTrackFilter = ['all', trackRoadClassFilter, easyPredicate];
    const roughTrackFilter = ['all', trackRoadClassFilter, roughPredicate, ['!', easyPredicate]];
    const weatherTrackFilter = ['all', trackRoadClassFilter, weatherPredicate, ['!', easyPredicate], ['!', roughPredicate]];
    const bareGroundTrackFilter = ['all', trackRoadClassFilter, groundPredicate, ['!', easyPredicate], ['!', roughPredicate]];
    // Categoria 5: non precisato — verde tratteggiato (stesso stile della cat. 4, solo class=track)
    const undefinedTrackFilter = ['all',
        ['==', ['get', 'class'], 'track'],
        ['!', easyPredicate], ['!', roughPredicate], ['!', weatherPredicate], ['!', groundPredicate]
    ];
    const groundTrackFilter = ['any', bareGroundTrackFilter, undefinedTrackFilter];
    const trailFilter = ['match', ['get', 'class'], ['path', 'pedestrian'], true, false];
    const accessoDivieto = ['private', 'no', 'destination', 'forestry', 'agricultural', 'customers'];
    const forbiddenAccessFilter = ['any',
        ['match', ['get', 'access'], accessoDivieto, true, false],
        ['match', ['get', 'vehicle'], accessoDivieto, true, false],
        ['match', ['get', 'motor_vehicle'], accessoDivieto, true, false],
        ['match', ['get', 'motorcar'], accessoDivieto, true, false],
        ['match', ['get', 'motorcycle'], accessoDivieto, true, false],
        ['match', ['get', 'class'], ['cycleway', 'footway'], true, false]
    ];
    const restrictedFilter = ['all',
        outdoorWayClassFilter,
        forbiddenAccessFilter
    ];
    const barrierKind = ['coalesce', ['get', 'barrier'], ['get', 'subclass'], ['get', 'class']];
    const barrierFilter = ['all',
        ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false],
        ['match', barrierKind, ['gate', 'lift_gate', 'swing_gate', 'hampshire_gate', 'chain', 'fence', 'cycle_barrier', 'motorcycle_barrier', 'block', 'bollard', 'yes', 'entrance', 'stile', 'horse_stile', 'kissing_gate', 'turnstile', 'cattle_grid', 'toll_booth', 'border_control', 'debris', 'log'], true, false]
    ];
    const mtbScale = ['to-number', ['coalesce', ['get', 'mtb_scale'], ['get', 'mtb:scale']], -1];
    const easyDifficultyFilter = ['all',
        trailFilter,
        ['>=', mtbScale, 0],
        ['<=', mtbScale, 1]
    ];
    const technicalDifficultyFilter = ['all',
        trailFilter,
        ['>=', mtbScale, 2],
        ['<=', mtbScale, 3]
    ];
    const hardDifficultyFilter = ['all',
        trailFilter,
        ['>=', mtbScale, 4]
    ];

    style.layers.forEach(layer => {
        if (layer.id === 'idro-background') {
            layer.paint['background-color'] = '#f5f1e7';
        }
        if (layer.id === 'idro-water-glow') {
            layer.paint['fill-color'] = '#edf8fb';
            layer.paint['fill-opacity'] = ['interpolate', ['linear'], ['zoom'], 0, 0.14, 13, 0.12];
        }
        if (layer.id === 'idro-water') {
            layer.paint['fill-color'] = '#d8edf4';
            layer.paint['fill-opacity'] = ['interpolate', ['linear'], ['zoom'], 0, 0.24, 13, 0.34];
        }
        if (layer.id === 'idro-water-intermittent') {
            layer.paint['fill-color'] = '#e7f5f8';
            layer.paint['fill-opacity'] = 0.16;
        }
        if (layer.id === 'idro-water-outline') {
            // Nascosto: il bordo del poligono crea un brutto effetto sul fill
            layer.paint['line-opacity'] = 0;
        }
        if (layer.id.startsWith('idro-waterway-') && layer.type === 'line' && layer.paint?.['line-opacity'] !== undefined) {
            layer.paint['line-opacity'] = ['interpolate', ['linear'], ['zoom'], 8, 0.08, 14, 0.24];
            layer.paint['line-color'] = '#8fc7d7';
        }
        // Glow e halo dei fiumi principali: nascosti perché ridondanti sui fiumi con fill poligonale
        if (layer.id === 'idro-waterway-river-glow' || layer.id === 'idro-waterway-river-halo') {
            layer.paint['line-opacity'] = 0;
        }
        if (layer.id === 'idro-road-minor') {
            layer.paint['line-opacity'] = ['interpolate', ['linear'], ['zoom'], 10, 0.18, 16, 0.42];
            layer.paint['line-color'] = '#fdfcf7';
        }
        if (layer.id === 'idro-road-major' || layer.id === 'idro-road-major-casing') {
            layer.paint['line-opacity'] = ['interpolate', ['linear'], ['zoom'], 5, 0.4, 13, 0.76];
        }
        if (layer.id === 'idro-road-label') {
            layer.minzoom = 11;
            layer.paint['text-opacity'] = ['interpolate', ['linear'], ['zoom'], 11, 0.46, 15, 0.78];
            layer.paint['text-color'] = '#5f5b54';
            layer.paint['text-halo-color'] = '#f5f1e7';
        }
        if (layer.id === 'idro-place-label') {
            layer.minzoom = 3;
            layer.filter = ['match', ['get', 'class'], ['city', 'town', 'village', 'hamlet', 'suburb', 'neighbourhood', 'state', 'country'], true, false];
            layer.layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 3, 10.5, 7, 12.5, 12, 15.8, 15, 17.5];
            layer.paint['text-opacity'] = ['interpolate', ['linear'], ['zoom'], 3, 0.72, 12, 0.95];
            layer.paint['text-color'] = '#3f3b34';
            layer.paint['text-halo-color'] = '#f5f1e7';
            layer.paint['text-halo-width'] = 1.45;
        }
        if (layer.id === 'idro-waterway-label' || layer.id === 'idro-water-name-point-label' || layer.id === 'idro-water-name-line-label') {
            layer.paint['text-color'] = '#2a6e8c';
            layer.paint['text-opacity'] = ['interpolate', ['linear'], ['zoom'], 9, 0.7, 12, 0.9, 16, 1.0];
            layer.paint['text-halo-color'] = 'rgba(240, 248, 255, 0.95)';
            layer.paint['text-halo-width'] = 1.8;
            if (layer.layout) {
                layer.layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 9, 11, 12, 13, 15, 15];
            }
        }
        if (layer.id === 'idro-river-poi') {
            layer.minzoom = 14;
            layer.paint['icon-opacity'] = ['interpolate', ['linear'], ['zoom'], 14, 0.72, 16, 0.92];
        }
        if (layer.id === 'idro-river-poi-lowzoom') {
            layer.paint['icon-opacity'] = ['interpolate', ['linear'], ['zoom'], 10, 0.78, 13, 0.95];
        }
        if (layer.id === 'idro-bridge-casing') {
            layer.paint['line-color'] = '#c8bfb0';
        }
    });

    const contourAndContextLayers = [
        {
            id: 'outdoor-contours-raster',
            type: 'raster',
            source: 'outdoor-topo-raster',
            minzoom: 7,
            paint: {
                'raster-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0.12, 11, 0.22, 16, 0.18],
                'raster-saturation': -0.42,
                'raster-contrast': 0.12
            }
        }
    ];

    const outdoorLayers = [
        {
            id: 'outdoor-track-easy-casing',
            type: 'line',
            source: 'openmaptiles',
            'source-layer': 'transportation',
            minzoom: 9,
            filter: ['all', trackRoadClassFilter, easyTrackFilter, ['!=', ['get', 'brunnel'], 'tunnel']],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
                'line-color': '#d2c5aa',
                'line-opacity': 0.42,
                'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.2, 10, 1.8, 12, 2.5, 14, 4, 16, 6, 18, 8]
            }
        },
        {
            id: 'outdoor-track-easy',
            type: 'line',
            source: 'openmaptiles',
            'source-layer': 'transportation',
            minzoom: 9,
            filter: ['all', trackRoadClassFilter, easyTrackFilter, ['!=', ['get', 'brunnel'], 'tunnel']],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
                'line-color': colorePistaOsmAnd,
                'line-opacity': 0.96,
                'line-width': larghezzaPistaOsmAnd
            }
        },
        {
            id: 'outdoor-track-rough-casing',
            type: 'line',
            source: 'openmaptiles',
            'source-layer': 'transportation',
            minzoom: 9,
            filter: ['all', trackRoadClassFilter, roughTrackFilter, ['!=', ['get', 'brunnel'], 'tunnel']],
            layout: { 'line-cap': 'butt', 'line-join': 'round' },
            paint: {
                'line-color': '#d2c5aa',
                'line-opacity': 0.35,
                'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.35, 10, 2, 12, 2.8, 14, 4.4, 16, 6.6, 18, 8.8]
            }
        },
        {
            id: 'outdoor-track-rough',
            type: 'line',
            source: 'openmaptiles',
            'source-layer': 'transportation',
            minzoom: 9,
            filter: ['all', trackRoadClassFilter, roughTrackFilter, ['!=', ['get', 'brunnel'], 'tunnel']],
            layout: { 'line-cap': 'butt', 'line-join': 'round' },
            paint: {
                'line-color': colorePistaOsmAnd,
                'line-dasharray': trattinoPistaOsmAnd,
                'line-opacity': 0.96,
                'line-width': larghezzaPistaOsmAnd
            }
        },
        {
            id: 'outdoor-track-weather-casing',
            type: 'line',
            source: 'openmaptiles',
            'source-layer': 'transportation',
            minzoom: 9,
            filter: ['all', trackRoadClassFilter, weatherTrackFilter, ['!=', ['get', 'brunnel'], 'tunnel']],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
                'line-color': '#cae5c9',
                'line-opacity': 0.42,
                'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.3, 10, 1.9, 13, 3, 14, 4, 16, 6, 18, 8]
            }
        },
        {
            id: 'outdoor-track-weather',
            type: 'line',
            source: 'openmaptiles',
            'source-layer': 'transportation',
            minzoom: 9,
            filter: ['all', trackRoadClassFilter, weatherTrackFilter, ['!=', ['get', 'brunnel'], 'tunnel']],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
                'line-color': coloreCheminOsmAnd,
                'line-opacity': 0.98,
                'line-width': larghezzaCheminOsmAnd
            }
        },
        {
            id: 'outdoor-track-ground-casing',
            type: 'line',
            source: 'openmaptiles',
            'source-layer': 'transportation',
            minzoom: 9,
            filter: ['all', trackRoadClassFilter, groundTrackFilter, ['!=', ['get', 'brunnel'], 'tunnel']],
            layout: { 'line-cap': 'butt', 'line-join': 'round' },
            paint: {
                'line-color': '#c8ebcf',
                'line-opacity': 0.35,
                'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.3, 10, 1.9, 13, 3, 14, 4, 16, 6, 18, 8]
            }
        },
        {
            id: 'outdoor-track-ground',
            type: 'line',
            source: 'openmaptiles',
            'source-layer': 'transportation',
            minzoom: 9,
            filter: ['all', trackRoadClassFilter, groundTrackFilter, ['!=', ['get', 'brunnel'], 'tunnel']],
            layout: { 'line-cap': 'butt', 'line-join': 'round' },
            paint: {
                'line-color': coloreCheminOsmAnd,
                'line-dasharray': trattinoCheminOsmAnd,
                'line-opacity': 0.98,
                'line-width': larghezzaCheminOsmAnd
            }
        },
        {
            id: 'outdoor-trail-casing',
            type: 'line',
            source: 'openmaptiles',
            'source-layer': 'transportation',
            minzoom: 9,
            filter: ['all', trailFilter, ['!=', ['get', 'brunnel'], 'tunnel']],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
                'line-color': '#f8f4ec',
                'line-dasharray': trattinoSentierOsmAnd,
                'line-opacity': 0.95,
                'line-width': ['interpolate', ['linear'], ['zoom'], 13, 2.2, 14, 3, 16, 4, 18, 5]
            }
        },
        {
            id: 'outdoor-trail',
            type: 'line',
            source: 'openmaptiles',
            'source-layer': 'transportation',
            minzoom: 9,
            filter: ['all', trailFilter, ['!=', ['get', 'brunnel'], 'tunnel']],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
                'line-color': coloreSentierOsmAnd,
                'line-dasharray': trattinoSentierOsmAnd,
                'line-opacity': 0.88,
                'line-width': larghezzaSentierOsmAnd
            }
        },
        {
            id: 'outdoor-difficulty-easy',
            type: 'line',
            source: 'openmaptiles',
            'source-layer': 'transportation',
            minzoom: 13,
            filter: easyDifficultyFilter,
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
                'line-color': '#000000',
                'line-dasharray': trattinoSentierOsmAnd,
                'line-opacity': 0.86,
                'line-width': larghezzaSentierOsmAnd
            }
        },
        {
            id: 'outdoor-difficulty-technical',
            type: 'line',
            source: 'openmaptiles',
            'source-layer': 'transportation',
            minzoom: 13,
            filter: technicalDifficultyFilter,
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
                'line-color': '#000000',
                'line-dasharray': trattinoSentierOsmAnd,
                'line-opacity': 0.9,
                'line-width': larghezzaSentierOsmAnd
            }
        },
        {
            id: 'outdoor-difficulty-hard',
            type: 'line',
            source: 'openmaptiles',
            'source-layer': 'transportation',
            minzoom: 13,
            filter: hardDifficultyFilter,
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
                'line-color': '#000000',
                'line-dasharray': trattinoSentierOsmAnd,
                'line-opacity': 0.96,
                'line-width': larghezzaSentierOsmAnd
            }
        },
        {
            id: 'outdoor-restricted-casing',
            type: 'line',
            source: 'openmaptiles',
            'source-layer': 'transportation',
            minzoom: 11,
            filter: restrictedFilter,
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
                'line-color': '#fff1f1',
                'line-opacity': 0.62,
                'line-width': ['interpolate', ['linear'], ['zoom'], 11, 3.2, 16, 6]
            }
        },
        {
            id: 'outdoor-restricted',
            type: 'line',
            source: 'openmaptiles',
            'source-layer': 'transportation',
            minzoom: 11,
            filter: restrictedFilter,
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
                'line-color': coloreDivietoOsmAnd,
                'line-opacity': 0.98,
                'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.5, 16, 3]
            }
        },
        {
            id: 'outdoor-track-label',
            type: 'symbol',
            source: 'openmaptiles',
            'source-layer': 'transportation_name',
            minzoom: 13,
            filter: ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false],
            layout: {
                'symbol-placement': 'line',
                'symbol-spacing': 320,
                'text-field': ['coalesce', ['get', 'name:it'], ['get', 'name'], ['get', 'ref']],
                'text-font': ['Noto Sans Italic'],
                'text-size': ['interpolate', ['linear'], ['zoom'], 13, 8.5, 16, 10.5, 18, 11.5],
                'text-rotation-alignment': 'map',
                'text-optional': true
            },
            paint: {
                'text-color': ['match', ['get', 'class'],
                    ['path', 'pedestrian', 'footway'], '#252525',
                    ['track', 'service'], '#6b4a1a',
                    '#5f5b54'
                ],
                'text-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.45, 16, 0.76],
                'text-halo-color': 'rgba(245, 241, 231, 0.96)',
                'text-halo-width': 1.25
            }
        }
    ];

    const createBarrierLayers = (suffix, sourceLayer) => [
        {
            id: `outdoor-barrier-far-${suffix}`,
            type: 'circle',
            source: 'openmaptiles',
            'source-layer': sourceLayer,
            minzoom: 13,
            maxzoom: 16,
            filter: barrierFilter,
            paint: {
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2, 15, 3],
                'circle-color': ['match', barrierKind, ['debris', 'log'], '#996600', coloreDivietoOsmAnd],
                'circle-opacity': 0.9,
                'circle-stroke-color': '#fff1f1',
                'circle-stroke-width': 0.8
            }
        },
        {
            id: `outdoor-barrier-near-${suffix}`,
            type: 'circle',
            source: 'openmaptiles',
            'source-layer': sourceLayer,
            minzoom: 16,
            filter: barrierFilter,
            paint: {
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 16, 3.5, 18, 5],
                'circle-color': ['match', barrierKind, ['debris', 'log'], '#996600', coloreDivietoOsmAnd],
                'circle-opacity': 0.92,
                'circle-stroke-color': '#fff7f0',
                'circle-stroke-width': 1.25
            }
        },
        {
            id: `outdoor-barrier-label-${suffix}`,
            type: 'symbol',
            source: 'openmaptiles',
            'source-layer': sourceLayer,
            minzoom: 16,
            filter: barrierFilter,
            layout: {
                'text-field': ['match', barrierKind,
                    ['gate', 'lift_gate', 'swing_gate', 'hampshire_gate'], 'G',
                    ['chain', 'fence'], 'C',
                    ['bollard'], 'B',
                    ['debris', 'log'], '!',
                    'X'
                ],
                'text-font': ['Noto Sans Bold'],
                'text-size': ['interpolate', ['linear'], ['zoom'], 16, 8, 18, 10],
                'text-allow-overlap': true,
                'text-ignore-placement': true
            },
            paint: {
                'text-color': '#ffffff',
                'text-halo-color': ['match', barrierKind, ['debris', 'log'], '#996600', coloreDivietoOsmAnd],
                'text-halo-width': 0.8
            }
        }
    ];
    const barrierLayers = [
        ...createBarrierLayers('transportation', 'transportation'),
        ...createBarrierLayers('poi', 'poi')
    ];

    const naturalContextLayers = [
        {
            id: 'outdoor-natural-poi',
            type: 'symbol',
            source: 'openmaptiles',
            'source-layer': 'poi',
            minzoom: 12,
            filter: ['all',
                ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false],
                ['match', ['get', 'subclass'], [
                    'shelter',
                    'alpine_hut',
                    'wilderness_hut',
                    'ranger_station',
                    'viewpoint',
                    'cave_entrance',
                    'cliff',
                    'spring',
                    'waterfall',
                    'picnic_site',
                    'camp_site',
                    'campsite',
                    'information'
                ], true, false]
            ],
            layout: {
                'icon-image': ['match', ['get', 'subclass'],
                    ['shelter', 'alpine_hut', 'wilderness_hut'], 'shelter',
                    ['ranger_station'], 'ranger_station',
                    ['viewpoint'], 'mountain',
                    ['cave_entrance', 'cliff'], 'triangle',
                    ['spring', 'waterfall'], 'water',
                    ['picnic_site'], 'picnic_site',
                    ['camp_site', 'campsite'], 'campsite',
                    ['information'], 'information',
                    'circle'
                ],
                'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.42, 16, 0.62],
                'icon-padding': 2,
                'text-anchor': 'top',
                'text-field': ['step', ['zoom'], '', 15, ['coalesce', ['get', 'name:it'], ['get', 'name'], ['get', 'name_en']]],
                'text-font': ['Noto Sans Regular'],
                'text-max-width': 8,
                'text-offset': [0, 0.8],
                'text-optional': true,
                'text-size': ['interpolate', ['linear'], ['zoom'], 15, 10, 18, 11.5]
            },
            paint: {
                'icon-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0.54, 16, 0.88],
                'text-color': '#4f5849',
                'text-halo-color': 'rgba(245, 241, 231, 0.92)',
                'text-halo-width': 1.15
            }
        },
        {
            id: 'outdoor-mountain-peak',
            type: 'symbol',
            source: 'openmaptiles',
            'source-layer': 'mountain_peak',
            minzoom: 8,
            filter: ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false],
            layout: {
                'icon-image': 'mountain',
                'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.42, 13, 0.6],
                'icon-padding': 2,
                'text-anchor': 'top',
                'text-field': ['case',
                    ['all', ['has', 'ele'], ['has', 'name']],
                    ['concat', ['coalesce', ['get', 'name:it'], ['get', 'name'], ['get', 'name_en']], '\n', ['to-string', ['get', 'ele']], ' m'],
                    ['coalesce', ['get', 'name:it'], ['get', 'name'], ['get', 'name_en']]
                ],
                'text-font': ['Noto Sans Regular'],
                'text-max-width': 8,
                'text-offset': [0, 0.75],
                'text-optional': true,
                'text-size': ['interpolate', ['linear'], ['zoom'], 8, 10, 13, 12.2, 16, 13]
            },
            paint: {
                'icon-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0.62, 13, 0.92],
                'text-color': '#4a4036',
                'text-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0.76, 13, 0.96],
                'text-halo-color': 'rgba(245, 241, 231, 0.95)',
                'text-halo-width': 1.55
            }
        }
    ];

    const contoursIndex = style.layers.findIndex(layer => layer.id === 'idro-water-glow');
    style.layers.splice(contoursIndex === -1 ? style.layers.length : contoursIndex, 0, ...contourAndContextLayers);

    const labelsIndex = style.layers.findIndex(layer => layer.id === 'idro-road-label');
    style.layers.splice(labelsIndex === -1 ? style.layers.length : labelsIndex, 0, ...outdoorLayers, ...barrierLayers, ...naturalContextLayers);
    return style;
}

function ensureApplicationLayersAboveMap() {
    if (!mapLoaded) return;
    for (const layerId of APPLICATION_LAYER_ORDER) {
        if (map.getLayer(layerId)) map.moveLayer(layerId);
    }
}

// ── Colorazione traccia per metrica ───────────────────────────────────────────

// Mappa t ∈ [0,1] → colore HSL (verde→giallo→rosso)
function metricToHsl(t) {
    const clamped = Math.min(1, Math.max(0, t));
    const hue = Math.round((1 - clamped) * 120); // 120=verde, 0=rosso
    return `hsl(${hue},88%,52%)`;
}

// Legge il tempo di un punto in ms (compatibile con formato ISO e numerico)
function _readPointTimeMs(point) {
    const raw = point?.time;
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
}

// Costruisce GeoJSON di segmenti (2 punti ciascuno) colorati per metrica.
// Ogni edge ha: { color, width }
function buildColoredTrackGeoJSON(metric) {
    const edges = [];

    for (let ti = 0; ti < tracks.length; ti++) {
        const track = tracks[ti];
        if (track.visible === false) continue;
        const width = (track.width || 3) + 1; // leggermente più spessa per visibilità
        for (let si = 0; si < track.segments.length; si++) {
            const seg = track.segments[si];
            if (seg.visible === false) continue;
            const pts = seg.points;
            if (pts.length < 2) continue;

            let prevPt = null, prevTimeMs = null;
            for (let i = 0; i < pts.length; i++) {
                const pt = pts[i];
                const ele = Number(pt.ele) || 0;
                const timeMs = _readPointTimeMs(pt);

                if (prevPt !== null) {
                    let value = null;
                    const d = haversineDistance(prevPt.lon, prevPt.lat, pt.lon, pt.lat);
                    const distM = d * 1000;

                    switch (metric) {
                        case 'altitude':
                            value = (ele + (Number(prevPt.ele) || 0)) / 2;
                            break;
                        case 'speed':
                            if (timeMs !== null && prevTimeMs !== null) {
                                const dtMs = timeMs - prevTimeMs;
                                if (dtMs > 0) {
                                    const spd = d / (dtMs / 3600000);
                                    if (spd >= 0 && spd <= 250) value = spd;
                                }
                            }
                            break;
                        case 'slope':
                            if (distM > 15) {
                                value = ((ele - (Number(prevPt.ele) || 0)) / distM) * 100;
                            }
                            break;
                        case 'tilt':
                            if (Number.isFinite(pt.tilt)) value = Math.abs(pt.tilt);
                            break;
                        case 'vibration':
                            if (Number.isFinite(pt.vibrationLevel)) value = pt.vibrationLevel;
                            break;
                    }

                    edges.push({
                        lon1: prevPt.lon, lat1: prevPt.lat,
                        lon2: pt.lon, lat2: pt.lat,
                        value, width
                    });
                }
                prevPt = pt;
                prevTimeMs = timeMs;
            }
        }
    }

    if (edges.length === 0) return { type: 'FeatureCollection', features: [] };

    // Calcola range globale per normalizzazione
    let vMin = Infinity, vMax = -Infinity;
    for (let i = 0; i < edges.length; i++) {
        const v = edges[i].value;
        if (v !== null && Number.isFinite(v)) {
            if (v < vMin) vMin = v;
            if (v > vMax) vMax = v;
        }
    }
    const range = (vMax > vMin) ? (vMax - vMin) : 1;

    // Aggiorna DOM legenda
    const legendMin = document.getElementById('stats-color-legend-min');
    const legendMax = document.getElementById('stats-color-legend-max');
    const legendLabel = document.getElementById('stats-color-legend-label');
    const metricLabels = {
        altitude: 'm', speed: 'km/h', slope: '%', tilt: '°', vibration: ''
    };
    const unit = metricLabels[metric] || '';
    if (legendMin) legendMin.textContent = Number.isFinite(vMin) ? `${Math.round(vMin * 10) / 10}${unit}` : '—';
    if (legendMax) legendMax.textContent = Number.isFinite(vMax) ? `${Math.round(vMax * 10) / 10}${unit}` : '—';
    if (legendLabel) {
        const names = { altitude: 'Altitudine', speed: 'Velocità', slope: 'Pendenza', tilt: 'Inclinazione', vibration: 'Vibrazioni' };
        legendLabel.textContent = names[metric] || metric;
    }

    const features = [];
    for (let i = 0; i < edges.length; i++) {
        const edge = edges[i];
        const color = (edge.value !== null && Number.isFinite(edge.value))
            ? metricToHsl((edge.value - vMin) / range)
            : '#6b7280'; // grigio per dati mancanti
        features.push({
            type: 'Feature',
            properties: { color, width: edge.width },
            geometry: {
                type: 'LineString',
                coordinates: [[edge.lon1, edge.lat1], [edge.lon2, edge.lat2]]
            }
        });
    }

    return { type: 'FeatureCollection', features };
}

// Inizializza sorgente e layer per la traccia colorata (chiamato da setupLayers)
function initColoredTrackLayers() {
    if (!map.getSource('gpx-lines-colored')) {
        map.addSource('gpx-lines-colored', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
            buffer: 4
        });
    }
    if (!map.getLayer('gpx-lines-colored-layer')) {
        map.addLayer({
            id: 'gpx-lines-colored-layer',
            type: 'line',
            source: 'gpx-lines-colored',
            layout: { 'line-join': 'round', 'line-cap': 'round', 'visibility': 'none' },
            paint: {
                'line-color': ['get', 'color'],
                'line-width': ['get', 'width'],
                'line-opacity': 1.0
            }
        });
    }
}

// Aggiorna il layer colorato e gestisce visibilità/swap con il layer standard
function refreshColoredTrackLayer() {
    if (!mapLoaded) return;
    const src = map.getSource('gpx-lines-colored');
    if (!src) return;

    if (_coloredTrackMode) {
        const data = buildColoredTrackGeoJSON(_coloredTrackMode);
        src.setData(data);
        if (map.getLayer('gpx-lines-colored-layer')) {
            map.setLayoutProperty('gpx-lines-colored-layer', 'visibility', 'visible');
        }
        // Nasconde il layer LOD standard
        if (map.getLayer('gpx-lines-layer')) {
            map.setPaintProperty('gpx-lines-layer', 'line-opacity', 0);
        }
    } else {
        src.setData({ type: 'FeatureCollection', features: [] });
        if (map.getLayer('gpx-lines-colored-layer')) {
            map.setLayoutProperty('gpx-lines-colored-layer', 'visibility', 'none');
        }
        // Ripristina opacità layer LOD standard
        if (map.getLayer('gpx-lines-layer')) {
            map.setPaintProperty('gpx-lines-layer', 'line-opacity', 0.85);
        }
    }
}

// Ascolta eventi di cambio modalità colore da stats.js
window.addEventListener('gpxsuite:colormode-changed', (e) => {
    _coloredTrackMode = e.detail?.mode || null;
    refreshColoredTrackLayer();
});

// ──────────────────────────────────────────────────────────────────────────────

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
        image.close ?.();
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
        if (track.localSource === 'recording-live') continue;
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
    // Aggiorna layer colorato se attivo
    if (_coloredTrackMode) {
        refreshColoredTrackLayer();
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
    initColoredTrackLayers();

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

    // ── Marker hover dal grafico altimetrico ───────────────────────────────
    if (!map.getSource('chart-hover-marker')) {
        map.addSource('chart-hover-marker', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });
    }
    if (!map.getLayer('chart-hover-marker-halo')) {
        map.addLayer({
            id: 'chart-hover-marker-halo',
            type: 'circle',
            source: 'chart-hover-marker',
            paint: {
                'circle-radius': 10,
                'circle-color': ['get', 'color'],
                'circle-opacity': 0.28,
                'circle-stroke-width': 0
            }
        });
    }
    if (!map.getLayer('chart-hover-marker-dot')) {
        map.addLayer({
            id: 'chart-hover-marker-dot',
            type: 'circle',
            source: 'chart-hover-marker',
            paint: {
                'circle-radius': 5,
                'circle-color': ['get', 'color'],
                'circle-stroke-width': 2,
                'circle-stroke-color': 'rgba(255,255,255,0.95)',
                'circle-opacity': 1
            }
        });
    }
    // ─────────────────────────────────────────────────────────────────────

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
    const width = container ?.offsetWidth || 1;
    const height = container ?.offsetHeight || 1;
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
    const bounds = map.getBounds ?.();
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
    return image ?.lngLat ||
        image ?.computedLngLat ||
        image ?.originalLngLat ||
        image ?.computed_geometry ||
        image ?.computedGeometry ||
        image ?.geometry;
}

function getMapillaryImageBearing(image) {
    return normalizeMapillaryBearing(
        image?.computed_compass_angle ??
        image?.computedCompassAngle ??
        image?.compass_angle ??
        image?.compassAngle ??
        image?.bearing
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
        const feature = e.features && e.features[0];
        const imageId = feature ?.properties ?.id || feature ?.properties ?.image_id || feature ?.properties ?.key;
        if (!imageId) {
            showToast("Immagine Mapillary senza ID interrogabile", "error");
            return;
        }
        e.preventDefault();
        updateMapillaryCurrentMarker(feature.geometry, imageId, feature.properties ?.computed_compass_angle || feature.properties ?.compass_angle);
        openMapillaryImage(String(imageId));
    });
}

function getMapillaryJsApi() {
    return window.mapillary ?.Viewer ? window.mapillary : (window.Mapillary ?.Viewer ? window.Mapillary : null);
}

function ensureMapillaryJsAssets() {
    const api = getMapillaryJsApi();
    if (api ?.Viewer) return Promise.resolve(api);
    if (_mapillaryAssetsPromise) return _mapillaryAssetsPromise;

    _mapillaryAssetsPromise = Promise.all([
        loadStylesheetOnce(MAPILLARY_CSS_URL, { id: 'mapillary-js-css' }),
        loadScriptOnce(MAPILLARY_JS_URL, { id: 'mapillary-js-cdn' })
    ]).then(() => getMapillaryJsApi()).catch(err => {
        _mapillaryAssetsPromise = null;
        throw err;
    });

    return _mapillaryAssetsPromise;
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
        updateMapillaryViewerHeader(currentImage ?.id || _mapillaryCurrentImageId);
        updateMapillaryCurrentMarker(
            getMapillaryImageLngLat(currentImage),
            currentImage ?.id,
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
        updateMapillaryCurrentBearing(pov ?.bearing);
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
    _mapillaryJsViewer.on('image', event => { syncMapillaryViewerToMap(event ?.image); });
    _mapillaryJsViewer.on('position', syncMapillaryViewerPosition);
    _mapillaryJsViewer.on('pov', syncMapillaryViewerPov);
    _mapillaryJsViewer.on('fov', syncMapillaryViewerFov);
    _mapillaryJsWindowResizeHandler = () => { syncMapillaryViewerFov(); };
    window.addEventListener('resize', _mapillaryJsWindowResizeHandler);
}

async function openMapillaryJsViewer(imageId) {
    const api = getMapillaryJsApi();
    if (!api ?.Viewer) throw new Error('MapillaryJS non disponibile');

    const panel = document.getElementById('panel-mapillary-viewer');
    const jsContainer = document.getElementById('mapillary-js-viewer');
    const image = document.getElementById('mapillary-image');
    const placeholder = document.getElementById('mapillary-placeholder');
    if (!panel || !jsContainer) throw new Error('Container MapillaryJS non disponibile');

    panel.classList.remove('hidden');
    setMapillaryViewerOpen(true);
    jsContainer.classList.remove('hidden');
    image ?.classList.add('hidden');
    placeholder ?.classList.add('hidden');
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
            image ?.id || imageId,
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
                const id = data.data[i] ?.id || data.data[i] ?.image_id;
                if (id) ids.push(String(id));
            }
        }
        url = data.paging ?.next || '';
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
    document.getElementById('mapillary-js-viewer') ?.classList.add('hidden');
    const image = document.getElementById('mapillary-image');
    const placeholder = document.getElementById('mapillary-placeholder');
    const keepCurrentVisible = options.keepCurrentVisible === true && image ?.src && !image.classList.contains('hidden');

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
        document.getElementById('mapillary-author').textContent = data.creator ?.username ? `di ${data.creator.username}` : '';
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
    if (!hasMapillaryToken()) {
        showToast("Inserisci prima il token Mapillary.", "error");
        return;
    }

    if (!options.forceFallback) {
        try {
            const api = await ensureMapillaryJsAssets();
            if (api ?.Viewer) {
                stopMapillaryPlayback();
                await openMapillaryJsViewer(imageId);
                return;
            }
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

export function createBaseMapStyle(style, isHybrid) {
    const normalizedStyle = normalizeBaseMapStyle(style);
    if (normalizedStyle === 'acqua') {
        return createHydroBaseMapStyle();
    }
    if (normalizedStyle === 'outdoor') {
        return createOutdoorBaseMapStyle();
    }

    const baseStyle = {
        version: 8,
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources: {},
        layers: []
    };

    if (normalizedStyle === 'sat') {
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

    if (normalizedStyle === 'topo') {
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
            layout: { visibility: hikingToggle ?.checked ? 'visible' : 'none' }
        });
    }

}

function restoreApplicationLayersAfterStyleLoad(reloadSerial) {
    if (reloadSerial !== _styleReloadSerial) return;

    // Le immagini custom MapLibre vengono perse al cambio stile: svuota la cache
    refreshPinImages();

    setupStyleDependentLayers();
    setupLayers();

    if (is3D && map.getSource('terrain-nextzen')) {
        map.setTerrain({ source: 'terrain-nextzen', exaggeration: 1.2 });
    }

    // Timeout necessario per aggirare la race condition di MapLibre WebWorker
    // dove le chiamate a setData sincrone dopo addSource vengono scartate
    setTimeout(() => {
        if (reloadSerial !== _styleReloadSerial) return;
        updateMapData(true);
        if (typeof _onStyleRestoredHook === 'function') {
            try { _onStyleRestoredHook(); } catch (err) { console.warn(err); }
        }
        ensureApplicationLayersAboveMap();
    }, 50);
}

export function setBaseMap(style) {
    const normalizedStyle = normalizeBaseMapStyle(style);
    setCurrentStyle(normalizedStyle);
    if (!mapLoaded) return;

    const isHybrid = document.getElementById('toggle-hybrid')?.checked;
    const reloadSerial = ++_styleReloadSerial;

    map.once('style.load', () => restoreApplicationLayersAfterStyleLoad(reloadSerial));
    map.setStyle(createBaseMapStyle(normalizedStyle, isHybrid), { diff: false });

    BASE_MAP_STYLES.forEach(s => {
        const el = document.getElementById(`map-style-${s}`);
        if (!el) return;
        el.className = s === normalizedStyle ?
            "text-[10px] font-bold py-1.5 px-1 rounded-md text-center bg-blue-600 text-white transition-all" :
            "text-[10px] font-medium py-1.5 px-1 rounded-md text-center text-gray-400 hover:text-white transition-all";
    });

    const satOptionsContainer = document.getElementById('sat-options-container');
    if (satOptionsContainer) {
        satOptionsContainer.className =
            normalizedStyle === 'sat' ? "pt-1.5 flex items-center justify-between" : "hidden";
    }

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

    const viewMode2dButton = document.getElementById('view-mode-2d');
    const viewMode3dButton = document.getElementById('view-mode-3d');
    if (viewMode2dButton) {
        viewMode2dButton.className = !enable3D ?
            "text-xs font-medium py-1 px-2 rounded bg-blue-600 text-white" :
            "text-xs font-medium py-1 px-2 rounded text-gray-400 hover:text-white";
    }
    if (viewMode3dButton) {
        viewMode3dButton.className = enable3D ?
            "text-xs font-medium py-1 px-2 rounded bg-blue-600 text-white" :
            "text-xs font-medium py-1 px-2 rounded text-gray-400 hover:text-white";
    }

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
        if (Number.isFinite(ele) && Math.abs(ele) > 0.01) return Math.round(ele);
    } catch {}

    try {
        return await queryTerrariumElevation(lon, lat);
    } catch {
        return 0;
    }
}

// ── Marker hover grafico altimetrico — aggiornato da custom events di stats.js ──
function _setChartHoverMarkerData(lat, lon, color) {
    if (!mapLoaded) return;
    const src = map.getSource('chart-hover-marker');
    if (!src) return;
    src.setData({
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: { color: color || '#3b82f6' }
        }]
    });
}

function _clearChartHoverMarkerData() {
    if (!mapLoaded) return;
    const src = map.getSource('chart-hover-marker');
    if (src) src.setData({ type: 'FeatureCollection', features: [] });
}

window.addEventListener('gpxsuite:chart-hover', (e) => {
    const { lat, lon, color } = e.detail || {};
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
        _setChartHoverMarkerData(lat, lon, color);
    }
});

window.addEventListener('gpxsuite:chart-hover-clear', () => {
    _clearChartHoverMarkerData();
});
