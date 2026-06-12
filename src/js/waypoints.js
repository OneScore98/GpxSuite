// waypoints.js — addWaypointAtCoords, openWaypointEditor, saveWaypointModifications,
//                waypoint layers MapLibre e interazioni fluide

import {
    tracks,
    activeTrackId,
    activeWpForEdit,
    setActiveWpForEdit,
    isAddingWaypoint,
    setIsAddingWaypoint,
    isDrawing,
    isCutting,
    isBoxDeleting,
    map
} from './state.js';

import { saveHistoryState } from './tracks.js';
import { updateMapData, queryElevation } from './map.js';
import { showToast, updateToolButtons, updateMapToolCursor } from './ui.js';
import { trovaTipoWaypoint } from './waypointTypes.js';

let _waypointInteractionsBound = false;
let _draggingWaypoint = null;
let _dragMoved = false;
let _dragStartPoint = null;
let _suppressNextWaypointClick = false;
// Sotto questa distanza (px) il movimento è jitter del click, non un drag
const DRAG_THRESHOLD_PX = 3;

// Cache immagini badge per colore+simbolo (`${color}|${symbol}` -> imageId)
const _pinImageCache = new Map();
const ID_PIN_PREFIX = 'gpx-wp-topo-';
const DEFAULT_WP_SYMBOL = '📍';

// Chiave stabile e sicura per l'id immagine a partire dall'emoji
function symbolKey(symbol) {
    return Array.from(symbol || DEFAULT_WP_SYMBOL)
        .map(ch => ch.codePointAt(0).toString(16))
        .join('-');
}

function disegnaPittogrammaWaypoint(ctx, tipo) {
    ctx.save();
    ctx.translate(20, 18);
    ctx.lineWidth = 1.7;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = '#ffffff';

    switch (tipo.chiave) {
        case 'bivacco':
            ctx.beginPath();
            ctx.moveTo(-7, 5);
            ctx.lineTo(0, -7);
            ctx.lineTo(7, 5);
            ctx.closePath();
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(0, -7);
            ctx.lineTo(0, 5);
            ctx.stroke();
            break;
        case 'vetta':
            ctx.beginPath();
            ctx.moveTo(-8, 5);
            ctx.lineTo(-2, -5);
            ctx.lineTo(1, -1);
            ctx.lineTo(4, -7);
            ctx.lineTo(9, 5);
            ctx.closePath();
            ctx.stroke();
            break;
        case 'acqua':
            ctx.beginPath();
            ctx.moveTo(0, -8);
            ctx.bezierCurveTo(5, -2, 7, 1, 7, 4);
            ctx.bezierCurveTo(7, 8, 4, 10, 0, 10);
            ctx.bezierCurveTo(-4, 10, -7, 8, -7, 4);
            ctx.bezierCurveTo(-7, 1, -5, -2, 0, -8);
            ctx.fill();
            break;
        case 'parcheggio':
            ctx.font = '700 15px Arial, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('P', 0, 1);
            break;
        case 'rifugio':
            ctx.beginPath();
            ctx.moveTo(-8, -1);
            ctx.lineTo(0, -8);
            ctx.lineTo(8, -1);
            ctx.stroke();
            ctx.strokeRect(-5.5, -1, 11, 8);
            ctx.beginPath();
            ctx.moveTo(0, 7);
            ctx.lineTo(0, 2);
            ctx.stroke();
            break;
        case 'pericolo':
            ctx.font = '800 17px Arial, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('!', 0, 1);
            break;
        default:
            ctx.beginPath();
            ctx.arc(0, 0, 5.2, 0, Math.PI * 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(0, -9);
            ctx.lineTo(0, -6);
            ctx.moveTo(0, 6);
            ctx.lineTo(0, 9);
            ctx.moveTo(-9, 0);
            ctx.lineTo(-6, 0);
            ctx.moveTo(6, 0);
            ctx.lineTo(9, 0);
            ctx.stroke();
            break;
    }

    ctx.restore();
}

// Disegna un badge topografico compatto con categoria interna e bordo traccia.
// Rasterizzato a 3x per restare nitido quando icon-size cresce con lo zoom.
function disegnaBadgeTopo(color, symbol) {
    const scala = 3;
    const larghezza = 40;
    const altezza = 44;
    const cx = larghezza / 2;
    const cy = 18;
    const raggio = 14;
    const tipo = trovaTipoWaypoint(symbol);

    const canvas = document.createElement('canvas');
    canvas.width = larghezza * scala;
    canvas.height = altezza * scala;
    const ctx = canvas.getContext('2d');
    ctx.scale(scala, scala);

    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.ellipse(cx, altezza - 3.2, 6.5, 2.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.shadowColor = 'rgba(15, 23, 42, 0.30)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 2;
    ctx.beginPath();
    ctx.moveTo(cx, altezza - 4);
    ctx.quadraticCurveTo(cx - 5.5, altezza - 13, cx - raggio * 0.72, cy + raggio * 0.70);
    ctx.arc(cx, cy, raggio, 0.76 * Math.PI, 0.24 * Math.PI, false);
    ctx.quadraticCurveTo(cx + 5.5, altezza - 13, cx, altezza - 4);
    ctx.closePath();
    ctx.fillStyle = 'rgba(248, 250, 252, 0.97)';
    ctx.fill();
    ctx.lineWidth = 2.3;
    ctx.strokeStyle = color || '#3b82f6';
    ctx.stroke();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, cy, 10.2, 0, Math.PI * 2);
    ctx.fillStyle = tipo.colore;
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.78)';
    ctx.stroke();

    disegnaPittogrammaWaypoint(ctx, tipo);

    return {
        imageData: ctx.getImageData(0, 0, canvas.width, canvas.height),
        pixelRatio: scala
    };
}

