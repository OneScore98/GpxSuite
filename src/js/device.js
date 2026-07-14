// device.js — integrazione GPXSuite Logger (M5StickS3 + GPS/BDS v1.1 + ENV III)
//
// Principio (vedi hardware-logger/DESIGN.md): la flash del logger e' la verita',
// l'app e' visualizzatore + telecomando. Quando il dispositivo e' collegato:
//   - i sensori del telefono NON vengono usati (GPS, orientamento, motion);
//   - la posizione arriva dal logger (feedExternalFix -> marker/follow);
//   - la dashboard sensori e' alimentata dalla BMI270 del logger;
//   - il REC dell'app comanda il logger via POST /cmd;
//   - i record live/backlog finiscono nella struttura canonica `tracks`.
//
// Dipendenze iniettate da main.js (initDeviceModule): nessun import circolare.

import { tracks, setActiveTrackId, setActiveSegmentId } from './state.js';
import { ensureLucideIcons } from './utils.js';
import { listStoredTracks, loadStoredTrack, persistTrackNow } from './storage.js';

const DEVICE_URL_KEY = 'gpxsuite-device-url-v1';
const DEVICE_AUTOCONNECT_KEY = 'gpxsuite-device-autoconnect-v1';
const RECORD_SIZE = 24;
const STORED_RECORD_SIZE = 20;
const STATUS_POLL_MS = 2500;
const RECONNECT_MS = 4000;
const MAP_REFRESH_THROTTLE_MS = 700;
const LIVE_PERSIST_DEBOUNCE_MS = 5000;
const AUTO_SYNC_DELAY_MS = 900;
const LOGGER_TRACK_COLOR = '#f97316';
const VIBRATION_LEVEL_MAX = 20;
const DEFAULT_DEVICE_URLS = ['http://192.168.4.1', 'http://gpx.local'];
const LOGGER_INTERFACE_URL = 'http://192.168.4.1';
const SAME_ORIGIN_DEVICE_URL = '';

let _deps = {};
let _baseUrl = null;            // "http://192.168.4.1" (senza slash finale)
let _connected = false;         // intento dell'utente
let _online = false;            // raggiungibilita' effettiva
let _connecting = false;
let _status = null;             // ultimo /status
let _settings = null;           // ultimo /settings
let _sessions = null;           // ultima lista /sessions
let _sessionId = null;          // sessione REC corrente
let _lastSeq = 0;
let _ws = null;
let _pollTimer = null;
let _reconnectTimer = null;
let _pollFailures = 0;
let _mapRefreshTimer = null;
let _mapRefreshLast = 0;
let _livePersistTimer = null;
let _autoSyncTimer = null;
let _panelRenderTimer = null;
let _panelInteractionUntil = 0;
let _panelOpen = false;
let _visibilityBound = false;
let _deviceUiBound = false;
let _connectReady = false;
let _autoConnectAttempted = false;
let _lastConnectionAttempts = [];
let _lastConnectionError = '';
let _syncing = false;           // backlog della sessione attiva
let _autoSyncing = false;       // sessioni storiche verso memoria telefono
let _autoSyncRerun = false;
let _syncStats = createEmptySyncStats();
let _settingsFormDirty = false;
let _settingsFormFocused = false;
let _pendingSettingsFromDevice = null;
let _settingsSaveBusy = false;
let _settingsSaveFeedback = { kind: 'idle', message: '' };

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function notify(msg, kind = 'info') { _deps.showToast?.(msg, kind); }

function syncDashboardVisualSettings() {
    _deps.setDeviceDashboardVisualSettings?.(_settings?.visual || null);
}

function applyDeviceSettings(settings, options = {}) {
    if (!settings) return false;
    if (!options.force && isDeviceSettingsEditing()) {
        _pendingSettingsFromDevice = settings;
        return false;
    }
    _settings = settings;
    _pendingSettingsFromDevice = null;
    syncDashboardVisualSettings();
    return true;
}

function deviceSettingsFeedbackClass(kind) {
    const base = 'rounded-lg border px-3 py-2 text-xs font-bold';
    switch (kind) {
        case 'saving': return `${base} bg-cyan-950/80 border-cyan-700 text-cyan-100`;
        case 'success': return `${base} bg-emerald-950/80 border-emerald-700 text-emerald-100`;
        case 'error': return `${base} bg-red-950/80 border-red-700 text-red-100`;
        default: return 'hidden';
    }
}

function setDeviceSettingsFeedback(kind, message) {
    _settingsSaveFeedback = { kind, message };
    updateDeviceSettingsFeedbackUi();
}

function updateDeviceSettingsFeedbackUi() {
    const feedback = document.getElementById('device-settings-feedback');
    if (feedback) {
        feedback.className = _settingsSaveFeedback.message ?
            deviceSettingsFeedbackClass(_settingsSaveFeedback.kind) :
            'hidden';
        feedback.setAttribute('role', _settingsSaveFeedback.kind === 'error' ? 'alert' : 'status');
        feedback.textContent = _settingsSaveFeedback.message || '';
    }
    const button = document.getElementById('device-settings-save-button');
    if (button) {
        button.disabled = _settingsSaveBusy;
        button.textContent = _settingsSaveBusy ? 'Salvataggio...' : 'Salva impostazioni';
        button.classList.toggle('opacity-60', _settingsSaveBusy);
        button.classList.toggle('cursor-wait', _settingsSaveBusy);
    }
}

function renderDeviceSettingsFeedback() {
    const message = _settingsSaveFeedback.message || '';
    return `<div id="device-settings-feedback" role="${_settingsSaveFeedback.kind === 'error' ? 'alert' : 'status'}"
        class="${message ? deviceSettingsFeedbackClass(_settingsSaveFeedback.kind) : 'hidden'}">${esc(message)}</div>`;
}

function markDeviceSettingsDirty() {
    _settingsFormDirty = true;
    if (!_settingsSaveBusy && _settingsSaveFeedback.message) {
        setDeviceSettingsFeedback('idle', '');
    }
    markDevicePanelInteraction();
}

function createEmptySyncStats() {
    return {
        state: 'idle',
        localSessions: 0,
        loggerSessions: 0,
        queued: 0,
        saved: 0,
        skipped: 0,
        deleted: 0,
        failed: 0,
        lastError: '',
        lastRunAt: null
    };
}

// ---------------------------------------------------------------------------
// Init e binding UI statica
// ---------------------------------------------------------------------------
export function initDeviceModule(deps = {}, options = {}) {
    _deps = { ..._deps, ...deps };
    _connectReady = _connectReady || options.deferConnect !== true;

    bindDeviceStaticUi();

    // Ripristino preferenze
    let savedUrl = '';
    let autoconnect = false;
    try {
        savedUrl = localStorage.getItem(DEVICE_URL_KEY) || '';
        autoconnect = localStorage.getItem(DEVICE_AUTOCONNECT_KEY) === '1';
    } catch (err) { }
    const input = document.getElementById('device-url-input');
    if (input && savedUrl) input.value = savedUrl;
    const autoBox = document.getElementById('device-autoconnect');
    if (autoBox) autoBox.checked = autoconnect;

    if (!_visibilityBound) {
        _visibilityBound = true;
        document.addEventListener('visibilitychange', () => {
            // Riallineamento dopo sblocco telefono: backlog dal seq gia' ricevuto
            if (document.visibilityState === 'visible' && _connected) {
                fetchStatus().then(applyStatus).catch(() => { });
                loadDeviceSettings().catch(() => { });
                syncBacklog();
                scheduleAutoSync('visible');
            } else if (document.visibilityState === 'hidden') {
                flushLiveTrackPersist();
            }
        });
        window.addEventListener('pagehide', flushLiveTrackPersist);
    }

    if (options.deferConnect === true || _autoConnectAttempted) {
        updateToolbarIndicator();
        return;
    }
    _autoConnectAttempted = true;

    // Modalita' logger: app servita direttamente dal dispositivo o telefono
    // gia' collegato alla WiFi GPXLogger. Non richiede input manuale.
    const host = location.hostname;
    if (isLoggerHost(host)) {
        connectDevice('', { silent: true, auto: false });
    } else {
        connectDevice(savedUrl || '', { silent: true, auto: true });
    }
    updateToolbarIndicator();
}

function bindDeviceStaticUi() {
    if (_deviceUiBound) return;
    _deviceUiBound = true;

    document.getElementById('btn-device-panel')?.addEventListener('click', toggleDevicePanel);
    document.getElementById('btn-close-device-panel')?.addEventListener('click', () => setDevicePanelOpen(false));
    document.getElementById('btn-device-connect')?.addEventListener('click', () => {
        if (_connected) { disconnectDevice(); return; }
        if (!_connectReady) {
            notify('Archivio locale in caricamento, riprova tra un istante', 'info');
            return;
        }
        connectDevice('', { auto: true });
    });
    document.getElementById('device-autoconnect')?.addEventListener('change', e => {
        try { localStorage.setItem(DEVICE_AUTOCONNECT_KEY, e.target.checked ? '1' : '0'); } catch (err) { }
    });

    const panel = document.getElementById('panel-device');
    if (panel) {
        panel.addEventListener('pointerdown', markDevicePanelInteraction, true);
        panel.addEventListener('pointerup', finishDevicePanelInteraction, true);
        panel.addEventListener('pointercancel', finishDevicePanelInteraction, true);
        panel.addEventListener('mouseleave', finishDevicePanelInteraction, true);
    }
}

function markDevicePanelInteraction() {
    _panelInteractionUntil = Date.now() + 700;
}

function finishDevicePanelInteraction() {
    _panelInteractionUntil = Date.now() + 120;
    if (isDeviceSettingsEditing()) {
        updateToolbarIndicator();
        return;
    }
    if (_panelRenderTimer) return;
    _panelRenderTimer = setTimeout(() => {
        _panelRenderTimer = null;
        if (isDeviceSettingsEditing()) {
            updateToolbarIndicator();
            return;
        }
        renderDevicePanel({ force: true });
    }, 140);
}

function shouldDeferDevicePanelRender() {
    return _panelOpen && !isDeviceSettingsEditing() && Date.now() < _panelInteractionUntil;
}

export function isDeviceConnected() { return _connected && _online; }

// ---------------------------------------------------------------------------
// Connessione
// ---------------------------------------------------------------------------
function normalizeUrl(raw) {
    let url = String(raw || '').trim();
    if (!url) url = 'gpx.local';
    if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
    return url.replace(/\/+$/, '');
}

function isLoggerHost(host = location.hostname) {
    return host === 'gpx.local' || host === 'gpx.local.' || host === '192.168.4.1';
}

