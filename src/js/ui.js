// ui.js — renderGisTree, modal management, toolbar handlers, createNewTrack,
//          updateActiveTracksHeader, searchNominatim, showToast, GIS tree operations

import {
    tracks, setTracks,
    activeTrackId, setActiveTrackId,
    activeSegmentId, setActiveSegmentId,
    undoStack,
    isDrawing, setIsDrawing,
    isCutting, setIsCutting,
    isBoxDeleting, setIsBoxDeleting,
    boxDeleteCoords, setBoxDeleteCoords,
    boxDeleteMarker, setBoxDeleteMarker,
    isAddingWaypoint, setIsAddingWaypoint,
    currentSnapProfile,
    currentStyle,
    map, mapLoaded, is3D,
    activeWpForEdit, setActiveWpForEdit
} from './state.js';

import { escapeXml, generateDistinctTrackColor, refreshLucideIcons } from './utils.js';
import { forceUpdateStats, haversineDistance } from './stats.js';
import { trackAnalyticsEvent } from './auth.js';
import { trovaTipoWaypoint } from './waypointTypes.js';
import {
    listStoredTracks,
    loadStoredTrack,
    deleteStoredTrack,
    ensureTrackStorageMeta,
    onLibraryChanged,
    loadPersistedAppSession,
    schedulePersistAppSession,
    schedulePersistTracks
} from './storage.js';

// Riferimenti a funzioni degli altri moduli — iniettati da main.js per evitare
// dipendenze circolari tra ui.js e gli altri moduli
let _updateMapData = null;
let _saveHistoryState = null;
let _setBaseMap = null;
let _setDimensionMode = null;
let _setMapillaryCoverageVisible = null;
let _configureMapillaryToken = null;
let _closeMapillaryViewer = null;
let _flyToPOI = null;
let _triggerUndo = null;
let _importGPX = null;
let _exportGPX = null;
let _addPointToActiveSegment = null;
let _cutTrackAtPoint = null;
let _handleBoxDeleteClick = null;
let _addWaypointAtCoords = null;
let _saveWaypointModifications = null;
let _setSnapProfile = null;
let _togglePrintPlanning = null;
let _disablePrintPlanning = null;
let _updatePrintGridLayout = null;
let _updatePrintGridScale = null;
let _setPrintPlanningOrientation = null;
let _generateHighResPrintPreview = null;
let _syncPrintOutputFromPreview = null;
let _toggleDeviceLocation = null;
let _orientMapToMovementHeading = null;
let _stopDeviceLocation = null;
let _requestDeviceLocationPermission = null;
let _requestDeviceOrientationPermission = null;
let _setDeviceOrientationEnabled = null;
let _setDeviceLocationStatusHandler = null;
let _setDeviceRecordingStatusHandler = null;
let _startDeviceRecording = null;
let _pauseDeviceRecording = null;
let _resumeDeviceRecording = null;
let _finishDeviceRecording = null;
let _getDeviceRecordingStatus = null;
let _getRecordingSettings = null;
let _updateRecordingSettings = null;
let _getDefaultRecordingName = null;
let _localLibraryBound = false;
let _gisDragPayload = null;
let _trackContextMenu = null;
let _trackLongPressTimer = null;
let _lastDeviceLocationStatus = {};
let _permissionRefreshTimer = null;
let _lastPermissionRefreshAt = 0;
let _trackNameLongPressTimer = null;
let _lastTrackNamePointer = { trackId: null, time: 0 };
let _lastTrackNameClick = { trackId: null, time: 0 };
let _treeSelection = [];
let _treeLastSelected = null;
let _treeClipboard = null;
const _compactLayoutMedia = window.matchMedia('(max-width: 767px)');
const MAP_FOCUS_ANIMATION_MS = 1700;
const TOOL_CURSORS = {
    draw: createSvgCursor('<line x1="5" y1="19" x2="19" y2="5" stroke="#f8fafc" stroke-width="3" stroke-linecap="round"/><line x1="4" y1="20" x2="9" y2="19" stroke="#f59e0b" stroke-width="3" stroke-linecap="round"/><path d="M16 4l4 4" stroke="#f8fafc" stroke-width="2" stroke-linecap="round"/>', 4, 20),
    cut: createSvgCursor('<circle cx="7" cy="7" r="3" fill="none" stroke="#f8fafc" stroke-width="2"/><circle cx="7" cy="17" r="3" fill="none" stroke="#f8fafc" stroke-width="2"/><path d="M10 9l11 9M10 15L21 6" stroke="#f8fafc" stroke-width="2.4" stroke-linecap="round"/>', 12, 12),
    box: createSvgCursor('<rect x="4" y="5" width="16" height="14" rx="1.5" fill="rgba(239,68,68,.18)" stroke="#ef4444" stroke-width="2.4" stroke-dasharray="4 2"/><path d="M7 8l10 8M17 8L7 16" stroke="#f8fafc" stroke-width="1.8" stroke-linecap="round"/>', 12, 12),
    waypoint: createSvgCursor('<path d="M12 22s7-6.2 7-12a7 7 0 10-14 0c0 5.8 7 12 7 12z" fill="#2563eb" stroke="#f8fafc" stroke-width="2"/><circle cx="12" cy="10" r="2.5" fill="#f8fafc"/>', 12, 22)
};
const DEVICE_DASHBOARD_STORAGE_KEY = 'gpxsuite-device-dashboard-v1';
const DEVICE_LOCATION_ENABLED_KEY = 'gpxsuite-location-enabled-v1';
const DEVICE_DASHBOARD_TILT_ZERO_KEY = 'gpxsuite-device-tilt-zero-v1';
const DEVICE_DASHBOARD_MOTION_PERMISSION_KEY = 'gpxsuite-motion-permission-v1';
const DEVICE_DASHBOARD_MOTION_ENABLED_KEY = 'gpxsuite-motion-sensor-enabled-v1';
const DEVICE_DASHBOARD_SETTINGS_VERSION = 3;
const DEVICE_DASHBOARD_POSITIONS = ['top-right', 'top-left', 'bottom-center', 'bottom-right', 'bottom-left'];
const DEVICE_DASHBOARD_SIZES = ['compact', 'medium', 'large'];
const DEVICE_DASHBOARD_STYLES = ['map', 'outdoor', 'night'];
const DEFAULT_DEVICE_DASHBOARD_SIZE = 'compact';
const DEFAULT_DEVICE_DASHBOARD_STYLE = 'map';
// Ridotto da 120ms a 250ms: il dashboard sensori non necessita di 8fps,
// 4fps è sufficiente per display numerici (velocità, altitudine, bussola).
const DEVICE_DASHBOARD_SENSOR_RENDER_MS = 250;
// Campionamento massimo dell'orientamento (~15Hz): gli eventi arrivano fino a
// 60Hz ma per inclinometro e registrazione bastano 15 campioni/s, con un
// quarto del lavoro CPU per la normalizzazione/smoothing.
const DEVICE_DASHBOARD_ORIENTATION_SAMPLE_MS = 66;
const DEVICE_DASHBOARD_TILT_MAX_DEG = 35;
const DEVICE_DASHBOARD_ZERO_HOLD_MS = 620;
const DEVICE_DASHBOARD_SENSOR_STALE_MS = 4500;
const DEVICE_DASHBOARD_FIELDS = [{
        id: 'compass',
        label: 'Bussola',
        icon: 'navigation',
        defaultPosition: 'top-right',
        defaultEnabled: true
    },
    {
        id: 'altitude',
        label: 'Altitudine',
        icon: 'mountain',
        defaultPosition: 'top-right',
        defaultEnabled: true
    },
    {
        id: 'speed',
        label: 'Velocità',
        icon: 'gauge',
        defaultPosition: 'top-right',
        defaultEnabled: true
    },
    {
        id: 'tilt',
        label: 'Inclinometro',
        icon: 'gauge',
        defaultPosition: 'bottom-center',
        defaultEnabled: false
    },
    {
        id: 'vibration',
        label: 'Vibrazioni',
        icon: 'activity',
        defaultPosition: 'bottom-center',
        defaultEnabled: false
    }
];
let _deviceLocationPermissionEnabled = readPersistedDeviceLocationEnabled();
let _deviceDashboardSettings = readDeviceDashboardSettings();
let _deviceDashboardSensorListeners = { orientation: false, motion: false };
let _deviceDashboardSensorRenderTimer = null;
let _lastDeviceDashboardSensorRenderAt = 0;
let _deviceDashboardTiltZero = readDeviceDashboardTiltZero();
let _deviceDashboardTiltState = {
    rawTilt: null,
    rawPitch: null,
    tilt: null,
    pitch: null,
    updatedAt: 0
};
let _deviceDashboardMotionState = {
    magnitude: null,
    lastMagnitude: null,
    vibration: null,
    level: null,
    updatedAt: 0
};
let _deviceDashboardTiltHoldTimer = null;
let _deviceDashboardTiltPermissionPrompted = false;
let _deviceDashboardMotionPermissionGranted = readPersistedDashboardMotionGrant();
let _deviceDashboardMotionEnabled = readPersistedDashboardMotionEnabled();
// Dedup stream orientamento: se arriva 'deviceorientationabsolute' ignoriamo
// gli eventi 'deviceorientation' duplicati (doppio lavoro a 60Hz su alcuni browser).
let _dashboardSawAbsoluteOrientation = false;
let _lastDashboardOrientationProcessedAt = 0;
// Ultimo stato registrazione noto: usato per attivare i sensori solo quando servono.
let _lastRecordingSensorStatus = null;
let _dashboardSensorVisibilityBound = false;
// Feed sensori esterno (GPXSuite Logger): quando attivo i listener
// deviceorientation/devicemotion del telefono restano staccati e la
// dashboard viene alimentata da device.js con i dati della BMI270.
let _externalSensorFeedActive = false;

