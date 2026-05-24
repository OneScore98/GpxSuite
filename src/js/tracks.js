// tracks.js — addPointToActiveSegment, cutTrackAtPoint, handleBoxDeleteClick,
//             fetchSnapRoute, saveHistoryState, triggerUndo, setSnapProfile

import {
    OSRM_ENDPOINTS,
    tracks, setTracks,
    activeTrackId, setActiveTrackId,
    activeSegmentId, setActiveSegmentId,
    undoStack, setUndoStack,
    isSnapActive, setIsSnapActive,
    currentSnapProfile, setCurrentSnapProfile,
    isCutting, setIsCutting,
    isBoxDeleting, setIsBoxDeleting,
    boxDeleteCoords, setBoxDeleteCoords,
    boxDeleteMarker, setBoxDeleteMarker,
    map
} from './state.js';

import { updateMapData, updateBoxDeletePreview } from './map.js';
import { queryElevation } from './map.js';
import { showToast, updateActiveTracksHeader, createNewTrack } from './ui.js';
import { haversineDistance } from './stats.js';
import { schedulePersistAppSession, schedulePersistTracks } from './storage.js';

// Throttle: su file enormi JSON.stringify dell'intero state può richiedere
// 100+ ms. Se l'utente fa molte modifiche rapide (es. tracciamento continuo),
// raggruppiamo: lo snapshot viene differito a idle e collassato in uno solo.
let _historyIdleHandle = null;
let _historyPending = false;

export function saveHistoryState(options = {}) {
    _historyPending = true;
    document.getElementById('btn-undo').disabled = false;
    if (_historyIdleHandle !== null) return;
    const idleTimeout = options.idleTimeout || 800;
    const flush = () => {
        _historyIdleHandle = null;
        if (!_historyPending) return;
        _historyPending = false;
        // Stringify lazy: ora il main thread è probabilmente idle
        const stateCopy = JSON.stringify({ tracks });
        undoStack.push(stateCopy);
        if (undoStack.length > 30) undoStack.shift();
        schedulePersistTracks(tracks);
    };
    if (window.requestIdleCallback) {
        _historyIdleHandle = window.requestIdleCallback(flush, { timeout: idleTimeout });
    } else {
        _historyIdleHandle = setTimeout(flush, Math.min(idleTimeout, 1200));
    }
}

export function triggerUndo() {
    if (undoStack.length <= 1) {
        showToast("Nessuna altra operazione da annullare", "info");
        return;
    }

    undoStack.pop();
    const prevState = JSON.parse(undoStack[undoStack.length - 1]);

    setTracks(prevState.tracks);
    if (tracks.length > 0) {
        setActiveTrackId(tracks[tracks.length - 1].id);
        const activeTrack = tracks.find(t => t.id === activeTrackId);
        if (activeTrack.segments.length > 0) {
            setActiveSegmentId(activeTrack.segments[activeTrack.segments.length - 1].id);
        }
    } else {
        setActiveTrackId(null);
        setActiveSegmentId(null);
    }

    updateMapData();
    showToast("Annullato con successo!", "success");
    schedulePersistTracks(tracks);
    schedulePersistAppSession();

    if (undoStack.length <= 1) {
        document.getElementById('btn-undo').disabled = true;
    }
}

function ensureActiveEditableSegment() {
    if (!activeTrackId || tracks.length === 0) {
        createNewTrack();
    }

    let track = tracks.find(t => t.id === activeTrackId) || tracks[tracks.length - 1] || null;
    if (!track) return { track: null, segment: null };

    if (track.id !== activeTrackId) {
        setActiveTrackId(track.id);
    }

    if (track.visible === false) {
        track.visible = true;
    }

    if (!Array.isArray(track.segments) || track.segments.length === 0) {
        track.segments = [{
            id: 'seg_' + Date.now(),
            name: 'Tracciato 1',
            points: [],
            visible: true
        }];
    }

    let segment = track.segments.find(s => s.id === activeSegmentId) || null;
    if (!segment) {
        segment = track.segments[track.segments.length - 1];
        setActiveSegmentId(segment.id);
    }

    if (segment.visible === false) {
        segment.visible = true;
    }

    return { track, segment };
}

