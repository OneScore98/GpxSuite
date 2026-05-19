// storage.js — persistenza locale IndexedDB per GPX per-device/per-browser

const DB_NAME = 'gpxsuite-local-db';
const STORE_NAME = 'gpx-files';
const LIBRARY_EVENT = 'gpxsuite:local-library-changed';

let _dbPromise = null;
let _persistTimer = null;
let _persistQueuedTracks = [];

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
    return JSON.parse(JSON.stringify(track));
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
        pointsCount: countTrackPoints(track),
        segmentsCount: track.segments.length,
        waypointCount: track.waypoints.length,
        track: cloneTrack(track)
    });
    await waitForTransaction(tx);
}

export function schedulePersistTracks(tracks) {
    _persistQueuedTracks = tracks.slice();
    clearTimeout(_persistTimer);
    _persistTimer = setTimeout(async() => {
        const toPersist = _persistQueuedTracks.slice();
        _persistTimer = null;
        for (let i = 0; i < toPersist.length; i++) {
            try {
                await putTrackRecord(toPersist[i]);
            } catch (err) {
                console.error('Errore salvataggio IndexedDB:', err);
            }
        }
        emitLibraryChanged();
    }, 250);
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
            createdAt: rec.createdAt,
            updatedAt: rec.updatedAt,
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
    return record ? cloneTrack(record.track) : null;
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
