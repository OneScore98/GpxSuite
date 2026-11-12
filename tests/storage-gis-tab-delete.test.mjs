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
globalThis.localStorage = {
    getItem: () => null,
    setItem() {}
};
globalThis.CustomEvent = class CustomEvent {
    constructor(type) { this.type = type; }
};

const {
    deleteStoredTracks,
    listStoredTracks,
    persistTrackNow
} = await import('../src/js/storage.js');

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

    const deletion = deleteStoredTracks(['file-a', 'file-b']);
    const restoration = Promise.all(deletedTracks.map(track => (
        persistTrackNow(structuredClone(track), { force: true, emit: false })
    )));
    await Promise.all([deletion, restoration]);

    assert.deepEqual((await listStoredTracks()).map(item => item.id).sort(), ['file-a', 'file-b']);
});