export async function addPointToActiveSegment(lon, lat) {
    const { track, segment } = ensureActiveEditableSegment();
    if (!track || !segment) {
        showToast("Impossibile trovare un segmento attivo per il disegno", "error");
        return;
    }

    if (segment.points.length === 0 || !isSnapActive) {
        const point = {
            lat: lat,
            lon: lon,
            ele: 0,
            isUserClicked: true
        };
        segment.points.push(point);
        saveHistoryState({ idleTimeout: 2500 });
        updateMapData();
        queryElevation(lon, lat).then(ele => {
            point.ele = ele;
            updateMapData();
            schedulePersistTracks(tracks);
        });
        return;
    }

    const lastPoint = segment.points[segment.points.length - 1];
    showToast("Calcolo percorso...", "info");

    try {
        const routePoints = await fetchSnapRoute(lastPoint, { lon, lat }, currentSnapProfile);
        if (routePoints && routePoints.length > 0) {
            routePoints.forEach((pt, i) => {
                const isEndpoint = i === routePoints.length - 1;
                segment.points.push({
                    lat: pt[0],
                    lon: pt[1],
                    ele: pt[2] || 0,
                    isUserClicked: isEndpoint,
                    needsElevation: true
                });
            });
        } else {
            segment.points.push({
                lat: lat,
                lon: lon,
                ele: 0,
                isUserClicked: true,
                needsElevation: true
            });
        }
    } catch (err) {
        console.warn('Errore routing OSRM:', err);
        showToast("Routing non disponibile: punto aggiunto in linea d'aria", "error");
        segment.points.push({
            lat: lat,
            lon: lon,
            ele: 0,
            isUserClicked: true,
            needsElevation: true
        });
    }

    saveHistoryState({ idleTimeout: 2500 });
    updateMapData();
}

function snapRouteCandidates(profile) {
    const endpoints = [];
    const brouterProfile = profile === 'bike' ? 'fastbike' : (profile === 'foot' ? 'trekking' : 'car-fast');
    endpoints.push({ type: 'brouter', profile: brouterProfile, label: `BRouter ${brouterProfile}` });

    const primary = OSRM_ENDPOINTS[profile] || OSRM_ENDPOINTS.foot;
    endpoints.push({ type: 'osrm', url: primary, label: `OSRM ${profile}` });

    if (profile === 'foot') {
        endpoints.push({ type: 'osrm', url: 'https://routing.openstreetmap.de/routed-foot/route/v1/driving/', label: 'OSRM foot fallback' });
    } else if (profile === 'bike') {
        endpoints.push({ type: 'osrm', url: 'https://routing.openstreetmap.de/routed-bike/route/v1/driving/', label: 'OSRM bike fallback' });
    } else {
        endpoints.push({ type: 'osrm', url: 'https://router.project-osrm.org/route/v1/driving/', label: 'OSRM demo fallback' });
    }

    return endpoints;
}

async function fetchJsonWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 9000);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`${options.label || 'route'} ${response.status}`);
        return await response.json();
    } finally {
        clearTimeout(timeout);
    }
}

function parseRouteCoordinates(coords) {
    if (!Array.isArray(coords) || coords.length < 2) return null;
    const parsedPoints = [];
    for (let i = 1; i < coords.length; i++) {
        const c = coords[i];
        if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
        parsedPoints.push([c[1], c[0], Number.isFinite(c[2]) ? Math.round(c[2]) : 0]);
    }
    return parsedPoints.length > 0 ? parsedPoints : null;
}

async function fetchOsrmSnapRoute(from, to, endpoint) {
    const url = `${endpoint.url}${from.lon},${from.lat};${to.lon},${to.lat}?geometries=geojson&overview=full`;
    const data = await fetchJsonWithTimeout(url, { label: endpoint.label });

    if (data.code === 'Ok' && data.routes && data.routes.length > 0) {
        return parseRouteCoordinates(data.routes[0].geometry.coordinates);
    }
    throw new Error(`${endpoint.label} ${data.code || 'NoRoute'}`);
}

async function fetchBrouterSnapRoute(from, to, endpoint) {
    const lonlats = `${from.lon},${from.lat}|${to.lon},${to.lat}`;
    const params = new URLSearchParams({
        lonlats,
        profile: endpoint.profile,
        alternativeidx: '0',
        format: 'geojson'
    });
    const data = await fetchJsonWithTimeout(`https://brouter.de/brouter?${params.toString()}`, { label: endpoint.label, timeoutMs: 12000 });
    const coords = data.features?.[0]?.geometry?.coordinates;
    const parsed = parseRouteCoordinates(coords);
    if (parsed) return parsed;
    throw new Error(`${endpoint.label} NoRoute`);
}

export async function fetchSnapRoute(from, to, profile) {
    const errors = [];
    const endpoints = snapRouteCandidates(profile);

    for (let i = 0; i < endpoints.length; i++) {
        const endpoint = endpoints[i];
        try {
            const route = endpoint.type === 'brouter' ?
                await fetchBrouterSnapRoute(from, to, endpoint) :
                await fetchOsrmSnapRoute(from, to, endpoint);
            if (route && route.length > 0) return route;
        } catch (err) {
            errors.push(`${endpoint.label}: ${err.message}`);
        }
    }

    throw new Error(errors.join(' | '));
}