// Restituisce l'imageId del pin per colore+simbolo, registrandolo se necessario
function getOrRegisterPinImage(color, symbol) {
    const safeColor = (color || '#3b82f6').replace('#', '');
    const safeSymbol = symbol || DEFAULT_WP_SYMBOL;
    const cacheKey = `${safeColor}|${safeSymbol}`;
    const imageId = `${ID_PIN_PREFIX}${safeColor}-${symbolKey(safeSymbol)}`;
    if (!map) return imageId;
    if (!_pinImageCache.has(cacheKey) && !map.hasImage(imageId)) {
        const { imageData, pixelRatio } = disegnaBadgeTopo(color || '#3b82f6', safeSymbol);
        map.addImage(imageId, imageData, { pixelRatio });
    }
    _pinImageCache.set(cacheKey, imageId);
    return imageId;
}

// Rigenera tutte le immagini pin (usato dopo cambio stile mappa)
export function refreshPinImages() {
    _pinImageCache.clear();
}

function buildWaypointFeatureCollection() {
    const features = [];
    for (let ti = 0; ti < tracks.length; ti++) {
        const track = tracks[ti];
        if (track.visible === false || track.waypointsVisible === false) continue;
        const trackColor = track.color || '#3b82f6';
        for (let wi = 0; wi < track.waypoints.length; wi++) {
            const wp = track.waypoints[wi];
            if (wp.visible === false) continue;
            // Immagine per combinazione colore traccia + simbolo del waypoint
            const imageId = getOrRegisterPinImage(trackColor, wp.symbol);
            features.push({
                type: 'Feature',
                properties: {
                    trackId: track.id,
                    wpId: wp.id,
                    name: wp.name,
                    symbol: wp.symbol || DEFAULT_WP_SYMBOL,
                    color: trackColor,
                    imageId: imageId
                },
                geometry: {
                    type: 'Point',
                    coordinates: [wp.lon, wp.lat]
                }
            });
        }
    }
    return { type: 'FeatureCollection', features };
}

function findWaypoint(trackId, wpId) {
    const track = tracks.find(t => t.id === trackId);
    if (!track) return null;
    const wp = track.waypoints.find(w => w.id === wpId);
    if (!wp) return null;
    return { track, wp };
}

function getWaypointFeatureFromEvent(e) {
    const feature = e?.features?.[0];
    if (!feature?.properties) return null;
    const trackId = feature.properties.trackId;
    const wpId = feature.properties.wpId;
    if (!trackId || !wpId) return null;
    return { trackId, wpId };
}

