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
const ID_MARKER_WAYPOINT_LEAFLET = 'gpx-waypoint-leaflet-marker';
const URL_ICONA_WAYPOINT_LEAFLET = 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png';
const URL_OMBRA_WAYPOINT_LEAFLET = 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png';
let _markerWaypointLeaflet = null;
let _markerWaypointLeafletPromise = null;
const _immaginiWaypointLeaflet = new Map();

function caricaImmagineWaypointLeaflet(url) {
    if (_immaginiWaypointLeaflet.has(url)) return _immaginiWaypointLeaflet.get(url);

    const promise = new Promise((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.onload = () => resolve(image);
        image.onerror = () => {
            _immaginiWaypointLeaflet.delete(url);
            reject(new Error(`Impossibile caricare ${url}`));
        };
        image.src = url;
    });

    _immaginiWaypointLeaflet.set(url, promise);
    return promise;
}

function costruisciMarkerWaypointLeaflet() {
    if (_markerWaypointLeaflet) return Promise.resolve(_markerWaypointLeaflet);
    if (_markerWaypointLeafletPromise) return _markerWaypointLeafletPromise;

    _markerWaypointLeafletPromise = Promise.all([
        caricaImmagineWaypointLeaflet(URL_ICONA_WAYPOINT_LEAFLET),
        caricaImmagineWaypointLeaflet(URL_OMBRA_WAYPOINT_LEAFLET)
    ]).then(([icona, ombra]) => {
        const scala = 2;
        const larghezza = 58;
        const altezza = 41;
        const ancoraX = 12;
        const x = (larghezza / 2) - ancoraX;
        const canvas = document.createElement('canvas');
        canvas.width = larghezza * scala;
        canvas.height = altezza * scala;
        const ctx = canvas.getContext('2d');
        ctx.scale(scala, scala);
        ctx.drawImage(ombra, x, 0, 41, 41);
        ctx.drawImage(icona, x, 0, 25, 41);
        _markerWaypointLeaflet = {
            imageData: ctx.getImageData(0, 0, canvas.width, canvas.height),
            pixelRatio: scala
        };
        return _markerWaypointLeaflet;
    }).catch(err => {
        _markerWaypointLeafletPromise = null;
        throw err;
    });

    return _markerWaypointLeafletPromise;
}

function registraMarkerWaypointLeaflet() {
    if (!map || map.hasImage(ID_MARKER_WAYPOINT_LEAFLET)) return;

    costruisciMarkerWaypointLeaflet()
        .then(({ imageData, pixelRatio }) => {
            if (!map || map.hasImage(ID_MARKER_WAYPOINT_LEAFLET)) return;
            map.addImage(ID_MARKER_WAYPOINT_LEAFLET, imageData, { pixelRatio });
        })
        .catch(err => console.warn('Errore caricamento marker waypoint Leaflet:', err));
}

function buildWaypointFeatureCollection() {
    const features = [];
    for (let ti = 0; ti < tracks.length; ti++) {
        const track = tracks[ti];
        if (track.visible === false || track.waypointsVisible === false) continue;
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
                    color: track.color || '#3b82f6'
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
    const feature = e ?.features ?.[0];
    if (!feature ?.properties) return null;
    const trackId = feature.properties.trackId;
    const wpId = feature.properties.wpId;
    if (!trackId || !wpId) return null;
    return { trackId, wpId };
}

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
        desc: 'Nessun dettaglio inserito',
        symbol: '📍',
        lat: lat,
        lon: lon,
        ele: 0,
        visible: true
    };
    newWp.ele = await queryElevation(lon, lat);
    track.waypoints.push(newWp);
    saveHistoryState();
    updateMapData();
    showToast(`Waypoint aggiunto a: ${track.name}`, "success");
    setIsAddingWaypoint(false);
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
    registraMarkerWaypointLeaflet();

    if (!map.getLayer('gpx-waypoints-cluster-halo-layer')) {
        map.addLayer({
            id: 'gpx-waypoints-cluster-halo-layer',
            type: 'circle',
            source: 'gpx-waypoints',
            filter: ['has', 'point_count'],
            paint: {
                'circle-radius': [
                    'step', ['get', 'point_count'],
                    14,
                    10, 17,
                    50, 21,
                    200, 25
                ],
                'circle-color': [
                    'step', ['get', 'point_count'],
                    '#38bdf8',
                    10, '#22c55e',
                    50, '#f59e0b',
                    200, '#ef4444'
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
                    10,
                    10, 12,
                    50, 15,
                    200, 18
                ],
                'circle-color': [
                    'step', ['get', 'point_count'],
                    '#0284c7',
                    10, '#16a34a',
                    50, '#d97706',
                    200, '#dc2626'
                ],
                'circle-opacity': 0.94,
                'circle-stroke-width': [
                    'interpolate', ['linear'],
                    ['zoom'],
                    4, 1.5,
                    12, 2.5
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
                    'step', ['get', 'point_count'],
                    11,
                    50, 12,
                    200, 13
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

    if (!map.getLayer('gpx-waypoints-hit-layer')) {
        map.addLayer({
            id: 'gpx-waypoints-hit-layer',
            type: 'circle',
            source: 'gpx-waypoints',
            filter: ['!', ['has', 'point_count']],
            minzoom: 12,
            paint: {
                'circle-radius': 22,
                'circle-color': '#000000',
                'circle-opacity': 0,
                'circle-translate': [0, -20],
                'circle-translate-anchor': 'viewport'
            }
        });
    }

    if (!map.getLayer('gpx-waypoints-marker-layer')) {
        map.addLayer({
            id: 'gpx-waypoints-marker-layer',
            type: 'symbol',
            source: 'gpx-waypoints',
            filter: ['!', ['has', 'point_count']],
            minzoom: 12,
            layout: {
                'icon-image': ID_MARKER_WAYPOINT_LEAFLET,
                'icon-anchor': 'bottom',
                'icon-size': 1,
                'icon-allow-overlap': true,
                'icon-ignore-placement': true
            }
        });
    }
}

export function updateWaypointsOnMap() {
    const src = map.getSource('gpx-waypoints');
    if (!src) return;
    src.setData(buildWaypointFeatureCollection());
}

export function bindWaypointInteractions() {
    if (_waypointInteractionsBound) return;
    _waypointInteractionsBound = true;

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

    map.on('click', 'gpx-waypoints-cluster-layer', (e) => {
        const feature = e ?.features ?.[0];
        const clusterId = feature ?.properties ?.cluster_id;
        const coords = feature ?.geometry ?.coordinates;
        const src = map.getSource('gpx-waypoints');
        if (!src || clusterId === undefined || !coords) return;
        src.getClusterExpansionZoom(clusterId, (err, zoom) => {
            if (err) return;
            map.easeTo({
                center: coords,
                zoom
            });
        });
    });

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

    map.on('mouseup', async() => {
        if (!_draggingWaypoint) return;
        const dragged = _draggingWaypoint;
        _draggingWaypoint = null;
        map.dragPan.enable();
        map.getCanvas().style.cursor = '';

        if (!_dragMoved) return;

        _suppressNextWaypointClick = true;
        const ele = await queryElevation(dragged.wp.lon, dragged.wp.lat);
        dragged.wp.ele = ele;
        saveHistoryState();
        updateMapData();
        showToast(`Waypoint spostato a quota ${ele}m`, "info");
    });

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