function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function createSvgCursor(svgBody, hotX, hotY) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${svgBody}</svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotX} ${hotY}, crosshair`;
}

function safeHtml(value) {
    return escapeXml(String(value ?? ''));
}

function createDefaultDeviceDashboardSettings() {
    const fields = {};
    DEVICE_DASHBOARD_FIELDS.forEach(field => {
        fields[field.id] = {
            enabled: field.defaultEnabled === true,
            position: field.defaultPosition,
            size: DEFAULT_DEVICE_DASHBOARD_SIZE,
            style: DEFAULT_DEVICE_DASHBOARD_STYLE
        };
    });
    return {
        version: DEVICE_DASHBOARD_SETTINGS_VERSION,
        fields
    };
}

function normalizeDeviceDashboardStyle(value) {
    if (DEVICE_DASHBOARD_STYLES.includes(value)) return value;
    if (value === 'essential') return 'map';
    if (value === 'contrast') return 'outdoor';
    if (value === 'glass') return 'night';
    return DEFAULT_DEVICE_DASHBOARD_STYLE;
}

function normalizeDeviceDashboardSettings(settings) {
    const defaults = createDefaultDeviceDashboardSettings();
    const fields = {};
    const legacySize = DEVICE_DASHBOARD_SIZES.includes(settings?.size) ? settings.size : DEFAULT_DEVICE_DASHBOARD_SIZE;
    const savedVersion = Number(settings?.version) || 0;
    const isLegacySettings = savedVersion > 0 && savedVersion < 2;
    DEVICE_DASHBOARD_FIELDS.forEach(field => {
        const saved = settings?.fields?.[field.id] || {};
        const hasSavedField = Boolean(settings?.fields && Object.prototype.hasOwnProperty.call(settings.fields, field.id));
        const useDefaultConfig = isLegacySettings && saved.enabled !== true;
        const savedPosition = DEVICE_DASHBOARD_POSITIONS.includes(saved.position) ? saved.position : defaults.fields[field.id].position;
        const savedSize = DEVICE_DASHBOARD_SIZES.includes(saved.size) ? saved.size : legacySize;
        const savedStyle = normalizeDeviceDashboardStyle(saved.style);
        fields[field.id] = {
            enabled: isLegacySettings || !hasSavedField ? field.defaultEnabled === true : saved.enabled === true,
            position: useDefaultConfig ? defaults.fields[field.id].position : savedPosition,
            size: savedSize,
            style: savedStyle
        };
    });
    return {
        version: DEVICE_DASHBOARD_SETTINGS_VERSION,
        fields
    };
}

function readPersistedDeviceLocationEnabled() {
    if (typeof localStorage === 'undefined') return true;
    try {
        const value = localStorage.getItem(DEVICE_LOCATION_ENABLED_KEY);
        return value === null ? true : value === 'enabled';
    } catch (err) {
        return true;
    }
}

function persistDeviceLocationEnabled(enabled) {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.setItem(DEVICE_LOCATION_ENABLED_KEY, enabled ? 'enabled' : 'disabled');
    } catch (err) {}
}

function setDeviceLocationPermissionEnabled(enabled) {
    _deviceLocationPermissionEnabled = enabled === true;
    persistDeviceLocationEnabled(_deviceLocationPermissionEnabled);
}

function readDeviceDashboardSettings() {
    if (typeof localStorage === 'undefined') {
        return createDefaultDeviceDashboardSettings();
    }
    try {
        const raw = localStorage.getItem(DEVICE_DASHBOARD_STORAGE_KEY);
        if (!raw) return createDefaultDeviceDashboardSettings();
        return normalizeDeviceDashboardSettings(JSON.parse(raw));
    } catch (err) {
        console.warn('Impostazioni dashboard dispositivo non leggibili:', err);
        return createDefaultDeviceDashboardSettings();
    }
}

function persistDeviceDashboardSettings() {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.setItem(DEVICE_DASHBOARD_STORAGE_KEY, JSON.stringify(_deviceDashboardSettings));
    } catch (err) {
        console.warn('Impostazioni dashboard dispositivo non salvate:', err);
    }
}

function readDeviceDashboardTiltZero() {
    if (typeof localStorage === 'undefined') return { tilt: 0, pitch: 0, updatedAt: 0 };
    try {
        const raw = localStorage.getItem(DEVICE_DASHBOARD_TILT_ZERO_KEY);
        if (!raw) return { tilt: 0, pitch: 0, updatedAt: 0 };
        const parsed = JSON.parse(raw);
        return {
            tilt: Number.isFinite(Number(parsed?.tilt)) ? Number(parsed.tilt) : 0,
            pitch: Number.isFinite(Number(parsed?.pitch)) ? Number(parsed.pitch) : 0,
            updatedAt: Number.isFinite(Number(parsed?.updatedAt)) ? Number(parsed.updatedAt) : 0
        };
    } catch (err) {
        console.warn('Zero inclinometro non leggibile:', err);
        return { tilt: 0, pitch: 0, updatedAt: 0 };
    }
}

function persistDeviceDashboardTiltZero() {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.setItem(DEVICE_DASHBOARD_TILT_ZERO_KEY, JSON.stringify(_deviceDashboardTiltZero));
    } catch (err) {
        console.warn('Zero inclinometro non salvato:', err);
    }
}

function readPersistedDashboardMotionGrant() {
    if (typeof localStorage === 'undefined') return false;
    try {
        return localStorage.getItem(DEVICE_DASHBOARD_MOTION_PERMISSION_KEY) === 'granted';
    } catch (err) {
        return false;
    }
}

function persistDashboardMotionGrant(granted) {
    if (typeof localStorage === 'undefined') return;
    try {
        if (granted) localStorage.setItem(DEVICE_DASHBOARD_MOTION_PERMISSION_KEY, 'granted');
        else localStorage.removeItem(DEVICE_DASHBOARD_MOTION_PERMISSION_KEY);
    } catch (err) {}
}

function readPersistedDashboardMotionEnabled() {
    if (typeof localStorage === 'undefined') return true;
    try {
        const value = localStorage.getItem(DEVICE_DASHBOARD_MOTION_ENABLED_KEY);
        return value === null ? true : value === 'enabled';
    } catch (err) {
        return true;
    }
}

function persistDashboardMotionEnabled(enabled) {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.setItem(DEVICE_DASHBOARD_MOTION_ENABLED_KEY, enabled ? 'enabled' : 'disabled');
    } catch (err) {}
}

function getEnabledDeviceDashboardFields() {
    return DEVICE_DASHBOARD_FIELDS.filter(field => _deviceDashboardSettings.fields[field.id]?.enabled === true);
}

function isDeviceDashboardFieldEnabled(fieldId) {
    return _deviceDashboardSettings.fields[fieldId]?.enabled === true;
}

function isDeviceDashboardSensorFresh(updatedAt) {
    return Number.isFinite(updatedAt) && updatedAt > 0 && Date.now() - updatedAt <= DEVICE_DASHBOARD_SENSOR_STALE_MS;
}

function isDashboardOrientationEnabled() {
    return _lastDeviceLocationStatus.orientationPermission !== 'disabled';
}

function setDashboardMotionEnabled(enabled) {
    const nextEnabled = enabled === true;
    if (_deviceDashboardMotionEnabled === nextEnabled) return _deviceDashboardMotionEnabled;

    _deviceDashboardMotionEnabled = nextEnabled;
    persistDashboardMotionEnabled(nextEnabled);
    if (!nextEnabled) {
        _deviceDashboardMotionState = { magnitude: null, lastMagnitude: null, vibration: null, level: null, updatedAt: 0 };
    }
    syncDeviceDashboardSensors();
    scheduleDeviceDashboardSensorRender();
    return _deviceDashboardMotionEnabled;
}

function disableDeviceSensorPermissions() {
    _setDeviceOrientationEnabled?.(false);
    setDashboardMotionEnabled(false);
    syncDeviceDashboardSensors();
    renderDeviceDashboard();
    scheduleDevicePermissionRefresh(true);
}

function clampDeviceDashboardValue(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function formatDeviceDashboardSignedDegree(value) {
    const number = parseDeviceDashboardNumber(value);
    if (number === null) return '--°';
    const rounded = Math.round(number);
    return `${rounded > 0 ? '+' : ''}${rounded}°`;
}

function getScreenOrientationAngle() {
    const angle = Number(window.screen?.orientation?.angle ?? window.orientation ?? 0);
    if (!Number.isFinite(angle)) return 0;
    return ((angle % 360) + 360) % 360;
}

function normalizeDeviceDashboardOrientation(event) {
    const beta = Number(event?.beta);
    const gamma = Number(event?.gamma);
    if (!Number.isFinite(beta) || !Number.isFinite(gamma)) return null;

    const angle = getScreenOrientationAngle();
    if (angle === 90) return { tilt: beta, pitch: -gamma };
    if (angle === 270) return { tilt: -beta, pitch: gamma };
    if (angle === 180) return { tilt: -gamma, pitch: -beta };
    return { tilt: gamma, pitch: beta };
}

async function requestDashboardMotionPermission() {
    if (typeof window.DeviceMotionEvent === 'undefined') {
        showToast("Sensore vibrazioni non supportato da questo browser", "error");
        return false;
    }
    setDashboardMotionEnabled(true);
    if (_deviceDashboardMotionPermissionGranted) {
        syncDeviceDashboardSensors();
        scheduleDeviceDashboardSensorRender();
        return true;
    }
    try {
        const MotionEvent = window.DeviceMotionEvent;
        if (typeof MotionEvent.requestPermission === 'function') {
            const permission = await MotionEvent.requestPermission();
            if (permission !== 'granted') {
                setDashboardMotionEnabled(false);
                showToast("Permesso movimento non concesso", "error");
                return false;
            }
        }
        _deviceDashboardMotionPermissionGranted = true;
        persistDashboardMotionGrant(true);
        syncDeviceDashboardSensors();
        scheduleDeviceDashboardSensorRender();
        return true;
    } catch (err) {
        console.warn('Movimento dispositivo non disponibile', err);
        setDashboardMotionEnabled(false);
        showToast("Sensore vibrazioni non disponibile", "error");
        return false;
    }
}

async function requestDashboardOrientationPermission(options = {}) {
    if (typeof window.DeviceOrientationEvent === 'undefined') {
        showToast("Inclinometro non supportato da questo browser", "error");
        return false;
    }
    _setDeviceOrientationEnabled?.(true);
    if (_requestDeviceOrientationPermission) {
        const granted = await _requestDeviceOrientationPermission({ forcePrompt: options.forcePrompt === true });
        if (granted) {
            syncDeviceDashboardSensors();
            scheduleDeviceDashboardSensorRender();
        }
        return granted;
    }
    try {
        const OrientationEvent = window.DeviceOrientationEvent;
        let granted = true;
        if (typeof OrientationEvent.requestPermission === 'function') {
            const permission = await OrientationEvent.requestPermission();
            granted = permission === 'granted';
        }
        if (granted) {
            syncDeviceDashboardSensors();
            scheduleDeviceDashboardSensorRender();
        }
        return granted;
    } catch (err) {
        console.warn('Inclinometro non disponibile', err);
        return false;
    }
}

function requestDashboardSensorPermissionsFromGesture() {
    const requests = [];
    if (typeof window.DeviceOrientationEvent !== 'undefined') {
        _setDeviceOrientationEnabled?.(true);
        requests.push(requestDashboardOrientationPermission({ forcePrompt: true }));
    }
    if (typeof window.DeviceMotionEvent !== 'undefined') {
        setDashboardMotionEnabled(true);
        requests.push(requestDashboardMotionPermission());
    }
    if (requests.length === 0) return;

    Promise.allSettled(requests).then(() => {
        syncDeviceDashboardSettingsForm();
        scheduleDevicePermissionRefresh(true);
    });
}

async function ensureDashboardTiltPermissionIfEnabled(fromGesture = false) {
    if (!isDeviceDashboardFieldEnabled('tilt')) return false;
    if (!isDashboardOrientationEnabled()) return false;
    if (typeof window.DeviceOrientationEvent === 'undefined') return false;
    if (isDeviceDashboardSensorFresh(_deviceDashboardTiltState.updatedAt)) return true;

    const OrientationEvent = window.DeviceOrientationEvent;
    const requiresGesture = typeof OrientationEvent.requestPermission === 'function';
    if (requiresGesture && !fromGesture) {
        if (!_deviceDashboardTiltPermissionPrompted) {
            _deviceDashboardTiltPermissionPrompted = true;
            showToast("Tocca l'inclinometro per autorizzare il sensore", "info");
        }
        return false;
    }

    _deviceDashboardTiltPermissionPrompted = true;
    const granted = await requestDashboardOrientationPermission({ forcePrompt: true });
    if (granted) {
        syncDeviceDashboardSensors();
        scheduleDeviceDashboardSensorRender();
    }
    return granted;
}

function scheduleDeviceDashboardSensorRender() {
    const now = Date.now();
    const elapsed = now - _lastDeviceDashboardSensorRenderAt;
    if (elapsed >= DEVICE_DASHBOARD_SENSOR_RENDER_MS) {
        _lastDeviceDashboardSensorRenderAt = now;
        if (_deviceDashboardSensorRenderTimer) {
            clearTimeout(_deviceDashboardSensorRenderTimer);
            _deviceDashboardSensorRenderTimer = null;
        }
        renderDeviceDashboard();
        return;
    }
    if (_deviceDashboardSensorRenderTimer) return;
    _deviceDashboardSensorRenderTimer = setTimeout(() => {
        _deviceDashboardSensorRenderTimer = null;
        _lastDeviceDashboardSensorRenderAt = Date.now();
        renderDeviceDashboard();
    }, DEVICE_DASHBOARD_SENSOR_RENDER_MS - elapsed);
}

function handleDeviceDashboardOrientation(event) {
    // Processa un solo stream quando il browser li emette entrambi.
    if (event.type === 'deviceorientationabsolute') {
        _dashboardSawAbsoluteOrientation = true;
    } else if (_dashboardSawAbsoluteOrientation) {
        return;
    }
    // Sottocampionamento a ~15Hz: meno trigonometria e smoothing per evento.
    const nowSample = Date.now();
    if (nowSample - _lastDashboardOrientationProcessedAt < DEVICE_DASHBOARD_ORIENTATION_SAMPLE_MS) return;
    _lastDashboardOrientationProcessedAt = nowSample;

    const angles = normalizeDeviceDashboardOrientation(event);
    if (!angles) return;

    const rawTilt = angles.tilt;
    const rawPitch = angles.pitch;
    const tilt = clampDeviceDashboardValue(rawTilt - _deviceDashboardTiltZero.tilt, -89, 89);
    const pitch = clampDeviceDashboardValue(rawPitch - _deviceDashboardTiltZero.pitch, -89, 89);
    const fresh = isDeviceDashboardSensorFresh(_deviceDashboardTiltState.updatedAt);
    const smooth = fresh ? 0.28 : 1;

    _deviceDashboardTiltState = {
        rawTilt,
        rawPitch,
        tilt: Number.isFinite(_deviceDashboardTiltState.tilt) ?
            (_deviceDashboardTiltState.tilt * (1 - smooth) + tilt * smooth) :
            tilt,
        pitch: Number.isFinite(_deviceDashboardTiltState.pitch) ?
            (_deviceDashboardTiltState.pitch * (1 - smooth) + pitch * smooth) :
            pitch,
        updatedAt: Date.now()
    };
    scheduleDeviceDashboardSensorRender();
}

function handleDeviceDashboardMotion(event) {
    const acceleration = event?.acceleration || event?.accelerationIncludingGravity;
    if (!acceleration) return;

    const ax = Number(acceleration.x) || 0;
    const ay = Number(acceleration.y) || 0;
    const az = Number(acceleration.z) || 0;
    const magnitude = Math.sqrt(ax * ax + ay * ay + az * az);
    const previousMagnitude = Number.isFinite(_deviceDashboardMotionState.magnitude) ?
        _deviceDashboardMotionState.magnitude :
        magnitude;
    const jerk = Math.abs(magnitude - previousMagnitude);
    const previousVibration = Number.isFinite(_deviceDashboardMotionState.vibration) ?
        _deviceDashboardMotionState.vibration :
        jerk;
    const vibration = previousVibration * 0.82 + jerk * 0.18;
    const level = clampDeviceDashboardValue(Math.round(1 + Math.min(vibration, 5.5) / 5.5 * 9), 1, 10);

    _deviceDashboardMotionState = {
        magnitude,
        lastMagnitude: previousMagnitude,
        vibration,
        level,
        updatedAt: Date.now()
    };
    scheduleDeviceDashboardSensorRender();
}

// Indica se la registrazione attiva richiede un sensore (cattura abilitata nelle
// impostazioni). In pausa o idle i sensori della registrazione restano spenti.
function recordingNeedsSensor(kind) {
    const status = _lastRecordingSensorStatus;
    if (!status || status.state !== 'recording') return false;
    const settings = status.settings || {};
    if (kind === 'orientation') return settings.recordTiltPitch !== false;
    return settings.recordVibration !== false;
}

function syncDeviceDashboardSensors() {
    // I listener sensore restano attivi solo quando servono davvero:
    // campo dashboard abilitato oppure registrazione in corso con cattura attiva.
    // A pagina nascosta vengono sempre staccati (risparmio batteria/CPU);
    // il visibilitychange qui sotto li riattacca al ritorno in primo piano.
    if (!_dashboardSensorVisibilityBound && typeof document !== 'undefined') {
        _dashboardSensorVisibilityBound = true;
        document.addEventListener('visibilitychange', syncDeviceDashboardSensors);
    }
    const pageHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const needsOrientation = !pageHidden && !_externalSensorFeedActive && isDashboardOrientationEnabled() &&
        (isDeviceDashboardFieldEnabled('tilt') || recordingNeedsSensor('orientation'));
    const needsMotion = !pageHidden && !_externalSensorFeedActive && _deviceDashboardMotionEnabled &&
        (isDeviceDashboardFieldEnabled('vibration') || recordingNeedsSensor('motion'));

    if (needsOrientation && !_deviceDashboardSensorListeners.orientation && typeof window.DeviceOrientationEvent !== 'undefined') {
        window.addEventListener('deviceorientationabsolute', handleDeviceDashboardOrientation, true);
        window.addEventListener('deviceorientation', handleDeviceDashboardOrientation, true);
        _deviceDashboardSensorListeners.orientation = true;
    } else if (!needsOrientation && _deviceDashboardSensorListeners.orientation) {
        window.removeEventListener('deviceorientationabsolute', handleDeviceDashboardOrientation, true);
        window.removeEventListener('deviceorientation', handleDeviceDashboardOrientation, true);
        _deviceDashboardSensorListeners.orientation = false;
        _dashboardSawAbsoluteOrientation = false;
        _deviceDashboardTiltState = { rawTilt: null, rawPitch: null, tilt: null, pitch: null, updatedAt: 0 };
    }

    if (needsMotion && !_deviceDashboardSensorListeners.motion && typeof window.DeviceMotionEvent !== 'undefined') {
        window.addEventListener('devicemotion', handleDeviceDashboardMotion, true);
        _deviceDashboardSensorListeners.motion = true;
    } else if (!needsMotion && _deviceDashboardSensorListeners.motion) {
        window.removeEventListener('devicemotion', handleDeviceDashboardMotion, true);
        _deviceDashboardSensorListeners.motion = false;
        _deviceDashboardMotionState = { magnitude: null, lastMagnitude: null, vibration: null, level: null, updatedAt: 0 };
    }
}

// Feed sensori esterno (GPXSuite Logger). Attivato/disattivato da device.js.
export function setExternalSensorFeed(active) {
    const next = active === true;
    if (next === _externalSensorFeedActive) return;
    _externalSensorFeedActive = next;
    if (!next) {
        _deviceDashboardTiltState = { rawTilt: null, rawPitch: null, tilt: null, pitch: null, updatedAt: 0 };
        _deviceDashboardMotionState = { magnitude: null, lastMagnitude: null, vibration: null, level: null, updatedAt: 0 };
    }
    syncDeviceDashboardSensors();
    scheduleDeviceDashboardSensorRender();
}

// Dati BMI270 dal logger verso la dashboard (pitch/tilt in gradi, vibrazione 1-10).
// Il logger e' gia' calibrato a bordo: nessuno zero locale da applicare.
export function feedExternalDashboardSensors(data = {}) {
    if (!_externalSensorFeedActive) return;
    const now = Date.now();
    if (Number.isFinite(data.pitch) || Number.isFinite(data.tilt)) {
        _deviceDashboardTiltState = {
            rawTilt: Number.isFinite(data.tilt) ? data.tilt : null,
            rawPitch: Number.isFinite(data.pitch) ? data.pitch : null,
            tilt: Number.isFinite(data.tilt) ? data.tilt : _deviceDashboardTiltState.tilt,
            pitch: Number.isFinite(data.pitch) ? data.pitch : _deviceDashboardTiltState.pitch,
            updatedAt: now
        };
    }
    if (Number.isFinite(data.vibrationLevel)) {
        _deviceDashboardMotionState = {
            magnitude: null,
            lastMagnitude: null,
            vibration: null,
            level: clampDeviceDashboardValue(Math.round(data.vibrationLevel), 1, 10),
            updatedAt: now
        };
    }
    scheduleDeviceDashboardSensorRender();
}

// Restituisce i dati sensore correnti per arricchire i punti GPS durante la registrazione.
// Chiamata da location.js tramite dependency injection in initDeviceLocation.
export function getCurrentRecordingSensorData() {
    const tiltFresh = isDeviceDashboardSensorFresh(_deviceDashboardTiltState.updatedAt);
    const motionFresh = isDeviceDashboardSensorFresh(_deviceDashboardMotionState.updatedAt);
    const orientationOk = isDashboardOrientationEnabled() || _externalSensorFeedActive;
    const motionOk = _deviceDashboardMotionEnabled || _externalSensorFeedActive;
    return {
        tilt: orientationOk && tiltFresh && Number.isFinite(_deviceDashboardTiltState.tilt) ? _deviceDashboardTiltState.tilt : null,
        pitch: orientationOk && tiltFresh && Number.isFinite(_deviceDashboardTiltState.pitch) ? _deviceDashboardTiltState.pitch : null,
        vibrationLevel: motionOk && motionFresh && Number.isFinite(_deviceDashboardMotionState.level) ? _deviceDashboardMotionState.level : null
    };
}

function setDeviceDashboardTiltZeroFromCurrent() {
    if (!isDeviceDashboardSensorFresh(_deviceDashboardTiltState.updatedAt)) {
        showToast("Inclinometro non ancora disponibile", "info");
        return false;
    }
    _deviceDashboardTiltZero = {
        tilt: _deviceDashboardTiltState.rawTilt,
        pitch: _deviceDashboardTiltState.rawPitch,
        updatedAt: Date.now()
    };
    persistDeviceDashboardTiltZero();
    showToast("Zero inclinometro impostato", "success");
    renderDeviceDashboard();
    return true;
}

function clearDeviceDashboardTiltHold(card) {
    if (_deviceDashboardTiltHoldTimer) {
        clearTimeout(_deviceDashboardTiltHoldTimer);
        _deviceDashboardTiltHoldTimer = null;
    }
    card?.classList.remove('device-dashboard-card--zero-arming');
}

function bindDeviceDashboardCardInteractions() {
    const compassCard = document.querySelector('[data-dashboard-field-card="compass"]');
    if (compassCard && compassCard.dataset.bound !== 'true') {
        compassCard.dataset.bound = 'true';
        const orientToMovement = event => {
            event.preventDefault();
            if (_orientMapToMovementHeading) {
                _orientMapToMovementHeading();
                return;
            }
            showToast("Direzione di movimento non disponibile", "info");
        };
        compassCard.addEventListener('click', orientToMovement);
        compassCard.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            orientToMovement(event);
        });
    }

    const tiltCard = document.querySelector('[data-dashboard-field-card="tilt"]');
    if (!tiltCard || tiltCard.dataset.bound === 'true') return;
    tiltCard.dataset.bound = 'true';
    const startHold = event => {
        event.preventDefault();
        clearDeviceDashboardTiltHold(tiltCard);
        const needsGesturePermission = typeof window.DeviceOrientationEvent !== 'undefined' &&
            typeof window.DeviceOrientationEvent.requestPermission === 'function' &&
            !isDeviceDashboardSensorFresh(_deviceDashboardTiltState.updatedAt);
        if (needsGesturePermission) {
            ensureDashboardTiltPermissionIfEnabled(true).catch(err => console.warn('Permesso inclinometro non richiesto:', err));
            return;
        }
        tiltCard.classList.add('device-dashboard-card--zero-arming');
        _deviceDashboardTiltHoldTimer = setTimeout(() => {
            _deviceDashboardTiltHoldTimer = null;
            tiltCard.classList.remove('device-dashboard-card--zero-arming');
            setDeviceDashboardTiltZeroFromCurrent();
        }, DEVICE_DASHBOARD_ZERO_HOLD_MS);
        if (typeof tiltCard.setPointerCapture === 'function' && event.pointerId !== undefined) {
            try { tiltCard.setPointerCapture(event.pointerId); } catch (err) {}
        }
    };
    tiltCard.addEventListener('pointerdown', startHold);
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(eventName => {
        tiltCard.addEventListener(eventName, () => clearDeviceDashboardTiltHold(tiltCard));
    });
}

function updateDeviceDashboardSettingsBadge() {
    const badge = document.getElementById('device-dashboard-settings-badge');
    if (!badge) return;
    const enabledCount = getEnabledDeviceDashboardFields().length;
    badge.textContent = enabledCount === 1 ? '1 campo' : `${enabledCount} campi`;
    badge.className = enabledCount > 0 ?
        'text-[9px] bg-sky-950 text-sky-300 px-1.5 py-0.5 rounded border border-sky-900 font-bold uppercase' :
        'text-[9px] bg-gray-950 text-gray-400 px-1.5 py-0.5 rounded border border-gray-800 font-bold uppercase';
}

function setDeviceDashboardSettingsExpanded(expanded) {
    const panel = document.getElementById('device-dashboard-settings-panel');
    const toggle = document.getElementById('device-dashboard-settings-toggle');
    const content = document.getElementById('device-dashboard-settings-content');
    if (!panel || !toggle || !content) return;
    panel.dataset.expanded = expanded ? 'true' : 'false';
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    content.classList.toggle('hidden', !expanded);
    if (!expanded) collapseDeviceDashboardFieldSettings();
}

function setDeviceDashboardFieldSettingsExpanded(fieldId, expanded) {
    const row = document.querySelector(`[data-dashboard-setting-row="${fieldId}"]`);
    const toggle = document.querySelector(`[data-dashboard-setting-toggle="${fieldId}"]`);
    if (!row) return;
    row.dataset.expanded = expanded ? 'true' : 'false';
    if (toggle) toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}

function collapseDeviceDashboardFieldSettings() {
    DEVICE_DASHBOARD_FIELDS.forEach(field => setDeviceDashboardFieldSettingsExpanded(field.id, false));
}

function collapseDeviceDashboardSettingsPanel() {
    setDeviceDashboardSettingsExpanded(false);
    collapseDeviceDashboardFieldSettings();
}

function syncDeviceDashboardSettingsForm() {
    DEVICE_DASHBOARD_FIELDS.forEach(field => {
        const fieldSettings = _deviceDashboardSettings.fields[field.id];
        const toggle = document.querySelector(`[data-dashboard-field="${field.id}"]`);
        const position = document.querySelector(`[data-dashboard-position-field="${field.id}"]`);
        const size = document.querySelector(`[data-dashboard-size-field="${field.id}"]`);
        const style = document.querySelector(`[data-dashboard-style-field="${field.id}"]`);
        if (toggle) toggle.checked = fieldSettings?.enabled === true;
        if (position) {
            position.value = fieldSettings?.position || field.defaultPosition;
            position.disabled = fieldSettings?.enabled !== true;
            position.classList.toggle('opacity-50', fieldSettings?.enabled !== true);
        }
        if (size) {
            size.value = fieldSettings?.size || DEFAULT_DEVICE_DASHBOARD_SIZE;
            size.disabled = fieldSettings?.enabled !== true;
            size.classList.toggle('opacity-50', fieldSettings?.enabled !== true);
        }
        if (style) {
            style.value = fieldSettings?.style || DEFAULT_DEVICE_DASHBOARD_STYLE;
            style.disabled = fieldSettings?.enabled !== true;
            style.classList.toggle('opacity-50', fieldSettings?.enabled !== true);
        }
    });
    updateDeviceDashboardSettingsBadge();
    renderDeviceDashboard();
}

function bindDeviceDashboardSettingsForm() {
    const toggle = document.getElementById('device-dashboard-settings-toggle');
    if (toggle && toggle.dataset.bound !== 'true') {
        toggle.dataset.bound = 'true';
        setDeviceDashboardSettingsExpanded(false);
        toggle.addEventListener('click', () => {
            const panel = document.getElementById('device-dashboard-settings-panel');
            setDeviceDashboardSettingsExpanded(panel?.dataset.expanded !== 'true');
        });
    }

    DEVICE_DASHBOARD_FIELDS.forEach(field => {
        const enabledInput = document.querySelector(`[data-dashboard-field="${field.id}"]`);
        const positionInput = document.querySelector(`[data-dashboard-position-field="${field.id}"]`);
        const sizeInput = document.querySelector(`[data-dashboard-size-field="${field.id}"]`);
        const styleInput = document.querySelector(`[data-dashboard-style-field="${field.id}"]`);
        const row = enabledInput?.closest('.device-dashboard-setting-row');

        if (row && row.dataset.bound !== 'true') {
            row.dataset.bound = 'true';
            row.dataset.dashboardSettingRow = field.id;
            row.dataset.expanded = 'false';
            row.setAttribute('role', 'button');
            row.setAttribute('tabindex', '0');
            row.setAttribute('aria-expanded', 'false');
            row.setAttribute('data-dashboard-setting-toggle', field.id);
            row.addEventListener('click', event => {
                if (event.target.closest('[data-dashboard-field]') || event.target.closest('label') || event.target.closest('.device-dashboard-field-controls')) return;
                event.preventDefault();
                const expanded = row.dataset.expanded !== 'true';
                setDeviceDashboardFieldSettingsExpanded(field.id, expanded);
            });
            row.addEventListener('keydown', event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                if (event.target.closest('[data-dashboard-field]') || event.target.closest('label') || event.target.closest('.device-dashboard-field-controls')) return;
                event.preventDefault();
                const expanded = row.dataset.expanded !== 'true';
                setDeviceDashboardFieldSettingsExpanded(field.id, expanded);
            });
        }

        if (enabledInput && enabledInput.dataset.bound !== 'true') {
            enabledInput.dataset.bound = 'true';
            enabledInput.addEventListener('change', async() => {
                _deviceDashboardSettings.fields[field.id].enabled = enabledInput.checked;
                persistDeviceDashboardSettings();
                if (enabledInput.checked && field.id === 'tilt') {
                    _deviceDashboardTiltPermissionPrompted = false;
                    await requestDashboardOrientationPermission({ forcePrompt: true });
                }
                if (enabledInput.checked && field.id === 'vibration') {
                    await requestDashboardMotionPermission();
                }
                syncDeviceDashboardSettingsForm();
                schedulePersistAppSession();
            });
        }

        if (positionInput && positionInput.dataset.bound !== 'true') {
            positionInput.dataset.bound = 'true';
            positionInput.addEventListener('change', () => {
                if (DEVICE_DASHBOARD_POSITIONS.includes(positionInput.value)) {
                    _deviceDashboardSettings.fields[field.id].position = positionInput.value;
                    persistDeviceDashboardSettings();
                    renderDeviceDashboard();
                    schedulePersistAppSession();
                }
            });
        }

        if (sizeInput && sizeInput.dataset.bound !== 'true') {
            sizeInput.dataset.bound = 'true';
            sizeInput.addEventListener('change', () => {
                _deviceDashboardSettings.fields[field.id].size = DEVICE_DASHBOARD_SIZES.includes(sizeInput.value) ?
                    sizeInput.value :
                    DEFAULT_DEVICE_DASHBOARD_SIZE;
                persistDeviceDashboardSettings();
                renderDeviceDashboard();
                schedulePersistAppSession();
            });
        }

        if (styleInput && styleInput.dataset.bound !== 'true') {
            styleInput.dataset.bound = 'true';
            styleInput.addEventListener('change', () => {
                _deviceDashboardSettings.fields[field.id].style = normalizeDeviceDashboardStyle(styleInput.value);
                persistDeviceDashboardSettings();
                renderDeviceDashboard();
                schedulePersistAppSession();
            });
        }
    });

    syncDeviceDashboardSettingsForm();
}

function parseDeviceDashboardNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function formatDeviceDashboardNumber(value, decimals = 0) {
    const number = parseDeviceDashboardNumber(value);
    if (number === null) return null;
    return number.toFixed(decimals);
}

function cardinalDirectionFromHeading(heading) {
    const directions = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
    const normalized = ((Number(heading) % 360) + 360) % 360;
    return directions[Math.round(normalized / 45) % directions.length];
}

function getLocationUnavailableMeta(status) {
    if (status.waiting) return 'In attesa GPS';
    if (!status.active) return 'GPS non attivo';
    return 'Dato non disponibile';
}

function buildDeviceDashboardTiltMetric() {
    if (!isDashboardOrientationEnabled()) {
        return {
            available: false,
            value: '--° --°',
            valueClass: 'device-dashboard-value--tilt',
            meta: 'Orientamento disattivato'
        };
    }
    const fresh = isDeviceDashboardSensorFresh(_deviceDashboardTiltState.updatedAt);
    const tilt = fresh ? _deviceDashboardTiltState.tilt : null;
    const pitch = fresh ? _deviceDashboardTiltState.pitch : null;
    const tiltPercent = fresh ? clampDeviceDashboardValue((tilt / DEVICE_DASHBOARD_TILT_MAX_DEG) * 42, -42, 42) : 0;
    const pitchPercent = fresh ? clampDeviceDashboardValue((pitch / DEVICE_DASHBOARD_TILT_MAX_DEG) * 42, -42, 42) : 0;
    const horizonRotation = fresh ? clampDeviceDashboardValue(-tilt, -45, 45) : 0;
    const zeroActive = _deviceDashboardTiltZero.updatedAt > 0;
    const statusLabel = fresh ? (zeroActive ? 'ZERO' : 'LIVE') : 'N/D';

    return {
        available: fresh,
        value: fresh ? `${formatDeviceDashboardSignedDegree(tilt)} ${formatDeviceDashboardSignedDegree(pitch)}` : '--° --°',
        valueClass: 'device-dashboard-value--tilt',
        meta: fresh ? 'Inclinometro dispositivo' : 'Sensore non disponibile',
        valueHtml: `
            <div class="device-tilt-widget">
                <div class="device-tilt-gauge" style="--tilt-x:${tiltPercent.toFixed(1)}%;--tilt-y:${pitchPercent.toFixed(1)}%;--tilt-rotation:${horizonRotation.toFixed(1)}deg">
                    <div class="device-tilt-crosshair"></div>
                    <div class="device-tilt-horizon"></div>
                    <div class="device-tilt-ball"></div>
                </div>
                <div class="device-tilt-readouts">
                    <div class="device-tilt-readout">
                        <span class="device-tilt-readout-label">Tilt</span>
                        <span class="device-tilt-readout-value">${safeHtml(formatDeviceDashboardSignedDegree(tilt))}</span>
                    </div>
                    <div class="device-tilt-readout">
                        <span class="device-tilt-readout-label">Pitch</span>
                        <span class="device-tilt-readout-value">${safeHtml(formatDeviceDashboardSignedDegree(pitch))}</span>
                    </div>
                    <div class="device-tilt-status">${safeHtml(statusLabel)}</div>
                </div>
            </div>
        `
    };
}

function renderDeviceDashboardVibrationBars(level) {
    let html = '';
    for (let i = 1; i <= 10; i++) {
        html += `<span class="device-vibration-bar" data-active="${level !== null && i <= level ? 'true' : 'false'}"></span>`;
    }
    return html;
}

function buildDeviceDashboardVibrationMetric() {
    if (!_deviceDashboardMotionEnabled) {
        return {
            available: false,
            value: '--/10',
            valueClass: 'device-dashboard-value--vibration',
            meta: 'Vibrazioni disattivate'
        };
    }
    const fresh = isDeviceDashboardSensorFresh(_deviceDashboardMotionState.updatedAt);
    const level = fresh ? _deviceDashboardMotionState.level : null;
    const vibration = fresh ? _deviceDashboardMotionState.vibration : null;
    const fill = level !== null ? `${level * 10}%` : '0%';

    return {
        available: fresh,
        value: level !== null ? `${level}/10` : '--/10',
        valueClass: 'device-dashboard-value--vibration',
        meta: fresh ? 'Vibrazione dispositivo' : 'Sensore non disponibile',
        valueHtml: `
            <div class="device-vibration-widget" style="--vibration-fill:${safeHtml(fill)}">
                <div class="device-vibration-main">
                    <span class="device-vibration-score">${level !== null ? safeHtml(level) : '--'}</span>
                    <span class="device-vibration-scale">/10</span>
                </div>
                <div class="device-vibration-bars">${renderDeviceDashboardVibrationBars(level)}</div>
                <div class="device-vibration-trace">${vibration !== null ? safeHtml(formatDeviceDashboardNumber(vibration, 1)) : 'N/D'}</div>
            </div>
        `
    };
}

function buildDeviceDashboardMetric(field, status) {
    const fix = status.fix || {};
    const heading = parseDeviceDashboardNumber(status.heading);
    const active = Boolean(status.active);

    if (field.id === 'compass') {
        if (active && heading !== null) {
            const degrees = Math.round(heading);
            return {
                available: true,
                value: `${degrees}°`,
                meta: cardinalDirectionFromHeading(degrees),
                heading: degrees
            };
        }
        return {
            available: false,
            value: '--°',
            meta: getLocationUnavailableMeta(status),
            heading: 0
        };
    }

    if (field.id === 'altitude') {
        const altitude = active ? formatDeviceDashboardNumber(fix.ele, 0) : null;
        return {
            available: altitude !== null,
            value: altitude !== null ? `${altitude} m` : '-- m',
            meta: altitude !== null ? 'Quota dispositivo' : getLocationUnavailableMeta(status)
        };
    }

    if (field.id === 'speed') {
        const speedMps = parseDeviceDashboardNumber(fix.speed);
        const speedKmh = active && speedMps !== null ? formatDeviceDashboardNumber(speedMps * 3.6, 1) : null;
        return {
            available: speedKmh !== null,
            value: speedKmh !== null ? `${speedKmh} km/h` : '-- km/h',
            meta: speedKmh !== null ? (status.moving ? 'In movimento' : 'Fermo') : getLocationUnavailableMeta(status)
        };
    }

    if (field.id === 'tilt') {
        return buildDeviceDashboardTiltMetric();
    }

    if (field.id === 'vibration') {
        return buildDeviceDashboardVibrationMetric();
    }

    return {
        available: false,
        value: '--',
        meta: ''
    };
}

function renderDeviceDashboardCard(field, status, prebuiltMetric = null) {
    const metric = prebuiltMetric || buildDeviceDashboardMetric(field, status);
    const metricHeading = parseDeviceDashboardNumber(metric.heading);
    const headingStyle = metricHeading !== null ? ` style="--device-dashboard-heading:${metricHeading}deg"` : '';
    const valueHtml = metric.valueHtml || safeHtml(metric.value);
    const fieldSettings = _deviceDashboardSettings.fields[field.id] || {};
    const size = DEVICE_DASHBOARD_SIZES.includes(fieldSettings.size) ? fieldSettings.size : DEFAULT_DEVICE_DASHBOARD_SIZE;
    const style = normalizeDeviceDashboardStyle(fieldSettings.style);
    const title = field.id === 'tilt' ?
        'Tieni premuto per impostare lo zero' :
        (field.id === 'compass' ? 'Orienta mappa verso direzione di marcia' : safeHtml(metric.meta || field.label));
    const titleAttr = title ? ` title="${safeHtml(title)}"` : '';
    const interactionAttrs = field.id === 'compass' ? ' role="button" tabindex="0"' : '';
    return `
        <div class="device-dashboard-card device-dashboard-card--${safeHtml(field.id)}" data-dashboard-field-card="${safeHtml(field.id)}" data-dashboard-size="${safeHtml(size)}" data-dashboard-style="${safeHtml(style)}"${titleAttr}${headingStyle}${interactionAttrs}>
            <div class="device-dashboard-icon">
                <i data-lucide="${safeHtml(field.icon)}" class="w-4 h-4"></i>
            </div>
            <div class="device-dashboard-value ${safeHtml(metric.valueClass || '')}">${valueHtml}</div>
            <div class="device-dashboard-label">${safeHtml(field.label)}</div>
            <div class="device-dashboard-meta">${safeHtml(metric.meta)}</div>
        </div>
    `;
}

function renderDeviceDashboard() {
    const dashboard = document.getElementById('device-dashboard');
    if (!dashboard) return;
    const zoneEls = {};
    DEVICE_DASHBOARD_POSITIONS.forEach(position => {
        const zone = dashboard.querySelector(`[data-dashboard-zone="${position}"]`);
        if (zone) {
            zone.innerHTML = '';
            zoneEls[position] = zone;
        }
    });

    const enabledFields = getEnabledDeviceDashboardFields();
    const hasBottomCenterWidget = enabledFields.some(field => {
        const position = _deviceDashboardSettings.fields[field.id]?.position || field.defaultPosition;
        return position === 'bottom-center';
    });
    const hasBottomWidget = enabledFields.some(field => {
        const position = _deviceDashboardSettings.fields[field.id]?.position || field.defaultPosition;
        return position.startsWith('bottom-');
    });
    document.body.classList.toggle('device-dashboard-bottom-center-active', hasBottomCenterWidget);
    document.body.classList.toggle('device-dashboard-bottom-active', hasBottomWidget);
    syncDeviceDashboardSensors();
    dashboard.classList.toggle('hidden', enabledFields.length === 0);
    if (enabledFields.length === 0) return;

    enabledFields.forEach(field => {
        // Mostra il widget solo quando ci sono dati reali dal sensore/GPS:
        // su desktop (o senza permessi) le card "N/D" sono solo rumore visivo.
        const metric = buildDeviceDashboardMetric(field, _lastDeviceLocationStatus);
        if (metric.available === false) return;
        const position = _deviceDashboardSettings.fields[field.id]?.position || field.defaultPosition;
        const zone = zoneEls[position] || zoneEls[field.defaultPosition];
        if (zone) zone.insertAdjacentHTML('beforeend', renderDeviceDashboardCard(field, _lastDeviceLocationStatus, metric));
    });
    refreshLucideIcons();
    bindDeviceDashboardCardInteractions();
}

export function updateMapToolCursor() {
    if (!map) return;
    const canvas = map.getCanvas();
    if (!canvas) return;
    if (isDrawing) canvas.style.cursor = TOOL_CURSORS.draw;
    else if (isCutting) canvas.style.cursor = TOOL_CURSORS.cut;
    else if (isBoxDeleting) canvas.style.cursor = TOOL_CURSORS.box;
    else if (isAddingWaypoint) canvas.style.cursor = TOOL_CURSORS.waypoint;
    else canvas.style.cursor = '';
}

function setToolButtonState(buttonId, active) {
    document.getElementById(buttonId)?.classList.toggle('bg-blue-600', active);
    document.getElementById(buttonId)?.classList.toggle('text-white', active);
}

export function updateToolButtons() {
    setToolButtonState('btn-draw-track', isDrawing);
    setToolButtonState('btn-cut-track', isCutting);
    setToolButtonState('btn-box-delete', isBoxDeleting);
    setToolButtonState('btn-add-waypoint', isAddingWaypoint);
}

function updateBoxDeletePreview(endLngLat = null) {
    const src = mapLoaded && map ? map.getSource('box-delete-preview') : null;
    if (!src) return;
    if (!boxDeleteCoords || !endLngLat) {
        src.setData({ type: 'FeatureCollection', features: [] });
        return;
    }
    const minLng = Math.min(boxDeleteCoords.lng, endLngLat.lng);
    const maxLng = Math.max(boxDeleteCoords.lng, endLngLat.lng);
    const minLat = Math.min(boxDeleteCoords.lat, endLngLat.lat);
    const maxLat = Math.max(boxDeleteCoords.lat, endLngLat.lat);
    src.setData({
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'Polygon',
                coordinates: [[[minLng, minLat], [maxLng, minLat], [maxLng, maxLat], [minLng, maxLat], [minLng, minLat]]]
            }
        }]
    });
}

function updateMapillaryToolbarButton() {
    const btn = document.getElementById('btn-mapillary-layer');
    const toggle = document.getElementById('toggle-mapillary');
    if (!btn || !toggle) return;
    const active = toggle.checked;
    btn.classList.toggle('bg-emerald-700', active);
    btn.classList.toggle('text-white', active);
    btn.classList.toggle('text-gray-300', !active);
}

function updateDeviceLocationToolbarButton(status = null) {
    if (status && typeof status === 'object') {
        _lastDeviceLocationStatus = { ..._lastDeviceLocationStatus, ...status };
    }
    status = _lastDeviceLocationStatus;
    renderDeviceDashboard();
    const buttons = ['btn-device-location-main', 'btn-device-location']
        .map(id => document.getElementById(id))
        .filter(Boolean);

    const active = Boolean(status.active);
    const waiting = Boolean(status.waiting);
    const moving = Boolean(status.moving);
    const centered = Boolean(status.centered);
    const state = waiting ? 'waiting' : (active ? (moving ? 'moving' : 'active') : 'idle');
    const title = waiting ?
        'Localizzazione in corso...' :
        (active ? (centered ? 'Disattiva localizzazione dispositivo' : 'Centra sulla posizione dispositivo') : 'Attiva localizzazione dispositivo');

    buttons.forEach(btn => {
        btn.dataset.locationState = state;
        btn.dataset.locationCentered = centered ? 'true' : 'false';
        btn.classList.remove('bg-sky-600', 'text-white');
        btn.classList.add('text-gray-300');
        btn.title = title;
    });
    scheduleDevicePermissionRefresh(false);
}

function formatRecordingElapsed(ms = 0) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function updateDeviceRecordingUi(status = {}) {
    // Tiene aggiornato lo stato usato per attivare/disattivare i sensori:
    // i listener tilt/vibrazioni partono solo a registrazione in corso
    // (se la cattura è abilitata) e si fermano in pausa/stop.
    const previousState = _lastRecordingSensorStatus?.state || 'idle';
    _lastRecordingSensorStatus = status;
    if (status.state !== previousState) syncDeviceDashboardSensors();

    const btn = document.getElementById('btn-device-recording');
    const chip = document.getElementById('recording-status-chip');
    const chipText = document.getElementById('recording-status-text');
    const badge = document.getElementById('recording-settings-badge');
    const state = status.state || 'idle';

    if (btn) {
        btn.dataset.recordingState = state;
        btn.title = state === 'recording' ?
            'Pausa o termina registrazione' :
            (state === 'paused' ? 'Riprendi registrazione' : 'Avvia registrazione traccia');
    }

    if (chip) {
        chip.dataset.recordingState = state;
        chip.classList.toggle('hidden', state === 'idle');
    }
    if (chipText) {
        const label = state === 'paused' ? 'PAUSA' : 'REC';
        chipText.textContent = `${label} ${formatRecordingElapsed(status.elapsedMs)} · ${status.pointsCount || 0} pt`;
    }
    if (badge) {
        badge.textContent = state === 'recording' ? 'REC' : (state === 'paused' ? 'Pausa' : 'Pronta');
        badge.className = state === 'recording' ?
            'text-[9px] bg-red-950 text-red-300 px-1.5 py-0.5 rounded border border-red-900 font-bold uppercase' :
            (state === 'paused' ?
                'text-[9px] bg-amber-950 text-amber-200 px-1.5 py-0.5 rounded border border-amber-900 font-bold uppercase' :
                'text-[9px] bg-gray-950 text-gray-400 px-1.5 py-0.5 rounded border border-gray-800 font-bold uppercase');
    }

    // Aggiorna anche le statistiche live dentro la modale azione (durata + punti)
    const elapsedEl = document.getElementById('recording-action-elapsed');
    const pointsEl = document.getElementById('recording-action-points');
    if (elapsedEl) elapsedEl.textContent = formatRecordingElapsed(status.elapsedMs);
    if (pointsEl) pointsEl.textContent = String(status.pointsCount || 0);
}

function permissionMeta(state) {
    switch (state) {
        case 'granted':
            return {
                label: 'Attivo',
                classes: 'bg-emerald-950 text-emerald-300 border-emerald-900'
            };
        case 'requesting':
            return {
                label: 'Richiesta',
                classes: 'bg-sky-950 text-sky-300 border-sky-900'
            };
        case 'prompt':
            return {
                label: 'Da autorizzare',
                classes: 'bg-amber-950 text-amber-200 border-amber-900'
            };
        case 'denied':
            return {
                label: 'Negato',
                classes: 'bg-red-950 text-red-300 border-red-900'
            };
        case 'unsupported':
            return {
                label: 'Non supportato',
                classes: 'bg-gray-950 text-gray-500 border-gray-800'
            };
        case 'disabled':
            return {
                label: 'Disattivato',
                classes: 'bg-gray-950 text-gray-400 border-gray-800'
            };
        default:
            return {
                label: 'Non verificato',
                classes: 'bg-gray-950 text-gray-400 border-gray-800'
            };
    }
}

function setPermissionBadge(id, state, withMargin = true) {
    const badge = document.getElementById(id);
    if (!badge) return;
    const meta = permissionMeta(state);
    badge.textContent = meta.label;
    badge.className = `${withMargin ? 'mt-1 ' : ''}inline-flex text-[9px] ${meta.classes} px-1.5 py-0.5 rounded border font-bold uppercase`;
}

async function queryBrowserPermission(name) {
    if (!navigator.permissions || typeof navigator.permissions.query !== 'function') return 'unknown';
    try {
        const query = navigator.permissions.query({ name })
            .then(permission => permission?.state || 'unknown')
            .catch(() => 'unknown');
        const timeout = new Promise(resolve => setTimeout(() => resolve('unknown'), 800));
        return await Promise.race([query, timeout]);
    } catch {
        return 'unknown';
    }
}

function getOrientationPermissionState() {
    if (typeof window.DeviceOrientationEvent === 'undefined') return 'unsupported';
    const OrientationEvent = window.DeviceOrientationEvent;
    if (typeof OrientationEvent.requestPermission === 'function') return 'prompt';
    return 'granted';
}

function getDashboardMotionPermissionState() {
    if (typeof window.DeviceMotionEvent === 'undefined') return 'unsupported';
    if (!_deviceDashboardMotionEnabled) return 'disabled';
    if (_deviceDashboardMotionPermissionGranted) return 'granted';
    const MotionEvent = window.DeviceMotionEvent;
    if (typeof MotionEvent.requestPermission === 'function') return 'prompt';
    return 'granted';
}

async function refreshDevicePermissionUi(force = false) {
    const now = Date.now();
    if (!force && now - _lastPermissionRefreshAt < 3000) return;
    _lastPermissionRefreshAt = now;

    const geoState = _lastDeviceLocationStatus.error === 'permission-denied' ?
        'denied' :
            (_lastDeviceLocationStatus.waiting ? 'requesting' :
                (_lastDeviceLocationStatus.active ? 'granted' :
                    (!_deviceLocationPermissionEnabled ? 'disabled' : await queryBrowserPermission('geolocation'))));
    const orientationState = _lastDeviceLocationStatus.orientationPermission || getOrientationPermissionState();
    const motionState = getDashboardMotionPermissionState();

    setPermissionBadge('location-permission-state', geoState, false);
    setPermissionBadge('orientation-permission-state', orientationState, false);
    setPermissionBadge('motion-permission-state', motionState, false);

    const overall = document.getElementById('device-permissions-badge');
    if (overall) {
        const states = [geoState, orientationState, motionState];
        const overallState = states.includes('denied') ? 'denied' :
            (states.includes('requesting') ? 'requesting' :
                (states.includes('prompt') ? 'prompt' :
                    (states.includes('disabled') ? 'disabled' :
                        (states.includes('granted') ? 'granted' : 'unsupported'))));
        const meta = permissionMeta(overallState);
        overall.textContent = overallState === 'granted' ? 'OK' :
            (overallState === 'prompt' ? 'Da autorizzare' : meta.label);
        overall.className = `text-[9px] ${meta.classes} px-1.5 py-0.5 rounded border font-bold uppercase`;
    }

    const orientationButton = document.getElementById('btn-orientation-permission');
    if (orientationButton) {
        const unsupported = orientationState === 'unsupported';
        orientationButton.disabled = unsupported;
        orientationButton.classList.toggle('opacity-50', unsupported);
        orientationButton.classList.toggle('cursor-not-allowed', unsupported);
    }

    const motionButton = document.getElementById('btn-motion-permission');
    if (motionButton) {
        const unsupported = motionState === 'unsupported';
        motionButton.disabled = unsupported;
        motionButton.classList.toggle('opacity-50', unsupported);
        motionButton.classList.toggle('cursor-not-allowed', unsupported);
    }
}

function scheduleDevicePermissionRefresh(force = false) {
    if (_permissionRefreshTimer) clearTimeout(_permissionRefreshTimer);
    _permissionRefreshTimer = setTimeout(() => {
        refreshDevicePermissionUi(force).catch(err => console.warn(err));
    }, force ? 0 : 150);
}

function setRecordingSettingsExpanded(expanded) {
    const panel = document.getElementById('recording-settings-panel');
    const toggle = document.getElementById('recording-settings-toggle');
    const content = document.getElementById('recording-settings-content');
    if (!panel || !toggle || !content) return;
    panel.dataset.expanded = expanded ? 'true' : 'false';
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    content.classList.toggle('hidden', !expanded);
}

function bindRecordingSettingsPanel() {
    const toggle = document.getElementById('recording-settings-toggle');
    if (!toggle || toggle.dataset.bound === 'true') return;
    toggle.dataset.bound = 'true';
    setRecordingSettingsExpanded(false);
    toggle.addEventListener('click', () => {
        const panel = document.getElementById('recording-settings-panel');
        setRecordingSettingsExpanded(panel?.dataset.expanded !== 'true');
    });
}

function closeRecordingActionModal() {
    document.getElementById('modal-recording-action')?.classList.add('hidden');
}

function openRecordingActionModal() {
    const status = _getDeviceRecordingStatus ? _getDeviceRecordingStatus() : { state: 'idle' };
    const pauseButton = document.getElementById('btn-recording-action-pause');
    if (pauseButton) {
        const label = status.state === 'paused' ? 'Riprendi' : 'Pausa';
        const iconName = status.state === 'paused' ? 'play' : 'pause';
        pauseButton.innerHTML = `<i data-lucide="${iconName}" class="w-3.5 h-3.5"></i><span>${label}</span>`;
    }
    // Aggiorna subito le statistiche live (la modale ascolta poi i tick).
    updateDeviceRecordingUi(status);
    document.getElementById('modal-recording-action')?.classList.remove('hidden');
    refreshLucideIcons();
}

function closeRecordingSaveModal() {
    document.getElementById('modal-recording-save')?.classList.add('hidden');
}

function openRecordingSaveModal() {
    const input = document.getElementById('recording-save-name');
    if (input) {
        input.value = _getDefaultRecordingName ? _getDefaultRecordingName() : 'rec';
        setTimeout(() => input.focus(), 30);
    }
    document.getElementById('modal-recording-save')?.classList.remove('hidden');
    refreshLucideIcons();
}

function syncRecordingSettingsForm() {
    if (!_getRecordingSettings) return;
    const settings = _getRecordingSettings();
    const setValue = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.value = value;
    };
    const setChecked = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.checked = Boolean(value);
    };
    setValue('recording-min-distance', settings.minDistanceM);
    setValue('recording-min-interval', settings.minIntervalMs / 1000);
    setValue('recording-max-accuracy', settings.maxAccuracyM);
    setValue('recording-min-speed', settings.minSpeedMps);
    setValue('recording-track-width', settings.trackWidth);
    setValue('recording-track-color', settings.trackColor);
    setChecked('recording-distance-or-time', settings.distanceOrTimeTrigger !== false);
    setChecked('recording-show-live-track', settings.showLiveTrack);
    setChecked('recording-save-elevation', settings.saveElevation);
    setChecked('recording-keep-screen-on', settings.keepScreenOn);
    setChecked('recording-high-accuracy-gps', settings.highAccuracyGps !== false);
    setChecked('recording-capture-tilt', settings.recordTiltPitch !== false);
    setChecked('recording-capture-vibration', settings.recordVibration !== false);
}

function bindRecordingSettingsForm() {
    bindRecordingSettingsPanel();
    syncRecordingSettingsForm();
    const bindNumber = (id, key, transform = value => value) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.onchange = () => {
            const value = Number(el.value);
            if (_updateRecordingSettings && Number.isFinite(value)) {
                _updateRecordingSettings({ [key]: transform(value) });
                syncRecordingSettingsForm();
            }
        };
    };
    bindNumber('recording-min-distance', 'minDistanceM');
    bindNumber('recording-min-interval', 'minIntervalMs', value => value * 1000);
    bindNumber('recording-max-accuracy', 'maxAccuracyM');
    bindNumber('recording-min-speed', 'minSpeedMps');
    bindNumber('recording-track-width', 'trackWidth');

    const distanceOrTimeToggle = document.getElementById('recording-distance-or-time');
    if (distanceOrTimeToggle) {
        distanceOrTimeToggle.onchange = () => _updateRecordingSettings?.({ distanceOrTimeTrigger: distanceOrTimeToggle.checked });
    }
    const liveToggle = document.getElementById('recording-show-live-track');
    if (liveToggle) {
        liveToggle.onchange = () => _updateRecordingSettings?.({ showLiveTrack: liveToggle.checked });
    }
    const eleToggle = document.getElementById('recording-save-elevation');
    if (eleToggle) {
        eleToggle.onchange = () => _updateRecordingSettings?.({ saveElevation: eleToggle.checked });
    }
    const wakeToggle = document.getElementById('recording-keep-screen-on');
    if (wakeToggle) {
        wakeToggle.onchange = () => _updateRecordingSettings?.({ keepScreenOn: wakeToggle.checked });
    }
    const gpsAccuracyToggle = document.getElementById('recording-high-accuracy-gps');
    if (gpsAccuracyToggle) {
        gpsAccuracyToggle.onchange = () => _updateRecordingSettings?.({ highAccuracyGps: gpsAccuracyToggle.checked });
    }
    const tiltCaptureToggle = document.getElementById('recording-capture-tilt');
    if (tiltCaptureToggle) {
        tiltCaptureToggle.onchange = () => {
            _updateRecordingSettings?.({ recordTiltPitch: tiltCaptureToggle.checked });
            // Applica subito: stacca/attacca i listener sensore anche a registrazione in corso.
            syncDeviceDashboardSensors();
        };
    }
    const vibrationCaptureToggle = document.getElementById('recording-capture-vibration');
    if (vibrationCaptureToggle) {
        vibrationCaptureToggle.onchange = () => {
            _updateRecordingSettings?.({ recordVibration: vibrationCaptureToggle.checked });
            syncDeviceDashboardSensors();
        };
    }
    const colorInput = document.getElementById('recording-track-color');
    if (colorInput) {
        colorInput.onchange = () => _updateRecordingSettings?.({ trackColor: colorInput.value });
    }
}

// Su iOS i sensori richiedono un permesso da gesto utente: l'avvio registrazione
// è il momento giusto per richiederlo, ma solo se la cattura è abilitata
// (sensori disattivati = nessuna richiesta e nessun consumo).
function requestRecordingSensorPermissionsIfNeeded() {
    const settings = _getRecordingSettings ? _getRecordingSettings() : null;
    if (!settings) return;
    if (settings.recordTiltPitch !== false &&
        isDashboardOrientationEnabled() &&
        typeof window.DeviceOrientationEvent !== 'undefined' &&
        typeof window.DeviceOrientationEvent.requestPermission === 'function' &&
        (_lastDeviceLocationStatus.orientationPermission || 'prompt') !== 'granted') {
        requestDashboardOrientationPermission({ forcePrompt: false }).catch(() => {});
    }
    if (settings.recordVibration !== false &&
        _deviceDashboardMotionEnabled &&
        typeof window.DeviceMotionEvent !== 'undefined' &&
        typeof window.DeviceMotionEvent.requestPermission === 'function' &&
        !_deviceDashboardMotionPermissionGranted) {
        requestDashboardMotionPermission().catch(() => {});
    }
}

function handleDeviceRecordingButtonClick(source = 'toolbar') {
    const status = _getDeviceRecordingStatus ? _getDeviceRecordingStatus() : { state: 'idle' };
    if (status.state === 'recording') {
        openRecordingActionModal();
        return;
    }
    if (status.state === 'paused') {
        if (source === 'chip') {
            openRecordingActionModal();
        } else {
            _resumeDeviceRecording?.();
        }
        return;
    }
    if (source !== 'chip') {
        requestRecordingSensorPermissionsIfNeeded();
        _startDeviceRecording?.();
    }
}

function clearBoxDeleteSelection() {
    setBoxDeleteCoords(null);
    updateBoxDeletePreview();
    if (boxDeleteMarker) {
        boxDeleteMarker.remove();
        setBoxDeleteMarker(null);
    }
}

export function injectDeps(deps) {
    _updateMapData = deps.updateMapData;
    _saveHistoryState = deps.saveHistoryState;
    _setBaseMap = deps.setBaseMap;
    _setDimensionMode = deps.setDimensionMode;
    _setMapillaryCoverageVisible = deps.setMapillaryCoverageVisible;
    _configureMapillaryToken = deps.configureMapillaryToken;
    _closeMapillaryViewer = deps.closeMapillaryViewer;
    _flyToPOI = deps.flyToPOI;
    _triggerUndo = deps.triggerUndo;
    _importGPX = deps.importGPX;
    _exportGPX = deps.exportGPX;
    _addPointToActiveSegment = deps.addPointToActiveSegment;
    _cutTrackAtPoint = deps.cutTrackAtPoint;
    _handleBoxDeleteClick = deps.handleBoxDeleteClick;
    _addWaypointAtCoords = deps.addWaypointAtCoords;
    _saveWaypointModifications = deps.saveWaypointModifications;
    _setSnapProfile = deps.setSnapProfile;
    _togglePrintPlanning = deps.togglePrintPlanning;
    _disablePrintPlanning = deps.disablePrintPlanning;
    _updatePrintGridLayout = deps.updatePrintGridLayout;
    _updatePrintGridScale = deps.updatePrintGridScale;
    _setPrintPlanningOrientation = deps.setPrintPlanningOrientation;
    _generateHighResPrintPreview = deps.generateHighResPrintPreview;
    _syncPrintOutputFromPreview = deps.syncPrintOutputFromPreview;
    _toggleDeviceLocation = deps.toggleDeviceLocation;
    _orientMapToMovementHeading = deps.orientMapToMovementHeading;
    _stopDeviceLocation = deps.stopDeviceLocation;
    _requestDeviceLocationPermission = deps.requestDeviceLocationPermission;
    _requestDeviceOrientationPermission = deps.requestDeviceOrientationPermission;
    _setDeviceOrientationEnabled = deps.setDeviceOrientationEnabled;
    _setDeviceLocationStatusHandler = deps.setDeviceLocationStatusHandler;
    _setDeviceRecordingStatusHandler = deps.setDeviceRecordingStatusHandler;
    _startDeviceRecording = deps.startDeviceRecording;
    _pauseDeviceRecording = deps.pauseDeviceRecording;
    _resumeDeviceRecording = deps.resumeDeviceRecording;
    _finishDeviceRecording = deps.finishDeviceRecording;
    _getDeviceRecordingStatus = deps.getDeviceRecordingStatus;
    _getRecordingSettings = deps.getRecordingSettings;
    _updateRecordingSettings = deps.updateRecordingSettings;
    _getDefaultRecordingName = deps.getDefaultRecordingName;
}

export function setupPrintUiEvents() {
    document.getElementById('btn-open-print').onclick = _togglePrintPlanning;
    document.getElementById('btn-close-print-setup').onclick = _disablePrintPlanning;
    document.getElementById('print-grid-select').onchange = _updatePrintGridLayout;
    document.getElementById('print-scale-slider').oninput = _updatePrintGridScale;
    document.getElementById('btn-print-port').onclick = () => _setPrintPlanningOrientation('portrait');
    document.getElementById('btn-print-land').onclick = () => _setPrintPlanningOrientation('landscape');

    document.getElementById('btn-generate-previews').onclick = () => {
        trackAnalyticsEvent('richiesta_stampa', { source: 'print_preview' }).catch(err => console.warn(err));
        if (_generateHighResPrintPreview) _generateHighResPrintPreview();
    };
    document.getElementById('btn-print-preview-cancel').onclick = () => {
        document.getElementById('print-preview-modal').classList.add('hidden');
    };
    document.getElementById('btn-print-preview-confirm').onclick = () => {
        if (_syncPrintOutputFromPreview) _syncPrintOutputFromPreview();
        window.print();
    };
}

export function createNewTrack(name) {
    const trackName = name || `Traccia ${tracks.length + 1}`;
    const color = generateDistinctTrackColor(tracks.map(track => track.color));
    const newTrack = {
        id: 'track_' + Date.now(),
        localFileId: 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        localCreatedAt: Date.now(),
        localUpdatedAt: Date.now(),
        localSource: 'created',
        name: trackName,
        desc: 'Nessuna descrizione',
        color,
        width: 3,
        visible: true,
        waypointsVisible: true,
        segments: [{
            id: 'seg_' + Date.now() + '_1',
            name: 'Tracciato 1',
            points: [],
            visible: true
        }],
        waypoints: []
    };
    tracks.push(newTrack);
    setActiveTrackId(newTrack.id);
    setActiveSegmentId(newTrack.segments[0].id);

    if (_saveHistoryState) _saveHistoryState();
    updateActiveTracksHeader();
    renderGisTree();
    showToast(`Creata: ${trackName}`, 'info');
    return newTrack;
}

function focusPointsOnMap(points) {
    if (!mapLoaded || !points || points.length === 0) return;

    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    const firstPoint = points[0];

    for (let pi = 0; pi < points.length; pi++) {
        const point = points[pi];
        if (point.lon < minLon) minLon = point.lon;
        if (point.lon > maxLon) maxLon = point.lon;
        if (point.lat < minLat) minLat = point.lat;
        if (point.lat > maxLat) maxLat = point.lat;
    }

    if (points.length === 1 || (minLon === maxLon && minLat === maxLat)) {
        map.flyTo({
            center: [firstPoint.lon, firstPoint.lat],
            zoom: 15,
            pitch: 45,
            duration: MAP_FOCUS_ANIMATION_MS,
            easing: easeInOutCubic
        });
        return;
    }

    map.fitBounds([[minLon, minLat], [maxLon, maxLat]], {
        padding: 60,
        duration: MAP_FOCUS_ANIMATION_MS,
        easing: easeInOutCubic,
        pitch: is3D ? map.getPitch() : 0,
        bearing: is3D ? map.getBearing() : 0
    });
}

function focusTrackOnMap(track) {
    if (!track) return;
    const allPoints = [];

    for (let si = 0; si < track.segments.length; si++) {
        const seg = track.segments[si];
        for (let pi = 0; pi < seg.points.length; pi++) {
            allPoints.push(seg.points[pi]);
        }
    }

    if (allPoints.length === 0) return;
    focusPointsOnMap(allPoints);
}

function focusSegmentOnMap(trackId, segId) {
    const track = tracks.find(tr => tr.id === trackId);
    const segment = track?.segments.find(seg => seg.id === segId);
    if (!segment || segment.points.length === 0) return;
    focusPointsOnMap(segment.points);
}

function makeTreeKey(type, trackId, segId = null) {
    return type === 'segment' ? `segment:${trackId}:${segId}` : `track:${trackId}`;
}

function parseTreeKey(key) {
    const parts = String(key || '').split(':');
    return {
        type: parts[0],
        trackId: parts[1] || null,
        segId: parts[2] || null
    };
}

function getTreeItemOrder() {
    const order = [];
    tracks.forEach(track => {
        order.push(makeTreeKey('track', track.id));
        track.segments.forEach(seg => order.push(makeTreeKey('segment', track.id, seg.id)));
    });
    return order;
}

function selectionHas(key) {
    return _treeSelection.includes(key);
}

function normalizeTreeSelection() {
    const valid = new Set(getTreeItemOrder());
    _treeSelection = _treeSelection.filter(key => valid.has(key));
    if (_treeLastSelected && !valid.has(_treeLastSelected)) _treeLastSelected = _treeSelection[_treeSelection.length - 1] || null;
}

function setTreeSelection(keys, lastKey = null) {
    const valid = new Set(getTreeItemOrder());
    _treeSelection = [...new Set(keys.filter(key => valid.has(key)))];
    _treeLastSelected = lastKey && valid.has(lastKey) ? lastKey : (_treeSelection[_treeSelection.length - 1] || null);
}

function selectTreeItem(type, trackId, segId, event = null) {
    const key = makeTreeKey(type, trackId, segId);
    const isRange = event && event.shiftKey && _treeLastSelected;
    const isToggle = event && (event.ctrlKey || event.metaKey);

    if (isRange) {
        const order = getTreeItemOrder();
        const start = order.indexOf(_treeLastSelected);
        const end = order.indexOf(key);
        if (start !== -1 && end !== -1) {
            const range = order.slice(Math.min(start, end), Math.max(start, end) + 1);
            setTreeSelection(isToggle ? [..._treeSelection, ...range] : range, key);
            return;
        }
    }

    if (isToggle) {
        const next = selectionHas(key)
            ? _treeSelection.filter(item => item !== key)
            : [..._treeSelection, key];
        setTreeSelection(next, key);
        return;
    }

    setTreeSelection([key], key);
}

function ensureTreeItemSelected(type, trackId, segId = null) {
    const key = makeTreeKey(type, trackId, segId);
    if (!selectionHas(key)) setTreeSelection([key], key);
}

function getSelectedItems() {
    normalizeTreeSelection();
    return _treeSelection.map(parseTreeKey);
}

function getSelectedTracks() {
    return getSelectedItems()
        .filter(item => item.type === 'track')
        .map(item => tracks.find(track => track.id === item.trackId))
        .filter(Boolean);
}

function getSelectedSegments() {
    return getSelectedItems()
        .filter(item => item.type === 'segment')
        .map(item => {
            const track = tracks.find(tr => tr.id === item.trackId);
            const segment = track?.segments.find(seg => seg.id === item.segId);
            return track && segment ? { track, segment } : null;
        })
        .filter(Boolean);
}

function uid(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function cloneSegmentForPaste(segment, suffix = ' copia') {
    return {
        ...JSON.parse(JSON.stringify(segment)),
        id: uid('seg'),
        name: `${segment.name || 'Tracciato'}${suffix}`
    };
}

function cloneTrackForPaste(track, suffix = ' copia') {
    const cloned = JSON.parse(JSON.stringify(track));
    cloned.id = uid('track');
    cloned.localFileId = uid('local');
    cloned.localCreatedAt = Date.now();
    cloned.localUpdatedAt = Date.now();
    cloned.localSource = 'created';
    cloned.name = `${track.name || 'Traccia'}${suffix}`;
    cloned.segments = (cloned.segments || []).map(seg => ({
        ...seg,
        id: uid('seg')
    }));
    cloned.waypoints = (cloned.waypoints || []).map(wp => ({
        ...wp,
        id: uid('wp')
    }));
    return cloned;
}

function getClipboardPayloadFromSelection() {
    const selectedTracks = getSelectedTracks();
    const selectedTrackIds = new Set(selectedTracks.map(track => track.id));
    const selectedSegments = getSelectedSegments()
        .filter(item => !selectedTrackIds.has(item.track.id));
    if (selectedTracks.length === 0 && selectedSegments.length === 0) return null;
    return {
        tracks: selectedTracks.map(track => JSON.parse(JSON.stringify(track))),
        segments: selectedSegments.map(item => ({
            sourceTrackId: item.track.id,
            segment: JSON.parse(JSON.stringify(item.segment))
        }))
    };
}

function refreshAfterTreeClipboardMutation(message) {
    if (_saveHistoryState) _saveHistoryState();
    if (_updateMapData) _updateMapData(true);
    updateActiveTracksHeader();
    renderGisTree();
    renderLocalGpxLibrary();
    schedulePersistAppSession();
    if (message) showToast(message, 'success');
}

function removeSelectionForCut() {
    const selectedTrackIds = new Set(getSelectedTracks().map(track => track.id));
    const selectedSegments = getSelectedSegments()
        .filter(item => !selectedTrackIds.has(item.track.id));

    if (selectedSegments.length > 0) {
        selectedSegments.forEach(({ track, segment }) => {
            track.segments = track.segments.filter(seg => seg.id !== segment.id);
        });
    }

    if (selectedTrackIds.size > 0) {
        setTracks(tracks.filter(track => !selectedTrackIds.has(track.id)));
    }

    if (!tracks.some(track => track.id === activeTrackId)) {
        const nextTrack = tracks[0] || null;
        setActiveTrackId(nextTrack?.id || null);
        setActiveSegmentId(nextTrack?.segments[0]?.id || null);
        if (nextTrack) setTrackExpanded(nextTrack.id, true);
    } else {
        const activeTrack = tracks.find(track => track.id === activeTrackId);
        if (activeTrack && !activeTrack.segments.some(seg => seg.id === activeSegmentId)) {
            setActiveSegmentId(activeTrack.segments[0]?.id || null);
        }
    }
    setTreeSelection([]);
}

function pasteTreeClipboard(target = {}) {
    if (!_treeClipboard || ((_treeClipboard.tracks || []).length === 0 && (_treeClipboard.segments || []).length === 0)) {
        showToast('Niente da incollare', 'info');
        return;
    }

    const pastedKeys = [];
    const trackTargetIndex = target.trackId ? tracks.findIndex(track => track.id === target.trackId) : -1;
    let insertTrackIndex = trackTargetIndex === -1 ? tracks.length : trackTargetIndex + 1;

    (_treeClipboard.tracks || []).forEach(trackData => {
        const cloned = cloneTrackForPaste(trackData, _treeClipboard.mode === 'cut' ? '' : ' copia');
        tracks.splice(insertTrackIndex, 0, cloned);
        insertTrackIndex++;
        pastedKeys.push(makeTreeKey('track', cloned.id));
        setActiveTrackId(cloned.id);
        setActiveSegmentId(cloned.segments[0]?.id || null);
        setTrackExpanded(cloned.id, true);
    });

    if ((_treeClipboard.segments || []).length > 0) {
        const targetTrack = tracks.find(track => track.id === target.trackId)
            || tracks.find(track => track.id === activeTrackId)
            || tracks[0];
        if (!targetTrack) return;

        let insertSegmentIndex = target.segId
            ? targetTrack.segments.findIndex(seg => seg.id === target.segId) + 1
            : targetTrack.segments.length;
        if (insertSegmentIndex < 0) insertSegmentIndex = targetTrack.segments.length;

        _treeClipboard.segments.forEach(item => {
            const cloned = cloneSegmentForPaste(item.segment, _treeClipboard.mode === 'cut' ? '' : ' copia');
            targetTrack.segments.splice(insertSegmentIndex, 0, cloned);
            insertSegmentIndex++;
            pastedKeys.push(makeTreeKey('segment', targetTrack.id, cloned.id));
            setActiveTrackId(targetTrack.id);
            setActiveSegmentId(cloned.id);
            setTrackExpanded(targetTrack.id, true);
        });
    }

    setTreeSelection(pastedKeys);
    if (_treeClipboard.mode === 'cut') _treeClipboard = null;
    refreshAfterTreeClipboardMutation('Elementi incollati');
}

function createTreeContextMenuButton(icon, label, action, disabled = false, danger = false) {
    return `
      <button onclick="${action}" ${disabled ? 'disabled' : ''}
              class="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-left ${danger ? 'text-red-300 hover:bg-red-950' : 'hover:bg-gray-800'} ${disabled ? 'opacity-40 cursor-not-allowed hover:bg-transparent' : ''}">
        <i data-lucide="${icon}" class="w-3.5 h-3.5"></i><span>${label}</span>
      </button>`;
}

function isInteractiveTreeTarget(target) {
    return Boolean(target?.closest('button, input, select, textarea, label, [data-tree-control="true"]'));
}

function isTextEditingTarget(target) {
    return Boolean(target?.closest('input, textarea, select, [contenteditable="true"]'));
}

function closeTrackContextMenu() {
    if (_trackContextMenu) {
        _trackContextMenu.remove();
        _trackContextMenu = null;
    }
    document.removeEventListener('pointerdown', handleOutsideTrackContextMenu);
    document.removeEventListener('keydown', handleTrackContextMenuKeydown);
}

function handleOutsideTrackContextMenu(event) {
    if (!_trackContextMenu || _trackContextMenu.contains(event.target)) return;
    closeTrackContextMenu();
}

function handleTrackContextMenuKeydown(event) {
    if (event.key === 'Escape') closeTrackContextMenu();
}

function openTrackContextMenuAt(trackId, clientX, clientY) {
    const track = tracks.find(tr => tr.id === trackId);
    if (!track) return;
    ensureTreeItemSelected('track', trackId);
    normalizeTreeSelection();
    const selectedCount = _treeSelection.length;
    const hasClipboard = !!_treeClipboard && (((_treeClipboard.tracks || []).length + (_treeClipboard.segments || []).length) > 0);
    const pointCount = (track.segments || []).reduce((sum, segment) => sum + ((segment.points || []).length), 0);

    const trackIndex = tracks.findIndex(t => t.id === trackId);
    const isFirst = trackIndex === 0;
    const isLast = trackIndex === tracks.length - 1;
    const selectedTracks = getSelectedTracks();
    const selectedTracksCount = selectedTracks.length;

    closeTrackContextMenu();
    const menu = document.createElement('div');
    menu.className = 'gpx-track-context-menu fixed z-50 w-60 rounded-xl border border-gray-700 bg-gray-950 shadow-2xl p-2 text-xs text-gray-200';
    menu.innerHTML = `
      <div class="px-2 pb-2 border-b border-gray-800">
        <div class="font-bold truncate">${escapeXml(track.name)}</div>
        <div class="text-[10px] text-gray-500">${selectedCount > 1 ? `${selectedCount} elementi selezionati` : 'File GPX selezionato'}</div>
      </div>
      ${createTreeContextMenuButton('copy', 'Copia', 'copyTreeSelection()')}
      ${createTreeContextMenuButton('clipboard-paste', 'Incolla', `pasteTreeSelection('${track.id}')`, !hasClipboard)}
      ${createTreeContextMenuButton('scissors', 'Taglia', 'cutTreeSelection()')}
      ${createTreeContextMenuButton('copy-plus', 'Duplica', `duplicateTreeSelection('${track.id}')`)}
      ${createTreeContextMenuButton('database', 'Recupera superfici OSM', `fetchSurfaceDataForTrack('${track.id}')`, pointCount < 2)}
      ${createTreeContextMenuButton('route', 'Estrai tratti non asfaltati', `extractOffroadFromTrack('${track.id}')`, pointCount < 2)}
      ${createTreeContextMenuButton('download', 'Scarica traccia', `downloadTrackGPX('${track.id}', 'context_menu')`)}
      ${createTreeContextMenuButton('chevron-up', 'Sposta su', `moveTrackUp('${track.id}')`, isFirst)}
      ${createTreeContextMenuButton('chevron-down', 'Sposta giù', `moveTrackDown('${track.id}')`, isLast)}
      ${selectedTracksCount > 1 
        ? createTreeContextMenuButton('git-merge', 'Unisci tracce selezionate', 'mergeSelectedTracks()')
        : createTreeContextMenuButton('git-merge', 'Unisci con un\'altra traccia...', `openMergeTracksModal('${track.id}')`, tracks.length < 2)
      }
      <div class="my-1 border-t border-gray-800"></div>
      <button onclick="openTrackNameEditor('${track.id}')" class="w-full flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-gray-800 text-left">
        <i data-lucide="pencil" class="w-3.5 h-3.5"></i><span>Rinomina</span>
      </button>
      <label class="flex items-center justify-between gap-2 px-2 py-2 rounded-lg hover:bg-gray-800 cursor-pointer">
        <span class="flex items-center gap-2"><i data-lucide="palette" class="w-3.5 h-3.5"></i> Colore</span>
        <input type="color" value="${track.color || '#3b82f6'}" onchange="changeTrackColor('${track.id}', this.value)" class="w-6 h-6 rounded border-0 bg-transparent cursor-pointer">
      </label>
      <label class="block px-2 py-2 rounded-lg hover:bg-gray-800 cursor-pointer">
        <span class="flex items-center justify-between mb-1">
          <span class="flex items-center gap-2"><i data-lucide="minus" class="w-3.5 h-3.5"></i> Spessore</span>
          <span class="text-gray-400">${track.width || 3}px</span>
        </span>
        <input type="range" min="1" max="12" step="1" value="${track.width || 3}" oninput="changeTrackWidth('${track.id}', this.value)" class="w-full accent-blue-500">
      </label>
      <button onclick="toggleTrackVisibility('${track.id}')" class="w-full flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-gray-800 text-left">
        <i data-lucide="${track.visible === false ? 'eye' : 'eye-off'}" class="w-3.5 h-3.5"></i><span>${track.visible === false ? 'Mostra file' : 'Nascondi file'}</span>
      </button>
      ${createTreeContextMenuButton('trash-2', selectedCount > 1 ? 'Elimina selezione' : 'Elimina file', selectedCount > 1 ? 'deleteTreeSelection()' : `deleteTrack('${track.id}')`, false, true)}`;
    document.body.appendChild(menu);
    refreshLucideIcons();

    const padding = 8;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(padding, Math.min(clientX, window.innerWidth - rect.width - padding))}px`;
    menu.style.top = `${Math.max(padding, Math.min(clientY, window.innerHeight - rect.height - padding))}px`;
    _trackContextMenu = menu;
    setTimeout(() => {
        document.addEventListener('pointerdown', handleOutsideTrackContextMenu);
        document.addEventListener('keydown', handleTrackContextMenuKeydown);
    }, 0);
}

