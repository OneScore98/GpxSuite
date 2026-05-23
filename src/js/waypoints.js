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
    const feature = e ? .features ? .[0];
    if (!feature ? .properties) return null;
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
                'circle-radius': 16,
                'circle-color': '#000000',
                'circle-opacity': 0
            }
        });
    }

    if (!map.getLayer('gpx-waypoints-circle-layer')) {
        map.addLayer({
            id: 'gpx-waypoints-circle-layer',
            type: 'circle',
            source: 'gpx-waypoints',
            filter: ['!', ['has', 'point_count']],
            minzoom: 12,
            paint: {
                'circle-radius': [
                    'interpolate', ['linear'],
                    ['zoom'],
                    12, 5,
                    14, 7,
                    17, 9
                ],
                'circle-color': ['get', 'color'],
                'circle-opacity': 0.95,
                'circle-stroke-width': [
                    'interpolate', ['linear'],
                    ['zoom'],
                    6, 1.2,
                    14, 2,
                    17, 2.5
                ],
                'circle-stroke-color': 'rgba(255,255,255,0.96)'
            }
        });
    }

    if (!map.getLayer('gpx-waypoints-ring-layer')) {
        map.addLayer({
            id: 'gpx-waypoints-ring-layer',
            type: 'circle',
            source: 'gpx-waypoints',
            filter: ['!', ['has', 'point_count']],
            minzoom: 13,
            paint: {
                'circle-radius': [
                    'interpolate', ['linear'],
                    ['zoom'],
                    13, 9,
                    14, 11,
                    17, 14
                ],
                'circle-color': 'rgba(255,255,255,0)',
                'circle-stroke-width': [
                    'interpolate', ['linear'],
                    ['zoom'],
                    8, 0.5,
                    14, 1.4,
                    17, 2
                ],
                'circle-stroke-color': ['get', 'color'],
                'circle-opacity': 0.38
            }
        });
    }

    if (!map.getLayer('gpx-waypoints-symbol-layer')) {
        map.addLayer({
            id: 'gpx-waypoints-symbol-layer',
            type: 'symbol',
            source: 'gpx-waypoints',
            filter: ['!', ['has', 'point_count']],
            minzoom: 13,
            layout: {
                'text-field': ['get', 'symbol'],
                'text-size': [
                    'interpolate', ['linear'],
                    ['zoom'],
                    13, 11,
                    17, 14
                ],
                'text-allow-overlap': true,
                'text-ignore-placement': true
            },
            paint: {
                'text-color': '#ffffff',
                'text-halo-color': 'rgba(15,23,42,0.62)',
                'text-halo-width': 1
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
        const feature = e ? .features ? .[0];
        const clusterId = feature ? .properties ? .cluster_id;
        const coords = feature ? .geometry ? .coordinates;
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