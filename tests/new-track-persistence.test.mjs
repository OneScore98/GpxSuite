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

const noop = () => {};
const activeTracksList = { innerHTML: '' };
const toastContainer = { appendChild: noop };
const localValues = new Map();

globalThis.indexedDB = createFakeIndexedDb();
globalThis.window = {
    addEventListener: noop,
    dispatchEvent: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    location: { hostname: 'localhost', href: 'http://localhost/', pathname: '/', search: '', hash: '' }
};
globalThis.document = {
    readyState: 'loading',
    visibilityState: 'visible',
    addEventListener: noop,
    removeEventListener: noop,
    getElementById: id => {
        if (id === 'active-tracks-list') return activeTracksList;
        if (id === 'toast-container') return toastContainer;
        return null;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ className: '', innerHTML: '', remove: noop })
};
globalThis.localStorage = {
    getItem: key => localValues.get(key) || null,
    setItem: (key, value) => localValues.set(key, value)
};
globalThis.CustomEvent = class CustomEvent {
    constructor(type) { this.type = type; }
};
globalThis.requestAnimationFrame = callback => {
    callback();
    return 0;
};

const state = await import('../src/js/state.js');
const gisTabs = await import('../src/js/gis-tabs.js');
const { listStoredTracks, loadPersistedAppSession } = await import('../src/js/storage.js');
const {
    createNewGisTab,
    createNewTrack,
    finishGisTabNameEditor,
    toggleGisTabVisibilityById
} = await import('../src/js/ui.js');

test('una traccia creata manualmente viene salvata prima del ricaricamento', async () => {
    state.setTracks([]);
    gisTabs.initializeGisTabs(state.tracks, null);

    const createdTrack = createNewTrack('Persistente');
    await new Promise(resolve => setTimeout(resolve, 350));

    const storedTracks = await listStoredTracks();
    assert.ok(
        storedTracks.some(track => track.id === createdTrack.localFileId),
        'la traccia appena creata deve essere presente in IndexedDB'
    );
});

test('una Scheda GIS creata e modificata sopravvive a un ricaricamento immediato', () => {
    state.setTracks([]);
    gisTabs.initializeGisTabs(state.tracks, null);

    const createdTab = createNewGisTab();
    finishGisTabNameEditor(createdTab.id, 'Viaggi');
    toggleGisTabVisibilityById(createdTab.id);
    const persistedSession = loadPersistedAppSession();

    assert.ok(
        persistedSession?.gisTabs?.some(tab => tab.id === createdTab.id),
        'la nuova Scheda GIS deve essere scritta in localStorage senza attendere il debounce'
    );
    assert.equal(persistedSession.selectedGisTabId, createdTab.id);

    gisTabs.initializeGisTabs([], persistedSession);
    const restoredTab = gisTabs.getGisTabsState().gisTabs.find(tab => tab.id === createdTab.id);
    assert.equal(restoredTab?.name, 'Viaggi');
    assert.equal(restoredTab?.visible, false);
    assert.equal(gisTabs.getGisTabsState().selectedGisTabId, createdTab.id);
});