export function handleTrackContextMenu(event, trackId) {
    event.preventDefault();
    event.stopPropagation();
    if (!selectionHas(makeTreeKey('track', trackId))) selectTreeItem('track', trackId, null, event);
    setTrackActive(trackId, false);
    openTrackContextMenuAt(trackId, event.clientX, event.clientY);
}

export function downloadTrackGPX(trackId = activeTrackId, source = 'toolbar') {
    const track = (trackId ? tracks.find(tr => tr.id === trackId) : null)
        || (activeTrackId ? tracks.find(tr => tr.id === activeTrackId) : null)
        || tracks[0];
    if (!track) {
        showToast('Seleziona una traccia da scaricare', 'error');
        return;
    }

    trackAnalyticsEvent('export_gpx', {
        source,
        trackId: track.id,
        trackName: track.name,
        tracks: 1
    }).catch(err => console.warn(err));

    if (_exportGPX) _exportGPX(track.id);
    closeTrackContextMenu();
}

export function handleTrackPointerDown(event, trackId) {
    if (event.pointerType === 'mouse' || isInteractiveTreeTarget(event.target)) return;
    clearTimeout(_trackLongPressTimer);
    _trackLongPressTimer = setTimeout(() => {
        selectTreeItem('track', trackId);
        setTrackActive(trackId, false);
        openTrackContextMenuAt(trackId, event.clientX, event.clientY);
    }, 650);
}

