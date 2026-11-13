import test from 'node:test';
import assert from 'node:assert/strict';

const CHIAVE_SESSIONE = 'gpxsuite-last-session-v1';
const valoriLocali = new Map();

globalThis.window = { dispatchEvent() {} };
globalThis.document = { getElementById: () => null };
globalThis.localStorage = {
    getItem: chiave => valoriLocali.get(chiave) || null,
    setItem: (chiave, valore) => valoriLocali.set(chiave, valore)
};

const stato = await import('../src/js/state.js');
const schede = await import('../src/js/gis-tabs.js');
const {
    loadPersistedAppSession,
    riprendiPersistenzaSessioneApp,
    schedulePersistAppSession,
    sospendiPersistenzaSessioneApp
} = await import('../src/js/storage.js');

test('il bootstrap ignora gli eventi iniziali della mappa e riprende a persistere dopo il ripristino', () => {
    const sessionePersistita = {
        version: schede.GIS_TABS_SESSION_VERSION,
        gisTabs: [
            { id: schede.PRIMARY_GIS_TAB_ID, name: 'Casa', visible: true, activeTrackId: null },
            { id: 'scheda-alpi', name: 'Alpi', visible: false, activeTrackId: 'traccia-alpi' }
        ],
        selectedGisTabId: 'scheda-alpi',
        trackOrder: ['file-alpi']
    };
    valoriLocali.set(CHIAVE_SESSIONE, JSON.stringify(sessionePersistita));

    stato.setTracks([]);
    schede.initializeGisTabs(stato.tracks, null);
    sospendiPersistenzaSessioneApp();

    // MapLibre emette moveend prima che IndexedDB abbia restituito le tracce.
    schedulePersistAppSession({ immediate: true });
    assert.deepEqual(loadPersistedAppSession(), sessionePersistita);

    const tracciaRipristinata = {
        id: 'traccia-alpi',
        localFileId: 'file-alpi',
        localSource: 'created',
        name: 'Sentiero alpino',
        gisTabId: 'scheda-alpi',
        visible: true,
        waypointsVisible: true,
        segments: [],
        waypoints: []
    };
    stato.setTracks([tracciaRipristinata]);
    schede.initializeGisTabs(stato.tracks, sessionePersistita);
    riprendiPersistenzaSessioneApp();

    const dopoRipristino = loadPersistedAppSession();
    assert.deepEqual(dopoRipristino.gisTabs, sessionePersistita.gisTabs);
    assert.equal(dopoRipristino.selectedGisTabId, 'scheda-alpi');
    assert.deepEqual(dopoRipristino.trackOrder, ['file-alpi']);

    schede.renameGisTab('scheda-alpi', 'Alpi occidentali');
    schedulePersistAppSession({ immediate: true });

    const dopoModifica = loadPersistedAppSession();
    assert.equal(
        dopoModifica.gisTabs.find(scheda => scheda.id === 'scheda-alpi').name,
        'Alpi occidentali'
    );
});
