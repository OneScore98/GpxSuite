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

const DEVICE_URL_KEY = 'gpxsuite-device-url-v1';
const DEVICE_AUTOCONNECT_KEY = 'gpxsuite-device-autoconnect-v1';
const RECORD_SIZE = 24;
const STATUS_POLL_MS = 2500;
const RECONNECT_MS = 4000;
const MAP_REFRESH_THROTTLE_MS = 700;
const LOGGER_TRACK_COLOR = '#f97316';

let _deps = {};
let _baseUrl = null;            // "http://192.168.4.1" (senza slash finale)
let _connected = false;         // intento dell'utente
let _online = false;            // raggiungibilita' effettiva
let _status = null;             // ultimo /status
let _sessions = null;           // ultima lista /sessions
let _sessionId = null;          // sessione REC corrente
let _lastSeq = 0;
let _ws = null;
let _pollTimer = null;
let _reconnectTimer = null;
let _pollFailures = 0;
let _mapRefreshTimer = null;
let _mapRefreshLast = 0;
let _panelOpen = false;
let _visibilityBound = false;
let _syncing = false;

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function notify(msg, kind = 'info') { _deps.showToast?.(msg, kind); }

// ---------------------------------------------------------------------------
// Init e binding UI statica
// ---------------------------------------------------------------------------
export function initDeviceModule(deps = {}) {
    _deps = deps;

    document.getElementById('btn-device-panel')?.addEventListener('click', toggleDevicePanel);
    document.getElementById('btn-close-device-panel')?.addEventListener('click', () => setDevicePanelOpen(false));
    document.getElementById('btn-device-connect')?.addEventListener('click', () => {
        if (_connected) { disconnectDevice(); return; }
        const input = document.getElementById('device-url-input');
        connectDevice(input ? input.value : '');
    });
    document.getElementById('device-autoconnect')?.addEventListener('change', e => {
        try { localStorage.setItem(DEVICE_AUTOCONNECT_KEY, e.target.checked ? '1' : '0'); } catch (err) {}
    });

    // Ripristino preferenze
    let savedUrl = '';
    let autoconnect = false;
    try {
        savedUrl = localStorage.getItem(DEVICE_URL_KEY) || '';
        autoconnect = localStorage.getItem(DEVICE_AUTOCONNECT_KEY) === '1';
    } catch (err) {}
    const input = document.getElementById('device-url-input');
    if (input && savedUrl) input.value = savedUrl;
    const autoBox = document.getElementById('device-autoconnect');
    if (autoBox) autoBox.checked = autoconnect;

    if (!_visibilityBound) {
        _visibilityBound = true;
        document.addEventListener('visibilitychange', () => {
            // Riallineamento dopo sblocco telefono: backlog dal seq gia' ricevuto
            if (document.visibilityState === 'visible' && _connected) {
                fetchStatus().then(applyStatus).catch(() => {});
                syncBacklog();
            }
        });
    }

    // Modalita' logger: app servita direttamente dal dispositivo
    const host = location.hostname;
    if (host === 'gpx.local' || host === '192.168.4.1') {
        connectDevice(location.origin);
    } else if (autoconnect && savedUrl) {
        connectDevice(savedUrl, { silent: true });
    }
    updateToolbarIndicator();
}

export function isDeviceConnected() { return _connected && _online; }

// ---------------------------------------------------------------------------
// Connessione
// ---------------------------------------------------------------------------
function normalizeUrl(raw) {
    let url = String(raw || '').trim();
    if (!url) url = '192.168.4.1';
    if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
    return url.replace(/\/+$/, '');
}

async function fetchWithTimeout(path, options = {}, timeoutMs = 4000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        return await fetch(_baseUrl + path, { ...options, signal: ctrl.signal, cache: 'no-store' });
    } finally {
        clearTimeout(timer);
    }
}

async function fetchStatus() {
    const res = await fetchWithTimeout('/status');
    if (!res.ok) throw new Error('status ' + res.status);
    return res.json();
}