function openSegmentContextMenuAt(trackId, segId, clientX, clientY) {
    const track = tracks.find(tr => tr.id === trackId);
    const segment = track?.segments.find(seg => seg.id === segId);
    if (!track || !segment) return;
    ensureTreeItemSelected('segment', trackId, segId);
    normalizeTreeSelection();
    const selectedCount = _treeSelection.length;
    const hasClipboard = !!_treeClipboard && (((_treeClipboard.tracks || []).length + (_treeClipboard.segments || []).length) > 0);

    closeTrackContextMenu();
    const menu = document.createElement('div');
    menu.className = 'gpx-track-context-menu fixed z-50 w-60 rounded-xl border border-gray-700 bg-gray-950 shadow-2xl p-2 text-xs text-gray-200';
    menu.innerHTML = `
      <div class="px-2 pb-2 border-b border-gray-800">
        <div class="font-bold truncate">${escapeXml(segment.name)}</div>
        <div class="text-[10px] text-gray-500">${selectedCount > 1 ? `${selectedCount} elementi selezionati` : 'Segmento selezionato'}</div>
      </div>
      ${createTreeContextMenuButton('copy', 'Copia', 'copyTreeSelection()')}
      ${createTreeContextMenuButton('clipboard-paste', 'Incolla', `pasteTreeSelection('${trackId}', '${segId}')`, !hasClipboard)}
      ${createTreeContextMenuButton('scissors', 'Taglia', 'cutTreeSelection()')}
      ${createTreeContextMenuButton('copy-plus', 'Duplica', `duplicateTreeSelection('${trackId}', '${segId}')`)}
      ${createTreeContextMenuButton('route', 'Estrai tratti non asfaltati', `extractOffroadFromSegment('${trackId}', '${segId}')`, segment.points.length < 2)}
      <div class="my-1 border-t border-gray-800"></div>
      <button onclick="renameSegmentFromMenu('${trackId}', '${segId}')" class="w-full flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-gray-800 text-left">
        <i data-lucide="pencil" class="w-3.5 h-3.5"></i><span>Rinomina</span>
      </button>
      <button onclick="toggleSegmentVisibility('${trackId}', '${segId}')" class="w-full flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-gray-800 text-left">
        <i data-lucide="${segment.visible === false ? 'eye' : 'eye-off'}" class="w-3.5 h-3.5"></i><span>${segment.visible === false ? 'Mostra segmento' : 'Nascondi segmento'}</span>
      </button>
      ${createTreeContextMenuButton('trash-2', selectedCount > 1 ? 'Elimina selezione' : 'Elimina segmento', selectedCount > 1 ? 'deleteTreeSelection()' : `deleteSegment('${trackId}', '${segId}')`, false, true)}`;
    document.body.appendChild(menu);
    refreshLucideIcons();

    const padding = 8;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(padding, Math.min(clientX, window.innerWidth - rect.width - padding))}px`;
    menu.style.top = `${Math.max(padding, Math.min(clientY, window.innerHeight - rect.height - padding))}px`;
    _trackContextMenu = menu;
    setTimeout(() => {
        document.addEventListener('pointerdown', handleOutsideTrackContextMenu);
        document.addEventListener('keydown', handleTrackContextMenuKeydown);
    }, 0);
}

export function handleSegmentContextMenu(event, trackId, segId) {
    event.preventDefault();
    event.stopPropagation();
    if (!selectionHas(makeTreeKey('segment', trackId, segId))) selectTreeItem('segment', trackId, segId, event);
    setSegmentActive(trackId, segId, false);
    openSegmentContextMenuAt(trackId, segId, event.clientX, event.clientY);
}

export function handleSegmentPointerDown(event, trackId, segId) {
    if (event.pointerType === 'mouse' || isInteractiveTreeTarget(event.target)) return;
    clearTimeout(_trackLongPressTimer);
    _trackLongPressTimer = setTimeout(() => {
        selectTreeItem('segment', trackId, segId);
        setSegmentActive(trackId, segId, false);
        openSegmentContextMenuAt(trackId, segId, event.clientX, event.clientY);
    }, 650);
}

export function clearTrackLongPress() {
    clearTimeout(_trackLongPressTimer);
    _trackLongPressTimer = null;
}

export function handleTrackTreeClick(event, trackId, shouldFocus = false) {
    if (isInteractiveTreeTarget(event.target)) return;
    selectTreeItem('track', trackId, null, event);
    if (trackId === activeTrackId) {
        if (shouldFocus) {
            const track = tracks.find(tr => tr.id === trackId);
            if (track) focusTrackOnMap(track);
        }
        toggleActiveTrackExpanded(trackId);
        return;
    }
    setTrackActive(trackId, shouldFocus);
}

export function handleSegmentTreeClick(event, trackId, segId, shouldFocus = false) {
    if (isInteractiveTreeTarget(event.target)) return;
    event.stopPropagation();
    selectTreeItem('segment', trackId, segId, event);
    setSegmentActive(trackId, segId, shouldFocus);
}

export function copyTreeSelection() {
    const payload = getClipboardPayloadFromSelection();
    if (!payload) {
        showToast('Nessun elemento selezionato', 'info');
        return;
    }
    _treeClipboard = { ...payload, mode: 'copy' };
    closeTrackContextMenu();
    showToast('Selezione copiata', 'success');
}

export function cutTreeSelection() {
    const payload = getClipboardPayloadFromSelection();
    if (!payload) {
        showToast('Nessun elemento selezionato', 'info');
        return;
    }
    _treeClipboard = { ...payload, mode: 'cut' };
    removeSelectionForCut();
    closeTrackContextMenu();
    refreshAfterTreeClipboardMutation('Selezione tagliata');
}

export function pasteTreeSelection(trackId = null, segId = null) {
    closeTrackContextMenu();
    pasteTreeClipboard({ trackId, segId });
}

export function duplicateTreeSelection(trackId = null, segId = null) {
    const payload = getClipboardPayloadFromSelection();
    if (!payload) {
        showToast('Nessun elemento selezionato', 'info');
        return;
    }
    const previousClipboard = _treeClipboard;
    _treeClipboard = { ...payload, mode: 'copy' };
    pasteTreeClipboard({ trackId, segId });
    _treeClipboard = previousClipboard;
}

export function deleteTreeSelection() {
    if (_treeSelection.length === 0) {
        showToast('Nessun elemento selezionato', 'info');
        return;
    }
    removeSelectionForCut();
    closeTrackContextMenu();
    refreshAfterTreeClipboardMutation('Selezione eliminata');
}

export function selectAllTreeItems() {
    setTreeSelection(getTreeItemOrder());
    renderGisTree();
    showToast('Tutti gli elementi del tree selezionati', 'info');
}

export function handleTreeKeyboardShortcuts(event) {
    if (!isSidebarOpen() || isTextEditingTarget(event.target)) return;
    const key = event.key.toLowerCase();
    const hasModifier = event.ctrlKey || event.metaKey;
    if (!hasModifier && event.key !== 'Delete' && event.key !== 'Backspace') return;

    if (hasModifier && key === 'a') {
        event.preventDefault();
        selectAllTreeItems();
    } else if (hasModifier && key === 'c') {
        event.preventDefault();
        copyTreeSelection();
    } else if (hasModifier && key === 'x') {
        event.preventDefault();
        cutTreeSelection();
    } else if (hasModifier && key === 'v') {
        event.preventDefault();
        pasteTreeSelection(activeTrackId, activeSegmentId);
    } else if (hasModifier && key === 'd') {
        event.preventDefault();
        duplicateTreeSelection(activeTrackId, activeSegmentId);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        deleteTreeSelection();
    }
}

export function renameSegmentFromMenu(trackId, segId) {
    closeTrackContextMenu();
    const input = document.getElementById(`segment-name-${segId}`);
    if (!input) return;
    input.focus();
    input.select();
}

const OVERPASS_API_URL = 'https://overpass-api.de/api/interpreter';
const OSM_MATCH_THRESHOLD_M = 35;
const OFFROAD_MIN_RANGE_DISTANCE_KM = 0.01;
const OVERPASS_BBOX_PADDING_DEG = 0.0015;
const OVERPASS_MAX_CHUNK_DISTANCE_KM = 7;
const OVERPASS_MAX_CHUNK_POINTS = 550;
const OVERPASS_MAX_CHUNK_LAT_SPAN_DEG = 0.06;
const OVERPASS_MAX_CHUNK_LON_SPAN_DEG = 0.08;
const OVERPASS_MAX_CHUNKS_PER_REQUEST = 8;
const OVERPASS_MAX_RETRY_DEPTH = 3;
const OVERPASS_MAX_RATE_RETRIES = 2;
const OVERPASS_RETRY_BASE_DELAY_MS = 5000;
const PAVED_SURFACES = new Set([
    'paved', 'asphalt', 'concrete', 'concrete:lanes', 'concrete:plates',
    'paving_stones', 'sett', 'cobblestone', 'unhewn_cobblestone', 'metal', 'wood'
]);
const UNPAVED_SURFACES = new Set([
    'unpaved', 'compacted', 'fine_gravel', 'gravel', 'pebblestone', 'ground',
    'dirt', 'earth', 'grass', 'grass_paver', 'sand', 'mud', 'clay',
    'woodchips', 'rock', 'stone', 'scree', 'shells', 'salt'
]);
const OFFROAD_HIGHWAYS = new Set(['track', 'path', 'bridleway', 'steps']);
const OFFROAD_TRACKTYPES = new Set(['grade2', 'grade3', 'grade4', 'grade5']);

function normalizeOsmTagValue(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function segmentDistanceKm(points, startIndex, endIndex) {
    let distance = 0;
    for (let i = startIndex + 1; i <= endIndex; i++) {
        distance += haversineDistance(points[i - 1].lon, points[i - 1].lat, points[i].lon, points[i].lat);
    }
    return distance;
}

function segmentDistanceMeters(points, startIndex, endIndex) {
    return segmentDistanceKm(points, startIndex, endIndex) * 1000;
}

function buildOffroadRanges(points, offroad) {
    const ranges = [];
    let start = null;

    for (let i = 0; i < offroad.length; i++) {
        if (offroad[i] && start === null) {
            start = i;
        } else if (!offroad[i] && start !== null) {
            ranges.push({ start, end: i - 1 });
            start = null;
        }
    }

    if (start !== null) ranges.push({ start, end: offroad.length - 1 });

    return ranges
        .map(range => ({
            start: Math.max(0, range.start - 1),
            end: Math.min(points.length - 1, range.end + 1)
        }))
        .filter(range => range.end > range.start)
        .map(range => ({
            ...range,
            distanceKm: segmentDistanceKm(points, range.start, range.end)
        }))
        .filter(range => range.distanceKm >= OFFROAD_MIN_RANGE_DISTANCE_KM);
}

function segmentBbox(points, startIndex = 0, endIndex = points.length - 1) {
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;

    for (let i = startIndex; i <= endIndex; i++) {
        const point = points[i];
        if (point.lon < minLon) minLon = point.lon;
        if (point.lon > maxLon) maxLon = point.lon;
        if (point.lat < minLat) minLat = point.lat;
        if (point.lat > maxLat) maxLat = point.lat;
    }

    return {
        south: minLat - OVERPASS_BBOX_PADDING_DEG,
        west: minLon - OVERPASS_BBOX_PADDING_DEG,
        north: maxLat + OVERPASS_BBOX_PADDING_DEG,
        east: maxLon + OVERPASS_BBOX_PADDING_DEG
    };
}

function buildOverpassQuery(points, startIndex = 0, endIndex = points.length - 1) {
    const bbox = segmentBbox(points, startIndex, endIndex);
    return buildOverpassQueryFromBboxes([bbox]);
}

function buildOverpassQueryFromBboxes(bboxes) {
    const clauses = bboxes
        .map(bbox => `  way["highway"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});`)
        .join('\n');
    return `[out:json][timeout:25];