// Aggiunge un waypoint immediatamente sulla mappa, poi aggiorna la quota in background
export async function addWaypointAtCoords(lon, lat) {
    if (!activeTrackId) {
        showToast("Seleziona o crea una traccia prima di aggiungere un waypoint.", "error");
        setIsAddingWaypoint(false);
        updateToolButtons();
        updateMapToolCursor();
        return;
    }
    const track = tracks.find(t => t.id === activeTrackId);
    if (!track) return;

    const wpName = `WP - ${track.waypoints.length + 1}`;
    const newWp = {
        id: 'wp_' + Date.now(),
        name: wpName,
        desc: '',
        symbol: '📍',
        lat: lat,
        lon: lon,
        ele: 0,
        visible: true
    };

    // Aggiunge SUBITO il waypoint e lo mostra sulla mappa senza attendere la quota
    track.waypoints.push(newWp);
    setIsAddingWaypoint(false);
    // Sincronizza pulsante toolbar e cursore dopo la disattivazione automatica
    updateToolButtons();
    updateMapToolCursor();
    updateMapData();
    saveHistoryState();

    // Apre subito l'editor: l'utente assegna nome/icona senza dover cercare
    // il waypoint appena creato nel GIS tree.
    openWaypointEditor(track.id, newWp.id);

    // Aggiorna la quota in background (non blocca la UI)
    try {
        const ele = await queryElevation(lon, lat);
        if (typeof ele === 'number' && !isNaN(ele) && ele !== 0) {
            newWp.ele = ele;
            updateMapData();
        }
    } catch (_) {
        // Quota resta 0, nessun toast di errore
    }
}