function deviceConnectionCandidates(rawUrl, options = {}) {
    const seen = new Set();
    const candidates = [];
    const push = value => {
        if (value === SAME_ORIGIN_DEVICE_URL) {
            if (!seen.has(SAME_ORIGIN_DEVICE_URL)) {
                seen.add(SAME_ORIGIN_DEVICE_URL);
                candidates.push(SAME_ORIGIN_DEVICE_URL);
            }
            return;
        }
        const url = normalizeUrl(value);
        if (seen.has(url)) return;
        seen.add(url);
        candidates.push(url);
    };

    if (isLoggerHost()) {
        push(SAME_ORIGIN_DEVICE_URL);
        return candidates;
    }
    if (rawUrl) push(rawUrl);
    if (options.auto !== false) {
        const savedInput = document.getElementById('device-url-input')?.value || '';
        if (savedInput) push(savedInput);
        try {
            const saved = localStorage.getItem(DEVICE_URL_KEY) || '';
            if (saved) push(saved);
        } catch (err) { }
        DEFAULT_DEVICE_URLS.forEach(push);
    }
    if (!candidates.length) DEFAULT_DEVICE_URLS.forEach(push);
    return candidates;
}

function displayDeviceUrl(url) {
    return url === SAME_ORIGIN_DEVICE_URL ? location.origin : url;
}

function deviceHttpUrl(path) {
    return _baseUrl === SAME_ORIGIN_DEVICE_URL ? path : _baseUrl + path;
}