export function cutTrackAtPoint(lngLat) {
    let segmentCut = false;

    for (let tIdx = 0; tIdx < tracks.length; tIdx++) {
        let track = tracks[tIdx];
        for (let sIdx = 0; sIdx < track.segments.length; sIdx++) {
            let seg = track.segments[sIdx];

            if (seg.points.length < 4) continue;

            let minDist = Infinity;
            let cutIndex = -1;

            seg.points.forEach((pt, index) => {
                const d = haversineDistance(lngLat.lng, lngLat.lat, pt.lon, pt.lat);
                if (d < minDist && d < 0.2) {
                    minDist = d;
                    cutIndex = index;
                }
            });

            if (cutIndex > 1 && cutIndex < seg.points.length - 2) {
                const firstHalf = seg.points.slice(0, cutIndex + 1);
                const secondHalf = seg.points.slice(cutIndex);

                const newSegId = 'seg_' + Date.now();

                seg.points = firstHalf;

                track.segments.splice(sIdx + 1, 0, {
                    id: newSegId,
                    name: `${seg.name} (Parte 2)`,
                    points: secondHalf
                });

                segmentCut = true;
                setActiveSegmentId(newSegId);
                break;
            }
        }
        if (segmentCut) break;
    }

    if (segmentCut) {
        saveHistoryState();
        updateMapData();
        showToast("Tracciato diviso in due segmenti!", "success");
    } else {
        showToast("Punto di taglio non valido o troppo lontano dalla linea", "error");
    }

    setIsCutting(false);
}

export function handleBoxDeleteClick(lngLat) {
    if (!boxDeleteCoords) {
        setBoxDeleteCoords(lngLat);
        updateBoxDeletePreview(lngLat, lngLat);
        const marker = new maplibregl.Marker({ color: '#ef4444' })
            .setLngLat(lngLat)
            .addTo(map);
        setBoxDeleteMarker(marker);
        showToast("Seleziona il secondo punto del rettangolo", "info");
    } else {
        const p1 = boxDeleteCoords;
        const p2 = lngLat;

        const minLng = Math.min(p1.lng, p2.lng);
        const maxLng = Math.max(p1.lng, p2.lng);
        const minLat = Math.min(p1.lat, p2.lat);
        const maxLat = Math.max(p1.lat, p2.lat);

        let countDeleted = 0;

        tracks.forEach(track => {
            track.segments.forEach(seg => {
                const initialLength = seg.points.length;
                seg.points = seg.points.filter(pt => {
                    const inBox = pt.lon >= minLng && pt.lon <= maxLng && pt.lat >= minLat && pt.lat <= maxLat;
                    if (inBox) countDeleted++;
                    return !inBox;
                });
            });
        });

        if (countDeleted > 0) {
            saveHistoryState();
            updateMapData();
            showToast(`Eliminati ${countDeleted} punti all'interno del rettangolo`, "success");
        } else {
            showToast("Nessun punto trovato all'interno dell'area selezionata", "info");
        }

        setIsBoxDeleting(false);
        setBoxDeleteCoords(null);
        updateBoxDeletePreview(null, null);
        if (boxDeleteMarker) {
            boxDeleteMarker.remove();
            setBoxDeleteMarker(null);
        }
    }
}

export function setSnapProfile(profile, options = {}) {
    setCurrentSnapProfile(profile);
    setIsSnapActive(profile !== 'off');

    const profiles = ['off', 'foot', 'bike', 'moto', 'car'];
    profiles.forEach(p => {
        const el = document.getElementById(`snap-profile-${p}`);
        if (p === profile) {
            el.className = "text-[10px] font-bold py-1 rounded bg-blue-600 text-white";
        } else {
            el.className = "text-[10px] py-1 rounded bg-gray-800 text-gray-400 hover:text-white";
        }
    });

    const indicator = document.getElementById('snap-indicator');
    const badge = document.getElementById('routing-badge');
    if (profile !== 'off') {
        indicator.className = "absolute bottom-1 right-1 w-2 h-2 rounded-full bg-green-500 border border-gray-950 animate-pulse";
        badge.innerText = `Attivo (${profile.toUpperCase()})`;
        badge.className = "text-[9px] bg-green-950 text-green-400 px-1.5 py-0.5 rounded border border-green-900 font-bold uppercase";
        if (!options.silent) {
            showToast(`Snap stradale attivato: Profilo ${profile.toUpperCase()}`, 'success');
        }
    } else {
        indicator.className = "absolute bottom-1 right-1 w-2 h-2 rounded-full bg-red-500 border border-gray-950";
        badge.innerText = "Disattivato";
        badge.className = "text-[9px] bg-red-950 text-red-400 px-1.5 py-0.5 rounded border border-red-900 font-bold uppercase";
        if (!options.silent) {
            showToast("Snap disattivato: Disegno in linea d'aria", 'info');
        }
    }

    schedulePersistAppSession();
}