export function setupWaypointLayers() {
    if (!map.getSource('gpx-waypoints')) {
        map.addSource('gpx-waypoints', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
            cluster: true,
            clusterMaxZoom: 11,
            clusterRadius: 42
        });
    }

    // --- Layer cluster ---

    if (!map.getLayer('gpx-waypoints-cluster-halo-layer')) {
        map.addLayer({
            id: 'gpx-waypoints-cluster-halo-layer',
            type: 'circle',
            source: 'gpx-waypoints',
            filter: ['has', 'point_count'],
            paint: {
                'circle-radius': [
                    'step', ['get', 'point_count'],
                    13, 10, 16, 50, 19, 200, 23
                ],
                'circle-color': '#f8fafc',
                'circle-opacity': 0.26,
                'circle-blur': 0.28
            }
        });
    }

    if (!map.getLayer('gpx-waypoints-cluster-layer')) {
        map.addLayer({
            id: 'gpx-waypoints-cluster-layer',
            type: 'circle',
            source: 'gpx-waypoints',
            filter: ['has', 'point_count'],
            paint: {
                'circle-radius': [
                    'step', ['get', 'point_count'],
                    9, 10, 11.5, 50, 14.5, 200, 17
                ],
                'circle-color': '#111827',
                'circle-opacity': 0.94,
                'circle-stroke-width': [
                    'interpolate', ['linear'], ['zoom'], 4, 1.3, 12, 2.4
                ],
                'circle-stroke-color': 'rgba(248,250,252,0.92)'
            }
        });
    }

    if (!map.getLayer('gpx-waypoints-cluster-count-layer')) {
        map.addLayer({
            id: 'gpx-waypoints-cluster-count-layer',
            type: 'symbol',
            source: 'gpx-waypoints',
            filter: ['has', 'point_count'],
            layout: {
                'text-field': ['get', 'point_count_abbreviated'],
                'text-size': [
                    'step', ['get', 'point_count'], 11, 50, 12, 200, 13
                ],
                // NB: un solo font: con piu' font MapLibre richiede il fontstack COMBINATO
                // ("Open Sans Semibold,Arial Unicode MS Bold") che sul glyph server
                // demotiles risponde 404 -> nessuna etichetta renderizzata.
                'text-font': ['Open Sans Semibold'],
                'text-allow-overlap': true,
                'text-ignore-placement': true
            },
            paint: {
                'text-color': '#ffffff',
                'text-halo-color': 'rgba(15,23,42,0.55)',
                'text-halo-width': 1
            }
        });
    }

    // --- Layer pin singolo ---

    // Area di hit invisibile: copre il badge e la punta geografica.
    // Raggio e offset seguono la scala del marker con lo zoom.
    if (!map.getLayer('gpx-waypoints-hit-layer')) {
        map.addLayer({
            id: 'gpx-waypoints-hit-layer',
            type: 'circle',
            source: 'gpx-waypoints',
            filter: ['!', ['has', 'point_count']],
            paint: {
                'circle-radius': [
                    'interpolate', ['linear'], ['zoom'],
                    5, 10, 10, 13, 16, 17
                ],
                'circle-color': '#000000',
                'circle-opacity': 0,
                // Sposta l'area di hit verso il centro del badge (sopra la punta)
                'circle-translate': [0, -18],
                'circle-translate-anchor': 'viewport'
            }
        });
    }

    // Badge topografico compatto, scala con lo zoom
    if (!map.getLayer('gpx-waypoints-marker-layer')) {
        map.addLayer({
            id: 'gpx-waypoints-marker-layer',
            type: 'symbol',
            source: 'gpx-waypoints',
            filter: ['!', ['has', 'point_count']],
            layout: {
                'icon-image': ['get', 'imageId'],   // selezione dinamica per colore traccia + simbolo
                'icon-anchor': 'bottom',
                // Piccolo da lontano, pieno formato da vicino
                'icon-size': [
                    'interpolate', ['linear'], ['zoom'],
                    5, 0.58, 10, 0.78, 13, 0.92, 16, 1.05
                ],
                'icon-allow-overlap': true,
                'icon-ignore-placement': true
            }
        });
    }

    if (!map.getLayer('gpx-waypoints-label-layer')) {
        map.addLayer({
            id: 'gpx-waypoints-label-layer',
            type: 'symbol',
            source: 'gpx-waypoints',
            filter: ['!', ['has', 'point_count']],
            minzoom: 12,
            layout: {
                'text-field': ['coalesce', ['get', 'name'], 'Waypoint'],
                // NB: un solo font: con piu' font MapLibre richiede il fontstack COMBINATO
                // ("Open Sans Semibold,Arial Unicode MS Bold") che sul glyph server
                // demotiles risponde 404 -> nessuna etichetta renderizzata.
                'text-font': ['Open Sans Semibold'],
                'text-size': [
                    'interpolate', ['linear'], ['zoom'], 12, 10, 16, 11.5
                ],
                'text-anchor': 'left',
                'text-offset': [0.85, -1.55],
                'text-allow-overlap': false,
                'text-ignore-placement': false
            },
            paint: {
                'text-color': '#111827',
                'text-halo-color': 'rgba(255,255,255,0.96)',
                'text-halo-width': 1.6
            }
        });
    }

    updateWaypointsOnMap();
}

export function updateWaypointsOnMap() {
    const src = map.getSource('gpx-waypoints');
    if (!src) return;
    src.setData(buildWaypointFeatureCollection());
}

