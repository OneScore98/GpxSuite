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
import { showToast } from './ui.js';

let _waypointInteractionsBound = false;
let _draggingWaypoint = null;
let _dragMoved = false;
let _suppressNextWaypointClick = false;

// Cache immagini pin per colore (color -> imageId)
const _pinImageCache = new Map();
const ID_PIN_PREFIX = 'gpx-wp-pin-';

// Disegna un pin stile Leaflet classico per il colore dato
function disegnaPinLeaflet(color) {
    const scala = 2;
    const larghezza = 30;
    const altezza = 44;
    const canvas = document.createElement('canvas');
    canvas.width = larghezza * scala;
    canvas.height = altezza * scala;
    const ctx = canvas.getContext('2d');
    ctx.scale(scala, scala);

    const cx = larghezza / 2; // 15

    // Ombra ellittica sotto la punta
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.ellipse(cx, altezza - 1.5, 7, 2.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Corpo del pin (teardrop)
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 5;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 2;

    ctx.beginPath();
    ctx.moveTo(cx, altezza - 3);                          // punta in basso
    ctx.bezierCurveTo(cx - 3, altezza - 10, 3, 26, 3, 15);  // lato sinistro
    ctx.bezierCurveTo(3, 7, 8, 2.5, cx, 2.5);             // curva in alto a sx
    ctx.bezierCurveTo(cx + 7, 2.5, larghezza - 3, 7, larghezza - 3, 15); // curva in alto a dx
    ctx.bezierCurveTo(larghezza - 3, 26, cx + 3, altezza - 10, cx, altezza - 3); // lato destro
    ctx.closePath();

    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.restore();

    // Cerchio bianco interno (il "buco" classico del pin Leaflet)
    ctx.beginPath();
    ctx.arc(cx, 15, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.fill();

    return {
        imageData: ctx.getImageData(0, 0, canvas.width, canvas.height),
        pixelRatio: scala
    };
}

// Restituisce l'imageId del pin per questo colore, registrandolo se necessario
function getOrRegisterPinImage(color) {
    const safeColor = (color || '#3b82f6').replace('#', '');
    const imageId = ID_PIN_PREFIX + safeColor;
    if (!map) return imageId;
    if (!_pinImageCache.has(color) && !map.hasImage(imageId)) {
        const { imageData, pixelRatio } = disegnaPinLeaflet(color || '#3b82f6');
        map.addImage(imageId, imageData, { pixelRatio });
    }
    _pinImageCache.set(color, imageId);
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
        const imageId = getOrRegisterPinImage(trackColor);
        for (let wi = 0; wi < track.waypoints.length; wi++) {
            const wp = track.waypoints[wi];
            if (wp.visible === false) continue;
            features.push({
                type: 'Feature',
                properties: {
                    trackId: track.id,
                    wpId: wp.id,
                    name: wp.name,
                    symbol: wp.symbol || '📍',
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
    updateMapData();
    showToast(`Waypoint "${wpName}" aggiunto`, "success");
    saveHistoryState();

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
                    14, 10, 17, 50, 21, 200, 25
                ],
                'circle-color': [
                    'step', ['get', 'point_count'],
                    '#38bdf8', 10, '#22c55e', 50, '#f59e0b', 200, '#ef4444'
                ],
                'circle-opacity': 0.18,
                'circle-blur': 0.35
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
                    10, 10, 12, 50, 15, 200, 18
                ],
                'circle-color': [
                    'step', ['get', 'point_count'],
                    '#0284c7', 10, '#16a34a', 50, '#d97706', 200, '#dc2626'
                ],
                'circle-opacity': 0.94,
                'circle-stroke-width': [
                    'interpolate', ['linear'], ['zoom'], 4, 1.5, 12, 2.5
                ],
                'circle-stroke-color': 'rgba(255,255,255,0.92)'
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
                'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
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

    // Area di hit invisibile: copre il corpo del pin (punta in basso, testa in alto)
    if (!map.getLayer('gpx-waypoints-hit-layer')) {
        map.addLayer({
            id: 'gpx-waypoints-hit-layer',
            type: 'circle',
            source: 'gpx-waypoints',
            filter: ['!', ['has', 'point_count']],
            paint: {
                'circle-radius': 20,
                'circle-color': '#000000',
                'circle-opacity': 0,
                // Sposta l'area di hit verso il centro del pin (sopra la punta)
                'circle-translate': [0, -16],
                'circle-translate-anchor': 'viewport'
            }
        });
    }

    // Pin teardrop colorato con icona per-colore traccia
    if (!map.getLayer('gpx-waypoints-marker-layer')) {
        map.addLayer({
            id: 'gpx-waypoints-marker-layer',
            type: 'symbol',
            source: 'gpx-waypoints',
            filter: ['!', ['has', 'point_count']],
            layout: {
                'icon-image': ['get', 'imageId'],   // selezione dinamica per colore traccia
                'icon-anchor': 'bottom',
                'icon-size': 1,
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
            minzoom: 9,
            layout: {
                'text-field': ['coalesce', ['get', 'name'], 'Waypoint'],
                'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
                'text-size': [
                    'interpolate', ['linear'], ['zoom'], 9, 10, 14, 12
                ],
                'text-anchor': 'top',
                'text-offset': [0, 0.35],
                'text-allow-overlap': false,
                'text-ignore-placement': false
            },
            paint: {
                'text-color': '#0f172a',
                'text-halo-color': 'rgba(255,255,255,0.94)',
                'text-halo-width': 1.8
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
        _suppressNextWaypointClick = false;
        map.dragPan.disable();
        map.getCanvas().style.cursor = 'grabbing';
        e.preventDefault();
    });

    map.on('mousemove', (e) => {
        if (!_draggingWaypoint) return;
        _dragMoved = true;
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