function deviceWsUrl(path) {
    if (_baseUrl !== SAME_ORIGIN_DEVICE_URL) return _baseUrl.replace(/^http/i, 'ws') + path;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}${path}`;
}

async function fetchWithTimeout(path, options = {}, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const method = options.method || 'GET';
        xhr.open(method, deviceHttpUrl(path), true);
        xhr.timeout = timeoutMs;
        xhr.responseType = 'arraybuffer';
        xhr.setRequestHeader('Cache-Control', 'no-cache');
        const headers = options.headers || {};
        const hasContentType = Object.keys(headers).some(name => name.toLowerCase() === 'content-type');
        Object.entries(headers).forEach(([name, value]) => xhr.setRequestHeader(name, value));

        let body = options.body ?? null;
        if (body instanceof URLSearchParams) {
            if (!hasContentType) xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8');
            body = body.toString();
        } else if (typeof body === 'string' && !hasContentType) {
            xhr.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        }

        xhr.onload = () => {
            const buffer = xhr.response || new ArrayBuffer(0);
            const decodeText = () => new TextDecoder().decode(buffer);
            resolve({
                ok: xhr.status >= 200 && xhr.status < 300,
                status: xhr.status,
                json: async () => JSON.parse(decodeText() || '{}'),
                text: async () => decodeText(),
                arrayBuffer: async () => buffer
            });
        };
        xhr.onerror = () => reject(new Error('rete non raggiungibile'));
        xhr.ontimeout = () => {
            const err = new Error('timeout');
            err.name = 'AbortError';
            reject(err);
        };
        xhr.send(body);
    });
}

async function fetchStatus() {
    const res = await fetchWithTimeout('/status');
    if (!res.ok) throw new Error('status ' + res.status);
    return res.json();
}

async function fetchSettings() {
    const res = await fetchWithTimeout('/settings');
    if (!res.ok) throw new Error('settings ' + res.status);
    return res.json();
}

function describeConnectionError(err) {
    if (!err) return 'nessuna risposta';
    if (err.name === 'AbortError') return 'timeout';
    if (err.name === 'TypeError') return 'rete o browser';
    return err.message || String(err);
}

export function openLoggerInterface(targetUrl = '') {
    const target = targetUrl ?
        normalizeUrl(targetUrl) + '/' :
        (isLoggerHost() ? location.origin.replace(/\/+$/, '') + '/' : LOGGER_INTERFACE_URL + '/');
    window.location.assign(target);
}

export async function connectDevice(rawUrl, options = {}) {
    if (_connected || _connecting) return;
    _connecting = true;
    updateToolbarIndicator();
    if (!options.silent) notify('Connessione al dispositivo...', 'info');
    let status;
    const candidates = deviceConnectionCandidates(rawUrl, options);
    _lastConnectionAttempts = [];
    _lastConnectionError = '';
    for (let i = 0; i < candidates.length; i++) {
        _baseUrl = candidates[i];
        try {
            status = await fetchStatus();
            break;
        } catch (err) {
            _lastConnectionAttempts.push({
                url: displayDeviceUrl(_baseUrl),
                error: describeConnectionError(err)
            });
            status = null;
        }
    }
    if (!status) {
        _baseUrl = null;
        _connecting = false;
        _lastConnectionError = 'Dispositivo non raggiungibile';
        if (!options.silent) notify('Dispositivo non raggiungibile', 'error');
        renderDevicePanel({ force: true, allowSettingsRender: true });
        updateToolbarIndicator();
        return;
    }

    _connecting = false;
    _connected = true;
    _online = true;
    _lastConnectionAttempts = [];
    _lastConnectionError = '';
    _pollFailures = 0;
    _lastSeq = 0;
    _sessionId = null;
    _syncStats = createEmptySyncStats();
    try {
        if (_baseUrl !== SAME_ORIGIN_DEVICE_URL) localStorage.setItem(DEVICE_URL_KEY, _baseUrl);
    } catch (err) { }

    // Da qui in poi i sensori del telefono non servono piu'.
    _deps.setExternalFixProvider?.(true);
    _deps.setExternalSensorFeed?.(true);
    if (_deps.isDeviceLocationActive && !_deps.isDeviceLocationActive()) {
        _deps.startDeviceLocation?.();
    }

    applyStatus(status);
    loadDeviceSettings().catch(() => { });
    openWebSocket();
    startPolling();
    if (status.rec) syncBacklog();          // registrazione gia' in corso: recupera tutto
    loadDeviceSessions().catch(() => { });
    scheduleAutoSync('connect');
    notify('Strumento collegato: sensori del telefono disattivati', 'success');
    renderDevicePanel();
    updateToolbarIndicator();
}

export function disconnectDevice(options = {}) {
    if (!_connected && !_baseUrl) return;
    _connecting = false;
    flushLiveTrackPersist();
    _connected = false;
    _online = false;
    _status = null;
    _settings = null;
    _settingsFormDirty = false;
    _settingsFormFocused = false;
    _pendingSettingsFromDevice = null;
    syncDashboardVisualSettings();
    _sessions = null;
    _sessionId = null;
    clearTimeout(_autoSyncTimer); _autoSyncTimer = null;
    clearTimeout(_livePersistTimer); _livePersistTimer = null;
    _autoSyncing = false;
    _autoSyncRerun = false;
    _syncStats = createEmptySyncStats();
    stopPolling();
    clearTimeout(_reconnectTimer); _reconnectTimer = null;
    if (_ws) { try { _ws.close(); } catch (err) { } _ws = null; }

    // Ritorno ai sensori del telefono
    _deps.setExternalSensorFeed?.(false);
    _deps.setExternalFixProvider?.(false);
    if (_deps.updateDeviceRecordingUi) {
        _deps.updateDeviceRecordingUi({ state: 'idle', elapsedMs: 0, pointsCount: 0 });
    }

    if (!options.silent) notify('Strumento scollegato: sensori del telefono riattivati', 'info');
    renderDevicePanel();
    updateToolbarIndicator();
}

function onUnreachable() {
    if (!_connected) return;
    if (_online) {
        _online = false;
        notify('Dispositivo non raggiungibile: riconnessione in corso...', 'error');
        renderDevicePanel();
        updateToolbarIndicator();
    }
}

function onReachable() {
    if (!_online) {
        _online = true;
        notify('Dispositivo di nuovo raggiungibile', 'success');
        syncBacklog();
        scheduleAutoSync('reconnect');
        updateToolbarIndicator();
    }
}

// ---------------------------------------------------------------------------
// Polling /status
// ---------------------------------------------------------------------------
function startPolling() {
    stopPolling();
    _pollTimer = setInterval(async () => {
        if (!_connected) return;
        try {
            const status = await fetchStatus();
            _pollFailures = 0;
            onReachable();
            applyStatus(status);
            if (!_ws || _ws.readyState === WebSocket.CLOSED) openWebSocket();
        } catch (err) {
            if (++_pollFailures >= 2) onUnreachable();
        }
    }, STATUS_POLL_MS);
}

function stopPolling() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

function applyStatus(status) {
    if (!status || typeof status !== 'object') return;
    _status = status;

    if (status.rec && status.session) {
        if (status.session !== _sessionId) {
            _sessionId = status.session;
            _lastSeq = getKnownDeviceSessionSeq(status.session);
            syncBacklog();
        }
    } else if (!status.rec) {
        _sessionId = null;
    }

    if (_deps.updateDeviceRecordingUi) {
        const state = status.rec ? (status.paused ? 'paused' : 'recording') : 'idle';
        let elapsedMs = 0;
        if (status.rec && status.startEpoch) {
            elapsedMs = Math.max(0, Date.now() - (status.startEpoch * 1000));
        }
        _deps.updateDeviceRecordingUi({
            state: state,
            elapsedMs: elapsedMs,
            pointsCount: status.seq || 0
        });
    }

    // Dashboard sensori con i dati del logger
    if (status.imu) {
        const vibrationSource = Number.isFinite(status.imu.accPeak) ? status.imu.accPeak :
            (Number.isFinite(status.imu.vibration) ? status.imu.vibration : null);
        const vibrationLevel = Number.isFinite(status.imu.level) ?
            status.imu.level :
            (vibrationSource !== null ? normalizeVibrationLevel(vibrationSource) : null);
        _deps.feedExternalDashboardSensors?.({
            pitch: status.imu.pitch,
            tilt: status.imu.roll,
            vibrationLevel
        });
    }
    const envTemp = Number(status.env?.temp);
    const batteryPct = Number(status.batt);
    const flashFreePct = Number(status.flashFreePct);
    const flashUsedPct = Number(status.flashUsedPct);
    _deps.feedExternalDashboardMeta?.({
        temperatureC: Number.isFinite(envTemp) ? envTemp : null,
        batteryPct: Number.isFinite(batteryPct) ? batteryPct : null,
        batteryCharging: status.charging === true,
        storageFreePct: Number.isFinite(flashFreePct) ?
            flashFreePct :
            (Number.isFinite(flashUsedPct) ? Math.max(0, 100 - flashUsedPct) : null)
    });
    // Posizione anche in standby (se il WS 'pos' non arriva)
    if (status.fix && Number.isFinite(status.lat) && Number.isFinite(status.lon)) {
        _deps.feedExternalFix?.({
            lat: status.lat, lon: status.lon, ele: status.ele,
            speedMps: Number.isFinite(status.speed) ? status.speed / 3.6 : null,
            heading: Number.isFinite(status.course) && status.course >= 0 ? status.course : null,
            accuracy: Number.isFinite(status.hdop) ? Math.max(3, status.hdop * 4) : 5
        });
    }
    if (!isDeviceSettingsEditing()) renderDevicePanel();
    else updateToolbarIndicator();
    updateToolbarIndicator();
}

// ---------------------------------------------------------------------------
// WebSocket /live
// ---------------------------------------------------------------------------
function openWebSocket() {
    if (!_connected) return;
    try { if (_ws) _ws.close(); } catch (err) { }
    const wsUrl = deviceWsUrl('/live');
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (err) { return; }
    ws.binaryType = 'arraybuffer';
    _ws = ws;

    ws.onmessage = event => {
        if (event.data instanceof ArrayBuffer) {
            handleRecords(parseRecords(event.data));
            return;
        }
        let msg;
        try { msg = JSON.parse(event.data); } catch (err) { return; }
        if (msg.ev === 'pos') {
            _deps.feedExternalFix?.({
                lat: msg.lat, lon: msg.lon, ele: msg.ele,
                speedMps: Number.isFinite(msg.speed) ? msg.speed / 3.6 : null,
                heading: Number.isFinite(msg.course) && msg.course >= 0 ? msg.course : null
            });
        } else if (msg.ev === 'rec_started') {
            notify(`Registrazione avviata sul dispositivo (${msg.source === 'button' ? 'pulsante' : 'app'})`, 'success');
            _sessionId = msg.session || null;
            _lastSeq = getKnownDeviceSessionSeq(_sessionId);
            fetchStatus().then(applyStatus).catch(() => { });
            scheduleAutoSync('rec_started');
        } else if (msg.ev === 'rec_paused') {
            notify('Registrazione in pausa sul dispositivo', 'info');
            fetchStatus().then(applyStatus).catch(() => { });
        } else if (msg.ev === 'rec_resumed') {
            notify('Registrazione ripresa sul dispositivo', 'success');
            fetchStatus().then(applyStatus).catch(() => { });
        } else if (msg.ev === 'rec_stopped') {
            notify('Registrazione fermata sul dispositivo', 'info');
            flushLiveTrackPersist();
            _sessionId = null;
            fetchStatus().then(applyStatus).catch(() => { });
            loadDeviceSessions({ scheduleSync: false }).then(() => scheduleAutoSync('rec_stopped')).catch(() => { });
        } else if (msg.ev === 'flash_warning') {
            notify('Flash del dispositivo quasi piena: scarica le sessioni', 'error');
        } else if (msg.ev === 'battery_low') {
            notify('Batteria del dispositivo in esaurimento', 'error');
        } else if (msg.ev === 'settings_updated') {
            loadDeviceSettings().catch(() => { });
        } else if (msg.rec !== undefined) {
            applyStatus(msg);           // snapshot stato inviato alla connessione WS
        }
    };
    ws.onclose = () => {
        if (!_connected) return;
        clearTimeout(_reconnectTimer);
        _reconnectTimer = setTimeout(() => { if (_connected) openWebSocket(); }, RECONNECT_MS);
    };
    ws.onerror = () => { try { ws.close(); } catch (err) { } };
}

// ---------------------------------------------------------------------------
// Record binari 24 B -> traccia live canonica in `tracks`
// ---------------------------------------------------------------------------
function parseRecords(buffer) {
    const dv = new DataView(buffer);
    const out = [];
    for (let o = 0; o + RECORD_SIZE <= buffer.byteLength; o += RECORD_SIZE) {
        out.push({
            seq: dv.getUint32(o, true),
            tMs: dv.getUint32(o + 4, true),
            lat: dv.getInt32(o + 8, true) / 1e7,
            lon: dv.getInt32(o + 12, true) / 1e7,
            ele: dv.getInt16(o + 16, true),
            speedMps: dv.getUint16(o + 18, true) / 100,
            hdop: dv.getUint8(o + 20) / 10,
            accPeak: dv.getUint8(o + 21) / 10,
            pitch: dv.getInt8(o + 22),
            roll: dv.getInt8(o + 23)
        });
    }
    return out;
}

function countTrackPoints(track) {
    let total = 0;
    const segments = track?.segments || [];
    for (let i = 0; i < segments.length; i++) {
        total += (segments[i].points || []).length;
    }
    return total;
}

function getDeviceTrackBySessionId(sessionId) {
    if (!sessionId) return null;
    return tracks.find(track => String(track.deviceSessionId || '') === String(sessionId)) || null;
}

function getTrackDeviceSeq(track) {
    if (!track) return 0;
    if (Number.isFinite(track.deviceLastSeq)) return track.deviceLastSeq;
    let lastSeq = 0;
    for (const segment of track.segments || []) {
        for (const point of segment.points || []) {
            if (Number.isFinite(point.seq) && point.seq > lastSeq) lastSeq = point.seq;
        }
    }
    return lastSeq || countTrackPoints(track);
}

function getKnownDeviceSessionSeq(sessionId) {
    return getTrackDeviceSeq(getDeviceTrackBySessionId(sessionId));
}

function sessionRecordCount(item) {
    const count = Number(item?.records);
    return Number.isFinite(count) && count > 0 ? count : 0;
}

function isCurrentDeviceSession(sessionId) {
    if (!sessionId) return false;
    const current = _sessionId || (_status && _status.session) || null;
    return Boolean(_status?.rec && current && String(current) === String(sessionId));
}

function isSessionItemActive(item) {
    return Boolean(item?.active || isCurrentDeviceSession(item?.id));
}

function normalizeVibrationLevel(accPeak) {
    const value = Math.max(Number(accPeak) || 0, 0);
    const steps = _settings?.visual?.vibration?.stepsMps2;
    if (Array.isArray(steps) && steps.length >= VIBRATION_LEVEL_MAX) {
        for (let i = 0; i < VIBRATION_LEVEL_MAX; i++) {
            const threshold = Number(steps[i]);
            if (Number.isFinite(threshold) && value <= threshold) return i + 1;
        }
        return VIBRATION_LEVEL_MAX;
    }
    const level = Math.round(1 + Math.min(value, 5.5) / 5.5 * (VIBRATION_LEVEL_MAX - 1));
    return Math.min(VIBRATION_LEVEL_MAX, Math.max(1, level));
}

function ensureSessionTrack() {
    const sid = _sessionId || (_status && _status.session) || 'SESS';
    let track = tracks.find(t => t.deviceSessionId === sid);
    if (track) {
        _lastSeq = Math.max(_lastSeq, getTrackDeviceSeq(track));
        return track;
    }

    _deps.saveHistoryState?.();
    const now = Date.now();
    track = {
        id: 'track_dev_' + now,
        localFileId: 'local_' + now + '_' + Math.random().toString(36).slice(2, 8),
        localCreatedAt: now,
        localUpdatedAt: now,
        localSource: 'device',
        deviceSessionId: sid,
        deviceLastSeq: 0,
        deviceSyncedAt: 0,
        name: 'Logger ' + sid,
        desc: 'Registrata dal GPXSuite Logger',
        color: LOGGER_TRACK_COLOR,
        width: 4,
        visible: true,
        waypointsVisible: true,
        segments: [{
            id: 'seg_dev_' + now,
            name: 'Live',
            points: [],
            visible: true
        }],
        waypoints: []
    };
    tracks.push(track);
    setActiveTrackId(track.id);
    setActiveSegmentId(track.segments[0].id);
    _deps.renderGisTree?.();
    _deps.updateActiveTracksHeader?.();
    return track;
}

function handleRecords(records) {
    if (!records.length) return;
    const fresh = records.filter(r => r.seq > _lastSeq);
    if (!fresh.length) return;

    const track = ensureSessionTrack();
    const points = track.segments[0].points;
    for (const r of fresh) {
        points.push({
            seq: r.seq,
            time: Number.isFinite(_status?.startEpoch) ? (_status.startEpoch * 1000) + r.tMs : Date.now(),
            lat: r.lat,
            lon: r.lon,
            ele: r.ele,
            speedMps: r.speedMps,
            hdop: r.hdop,
            accPeak: r.accPeak,
            pitch: r.pitch,
            tilt: r.roll,
            vibrationLevel: normalizeVibrationLevel(r.accPeak),
            isUserClicked: false,
            needsElevation: false
        });
    }
    _lastSeq = fresh[fresh.length - 1].seq;
    track.deviceLastSeq = _lastSeq;
    track.deviceSyncedAt = Date.now();
    track.localUpdatedAt = Date.now();

    const last = fresh[fresh.length - 1];
    _deps.feedExternalFix?.({
        lat: last.lat, lon: last.lon, ele: last.ele,
        speedMps: last.speedMps,
        accuracy: Math.max(3, last.hdop * 4)
    });
    _deps.feedExternalDashboardSensors?.({
        pitch: last.pitch,
        tilt: last.roll,
        vibrationLevel: normalizeVibrationLevel(last.accPeak)
    });
    scheduleMapRefresh();
    scheduleLiveTrackPersist(track);
}

// A 10 Hz non si aggiorna la mappa per ogni record: throttle con trailing call.
function scheduleMapRefresh() {
    const now = Date.now();
    if (now - _mapRefreshLast >= MAP_REFRESH_THROTTLE_MS) {
        _mapRefreshLast = now;
        _deps.updateMapData?.();
        return;
    }
    if (_mapRefreshTimer) return;
    _mapRefreshTimer = setTimeout(() => {
        _mapRefreshTimer = null;
        _mapRefreshLast = Date.now();
        _deps.updateMapData?.();
    }, MAP_REFRESH_THROTTLE_MS - (now - _mapRefreshLast));
}

function getCurrentDeviceTrack() {
    return getDeviceTrackBySessionId(_sessionId || (_status && _status.session) || null);
}

async function persistDeviceTrackVerified(track, expectedPoints = 0) {
    if (!track) return false;
    await persistTrackNow(track, { force: true });
    const storedTrack = await loadStoredTrack(track.localFileId);
    return Boolean(storedTrack &&
        String(storedTrack.deviceSessionId || '') === String(track.deviceSessionId || '') &&
        countTrackPoints(storedTrack) >= expectedPoints);
}

function scheduleLiveTrackPersist(track = getCurrentDeviceTrack()) {
    if (!track || track.localSource !== 'device') return;
    clearTimeout(_livePersistTimer);
    _livePersistTimer = setTimeout(() => {
        _livePersistTimer = null;
        persistDeviceTrackVerified(track, 0).catch(err => {
            _syncStats.lastError = 'Salvataggio live non riuscito';
            console.warn('Persistenza live logger fallita', err);
            renderDevicePanel();
        });
    }, LIVE_PERSIST_DEBOUNCE_MS);
}

function flushLiveTrackPersist() {
    const track = getCurrentDeviceTrack();
    if (_livePersistTimer) {
        clearTimeout(_livePersistTimer);
        _livePersistTimer = null;
    }
    if (track) {
        persistDeviceTrackVerified(track, 0).catch(err => console.warn('Flush live logger fallito', err));
    }
}

async function fetchDeviceSessions() {
    const res = await fetchWithTimeout('/sessions', {}, 8000);
    if (!res.ok) throw new Error('sessions ' + res.status);
    return res.json();
}

async function readStoredDeviceSessionMap() {
    const files = await listStoredTracks();
    const sessionMap = new Map();
    for (const file of files) {
        if (!file.deviceSessionId) continue;
        const key = String(file.deviceSessionId);
        const existing = sessionMap.get(key);
        if (!existing || (file.pointsCount || 0) > (existing.pointsCount || 0)) {
            sessionMap.set(key, file);
        }
    }
    return sessionMap;
}

async function verifyStoredSessionMeta(meta, sessionId, expectedPoints = 0) {
    if (!meta?.id) return false;
    const storedTrack = await loadStoredTrack(meta.id);
    return Boolean(storedTrack &&
        String(storedTrack.deviceSessionId || '') === String(sessionId) &&
        countTrackPoints(storedTrack) >= expectedPoints);
}

function isTrackCompleteForSession(track, expectedPoints = 0) {
    if (!track) return false;
    if (expectedPoints <= 0) return true;
    return countTrackPoints(track) >= expectedPoints || getTrackDeviceSeq(track) >= expectedPoints;
}

async function deleteVerifiedDeviceSession(sessionId, options = {}) {
    if (isCurrentDeviceSession(sessionId)) return false;
    const res = await fetchWithTimeout('/delete?id=' + encodeURIComponent(sessionId), { method: 'POST' }, 8000);
    if (!res.ok) {
        const message = await res.text();
        throw new Error(message || ('delete ' + res.status));
    }
    if (options.refresh !== false) {
        loadDeviceSessions({ scheduleSync: false }).catch(() => { });
    }
    _syncStats.deleted++;
    return true;
}

async function downloadDeviceSessionToPhone(item, targetTrack = null) {
    const sessionId = String(item.id);
    const expectedPoints = sessionRecordCount(item);
    const res = await fetchWithTimeout('/download?id=' + encodeURIComponent(sessionId), {}, 30000);
    if (!res.ok) throw new Error('download ' + res.status);
    const xml = await res.text();
    const track = await _deps.importGPX?.(xml, sessionId + '.gpx', {
        silent: true,
        flyTo: false,
        activate: false,
        updateMap: false,
        saveHistory: false,
        source: 'device',
        deviceSessionId: sessionId,
        deviceLastSeq: expectedPoints,
        targetTrackId: targetTrack?.id || null,
        trackName: targetTrack?.name || ('Logger ' + sessionId),
        color: targetTrack?.color || LOGGER_TRACK_COLOR,
        width: targetTrack?.width || 4
    });
    if (!track) throw new Error('import failed');
    track.localSource = 'device';
    track.deviceSessionId = sessionId;
    track.deviceLastSeq = Math.max(getTrackDeviceSeq(track), expectedPoints);
    track.deviceSyncedAt = Date.now();
    track.localUpdatedAt = Date.now();
    const verified = await persistDeviceTrackVerified(track, expectedPoints);
    if (!verified) throw new Error('verify failed');
    return track;
}

function scheduleAutoSync(reason = 'auto', delayMs = AUTO_SYNC_DELAY_MS) {
    if (!_connected) return;
    clearTimeout(_autoSyncTimer);
    _autoSyncTimer = setTimeout(() => {
        _autoSyncTimer = null;
        runAutoSync(reason).catch(err => {
            console.warn('Sync logger automatica fallita', err);
            renderDevicePanel();
        });
    }, delayMs);
}

async function runAutoSync(reason = 'auto') {
    if (!_connected) return;
    if (_autoSyncing) {
        _autoSyncRerun = true;
        return;
    }
    _autoSyncing = true;
    _syncStats = {
        ...createEmptySyncStats(),
        state: 'syncing',
        lastRunAt: Date.now()
    };
    renderDevicePanel();

    let changedTracks = false;
    try {
        const sessions = await fetchDeviceSessions();
        _sessions = Array.isArray(sessions) ? sessions : [];
        const storedMap = await readStoredDeviceSessionMap();
        _syncStats.localSessions = storedMap.size;
        _syncStats.loggerSessions = _sessions.length;
        _syncStats.queued = _sessions.filter(item => !isSessionItemActive(item)).length;

        for (const item of _sessions) {
            if (!_connected) break;
            if (!item?.id || isSessionItemActive(item)) continue;

            const sessionId = String(item.id);
            const expectedPoints = sessionRecordCount(item);
            const localTrack = getDeviceTrackBySessionId(sessionId);
            const storedMeta = storedMap.get(sessionId);

            if (storedMeta && await verifyStoredSessionMeta(storedMeta, sessionId, expectedPoints)) {
                _syncStats.skipped++;
                await deleteVerifiedDeviceSession(sessionId, { refresh: false });
                continue;
            }

            if (localTrack && isTrackCompleteForSession(localTrack, expectedPoints)) {
                localTrack.deviceLastSeq = Math.max(getTrackDeviceSeq(localTrack), expectedPoints);
                localTrack.deviceSyncedAt = Date.now();
                const verified = await persistDeviceTrackVerified(localTrack, expectedPoints);
                if (!verified) throw new Error('Salvataggio locale non verificato');
                _syncStats.saved++;
                storedMap.set(sessionId, {
                    id: localTrack.localFileId,
                    deviceSessionId: sessionId,
                    pointsCount: countTrackPoints(localTrack)
                });
                await deleteVerifiedDeviceSession(sessionId, { refresh: false });
                continue;
            }

            await downloadDeviceSessionToPhone(item, localTrack);
            _syncStats.saved++;
            changedTracks = true;
            await deleteVerifiedDeviceSession(sessionId, { refresh: false });
        }

        if (changedTracks) {
            _deps.updateMapData?.(true);
            _deps.renderGisTree?.();
            _deps.updateActiveTracksHeader?.();
        }
        _syncStats.state = 'idle';
        _syncStats.lastError = '';
        loadDeviceSessions({ scheduleSync: false }).catch(() => { });
        if (_syncStats.saved > 0 || _syncStats.deleted > 0) {
            notify(`Sync telefono completata: ${_syncStats.saved} salvate, ${_syncStats.deleted} liberate`, 'success');
        }
    } catch (err) {
        _syncStats.state = 'error';
        _syncStats.lastError = err?.message || 'Sync non riuscita';
        _syncStats.failed++;
        throw err;
    } finally {
        _autoSyncing = false;
        renderDevicePanel();
        updateToolbarIndicator();
        if (_autoSyncRerun && _connected) {
            _autoSyncRerun = false;
            scheduleAutoSync('rerun', 250);
        }
    }
}

// ---------------------------------------------------------------------------
// /sync — riallineamento backlog (sblocco telefono, riconnessione, connect)
// ---------------------------------------------------------------------------
async function syncBacklog() {
    if (!_connected || _syncing || !_status?.rec) return;
    _syncing = true;
    try {
        const res = await fetchWithTimeout('/sync?from=' + _lastSeq, {}, 15000);
        if (res.ok) {
            const buf = await res.arrayBuffer();
            if (buf.byteLength) {
                handleRecords(parseRecords(buf));
                notify('Traccia riallineata dal dispositivo', 'success');
            }
        }
    } catch (err) {
        console.warn('Sync backlog non riuscito', err);
    } finally {
        _syncing = false;
    }
}

// ---------------------------------------------------------------------------
// Comandi verso il logger
// ---------------------------------------------------------------------------
async function sendCommand(body, okMsg) {
    if (!_connected) { notify('Nessun dispositivo collegato', 'error'); return null; }
    try {
        const res = await fetchWithTimeout('/cmd', { method: 'POST', body }, 8000);
        const text = await res.text();
        if (res.status === 208) { notify('Il dispositivo era già in questo stato', 'info'); }
        else if (!res.ok) { notify('Comando rifiutato: ' + text, 'error'); return null; }
        else if (okMsg) notify(okMsg, 'success');
        try {
            const parsed = JSON.parse(text);
            if (parsed?.gps && parsed?.recording) {
                if (applyDeviceSettings(parsed)) renderDevicePanel();
            } else {
                applyStatus(parsed);
            }
        } catch (err) {
            fetchStatus().then(applyStatus).catch(() => { });
        }
        return text;
    } catch (err) {
        notify('Dispositivo non raggiungibile', 'error');
        return null;
    }
}

export function toggleDeviceRecording() {
    if (!_status) return;
    if (_status.rec) stopLoggerRecording();
    else startLoggerRecording();
}

export function startLoggerRecording() {
    return sendCommand('START', 'Registrazione avviata sul dispositivo');
}

export function pauseLoggerRecording() {
    return sendCommand('PAUSE', 'Registrazione in pausa sul dispositivo');
}

export function resumeLoggerRecording() {
    return sendCommand('RESUME', 'Registrazione ripresa sul dispositivo');
}

export function stopLoggerRecording() {
    return sendCommand('STOP', 'Registrazione fermata dal telecomando');
}

export function setDeviceRate(hz) {
    const rate = parseInt(hz, 10);
    if (!(rate >= 1 && rate <= 10)) return;
    sendCommand('SET_RATE ' + rate, `Frequenza GPS impostata a ${rate} Hz`);
}

export function calibrateDeviceImu() {
    sendCommand('CAL_IMU', 'Assetto azzerato sul dispositivo (veicolo in piano)');
}

export function saveGpsReceiverConfig() {
    sendCommand('GPS_SAVE', 'Configurazione GPS salvata nella flash del ricevitore');
}

export function restartGpsReceiver(mode = 'hot') {
    const normalized = String(mode || 'hot').toUpperCase();
    const label = normalized === 'COLD' ? 'cold' : (normalized === 'WARM' ? 'warm' : 'hot');
    sendCommand('GPS_RESTART ' + normalized, `Riavvio GPS ${label} inviato`);
}

export function standbyGpsReceiver() {
    const input = document.getElementById('device-gps-standby-sec');
    const fallback = _settings?.gps?.standbySec ?? 60;
    const sec = Math.min(65535, Math.max(1, parseInt(input?.value || fallback, 10) || 60));
    sendCommand('GPS_STANDBY ' + sec, `GPS in standby per ${sec} s`);
}

export async function loadDeviceSettings() {
    if (!_connected) return;
    const settings = await fetchSettings();
    if (applyDeviceSettings(settings)) renderDevicePanel();
}

function collectDeviceSettingsForm() {
    const form = document.getElementById('device-settings-form');
    if (!form) return null;
    const params = new URLSearchParams();
    form.querySelectorAll('[name]').forEach(input => {
        if (input.type === 'checkbox') params.set(input.name, input.checked ? '1' : '0');
        else if (input.name === 'displayStartPage') {
            const page = Math.min(5, Math.max(0, parseInt(input.value, 10) || 0));
            params.set(input.name, String(page));
        } else params.set(input.name, input.value);
    });
    return params;
}

function normalizeSettingHex(value) {
    const text = String(value || '').trim();
    return /^#[0-9a-f]{6}$/i.test(text) ? text.toUpperCase() : '';
}

function getReturnedSettingValue(settings, key) {
    const speed = settings?.visual?.speed || {};
    const vibration = settings?.visual?.vibration || {};
    switch (key) {
        case 'speedLowColor': return speed.lowColor;
        case 'speedMediumColor': return speed.mediumColor;
        case 'speedHighColor': return speed.highColor;
        case 'vibrationLowColor': return vibration.lowColor;
        case 'vibrationMediumColor': return vibration.mediumColor;
        case 'vibrationHighColor': return vibration.highColor;
        default: return null;
    }
}

function verifyDeviceSettingsEcho(params, settings) {
    const colorKeys = [
        'speedLowColor',
        'speedMediumColor',
        'speedHighColor',
        'vibrationLowColor',
        'vibrationMediumColor',
        'vibrationHighColor'
    ];
    return colorKeys.filter(key => {
        if (!params.has(key)) return false;
        return normalizeSettingHex(params.get(key)) !== normalizeSettingHex(getReturnedSettingValue(settings, key));
    });
}

export async function saveDeviceSettings() {
    if (_settingsSaveBusy) return;
    if (!_connected) {
        setDeviceSettingsFeedback('error', 'Nessun dispositivo collegato');
        notify('Nessun dispositivo collegato', 'error');
        return;
    }
    const params = collectDeviceSettingsForm();
    if (!params) return;
    _settingsSaveBusy = true;
    setDeviceSettingsFeedback('saving', 'Salvataggio impostazioni sul logger...');
    try {
        const res = await fetchWithTimeout('/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: params
        }, 8000);
        const json = await res.json();
        if (!res.ok) {
            _settingsSaveBusy = false;
            setDeviceSettingsFeedback('error', 'Salvataggio impostazioni non riuscito');
            notify('Salvataggio impostazioni non riuscito', 'error');
            return;
        }
        _settingsFormDirty = false;
        _settingsFormFocused = false;
        _pendingSettingsFromDevice = null;
        applyDeviceSettings(json, { force: true });
        const mismatches = verifyDeviceSettingsEcho(params, json);
        _settingsSaveBusy = false;
        if (mismatches.length) {
            setDeviceSettingsFeedback('error', 'Salvato, ma il logger non ha confermato alcuni colori');
            notify('Il logger non ha confermato alcuni colori salvati', 'error');
        } else {
            setDeviceSettingsFeedback('success', 'Impostazioni salvate sul logger');
            notify('Impostazioni logger salvate e verificate', 'success');
        }
        fetchStatus().then(applyStatus).catch(() => { });
        renderDevicePanel({ force: true, allowSettingsRender: true });
    } catch (err) {
        _settingsSaveBusy = false;
        setDeviceSettingsFeedback('error', 'Nessuna risposta dal logger durante il salvataggio');
        notify('Dispositivo non raggiungibile', 'error');
    }
}

// ---------------------------------------------------------------------------
// Libreria sessioni del dispositivo
// ---------------------------------------------------------------------------
export async function loadDeviceSessions(options = {}) {
    if (!_connected) return;
    try {
        _sessions = await fetchDeviceSessions();
        if (!isDeviceSettingsEditing()) renderDevicePanel();
        if (options.scheduleSync !== false) scheduleAutoSync('sessions');
        return _sessions;
    } catch (err) {
        if (!options.silent) notify('Elenco sessioni non disponibile', 'error');
        return _sessions;
    }
}

export async function importDeviceSession(sessionId) {
    if (!_connected) return;
    notify('Scarico la sessione dal dispositivo...', 'info');
    try {
        const res = await fetchWithTimeout('/download?id=' + encodeURIComponent(sessionId), {}, 30000);
        if (!res.ok) { notify('Download non riuscito', 'error'); return; }
        const xml = await res.text();
        const track = await _deps.importGPX?.(xml, sessionId + '.gpx', {
            source: 'device',
            deviceSessionId: sessionId,
            trackName: 'Logger ' + sessionId
        });
        if (track) {
            track.deviceLastSeq = Math.max(getTrackDeviceSeq(track), countTrackPoints(track));
            track.deviceSyncedAt = Date.now();
            persistDeviceTrackVerified(track, 0).catch(err => console.warn('Persistenza import logger fallita', err));
        }
    } catch (err) {
        notify('Download non riuscito', 'error');
    }
}

export async function deleteDeviceSession(sessionId, options = {}) {
    if (!_connected) return false;
    if (isCurrentDeviceSession(sessionId)) {
        if (!options.silent) notify('Sessione ancora attiva: ferma la registrazione prima di eliminarla', 'error');
        return false;
    }
    if (!options.silent && !confirm(`Eliminare la sessione ${sessionId} dalla flash del dispositivo?`)) return false;
    try {
        const res = await fetchWithTimeout('/delete?id=' + encodeURIComponent(sessionId), { method: 'POST' }, 8000);
        if (res.ok) {
            if (!options.silent) notify('Sessione eliminata dal dispositivo', 'success');
            if (options.refresh !== false) loadDeviceSessions({ scheduleSync: false }).catch(() => { });
            return true;
        } else {
            if (!options.silent) notify('Eliminazione non riuscita: ' + await res.text(), 'error');
            return false;
        }
    } catch (err) {
        if (!options.silent) notify('Dispositivo non raggiungibile', 'error');
        return false;
    }
}

export function getDeviceSessionId() {
    return _sessionId || (_status && _status.session) || null;
}

// ---------------------------------------------------------------------------
// Pannello Dispositivo
// ---------------------------------------------------------------------------
function setDevicePanelOpen(open) {
    _panelOpen = open;
    const panel = document.getElementById('panel-device');
    const btn = document.getElementById('btn-device-panel');
    if (!panel) return;
    panel.classList.toggle('-translate-x-[26rem]', !open);
    btn?.classList.toggle('bg-blue-600', open);
    btn?.classList.toggle('text-white', open);
    if (open) {
        renderDevicePanel();
        if (_connected) loadDeviceSessions().catch(() => { });
    }
}

export function toggleDevicePanel() { setDevicePanelOpen(!_panelOpen); }

function updateToolbarIndicator() {
    const dot = document.getElementById('device-panel-indicator');
    if (!dot) return;
    dot.classList.remove('bg-gray-600', 'bg-emerald-500', 'bg-red-500', 'animate-pulse');
    if (!_connected) dot.classList.add('bg-gray-600');
    else if (!_online) { dot.classList.add('bg-red-500'); }
    else if (_status?.rec) { dot.classList.add('bg-red-500', 'animate-pulse'); }
    else dot.classList.add('bg-emerald-500');

    const connBtn = document.getElementById('btn-device-connect');
    if (connBtn) {
        connBtn.textContent = _connecting ? 'Connessione...' : (_connected ? 'Disconnetti' : 'Connetti automaticamente');
        connBtn.disabled = _connecting;
        connBtn.classList.toggle('opacity-70', _connecting);
    }
    const connDot = document.getElementById('device-conn-state');
    if (connDot) {
        connDot.className = 'w-2.5 h-2.5 rounded-full ' +
            (!_connected ? 'bg-gray-600' : _online ? 'bg-emerald-500' : 'bg-red-500 animate-pulse');
    }
}

function isDeviceSettingsEditing() {
    const active = document.activeElement;
    return _settingsFormDirty ||
        _settingsFormFocused ||
        Boolean(active && active.closest && active.closest('#device-settings-form'));
}

function row(label, value, valueClass = 'text-gray-100') {
    return `<div class="flex justify-between items-baseline gap-3 py-1 border-b border-gray-800/60 last:border-0">
        <span class="text-[11px] uppercase tracking-wide text-gray-500">${label}</span>
        <span class="text-sm font-semibold ${valueClass}">${value}</span></div>`;
}

function sectionCard(title, icon, inner) {
    return `<section class="bg-gray-900/70 border border-gray-800 rounded-xl p-3 space-y-1">
        <div class="flex items-center gap-2 mb-1">
            <i data-lucide="${icon}" class="w-4 h-4 text-cyan-400"></i>
            <h3 class="text-xs font-bold uppercase tracking-wider text-gray-300">${title}</h3>
        </div>${inner}</section>`;
}

function selected(value, current) {
    return String(value) === String(current) ? 'selected' : '';
}

function checked(value) {
    return value ? 'checked' : '';
}

function settingInput(name, value, attrs = '') {
    return `<input name="${name}" value="${esc(value)}" ${attrs}
        class="w-full bg-gray-950 border border-gray-800 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-600">`;
}

function settingColorInput(name, value) {
    const normalized = /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : '#38bdf8';
    return `<input name="${name}" value="${esc(normalized)}" type="color"
        class="w-full h-[31px] bg-gray-950 border border-gray-800 rounded-lg px-1 py-1 cursor-pointer">`;
}

function rescaleVibrationStepsFromMax(form) {
    const maxInput = form?.querySelector('[name="vibrationStep20"]');
    const maxValue = Number(maxInput?.value);
    if (!Number.isFinite(maxValue) || maxValue <= 0) return;
    const maxClamped = Math.min(30, Math.max(0.05, maxValue));
    for (let level = 1; level < 20; level++) {
        const input = form.querySelector(`[name="vibrationStep${String(level).padStart(2, '0')}"]`);
        if (!input) continue;
        input.value = (maxClamped * level / 20).toFixed(2);
    }
}

function estimatedRecordHzFromSettings(settings = _settings) {
    const gpsRate = Math.min(10, Math.max(1, Number(settings?.gps?.rate) || Number(_status?.rate) || 10));
    const profile = settings?.recording?.profile || 'standard';
    if (profile === 'dense') return gpsRate;
    if (profile === 'eco') return Math.min(gpsRate, 2);
    return Math.min(gpsRate, 5);
}

function estimatedKbPerHourFromSettings(settings = _settings) {
    const reported = Number(settings?.recording?.estimatedKbPerHour);
    if (Number.isFinite(reported) && reported > 0) return reported;
    const envBytes = settings?.recording?.envLog === false ? 0 : 4320;
    return Math.ceil(((estimatedRecordHzFromSettings(settings) * STORED_RECORD_SIZE * 3600) + envBytes) / 1024);
}

function formatHours(value) {
    const hours = Number(value);
    if (!Number.isFinite(hours) || hours <= 0) return '—';
    return hours < 10 ? hours.toFixed(1) : String(Math.round(hours));
}

function renderDeviceSyncCard() {
    const state = _autoSyncing || _syncStats.state === 'syncing' ?
        'Sincronizzazione in corso' :
        (_syncStats.state === 'error' ? 'Errore sync' : 'Pronto');
    const stateClass = _syncStats.state === 'error' ? 'text-red-400' :
        (_autoSyncing || _syncStats.state === 'syncing' ? 'text-cyan-300' : 'text-emerald-400');
    const lastRun = _syncStats.lastRunAt ?
        new Date(_syncStats.lastRunAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) :
        'mai';
    const errorRow = _syncStats.lastError ?
        row('Ultimo errore', esc(_syncStats.lastError), 'text-red-400') :
        '';

    return sectionCard('Sync telefono', 'smartphone', `
        ${row('Stato', state, stateClass)}
        ${row('Logger', `${_syncStats.loggerSessions || (Array.isArray(_sessions) ? _sessions.length : 0)} sessioni`)}
        ${row('Telefono', `${_syncStats.localSessions} sessioni salvate`)}
        ${row('Coda', `${_syncStats.queued} mancanti · ${_syncStats.skipped} già presenti`)}
        ${row('Memoria liberata', `${_syncStats.deleted} sessioni`)}
        ${row('Ultimo controllo', lastRun)}
        ${errorRow}`);
}

function renderDeviceSettingsCard() {
    if (!_settings) {
        return sectionCard('Impostazioni logger', 'sliders-horizontal',
            `<p class="text-xs text-gray-500">Impostazioni non ancora caricate.</p>
             <button onclick="window.loadDeviceSettings()" class="mt-2 w-full py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 text-xs font-semibold text-gray-300">Carica impostazioni</button>`);
    }
    const gps = _settings.gps || {};
    const offsets = _settings.offsets || {};
    const vibration = _settings.vibration || {};
    const rec = _settings.recording || {};
    const display = _settings.display || {};
    const visual = _settings.visual || {};
    const visualSpeed = visual.speed || {};
    const visualVibration = visual.vibration || {};
    const defaultVibrationStepMax = (Number(vibration.alertMps2) || 4) /
        (0.70 + (Number(vibration.sensitivity) || 3) * 0.15);
    const vibrationSteps = Array.from({ length: 20 }, (_, index) => {
        const fromSettings = Number(visualVibration.stepsMps2?.[index]);
        return Number.isFinite(fromSettings) && fromSettings > 0 ?
            fromSettings :
            defaultVibrationStepMax * (index + 1) / 20;
    });
    const vibrationStepInputs = vibrationSteps.map((value, index) => {
        const level = index + 1;
        const name = `vibrationStep${String(level).padStart(2, '0')}`;
        return `<label class="space-y-1">
            <span class="text-[9px] text-gray-500 uppercase font-semibold">Liv ${level}</span>
            ${settingInput(name, Number(value).toFixed(2), 'type="number" min="0.05" max="30" step="0.05"')}
        </label>`;
    }).join('');
    const estHz = Number(rec.estimatedHz) || estimatedRecordHzFromSettings(_settings);
    const estKbHour = Number(rec.estimatedKbPerHour) || estimatedKbPerHourFromSettings(_settings);
    const gnssOptions = [
        [1, 'GPS'],
        [2, 'BDS'],
        [3, 'GPS+BDS'],
        [4, 'GLONASS'],
        [5, 'GPS+GLO'],
        [6, 'BDS+GLO'],
        [7, 'GPS+BDS+GLO']
    ];
    const nmeaOptions = [
        [0, 'compact'],
        [1, 'nav'],
        [2, 'diag'],
        [3, 'full']
    ];
    const nmeaVersionOptions = [
        [2, 'NMEA 4.1+'],
        [5, 'Dual 2.3/4.0'],
        [9, 'GPS 2.2']
    ];
    const baudOptions = [4800, 9600, 19200, 38400, 57600, 115200];
    return sectionCard('Impostazioni logger', 'sliders-horizontal', `
        <form id="device-settings-form" class="space-y-3">
            <div class="grid grid-cols-2 gap-2">
                <label class="space-y-1">
                    <span class="text-[9px] text-gray-500 uppercase font-semibold">GPS rate</span>
                    <select name="gpsRate" class="w-full bg-gray-950 border border-gray-800 rounded-lg px-2 py-1.5 text-xs text-white">
                        ${[1, 2, 5, 10].map(hz => `<option value="${hz}" ${selected(hz, gps.rate)}>${hz} Hz</option>`).join('')}
                    </select>
                </label>
                <label class="space-y-1">
                    <span class="text-[9px] text-gray-500 uppercase font-semibold">Sistema</span>
                    <select name="gpsGnssMode" class="w-full bg-gray-950 border border-gray-800 rounded-lg px-2 py-1.5 text-xs text-white">
                        ${gnssOptions.map(([value, label]) => `<option value="${value}" ${selected(value, gps.gnssMode ?? 7)}>${label}</option>`).join('')}
                    </select>
                </label>
                <label class="space-y-1">
                    <span class="text-[9px] text-gray-500 uppercase font-semibold">NMEA out</span>
                    <select name="gpsNmeaProfile" class="w-full bg-gray-950 border border-gray-800 rounded-lg px-2 py-1.5 text-xs text-white">
                        ${nmeaOptions.map(([value, label]) => `<option value="${value}" ${selected(value, gps.nmeaProfileId ?? 0)}>${label}</option>`).join('')}
                    </select>
                </label>
                <label class="space-y-1">
                    <span class="text-[9px] text-gray-500 uppercase font-semibold">UART baud</span>
                    <select name="gpsBaud" class="w-full bg-gray-950 border border-gray-800 rounded-lg px-2 py-1.5 text-xs text-white">
                        ${baudOptions.map(baud => `<option value="${baud}" ${selected(baud, gps.baud ?? 115200)}>${baud}</option>`).join('')}
                    </select>
                </label>
                <label class="space-y-1">
                    <span class="text-[9px] text-gray-500 uppercase font-semibold">NMEA ver</span>
                    <select name="gpsNmeaVersion" class="w-full bg-gray-950 border border-gray-800 rounded-lg px-2 py-1.5 text-xs text-white">
                        ${nmeaVersionOptions.map(([value, label]) => `<option value="${value}" ${selected(value, gps.nmeaVersionId ?? 2)}>${label}</option>`).join('')}
                    </select>
                </label>
                <label class="space-y-1">
                    <span class="text-[9px] text-gray-500 uppercase font-semibold">Standby s</span>
                    ${settingInput('gpsStandbySec', gps.standbySec ?? 60, 'id="device-gps-standby-sec" type="number" min="1" max="65535" step="1"')}
                </label>
                <label class="space-y-1">
                    <span class="text-[9px] text-gray-500 uppercase font-semibold">Filtro GPS</span>
                    <select name="gpsFilter" class="w-full bg-gray-950 border border-gray-800 rounded-lg px-2 py-1.5 text-xs text-white">
                        ${['off', 'soft', 'medium', 'strong'].map(v => `<option value="${v}" ${selected(v, gps.filter)}>${v}</option>`).join('')}
                    </select>
                </label>
                <label class="space-y-1">
                    <span class="text-[9px] text-gray-500 uppercase font-semibold">HDOP max</span>
                    ${settingInput('gpsHdopMax', gps.hdopMax ?? 2.5, 'type="number" min="0.8" max="9.9" step="0.1"')}
                </label>
                <label class="space-y-1">
                    <span class="text-[9px] text-gray-500 uppercase font-semibold">Vel min km/h</span>
                    ${settingInput('gpsMinSpeedKmh', gps.minSpeedKmh ?? 1.5, 'type="number" min="0" max="20" step="0.1"')}
                </label>
            </div>

            <div class="grid grid-cols-3 gap-2 border-t border-gray-800 pt-3">
                <button type="button" onclick="window.saveGpsReceiverConfig()" class="py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 text-[11px] font-semibold text-cyan-300">Salva GPS</button>
                <button type="button" onclick="window.restartGpsReceiver('hot')" class="py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 text-[11px] font-semibold text-gray-200">Hot restart</button>
                <button type="button" onclick="window.restartGpsReceiver('warm')" class="py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 text-[11px] font-semibold text-gray-200">Warm restart</button>
                <button type="button" onclick="window.restartGpsReceiver('cold')" class="py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 text-[11px] font-semibold text-gray-200">Cold restart</button>
                <button type="button" onclick="window.standbyGpsReceiver()" class="col-span-2 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 text-[11px] font-semibold text-amber-300">Standby GPS</button>
            </div>

            <div class="grid grid-cols-3 gap-2 border-t border-gray-800 pt-3">
                <label class="space-y-1"><span class="text-[9px] text-gray-500 uppercase font-semibold">Off quota</span>${settingInput('altitudeOffsetM', offsets.altitudeM ?? 0, 'type="number" step="1"')}</label>
                <label class="space-y-1"><span class="text-[9px] text-gray-500 uppercase font-semibold">Off pitch</span>${settingInput('pitchOffsetDeg', offsets.pitchDeg ?? 0, 'type="number" step="0.5"')}</label>
                <label class="space-y-1"><span class="text-[9px] text-gray-500 uppercase font-semibold">Off roll</span>${settingInput('rollOffsetDeg', offsets.rollDeg ?? 0, 'type="number" step="0.5"')}</label>
                <label class="space-y-1"><span class="text-[9px] text-gray-500 uppercase font-semibold">Off temp</span>${settingInput('tempOffsetC', offsets.tempC ?? 0, 'type="number" step="0.1"')}</label>
                <label class="space-y-1 col-span-2"><span class="text-[9px] text-gray-500 uppercase font-semibold">Off pressione Pa</span>${settingInput('pressureOffsetPa', offsets.pressurePa ?? 0, 'type="number" step="10"')}</label>
            </div>

            <div class="grid grid-cols-3 gap-2 border-t border-gray-800 pt-3">
                <label class="space-y-1"><span class="text-[9px] text-gray-500 uppercase font-semibold">Vib sens</span>${settingInput('vibrationSensitivity', vibration.sensitivity ?? 3, 'type="number" min="1" max="5" step="1"')}</label>
                <label class="space-y-1"><span class="text-[9px] text-gray-500 uppercase font-semibold">Vib risposta</span>${settingInput('vibrationResponse', vibration.response ?? 4, 'type="number" min="1" max="5" step="1"')}</label>
                <label class="space-y-1"><span class="text-[9px] text-gray-500 uppercase font-semibold">Soglia vib</span>${settingInput('vibrationAlertMps2', vibration.alertMps2 ?? 4, 'type="number" min="1" max="12" step="0.5"')}</label>
            </div>

            <div class="grid grid-cols-3 gap-2 border-t border-gray-800 pt-3">
                <div class="col-span-3 text-[10px] uppercase tracking-wide text-gray-500 font-bold">Colori velocità</div>
                <label class="space-y-1"><span class="text-[9px] text-gray-500 uppercase font-semibold">Bassa km/h</span>${settingInput('speedLowKmh', visualSpeed.lowKmh ?? 35, 'type="number" min="0" max="250" step="1"')}</label>
                <label class="space-y-1"><span class="text-[9px] text-gray-500 uppercase font-semibold">Media km/h</span>${settingInput('speedMediumKmh', visualSpeed.mediumKmh ?? 90, 'type="number" min="0" max="280" step="1"')}</label>
                <label class="space-y-1"><span class="text-[9px] text-gray-500 uppercase font-semibold">Alta km/h</span>${settingInput('speedHighKmh', visualSpeed.highKmh ?? 140, 'type="number" min="0" max="320" step="1"')}</label>
                <label class="space-y-1"><span class="text-[9px] text-gray-500 uppercase font-semibold">Col bassa</span>${settingColorInput('speedLowColor', visualSpeed.lowColor ?? '#38bdf8')}</label>
                <label class="space-y-1"><span class="text-[9px] text-gray-500 uppercase font-semibold">Col media</span>${settingColorInput('speedMediumColor', visualSpeed.mediumColor ?? '#f59e0b')}</label>
                <label class="space-y-1"><span class="text-[9px] text-gray-500 uppercase font-semibold">Col alta</span>${settingColorInput('speedHighColor', visualSpeed.highColor ?? '#ef4444')}</label>
            </div>

            <div class="grid grid-cols-3 gap-2 border-t border-gray-800 pt-3">
                <div class="col-span-3 text-[10px] uppercase tracking-wide text-gray-500 font-bold">Scala vibrazioni</div>
                <label class="space-y-1"><span class="text-[9px] text-gray-500 uppercase font-semibold">Bassa liv</span>${settingInput('vibrationLowLevel', visualVibration.lowLevel ?? 5, 'type="number" min="1" max="20" step="1"')}</label>
                <label class="space-y-1"><span class="text-[9px] text-gray-500 uppercase font-semibold">Media liv</span>${settingInput('vibrationMediumLevel', visualVibration.mediumLevel ?? 12, 'type="number" min="1" max="20" step="1"')}</label>
                <label class="space-y-1"><span class="text-[9px] text-gray-500 uppercase font-semibold">Alta liv</span>${settingInput('vibrationHighLevel', visualVibration.highLevel ?? 18, 'type="number" min="1" max="20" step="1"')}</label>
                <label class="space-y-1"><span class="text-[9px] text-gray-500 uppercase font-semibold">Col bassa</span>${settingColorInput('vibrationLowColor', visualVibration.lowColor ?? '#38bdf8')}</label>
                <label class="space-y-1"><span class="text-[9px] text-gray-500 uppercase font-semibold">Col media</span>${settingColorInput('vibrationMediumColor', visualVibration.mediumColor ?? '#f59e0b')}</label>
                <label class="space-y-1"><span class="text-[9px] text-gray-500 uppercase font-semibold">Col alta</span>${settingColorInput('vibrationHighColor', visualVibration.highColor ?? '#ef4444')}</label>
            </div>

            <div class="grid grid-cols-4 gap-2 border-t border-gray-800 pt-3">
                <div class="col-span-4 text-[10px] uppercase tracking-wide text-gray-500 font-bold">Gradini vibrazioni m/s²</div>
                ${vibrationStepInputs}
            </div>

            <div class="grid grid-cols-2 gap-2 border-t border-gray-800 pt-3">
                <label class="space-y-1">
                    <span class="text-[9px] text-gray-500 uppercase font-semibold">Profilo REC</span>
                    <select name="recProfile" class="w-full bg-gray-950 border border-gray-800 rounded-lg px-2 py-1.5 text-xs text-white">
                        ${['eco', 'standard', 'dense'].map(v => `<option value="${v}" ${selected(v, rec.profile)}>${v}</option>`).join('')}
                    </select>
                </label>
                <label class="space-y-1"><span class="text-[9px] text-gray-500 uppercase font-semibold">Flush ms</span>${settingInput('recFlushMs', rec.flushMs ?? 500, 'type="number" min="100" max="5000" step="100"')}</label>
                <div class="col-span-2 grid grid-cols-2 gap-2 text-[11px]">
                    <div class="bg-gray-950 border border-gray-800 rounded-lg px-2 py-1.5">
                        <span class="text-gray-500 uppercase font-semibold">Scrittura</span>
                        <span class="block text-cyan-300 font-semibold">${estHz.toFixed(1)} Hz</span>
                    </div>
                    <div class="bg-gray-950 border border-gray-800 rounded-lg px-2 py-1.5">
                        <span class="text-gray-500 uppercase font-semibold">Consumo</span>
                        <span class="block text-cyan-300 font-semibold">${Math.round(estKbHour)} KB/h</span>
                    </div>
                </div>
                <label class="flex items-center justify-between gap-2 text-xs text-gray-300"><span>Autostart REC</span><input name="recAutoStart" type="checkbox" class="accent-cyan-500" ${checked(rec.autoStart)}></label>
                <label class="flex items-center justify-between gap-2 text-xs text-gray-300"><span>Log ENV</span><input name="recEnvLog" type="checkbox" class="accent-cyan-500" ${checked(rec.envLog !== false)}></label>
                <label class="flex items-center justify-between gap-2 text-xs text-gray-300 col-span-2"><span>Inverti assi IMU</span><input name="invertImuAxes" type="checkbox" class="accent-cyan-500" ${checked(offsets.invertImuAxes)}></label>
            </div>

            <div class="grid grid-cols-3 gap-2 border-t border-gray-800 pt-3">
                <label class="space-y-1"><span class="text-[9px] text-gray-500 uppercase font-semibold">Luminosita</span>${settingInput('displayBright', display.brightness ?? 120, 'type="number" min="20" max="255" step="5"')}</label>
                <label class="space-y-1"><span class="text-[9px] text-gray-500 uppercase font-semibold">Timeout s</span>${settingInput('displayDimSec', display.dimSec ?? 30, 'type="number" min="5" max="300" step="5"')}</label>
                <label class="space-y-1"><span class="text-[9px] text-gray-500 uppercase font-semibold">Pagina start</span>${settingInput('displayStartPage', Math.min(5, Math.max(0, Number(display.startPage) || 0)), 'type="number" min="0" max="5" step="1"')}</label>
            </div>

            ${renderDeviceSettingsFeedback()}
            <button id="device-settings-save-button" type="submit" ${_settingsSaveBusy ? 'disabled' : ''}
                class="w-full py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-white text-xs font-bold disabled:opacity-60 disabled:cursor-wait">${_settingsSaveBusy ? 'Salvataggio...' : 'Salva impostazioni'}</button>
        </form>`);
}

function bindDeviceSettingsForm() {
    const form = document.getElementById('device-settings-form');
    if (!form) return;
    _settingsFormFocused = form.contains(document.activeElement);
    form.addEventListener('focusin', () => {
        _settingsFormFocused = true;
        markDevicePanelInteraction();
    });
    form.addEventListener('focusout', () => {
        setTimeout(() => {
            _settingsFormFocused = form.contains(document.activeElement);
            if (!_settingsFormFocused && !_settingsFormDirty && _pendingSettingsFromDevice) {
                applyDeviceSettings(_pendingSettingsFromDevice, { force: true });
                renderDevicePanel();
            }
        }, 0);
    });
    form.addEventListener('input', () => {
        markDeviceSettingsDirty();
    });
    form.addEventListener('change', () => {
        markDeviceSettingsDirty();
    });
    const maxVibrationStep = form.querySelector('[name="vibrationStep20"]');
    if (maxVibrationStep) {
        const handleMaxVibrationStep = () => {
            rescaleVibrationStepsFromMax(form);
            markDeviceSettingsDirty();
        };
        maxVibrationStep.addEventListener('input', handleMaxVibrationStep);
        maxVibrationStep.addEventListener('change', handleMaxVibrationStep);
    }
    form.addEventListener('submit', event => {
        event.preventDefault();
        saveDeviceSettings();
    });
}

function renderDevicePanel(options = {}) {
    if (isDeviceSettingsEditing() && options.allowSettingsRender !== true) {
        updateToolbarIndicator();
        return;
    }
    if (!options.force && shouldDeferDevicePanelRender()) {
        if (!_panelRenderTimer) {
            _panelRenderTimer = setTimeout(() => {
                _panelRenderTimer = null;
                renderDevicePanel({ force: true });
            }, Math.max(80, _panelInteractionUntil - Date.now() + 40));
        }
        updateToolbarIndicator();
        return;
    }
    if (!_panelOpen) { updateToolbarIndicator(); return; }
    const body = document.getElementById('device-panel-live');
    if (!body) return;
    const s = _status;

    if (!_connected) {
        const attempts = _lastConnectionAttempts.length ?
            `<div class="mt-3 text-left bg-gray-900/70 border border-gray-800 rounded-xl p-3 space-y-2">
                <div class="text-xs font-bold uppercase tracking-wide text-red-300">${esc(_lastConnectionError || 'Connessione non riuscita')}</div>
                ${_lastConnectionAttempts.map(item => row(esc(item.url), esc(item.error), 'text-red-300')).join('')}
                <button onclick="window.openLoggerInterface()" class="mt-2 w-full py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-white text-xs font-bold">Apri interfaccia logger</button>
            </div>` : '';
        body.innerHTML = `<div class="text-center text-gray-500 text-sm py-8 px-4 space-y-2">
            <i data-lucide="router" class="w-8 h-8 mx-auto text-gray-600"></i>
            <p>Nessuno strumento collegato.</p>
            <p class="text-xs">Collega il telefono alla WiFi <b class="text-gray-300">GPXLogger</b>: l'app cerca automaticamente <b class="text-gray-300">gpx.local</b> e <b class="text-gray-300">192.168.4.1</b>.</p>
            ${attempts}
        </div>`;
        ensureLucideIcons();
        return;
    }
    if (!s) { body.innerHTML = '<div class="text-center text-gray-500 text-sm py-8">Lettura stato...</div>'; return; }

    const recBtn = s.rec ?
        `<button onclick="window.toggleDeviceRecording()" class="w-full py-3 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold flex items-center justify-center gap-2 transition-all">
            <span class="w-3 h-3 rounded-sm bg-white"></span>FERMA REGISTRAZIONE</button>` :
        `<button onclick="window.toggleDeviceRecording()" class="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold flex items-center justify-center gap-2 transition-all">
            <span class="w-3 h-3 rounded-full bg-white animate-pulse"></span>AVVIA REGISTRAZIONE</button>`;

    const flashPct = Number(s.flashUsedPct) || 0;
    const estimatedKbHour = Number(s.flashKbPerHour) || estimatedKbPerHourFromSettings(_settings);
    const estimatedHours = Number(s.flashEstHours) ||
        ((Number(s.flashFreeKb) || 0) / Math.max(1, estimatedKbHour));
    const recProfileLabel = _settings?.recording?.profile || 'standard';
    const batt = Number(s.batt) || 0;

    const strumento = sectionCard('Strumento', 'router', `
        ${recBtn}
        <div class="pt-2">
        ${row('Stato', s.rec ? `REC · ${esc(s.session)}` : 'Standby', s.rec ? 'text-red-400' : 'text-gray-300')}
        ${row('Batteria', `${batt}%${s.charging ? ' · in carica' : ''}`, batt > 25 ? 'text-emerald-400' : 'text-red-400')}
        ${row('Flash', `${flashPct}% usata · ~${formatHours(estimatedHours)} h`, flashPct < 85 ? 'text-gray-100' : 'text-amber-400')}
        ${row('Stima REC', `${recProfileLabel} · ${Math.round(estimatedKbHour)} KB/h`)}
        ${row('Client WiFi', esc(s.clients))}
        ${row('Record ricevuti', String(_lastSeq))}
        </div>`);
    const syncCard = renderDeviceSyncCard();

    const gpsDiag = s.gps || {};
    const gpsAge = Number.isFinite(gpsDiag.fixAgeMs) && gpsDiag.fixAgeMs > 0 ?
        `${Math.round(gpsDiag.fixAgeMs / 1000)} s` : '—';
    const gpsNmeaOk = Number(gpsDiag.nmeaOk) || 0;
    const gpsNmeaErr = Number(gpsDiag.nmeaErr) || 0;
    const gpsErrPct = (gpsNmeaOk + gpsNmeaErr) > 0 ?
        Math.round(gpsNmeaErr * 100 / (gpsNmeaOk + gpsNmeaErr)) : 0;
    const gpsUartOk = Number(gpsDiag.chars) > 0;
    const gpsCfg = _settings?.gps || {};
    const gps = sectionCard('Sensore GPS · AT6668', 'satellite', `
        ${row('Modulo GPS', gpsUartOk ? 'UART OK · dati ricevuti' : 'NO UART · nessun dato', gpsUartOk ? 'text-emerald-400' : 'text-red-400')}
        ${row('Fix', s.fix ? '3D attivo' : 'assente', s.fix ? 'text-emerald-400' : 'text-amber-400')}
        ${row('HDOP', Number(s.hdop).toFixed(1), Number(s.hdop) < 2 ? 'text-emerald-400' : 'text-amber-400')}
        ${row('Posizione', s.fix ? `${Number(s.lat).toFixed(5)}, ${Number(s.lon).toFixed(5)}` : '—')}
        ${row('Velocità', `${Number(s.speed).toFixed(1)} km/h`)}
        ${row('Rotta GPS', Number(s.course) >= 0 ? `${Number(s.course).toFixed(0)}°` : '—')}
        ${row('Età fix', gpsAge)}
        ${row('NMEA RX', gpsDiag.chars !== undefined ? `${gpsDiag.chars} char · ${gpsDiag.nmeaFix || 0} fix` : '—')}
        ${row('Checksum', gpsDiag.nmeaOk !== undefined ? `${gpsNmeaOk} ok · ${gpsErrPct}% err` : '—', gpsErrPct > 5 ? 'text-red-400' : (gpsErrPct > 0 ? 'text-amber-400' : 'text-emerald-400'))}
        ${row('Sistema', gpsCfg.gnss ? esc(gpsCfg.gnss).toUpperCase() : '—')}
        ${row('NMEA out', gpsCfg.nmeaProfile ? esc(gpsCfg.nmeaProfile) : '—')}
        ${row('UART', gpsCfg.baud ? `${Number(gpsCfg.baud)} bps` : '—')}
        <div class="flex items-center justify-between pt-2">
            <span class="text-[11px] uppercase tracking-wide text-gray-500">Frequenza</span>
            <select onchange="window.setDeviceRate(this.value)" class="bg-gray-800 border border-gray-700 rounded-lg text-sm px-2 py-1">
                ${[1, 2, 5, 10].map(hz => `<option value="${hz}" ${Number(s.rate) === hz ? 'selected' : ''}>${hz} Hz</option>`).join('')}
            </select>
        </div>`);
    const settingsCard = renderDeviceSettingsCard();

    const imu = s.imu || {};
    const imuCard = sectionCard('Sensore IMU · BMI270', 'move-3d', `
        ${row('Pitch', `${Number(imu.pitch ?? 0).toFixed(0)}°`)}
        ${row('Roll', `${Number(imu.roll ?? 0).toFixed(0)}°`)}
        ${row('G laterale', `${Number(imu.latG ?? 0).toFixed(2)} g`)}
        ${row('G longitudinale', `${Number(imu.longG ?? 0).toFixed(2)} g`)}
        <button onclick="window.calibrateDeviceImu()" class="mt-2 w-full py-2 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 text-sm font-semibold text-cyan-300 transition-all">
            Calibra assetto (veicolo in piano)</button>`);

    const env = s.env || {};
    const envTemp = Number(env.temp);
    const envHum = Number(env.hum);
    const envPress = Number(env.press);
    const envThermo = Boolean(env.thermo ?? env.ok);
    const envBaro = Boolean(env.baro ?? (Number.isFinite(envPress) && envPress > 0));
    const envCard = sectionCard('Sensore ambiente · ENV III', 'thermometer', env.ok ? `
        ${row('Termoigrometro', envThermo ? 'presente' : 'assente', envThermo ? 'text-emerald-400' : 'text-amber-400')}
        ${row('Barometro', envBaro ? 'presente' : 'assente', envBaro ? 'text-emerald-400' : 'text-amber-400')}
        ${row('Temperatura', envThermo && Number.isFinite(envTemp) ? `${envTemp.toFixed(1)} °C` : '--', envTemp > 45 ? 'text-red-400' : 'text-gray-100')}
        ${row('Umidità', envThermo && Number.isFinite(envHum) ? `${envHum.toFixed(0)} %` : '--')}
        ${row('Pressione', envBaro && Number.isFinite(envPress) ? `${(envPress / 100).toFixed(1)} hPa` : '--')}
        ${row('Quota', `${Number(s.ele).toFixed(0)} m (${envBaro ? 'GPS+baro' : 'solo GPS'})`)}` :
        `<p class="text-xs text-gray-500">ENV III non rilevata: quota dalla sola antenna GPS.</p>
        ${row('Quota GPS', `${Number(s.ele).toFixed(0)} m`)}`);

    const telefono = sectionCard('Telefono', 'smartphone', `
        <p class="text-xs text-emerald-300/90 leading-relaxed">GPS, bussola e accelerometro del telefono sono
        <b>disattivati</b>: posizione, assetto e vibrazioni arrivano dallo strumento. Zero batteria, zero surriscaldamento.</p>`);

    let sessioniInner = '<p class="text-xs text-gray-500">Nessuna sessione in memoria.</p>';
    if (Array.isArray(_sessions) && _sessions.length) {
        sessioniInner = _sessions.slice().reverse().map(item => {
            const sid = esc(item.id);
            return `<div class="flex items-center justify-between gap-2 py-1.5 border-b border-gray-800/60 last:border-0">
                <div class="min-w-0">
                    <div class="text-sm font-semibold ${item.active ? 'text-red-400' : 'text-gray-100'} truncate">${sid}${item.active ? ' · REC' : ''}</div>
                    <div class="text-[11px] text-gray-500">${Number(item.records).toLocaleString('it-IT')} punti</div>
                </div>
                <div class="flex gap-1 shrink-0">
                    <button onclick="window.importDeviceSession('${sid}')" title="Importa in GPXSuite"
                        class="w-7 h-7 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 flex items-center justify-center text-cyan-300"><i data-lucide="download" class="w-3.5 h-3.5"></i></button>
                    ${item.active ? '' : `<button onclick="window.deleteDeviceSession('${sid}')" title="Elimina dalla flash"
                        class="w-7 h-7 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 flex items-center justify-center text-red-400"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>`}
                </div></div>`;
        }).join('');
    }
    const sessioni = sectionCard('Sessioni sul dispositivo', 'hard-drive', `${sessioniInner}
        <button onclick="window.loadDeviceSessions()" class="mt-2 w-full py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 text-xs font-semibold text-gray-300 transition-all">Aggiorna elenco</button>`);

    body.innerHTML = `<div class="space-y-3 p-3">${strumento}${syncCard}${gps}${settingsCard}${imuCard}${envCard}${telefono}${sessioni}</div>`;
    bindDeviceSettingsForm();
    ensureLucideIcons();
    updateToolbarIndicator();
}