(
${clauses}
);
out tags geom;`;
}

function buildOverpassQueryForChunkBatch(points, chunks, startChunkIndex, endChunkIndex) {
    const bboxes = [];
    for (let i = startChunkIndex; i <= endChunkIndex; i++) {
        const chunk = chunks[i];
        bboxes.push(segmentBbox(points, chunk.startIndex, chunk.endIndex));
    }
    return buildOverpassQueryFromBboxes(bboxes);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function mergeOsmWays(wayGroups) {
    const merged = new Map();
    for (let i = 0; i < wayGroups.length; i++) {
        const ways = wayGroups[i];
        for (let j = 0; j < ways.length; j++) {
            const way = ways[j];
            if (!merged.has(way.id)) merged.set(way.id, way);
        }
    }
    return Array.from(merged.values());
}

function markOverpassError(error, retryable) {
    error.retryable = retryable;
    return error;
}

function isRetryableOverpassError(error) {
    return error?.retryable === true;
}

function getOffroadAnalysisErrorMessage(error) {
    if (error?.status === 429) {
        return "Overpass ha limitato le richieste. Riprova tra qualche secondo.";
    }
    if (error?.status === 408 || error?.status >= 500 || isRetryableOverpassError(error)) {
        return "Overpass non ha completato l'analisi in tempo. Riprova tra poco.";
    }
    return "Impossibile completare l'analisi superfici. Verifica rete/Overpass.";
}

function getOverpassRetryDelayMs(error, attempt) {
    const retryAfter = Number(error?.retryAfterSeconds);
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
        return Math.min(retryAfter * 1000, 30000);
    }
    return OVERPASS_RETRY_BASE_DELAY_MS * (attempt + 1);
}

function normalizeOverpassWays(data) {
    return (data.elements || [])
        .filter(element => element.type === 'way' && Array.isArray(element.geometry) && element.geometry.length >= 2)
        .map(element => ({
            id: element.id,
            tags: element.tags || {},
            geometry: element.geometry.map(node => ({ lat: node.lat, lon: node.lon }))
        }));
}

async function fetchOsmWaysForQuery(query) {
    const response = await fetch(OVERPASS_API_URL, {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `data=${encodeURIComponent(query)}`
    });

    if (!response.ok) {
        const error = markOverpassError(
            new Error(`Overpass ${response.status}`),
            response.status === 408 || response.status === 429 || response.status >= 500
        );
        error.status = response.status;
        error.retryAfterSeconds = response.headers.get('Retry-After');
        throw error;
    }

    let data;
    try {
        data = await response.json();
    } catch (error) {
        throw markOverpassError(new Error('Risposta Overpass non valida'), true);
    }

    if (data.remark && /timed out|timeout|runtime error/i.test(data.remark)) {
        throw markOverpassError(new Error(data.remark), true);
    }
    return normalizeOverpassWays(data);
}

async function fetchOsmWaysForQueryWithRetry(query, attempt = 0) {
    try {
        return await fetchOsmWaysForQuery(query);
    } catch (error) {
        if (!isRetryableOverpassError(error) || attempt >= OVERPASS_MAX_RATE_RETRIES) throw error;
        await delay(getOverpassRetryDelayMs(error, attempt));
        return fetchOsmWaysForQueryWithRetry(query, attempt + 1);
    }
}

async function fetchOsmWaysForRange(points, startIndex = 0, endIndex = points.length - 1) {
    return fetchOsmWaysForQueryWithRetry(buildOverpassQuery(points, startIndex, endIndex));
}

async function fetchOsmWaysForRangeWithRetry(points, startIndex, endIndex, retryDepth = 0) {
    try {
        return await fetchOsmWaysForRange(points, startIndex, endIndex);
    } catch (error) {
        const canSplit = endIndex - startIndex >= 3 && retryDepth < OVERPASS_MAX_RETRY_DEPTH;
        if (!isRetryableOverpassError(error) || !canSplit) throw error;

        const midIndex = Math.floor((startIndex + endIndex) / 2);
        const leftWays = await fetchOsmWaysForRangeWithRetry(points, startIndex, midIndex, retryDepth + 1);
        const rightWays = await fetchOsmWaysForRangeWithRetry(points, midIndex, endIndex, retryDepth + 1);
        return mergeOsmWays([leftWays, rightWays]);
    }
}

async function fetchOsmWaysForChunkBatchWithRetry(points, chunks, startChunkIndex, endChunkIndex, retryDepth = 0) {
    try {
        const query = buildOverpassQueryForChunkBatch(points, chunks, startChunkIndex, endChunkIndex);
        return await fetchOsmWaysForQueryWithRetry(query);
    } catch (error) {
        if (!isRetryableOverpassError(error) || retryDepth >= OVERPASS_MAX_RETRY_DEPTH) throw error;

        if (endChunkIndex > startChunkIndex) {
            const midChunkIndex = Math.floor((startChunkIndex + endChunkIndex) / 2);
            const leftWays = await fetchOsmWaysForChunkBatchWithRetry(points, chunks, startChunkIndex, midChunkIndex, retryDepth + 1);
            const rightWays = await fetchOsmWaysForChunkBatchWithRetry(points, chunks, midChunkIndex + 1, endChunkIndex, retryDepth + 1);
            return mergeOsmWays([leftWays, rightWays]);
        }

        const chunk = chunks[startChunkIndex];
        return fetchOsmWaysForRangeWithRetry(points, chunk.startIndex, chunk.endIndex, retryDepth + 1);
    }
}

function splitOffroadAnalysisChunks(points) {
    const chunks = [];
    if (!Array.isArray(points) || points.length < 2) return chunks;

    let startIndex = 0;
    let distanceKm = 0;
    let minLon = points[0].lon;
    let maxLon = points[0].lon;
    let minLat = points[0].lat;
    let maxLat = points[0].lat;

    for (let i = 1; i < points.length; i++) {
        const point = points[i];
        distanceKm += haversineDistance(points[i - 1].lon, points[i - 1].lat, point.lon, point.lat);
        if (point.lon < minLon) minLon = point.lon;
        if (point.lon > maxLon) maxLon = point.lon;
        if (point.lat < minLat) minLat = point.lat;
        if (point.lat > maxLat) maxLat = point.lat;

        const pointCount = i - startIndex + 1;
        const shouldClose = i < points.length - 1 && (
            pointCount >= OVERPASS_MAX_CHUNK_POINTS ||
            distanceKm >= OVERPASS_MAX_CHUNK_DISTANCE_KM ||
            maxLat - minLat >= OVERPASS_MAX_CHUNK_LAT_SPAN_DEG ||
            maxLon - minLon >= OVERPASS_MAX_CHUNK_LON_SPAN_DEG
        );

        if (shouldClose) {
            chunks.push({ startIndex, endIndex: i });
            startIndex = i;
            distanceKm = 0;
            minLon = point.lon;
            maxLon = point.lon;
            minLat = point.lat;
            maxLat = point.lat;
        }
    }

    if (points.length - startIndex >= 2) {
        chunks.push({ startIndex, endIndex: points.length - 1 });
    }

    return chunks;
}

function classifyOsmWaySurface(tags) {
    const surface = normalizeOsmTagValue(tags.surface);
    const tracktype = normalizeOsmTagValue(tags.tracktype);
    const highway = normalizeOsmTagValue(tags.highway);

    if (UNPAVED_SURFACES.has(surface)) return 'offroad';
    if (PAVED_SURFACES.has(surface)) return 'paved';
    if (OFFROAD_TRACKTYPES.has(tracktype)) return 'offroad';
    if (tracktype === 'grade1') return 'paved';
    if (OFFROAD_HIGHWAYS.has(highway)) return 'offroad';
    return 'unknown';
}

function metersPerLonAtLat(lat) {
    return 111320 * Math.max(0.01, Math.cos(lat * Math.PI / 180));
}

function pointToSegmentDistanceMeters(point, a, b) {
    const lat0 = point.lat;
    const mx = metersPerLonAtLat(lat0);
    const my = 110540;
    const px = point.lon * mx;
    const py = point.lat * my;
    const ax = a.lon * mx;
    const ay = a.lat * my;
    const bx = b.lon * mx;
    const by = b.lat * my;
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function pointToSegmentBboxDistanceMeters(point, segment) {
    const mx = metersPerLonAtLat(point.lat);
    const my = 110540;
    const dx = point.lon < segment.minLon
        ? (segment.minLon - point.lon) * mx
        : point.lon > segment.maxLon
            ? (point.lon - segment.maxLon) * mx
            : 0;
    const dy = point.lat < segment.minLat
        ? (segment.minLat - point.lat) * my
        : point.lat > segment.maxLat
            ? (point.lat - segment.maxLat) * my
            : 0;
    return Math.hypot(dx, dy);
}

function buildOsmWaySegments(osmWays) {
    const segments = [];
    for (let wi = 0; wi < osmWays.length; wi++) {
        const way = osmWays[wi];
        const surfaceClass = classifyOsmWaySurface(way.tags);
        for (let i = 1; i < way.geometry.length; i++) {
            const a = way.geometry[i - 1];
            const b = way.geometry[i];
            segments.push({
                way,
                surfaceClass,
                a,
                b,
                minLon: Math.min(a.lon, b.lon),
                maxLon: Math.max(a.lon, b.lon),
                minLat: Math.min(a.lat, b.lat),
                maxLat: Math.max(a.lat, b.lat)
            });
        }
    }
    return segments;
}

function findNearestOsmWaySegment(point, osmSegments) {
    let best = null;
    let bestDistance = Infinity;

    for (let i = 0; i < osmSegments.length; i++) {
        const segment = osmSegments[i];
        if (pointToSegmentBboxDistanceMeters(point, segment) >= bestDistance) continue;
        const distance = pointToSegmentDistanceMeters(point, segment.a, segment.b);
        if (distance < bestDistance) {
            best = segment;
            bestDistance = distance;
        }
    }

    return best ? { ...best, distance: bestDistance } : null;
}

function classifyTrackLegSurface(points, index, osmSegments) {
    const from = points[index - 1];
    const to = points[index];
    const mid = {
        lat: (from.lat + to.lat) / 2,
        lon: (from.lon + to.lon) / 2
    };
    const nearest = findNearestOsmWaySegment(mid, osmSegments);
    const legDistance = segmentDistanceMeters(points, index - 1, index);

    if (!nearest || nearest.distance > Math.max(OSM_MATCH_THRESHOLD_M, Math.min(80, legDistance * 0.35))) {
        return {
            surface: 'unknown',
            reason: 'unmapped',
            distance: nearest?.distance || Infinity
        };
    }

    return {
        surface: nearest.surfaceClass || 'unknown',
        reason: nearest.surfaceClass === 'unknown' ? 'unknown-road' : 'matched',
        distance: nearest.distance,
        tags: nearest.way.tags
    };
}

function classifyTrackLegAsOffroad(points, index, osmSegments) {
    const from = points[index - 1];
    const to = points[index];
    const mid = {
        lat: (from.lat + to.lat) / 2,
        lon: (from.lon + to.lon) / 2
    };
    const nearest = findNearestOsmWaySegment(mid, osmSegments);
    const legDistance = segmentDistanceMeters(points, index - 1, index);

    if (!nearest || nearest.distance > Math.max(OSM_MATCH_THRESHOLD_M, Math.min(80, legDistance * 0.35))) {
        return {
            offroad: true,
            reason: 'unmapped',
            distance: nearest?.distance || Infinity
        };
    }

    if (nearest.surfaceClass === 'offroad') {
        return {
            offroad: true,
            reason: 'unpaved',
            distance: nearest.distance,
            tags: nearest.way.tags
        };
    }

    return {
        offroad: false,
        reason: nearest.surfaceClass === 'paved' ? 'paved' : 'unknown-road',
        distance: nearest.distance,
        tags: nearest.way.tags
    };
}

function clonePoint(point) {
    const cloned = {
        lat: point.lat,
        lon: point.lon,
        ele: point.ele || 0,
        isUserClicked: point.isUserClicked === true
    };
    if (point.time) cloned.time = point.time;
    if (point.surface) cloned.surface = point.surface;
    return cloned;
}

function getAnalyzableSegments(sourceTrack) {
    return (sourceTrack?.segments || [])
        .filter(segment => Array.isArray(segment.points) && segment.points.length >= 2);
}

// === Job di analisi offroad in corso: placeholder "in caricamento" nel GIS tree ===
const _offroadJobs = new Map();
let _offroadJobSeq = 0;

// Cede il controllo al browser per permettere il repaint (spinner, barra, mappa)
// durante i loop pesanti di classificazione superfici.
function yieldToUi() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

function createOffroadCancelledError() {
    const error = new Error('Analisi offroad annullata');
    error.offroadCancelled = true;
    return error;
}

function getOffroadJobStatusText(job) {
    if (job.cancelled) return 'Annullamento in corso…';
    const current = Math.min(job.doneChunks + 1, job.totalChunks);
    if (job.phase === 'fetch') {
        return `Scarico dati stradali OSM… blocco ${current}/${job.totalChunks}`;
    }
    return `Analisi tratti non asfaltati… blocco ${current}/${job.totalChunks}`;
}

function getOffroadJobPercent(job) {
    if (!job.totalChunks) return 0;
    return Math.round((job.doneChunks / job.totalChunks) * 100);
}

function updateOffroadJobUi(job) {
    const statusEl = document.getElementById(`offroad-job-status-${job.id}`);
    if (statusEl) statusEl.textContent = getOffroadJobStatusText(job);
    const barEl = document.getElementById(`offroad-job-bar-${job.id}`);
    if (barEl) barEl.style.width = `${getOffroadJobPercent(job)}%`;
}

function startOffroadJob(label, totalChunks) {
    const job = {
        id: `job_${Date.now()}_${++_offroadJobSeq}`,
        label: label || 'Traccia',
        totalChunks: Math.max(totalChunks, 1),
        doneChunks: 0,
        cancelled: false
    };
    _offroadJobs.set(job.id, job);
    renderGisTree();
    flushGisTreeIfDirty();
    return job;
}

function finishOffroadJob(job) {
    if (!job) return;
    _offroadJobs.delete(job.id);
    renderGisTree();
    flushGisTreeIfDirty();
}

export function cancelOffroadAnalysis(jobId) {
    const job = _offroadJobs.get(jobId);
    if (!job || job.cancelled) return;
    job.cancelled = true;
    updateOffroadJobUi(job);
    showToast('Annullamento analisi offroad…', 'info');
}

function renderOffroadJobsHtml() {
    if (_offroadJobs.size === 0) return '';
    let html = '';
    _offroadJobs.forEach(job => {
        html += `
        <div class="gis-track-card bg-gray-900/95 border border-amber-700/60 rounded-xl overflow-hidden shadow-lg" id="offroad-job-${job.id}">
          <div class="flex items-stretch">
            <div class="w-1.5 bg-amber-500/80 animate-pulse"></div>
            <div class="flex-1 min-w-0 p-2.5 space-y-1.5">
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-1.5 min-w-0">
                  <i data-lucide="loader-2" class="w-3.5 h-3.5 text-amber-300 animate-spin shrink-0"></i>
                  <span class="text-xs font-bold text-amber-100 truncate">Offroad - ${escapeXml(job.label)}</span>
                </div>
                <button onclick="cancelOffroadAnalysis('${job.id}')" class="text-[10px] font-semibold text-gray-400 hover:text-red-300 border border-gray-700 hover:border-red-800 rounded px-1.5 py-0.5 shrink-0" title="Annulla l'analisi offroad in corso">Annulla</button>
              </div>
              <div id="offroad-job-status-${job.id}" class="text-[10px] text-gray-400 pl-5">${getOffroadJobStatusText(job)}</div>
              <div class="ml-5 h-1 rounded-full bg-gray-800 overflow-hidden">
                <div id="offroad-job-bar-${job.id}" class="h-full bg-amber-400/80 transition-all duration-300" style="width:${getOffroadJobPercent(job)}%"></div>
              </div>
            </div>
          </div>
        </div>`;
    });
    return `<div class="space-y-2 mb-3">
      <span class="text-[10px] text-amber-300/90 font-bold uppercase tracking-wider flex items-center gap-1">
        <i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i> Analisi in corso (${_offroadJobs.size})
      </span>${html}
    </div>`;
}

function countOffroadAnalysisChunks(sourceSegments) {
    let total = 0;
    for (let i = 0; i < sourceSegments.length; i++) {
        total += splitOffroadAnalysisChunks(sourceSegments[i].points).length;
    }
    return total;
}

async function analyzeOffroadSegment(sourceSegment, job = null) {
    const points = sourceSegment.points || [];
    const chunks = splitOffroadAnalysisChunks(points);
    const offroad = new Array(points.length).fill(false);
    const seenOsmWayIds = new Set();
    let unpavedLegCount = 0;
    let unmappedLegCount = 0;
    let pavedLegCount = 0;
    let unknownRoadLegCount = 0;
    let matchedWayCount = 0;

    for (let c = 0; c < chunks.length; c += OVERPASS_MAX_CHUNKS_PER_REQUEST) {
        if (job?.cancelled) throw createOffroadCancelledError();
        const endChunkIndex = Math.min(chunks.length - 1, c + OVERPASS_MAX_CHUNKS_PER_REQUEST - 1);
        if (job) {
            job.phase = 'fetch';
            updateOffroadJobUi(job);
        }
        const osmWays = await fetchOsmWaysForChunkBatchWithRetry(points, chunks, c, endChunkIndex);
        if (job?.cancelled) throw createOffroadCancelledError();
        if (job) {
            job.phase = 'classify';
            updateOffroadJobUi(job);
        }
        for (let w = 0; w < osmWays.length; w++) {
            seenOsmWayIds.add(osmWays[w].id);
        }

        const osmSegments = buildOsmWaySegments(osmWays);
        for (let chunkIndex = c; chunkIndex <= endChunkIndex; chunkIndex++) {
            if (job) {
                if (job.cancelled) throw createOffroadCancelledError();
                // Repaint del browser tra un blocco e l'altro: senza questo yield
                // la classificazione blocca il main thread e l'interfaccia si congela.
                await yieldToUi();
            }
            const chunk = chunks[chunkIndex];
            for (let i = chunk.startIndex + 1; i <= chunk.endIndex; i++) {
                // Yield periodico anche dentro il blocco: con dati OSM urbani densi
                // la classificazione di un singolo blocco può richiedere secondi.
                if (job && ((i - chunk.startIndex) % 64) === 0) await yieldToUi();
                const classification = classifyTrackLegAsOffroad(points, i, osmSegments);
                if (classification.offroad) {
                    offroad[i - 1] = true;
                    offroad[i] = true;
                    if (classification.reason === 'unpaved') {
                        unpavedLegCount++;
                        matchedWayCount++;
                    } else {
                        unmappedLegCount++;
                    }
                } else {
                    if (classification.reason === 'paved') {
                        pavedLegCount++;
                        matchedWayCount++;
                    } else {
                        unknownRoadLegCount++;
                    }
                }
            }
            if (job) {
                job.doneChunks = Math.min(job.totalChunks, job.doneChunks + 1);
                updateOffroadJobUi(job);
            }
        }
    }

    return {
        ranges: buildOffroadRanges(points, offroad),
        osmWayCount: seenOsmWayIds.size,
        osmChunkCount: chunks.length,
        matchedWayCount,
        unpavedLegCount,
        unmappedLegCount,
        pavedLegCount,
        unknownRoadLegCount
    };
}

function createSurfaceSummary() {
    return {
        osmWayCount: 0,
        osmChunkCount: 0,
        matchedWayCount: 0,
        pavedLegCount: 0,
        offroadLegCount: 0,
        unknownLegCount: 0,
        pavedKm: 0,
        offroadKm: 0,
        unknownKm: 0
    };
}

function addSurfaceSummary(summary, partial) {
    summary.osmWayCount += partial.osmWayCount;
    summary.osmChunkCount += partial.osmChunkCount;
    summary.matchedWayCount += partial.matchedWayCount;
    summary.pavedLegCount += partial.pavedLegCount;
    summary.offroadLegCount += partial.offroadLegCount;
    summary.unknownLegCount += partial.unknownLegCount;
    summary.pavedKm += partial.pavedKm;
    summary.offroadKm += partial.offroadKm;
    summary.unknownKm += partial.unknownKm;
}

function getDominantSurfaceFromSummary(summary) {
    const knownKm = summary.pavedKm + summary.offroadKm;
    if (knownKm <= 0) return 'unknown';
    return summary.offroadKm >= summary.pavedKm ? 'offroad' : 'paved';
}

async function analyzeSurfaceSegment(sourceSegment) {
    const points = sourceSegment.points || [];
    const chunks = splitOffroadAnalysisChunks(points);
    const legSurfaces = new Array(points.length).fill('unknown');
    const seenOsmWayIds = new Set();
    const summary = createSurfaceSummary();
    summary.osmChunkCount = chunks.length;

    for (let c = 0; c < chunks.length; c += OVERPASS_MAX_CHUNKS_PER_REQUEST) {
        const endChunkIndex = Math.min(chunks.length - 1, c + OVERPASS_MAX_CHUNKS_PER_REQUEST - 1);
        const osmWays = await fetchOsmWaysForChunkBatchWithRetry(points, chunks, c, endChunkIndex);
        for (let w = 0; w < osmWays.length; w++) {
            seenOsmWayIds.add(osmWays[w].id);
        }

        const osmSegments = buildOsmWaySegments(osmWays);
        for (let chunkIndex = c; chunkIndex <= endChunkIndex; chunkIndex++) {
            const chunk = chunks[chunkIndex];
            for (let i = chunk.startIndex + 1; i <= chunk.endIndex; i++) {
                const classification = classifyTrackLegSurface(points, i, osmSegments);
                const surface = classification.surface || 'unknown';
                const distanceKm = segmentDistanceKm(points, i - 1, i);
                legSurfaces[i] = surface;

                if (surface === 'paved') {
                    summary.pavedLegCount++;
                    summary.pavedKm += distanceKm;
                    summary.matchedWayCount++;
                } else if (surface === 'offroad') {
                    summary.offroadLegCount++;
                    summary.offroadKm += distanceKm;
                    summary.matchedWayCount++;
                } else {
                    summary.unknownLegCount++;
                    summary.unknownKm += distanceKm;
                }
            }
        }
    }

    summary.osmWayCount = seenOsmWayIds.size;
    return { legSurfaces, summary };
}

function applySurfaceAnalysisToSegment(sourceSegment, analysis) {
    const points = sourceSegment.points || [];
    const legSurfaces = analysis.legSurfaces || [];
    let firstSurface = null;

    for (let i = 1; i < points.length; i++) {
        const surface = legSurfaces[i] || 'unknown';
        points[i].surfaceFromPrev = surface;
        points[i].surface = surface;
        if (firstSurface === null) firstSurface = surface;
    }

    if (points[0] && firstSurface !== null) {
        points[0].surface = firstSurface;
    }
    sourceSegment.surface = getDominantSurfaceFromSummary(analysis.summary);
}

function formatFetchedSurfaceSummary(summary) {
    const totalKm = summary.pavedKm + summary.offroadKm + summary.unknownKm;
    if (totalKm <= 0) return 'nessun tratto analizzato';
    const pavedPercent = Math.round((summary.pavedKm / totalKm) * 100);
    const offroadPercent = Math.round((summary.offroadKm / totalKm) * 100);
    const unknownPercent = Math.max(0, 100 - pavedPercent - offroadPercent);
    return `asfalto ${pavedPercent}%, offroad ${offroadPercent}%, N/D ${unknownPercent}%`;
}

function createOffroadTrack(sourceTrack, extractedRanges, nameBase, summary) {
    const createdAt = Date.now();
    const sourceTrackName = sourceTrack.name || 'Traccia';
    const newTrack = {
        id: `track_offroad_${createdAt}`,
        localFileId: `local_${createdAt}_${Math.random().toString(36).slice(2, 8)}`,
        localCreatedAt: createdAt,
        localUpdatedAt: createdAt,
        localSource: 'derived',
        name: `Offroad - ${nameBase}`,
        desc: `Tratti non asfaltati estratti da ${sourceTrackName}. OSM highway/surface/tracktype. Blocchi OSM: ${summary.osmChunkCount}; segmenti non asfaltati: ${summary.unpavedLegCount}; fuori rete OSM: ${summary.unmappedLegCount}.`,
        surface: 'offroad',
        color: generateDistinctTrackColor(tracks.map(track => track.color)),
        width: Math.max((sourceTrack.width || 3) + 2, 5),
        visible: true,
        waypointsVisible: true,
        segments: extractedRanges.map((item, index) => ({
            id: `seg_offroad_${createdAt}_${index + 1}`,
            name: `${item.sourceSegment.name || 'Segmento'} - offroad ${index + 1}`,
            surface: 'offroad',
            points: item.sourceSegment.points.slice(item.range.start, item.range.end + 1).map(clonePoint),
            visible: true
        })),
        waypoints: []
    };

    tracks.push(newTrack);
    setActiveTrackId(newTrack.id);
    setActiveSegmentId(newTrack.segments[0]?.id || null);
    return newTrack;
}

async function extractOffroadFromSources(sourceTrack, sourceSegments, nameBase) {
    closeTrackContextMenu();

    if (!sourceTrack || sourceSegments.length === 0) {
        showToast("Nessun segmento valido per analizzare l'offroad", "error");
        return;
    }

    const totalChunks = countOffroadAnalysisChunks(sourceSegments);
    showToast(`Analisi superfici OSM: ${sourceSegments.length} segmenti, ${totalChunks} blocchi...`, "info");

    // Placeholder "in caricamento" subito visibile nel GIS tree
    const job = startOffroadJob(nameBase, totalChunks);

    try {
        const extractedRanges = [];
        const summary = {
            osmWayCount: 0,
            osmChunkCount: 0,
            matchedWayCount: 0,
            unpavedLegCount: 0,
            unmappedLegCount: 0,
            pavedLegCount: 0,
            unknownRoadLegCount: 0
        };

        for (let i = 0; i < sourceSegments.length; i++) {
            if (job.cancelled) throw createOffroadCancelledError();
            const sourceSegment = sourceSegments[i];
            const result = await analyzeOffroadSegment(sourceSegment, job);
            summary.osmWayCount += result.osmWayCount;
            summary.osmChunkCount += result.osmChunkCount;
            summary.matchedWayCount += result.matchedWayCount;
            summary.unpavedLegCount += result.unpavedLegCount;
            summary.unmappedLegCount += result.unmappedLegCount;
            summary.pavedLegCount += result.pavedLegCount;
            summary.unknownRoadLegCount += result.unknownRoadLegCount;

            for (let r = 0; r < result.ranges.length; r++) {
                extractedRanges.push({
                    sourceSegment,
                    range: result.ranges[r]
                });
            }
        }

        if (extractedRanges.length === 0) {
            showToast(`Nessun tratto non asfaltato rilevato: ${summary.pavedLegCount} tratti asfaltati, ${summary.unknownRoadLegCount} senza surface`, "info");
            return;
        }

        const newTrack = createOffroadTrack(sourceTrack, extractedRanges, nameBase, summary);
        if (_saveHistoryState) _saveHistoryState();
        if (_updateMapData) _updateMapData(true);
        renderGisTree();
        updateActiveTracksHeader();
        focusTrackOnMap(newTrack);
        schedulePersistTracks(tracks);
        schedulePersistAppSession();
        showToast(`Creata ${newTrack.name}: ${extractedRanges.length} tratti non asfaltati`, "success");
    } catch (err) {
        if (err?.offroadCancelled) {
            showToast("Analisi offroad annullata", "info");
        } else {
            console.error(err);
            showToast(getOffroadAnalysisErrorMessage(err), "error");
        }
    } finally {
        // Rimuove sempre il placeholder dal GIS tree (successo, errore,
        // annullamento o nessun tratto trovato).
        finishOffroadJob(job);
    }
}

export async function extractOffroadFromTrack(trackId) {
    const sourceTrack = tracks.find(track => track.id === trackId);
    const sourceSegments = getAnalyzableSegments(sourceTrack);
    await extractOffroadFromSources(sourceTrack, sourceSegments, sourceTrack?.name || 'Traccia');
}

export async function fetchSurfaceDataForTrack(trackId) {
    closeTrackContextMenu();

    const sourceTrack = tracks.find(track => track.id === trackId);
    const sourceSegments = getAnalyzableSegments(sourceTrack);
    if (!sourceTrack || sourceSegments.length === 0) {
        showToast("Nessun segmento valido per recuperare le superfici", "error");
        return;
    }

    const totalChunks = countOffroadAnalysisChunks(sourceSegments);
    showToast(`Richiesta superfici Overpass: ${sourceSegments.length} segmenti, ${totalChunks} blocchi...`, "info");

    try {
        const summary = createSurfaceSummary();
        for (let i = 0; i < sourceSegments.length; i++) {
            const sourceSegment = sourceSegments[i];
            const analysis = await analyzeSurfaceSegment(sourceSegment);
            applySurfaceAnalysisToSegment(sourceSegment, analysis);
            addSurfaceSummary(summary, analysis.summary);
        }

        sourceTrack.surface = getDominantSurfaceFromSummary(summary);
        sourceTrack.surfaceAnalyzedAt = Date.now();
        sourceTrack.localUpdatedAt = Date.now();

        if (_saveHistoryState) _saveHistoryState();
        if (_updateMapData) _updateMapData(true);
        renderGisTree();
        updateActiveTracksHeader();
        forceUpdateStats();
        schedulePersistTracks(tracks);
        schedulePersistAppSession();
        showToast(`Superfici aggiornate: ${formatFetchedSurfaceSummary(summary)}`, "success");
    } catch (err) {
        console.error(err);
        showToast(getOffroadAnalysisErrorMessage(err), "error");
    }
}

export async function extractOffroadFromSegment(trackId, segId) {
    const sourceTrack = tracks.find(track => track.id === trackId);
    const sourceSegment = sourceTrack?.segments.find(segment => segment.id === segId);

    if (!sourceTrack || !sourceSegment || !Array.isArray(sourceSegment.points) || sourceSegment.points.length < 2) {
        showToast("Segmento troppo corto per analizzare l'offroad", "error");
        return;
    }

    await extractOffroadFromSources(sourceTrack, [sourceSegment], sourceSegment.name || sourceTrack.name || 'Segmento');
}

export function handleTrackNamePointerDown(event, trackId) {
    if (event.pointerType === 'mouse') {
        const now = Date.now();
        if (_lastTrackNamePointer.trackId === trackId && now - _lastTrackNamePointer.time < 450) {
            event.preventDefault();
            openTrackNameEditor(trackId);
        }
        _lastTrackNamePointer = { trackId, time: now };
        return;
    }
    event.stopPropagation();
    clearTimeout(_trackNameLongPressTimer);
    _trackNameLongPressTimer = setTimeout(() => {
        openTrackNameEditor(trackId);
    }, 650);
}

export function clearTrackNameLongPress() {
    clearTimeout(_trackNameLongPressTimer);
    _trackNameLongPressTimer = null;
}

export function handleTrackNameClick(event, trackId) {
    event.stopPropagation();
    const now = Date.now();
    const isSecondClick = _lastTrackNameClick.trackId === trackId && now - _lastTrackNameClick.time < 800;
    _lastTrackNameClick = { trackId, time: now };
    if (event.detail >= 2 || isSecondClick) {
        event.preventDefault();
        openTrackNameEditor(trackId);
        return;
    }
    if (trackId === activeTrackId) {
        const track = tracks.find(tr => tr.id === trackId);
        if (track) focusTrackOnMap(track);
        toggleActiveTrackExpanded(trackId);
        return;
    }
    setTrackActive(trackId, true);
}

export function openTrackNameEditor(trackId) {
    closeTrackContextMenu();
    const nameEl = document.getElementById(`track-name-${trackId}`);
    if (!nameEl) return;
    nameEl.contentEditable = 'true';
    nameEl.classList.remove('cursor-pointer');
    nameEl.classList.add('cursor-text');
    nameEl.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(nameEl);
    selection.removeAllRanges();
    selection.addRange(range);
}

export function finishTrackNameEditor(trackId, newName) {
    const nameEl = document.getElementById(`track-name-${trackId}`);
    if (nameEl) {
        nameEl.contentEditable = 'false';
        nameEl.classList.add('cursor-pointer');
        nameEl.classList.remove('cursor-text');
    }
    renameTrack(trackId, newName);
}

export function handleTrackNameKeydown(event, trackId) {
    if (event.key === 'Enter') {
        event.preventDefault();
        finishTrackNameEditor(trackId, event.currentTarget.textContent);
        event.currentTarget.blur();
    } else if (event.key === 'Escape') {
        event.preventDefault();
        const track = tracks.find(tr => tr.id === trackId);
        if (track) event.currentTarget.textContent = track.name;
        event.currentTarget.blur();
    }
}

function formatLibraryDate(ts) {
    if (!ts) return 'Data sconosciuta';
    return new Date(ts).toLocaleString('it-IT', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

export async function renderLocalGpxLibrary() {
    const container = document.getElementById('local-gpx-library');
    if (!container) return;

    try {
        const files = await listStoredTracks();
        if (files.length === 0) {
            container.innerHTML = `
              <div class="text-center py-4 text-gray-500 text-[11px] italic">
                Nessun GPX salvato sul dispositivo.
              </div>`;
            return;
        }

        container.innerHTML = files.map(file => {
            const loadedTrack = tracks.find(track => track.localFileId === file.id);
            const stateLabel = loadedTrack
                ? (loadedTrack.visible === false ? 'Nascosta' : 'Visibile')
                : (file.visible === false ? 'Nascosta salvata' : 'Visibile salvata');
            return `
              <div class="bg-gray-900 border border-gray-800 rounded-xl p-2.5 space-y-2">
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0">
                    <div class="text-xs font-semibold text-white truncate">${escapeXml(file.name)}</div>
                    <div class="text-[10px] text-gray-500">
                      ${file.source === 'imported' ? 'Importato' : 'Creato in app'} · Agg. ${formatLibraryDate(file.updatedAt)}
                    </div>
                  </div>
                  <button onclick="deleteStoredTrackFromLibrary('${file.id}')" class="text-gray-500 hover:text-red-400 shrink-0" title="Elimina dal dispositivo">
                    <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                  </button>
                </div>
                <div class="flex items-center justify-between gap-2 text-[10px] text-gray-500">
                  <span>${file.pointsCount} pt · ${file.segmentsCount} seg · ${file.waypointCount} wp</span>
                  <span class="${loadedTrack && loadedTrack.visible !== false ? 'text-green-400' : 'text-gray-500'}">${stateLabel}</span>
                </div>
                <div class="flex gap-2">
                  <button onclick="openStoredTrackFromLibrary('${file.id}')" class="flex-1 bg-emerald-600/20 hover:bg-emerald-600/35 text-emerald-300 border border-emerald-900/80 rounded-lg py-1.5 text-[11px] font-semibold ${loadedTrack ? 'opacity-60 cursor-default' : ''}">
                    ${loadedTrack ? 'Gia caricato' : 'Carica'}
                  </button>
                </div>
              </div>
            `;
        }).join('');
        refreshLucideIcons();
    } catch (err) {
        console.error(err);
        container.innerHTML = `
          <div class="text-center py-4 text-red-400 text-[11px] italic">
            Archivio locale non disponibile.
          </div>`;
    }
}

export async function openStoredTrackFromLibrary(fileId) {
    const existing = tracks.find(track => track.localFileId === fileId);
    if (existing) {
        setTrackActive(existing.id);
        showToast(`Già in memoria: ${existing.name}`, 'info');
        return;
    }

    const storedTrack = await loadStoredTrack(fileId);
    if (!storedTrack) {
        showToast("File locale non trovato", "error");
        renderLocalGpxLibrary();
        return;
    }

    ensureTrackStorageMeta(storedTrack, storedTrack.localSource || 'imported');
    tracks.push(storedTrack);
    setActiveTrackId(storedTrack.id);
    setActiveSegmentId(storedTrack.segments[0]?.id || null);
    if (_saveHistoryState) _saveHistoryState();
    if (_updateMapData) _updateMapData(true);
    updateActiveTracksHeader();
    renderGisTree();
    renderLocalGpxLibrary();
    schedulePersistAppSession();
    showToast(`Caricato da archivio: ${storedTrack.name}`, 'success');
}

export async function restoreStoredTracksOnStartup() {
    const session = loadPersistedAppSession();
    const files = await listStoredTracks();
    if (files.length === 0) return { restoredCount: 0, session };

    const restoredTracks = [];
    for (let i = 0; i < files.length; i++) {
        const storedTrack = await loadStoredTrack(files[i].id);
        if (!storedTrack) continue;
        ensureTrackStorageMeta(storedTrack, storedTrack.localSource || 'imported');
        if (!Array.isArray(storedTrack.segments) || storedTrack.segments.length === 0) {
            storedTrack.segments = [{
                id: 'seg_' + Date.now() + '_' + i,
                name: 'Tracciato 1',
                points: [],
                visible: true
            }];
        }
        restoredTracks.push(storedTrack);
    }

    if (restoredTracks.length === 0) return { restoredCount: 0, session };

    if (Array.isArray(session?.trackOrder) && session.trackOrder.length > 0) {
        const orderMap = new Map(session.trackOrder.map((id, index) => [id, index]));
        restoredTracks.sort((a, b) => {
            const aIndex = orderMap.has(a.localFileId) ? orderMap.get(a.localFileId) : Number.MAX_SAFE_INTEGER;
            const bIndex = orderMap.has(b.localFileId) ? orderMap.get(b.localFileId) : Number.MAX_SAFE_INTEGER;
            return aIndex - bIndex;
        });
    }

    setTracks(restoredTracks);
    const activeTrack = restoredTracks.find(track => track.id === session?.activeTrackId)
        || restoredTracks.find(track => track.visible !== false)
        || restoredTracks[0];
    setActiveTrackId(activeTrack?.id || null);

    const activeSegment = activeTrack?.segments.find(segment => segment.id === session?.activeSegmentId)
        || activeTrack?.segments[0]
        || null;
    setActiveSegmentId(activeSegment?.id || null);

    if (typeof session?.hikingTrailsVisible === 'boolean') {
        const hikingToggle = document.getElementById('toggle-hiking-trails');
        if (hikingToggle) hikingToggle.checked = session.hikingTrailsVisible;
        if (mapLoaded && map.getLayer('hiking-trails-layer')) {
            map.setLayoutProperty('hiking-trails-layer', 'visibility', session.hikingTrailsVisible ? 'visible' : 'none');
        }
    }
    if (document.getElementById('toggle-mapillary')) {
        document.getElementById('toggle-mapillary').checked = session?.mapillaryVisible === true;
    }
    if (_setMapillaryCoverageVisible) {
        _setMapillaryCoverageVisible(session?.mapillaryVisible === true, { silent: true });
    }

    if (_setSnapProfile) {
        _setSnapProfile(session?.currentSnapProfile || 'off', { silent: true });
    }

    if (_updateMapData) _updateMapData(true);
    updateActiveTracksHeader();
    renderGisTree();
    renderLocalGpxLibrary();

    const applyMapSession = () => {
        if (session?.mapView && mapLoaded && map) {
            map.jumpTo({
                center: session.mapView.center,
                zoom: session.mapView.zoom,
                pitch: session.mapView.pitch,
                bearing: session.mapView.bearing
            });
        }
        if (_setDimensionMode) {
            _setDimensionMode(!!session?.is3D, { silent: true });
        }
    };

    if (session?.currentStyle && session.currentStyle !== currentStyle && _setBaseMap) {
        map.once('idle', applyMapSession);
        _setBaseMap(session.currentStyle);
    } else {
        applyMapSession();
    }

    schedulePersistAppSession();
    return { restoredCount: restoredTracks.length, session };
}

export async function deleteStoredTrackFromLibrary(fileId) {
    const track = tracks.find(item => item.localFileId === fileId);
    if (track) {
        deleteTrack(track.id);
        return;
    }

    await deleteStoredTrack(fileId);
    renderLocalGpxLibrary();
    showToast("GPX eliminato dal dispositivo", "info");
}

export function initLocalLibrary() {
    renderLocalGpxLibrary();
    if (_localLibraryBound) return;
    onLibraryChanged(() => {
        renderLocalGpxLibrary();
    });
    _localLibraryBound = true;
}

// Verifica se l'albero GIS è visibile sullo schermo. Quando il pannello è chiuso
// non ricostruiamo il DOM (risparmio enorme su tracce enormi con tanti segmenti).
export function isGisTreeVisible() {
    const el = document.getElementById('sidebar-tracks-right');
    if (!el) return false;
    return !el.classList.contains('translate-x-96');
}

function isCompactLayout() {
    return _compactLayoutMedia.matches;
}

function isMainMenuOpen() {
    const el = document.getElementById('panel-main-menu');
    return !!el && !el.classList.contains('-translate-x-80');
}

function isSidebarOpen() {
    const el = document.getElementById('sidebar-tracks-right');
    return !!el && !el.classList.contains('translate-x-96');
}

function isStatsPanelOpen() {
    const el = document.getElementById('panel-bottom-stats');
    return !!el && !el.classList.contains('translate-y-60');
}

function isPrintSetupOpen() {
    const el = document.getElementById('panel-print-setup');
    return !!el && !el.classList.contains('hidden');
}

function closeMainMenu() {
    document.getElementById('panel-main-menu').classList.add('-translate-x-80');
    collapseDeviceDashboardSettingsPanel();
}

function closeSidebar() {
    document.getElementById('sidebar-tracks-right').classList.add('translate-x-96');
}

function closeStatsPanel() {
    document.getElementById('panel-bottom-stats').classList.add('translate-y-60');
    document.body.classList.remove('stats-panel-open');
    document.getElementById('btn-toggle-stats').classList.remove('bg-blue-600', 'text-white');
    document.getElementById('btn-toggle-stats').classList.add('text-gray-300');
    document.getElementById('btn-mobile-stats')?.classList.remove('bg-blue-600', 'text-white');
}

function closeOtherPanels(except) {
    closeMobileToolbar();
    if (except !== 'main') closeMainMenu();
    if (except !== 'sidebar') closeSidebar();
    if (except !== 'stats') closeStatsPanel();
    if (except !== 'print' && _disablePrintPlanning) _disablePrintPlanning();
}

function closeMobileToolbar() {
    document.body.classList.remove('mobile-tools-open');
    document.getElementById('btn-mobile-toolbar-toggle')?.classList.remove('bg-blue-600', 'text-white');
}

function toggleMobileToolbar() {
    const isOpen = document.body.classList.toggle('mobile-tools-open');
    const btn = document.getElementById('btn-mobile-toolbar-toggle');
    btn?.classList.toggle('bg-blue-600', isOpen);
    btn?.classList.toggle('text-white', isOpen);
}

export function syncMobileBackdrop() {
    const backdrop = document.getElementById('mobile-panel-backdrop');
    if (!backdrop) return;

    if (!isCompactLayout()) {
        backdrop.classList.add('hidden');
        return;
    }

    // Struttura GIS e progettazione stampa restano leggere su mobile: niente
    // backdrop, cosi la mappa rimane visibile mentre si naviga tra gli elementi.
    const hasOpenPanel = isMainMenuOpen() || isStatsPanelOpen();
    backdrop.classList.toggle('hidden', !hasOpenPanel);
}

// Debounce interno: evita di ricostruire il tree DOM ad ogni singola modifica
let _gisTreeTimer = null;
let _gisTreeDirty = false;
const _collapsedActiveTrackIds = new Set();
const _collapsedTrackSectionKeys = new Set();

// Paginazione GIS tree: con file enormi (1000+ segmenti, centinaia di waypoint)
// renderizzare tutte le righe in un colpo solo blocca il main thread per
// centinaia di ms (HTML + innerHTML + icone Lucide). Mostriamo le prime N righe
// e un pulsante "Mostra altri".
const GIS_TREE_PAGE_SIZE = 120;
const _gisTreeSegmentLimits = new Map();
const _gisTreeWaypointLimits = new Map();

export function showMoreGisSegments(trackId) {
    const current = _gisTreeSegmentLimits.get(trackId) || GIS_TREE_PAGE_SIZE;
    _gisTreeSegmentLimits.set(trackId, current + GIS_TREE_PAGE_SIZE);
    renderGisTree();
}

export function showMoreGisWaypoints(trackId) {
    const current = _gisTreeWaypointLimits.get(trackId) || GIS_TREE_PAGE_SIZE;
    _gisTreeWaypointLimits.set(trackId, current + GIS_TREE_PAGE_SIZE);
    renderGisTree();
}

// Aggiornamento leggero dei contatori punti nel GIS tree senza re-render
// completo: usato durante il disegno/registrazione (hot path).
export function updateGisTreeCounters(trackId, segId = null) {
    _gisTreeDirty = true; // il prossimo flush completo riallinea tutto il resto
    if (!isGisTreeVisible()) return;
    const track = tracks.find(t => t.id === trackId);
    if (!track) return;
    if (segId) {
        const seg = track.segments.find(s => s.id === segId);
        const segEl = document.getElementById(`seg-pt-count-${segId}`);
        if (seg && segEl) segEl.textContent = `${seg.points.length.toLocaleString('it-IT')} pt`;
    }
    const metaEl = document.getElementById(`track-meta-${track.id}`);
    if (metaEl) {
        const trackIndex = tracks.indexOf(track);
        let pointCount = 0;
        for (let i = 0; i < track.segments.length; i++) pointCount += track.segments[i].points.length;
        metaEl.textContent = `File ${trackIndex + 1} · ${track.segments.length} segmenti · ${pointCount} pt · ${track.waypoints.length} wp · ${track.width || 3}px`;
    }
}

function pruneCollapsedActiveTracks() {
    const validTrackIds = new Set(tracks.map(track => track.id));
    _collapsedActiveTrackIds.forEach(trackId => {
        if (!validTrackIds.has(trackId)) _collapsedActiveTrackIds.delete(trackId);
    });
    _collapsedTrackSectionKeys.forEach(key => {
        const [trackId] = key.split(':');
        if (!validTrackIds.has(trackId)) _collapsedTrackSectionKeys.delete(key);
    });
    _gisTreeSegmentLimits.forEach((_, trackId) => {
        if (!validTrackIds.has(trackId)) _gisTreeSegmentLimits.delete(trackId);
    });
    _gisTreeWaypointLimits.forEach((_, trackId) => {
        if (!validTrackIds.has(trackId)) _gisTreeWaypointLimits.delete(trackId);
    });
}

function isTrackExpanded(trackId, isActive) {
    return isActive && !_collapsedActiveTrackIds.has(trackId);
}

function setTrackExpanded(trackId, expanded) {
    if (expanded) _collapsedActiveTrackIds.delete(trackId);
    else _collapsedActiveTrackIds.add(trackId);
}

function toggleActiveTrackExpanded(trackId) {
    if (_collapsedActiveTrackIds.has(trackId)) _collapsedActiveTrackIds.delete(trackId);
    else _collapsedActiveTrackIds.add(trackId);
    renderGisTree();
}

function makeTrackSectionKey(trackId, section) {
    return `${trackId}:${section}`;
}

function isTrackSectionExpanded(trackId, section) {
    return !_collapsedTrackSectionKeys.has(makeTrackSectionKey(trackId, section));
}

function setTrackSectionExpanded(trackId, section, expanded) {
    const key = makeTrackSectionKey(trackId, section);
    if (expanded) _collapsedTrackSectionKeys.delete(key);
    else _collapsedTrackSectionKeys.add(key);
}

export function toggleTrackSection(event, trackId, section) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (!['segments', 'waypoints'].includes(section)) return;
    const key = makeTrackSectionKey(trackId, section);
    if (_collapsedTrackSectionKeys.has(key)) _collapsedTrackSectionKeys.delete(key);
    else _collapsedTrackSectionKeys.add(key);
    renderGisTree();
}

export function renderGisTree() {
    // Marca sempre come dirty — verrà ridisegnato all'apertura del pannello
    _gisTreeDirty = true;
    if (!isGisTreeVisible()) return;
    clearTimeout(_gisTreeTimer);
    _gisTreeTimer = setTimeout(_doRenderGisTree, 100);
}

// Forza un rendering immediato (chiamato quando l'utente apre il pannello)
export function flushGisTreeIfDirty() {
    if (!_gisTreeDirty) return;
    clearTimeout(_gisTreeTimer);
    _doRenderGisTree();
}

function _doRenderGisTree() {
    _gisTreeDirty = false;
    const container = document.getElementById('gis-file-tree');
    normalizeTreeSelection();
    pruneCollapsedActiveTracks();
    const offroadJobsHtml = renderOffroadJobsHtml();
    if (tracks.length === 0 && !offroadJobsHtml) {
        container.innerHTML = `
          <div class="text-center py-6 text-gray-500 text-xs italic">
            Nessuna traccia o waypoint caricati in memoria.
          </div>`;
        return;
    }

    let html = offroadJobsHtml;

    if (tracks.length > 0) {
        html += `<div class="space-y-2">
          <span class="text-[10px] text-gray-400 font-bold uppercase tracking-wider flex items-center gap-1">
            <i data-lucide="folder-tree" class="w-3.5 h-3.5"></i> File GPX in mappa (${tracks.length})
          </span>`;

        tracks.forEach((track, trackIndex) => {
            const isActive = track.id === activeTrackId;
            const isSelected = selectionHas(makeTreeKey('track', track.id));
            const isExpanded = isTrackExpanded(track.id, isActive);
            const areSegmentsExpanded = isTrackSectionExpanded(track.id, 'segments');
            const areWaypointsExpanded = isTrackSectionExpanded(track.id, 'waypoints');
            const segmentCount = track.segments.length;
            const pointCount = track.segments.reduce((sum, seg) => sum + seg.points.length, 0);
            const isFirst = trackIndex === 0;
            const isLast = trackIndex === tracks.length - 1;

            // Paginazione righe: mostra al massimo N segmenti/waypoint per volta.
            // Il limite viene esteso automaticamente per includere il segmento attivo.
            let segRenderLimit = _gisTreeSegmentLimits.get(track.id) || GIS_TREE_PAGE_SIZE;
            if (isActive && activeSegmentId) {
                const activeSegIndex = track.segments.findIndex(seg => seg.id === activeSegmentId);
                if (activeSegIndex >= segRenderLimit) segRenderLimit = activeSegIndex + 1;
            }
            const visibleSegments = track.segments.length > segRenderLimit
                ? track.segments.slice(0, segRenderLimit)
                : track.segments;
            const hiddenSegmentCount = track.segments.length - visibleSegments.length;
            const wpRenderLimit = _gisTreeWaypointLimits.get(track.id) || GIS_TREE_PAGE_SIZE;
            const visibleWaypoints = track.waypoints.length > wpRenderLimit
                ? track.waypoints.slice(0, wpRenderLimit)
                : track.waypoints;
            const hiddenWaypointCount = track.waypoints.length - visibleWaypoints.length;
            html += `
            <div class="gis-track-card group bg-gray-900/95 border ${isSelected ? 'border-cyan-400/80 bg-cyan-950/20' : (isActive ? 'border-blue-500/60 shadow-blue-950/30' : 'border-gray-800')} rounded-xl overflow-hidden shadow-lg"
                 onclick="handleTrackTreeClick(event, '${track.id}', true)"
                 oncontextmenu="handleTrackContextMenu(event, '${track.id}')"
                 onpointerdown="handleTrackPointerDown(event, '${track.id}')"
                 onpointerup="clearTrackLongPress()"
                 onpointercancel="clearTrackLongPress()"
                 onpointerleave="clearTrackLongPress()"
                 ondragover="handleGisDragOver(event)"
                 ondrop="handleGisDrop(event, 'track', '${track.id}')">
              <div class="flex items-stretch">
                <div class="gis-track-color-strip w-1.5" style="background-color: ${track.color || '#3b82f6'}"></div>
                <div class="gis-track-body flex-1 min-w-0 p-2.5 space-y-2">
                  <div class="gis-track-header flex items-start justify-between gap-2">
                    <div class="flex items-start gap-2 min-w-0 flex-1">
                      <button draggable="true"
                              ondragstart="handleGisDragStart(event, 'track', '${track.id}')"
                              ondragend="handleGisDragEnd(event)"
                              class="gis-track-drag mt-0.5 text-gray-600 hover:text-gray-300 cursor-grab active:cursor-grabbing"
                              title="Trascina per riordinare questo file GPX">
                        <i data-lucide="grip-vertical" class="w-4 h-4"></i>
                      </button>
                      <div class="gis-track-title-block flex-1 min-w-0 cursor-pointer">
                        <div class="flex items-center gap-1.5 min-w-0">
                          <i data-lucide="${isExpanded ? 'chevron-down' : 'chevron-right'}" class="w-3 h-3 ${isActive ? 'text-blue-300' : 'text-gray-500'} shrink-0"></i>
                          <i data-lucide="file-map" class="w-3.5 h-3.5 ${isActive ? 'text-blue-300' : 'text-gray-500'} shrink-0"></i>
                          <span id="track-name-${track.id}" data-track-name-id="${track.id}" role="button" tabindex="0" contenteditable="false"
                                class="track-name-label block text-xs font-bold ${track.visible === false ? 'text-gray-500 line-through' : 'text-white'} border-b border-transparent focus:border-blue-500 focus:outline-none min-w-0 flex-1 truncate cursor-pointer select-none">${escapeXml(track.name)}</span>
                        </div>
                        <div id="track-meta-${track.id}" class="gis-track-meta text-[10px] text-gray-500 mt-0.5 pl-5">File ${trackIndex + 1} · ${segmentCount} segmenti · ${pointCount} pt · ${track.waypoints.length} wp · ${track.width || 3}px</div>
                      </div>
                    </div>
                    <div class="gis-track-actions flex items-center gap-1.5 shrink-0">
                      <button onclick="moveTrackUp('${track.id}')" ${isFirst ? 'disabled class="opacity-20 cursor-not-allowed text-gray-700"' : 'class="text-gray-400 hover:text-white"'} title="Sposta su"><i data-lucide="chevron-up" class="w-3.5 h-3.5"></i></button>
                      <button onclick="moveTrackDown('${track.id}')" ${isLast ? 'disabled class="opacity-20 cursor-not-allowed text-gray-700"' : 'class="text-gray-400 hover:text-white"'} title="Sposta giù"><i data-lucide="chevron-down" class="w-3.5 h-3.5"></i></button>
                      <button onclick="toggleTrackVisibility('${track.id}')" class="text-gray-400 hover:text-white" title="Mostra/Nascondi File"><i data-lucide="${track.visible === false ? 'eye-off' : 'eye'}" class="w-3.5 h-3.5"></i></button>
                      <input type="color" value="${track.color}" onchange="changeTrackColor('${track.id}', this.value)" class="w-4 h-4 rounded border-0 bg-transparent cursor-pointer" title="Colore traccia">
                      <button onclick="handleTrackContextMenu(event, '${track.id}')" class="text-gray-500 hover:text-white" title="Menu file"><i data-lucide="more-vertical" class="w-3.5 h-3.5"></i></button>
                      <button onclick="deleteTrack('${track.id}')" class="text-gray-500 hover:text-red-400" title="Elimina file"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                    </div>
                  </div>

                  ${isExpanded ? `
                  <div class="gis-track-details ml-5 pl-3 border-l border-gray-800/90 space-y-1"
                       ondragover="handleGisDragOver(event)"
                       ondrop="handleGisDrop(event, 'track-segments', '${track.id}')">
                    <div class="flex items-center justify-between pb-0.5">
                      <button type="button"
                              data-gis-section-toggle="true"
                              data-section-track-id="${track.id}"
                              data-section-kind="segments"
                              class="gis-section-toggle flex items-center justify-start gap-1 text-left w-full text-[9px] text-gray-600 hover:text-gray-300 font-bold uppercase tracking-wider bg-transparent border-0 p-0 min-h-0">
                        <i data-lucide="${areSegmentsExpanded ? 'chevron-down' : 'chevron-right'}" class="w-3 h-3"></i>
                        <i data-lucide="git-branch" class="w-3 h-3"></i> Segmenti
                      </button>
                    </div>
                    ${areSegmentsExpanded ? visibleSegments.map((seg, segIndex) => {
                        const isSegActive = seg.id === activeSegmentId;
                        const isSegSelected = selectionHas(makeTreeKey('segment', track.id, seg.id));
                        return `
                        <div class="gis-segment-row flex items-center justify-between text-xs py-1.5 px-1.5 rounded border ${isSegSelected ? 'bg-cyan-950/45 text-cyan-200 border-cyan-700/70' : (isSegActive ? 'bg-blue-950/40 text-blue-300 border-blue-900/60' : 'text-gray-400 border-transparent hover:bg-gray-800/45 hover:border-gray-800')} ${seg.visible === false ? 'opacity-55' : ''}"
                             onclick="handleSegmentTreeClick(event, '${track.id}', '${seg.id}', true)"
                             oncontextmenu="handleSegmentContextMenu(event, '${track.id}', '${seg.id}')"
                             onpointerdown="handleSegmentPointerDown(event, '${track.id}', '${seg.id}')"
                             onpointerup="clearTrackLongPress()"
                             onpointercancel="clearTrackLongPress()"
                             onpointerleave="clearTrackLongPress()"
                             ondragover="handleGisDragOver(event)"
                             ondrop="handleGisDrop(event, 'segment', '${track.id}', '${seg.id}')">
                          <div class="flex items-center gap-1.5 min-w-0 flex-1 cursor-pointer">
                            <button draggable="true"
                                    ondragstart="handleGisDragStart(event, 'segment', '${track.id}', '${seg.id}')"
                                    ondragend="handleGisDragEnd(event)"
                                    class="text-gray-600 hover:text-gray-300 cursor-grab active:cursor-grabbing shrink-0"
                                    title="Trascina per riordinare o spostare questo segmento">
                              <i data-lucide="grip-vertical" class="w-3.5 h-3.5"></i>
                            </button>
                            <i data-lucide="milestone" class="w-3 h-3 text-gray-500 shrink-0"></i>
                            <input id="segment-name-${seg.id}" type="text" value="${escapeXml(seg.name)}" onchange="renameSegment('${track.id}', '${seg.id}', this.value)" onclick="event.stopPropagation()" class="bg-transparent text-[11px] border-b border-transparent hover:border-gray-700 focus:border-blue-500 focus:outline-none flex-1 min-w-0 ${seg.visible === false ? 'line-through' : ''}">
                          </div>
                          <div class="flex items-center gap-1.5 shrink-0">
                            <span id="seg-pt-count-${seg.id}" class="text-[10px] text-gray-500 whitespace-nowrap">${seg.points.length.toLocaleString('it-IT')} pt</span>
                            <button onclick="toggleSegmentVisibility('${track.id}', '${seg.id}')" class="text-gray-500 hover:text-white" title="Mostra/Nascondi Segmento"><i data-lucide="${seg.visible === false ? 'eye-off' : 'eye'}" class="w-3 h-3"></i></button>
                            <button onclick="deleteSegment('${track.id}', '${seg.id}')" class="text-gray-600 hover:text-red-400" title="Elimina segmento"><i data-lucide="x" class="w-3 h-3"></i></button>
                          </div>
                        </div>
                      `;
                    }).join('') + (hiddenSegmentCount > 0 ? `
                    <button onclick="event.stopPropagation(); showMoreGisSegments('${track.id}')" class="text-[10px] text-cyan-400 hover:text-cyan-300 flex items-center gap-0.5 pt-1 pl-1">
                      <i data-lucide="chevrons-down" class="w-3 h-3"></i> Mostra altri ${Math.min(GIS_TREE_PAGE_SIZE, hiddenSegmentCount)} segmenti (${hiddenSegmentCount} nascosti)
                    </button>` : '') + `
                    <button onclick="addNewSegmentToTrack('${track.id}')" class="text-[10px] text-blue-400 hover:text-blue-300 flex items-center gap-0.5 pt-1 pl-1">
                      <i data-lucide="plus" class="w-3 h-3"></i> Aggiungi Segmento
                    </button>` : ''}
                  </div>` + (track.waypoints.length > 0 ? `
                  <div class="gis-waypoints-block ml-5 pl-3 border-l border-gray-800/60 pt-1">
                    <div class="flex items-center justify-between mb-1">
                      <button type="button"
                              data-gis-section-toggle="true"
                              data-section-track-id="${track.id}"
                              data-section-kind="waypoints"
                              class="gis-section-toggle flex flex-1 min-w-0 items-center justify-start gap-1 text-left text-[9px] text-gray-500 hover:text-gray-300 font-bold uppercase tracking-wider bg-transparent border-0 p-0 min-h-0">
                        <i data-lucide="${areWaypointsExpanded ? 'chevron-down' : 'chevron-right'}" class="w-3 h-3"></i>
                        <i data-lucide="map-pinned" class="w-3 h-3"></i> Waypoints (${track.waypoints.length})
                      </button>
                      <button onclick="event.stopPropagation(); toggleAllWaypointsVisibility('${track.id}')" class="text-gray-500 hover:text-white" title="Mostra/Nascondi Gruppo Waypoint"><i data-lucide="${track.waypointsVisible === false ? 'eye-off' : 'eye'}" class="w-3.5 h-3.5"></i></button>
                    </div>
                    ${areWaypointsExpanded ? `<div class="${track.waypointsVisible === false ? 'hidden' : 'space-y-1'}">
                      ${visibleWaypoints.map(wp => {
                          const tipoWp = trovaTipoWaypoint(wp.symbol);
                          return `
                          <div class="gis-waypoint-row flex items-center justify-between gap-1 text-xs hover:bg-gray-800/40 p-1 rounded transition-all ${wp.visible === false ? 'opacity-50' : ''}">
                            <div class="flex items-center gap-1.5 min-w-0">
                              <span class="gis-waypoint-symbol" style="--wp-color: ${tipoWp.colore}" title="${escapeXml(tipoWp.etichetta)}">${escapeXml(tipoWp.sigla)}</span>
                              <span class="font-medium text-gray-200 truncate cursor-pointer" onclick="zoomToWaypoint(${wp.lon}, ${wp.lat})">${escapeXml(wp.name)}</span>
                              <span class="text-[9px] text-gray-500">${wp.ele}m</span>
                            </div>
                            <div class="flex items-center gap-1">
                              <button onclick="toggleWaypointVisibility('${track.id}', '${wp.id}')" class="text-gray-500 hover:text-white" title="Mostra/Nascondi"><i data-lucide="${wp.visible === false ? 'eye-off' : 'eye'}" class="w-3 h-3"></i></button>
                              <button onclick="openWaypointEditor('${track.id}', '${wp.id}')" class="text-gray-500 hover:text-white"><i data-lucide="edit-3" class="w-3 h-3"></i></button>
                              <button onclick="deleteWaypoint('${track.id}', '${wp.id}')" class="text-gray-500 hover:text-red-400"><i data-lucide="trash" class="w-3 h-3"></i></button>
                            </div>
                          </div>
                      `;
                      }).join('')}
                      ${hiddenWaypointCount > 0 ? `
                      <button onclick="event.stopPropagation(); showMoreGisWaypoints('${track.id}')" class="text-[10px] text-cyan-400 hover:text-cyan-300 flex items-center gap-0.5 pt-1 pl-1">
                        <i data-lucide="chevrons-down" class="w-3 h-3"></i> Mostra altri ${Math.min(GIS_TREE_PAGE_SIZE, hiddenWaypointCount)} waypoint (${hiddenWaypointCount} nascosti)
                      </button>` : ''}
                    </div>` : ''}
                  </div>
                ` : '') : ''}
                </div>
              </div>
            </div>`;
        });
        html += `</div>`;
    }
    container.innerHTML = html;
    refreshLucideIcons();
    container.querySelectorAll('[data-track-name-id]').forEach(nameEl => {
        const trackId = nameEl.dataset.trackNameId;
        nameEl.addEventListener('click', event => handleTrackNameClick(event, trackId));
        nameEl.addEventListener('dblclick', event => {
            event.preventDefault();
            openTrackNameEditor(trackId);
        });
        nameEl.addEventListener('pointerdown', event => handleTrackNamePointerDown(event, trackId));
        nameEl.addEventListener('pointerup', clearTrackNameLongPress);
        nameEl.addEventListener('pointercancel', clearTrackNameLongPress);
        nameEl.addEventListener('pointerleave', clearTrackNameLongPress);
        nameEl.addEventListener('keydown', event => handleTrackNameKeydown(event, trackId));
        nameEl.addEventListener('blur', event => finishTrackNameEditor(trackId, event.currentTarget.textContent));
    });
    container.querySelectorAll('[data-gis-section-toggle]').forEach(button => {
        button.addEventListener('click', event => {
            toggleTrackSection(event, button.dataset.sectionTrackId, button.dataset.sectionKind);
        });
    });
}

function getDropPosition(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

function finishGisTreeMove(message) {
    if (_saveHistoryState) _saveHistoryState();
    if (_updateMapData) _updateMapData(true);
    updateActiveTracksHeader();
    renderGisTree();
    renderLocalGpxLibrary();
    showToast(message, 'success');
}

export function handleGisDragStart(event, type, trackId, segId = null) {
    _gisDragPayload = { type, trackId, segId };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', JSON.stringify(_gisDragPayload));
}

export function handleGisDragOver(event) {
    if (!_gisDragPayload) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
}

export function handleGisDragEnd() {
    _gisDragPayload = null;
}

export function handleGisDrop(event, targetType, targetTrackId, targetSegId = null) {
    if (!_gisDragPayload) return;

    if (_gisDragPayload.type === 'track' && targetType !== 'track') return;

    event.preventDefault();
    event.stopPropagation();

    if (_gisDragPayload.type === 'track' && targetType === 'track') {
        const fromIndex = tracks.findIndex(track => track.id === _gisDragPayload.trackId);
        const targetIndex = tracks.findIndex(track => track.id === targetTrackId);
        if (fromIndex === -1 || targetIndex === -1 || fromIndex === targetIndex) return;

        let toIndex = targetIndex + (getDropPosition(event) === 'after' ? 1 : 0);
        if (fromIndex < toIndex) toIndex--;
        tracks.splice(toIndex, 0, tracks.splice(fromIndex, 1)[0]);
        setActiveTrackId(_gisDragPayload.trackId);
        const activeTrack = tracks.find(track => track.id === _gisDragPayload.trackId);
        setActiveSegmentId(activeTrack?.segments[0]?.id || null);
        _gisDragPayload = null;
        finishGisTreeMove("Ordine dei file aggiornato");
        return;
    }

    if (_gisDragPayload.type !== 'segment') return;

    const sourceTrack = tracks.find(track => track.id === _gisDragPayload.trackId);
    const targetTrack = tracks.find(track => track.id === targetTrackId);
    if (!sourceTrack || !targetTrack) return;

    if (
        targetType === 'segment' &&
        sourceTrack.id === targetTrack.id &&
        _gisDragPayload.segId === targetSegId
    ) {
        _gisDragPayload = null;
        return;
    }

    const sourceIndex = sourceTrack.segments.findIndex(seg => seg.id === _gisDragPayload.segId);
    if (sourceIndex === -1) return;

    const [segment] = sourceTrack.segments.splice(sourceIndex, 1);
    let targetIndex = targetTrack.segments.length;

    if (targetType === 'segment' && targetSegId) {
        targetIndex = targetTrack.segments.findIndex(seg => seg.id === targetSegId);
        if (targetIndex === -1) targetIndex = targetTrack.segments.length;
        else if (getDropPosition(event) === 'after') targetIndex++;
    }

    if (sourceTrack.id === targetTrack.id && sourceIndex < targetIndex) targetIndex--;
    targetTrack.segments.splice(Math.max(0, targetIndex), 0, segment);
    setActiveTrackId(targetTrack.id);
    setActiveSegmentId(segment.id);
    _gisDragPayload = null;
    finishGisTreeMove(sourceTrack.id === targetTrack.id ? "Segmento riordinato" : "Segmento spostato in un altro file");
}

export function setTrackActive(trackId, shouldFocus = false) {
    const track = tracks.find(tr => tr.id === trackId);
    if (!track) return;

    const wasActive = activeTrackId === trackId;
    setActiveTrackId(trackId);
    if (!wasActive) setTrackExpanded(trackId, true);
    if (track.segments.length > 0) {
        setActiveSegmentId(track.segments[track.segments.length - 1].id);
    }
    if (shouldFocus) focusTrackOnMap(track);
    if (_updateMapData) _updateMapData();
    updateActiveTracksHeader();
    if (!wasActive) renderGisTree();
    schedulePersistAppSession();
}

export function renameTrack(trackId, newName) {
    const t = tracks.find(tr => tr.id === trackId);
    const cleanName = String(newName || '').trim();
    if (t && cleanName && t.name !== cleanName) {
        t.name = cleanName;
        if (_saveHistoryState) _saveHistoryState();
        updateActiveTracksHeader();
        renderGisTree();
    }
}

export function changeTrackColor(trackId, newColor) {
    const t = tracks.find(tr => tr.id === trackId);
    if (t) {
        t.color = newColor;
        if (_saveHistoryState) _saveHistoryState();
        if (_updateMapData) _updateMapData();
        renderGisTree();
    }
}

export function changeTrackWidth(trackId, newWidth) {
    const t = tracks.find(tr => tr.id === trackId);
    const width = Math.max(1, Math.min(12, Number(newWidth) || 3));
    if (t && t.width !== width) {
        t.width = width;
        if (_saveHistoryState) _saveHistoryState();
        if (_updateMapData) _updateMapData();
        renderGisTree();
    }
}

export function toggleTrackVisibility(trackId) {
    const t = tracks.find(tr => tr.id === trackId);
    if (t) {
        t.visible = t.visible === false ? true : false;
        if (_saveHistoryState) _saveHistoryState();
        if (_updateMapData) _updateMapData();
        renderGisTree();
    }
}

export function toggleAllWaypointsVisibility(trackId) {
    const track = tracks.find(t => t.id === trackId);
    if (track) {
        track.waypointsVisible = track.waypointsVisible === false ? true : false;
        if (_saveHistoryState) _saveHistoryState();
        if (_updateMapData) _updateMapData();
    }
}

export function toggleWaypointVisibility(trackId, wpId) {
    const track = tracks.find(t => t.id === trackId);
    if (track) {
        const wp = track.waypoints.find(w => w.id === wpId);
        if (wp) {
            wp.visible = wp.visible === false ? true : false;
            if (_saveHistoryState) _saveHistoryState();
            if (_updateMapData) _updateMapData();
        }
    }
}

export function toggleSegmentVisibility(trackId, segId) {
    const t = tracks.find(tr => tr.id === trackId);
    if (t) {
        const s = t.segments.find(sg => sg.id === segId);
        if (s) {
            s.visible = s.visible === false ? true : false;
            if (_saveHistoryState) _saveHistoryState();
            if (_updateMapData) _updateMapData();
        }
    }
}

export function deleteTrack(trackId) {
    const trackToDelete = tracks.find(t => t.id === trackId);
    const remainingTracks = tracks.filter(t => t.id !== trackId);
    setTracks(remainingTracks);
    _collapsedActiveTrackIds.delete(trackId);
    if (activeTrackId === trackId) {
        const nextTrack = remainingTracks.length > 0 ? remainingTracks[0] : null;
        setActiveTrackId(nextTrack ? nextTrack.id : null);
        setActiveSegmentId(nextTrack && nextTrack.segments.length > 0 ? nextTrack.segments[0].id : null);
        if (nextTrack) setTrackExpanded(nextTrack.id, true);
    }
    if (trackToDelete?.localFileId) {
        deleteStoredTrack(trackToDelete.localFileId).catch(err => console.error(err));
    }
    if (_saveHistoryState) _saveHistoryState();
    if (_updateMapData) _updateMapData();
    updateActiveTracksHeader();
    renderLocalGpxLibrary();
}

export function addNewSegmentToTrack(trackId) {
    const t = tracks.find(tr => tr.id === trackId);
    if (t) {
        const newSegId = 'seg_' + Date.now();
        t.segments.push({
            id: newSegId,
            name: `Tracciato ${t.segments.length + 1}`,
            points: [],
            visible: true
        });
        setActiveSegmentId(newSegId);
        setActiveTrackId(trackId);
        setTrackExpanded(trackId, true);
        setTrackSectionExpanded(trackId, 'segments', true);

        if (_saveHistoryState) _saveHistoryState();
        if (_updateMapData) _updateMapData();
        showToast("Nuovo sotto-tracciato creato!", "success");
    }
}

export function renameSegment(trackId, segId, newName) {
    const t = tracks.find(tr => tr.id === trackId);
    if (t) {
        const s = t.segments.find(sg => sg.id === segId);
        if (s) {
            s.name = newName;
            if (_saveHistoryState) _saveHistoryState();
            renderGisTree();
        }
    }
}

export function setSegmentActive(trackId, segId, shouldFocus = false) {
    setActiveTrackId(trackId);
    setActiveSegmentId(segId);
    setTrackExpanded(trackId, true);
    setTrackSectionExpanded(trackId, 'segments', true);
    if (shouldFocus) focusSegmentOnMap(trackId, segId);
    if (_updateMapData) _updateMapData();
    updateActiveTracksHeader();
    renderGisTree();
    schedulePersistAppSession();
}

export function deleteSegment(trackId, segId) {
    const t = tracks.find(tr => tr.id === trackId);
    if (t) {
        t.segments = t.segments.filter(sg => sg.id !== segId);
        if (activeSegmentId === segId) {
            setActiveSegmentId(t.segments.length > 0 ? t.segments[0].id : null);
        }
    }
    if (_saveHistoryState) _saveHistoryState();
    if (_updateMapData) _updateMapData();
}

export function zoomToWaypoint(lon, lat) {
    if (!mapLoaded) return;
    map.flyTo({ center: [lon, lat], zoom: 15, pitch: 45 });
}

export function deleteWaypoint(trackId, wpId) {
    const track = tracks.find(t => t.id === trackId);
    if (track) {
        track.waypoints = track.waypoints.filter(w => w.id !== wpId);
        if (_saveHistoryState) _saveHistoryState();
        if (_updateMapData) _updateMapData();
        showToast("Waypoint rimosso", "info");
    }
}

export function updateActiveTracksHeader() {
    const list = document.getElementById('active-tracks-list');
    if (tracks.length === 0) {
        list.innerHTML = `<span class="text-gray-500 italic whitespace-nowrap">Nessuna traccia creata</span>`;
        return;
    }

    list.innerHTML = tracks.map(t => {
        const isActive = t.id === activeTrackId;
        return `
          <div onclick="setTrackActive('${t.id}', true)" class="cursor-pointer flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold whitespace-nowrap transition-all ${isActive ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-400 hover:text-white'} ${t.visible === false ? 'opacity-50' : ''}">
            <span class="w-2 h-2 rounded-full" style="background-color: ${t.color}"></span>
            <span class="${t.visible === false ? 'line-through' : ''}">${t.name}</span>
          </div>
        `;
    }).join('');
}

export async function searchNominatim() {
    const q = document.getElementById('input-search').value;
    if (!q) return;

    showToast("Ricerca in corso...", "info");
    trackAnalyticsEvent('richiesta_nominatim', { queryLength: q.length }).catch(err => console.warn(err));
    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`);
        const data = await res.json();
        if (data && data.length > 0) {
            const loc = data[0];
            map.flyTo({
                center: [parseFloat(loc.lon), parseFloat(loc.lat)],
                zoom: 12,
                pitch: 0
            });
            showToast(`Trovato: ${loc.display_name}`, "success");
        } else {
            showToast("Località non trovata", "error");
        }
    } catch {
        showToast("Errore di connessione al servizio di ricerca", "error");
    }
}

