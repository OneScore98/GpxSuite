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
const RECORDING_FOLLOW_MIN_INTERVAL_MS = 120;
const USER_EXPLORING_RECENTER_DELAY_MS = 6000;
const LOCATION_CENTERED_DISTANCE_M = 25;
const RECENTERED_CONTROL_GRACE_MS = 2200;
const LOCATION_SOURCE_ID = 'device-location';
const LOCATION_DOT_LAYER_ID = 'device-location-dot-layer';
const LOCATION_HALO_LAYER_ID = 'device-location-halo-layer';
const LOCATION_HEADING_LAYER_ID = 'device-location-heading-layer';
const LOCATION_HEADING_ICON_ID = 'device-location-heading-icon';
const RECORDING_SOURCE_ID = 'device-recording-track';
const RECORDING_LAYER_ID = 'device-recording-track-layer';
const RECORDING_CASING_LAYER_ID = 'device-recording-track-casing-layer';
const RECORDING_POINT_LAYER_ID = 'device-recording-current-point-layer';
const RECORDING_POINT_HALO_LAYER_ID = 'device-recording-current-point-halo-layer';
const RECORDING_PREVIEW_THROTTLE_MS = 120;
const RECORDING_PREVIEW_MIN_MOVE_M = 0.4;
const SIMULATED_WATCH_ID = '__gpxsuite_simulated_location__';

// --- Costanti ispirate alle app di tracking sportivo (Strava/Komoot/Wikiloc) ---
// Warmup: i primi N fix sono spesso imprecisi (cold-start GPS), allarghiamo
// temporaneamente la soglia di accuracy per non perdere l'avvio del percorso.
const RECORDING_WARMUP_FIXES = 3;
const RECORDING_WARMUP_ACCURACY_MULTIPLIER = 2.2;
// Outlier filter: scarta fix che implicherebbero velocità impossibili tra
// due punti accettati consecutivi (teleport da multipath GPS). 70 m/s = 252 km/h
// → ragionevole per pedoni/bici/moto, opzionale via setting per scenari estremi.
const RECORDING_OUTLIER_MAX_SPEED_MPS = 70;
// Smoothing pesato sull'accuracy: come un filtro Kalman semplificato.
// alpha = ACC_REF / (ACC_REF + accuracy)  → con accuracy 8 m, alpha ≈ 0.5
const RECORDING_SMOOTHING_ACCURACY_REF = 8;
const RECORDING_SMOOTHING_ALPHA_MIN = 0.18; // più piccolo → più filtro
const RECORDING_SMOOTHING_ALPHA_MAX = 0.85;
const RECORDING_ELEVATION_GAIN_MIN_M = 1;   // ignora rumore di quota sotto 1 m
// Persistenza locale: snapshot della sessione corrente per recovery da crash.
const RECORDING_PERSIST_KEY = 'gpxsuite-recording-snapshot-v1';
const RECORDING_PERSIST_DEBOUNCE_MS = 5000;
const RECORDING_SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const ORIENTATION_PERMISSION_KEY = 'gpxsuite-orientation-permission-v1';

const DEFAULT_RECORDING_SETTINGS = {
    minDistanceM: 1,
    minIntervalMs: 500,
    maxAccuracyM: 30,             // soglia base più stretta, warmup la rilassa
    minSpeedMps: 0,
    showLiveTrack: true,
    saveElevation: true,
    smoothingEnabled: false,       // default raw: marker e traccia live devono coincidere
    outlierFilterEnabled: true,    // scarta teleport GPS
    autoPauseOnLockMs: 0,          // 0 = disattivato (per uso futuro)
    keepScreenOn: true,            // Wake Lock API
    livePreviewMaxPoints: 3000,
    trackColor: '#ef4444',
    trackWidth: 4
};

const GEOLOCATION_OPTIONS = {
    enableHighAccuracy: true,
    maximumAge: 0,                  // niente cache: sempre fix nuovi
    timeout: 20000
};

let _watchId = null;
let _lastFix = null;
let _lastHeading = null;
let _orientationHeading = null;
let _orientationListening = false;
let _orientationPermissionGranted = readPersistedOrientationGrant();
let _orientationRequestToken = 0;
let _waitingForFirstFix = false;
let _isMoving = false;
let _lastFollowAt = 0;
let _userExploringUntil = 0;
let _recentCenteredUntil = 0;
let _focusAnimationUntil = 0;
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
let _recordingPreviewRetryScheduled = false;
let _recordingTickIntervalId = null;
let _wakeLock = null;
let _wakeLockVisibilityBound = false;
let _persistSnapshotTimer = null;
let _simulationIntervalId = null;

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