export async function connectDevice(rawUrl, options = {}) {
    if (_connected) return;
    _baseUrl = normalizeUrl(rawUrl);
    if (!options.silent) notify('Connessione al dispositivo...', 'info');
    let status;
    try {
        status = await fetchStatus();
    } catch (err) {
        _baseUrl = null;
        if (!options.silent) notify('Dispositivo non raggiungibile. Sei connesso alla WiFi GPXLogger?', 'error');
        renderDevicePanel();
        return;
    }

    _connected = true;
    _online = true;
    _pollFailures = 0;
    _lastSeq = 0;
    _sessionId = null;
    try { localStorage.setItem(DEVICE_URL_KEY, _baseUrl); } catch (err) {}

    // Da qui in poi i sensori del telefono non servono piu'.
    _deps.setExternalFixProvider?.(true);
    _deps.setExternalSensorFeed?.(true);
    if (_deps.isDeviceLocationActive && !_deps.isDeviceLocationActive()) {
        _deps.startDeviceLocation?.();
    }

    applyStatus(status);
    openWebSocket();
    startPolling();
    if (status.rec) syncBacklog();          // registrazione gia' in corso: recupera tutto
    loadDeviceSessions().catch(() => {});
    notify('Strumento collegato: sensori del telefono disattivati', 'success');
    renderDevicePanel();
    updateToolbarIndicator();
}

export function disconnectDevice(options = {}) {
    if (!_connected && !_baseUrl) return;
    _connected = false;
    _online = false;
    _status = null;
    _sessions = null;
    _sessionId = null;
    stopPolling();
    clearTimeout(_reconnectTimer); _reconnectTimer = null;
    if (_ws) { try { _ws.close(); } catch (err) {} _ws = null; }

    // Ritorno ai sensori del telefono
    _deps.setExternalSensorFeed?.(false);
    _deps.setExternalFixProvider?.(false);

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
        updateToolbarIndicator();
    }
}

// ---------------------------------------------------------------------------
// Polling /status
// ---------------------------------------------------------------------------
function startPolling() {
    stopPolling();
    _pollTimer = setInterval(async() => {
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
            _lastSeq = 0;               // nuova sessione: backlog dall'inizio
            syncBacklog();
        }
    } else if (!status.rec) {
        _sessionId = null;
    }

    // Dashboard sensori con i dati del logger
    if (status.imu) {
        _deps.feedExternalDashboardSensors?.({
            pitch: status.imu.pitch,
            tilt: status.imu.roll,
            vibrationLevel: Number.isFinite(status.imu.accPeak) ?
                Math.round(1 + Math.min(status.imu.accPeak, 5.5) / 5.5 * 9) : null
        });
    }
    // Posizione anche in standby (se il WS 'pos' non arriva)
    if (status.fix && Number.isFinite(status.lat) && Number.isFinite(status.lon)) {
        _deps.feedExternalFix?.({
            lat: status.lat, lon: status.lon, ele: status.ele,
            speedMps: Number.isFinite(status.speed) ? status.speed / 3.6 : null,
            accuracy: Number.isFinite(status.hdop) ? Math.max(3, status.hdop * 4) : 5
        });
    }
    renderDevicePanel();
    updateToolbarIndicator();
}

// ---------------------------------------------------------------------------
// WebSocket /live
// ---------------------------------------------------------------------------
function openWebSocket() {
    if (!_connected || !_baseUrl) return;
    try { if (_ws) _ws.close(); } catch (err) {}
    const wsUrl = _baseUrl.replace(/^http/i, 'ws') + '/live';
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
                speedMps: Number.isFinite(msg.speed) ? msg.speed / 3.6 : null
            });
        } else if (msg.ev === 'rec_started') {
            notify(`Registrazione avviata sul dispositivo (${msg.source === 'button' ? 'pulsante' : 'app'})`, 'success');
            _sessionId = msg.session || null;
            _lastSeq = 0;
            fetchStatus().then(applyStatus).catch(() => {});
        } else if (msg.ev === 'rec_stopped') {
            notify('Registrazione fermata sul dispositivo', 'info');
            _sessionId = null;
            fetchStatus().then(applyStatus).catch(() => {});
            loadDeviceSessions().catch(() => {});
        } else if (msg.ev === 'flash_warning') {
            notify('Flash del dispositivo quasi piena: scarica le sessioni', 'error');
        } else if (msg.ev === 'battery_low') {
            notify('Batteria del dispositivo in esaurimento', 'error');
        } else if (msg.rec !== undefined) {
            applyStatus(msg);           // snapshot stato inviato alla connessione WS
        }
    };
    ws.onclose = () => {
        if (!_connected) return;
        clearTimeout(_reconnectTimer);
        _reconnectTimer = setTimeout(() => { if (_connected) openWebSocket(); }, RECONNECT_MS);
    };
    ws.onerror = () => { try { ws.close(); } catch (err) {} };
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

