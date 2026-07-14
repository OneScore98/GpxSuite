// storage.js — persistenza locale IndexedDB per GPX per-device/per-browser

import {
    tracks as appTracks,
    activeTrackId,
    activeSegmentId,
    currentStyle,
    currentSnapProfile,
    isMapillaryVisible,
    is3D,
    map
} from './state.js';

const DB_NAME = 'gpxsuite-local-db';
const STORE_NAME = 'gpx-files';
const LIBRARY_EVENT = 'gpxsuite:local-library-changed';
const SESSION_KEY = 'gpxsuite-last-session-v1';

let _dbPromise = null;
let _persistTimer = null;
let _persistQueuedTracks = [];
let _sessionTimer = null;

function promisifyRequest(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });
}

function waitForTransaction(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
}

function emitLibraryChanged() {
    window.dispatchEvent(new CustomEvent(LIBRARY_EVENT));
}

function countTrackPoints(track) {
    let total = 0;
    for (let i = 0; i < track.segments.length; i++) {
        total += track.segments[i].points.length;
    }
    return total;
}

function cloneTrack(track) {
    if (typeof structuredClone === 'function') return structuredClone(track);
    return JSON.parse(JSON.stringify(track));
}

// ── Firma contenuto traccia ───────────────────────────────────────────────────
// Permette di saltare il salvataggio IndexedDB delle tracce NON modificate:
// prima di questa ottimizzazione ogni schedulePersistTracks ri-serializzava
// TUTTE le tracce (su file enormi = 100+ ms di clone per ogni modifica).
// La firma è O(numero segmenti + waypoint), non O(numero punti).
const _persistedTrackSignatures = new WeakMap();

function trackContentSignature(track) {
    const parts = [
        track.localFileId || '',
        track.deviceSessionId || '',
        Number.isFinite(track.deviceLastSeq) ? track.deviceLastSeq : '',
        track.name || '',
        track.desc || '',
        track.color || '',
        track.width || 3,
        track.visible !== false,
        track.waypointsVisible !== false
    ];
    const segs = track.segments || [];
    for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        const pts = seg.points || [];
        const n = pts.length;
        parts.push(seg.id, seg.name, seg.visible !== false, n);
        if (n > 0) {
            const f = pts[0];
            const m = pts[n >> 1];
            const l = pts[n - 1];
            parts.push(f.lon, f.lat, f.ele, m.lon, m.lat, m.ele, m.surfaceFromPrev || '', l.lon, l.lat, l.ele);
        }
    }
    const wps = track.waypoints || [];
    parts.push(wps.length);
    for (let i = 0; i < wps.length; i++) {
        const wp = wps[i];
        parts.push(wp.id, wp.name, wp.lat, wp.lon, wp.ele, wp.symbol, wp.visible !== false, wp.desc || '');
    }
    return parts.join('|');
}

export function ensureTrackStorageMeta(track, source = 'created') {
    if (!track.localFileId) track.localFileId = 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    if (!track.localCreatedAt) track.localCreatedAt = Date.now();
    if (!track.localSource) track.localSource = source;
    return track.localFileId;
}

async function openDb() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                store.createIndex('updatedAt', 'updatedAt');
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Unable to open IndexedDB'));
    });
    return _dbPromise;
}

async function putTrackRecord(track) {
    const db = await openDb();
    ensureTrackStorageMeta(track, track.localSource || 'created');
    track.localUpdatedAt = Date.now();

    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put({
        id: track.localFileId,
        name: track.name || 'Traccia senza nome',
        source: track.localSource || 'created',
        createdAt: track.localCreatedAt,
        updatedAt: track.localUpdatedAt,
        deviceSessionId: track.deviceSessionId || null,
        deviceLastSeq: Number.isFinite(track.deviceLastSeq) ? track.deviceLastSeq : null,
        pointsCount: countTrackPoints(track),
        segmentsCount: track.segments.length,
        waypointCount: track.waypoints.length,
        // Nessun clone esplicito: IndexedDB esegue già lo structured clone
        // in modo sincrono durante put() — clonare prima raddoppiava il costo.
        track: track
    });
    await waitForTransaction(tx);
}

async function persistOneTrackNow(track, force = false) {
    if (!track || track.localSource === 'recording-live') return null;
    const signature = trackContentSignature(track);
    if (!force && _persistedTrackSignatures.get(track) === signature) {
        return track.localFileId || null;
    }
    await putTrackRecord(track);
    _persistedTrackSignatures.set(track, signature);
    return track.localFileId || null;
}

function readHikingTrailsVisibility() {
    return document.getElementById('toggle-hiking-trails')?.checked === true;
}