export function isDeviceLocationSimulationAvailable() {
    return isLocalSimulationHost();
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

    if (hasRecordingPreviewData()) {
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

    _recording = createEmptyRecording();
    _recording.state = 'recording';
    _recording.startedAt = Date.now();
    _lastRecordingPreviewAt = 0;
    clearPersistedRecordingSnapshot();
    if (_lastFix) updateRecordingLivePreview(_lastFix, false);
    if (_recordingSettings.showLiveTrack) refreshRecordingPreview(true);
    startRecordingTick();
    acquireWakeLock().catch(() => {});
    notify("Registrazione avviata", "success");
    emitRecordingStatus();
    return true;
}

export function pauseDeviceRecording() {
    if (_recording.state !== 'recording') return false;
    _recording.state = 'paused';
    _recording.pausedAt = Date.now();
    stopRecordingTick();
    releaseWakeLock();
    persistRecordingSnapshot();
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
    startRecordingTick();
    acquireWakeLock().catch(() => {});
    notify("Registrazione ripresa", "success");
    emitRecordingStatus();
    return true;
}

export async function finishDeviceRecording(name = getDefaultRecordingName()) {
    if (_recording.state === 'idle') return null;

    const recording = _recording;
    _recording = createEmptyRecording();
    stopRecordingTick();
    releaseWakeLock();
    emitRecordingStatus();
    clearRecordingPreview();
    clearPersistedRecordingSnapshot();

    const recordedPoints = chooseRecordedPointsForSave(recording);
    if (recordedPoints.length === 0) {
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
            points: recordedPoints.map(point => ({
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
    return { track, pointsCount: recordedPoints.length, ...fileResult };
}

export function toggleDeviceLocation() {
    if (_watchId !== null) {
        if (_waitingForFirstFix) {
            notify("Localizzazione in attesa del primo fix", "info");
            return true;
        }
        if (isMapCenteredOnLastFix()) {
            stopDeviceLocation('manual');
            return false;
        }
        if (centerOnCurrentDeviceLocation()) {
            notify("Vista centrata sulla posizione", "info");
            emitStatus();
        }
        return true;
    }
    return startDeviceLocation();
}

export function requestDeviceLocationPermission() {
    if (_watchId !== null) {
        notify("Permesso localizzazione gia attivo", "info");
        emitStatus();
        return true;
    }
    return startDeviceLocation();
}

export async function requestDeviceOrientationPermission() {
    if (typeof window.DeviceOrientationEvent === 'undefined') {
        notify("Orientamento dispositivo non supportato", "error");
        emitStatus({ orientationPermission: 'unsupported' });
        return false;
    }

    const granted = await requestOrientationAccess();
    if (!granted) {
        notify("Permesso orientamento non concesso", "error");
        emitStatus({ orientationPermission: 'denied' });
        return false;
    }

    notify("Permesso orientamento attivo", "success");
    if (_watchId !== null) {
        startOrientationTracking();
    }
    emitStatus({ orientationPermission: 'granted' });
    return true;
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
    _recentCenteredUntil = 0;
    _focusAnimationUntil = 0;
    purgeLegacyDomLocationMarkers();
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
    clearLocationSimulationTimer();
    if (_watchId !== null) {
        if (_watchId !== SIMULATED_WATCH_ID) {
            navigator.geolocation.clearWatch(_watchId);
        }
    }

    _watchId = null;
    _waitingForFirstFix = false;
    _isMoving = false;
    _lastFix = null;
    _lastHeading = null;
    _lastFollowAt = 0;
    _recentCenteredUntil = 0;
    _focusAnimationUntil = 0;
    clearLocationMarker();
    stopOrientationTracking();
    emitStatus();

    if (reason === 'manual') {
        notify("Localizzazione disattivata", "info");
    }
}

export function startDeviceRecordingSimulation(options = {}) {
    if (!isLocalSimulationHost()) {
        notify("Simulazione GPS disponibile solo in locale", "error");
        return false;
    }
    if (!mapLoaded || !map) {
        notify("Mappa non ancora pronta per la simulazione GPS", "info");
        return false;
    }

    startSimulatedDeviceLocation();
    if (_recording.state === 'idle' && !startDeviceRecording()) return false;
    if (_recording.state !== 'recording') {
        notify("La registrazione deve essere attiva per simulare il GPS", "info");
        return false;
    }

    clearLocationSimulationTimer();
    const route = buildSimulatedRoute(options);
    const intervalMs = Math.max(80, Number(options.intervalMs) || 350);
    let index = 0;

    const emitNext = () => {
        if (_recording.state !== 'recording' || index >= route.length) {
            clearLocationSimulationTimer();
            if (index >= route.length) notify("Simulazione GPS completata", "success");
            return;
        }
        handlePosition(createSimulatedPosition(route[index], index, route));
        index += 1;
    };

    emitNext();
    _simulationIntervalId = setInterval(emitNext, intervalMs);
    notify("Simulazione GPS avviata", "info");
    return { points: route.length, intervalMs };
}

export function stopDeviceRecordingSimulation() {
    clearLocationSimulationTimer();
    if (_watchId === SIMULATED_WATCH_ID) {
        stopDeviceLocation('simulation');
    }
    return true;
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

    updateLiveLocationFrame(fix, moving, heading);

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

function startSimulatedDeviceLocation() {
    if (_watchId !== null && _watchId !== SIMULATED_WATCH_ID) {
        navigator.geolocation.clearWatch(_watchId);
    }

    _watchId = SIMULATED_WATCH_ID;
    _waitingForFirstFix = true;
    _isMoving = false;
    _lastFix = null;
    _lastHeading = null;
    _lastFollowAt = 0;
    _recentCenteredUntil = 0;
    _focusAnimationUntil = 0;
    purgeLegacyDomLocationMarkers();
    bindMapExplorationDetection();
    emitStatus({ simulated: true });
}

function clearLocationSimulationTimer() {
    if (_simulationIntervalId !== null) {
        clearInterval(_simulationIntervalId);
        _simulationIntervalId = null;
    }
}

function buildSimulatedRoute(options = {}) {
    const count = Math.max(4, Math.min(200, Math.round(Number(options.count) || 28)));
    const center = typeof map?.getCenter === 'function' ? map.getCenter() : null;
    const startLat = Number.isFinite(Number(options.lat)) ? Number(options.lat) :
        Number(center?.lat ?? 44.164178);
    const startLon = Number.isFinite(Number(options.lon)) ? Number(options.lon) :
        Number(center?.lng ?? center?.lon ?? 7.512308);
    const stepLat = Number.isFinite(Number(options.stepLat)) ? Number(options.stepLat) : 0.000035;
    const stepLon = Number.isFinite(Number(options.stepLon)) ? Number(options.stepLon) : 0.000055;

    const route = [];
    for (let i = 0; i < count; i += 1) {
        route.push({
            lat: startLat + stepLat * i + Math.sin(i / 2.4) * 0.000012,
            lon: startLon + stepLon * i + Math.cos(i / 3) * 0.000010,
            ele: 500 + Math.round(i * 0.8)
        });
    }
    return route;
}

function createSimulatedPosition(point, index, route) {
    const previous = index > 0 ? route[index - 1] : null;
    const next = route[index + 1] || point;
    const heading = previous ? bearingDegrees(previous, point) : bearingDegrees(point, next);
    return {
        coords: {
            longitude: point.lon,
            latitude: point.lat,
            altitude: point.ele,
            accuracy: 4,
            speed: 1.6,
            heading
        },
        timestamp: Date.now()
    };
}

function isLocalSimulationHost() {
    const host = window.location.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '';
}

function focusInitialPosition(fix) {
    if (!mapLoaded || !map) return;
    const currentZoom = typeof map.getZoom === 'function' ? map.getZoom() : 0;
    _recentCenteredUntil = Date.now() + RECENTERED_CONTROL_GRACE_MS;
    if (_recording.state === 'recording') {
        _focusAnimationUntil = 0;
        jumpToCurrentFix(fix, { zoom: Math.max(currentZoom, INITIAL_LOCATION_ZOOM) });
        return;
    }
    _focusAnimationUntil = Date.now() + 1300;
    map.flyTo({
        center: [fix.lon, fix.lat],
        zoom: Math.max(currentZoom, INITIAL_LOCATION_ZOOM),
        duration: 1200,
        essential: true
    });
}

function centerOnCurrentDeviceLocation() {
    if (!mapLoaded || !map || !_lastFix) return false;
    _userExploringUntil = 0;
    _lastFollowAt = 0;
    _recentCenteredUntil = Date.now() + RECENTERED_CONTROL_GRACE_MS;
    _focusAnimationUntil = Date.now() + 700;
    map.easeTo({
        center: [_lastFix.lon, _lastFix.lat],
        duration: 650,
        essential: true
    });
    return true;
}

function isMapCenteredOnLastFix() {
    if (!mapLoaded || !map || !_lastFix) return false;
    if (Date.now() < _recentCenteredUntil) return true;
    if (typeof map.getCenter !== 'function') return false;
    const center = map.getCenter();
    const lon = Number(center?.lng ?? center?.lon);
    const lat = Number(center?.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
    return distanceMeters({ lon, lat }, _lastFix) <= LOCATION_CENTERED_DISTANCE_M;
}

function followPosition(fix) {
    if (!mapLoaded || !map) return;
    const now = Date.now();
    const timing = getFollowTiming();
    if (now < _focusAnimationUntil) return;
    const recording = _recording.state === 'recording';
    const minIntervalMs = recording ? RECORDING_FOLLOW_MIN_INTERVAL_MS : timing.intervalMs;
    if (now - _lastFollowAt < minIntervalMs) return;
    if (now < _userExploringUntil) return;
    _lastFollowAt = now;
    _recentCenteredUntil = now + RECENTERED_CONTROL_GRACE_MS;

    if (recording) {
        jumpToCurrentFix(fix);
        return;
    }

    map.easeTo({
        center: [fix.lon, fix.lat],
        duration: timing.durationMs,
        essential: true
    });
}

function jumpToCurrentFix(fix, extra = {}) {
    const camera = {
        center: [fix.lon, fix.lat],
        ...extra
    };
    if (typeof map.stop === 'function') map.stop();
    if (typeof map.jumpTo === 'function') {
        map.jumpTo(camera);
    } else {
        map.easeTo({ ...camera, duration: 0, essential: true });
    }
}

function getFollowTiming() {
    const zoom = typeof map?.getZoom === 'function' ? map.getZoom() : 16;
    if (zoom < 11) return { intervalMs: 450, durationMs: 900 };
    if (zoom < 14) return { intervalMs: 600, durationMs: 720 };
    return { intervalMs: FOLLOW_MIN_INTERVAL_MS, durationMs: 550 };
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
    _recentCenteredUntil = 0;
    _focusAnimationUntil = 0;
    emitStatus();
}

function updateRecordingLivePreview(fix, refresh = true, heading = fix.heading) {
    if (_recording.state !== 'recording') return;
    if (!Number.isFinite(fix.lon) || !Number.isFinite(fix.lat)) return;

    const point = createRecordingPoint(fix, fix.lat, fix.lon, heading);
    _recording.liveFix = point;
    appendRecordingPreviewPoint(point);

    if (refresh && _recordingSettings.showLiveTrack) {
        refreshRecordingPreview(true);
    }
}

function updateLiveLocationFrame(fix, moving, heading) {
    updateRecordingLivePreview(fix, false, heading);
    if (_recordingSettings.showLiveTrack && hasRecordingPreviewData()) {
        refreshRecordingPreview(true);
    }
    updateLocationMarker(fix, moving, heading);
    if (mapLoaded && map && typeof map.triggerRepaint === 'function') {
        map.triggerRepaint();
    }
}

function appendRecordingPreviewPoint(point) {
    const previewPoints = _recording.previewPoints;
    const last = previewPoints[previewPoints.length - 1] || null;
    if (!last) {
        previewPoints.push(point);
        return;
    }

    if (point.time === last.time || distanceMeters(last, point) < RECORDING_PREVIEW_MIN_MOVE_M) {
        previewPoints[previewPoints.length - 1] = point;
        return;
    }

    previewPoints.push(point);
}

function createRecordingPoint(fix, lat = fix.lat, lon = fix.lon, heading = fix.heading) {
    return {
        lat,
        lon,
        ele: _recordingSettings.saveElevation && Number.isFinite(fix.ele) ? Math.round(fix.ele) : 0,
        time: fix.timestamp,
        accuracy: Number.isFinite(fix.accuracy) ? fix.accuracy : null,
        speed: Number.isFinite(fix.speed) ? fix.speed : null,
        heading: Number.isFinite(heading) ? heading : null
    };
}

function hasRecordingPreviewData() {
    return Boolean(
        _recording.liveFix ||
        _recording.previewPoints.length > 0 ||
        _recording.points.length > 0
    );
}

function captureRecordingPoint(fix) {
    if (_recording.state !== 'recording') return;
    if (!shouldAcceptRecordingFix(fix)) {
        _recording.skipped++;
        emitRecordingStatus();
        return;
    }

    // ---- Smoothing pesato sull'accuracy (Kalman-like 1D) -------------------
    // Tecnica usata anche da molte app di tracking sportivo: invece di salvare
    // il fix raw, lo si combina con la stima precedente con un peso che dipende
    // dalla qualità del segnale. Con segnale buono (accuracy bassa) ci si fida
    // del nuovo fix (alpha alto); con segnale rumoroso si tiene la stima vecchia.
    let lat = fix.lat;
    let lon = fix.lon;
    if (_recordingSettings.smoothingEnabled !== false && _recording.smoothed) {
        const acc = Number.isFinite(fix.accuracy) ? fix.accuracy : RECORDING_SMOOTHING_ACCURACY_REF * 2;
        const ratio = RECORDING_SMOOTHING_ACCURACY_REF / (RECORDING_SMOOTHING_ACCURACY_REF + acc);
        const alpha = Math.max(
            RECORDING_SMOOTHING_ALPHA_MIN,
            Math.min(RECORDING_SMOOTHING_ALPHA_MAX, ratio)
        );
        lat = _recording.smoothed.lat * (1 - alpha) + fix.lat * alpha;
        lon = _recording.smoothed.lon * (1 - alpha) + fix.lon * alpha;
    }
    _recording.smoothed = { lat, lon };

    const point = createRecordingPoint(fix, lat, lon);

    // ---- Accumulatori live ------------------------------------------------
    const lastAccepted = _recording.lastAcceptedFix;
    const prevPoint = _recording.points[_recording.points.length - 1] || null;
    if (lastAccepted && prevPoint) {
        const segDist = distanceMeters({ lat: prevPoint.lat, lon: prevPoint.lon }, { lat, lon });
        _recording.totalDistanceM += segDist;
        const elapsedMs = Math.max(0, fix.timestamp - lastAccepted.timestamp);
        const impliedSpeed = elapsedMs > 0 ? segDist / (elapsedMs / 1000) : 0;
        const isMoving = (Number.isFinite(fix.speed) && fix.speed >= MOVEMENT_MIN_SPEED_MPS) ||
            impliedSpeed >= 0.5;
        if (isMoving) _recording.movingMs += elapsedMs;
        _recording.currentSpeed = Number.isFinite(fix.speed) ? Math.max(0, fix.speed) : impliedSpeed;
        if (Number.isFinite(point.ele) && Number.isFinite(prevPoint.ele)) {
            const dEle = point.ele - prevPoint.ele;
            if (dEle >= RECORDING_ELEVATION_GAIN_MIN_M) _recording.totalGainM += dEle;
        }
    } else {
        _recording.firstFixAccuracy = Number.isFinite(fix.accuracy) ? fix.accuracy : null;
        _recording.currentSpeed = Number.isFinite(fix.speed) ? Math.max(0, fix.speed) : 0;
    }
    _recording.lastEle = Number.isFinite(point.ele) ? point.ele : _recording.lastEle;

    _recording.points.push(point);
    _recording.lastAcceptedFix = fix;
    schedulePersistRecordingSnapshot();
    emitRecordingStatus();
}

function shouldAcceptRecordingFix(fix) {
    if (!Number.isFinite(fix.lon) || !Number.isFinite(fix.lat)) return false;

    const last = _recording.lastAcceptedFix;
    const accepted = _recording.points.length;

    // 1) Accuracy gating con warmup: i primi fix sono spesso poco precisi.
    //    Allarghiamo la soglia per RECORDING_WARMUP_FIXES per non perdere
    //    l'avvio del percorso (cold-start GPS).
    const warming = accepted < RECORDING_WARMUP_FIXES;
    const accuracyLimit = warming ?
        _recordingSettings.maxAccuracyM * RECORDING_WARMUP_ACCURACY_MULTIPLIER :
        _recordingSettings.maxAccuracyM;
    if (Number.isFinite(fix.accuracy) && fix.accuracy > accuracyLimit) return false;

    // 2) Outlier (teleport) rejection: scarta fix che implicherebbero velocità
    //    impossibili rispetto all'ultimo accettato (multipath GPS, fix corrotti).
    if (last && _recordingSettings.outlierFilterEnabled !== false) {
        const elapsedSec = Math.max(0.001, (fix.timestamp - last.timestamp) / 1000);
        const dist = distanceMeters(last, fix);
        const impliedSpeed = dist / elapsedSec;
        if (impliedSpeed > RECORDING_OUTLIER_MAX_SPEED_MPS) return false;
    }

    // 3) Filtro velocità minima (per evitare drift mentre il dispositivo
    //    è fermo, se l'utente ha impostato una soglia > 0).
    const firstPoint = accepted === 0;
    if (!firstPoint && Number.isFinite(fix.speed) && _recordingSettings.minSpeedMps > 0 &&
        fix.speed < _recordingSettings.minSpeedMps) {
        return false;
    }

    if (!last) return true;

    // 4) Intervallo minimo tra fix accettati.
    const elapsedMs = Math.max(0, fix.timestamp - last.timestamp);
    const distance = distanceMeters(last, fix);
    const impliedSpeed = elapsedMs > 0 ? distance / (elapsedMs / 1000) : 0;
    const isMoving = (Number.isFinite(fix.speed) && fix.speed >= MOVEMENT_MIN_SPEED_MPS) ||
        impliedSpeed >= 0.5;
    if (elapsedMs < _recordingSettings.minIntervalMs) {
        if (!isMoving || distance < Math.max(1, _recordingSettings.minDistanceM)) {
            return false;
        }
    }

    if (isMoving) {
        return distance >= _recordingSettings.minDistanceM;
    }

    const acc = Number.isFinite(fix.accuracy) ? fix.accuracy : _recordingSettings.maxAccuracyM;
    const requiredStationary = Math.max(_recordingSettings.minDistanceM, 8, Math.min(22, acc * 0.85));
    return distance >= requiredStationary;
}

function refreshRecordingPreview(force = false) {
    if (!_recordingSettings.showLiveTrack || !hasRecordingPreviewData()) {
        clearRecordingPreview();
        return;
    }
    if (!mapLoaded || !map) return;
    if (typeof map.isStyleLoaded === 'function' && !map.isStyleLoaded()) {
        scheduleRecordingPreviewRetry();
        return;
    }

    const now = Date.now();
    if (!force && now - _lastRecordingPreviewAt < RECORDING_PREVIEW_THROTTLE_MS) return;
    _lastRecordingPreviewAt = now;

    ensureRecordingPreviewLayer();
    const source = map.getSource(RECORDING_SOURCE_ID);
    if (!source) return;
    source.setData(buildRecordingPreviewGeoJson());
}

function ensureRecordingPreviewLayer() {
    if (!mapLoaded || !map) return;
    if (typeof map.isStyleLoaded === 'function' && !map.isStyleLoaded()) {
        scheduleRecordingPreviewRetry();
        return;
    }

    if (!map.getSource(RECORDING_SOURCE_ID)) {
        map.addSource(RECORDING_SOURCE_ID, {
            type: 'geojson',
            data: emptyRecordingPreview()
        });
    }

    if (!map.getLayer(RECORDING_CASING_LAYER_ID)) {
        map.addLayer({
            id: RECORDING_CASING_LAYER_ID,
            type: 'line',
            source: RECORDING_SOURCE_ID,
            filter: ['==', ['get', 'kind'], 'line'],
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
                'line-color': '#ffffff',
                'line-width': Math.max(3, _recordingSettings.trackWidth + 3),
                'line-opacity': 0.58
            }
        });
    } else {
        map.setPaintProperty(RECORDING_CASING_LAYER_ID, 'line-width', Math.max(3, _recordingSettings.trackWidth + 3));
    }

    if (!map.getLayer(RECORDING_LAYER_ID)) {
        map.addLayer({
            id: RECORDING_LAYER_ID,
            type: 'line',
            source: RECORDING_SOURCE_ID,
            filter: ['==', ['get', 'kind'], 'line'],
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

    if (!map.getLayer(RECORDING_POINT_HALO_LAYER_ID)) {
        map.addLayer({
            id: RECORDING_POINT_HALO_LAYER_ID,
            type: 'circle',
            source: RECORDING_SOURCE_ID,
            filter: ['==', ['get', 'kind'], 'current-point'],
            paint: {
                'circle-radius': 13,
                'circle-color': _recordingSettings.trackColor,
                'circle-opacity': 0.24,
                'circle-stroke-width': 1,
                'circle-stroke-color': 'rgba(255,255,255,0.7)'
            }
        });
    } else {
        map.setPaintProperty(RECORDING_POINT_HALO_LAYER_ID, 'circle-color', _recordingSettings.trackColor);
    }

    if (!map.getLayer(RECORDING_POINT_LAYER_ID)) {
        map.addLayer({
            id: RECORDING_POINT_LAYER_ID,
            type: 'circle',
            source: RECORDING_SOURCE_ID,
            filter: ['==', ['get', 'kind'], 'current-point'],
            paint: {
                'circle-radius': 6,
                'circle-color': _recordingSettings.trackColor,
                'circle-stroke-width': 3,
                'circle-stroke-color': '#ffffff',
                'circle-opacity': 1
            }
        });
    } else {
        map.setPaintProperty(RECORDING_POINT_LAYER_ID, 'circle-color', _recordingSettings.trackColor);
    }
}

function clearRecordingPreview() {
    _recordingPreviewRetryScheduled = false;
    const source = mapLoaded && map ? map.getSource(RECORDING_SOURCE_ID) : null;
    if (source) source.setData(emptyRecordingPreview());
}

function scheduleRecordingPreviewRetry() {
    if (_recordingPreviewRetryScheduled || !mapLoaded || !map) return;
    _recordingPreviewRetryScheduled = true;

    const retry = () => {
        _recordingPreviewRetryScheduled = false;
        if (_recording.state !== 'idle' && _recordingSettings.showLiveTrack) {
            refreshRecordingPreview(true);
        }
    };

    if (typeof map.once === 'function') {
        map.once('idle', retry);
    } else {
        setTimeout(retry, 300);
    }
}

function buildRecordingPreviewGeoJson() {
    const points = _recording.previewPoints.length > 0 ? _recording.previewPoints : _recording.points;
    const maxPoints = _recordingSettings.livePreviewMaxPoints;
    const step = points.length > maxPoints ? Math.ceil(points.length / maxPoints) : 1;
    const coordinates = [];

    for (let i = 0; i < points.length; i += step) {
        coordinates.push([points[i].lon, points[i].lat]);
    }
    const last = _recording.liveFix || points[points.length - 1] || _recording.points[_recording.points.length - 1];
    if (last && coordinates.length === 0) {
        coordinates.push([last.lon, last.lat]);
    } else if (last && coordinates.length > 0) {
        const lastCoord = coordinates[coordinates.length - 1];
        if (lastCoord[0] !== last.lon || lastCoord[1] !== last.lat) {
            coordinates.push([last.lon, last.lat]);
        }
    }

    const features = [];
    if (coordinates.length >= 2) {
        features.push({
            type: 'Feature',
            properties: { kind: 'line' },
            geometry: { type: 'LineString', coordinates }
        });
    }
    if (last) {
        const hasHeading = Number.isFinite(last.heading);
        features.push({
            type: 'Feature',
            properties: {
                kind: 'current-point',
                hasHeading,
                heading: hasHeading ? last.heading : 0
            },
            geometry: { type: 'Point', coordinates: [last.lon, last.lat] }
        });
    }

    return { type: 'FeatureCollection', features };
}

function emptyRecordingPreview() {
    return { type: 'FeatureCollection', features: [] };
}

function updateLocationMarker(fix, moving, heading) {
    purgeLegacyDomLocationMarkers();
    ensureLocationMarkerLayers();
    const source = mapLoaded && map ? map.getSource(LOCATION_SOURCE_ID) : null;
    if (!source) return;
    source.setData(buildLocationFeatureCollection(fix, moving, heading));
}

function ensureLocationMarkerLayers() {
    if (!mapLoaded || !map || (typeof map.isStyleLoaded === 'function' && !map.isStyleLoaded())) return;

    ensureHeadingIcon();

    if (!map.getSource(LOCATION_SOURCE_ID)) {
        map.addSource(LOCATION_SOURCE_ID, {
            type: 'geojson',
            data: emptyLocationFeatureCollection()
        });
    }

    if (!map.getLayer(LOCATION_HALO_LAYER_ID)) {
        map.addLayer({
            id: LOCATION_HALO_LAYER_ID,
            type: 'circle',
            source: LOCATION_SOURCE_ID,
            paint: {
                'circle-radius': ['case', ['get', 'moving'], 28, 16],
                'circle-color': '#0ea5e9',
                'circle-opacity': ['case', ['get', 'moving'], 0.32, 0.18],
                'circle-stroke-width': ['case', ['get', 'moving'], 2, 1],
                'circle-stroke-color': 'rgba(255,255,255,0.55)'
            }
        });
    }

    if (!map.getLayer(LOCATION_HEADING_LAYER_ID)) {
        map.addLayer({
            id: LOCATION_HEADING_LAYER_ID,
            type: 'symbol',
            source: LOCATION_SOURCE_ID,
            filter: ['==', ['get', 'hasHeading'], true],
            layout: {
                'icon-image': LOCATION_HEADING_ICON_ID,
                'icon-size': 1.0,
                'icon-rotate': ['get', 'heading'],
                'icon-rotation-alignment': 'map',
                'icon-pitch-alignment': 'map',
                'icon-allow-overlap': true,
                'icon-ignore-placement': true
            },
            paint: {
                // Cono pieno quando ci si muove, più tenue quando il dato
                // proviene solo dalla bussola (utente fermo).
                'icon-opacity': ['case', ['get', 'moving'], 1.0, 0.78]
            }
        });
    } else {
        map.setPaintProperty(LOCATION_HEADING_LAYER_ID, 'icon-opacity',
            ['case', ['get', 'moving'], 1.0, 0.78]);
    }

    if (!map.getLayer(LOCATION_DOT_LAYER_ID)) {
        map.addLayer({
            id: LOCATION_DOT_LAYER_ID,
            type: 'circle',
            source: LOCATION_SOURCE_ID,
            paint: {
                'circle-radius': ['case', ['get', 'moving'], 9, 6],
                'circle-color': '#2563eb',
                'circle-stroke-width': ['case', ['get', 'moving'], 4, 3],
                'circle-stroke-color': '#ffffff',
                'circle-opacity': 1
            }
        });
    }
}

function ensureHeadingIcon() {
    if (!mapLoaded || !map || (typeof map.hasImage === 'function' && map.hasImage(LOCATION_HEADING_ICON_ID))) return;

    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, size, size);

    const cx = size / 2;
    const cy = size / 2;

    // ---- 1) Cono di direzione (campo visivo) -------------------------------
    // Un settore di ~60° davanti al puntino, con sfumatura radiale che svanisce
    // sui bordi: comunica la direzione anche da lontano senza coprire la mappa.
    const fanRadius = 60;
    const halfAngle = Math.PI / 6; // 30° per lato → 60° totale
    const fanGradient = ctx.createRadialGradient(cx, cy, 6, cx, cy, fanRadius);
    fanGradient.addColorStop(0, 'rgba(56, 189, 248, 0.9)');
    fanGradient.addColorStop(0.55, 'rgba(56, 189, 248, 0.35)');
    fanGradient.addColorStop(1, 'rgba(56, 189, 248, 0)');
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, fanRadius, -Math.PI / 2 - halfAngle, -Math.PI / 2 + halfAngle);
    ctx.closePath();
    ctx.fillStyle = fanGradient;
    ctx.fill();

    // Bordo sottile bianco lungo i lati del cono, per stacco su sfondi chiari.
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(halfAngle) * fanRadius, cy - Math.cos(halfAngle) * fanRadius);
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx - Math.sin(halfAngle) * fanRadius, cy - Math.cos(halfAngle) * fanRadius);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // ---- 2) Chevron principale ---------------------------------------------
    // Una freccia "a punta" allungata, leggermente staccata dal puntino blu
    // per non confondersi. Spessa, con alone bianco e ombra per leggibilità.
    const tipY = cy - 50;
    const baseY = cy - 14;
    const notchY = cy - 22;
    const halfWidth = 18;

    ctx.beginPath();
    ctx.moveTo(cx, tipY);                 // punta in alto
    ctx.lineTo(cx + halfWidth, baseY);    // spalla destra
    ctx.lineTo(cx, notchY);               // tacca centrale → forma chevron
    ctx.lineTo(cx - halfWidth, baseY);    // spalla sinistra
    ctx.closePath();

    // Ombra portata sotto al chevron per "sollevarlo" dalla mappa.
    ctx.save();
    ctx.shadowColor = 'rgba(2, 6, 23, 0.55)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = '#0c4a6e';
    ctx.fill();
    ctx.restore();

    // Alone bianco spesso per garantire contrasto su qualunque basemap.
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 6;
    ctx.stroke();

    // Riempimento con gradiente blu cielo → blu scuro per dare profondità.
    const chevronGradient = ctx.createLinearGradient(cx, tipY, cx, baseY);
    chevronGradient.addColorStop(0, '#7dd3fc');
    chevronGradient.addColorStop(0.55, '#38bdf8');
    chevronGradient.addColorStop(1, '#0284c7');
    ctx.fillStyle = chevronGradient;
    ctx.fill();

    // Sottile riflesso bianco lungo il bordo sinistro della punta.
    ctx.beginPath();
    ctx.moveTo(cx - 1, tipY + 4);
    ctx.lineTo(cx - halfWidth + 6, baseY - 4);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 1.6;
    ctx.stroke();

    map.addImage(LOCATION_HEADING_ICON_ID, ctx.getImageData(0, 0, size, size), { pixelRatio: 2 });
}

function buildLocationFeatureCollection(fix, moving, heading) {
    const hasHeading = Number.isFinite(heading);
    return {
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            properties: {
                moving: Boolean(moving),
                hasHeading,
                heading: hasHeading ? heading : 0
            },
            geometry: {
                type: 'Point',
                coordinates: [fix.lon, fix.lat]
            }
        }]
    };
}

function emptyLocationFeatureCollection() {
    return { type: 'FeatureCollection', features: [] };
}

function clearLocationMarker() {
    const source = mapLoaded && map ? map.getSource(LOCATION_SOURCE_ID) : null;
    if (source) source.setData(emptyLocationFeatureCollection());
    purgeLegacyDomLocationMarkers();
}

function purgeLegacyDomLocationMarkers() {
    document.querySelectorAll('.device-location-marker').forEach(element => element.remove());
}

function resolveHeading(fix, previousFix, distance, moving) {
    const courseHeading = previousFix && distance >= 2 ? bearingDegrees(previousFix, fix) : null;
    let heading = moving && courseHeading !== null ? courseHeading : null;

    if (heading === null && Number.isFinite(fix.heading)) {
        heading = fix.heading;
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

    const granted = await requestOrientationAccess();
    if (!granted) return;

    if (requestToken !== _orientationRequestToken || _watchId === null) return;
    window.addEventListener('deviceorientationabsolute', handleDeviceOrientation, true);
    window.addEventListener('deviceorientation', handleDeviceOrientation, true);
    _orientationListening = true;
}

async function requestOrientationAccess() {
    if (typeof window.DeviceOrientationEvent === 'undefined') return false;
    if (_orientationPermissionGranted) return true;

    try {
        const OrientationEvent = window.DeviceOrientationEvent;
        if (typeof OrientationEvent.requestPermission === 'function') {
            const permission = await OrientationEvent.requestPermission();
            _orientationPermissionGranted = permission === 'granted';
            return _orientationPermissionGranted;
        }
        _orientationPermissionGranted = true;
        return true;
    } catch (err) {
        console.warn('Orientamento dispositivo non disponibile', err);
        return false;
    }
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
    if (_isMoving && _lastFix) {
        _lastHeading = heading;
        updateLocationMarker(_lastFix, true, heading);
    }
}

function emitStatus(extra = {}) {
    if (!_onStatusChange) return;
    _onStatusChange({
        active: _watchId !== null,
        waiting: _waitingForFirstFix,
        moving: _isMoving,
        centered: isMapCenteredOnLastFix(),
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

function startRecordingTick() {
    stopRecordingTick();
    _recordingTickIntervalId = setInterval(() => {
        if (_recording.state !== 'recording') {
            stopRecordingTick();
            return;
        }
        emitRecordingStatus();
    }, 1000);
}

function stopRecordingTick() {
    if (_recordingTickIntervalId !== null) {
        clearInterval(_recordingTickIntervalId);
        _recordingTickIntervalId = null;
    }
}

// ---- Wake Lock: tiene la pagina sveglia durante la registrazione. -------
// Le app di tracking nativo girano in background; sul web la soluzione
// più portatile è il Wake Lock API. Quando lo schermo si spegne il browser
// throttle drasticamente i timer e watchPosition smette di emettere fix.
async function acquireWakeLock() {
    if (!_recordingSettings.keepScreenOn) return;
    if (!('wakeLock' in navigator)) return;
    if (_wakeLock) return;
    try {
        _wakeLock = await navigator.wakeLock.request('screen');
        _wakeLock.addEventListener('release', () => {
            // Il sistema può rilasciarlo (es. cambio tab); lo recuperiamo
            // alla prossima visibility change.
            _wakeLock = null;
        });
    } catch (err) {
        // Tipicamente AbortError o NotAllowedError: non bloccante.
        console.warn('Wake Lock non disponibile', err);
    }

    if (!_wakeLockVisibilityBound) {
        _wakeLockVisibilityBound = true;
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' &&
                _recording.state === 'recording') {
                acquireWakeLock().catch(() => {});
            }
        });
    }
}

function releaseWakeLock() {
    if (!_wakeLock) return;
    const lock = _wakeLock;
    _wakeLock = null;
    lock.release().catch(() => {});
}

// ---- Persistenza locale della registrazione attiva ---------------------
// Snapshot debounced ogni RECORDING_PERSIST_DEBOUNCE_MS: se l'utente chiude
// la tab o l'OS la termina, alla riapertura troviamo i punti già registrati
// e possiamo decidere se riprendere/salvare.
function schedulePersistRecordingSnapshot() {
    if (_persistSnapshotTimer) return;
    _persistSnapshotTimer = setTimeout(() => {
        _persistSnapshotTimer = null;
        persistRecordingSnapshot();
    }, RECORDING_PERSIST_DEBOUNCE_MS);
}

function persistRecordingSnapshot() {
    if (typeof localStorage === 'undefined') return;
    if (_recording.state === 'idle') {
        try { localStorage.removeItem(RECORDING_PERSIST_KEY); } catch (e) {}
        return;
    }
    try {
        const snapshot = {
            v: 1,
            savedAt: Date.now(),
            state: _recording.state,
            startedAt: _recording.startedAt,
            pausedAt: _recording.pausedAt,
            totalPausedMs: _recording.totalPausedMs,
            points: _recording.points,
            totalDistanceM: _recording.totalDistanceM,
            totalGainM: _recording.totalGainM,
            movingMs: _recording.movingMs,
            firstFixAccuracy: _recording.firstFixAccuracy
        };
        localStorage.setItem(RECORDING_PERSIST_KEY, JSON.stringify(snapshot));
    } catch (err) {
        // Probabilmente quota piena: ignoriamo, non vogliamo bloccare il tracking.
        console.warn('Snapshot registrazione fallito', err);
    }
}

function clearPersistedRecordingSnapshot() {
    if (_persistSnapshotTimer) {
        clearTimeout(_persistSnapshotTimer);
        _persistSnapshotTimer = null;
    }
    try { localStorage.removeItem(RECORDING_PERSIST_KEY); } catch (e) {}
}

function readPersistedRecordingSnapshot() {
    if (typeof localStorage === 'undefined') return null;
    try {
        const raw = localStorage.getItem(RECORDING_PERSIST_KEY);
        if (!raw) return null;
        const snap = JSON.parse(raw);
        if (!snap || snap.v !== 1) return null;
        if (!Array.isArray(snap.points) || snap.points.length === 0) return null;
        if (Date.now() - (snap.savedAt || 0) > RECORDING_SNAPSHOT_MAX_AGE_MS) {
            try { localStorage.removeItem(RECORDING_PERSIST_KEY); } catch (e) {}
            return null;
        }
        return snap;
    } catch (err) {
        return null;
    }
}

// ---- Permesso orientamento dispositivo (iOS richiede gesto utente) -----
// La permission API per DeviceOrientation NON espone uno stato persistito,
// quindi memorizziamo noi l'esito del primo prompt, evitando di mostrare
// per sempre "Da autorizzare" all'utente che ha già accettato.
function readPersistedOrientationGrant() {
    try {
        return localStorage.getItem(ORIENTATION_PERMISSION_KEY) === 'granted';
    } catch (err) {
        return false;
    }
}

function persistOrientationGrant(granted) {
    try {
        if (granted) localStorage.setItem(ORIENTATION_PERMISSION_KEY, 'granted');
        else localStorage.removeItem(ORIENTATION_PERMISSION_KEY);
    } catch (err) {}
}

export function hasGrantedOrientationPermission() {
    return _orientationPermissionGranted;
}

// ---- Recovery sessione registrazione (da chiamare a init) ---------------
export function getPendingRecordingSnapshot() {
    return readPersistedRecordingSnapshot();
}

export function discardPendingRecordingSnapshot() {
    clearPersistedRecordingSnapshot();
}

export function resumePendingRecordingSnapshot() {
    const snap = readPersistedRecordingSnapshot();
    if (!snap) return false;
    if (!isDeviceLocationActive() && !startDeviceLocation()) {
        // Anche senza GPS attivo possiamo presentare i punti, poi l'utente
        // attiverà la geo. Ma per ora richiediamo geo per "continuare".
        return false;
    }

    _recording = {
        state: 'paused',
        startedAt: snap.startedAt || Date.now(),
        pausedAt: Date.now(),
        totalPausedMs: snap.totalPausedMs || 0,
        points: snap.points.slice(),
        lastAcceptedFix: null,
        skipped: 0,
        previewPoints: snap.points.slice(),
        liveFix: snap.points.length ? snap.points[snap.points.length - 1] : null,
        smoothed: snap.points.length ? {
            lat: snap.points[snap.points.length - 1].lat,
            lon: snap.points[snap.points.length - 1].lon
        } : null,
        totalDistanceM: Number(snap.totalDistanceM) || 0,
        totalGainM: Number(snap.totalGainM) || 0,
        movingMs: Number(snap.movingMs) || 0,
        lastEle: snap.points.length ? snap.points[snap.points.length - 1].ele : null,
        firstFixAccuracy: snap.firstFixAccuracy ?? null,
        currentSpeed: 0
    };
    _lastRecordingPreviewAt = 0;
    if (_recordingSettings.showLiveTrack) refreshRecordingPreview(true);
    emitRecordingStatus();
    notify("Registrazione ripristinata in pausa", "info");
    return true;
}

// Richiamato dopo un cambio basemap: MapLibre azzera sorgenti/layer, qui le
// ricreiamo subito invece di attendere il prossimo fix GPS.
export function restoreDeviceOverlays() {
    if (!mapLoaded || !map) return;
    if (_lastFix) {
        updateLocationMarker(_lastFix, _isMoving, _lastHeading);
    }
    if (_recording.state !== 'idle' && _recordingSettings.showLiveTrack) {
        refreshRecordingPreview(true);
    }
}

function createEmptyRecording() {
    return {
        state: 'idle',
        startedAt: null,
        pausedAt: null,
        totalPausedMs: 0,
        points: [],
        lastAcceptedFix: null,
        skipped: 0,
        previewPoints: [],         // punti raw per anteprima immediata
        liveFix: null,             // ultimo fix visualizzato in tempo reale
        smoothed: null,           // ultimo punto smoothed (Kalman-like)
        totalDistanceM: 0,        // distanza percorsa cumulata (m)
        totalGainM: 0,            // dislivello positivo cumulato (m)
        movingMs: 0,              // tempo in movimento (escluse pause/fermi)
        lastEle: null,
        firstFixAccuracy: null,   // accuracy del primo fix (debug/diagnosi)
        currentSpeed: 0           // velocità istantanea ultima nota (m/s)
    };
}

function chooseRecordedPointsForSave(recording) {
    if (recording.points.length >= 2 || recording.previewPoints.length < 2) {
        return recording.points;
    }
    return recording.previewPoints;
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
