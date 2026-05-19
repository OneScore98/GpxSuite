// waypoints.js — addWaypointAtCoords, openWaypointEditor, saveWaypointModifications, updateWaypointsOnMap

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

export function updateWaypointsOnMap() {
    const currentMarkers = document.querySelectorAll('.marker-waypoint-pin');
    currentMarkers.forEach(m => m.remove());
    tracks.forEach(track => {
        if (track.visible === false || track.waypointsVisible === false) return;
        track.waypoints.forEach(wp => {
            if (wp.visible === false) return;
            const el = document.createElement('div');
            el.className = 'marker-waypoint-pin cursor-pointer text-xl filter drop-shadow-md select-none transition-all hover:scale-125';
            el.innerText = wp.symbol || '📍';
            el.id = `map-wp-${wp.id}`;
            let isDraggingWp = false;
            el.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                isDraggingWp = true;
                map.getCanvas().style.cursor = 'grabbing';

                function onMouseMove(moveEvent) {
                    if (!isDraggingWp) return;
                    const coords = map.unproject([moveEvent.clientX, moveEvent.clientY]);
                    wp.lon = coords.lng;
                    wp.lat = coords.lat;
                }

                function onMouseUp() {
                    if (isDraggingWp) {
                        isDraggingWp = false;
                        map.getCanvas().style.cursor = '';
                        window.removeEventListener('mousemove', onMouseMove);
                        window.removeEventListener('mouseup', onMouseUp);
                        queryElevation(wp.lon, wp.lat).then(ele => {
                            wp.ele = ele;
                            saveHistoryState();
                            updateMapData();
                            showToast(`Waypoint spostato a quota ${ele}m`, "info");
                        });
                    }
                }
                window.addEventListener('mousemove', onMouseMove);
                window.addEventListener('mouseup', onMouseUp);
            });
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                openWaypointEditor(track.id, wp.id);
            });
            new maplibregl.Marker({
                    element: el
                })
                .setLngLat([wp.lon, wp.lat])
                .addTo(map);
        });
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
