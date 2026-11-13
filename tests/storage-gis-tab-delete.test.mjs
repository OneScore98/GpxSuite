import test from 'node:test';
import assert from 'node:assert/strict';

function createFakeIndexedDb() {
    const records = new Map();
    const makeTransaction = () => {
        let completionScheduled = false;
        const transaction = {
            oncomplete: null,
            onerror: null,
            onabort: null,
            objectStore() {
                const completeSoon = () => {
                    if (completionScheduled) return;
                    completionScheduled = true;
                    queueMicrotask(() => transaction.oncomplete?.());
                };
                return {
                    put(record) {
                        records.set(record.id, structuredClone(record));
                        completeSoon();
                    },
                    delete(id) {
                        records.delete(id);
                        completeSoon();
                    },
                    get(id) {
                        const request = {};
                        queueMicrotask(() => {
                            const record = records.get(id);
                            request.result = record ? structuredClone(record) : undefined;
                            request.onsuccess?.();
                            completeSoon();
                        });
                        return request;
                    },
                    getAll() {
                        const request = {};
                        queueMicrotask(() => {
                            request.result = [...records.values()].map(record => structuredClone(record));
                            request.onsuccess?.();
                            completeSoon();
                        });
                        return request;
                    }
                };
            }
        };
        return transaction;
    };

    return {
        open() {
            const request = {};
            queueMicrotask(() => {
                request.result = {
                    objectStoreNames: { contains: () => true },
                    transaction: makeTransaction
                };
                request.onsuccess?.();
            });
            return request;
        }
    };
}

globalThis.indexedDB = createFakeIndexedDb();
globalThis.window = {
    dispatchEvent() {},
    addEventListener() {}
};
globalThis.document = { getElementById: () => null };
const localValues = new Map();
globalThis.localStorage = {
    getItem: key => localValues.get(key) || null,
    setItem: (key, value) => localValues.set(key, value)
};
globalThis.CustomEvent = class CustomEvent {
    constructor(type) { this.type = type; }
};

const {
    eliminaTracceMemorizzate,
    listStoredTracks,
    loadPersistedAppSession,
    loadStoredTrack,
    persisteSubitoSessioneGisRipristinata,
    persistTrackNow
} = await import('../src/js/storage.js');
const { setTracks } = await import('../src/js/state.js');
const {
    GIS_TABS_SESSION_VERSION,
    PRIMARY_GIS_TAB_ID,
    initializeGisTabs
} = await import('../src/js/gis-tabs.js');

function storedTrack(id, gisTabId) {
    return {
        id: `track-${id}`,
        localFileId: id,
        localCreatedAt: 1,
        localSource: 'created',
        name: id,
        gisTabId,
        segments: [],
        waypoints: []
    };
}

test('undo ripersistisce le tracce dopo la cancellazione batch senza corse asincrone', async () => {
    const deletedTracks = [storedTrack('file-a', 'tab-a'), storedTrack('file-b', 'tab-a')];
    await Promise.all(deletedTracks.map(track => persistTrackNow(track, { force: true, emit: false })));

    const deletion = eliminaTracceMemorizzate(['file-a', 'file-b']);
    const restoration = Promise.all(deletedTracks.map(track => (
        persistTrackNow(structuredClone(track), { force: true, emit: false })
    )));
    await Promise.all([deletion, restoration]);

    assert.deepEqual((await listStoredTracks()).map(item => item.id).sort(), ['file-a', 'file-b']);
});

test('la riparazione di avvio persiste subito owner e sessione canonica senza perdere le preferenze', async () => {
    const orphan = storedTrack('file-orphan', PRIMARY_GIS_TAB_ID);
    const alpi = storedTrack('file-alpi', 'tab-alpi');
    const tracks = [orphan, alpi];
    setTracks(tracks);
    initializeGisTabs(tracks, {
        version: GIS_TABS_SESSION_VERSION,
        gisTabs: [
            { id: 'tab-alpi', name: 'Alpi', visible: false, activeTrackId: alpi.id },
            { id: PRIMARY_GIS_TAB_ID, name: 'Casa', visible: true, activeTrackId: orphan.id }
        ],
        selectedGisTabId: 'tab-alpi'
    });
    const previousSession = {
        version: 1,
        currentStyle: 'satellite',
        activeSegmentId: 'segmento-alpi',
        mapView: { center: [9, 45], zoom: 11, pitch: 20, bearing: 3 }
    };

    await persisteSubitoSessioneGisRipristinata([orphan], previousSession);

    const saved = loadPersistedAppSession();
    assert.equal(saved.version, GIS_TABS_SESSION_VERSION);
    assert.equal(saved.currentStyle, 'satellite');
    assert.equal(saved.activeSegmentId, 'segmento-alpi');
    assert.deepEqual(saved.mapView, previousSession.mapView);
    assert.deepEqual(saved.trackOrder, ['file-orphan', 'file-alpi']);
    assert.deepEqual(saved.gisTabs.map(tab => tab.id), ['tab-alpi', PRIMARY_GIS_TAB_ID]);
    assert.equal(saved.selectedGisTabId, 'tab-alpi');
    assert.equal((await loadStoredTrack('file-orphan')).gisTabId, PRIMARY_GIS_TAB_ID);
});
