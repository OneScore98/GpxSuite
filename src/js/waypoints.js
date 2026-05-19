// waypoints.js — addWaypointAtCoords, openWaypointEditor, saveWaypointModifications,
//                waypoint layers MapLibre e interazioni fluide

import {
    tracks,
    activeTrackId,
    activeWpForEdit, setActiveWpForEdit,
    isAddingWaypoint, setIsAddingWaypoint,
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
    const feature = e?.features?.[0];
    if (!feature?.properties) return null;
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
            data: { type: 'FeatureCollection', features: [] }
        });
    }

    if (!map.getLayer('gpx-waypoints-hit-layer')) {
        map.addLayer({
            id: 'gpx-waypoints-hit-layer',
            type: 'circle',
            source: 'gpx-waypoints',
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
            paint: {
                'circle-radius': 10,
                'circle-color': ['get', 'color'],
                'circle-opacity': 0.9,
                'circle-stroke-width': 2,
                'circle-stroke-color': '#ffffff'
            }
        });
    }

    if (!map.getLayer('gpx-waypoints-symbol-layer')) {
        map.addLayer({
            id: 'gpx-waypoints-symbol-layer',
            type: 'symbol',
            source: 'gpx-waypoints',
            layout: {
                'text-field': ['get', 'symbol'],
                'text-size': 14,
                'text-allow-overlap': true,
                'text-ignore-placement': true
            },
            paint: {
                'text-color': '#ffffff'
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

    map.on('mouseenter', 'gpx-waypoints-hit-layer', () => {
        map.getCanvas().style.cursor = 'pointer';
    });

    map.on('mouseleave', 'gpx-waypoints-hit-layer', () => {
        if (!_draggingWaypoint) map.getCanvas().style.cursor = '';
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