function updateCursorCoordinates(lngLat) {
    const el = document.getElementById('cursor-coordinates');
    if (!el || !lngLat) return;
    el.textContent = `${lngLat.lat.toFixed(6)}, ${lngLat.lng.toFixed(6)}`;
}

export function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');

    let accent = 'bg-gray-500';
    if (type === 'success') accent = 'bg-emerald-400';
    if (type === 'error') accent = 'bg-red-400';
    if (type === 'info') accent = 'bg-sky-400';

    // NB: usare solo opacità Tailwind valide (multipli di 5): /88 non esiste e
    // renderebbe il toast trasparente e illeggibile sulla mappa chiara.
    toast.className = `bg-gray-950/90 border border-gray-800 text-gray-300 px-2.5 py-1.5 rounded-md shadow-lg text-[11px] font-medium flex items-center gap-2 transform -translate-x-2 opacity-0 transition-all duration-200`;
    toast.innerHTML = `
        <div class="w-1 h-1 rounded-full ${accent} shrink-0"></div>
        <span class="leading-snug">${message}</span>
      `;

    container.appendChild(toast);

    setTimeout(() => {
        toast.className = toast.className.replace('-translate-x-2 opacity-0', 'translate-x-0 opacity-100');
    }, 50);

    // Esiti importanti (successo/errore) restano visibili più a lungo: spesso
    // arrivano al termine di operazioni lunghe e l'utente non guarda il toast.
    const duration = (type === 'success' || type === 'error') ? 5500 : 2800;
    setTimeout(() => {
        toast.className = toast.className.replace('translate-x-0 opacity-100', '-translate-x-2 opacity-0');
        setTimeout(() => {
            toast.remove();
        }, 220);
    }, duration);
}

