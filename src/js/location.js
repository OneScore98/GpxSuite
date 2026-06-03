// location.js - geolocalizzazione dispositivo, follow camera e marker orientato

import {
    map,
    mapLoaded,
    tracks,
    setActiveTrackId,
    setActiveSegmentId
} from './state.js';
import { escapeXml, generateDistinctTrackColor } from './utils.js';

const INITIAL_LOCATION_ZOOM = 16.5;
const MOVEMENT_MIN_DISTANCE_M = 5;
const MOVEMENT_MIN_SPEED_MPS = 0.7;
const FOLLOW_MIN_INTERVAL_MS = 800;
const USER_EXPLORING_RECENTER_DELAY_MS = 12000;
const RECORDING_SOURCE_ID = 'device-recording-track';
const RECORDING_LAYER_ID = 'device-recording-track-layer';
const RECORDING_PREVIEW_THROTTLE_MS = 1000;

const DEFAULT_RECORDING_SETTINGS = {
    minDistanceM: 3,
    minIntervalMs: 1000,
    maxAccuracyM: 50,
    minSpeedMps: 0,
    showLiveTrack: true,
    saveElevation: true,
    livePreviewMaxPoints: 3000,
    trackColor: '#ef4444',
    trackWidth: 4
};

const GEOLOCATION_OPTIONS = {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 15000
};

let _watchId = null;
let _marker = null;
let _markerEl = null;
let _lastFix = null;
let _lastHeading = null;
let _orientationHeading = null;
let _orientationListening = false;
let _orientationRequestToken = 0;
let _waitingForFirstFix = false;
let _isMoving = false;
let _lastFollowAt = 0;
let _userExploringUntil = 0;
let _mapExplorationBound = false;
let _showToast = null;
let _onStatusChange = null;
let _onRecordingStatusChange = null;
let _updateMapData = null;
let _renderGisTree = null;
let _updateActiveTracksHeader = null;
let _schedulePersistTracks = null;
let _saveHistoryState = null;
let _recordingSettings = { ...DEFAULT_RECORDING_SETTINGS };
let _recording = createEmptyRecording();
let _lastRecordingPreviewAt = 0;

export function initDeviceLocation(options = {}) {
    _showToast = typeof options.showToast === 'function' ? options.showToast : null;
    _updateMapData = typeof options.updateMapData === 'function' ? options.updateMapData : null;
    _renderGisTree = typeof options.renderGisTree === 'function' ? options.renderGisTree : null;
    _updateActiveTracksHeader = typeof options.updateActiveTracksHeader === 'function' ? options.updateActiveTracksHeader : null;
    _schedulePersistTracks = typeof options.schedulePersistTracks === 'function' ? options.schedulePersistTracks : null;
    _saveHistoryState = typeof options.saveHistoryState === 'function' ? options.saveHistoryState : null;
}

export function setDeviceLocationStatusHandler(handler) {
    _onStatusChange = typeof handler === 'function' ? handler : null;
    emitStatus();
}

export function isDeviceLocationActive() {
    return _watchId !== null;
}

export function setDeviceRecordingStatusHandler(handler) {
    _onRecordingStatusChange = typeof handler === 'function' ? handler : null;
    emitRecordingStatus();
}

export function getRecordingSettings() {
    return { ..._recordingSettings };
}

export function updateRecordingSettings(settings = {}) {
    const next = { ..._recordingSettings };
    if (Number.isFinite(Number(settings.minDistanceM))) {
        next.minDistanceM = Math.max(0, Number(settings.minDistanceM));
    }
    if (Number.isFinite(Number(settings.minIntervalMs))) {
        next.minIntervalMs = Math.max(0, Number(settings.minIntervalMs));
    }
    if (Number.isFinite(Number(settings.maxAccuracyM))) {
        next.maxAccuracyM = Math.max(1, Number(settings.maxAccuracyM));
    }
    if (Number.isFinite(Number(settings.minSpeedMps))) {
        next.minSpeedMps = Math.max(0, Number(settings.minSpeedMps));
    }
    if (typeof settings.showLiveTrack === 'boolean') {
        next.showLiveTrack = settings.showLiveTrack;
    }
    if (typeof settings.saveElevation === 'boolean') {
        next.saveElevation = settings.saveElevation;
    }
    if (Number.isFinite(Number(settings.livePreviewMaxPoints))) {
        next.livePreviewMaxPoints = Math.max(100, Math.round(Number(settings.livePreviewMaxPoints)));
    }
    if (typeof settings.trackColor === 'string' && /^#[0-9a-f]{6}$/i.test(settings.trackColor)) {
        next.trackColor = settings.trackColor;
    }
    if (Number.isFinite(Number(settings.trackWidth))) {
        next.trackWidth = Math.max(1, Math.min(10, Number(settings.trackWidth)));
    }
    _recordingSettings = next;

    if (_recording.points.length > 0) {
        if (_recordingSettings.showLiveTrack) {
            refreshRecordingPreview(true);
        } else {
            clearRecordingPreview();
        }
    }
    emitRecordingStatus();
}