function ensureSessionTrack() {
    const sid = _sessionId || (_status && _status.session) || 'SESS';
    let track = tracks.find(t => t.deviceSessionId === sid);
    if (track) return track;

    _deps.saveHistoryState?.();
    const now = Date.now();
    track = {
        id: 'track_dev_' + now,
        localFileId: 'local_' + now + '_' + Math.random().toString(36).slice(2, 8),
        localCreatedAt: now,
        localUpdatedAt: now,
        localSource: 'device',
        deviceSessionId: sid,
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
            lat: r.lat,
            lon: r.lon,
            ele: r.ele,
            isUserClicked: false,
            needsElevation: false
        });
    }
    _lastSeq = fresh[fresh.length - 1].seq;
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
        vibrationLevel: Math.round(1 + Math.min(last.accPeak, 5.5) / 5.5 * 9)
    });
    scheduleMapRefresh();
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
        try { applyStatus(JSON.parse(text)); } catch (err) { fetchStatus().then(applyStatus).catch(() => {}); }
        return text;
    } catch (err) {
        notify('Dispositivo non raggiungibile', 'error');
        return null;
    }
}

export function toggleDeviceRecording() {
    if (!_status) return;
    if (_status.rec) sendCommand('STOP', 'Registrazione fermata dal telecomando');
    else sendCommand('START', 'Registrazione avviata sul dispositivo');
}

export function setDeviceRate(hz) {
    const rate = parseInt(hz, 10);
    if (!(rate >= 1 && rate <= 10)) return;
    sendCommand('SET_RATE ' + rate, `Frequenza GPS impostata a ${rate} Hz`);
}

export function calibrateDeviceImu() {
    sendCommand('CAL_IMU', 'Assetto azzerato sul dispositivo (veicolo in piano)');
}

// ---------------------------------------------------------------------------
// Libreria sessioni del dispositivo
// ---------------------------------------------------------------------------
export async function loadDeviceSessions() {
    if (!_connected) return;
    const res = await fetchWithTimeout('/sessions', {}, 8000);
    if (!res.ok) return;
    _sessions = await res.json();
    renderDevicePanel();
}

export async function importDeviceSession(sessionId) {
    if (!_connected) return;
    notify('Scarico la sessione dal dispositivo...', 'info');
    try {
        const res = await fetchWithTimeout('/download?id=' + encodeURIComponent(sessionId), {}, 30000);
        if (!res.ok) { notify('Download non riuscito', 'error'); return; }
        const xml = await res.text();
        _deps.importGPX?.(xml, sessionId + '.gpx');
    } catch (err) {
        notify('Download non riuscito', 'error');
    }
}