export function moveTrackUp(trackId) {
    closeTrackContextMenu();
    const index = tracks.findIndex(t => t.id === trackId);
    if (index <= 0) return;

    const temp = tracks[index];
    tracks[index] = tracks[index - 1];
    tracks[index - 1] = temp;

    finishGisTreeMove("Traccia spostata in alto");
}

export function moveTrackDown(trackId) {
    closeTrackContextMenu();
    const index = tracks.findIndex(t => t.id === trackId);
    if (index === -1 || index >= tracks.length - 1) return;

    const temp = tracks[index];
    tracks[index] = tracks[index + 1];
    tracks[index + 1] = temp;

    finishGisTreeMove("Traccia spostata in basso");
}

export function openMergeTracksModal(trackId) {
    closeTrackContextMenu();
    const sourceTrack = tracks.find(t => t.id === trackId);
    if (!sourceTrack) return;

    const otherTracks = tracks.filter(t => t.id !== trackId);
    if (otherTracks.length === 0) {
        showToast("Nessun'altra traccia disponibile con cui effettuare l'unione", "error");
        return;
    }

    const modal = document.createElement('div');
    modal.id = 'dynamic-merge-modal';
    modal.className = 'fixed inset-0 bg-black/70 backdrop-blur-sm z-[100000] flex items-center justify-center p-4';

    let optionsHtml = otherTracks.map(t => `<option value="${t.id}">${escapeXml(t.name)}</option>`).join('');

    modal.innerHTML = `
        <div class="bg-gray-950 border border-gray-800 p-5 rounded-2xl shadow-2xl space-y-4 w-full max-w-sm text-gray-200">
            <h3 class="font-bold text-sm flex items-center gap-2 border-b border-gray-800 pb-2.5">
                <i data-lucide="git-merge" class="w-4 h-4 text-blue-400"></i> UNISCI TRACCE
            </h3>
            <p class="text-xs text-gray-400">
                Stai per unire la traccia <strong class="text-white">${escapeXml(sourceTrack.name)}</strong> in un'altra traccia.
                I segmenti e waypoint verranno spostati nella traccia di destinazione e questa traccia verrà rimossa.
            </p>
            <div class="space-y-1">
                <label class="text-[10px] text-gray-400 uppercase font-semibold">Seleziona traccia di destinazione</label>
                <select id="merge-target-select" class="w-full bg-gray-900 border border-gray-800 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500">
                    ${optionsHtml}
                </select>
            </div>
            <div class="flex items-center justify-end gap-2 pt-2">
                <button id="btn-merge-cancel" class="px-3 py-1.5 rounded-lg text-xs font-semibold text-gray-400 hover:text-white hover:bg-gray-800 transition-all">
                    Annulla
                </button>
                <button id="btn-merge-confirm" class="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 transition-all flex items-center gap-1">
                    <i data-lucide="git-merge" class="w-3.5 h-3.5"></i> Unisci
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    refreshLucideIcons();

    modal.querySelector('#btn-merge-cancel').onclick = () => {
        modal.remove();
    };

    modal.querySelector('#btn-merge-confirm').onclick = () => {
        const targetId = modal.querySelector('#merge-target-select').value;
        modal.remove();
        mergeTwoTracks(sourceTrack.id, targetId);
    };
}

export function mergeTwoTracks(sourceId, targetId) {
    const sourceTrack = tracks.find(t => t.id === sourceId);
    const targetTrack = tracks.find(t => t.id === targetId);
    if (!sourceTrack || !targetTrack) return;

    // Copy segments
    if (sourceTrack.segments) {
        sourceTrack.segments.forEach(seg => {
            targetTrack.segments.push({
                ...seg,
                id: uid('seg')
            });
        });
    }
    // Copy waypoints
    if (sourceTrack.waypoints) {
        sourceTrack.waypoints.forEach(wp => {
            targetTrack.waypoints.push({
                ...wp,
                id: uid('wp')
            });
        });
    }

    // Remove source track
    setTracks(tracks.filter(t => t.id !== sourceTrack.id));
    _collapsedActiveTrackIds.delete(sourceTrack.id);

    setActiveTrackId(targetTrack.id);
    if (targetTrack.segments.length > 0) {
        setActiveSegmentId(targetTrack.segments[0].id);
    }
    setTrackExpanded(targetTrack.id, true);
    setTreeSelection([makeTreeKey('track', targetTrack.id)]);

    if (_saveHistoryState) _saveHistoryState();
    if (_updateMapData) _updateMapData();
    updateActiveTracksHeader();
    renderGisTree();
    renderLocalGpxLibrary();

    showToast(`Traccia "${sourceTrack.name}" unita in "${targetTrack.name}"!`, "success");
}

export function mergeSelectedTracks() {
    closeTrackContextMenu();
    const selectedTracks = getSelectedTracks();
    if (selectedTracks.length < 2) {
        showToast("Seleziona almeno due tracce per effettuare l'unione", "error");
        return;
    }

    // Sort selectedTracks by their index in tracks to keep order consistent
    selectedTracks.sort((a, b) => {
        return tracks.findIndex(t => t.id === a.id) - tracks.findIndex(t => t.id === b.id);
    });

    const targetTrack = selectedTracks[0];
    const tracksToMerge = selectedTracks.slice(1);

    tracksToMerge.forEach(sourceTrack => {
        // Copy segments
        if (sourceTrack.segments) {
            sourceTrack.segments.forEach(seg => {
                targetTrack.segments.push({
                    ...seg,
                    id: uid('seg')
                });
            });
        }
        // Copy waypoints
        if (sourceTrack.waypoints) {
            sourceTrack.waypoints.forEach(wp => {
                targetTrack.waypoints.push({
                    ...wp,
                    id: uid('wp')
                });
            });
        }

        // Remove source track
        setTracks(tracks.filter(t => t.id !== sourceTrack.id));
        _collapsedActiveTrackIds.delete(sourceTrack.id);
    });

    setActiveTrackId(targetTrack.id);
    if (targetTrack.segments.length > 0) {
        setActiveSegmentId(targetTrack.segments[0].id);
    }
    setTrackExpanded(targetTrack.id, true);
    setTreeSelection([makeTreeKey('track', targetTrack.id)]);

    if (_saveHistoryState) _saveHistoryState();
    if (_updateMapData) _updateMapData();
    updateActiveTracksHeader();
    renderGisTree();
    renderLocalGpxLibrary();

    showToast(`Tracce unite con successo in "${targetTrack.name}"!`, "success");
}

export function setupEvents() {
    document.getElementById('mobile-panel-backdrop').onclick = () => {
        closeOtherPanels(null);
        syncMobileBackdrop();
    };

    document.getElementById('btn-mobile-toolbar-toggle').onclick = () => {
        if (isCompactLayout()) {
            closeMainMenu();
            closeSidebar();
            closeStatsPanel();
            if (_disablePrintPlanning) _disablePrintPlanning();
            toggleMobileToolbar();
            syncMobileBackdrop();
        }
    };

    document.getElementById('btn-main-menu').onclick = () => {
        const p = document.getElementById('panel-main-menu');
        const willOpen = p.classList.contains('-translate-x-80');
        if (willOpen && isCompactLayout()) closeOtherPanels('main');
        else closeMobileToolbar();
        p.classList.toggle('-translate-x-80');
        syncMobileBackdrop();
    };
    document.getElementById('btn-close-main-menu').onclick = () => {
        closeMainMenu();
        syncMobileBackdrop();
    };

    document.getElementById('btn-open-sidebar-right').onclick = () => {
        const sb = document.getElementById('sidebar-tracks-right');
        const willOpen = sb.classList.contains('translate-x-96');
        if (willOpen && isCompactLayout()) closeOtherPanels('sidebar');
        else closeMobileToolbar();
        sb.classList.toggle('translate-x-96');
        // Se l'abbiamo appena aperto e ci sono modifiche pendenti, rendi ora
        if (!sb.classList.contains('translate-x-96')) {
            flushGisTreeIfDirty();
        }
        syncMobileBackdrop();
    };
    document.getElementById('btn-close-sidebar-right').onclick = () => {
        closeSidebar();
        syncMobileBackdrop();
    };

    document.getElementById('btn-close-bottom').onclick = () => {
        closeStatsPanel();
        syncMobileBackdrop();
    };

    document.getElementById('btn-toggle-stats').onclick = () => {
        const panel = document.getElementById('panel-bottom-stats');
        const btn = document.getElementById('btn-toggle-stats');
        const isOpen = !panel.classList.contains('translate-y-60');
        if (isOpen) {
            closeStatsPanel();
        } else {
            if (isCompactLayout()) closeOtherPanels('stats');
            else closeMobileToolbar();
            panel.classList.remove('translate-y-60');
            document.body.classList.add('stats-panel-open');
            btn.classList.add('bg-blue-600', 'text-white');
            btn.classList.remove('text-gray-300');
            document.getElementById('btn-mobile-stats')?.classList.add('bg-blue-600', 'text-white');
            // Forza un ricalcolo: il pannello era chiuso e abbiamo saltato i refresh
            forceUpdateStats();
        }
        syncMobileBackdrop();
    };

    document.getElementById('btn-mobile-stats').onclick = () => {
        closeMobileToolbar();
        document.getElementById('btn-toggle-stats').click();
    };

    document.getElementById('map-style-osm').onclick = () => _setBaseMap('osm');
    document.getElementById('map-style-sat').onclick = () => _setBaseMap('sat');
    document.getElementById('map-style-topo').onclick = () => _setBaseMap('topo');
    document.getElementById('map-style-acqua').onclick = () => _setBaseMap('acqua');
    document.getElementById('map-style-outdoor').onclick = () => _setBaseMap('outdoor');
    document.getElementById('toggle-hybrid').onchange = () => {
        if (currentStyle === 'sat') _setBaseMap('sat');
    };

    document.getElementById('toggle-hiking-trails').onchange = (e) => {
        if (!mapLoaded) return;
        const visible = e.target.checked ? 'visible' : 'none';
        map.setLayoutProperty('hiking-trails-layer', 'visibility', visible);
        schedulePersistAppSession();
        showToast(e.target.checked ? "Sentieri OSM Visibili" : "Sentieri OSM Nascosti", "success");
    };

    document.getElementById('toggle-mapillary').onchange = (e) => {
        if (_setMapillaryCoverageVisible) _setMapillaryCoverageVisible(e.target.checked);
        updateMapillaryToolbarButton();
    };

    document.getElementById('btn-save-mapillary-token').onclick = () => {
        const token = document.getElementById('input-mapillary-token').value;
        if (_configureMapillaryToken) _configureMapillaryToken(token);
        updateMapillaryToolbarButton();
        showToast(token.trim() ? "Token Mapillary salvato" : "Token Mapillary rimosso", "success");
    };

    document.getElementById('btn-clear-mapillary-token').onclick = () => {
        document.getElementById('input-mapillary-token').value = '';
        if (_configureMapillaryToken) _configureMapillaryToken('');
        updateMapillaryToolbarButton();
        showToast("Token Mapillary rimosso", "success");
    };

    document.getElementById('btn-close-mapillary-viewer').onclick = () => {
        if (_closeMapillaryViewer) _closeMapillaryViewer();
    };

    const viewMode2dButton = document.getElementById('view-mode-2d');
    const viewMode3dButton = document.getElementById('view-mode-3d');
    if (viewMode2dButton) viewMode2dButton.onclick = () => _setDimensionMode(false);
    if (viewMode3dButton) viewMode3dButton.onclick = () => _setDimensionMode(true);

    document.getElementById('btn-draw-track').onclick = () => {
        setIsDrawing(!isDrawing);
        setIsCutting(false);
        setIsBoxDeleting(false);
        setIsAddingWaypoint(false);
        _disablePrintPlanning();
        clearBoxDeleteSelection();

        const btn = document.getElementById('btn-draw-track');
        if (isDrawing) {
            btn.classList.add('bg-blue-600', 'text-white');
            showToast("Clicca sulla mappa per iniziare a tracciare", "info");
        } else {
            btn.classList.remove('bg-blue-600', 'text-white');
            if (_updateMapData) _updateMapData(true);
        }
        updateToolButtons();
        updateMapToolCursor();
    };

    const profiles = ['off', 'foot', 'bike', 'moto', 'car', 'water'];
    profiles.forEach(p => {
        document.getElementById(`snap-profile-${p}`).onclick = () => {
            _setSnapProfile(p);
        };
    });

    document.getElementById('btn-snap-toggle').onclick = () => {
        if (currentSnapProfile === 'off') {
            _setSnapProfile('foot');
        } else {
            _setSnapProfile('off');
        }
    };

    document.getElementById('btn-mapillary-layer').onclick = () => {
        const toggle = document.getElementById('toggle-mapillary');
        if (!toggle) return;
        toggle.checked = !toggle.checked;
        if (_setMapillaryCoverageVisible) _setMapillaryCoverageVisible(toggle.checked);
        updateMapillaryToolbarButton();
    };

    ['btn-device-location-main', 'btn-device-location'].forEach(id => {
        const btnDeviceLocation = document.getElementById(id);
        if (!btnDeviceLocation) return;
        btnDeviceLocation.onclick = () => {
            const wasActive = Boolean(_lastDeviceLocationStatus.active || _lastDeviceLocationStatus.waiting);
            const willActivateLocation = !_lastDeviceLocationStatus.active && !_lastDeviceLocationStatus.waiting;
            if (willActivateLocation) {
                setDeviceLocationPermissionEnabled(true);
                requestDashboardSensorPermissionsFromGesture();
            }
            const active = _toggleDeviceLocation ? _toggleDeviceLocation() : false;
            if (wasActive && !active) {
                setDeviceLocationPermissionEnabled(false);
                disableDeviceSensorPermissions();
            }
            if (active && isCompactLayout()) {
                closeMobileToolbar();
                syncMobileBackdrop();
            }
        };
    });
    if (_setDeviceLocationStatusHandler) {
        _setDeviceLocationStatusHandler(updateDeviceLocationToolbarButton);
    }
    updateDeviceLocationToolbarButton();
    document.getElementById('btn-location-permission')?.addEventListener('click', () => {
        const locationActive = Boolean(_lastDeviceLocationStatus.active || _lastDeviceLocationStatus.waiting);
        if (locationActive) {
            if (_stopDeviceLocation) _stopDeviceLocation('manual');
            else _toggleDeviceLocation?.();
            setDeviceLocationPermissionEnabled(false);
            disableDeviceSensorPermissions();
            scheduleDevicePermissionRefresh(true);
            setTimeout(() => scheduleDevicePermissionRefresh(true), 1200);
            return;
        }
        setDeviceLocationPermissionEnabled(true);
        requestDashboardSensorPermissionsFromGesture();
        _requestDeviceLocationPermission?.();
        scheduleDevicePermissionRefresh(true);
        setTimeout(() => scheduleDevicePermissionRefresh(true), 1200);
    });
    document.getElementById('btn-orientation-permission')?.addEventListener('click', async() => {
        const orientationState = _lastDeviceLocationStatus.orientationPermission || getOrientationPermissionState();
        if (orientationState === 'granted') {
            _setDeviceOrientationEnabled?.(false);
            syncDeviceDashboardSensors();
            renderDeviceDashboard();
            showToast("Orientamento disattivato", "info");
            scheduleDevicePermissionRefresh(true);
            return;
        }
        await requestDashboardOrientationPermission({ forcePrompt: true });
        scheduleDevicePermissionRefresh(true);
    });
    document.getElementById('btn-motion-permission')?.addEventListener('click', async() => {
        const motionState = getDashboardMotionPermissionState();
        if (motionState === 'granted') {
            setDashboardMotionEnabled(false);
            showToast("Vibrazioni disattivate", "info");
            scheduleDevicePermissionRefresh(true);
            return;
        }
        await requestDashboardMotionPermission();
        scheduleDevicePermissionRefresh(true);
    });
    scheduleDevicePermissionRefresh(true);

    const btnDeviceRecording = document.getElementById('btn-device-recording');
    if (btnDeviceRecording) {
        btnDeviceRecording.onclick = () => handleDeviceRecordingButtonClick('toolbar');
    }
    document.getElementById('recording-status-chip')?.addEventListener('click', () => handleDeviceRecordingButtonClick('chip'));
    document.getElementById('recording-status-chip')?.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        handleDeviceRecordingButtonClick('chip');
    });
    document.getElementById('btn-recording-action-pause')?.addEventListener('click', () => {
        const status = _getDeviceRecordingStatus ? _getDeviceRecordingStatus() : { state: 'idle' };
        if (status.state === 'paused') _resumeDeviceRecording?.();
        else _pauseDeviceRecording?.();
        closeRecordingActionModal();
    });
    document.getElementById('btn-recording-action-stop')?.addEventListener('click', () => {
        _pauseDeviceRecording?.();
        closeRecordingActionModal();
        openRecordingSaveModal();
    });
    document.getElementById('btn-recording-action-cancel')?.addEventListener('click', closeRecordingActionModal);
    document.getElementById('btn-recording-save-cancel')?.addEventListener('click', () => {
        closeRecordingSaveModal();
        const status = _getDeviceRecordingStatus ? _getDeviceRecordingStatus() : { state: 'idle' };
        if (status.state === 'paused') _resumeDeviceRecording?.();
    });
    document.getElementById('btn-recording-save-confirm')?.addEventListener('click', async() => {
        const btn = document.getElementById('btn-recording-save-confirm');
        const input = document.getElementById('recording-save-name');
        const name = input?.value?.trim() || (_getDefaultRecordingName ? _getDefaultRecordingName() : 'rec');
        btn?.setAttribute('disabled', 'true');
        try {
            const result = await _finishDeviceRecording?.(name);
            if (result) closeRecordingSaveModal();
        } finally {
            btn?.removeAttribute('disabled');
        }
    });
    if (_setDeviceRecordingStatusHandler) {
        _setDeviceRecordingStatusHandler(updateDeviceRecordingUi);
    }
    bindDeviceDashboardSettingsForm();
    ensureDashboardTiltPermissionIfEnabled(false).catch(err => console.warn('Permesso inclinometro non richiesto:', err));
    bindRecordingSettingsForm();
    updateDeviceRecordingUi(_getDeviceRecordingStatus ? _getDeviceRecordingStatus() : { state: 'idle' });

    map.on('click', (e) => {
        const coords = e.lngLat;
        if (isDrawing) {
            _addPointToActiveSegment(coords.lng, coords.lat);
        } else if (isCutting) {
            _cutTrackAtPoint(coords);
        } else if (isBoxDeleting) {
            _handleBoxDeleteClick(coords);
        } else if (isAddingWaypoint) {
            _addWaypointAtCoords(coords.lng, coords.lat);
        }
    });

    map.on('mousemove', (e) => {
        updateCursorCoordinates(e.lngLat);
        if (isBoxDeleting && boxDeleteCoords) updateBoxDeletePreview(e.lngLat);
        updateMapToolCursor();
    });

    document.getElementById('btn-cut-track').onclick = () => {
        setIsCutting(!isCutting);
        setIsDrawing(false);
        setIsBoxDeleting(false);
        setIsAddingWaypoint(false);
        _disablePrintPlanning();
        clearBoxDeleteSelection();
        updateToolButtons();
        updateMapToolCursor();
        showToast(isCutting ? "Clicca su un punto della traccia per tagliarla in due segmenti" : "Taglio disattivato", "info");
    };

    document.getElementById('btn-box-delete').onclick = () => {
        setIsBoxDeleting(!isBoxDeleting);
        setIsDrawing(false);
        setIsCutting(false);
        setIsAddingWaypoint(false);
        _disablePrintPlanning();
        clearBoxDeleteSelection();
        updateToolButtons();
        updateMapToolCursor();
        showToast(isBoxDeleting ? "Clicca due punti per definire il rettangolo d'eliminazione" : "Cancellazione box disattivata", "info");
    };

    document.getElementById('btn-add-waypoint').onclick = () => {
        setIsAddingWaypoint(!isAddingWaypoint);
        setIsDrawing(false);
        setIsCutting(false);
        setIsBoxDeleting(false);
        _disablePrintPlanning();
        clearBoxDeleteSelection();
        updateToolButtons();
        updateMapToolCursor();
        showToast(isAddingWaypoint ? "Clicca sulla mappa per inserire un Waypoint" : "Inserimento waypoint disattivato", "info");
    };

    updateToolButtons();
    updateMapToolCursor();
    updateMapillaryToolbarButton();

    document.getElementById('btn-undo').onclick = _triggerUndo;

    window.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
            e.preventDefault();
            _triggerUndo();
            return;
        }
        handleTreeKeyboardShortcuts(e);
    });

    const fileImportInput = document.getElementById('file-import-gpx');
    if (fileImportInput) {
        fileImportInput.onchange = (e) => {
            const file = e.target.files[0];
            if (file) {
                trackAnalyticsEvent('import_gpx', {
                    fileName: file.name,
                    size: file.size
                }).catch(err => console.warn(err));
                const reader = new FileReader();
                reader.onload = function(evt) {
                    _importGPX(evt.target.result, file.name);
                };
                reader.readAsText(file);
            }
        };
    }

    document.getElementById('btn-tree-new-track').onclick = () => {
        createNewTrack();
    };

    document.getElementById('btn-search').onclick = searchNominatim;
    document.getElementById('input-search').onkeydown = (e) => {
        if (e.key === 'Enter') searchNominatim();
    };

    document.getElementById('btn-wp-cancel').onclick = () => {
        document.getElementById('modal-waypoint').classList.add('hidden');
        setActiveWpForEdit({ trackId: null, wpId: null });
    };
    document.getElementById('btn-wp-save').onclick = _saveWaypointModifications;

    // Eventi di pianificazione stampa
    setupPrintUiEvents();

    if (typeof _compactLayoutMedia.addEventListener === 'function') {
        _compactLayoutMedia.addEventListener('change', syncMobileBackdrop);
    } else if (typeof _compactLayoutMedia.addListener === 'function') {
        _compactLayoutMedia.addListener(syncMobileBackdrop);
    }

    window.addEventListener('resize', syncMobileBackdrop);
}