function buildSessionSnapshot() {
    const persistedTracks = appTracks.filter(track => track.localSource !== 'recording-live');
    const activeTrack = appTracks.find(track => track.id === activeTrackId);
    const snapshot = {
        version: 1,
        savedAt: Date.now(),
        activeTrackId: activeTrack?.localSource === 'recording-live' ? null : (activeTrackId || null),
        activeSegmentId: activeTrack?.localSource === 'recording-live' ? null : (activeSegmentId || null),
        currentStyle,
        currentSnapProfile,
        is3D,
        hikingTrailsVisible: readHikingTrailsVisibility(),
        mapillaryVisible: isMapillaryVisible,
        trackOrder: persistedTracks.map(track => track.localFileId || track.id)
    };

    if (map) {
        const center = map.getCenter();
        snapshot.mapView = {
            center: [center.lng, center.lat],
            zoom: map.getZoom(),
            pitch: map.getPitch(),
            bearing: map.getBearing()
        };
    } else {
        snapshot.mapView = null;
    }

    return snapshot;
}

export function loadPersistedAppSession() {
    try {
        const raw = localStorage.getItem(SESSION_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (err) {
        console.error('Errore lettura sessione locale:', err);
        return null;
    }
}

function persistAppSessionNow() {
    try {
        localStorage.setItem(SESSION_KEY, JSON.stringify(buildSessionSnapshot()));
    } catch (err) {
        console.error('Errore salvataggio sessione locale:', err);
    }
}

export function schedulePersistAppSession() {
    clearTimeout(_sessionTimer);
    _sessionTimer = setTimeout(() => {
        _sessionTimer = null;
        persistAppSessionNow();
    }, 150);
}

async function persistTracksNow(trackList, force = false) {
    for (let i = 0; i < trackList.length; i++) {
        const track = trackList[i];
        if (track?.localSource === 'recording-live') continue;
        try {
            // Salta le tracce il cui contenuto non è cambiato dall'ultimo
            // salvataggio (firma leggera). Il flush di uscita forza sempre
            // il salvataggio completo per garantire la durabilità.
            await persistOneTrackNow(track, force);
        } catch (err) {
            console.error('Errore salvataggio IndexedDB:', err);
        }
    }
}

export async function persistTrackNow(track, options = {}) {
    const id = await persistOneTrackNow(track, options.force === true);
    persistAppSessionNow();
    if (options.emit !== false) emitLibraryChanged();
    return id;
}

export function schedulePersistTracks(trackList) {
    _persistQueuedTracks = trackList.filter(track => track?.localSource !== 'recording-live');
    clearTimeout(_persistTimer);
    _persistTimer = setTimeout(async() => {
        const toPersist = _persistQueuedTracks.slice();
        _persistTimer = null;
        await persistTracksNow(toPersist);
        persistAppSessionNow();
        emitLibraryChanged();
    }, 250);
    schedulePersistAppSession();
}

export async function flushPersistedStateNow() {
    clearTimeout(_persistTimer);
    clearTimeout(_sessionTimer);
    _persistTimer = null;
    _sessionTimer = null;
    _persistQueuedTracks = appTracks.filter(track => track?.localSource !== 'recording-live');
    await persistTracksNow(_persistQueuedTracks, true);
    persistAppSessionNow();
}

export async function listStoredTracks() {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const records = await promisifyRequest(tx.objectStore(STORE_NAME).getAll());
    await waitForTransaction(tx);
    return records
        .map(rec => ({
            id: rec.id,
            name: rec.name,
            source: rec.source,
            deviceSessionId: rec.deviceSessionId || rec.track?.deviceSessionId || null,
            deviceLastSeq: Number.isFinite(rec.deviceLastSeq) ? rec.deviceLastSeq :
                (Number.isFinite(rec.track?.deviceLastSeq) ? rec.track.deviceLastSeq : null),
            createdAt: rec.createdAt,
            updatedAt: rec.updatedAt,
            visible: rec.track?.visible !== false,
            pointsCount: rec.pointsCount || 0,
            segmentsCount: rec.segmentsCount || 0,
            waypointCount: rec.waypointCount || 0
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadStoredTrack(id) {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const record = await promisifyRequest(tx.objectStore(STORE_NAME).get(id));
    await waitForTransaction(tx);
    if (!record) return null;
    const track = cloneTrack(record.track);
    // La traccia appena letta è per definizione identica a quella salvata:
    // pre-carica la firma per evitare un ri-salvataggio completo inutile
    // al primo schedulePersistTracks dopo il ripristino.
    _persistedTrackSignatures.set(track, trackContentSignature(track));
    return track;
}

export async function deleteStoredTrack(id) {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    await waitForTransaction(tx);
    emitLibraryChanged();
}

export async function hasStoredTracks() {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const count = await promisifyRequest(tx.objectStore(STORE_NAME).count());
    await waitForTransaction(tx);
    return count > 0;
}

export function onLibraryChanged(handler) {
    window.addEventListener(LIBRARY_EVENT, handler);
}