export function getDeviceRecordingStatus() {
    return buildRecordingStatus();
}

export function getDefaultRecordingName(date = new Date()) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}_rec`;
}

export function startDeviceRecording() {
    if (_recording.state !== 'idle') return false;
    if (!isDeviceLocationActive() && !startDeviceLocation()) return false;

    _recording = {
        state: 'recording',
        startedAt: Date.now(),
        pausedAt: null,
        totalPausedMs: 0,
        points: [],
        lastAcceptedFix: null,
        skipped: 0
    };
    _lastRecordingPreviewAt = 0;
    if (_recordingSettings.showLiveTrack) refreshRecordingPreview(true);
    notify("Registrazione avviata", "success");
    emitRecordingStatus();
    return true;
}

export function pauseDeviceRecording() {
    if (_recording.state !== 'recording') return false;
    _recording.state = 'paused';
    _recording.pausedAt = Date.now();
    notify("Registrazione in pausa", "info");
    emitRecordingStatus();
    return true;
}

export function resumeDeviceRecording() {
    if (_recording.state !== 'paused') return false;
    if (!isDeviceLocationActive() && !startDeviceLocation()) return false;
    if (_recording.pausedAt) {
        _recording.totalPausedMs += Date.now() - _recording.pausedAt;
    }
    _recording.state = 'recording';
    _recording.pausedAt = null;
    notify("Registrazione ripresa", "success");
    emitRecordingStatus();
    return true;
}

export async function finishDeviceRecording(name = getDefaultRecordingName()) {
    if (_recording.state === 'idle') return null;

    const recording = _recording;
    _recording = createEmptyRecording();
    emitRecordingStatus();
    clearRecordingPreview();

    if (recording.points.length === 0) {
        notify("Nessun punto registrato", "error");
        return null;
    }

    const trackName = sanitizeRecordingName(name || getDefaultRecordingName());
    const segmentId = `seg_${Date.now()}_rec`;
    const track = {
        id: `track_${Date.now()}_rec`,
        localFileId: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        localCreatedAt: recording.startedAt || Date.now(),
        localUpdatedAt: Date.now(),
        localSource: 'recording',
        name: trackName,
        desc: 'Registrazione dispositivo',
        color: _recordingSettings.trackColor || generateDistinctTrackColor(tracks.map(item => item.color)),
        width: _recordingSettings.trackWidth || 4,
        visible: true,
        waypointsVisible: true,
        segments: [{
            id: segmentId,
            name: 'Registrazione 1',
            points: recording.points.map(point => ({
                lat: point.lat,
                lon: point.lon,
                ele: point.ele,
                time: point.time,
                isUserClicked: false
            })),
            visible: true
        }],
        waypoints: []
    };

    tracks.push(track);
    setActiveTrackId(track.id);
    setActiveSegmentId(segmentId);
    if (_saveHistoryState) _saveHistoryState();
    if (_updateMapData) _updateMapData(true);
    if (_updateActiveTracksHeader) _updateActiveTracksHeader();
    if (_renderGisTree) _renderGisTree();
    if (_schedulePersistTracks) _schedulePersistTracks(tracks);

    const fileResult = await saveRecordingGpx(track, `${trackName}.gpx`);
    notify(fileResult.savedFile ? "Registrazione salvata" : "Registrazione salvata in mappa", "success");
    return { track, pointsCount: recording.points.length, ...fileResult };
}

export function toggleDeviceLocation() {
    if (_watchId !== null) {
        stopDeviceLocation('manual');
        return false;
    }
    return startDeviceLocation();
}

export function startDeviceLocation() {
    if (!navigator.geolocation) {
        notify("Localizzazione non supportata da questo browser", "error");
        emitStatus({ error: 'unsupported' });
        return false;
    }

    if (!mapLoaded || !map) {
        notify("Mappa non ancora pronta per la localizzazione", "info");
        emitStatus({ error: 'map-not-ready' });
        return false;
    }

    _waitingForFirstFix = true;
    _isMoving = false;
    _lastFix = null;
    _lastHeading = null;
    _lastFollowAt = 0;
    emitStatus();
    bindMapExplorationDetection();
    startOrientationTracking();

    try {
        _watchId = navigator.geolocation.watchPosition(
            handlePosition,
            handleLocationError,
            GEOLOCATION_OPTIONS
        );
    } catch (err) {
        _waitingForFirstFix = false;
        stopOrientationTracking();
        notify("Localizzazione non avviabile in questo contesto", "error");
        emitStatus({ error: 'start-failed' });
        console.error(err);
        return false;
    }

    notify("Richiesta localizzazione in corso", "info");
    emitStatus();
    return true;
}

export function stopDeviceLocation(reason = 'programmatic') {
    if (_watchId !== null) {
        navigator.geolocation.clearWatch(_watchId);
    }

    _watchId = null;
    _waitingForFirstFix = false;
    _isMoving = false;
    _lastFix = null;
    _lastHeading = null;
    _lastFollowAt = 0;
    removeMarker();
    stopOrientationTracking();
    emitStatus();

    if (reason === 'manual') {
        notify("Localizzazione disattivata", "info");
    }
}

function handlePosition(position) {
    const coords = position.coords || {};
    const fix = {
        lon: Number(coords.longitude),
        lat: Number(coords.latitude),
        ele: Number(coords.altitude),
        accuracy: Number(coords.accuracy),
        speed: Number(coords.speed),
        heading: normalizeHeading(coords.heading),
        timestamp: Number(position.timestamp) || Date.now()
    };

    if (!Number.isFinite(fix.lon) || !Number.isFinite(fix.lat)) {
        return;
    }

    const previousFix = _lastFix;
    const distance = previousFix ? distanceMeters(previousFix, fix) : 0;
    const speedMoving = Number.isFinite(fix.speed) && fix.speed >= MOVEMENT_MIN_SPEED_MPS;
    const coordinateMoved = distance >= MOVEMENT_MIN_DISTANCE_M;
    const isFirstFix = previousFix === null;
    const moving = speedMoving || coordinateMoved;
    const heading = resolveHeading(fix, previousFix, distance, moving);

    _lastFix = fix;
    _isMoving = moving;
    _waitingForFirstFix = false;

    ensureMarker();
    updateMarker(fix, moving, heading);

    if (isFirstFix) {
        focusInitialPosition(fix);
        notify("Localizzazione attiva", "success");
    } else if (moving) {
        followPosition(fix);
    }

    captureRecordingPoint(fix);

    emitStatus({
        accuracy: Number.isFinite(fix.accuracy) ? fix.accuracy : null,
        error: null
    });
}

function handleLocationError(error) {
    const message = geolocationErrorMessage(error);
    notify(message, "error");

    if (error && error.code === 1) {
        stopDeviceLocation('permission-denied');
        emitStatus({ error: 'permission-denied' });
        return;
    }

    emitStatus({ error: error?.code || 'unknown' });
}

function focusInitialPosition(fix) {
    if (!mapLoaded || !map) return;
    const currentZoom = typeof map.getZoom === 'function' ? map.getZoom() : 0;
    map.flyTo({
        center: [fix.lon, fix.lat],
        zoom: Math.max(currentZoom, INITIAL_LOCATION_ZOOM),
        duration: 1200,
        essential: true
    });
}

function followPosition(fix) {
    if (!mapLoaded || !map) return;
    const now = Date.now();
    if (now - _lastFollowAt < FOLLOW_MIN_INTERVAL_MS) return;
    if (now < _userExploringUntil) return;
    _lastFollowAt = now;
    map.easeTo({
        center: [fix.lon, fix.lat],
        duration: 550,
        essential: true
    });
}

function bindMapExplorationDetection() {
    if (_mapExplorationBound || !mapLoaded || !map) return;
    _mapExplorationBound = true;

    const markFromMapEvent = event => {
        if (event?.originalEvent) markUserExploring();
    };
    ['dragstart', 'zoomstart', 'rotatestart', 'pitchstart'].forEach(eventName => {
        map.on(eventName, markFromMapEvent);
    });

    const canvas = map.getCanvas?.();
    if (!canvas) return;
    ['wheel', 'mousedown', 'touchstart', 'pointerdown'].forEach(eventName => {
        canvas.addEventListener(eventName, markUserExploring, { passive: true });
    });
}

function markUserExploring() {
    _userExploringUntil = Date.now() + USER_EXPLORING_RECENTER_DELAY_MS;
}

function captureRecordingPoint(fix) {
    if (_recording.state !== 'recording') return;
    if (!shouldAcceptRecordingFix(fix)) {
        _recording.skipped++;
        emitRecordingStatus();
        return;
    }

    const point = {
        lat: fix.lat,
        lon: fix.lon,
        ele: _recordingSettings.saveElevation && Number.isFinite(fix.ele) ? Math.round(fix.ele) : 0,
        time: fix.timestamp,
        accuracy: Number.isFinite(fix.accuracy) ? fix.accuracy : null,
        speed: Number.isFinite(fix.speed) ? fix.speed : null
    };
    _recording.points.push(point);
    _recording.lastAcceptedFix = fix;
    refreshRecordingPreview(false);
    emitRecordingStatus();
}

function shouldAcceptRecordingFix(fix) {
    if (!Number.isFinite(fix.lon) || !Number.isFinite(fix.lat)) return false;
    const firstPoint = _recording.points.length === 0;
    if (!firstPoint && Number.isFinite(fix.accuracy) && fix.accuracy > _recordingSettings.maxAccuracyM) {
        return false;
    }
    if (!firstPoint && Number.isFinite(fix.speed) && fix.speed < _recordingSettings.minSpeedMps) {
        return false;
    }

    const last = _recording.lastAcceptedFix;
    if (!last) return true;

    const elapsed = Math.max(0, fix.timestamp - last.timestamp);
    if (elapsed < _recordingSettings.minIntervalMs) return false;

    const distance = distanceMeters(last, fix);
    return distance >= _recordingSettings.minDistanceM;
}

function refreshRecordingPreview(force = false) {
    if (!_recordingSettings.showLiveTrack || _recording.points.length === 0) {
        clearRecordingPreview();
        return;
    }
    if (!mapLoaded || !map) return;

    const now = Date.now();
    if (!force && now - _lastRecordingPreviewAt < RECORDING_PREVIEW_THROTTLE_MS) return;
    _lastRecordingPreviewAt = now;

    ensureRecordingPreviewLayer();
    const source = map.getSource(RECORDING_SOURCE_ID);
    if (!source) return;
    source.setData(buildRecordingPreviewGeoJson());
}

function ensureRecordingPreviewLayer() {
    if (!mapLoaded || !map || !map.isStyleLoaded?.()) return;

    if (!map.getSource(RECORDING_SOURCE_ID)) {
        map.addSource(RECORDING_SOURCE_ID, {
            type: 'geojson',
            data: emptyRecordingPreview()
        });
    }

    if (!map.getLayer(RECORDING_LAYER_ID)) {
        map.addLayer({
            id: RECORDING_LAYER_ID,
            type: 'line',
            source: RECORDING_SOURCE_ID,
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
                'line-color': _recordingSettings.trackColor,
                'line-width': _recordingSettings.trackWidth,
                'line-opacity': 0.92
            }
        });
    } else {
        map.setPaintProperty(RECORDING_LAYER_ID, 'line-color', _recordingSettings.trackColor);
        map.setPaintProperty(RECORDING_LAYER_ID, 'line-width', _recordingSettings.trackWidth);
    }
}

function clearRecordingPreview() {
    const source = mapLoaded && map ? map.getSource(RECORDING_SOURCE_ID) : null;
    if (source) source.setData(emptyRecordingPreview());
}

function buildRecordingPreviewGeoJson() {
    const points = _recording.points;
    const maxPoints = _recordingSettings.livePreviewMaxPoints;
    const step = points.length > maxPoints ? Math.ceil(points.length / maxPoints) : 1;
    const coordinates = [];

    for (let i = 0; i < points.length; i += step) {
        coordinates.push([points[i].lon, points[i].lat]);
    }
    const last = points[points.length - 1];
    if (last && coordinates.length > 0) {
        const lastCoord = coordinates[coordinates.length - 1];
        if (lastCoord[0] !== last.lon || lastCoord[1] !== last.lat) {
            coordinates.push([last.lon, last.lat]);
        }
    }

    return {
        type: 'FeatureCollection',
        features: coordinates.length >= 2 ? [{
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates }
        }] : []
    };
}

function emptyRecordingPreview() {
    return { type: 'FeatureCollection', features: [] };
}

function ensureMarker() {
    if (_marker || !mapLoaded || !map || !window.maplibregl) return;

    _markerEl = document.createElement('div');
    _markerEl.className = 'device-location-marker';
    _markerEl.setAttribute('aria-label', 'Posizione dispositivo');
    _markerEl.innerHTML = `
        <span class="device-location-heading" aria-hidden="true"></span>
        <span class="device-location-pulse" aria-hidden="true"></span>
        <span class="device-location-dot" aria-hidden="true"></span>
    `;

    _marker = new window.maplibregl.Marker({
        element: _markerEl,
        anchor: 'center'
    }).addTo(map);
}

function updateMarker(fix, moving, heading) {
    if (!_marker || !_markerEl) return;
    _marker.setLngLat([fix.lon, fix.lat]);
    _markerEl.classList.toggle('device-location-marker--moving', moving);
    _markerEl.style.setProperty('--device-heading', `${Number.isFinite(heading) ? heading : 0}deg`);
    _markerEl.title = moving ? 'Posizione in movimento' : 'Posizione dispositivo';
}

function removeMarker() {
    if (_marker) {
        _marker.remove();
    }
    _marker = null;
    _markerEl = null;
}

function resolveHeading(fix, previousFix, distance, moving) {
    let heading = Number.isFinite(fix.heading) ? fix.heading : null;

    if (heading === null && previousFix && distance >= 2) {
        heading = bearingDegrees(previousFix, fix);
    }

    if (heading === null && Number.isFinite(_orientationHeading)) {
        heading = _orientationHeading;
    }

    if (heading === null && Number.isFinite(_lastHeading)) {
        heading = _lastHeading;
    }

    if (moving && heading !== null) {
        _lastHeading = heading;
    }

    return heading;
}

async function startOrientationTracking() {
    if (_orientationListening || typeof window.DeviceOrientationEvent === 'undefined') return;
    const requestToken = ++_orientationRequestToken;

    try {
        const OrientationEvent = window.DeviceOrientationEvent;
        if (typeof OrientationEvent.requestPermission === 'function') {
            const permission = await OrientationEvent.requestPermission();
            if (permission !== 'granted') return;
        }
    } catch (err) {
        console.warn('Orientamento dispositivo non disponibile', err);
        return;
    }

    if (requestToken !== _orientationRequestToken || _watchId === null) return;
    window.addEventListener('deviceorientationabsolute', handleDeviceOrientation, true);
    window.addEventListener('deviceorientation', handleDeviceOrientation, true);
    _orientationListening = true;
}

function stopOrientationTracking() {
    _orientationRequestToken++;
    if (!_orientationListening) return;
    window.removeEventListener('deviceorientationabsolute', handleDeviceOrientation, true);
    window.removeEventListener('deviceorientation', handleDeviceOrientation, true);
    _orientationListening = false;
    _orientationHeading = null;
}

function handleDeviceOrientation(event) {
    const rawHeading = Number.isFinite(event.webkitCompassHeading) ?
        event.webkitCompassHeading :
        (Number.isFinite(event.alpha) ? 360 - event.alpha : null);
    const heading = normalizeHeading(rawHeading);
    if (!Number.isFinite(heading)) return;

    _orientationHeading = heading;
    if (_isMoving && _markerEl) {
        _lastHeading = heading;
        _markerEl.style.setProperty('--device-heading', `${heading}deg`);
    }
}

function emitStatus(extra = {}) {
    if (!_onStatusChange) return;
    _onStatusChange({
        active: _watchId !== null,
        waiting: _waitingForFirstFix,
        moving: _isMoving,
        ...extra
    });
}

function emitRecordingStatus(extra = {}) {
    if (!_onRecordingStatusChange) return;
    _onRecordingStatusChange({
        ...buildRecordingStatus(),
        ...extra
    });
}

function buildRecordingStatus() {
    const elapsedMs = _recording.state === 'idle' ? 0 : Math.max(0,
        Date.now() -
        (_recording.startedAt || Date.now()) -
        _recording.totalPausedMs -
        (_recording.state === 'paused' && _recording.pausedAt ? Date.now() - _recording.pausedAt : 0)
    );
    return {
        state: _recording.state,
        recording: _recording.state === 'recording',
        paused: _recording.state === 'paused',
        pointsCount: _recording.points.length,
        skippedCount: _recording.skipped,
        elapsedMs,
        settings: getRecordingSettings()
    };
}

function notify(message, type = 'info') {
    if (_showToast) {
        _showToast(message, type);
    }
}

function geolocationErrorMessage(error) {
    if (!error) return "Localizzazione non disponibile";
    if (error.code === 1) return "Permesso di localizzazione negato";
    if (error.code === 2) return "Posizione non disponibile dal dispositivo";
    if (error.code === 3) return "Timeout durante la localizzazione";
    return "Errore durante la localizzazione";
}

function normalizeHeading(value) {
    const heading = Number(value);
    if (!Number.isFinite(heading)) return null;
    return ((heading % 360) + 360) % 360;
}

function createEmptyRecording() {
    return {
        state: 'idle',
        startedAt: null,
        pausedAt: null,
        totalPausedMs: 0,
        points: [],
        lastAcceptedFix: null,
        skipped: 0
    };
}

function sanitizeRecordingName(name) {
    return String(name || getDefaultRecordingName())
        .trim()
        .replace(/[\\/:*?"<>|]+/g, '-')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_') || getDefaultRecordingName();
}

async function saveRecordingGpx(track, suggestedFileName) {
    const safeFileName = sanitizeRecordingName(suggestedFileName.replace(/\.gpx$/i, '')) + '.gpx';
    const blob = new Blob([buildGpxForTrack(track)], { type: 'application/gpx+xml' });

    if (typeof window.showSaveFilePicker === 'function') {
        try {
            const handle = await window.showSaveFilePicker({
                suggestedName: safeFileName,
                types: [{
                    description: 'GPX',
                    accept: { 'application/gpx+xml': ['.gpx'] }
                }]
            });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            return { savedFile: true, fileName: safeFileName };
        } catch (err) {
            if (err?.name === 'AbortError') return { savedFile: false, fileName: safeFileName };
            console.error(err);
        }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = safeFileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return { savedFile: true, fileName: safeFileName };
}

function buildGpxForTrack(track) {
    const parts = [];
    parts.push(`<?xml version="1.0" encoding="UTF-8"?>\n`);
    parts.push(`<gpx version="1.1" creator="GpxSuite" xmlns="http://www.topografix.com/GPX/1/1">\n`);
    parts.push(`  <trk>\n`);
    parts.push(`    <name>${escapeXml(track.name || 'Registrazione')}</name>\n`);
    parts.push(`    <desc>${escapeXml(track.desc || '')}</desc>\n`);
    for (const segment of track.segments || []) {
        parts.push(`    <trkseg>\n`);
        for (const point of segment.points || []) {
            parts.push(`      <trkpt lat="${point.lat.toFixed(6)}" lon="${point.lon.toFixed(6)}">\n`);
            if (Number.isFinite(point.ele) && Math.abs(point.ele) > 0.01) {
                parts.push(`        <ele>${point.ele}</ele>\n`);
            }
            if (point.time) {
                parts.push(`        <time>${new Date(point.time).toISOString()}</time>\n`);
            }
            parts.push(`      </trkpt>\n`);
        }
        parts.push(`    </trkseg>\n`);
    }
    parts.push(`  </trk>\n`);
    parts.push(`</gpx>`);
    return parts.join('');
}

function distanceMeters(a, b) {
    const radius = 6371000;
    const lat1 = a.lat * Math.PI / 180;
    const lat2 = b.lat * Math.PI / 180;
    const dLat = lat2 - lat1;
    const dLon = (b.lon - a.lon) * Math.PI / 180;
    const sinLat = Math.sin(dLat / 2);
    const sinLon = Math.sin(dLon / 2);
    const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
    return 2 * radius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function bearingDegrees(a, b) {
    const lat1 = a.lat * Math.PI / 180;
    const lat2 = b.lat * Math.PI / 180;
    const dLon = (b.lon - a.lon) * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) -
        Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return normalizeHeading(Math.atan2(y, x) * 180 / Math.PI);
}