export async function deleteDeviceSession(sessionId) {
    if (!_connected) return;
    if (!confirm(`Eliminare la sessione ${sessionId} dalla flash del dispositivo?`)) return;
    try {
        const res = await fetchWithTimeout('/delete?id=' + encodeURIComponent(sessionId), { method: 'POST' }, 8000);
        if (res.ok) {
            notify('Sessione eliminata dal dispositivo', 'success');
            loadDeviceSessions().catch(() => {});
        } else {
            notify('Eliminazione non riuscita: ' + await res.text(), 'error');
        }
    } catch (err) {
        notify('Dispositivo non raggiungibile', 'error');
    }
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
        if (_connected) loadDeviceSessions().catch(() => {});
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
    if (connBtn) connBtn.textContent = _connected ? 'Disconnetti' : 'Connetti';
    const connDot = document.getElementById('device-conn-state');
    if (connDot) {
        connDot.className = 'w-2.5 h-2.5 rounded-full ' +
            (!_connected ? 'bg-gray-600' : _online ? 'bg-emerald-500' : 'bg-red-500 animate-pulse');
    }
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

function renderDevicePanel() {
    if (!_panelOpen) { updateToolbarIndicator(); return; }
    const body = document.getElementById('device-panel-live');
    if (!body) return;
    const s = _status;

    if (!_connected) {
        body.innerHTML = `<div class="text-center text-gray-500 text-sm py-8 px-4 space-y-2">
            <i data-lucide="router" class="w-8 h-8 mx-auto text-gray-600"></i>
            <p>Nessuno strumento collegato.</p>
            <p class="text-xs">Collega il telefono alla WiFi <b class="text-gray-300">GPXLogger</b> e premi Connetti
            (indirizzo predefinito <b class="text-gray-300">192.168.4.1</b> o <b class="text-gray-300">gpx.local</b>).</p>
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
    const oreResidue = ((Number(s.flashFreeKb) || 0) / 864).toFixed(1);
    const batt = Number(s.batt) || 0;

    const strumento = sectionCard('Strumento', 'router', `
        ${recBtn}
        <div class="pt-2">
        ${row('Stato', s.rec ? `REC · ${esc(s.session)}` : 'Standby', s.rec ? 'text-red-400' : 'text-gray-300')}
        ${row('Batteria', `${batt}%${s.charging ? ' · in carica' : ''}`, batt > 25 ? 'text-emerald-400' : 'text-red-400')}
        ${row('Flash', `${flashPct}% usata · ~${oreResidue} h residue`, flashPct < 85 ? 'text-gray-100' : 'text-amber-400')}
        ${row('Client WiFi', esc(s.clients))}
        ${row('Record ricevuti', String(_lastSeq))}
        </div>`);

    const gps = sectionCard('Sensore GPS · AT6668', 'satellite', `
        ${row('Fix', s.fix ? '3D attivo' : 'assente', s.fix ? 'text-emerald-400' : 'text-amber-400')}
        ${row('Satelliti', esc(s.sats))}
        ${row('HDOP', Number(s.hdop).toFixed(1), Number(s.hdop) < 2 ? 'text-emerald-400' : 'text-amber-400')}
        ${row('Posizione', s.fix ? `${Number(s.lat).toFixed(5)}, ${Number(s.lon).toFixed(5)}` : '—')}
        ${row('Velocità', `${Number(s.speed).toFixed(1)} km/h`)}
        <div class="flex items-center justify-between pt-2">
            <span class="text-[11px] uppercase tracking-wide text-gray-500">Frequenza</span>
            <select onchange="window.setDeviceRate(this.value)" class="bg-gray-800 border border-gray-700 rounded-lg text-sm px-2 py-1">
                ${[1, 2, 5, 10].map(hz => `<option value="${hz}" ${Number(s.rate) === hz ? 'selected' : ''}>${hz} Hz</option>`).join('')}
            </select>
        </div>`);

    const imu = s.imu || {};
    const imuCard = sectionCard('Sensore IMU · BMI270', 'move-3d', `
        ${row('Pitch', `${Number(imu.pitch ?? 0).toFixed(0)}°`)}
        ${row('Roll', `${Number(imu.roll ?? 0).toFixed(0)}°`)}
        ${row('G laterale', `${Number(imu.latG ?? 0).toFixed(2)} g`)}
        ${row('G longitudinale', `${Number(imu.longG ?? 0).toFixed(2)} g`)}
        <button onclick="window.calibrateDeviceImu()" class="mt-2 w-full py-2 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 text-sm font-semibold text-cyan-300 transition-all">
            Calibra assetto (veicolo in piano)</button>`);

    const env = s.env || {};
    const envCard = sectionCard('Sensore ambiente · ENV III', 'thermometer', env.ok ? `
        ${row('Temperatura', `${Number(env.temp).toFixed(1)} °C`, Number(env.temp) > 45 ? 'text-red-400' : 'text-gray-100')}
        ${row('Umidità', `${Number(env.hum).toFixed(0)} %`)}
        ${row('Pressione', `${(Number(env.press) / 100).toFixed(1)} hPa`)}
        ${row('Quota fusa', `${Number(s.ele).toFixed(0)} m (GPS+baro)`)}` :
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

    body.innerHTML = `<div class="space-y-3 p-3">${strumento}${gps}${imuCard}${envCard}${telefono}${sessioni}</div>`;
    ensureLucideIcons();
    updateToolbarIndicator();
}