export function bindWaypointInteractions() {
    if (_waypointInteractionsBound) return;
    _waypointInteractionsBound = true;

    // Cursor cluster
    map.on('mouseenter', 'gpx-waypoints-cluster-layer', () => {
        if (!isDrawing && !isCutting && !isBoxDeleting && !isAddingWaypoint) {
            map.getCanvas().style.cursor = 'pointer';
        }
    });
    map.on('mouseleave', 'gpx-waypoints-cluster-layer', () => {
        if (!_draggingWaypoint && !isDrawing && !isCutting && !isBoxDeleting && !isAddingWaypoint) {
            map.getCanvas().style.cursor = '';
        }
    });

    // Click su cluster: espandi zoom
    map.on('click', 'gpx-waypoints-cluster-layer', (e) => {
        const feature = e?.features?.[0];
        const clusterId = feature?.properties?.cluster_id;
        const coords = feature?.geometry?.coordinates;
        const src = map.getSource('gpx-waypoints');
        if (!src || clusterId === undefined || !coords) return;
        src.getClusterExpansionZoom(clusterId, (err, zoom) => {
            if (err) return;
            map.easeTo({ center: coords, zoom });
        });
    });

    // Cursor hit area singolo pin
    map.on('mouseenter', 'gpx-waypoints-hit-layer', () => {
        if (!isDrawing && !isCutting && !isBoxDeleting && !isAddingWaypoint) {
            map.getCanvas().style.cursor = 'pointer';
        }
    });
    map.on('mouseleave', 'gpx-waypoints-hit-layer', () => {
        if (!_draggingWaypoint && !isDrawing && !isCutting && !isBoxDeleting && !isAddingWaypoint) {
            map.getCanvas().style.cursor = '';
        }
    });

    // Drag waypoint
    map.on('mousedown', 'gpx-waypoints-hit-layer', (e) => {
        if (isAddingWaypoint) return;
        const ids = getWaypointFeatureFromEvent(e);
        if (!ids) return;
        const found = findWaypoint(ids.trackId, ids.wpId);
        if (!found) return;

        _draggingWaypoint = found;
        _dragMoved = false;
        _dragStartPoint = e.point;
        _suppressNextWaypointClick = false;
        map.dragPan.disable();
        map.getCanvas().style.cursor = 'grabbing';
        e.preventDefault();
    });

    map.on('mousemove', (e) => {
        if (!_draggingWaypoint) return;
        // Ignora il jitter del click: il drag parte solo oltre la soglia in pixel,
        // altrimenti il click di apertura editor verrebbe scambiato per spostamento.
        if (!_dragMoved && _dragStartPoint) {
            const dx = e.point.x - _dragStartPoint.x;
            const dy = e.point.y - _dragStartPoint.y;
            if ((dx * dx + dy * dy) < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
            _dragMoved = true;
        }
        _draggingWaypoint.wp.lon = e.lngLat.lng;
        _draggingWaypoint.wp.lat = e.lngLat.lat;
        updateWaypointsOnMap();
    });

    map.on('mouseup', async () => {
        if (!_draggingWaypoint) return;
        const dragged = _draggingWaypoint;
        _draggingWaypoint = null;
        map.dragPan.enable();
        map.getCanvas().style.cursor = '';

        if (!_dragMoved) return;

        _suppressNextWaypointClick = true;
        try {
            const ele = await queryElevation(dragged.wp.lon, dragged.wp.lat);
            if (typeof ele === 'number' && !isNaN(ele)) {
                dragged.wp.ele = ele;
            }
        } catch (_) {}
        saveHistoryState();
        updateMapData();
        showToast(`Waypoint spostato`, "info");
    });

    // Click su pin: apri editor
    map.on('click', 'gpx-waypoints-hit-layer', (e) => {
        if (isAddingWaypoint) return;
        if (_suppressNextWaypointClick) {
            _suppressNextWaypointClick = false;
            return;
        }
        const ids = getWaypointFeatureFromEvent(e);
        if (!ids) return;
        openWaypointEditor(ids.trackId, ids.wpId);
        e.preventDefault();
    });
}

export function openWaypointEditor(trackId, wpId) {
    const track = tracks.find(t => t.id === trackId);
    if (!track) return;
    const wp = track.waypoints.find(w => w.id === wpId);
    if (!wp) return;

    setActiveWpForEdit({ trackId, wpId });
    document.getElementById('wp-title').value = wp.name;
    document.getElementById('wp-desc').value = wp.desc;
    document.getElementById('wp-symbol').value = wp.symbol;

    document.getElementById('modal-waypoint').classList.remove('hidden');
}

export function saveWaypointModifications() {
    if (!activeWpForEdit.trackId || !activeWpForEdit.wpId) return;
    const track = tracks.find(t => t.id === activeWpForEdit.trackId);
    if (track) {
        const wp = track.waypoints.find(w => w.id === activeWpForEdit.wpId);
        if (wp) {
            wp.name = document.getElementById('wp-title').value;
            wp.desc = document.getElementById('wp-desc').value;
            wp.symbol = document.getElementById('wp-symbol').value;
            saveHistoryState();
            updateMapData();
            showToast("Waypoint salvato!", "success");
        }
    }

    document.getElementById('modal-waypoint').classList.add('hidden');
    setActiveWpForEdit({ trackId: null, wpId: null });
}
