import test from 'node:test';
import assert from 'node:assert/strict';

const noop = () => {};
const archivio = new Map();
const elementi = new Map();
globalThis.window = { addEventListener: noop, dispatchEvent: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), location: { hostname: 'localhost' } };
globalThis.document = { readyState: 'loading', addEventListener: noop, getElementById: id => elementi.get(id) || null, querySelector: () => null, querySelectorAll: () => [] };
globalThis.localStorage = { getItem: k => archivio.get(k) || null, setItem: (k, v) => archivio.set(k, v) };
const stato = await import('../src/js/state.js');
const { createBaseMapStyle, setBaseMap } = await import('../src/js/map.js');
const archivioSessione = await import('../src/js/storage.js');

test('ADV seleziona una base vettoriale indipendente da OUT e normalizza gli stili sconosciuti', () => {
    const outdoor = createBaseMapStyle('outdoor');
    const prima = JSON.stringify(outdoor);
    const adv = createBaseMapStyle('adv');
    assert.ok(adv.sources.openmaptiles, 'ADV usa la sorgente cartografica vettoriale');
    assert.ok(adv.layers.some(layer => layer.id.startsWith('adv-')));
    adv.layers[0].paint['background-color'] = 'red';
    assert.equal(JSON.stringify(outdoor), prima);
    assert.notEqual(createBaseMapStyle('adv').layers[0].paint['background-color'], 'red');
    setBaseMap('adv');
    assert.equal(stato.currentStyle, 'adv');
    setBaseMap('inesistente');
    assert.equal(stato.currentStyle, 'osm');
});

test('ADV attraversa selezione, legenda e persistenza senza cambiare tracce o undo', () => {
    const stili = [];
    stato.setMap({ once: noop, setStyle: stile => stili.push(stile), getCenter: () => ({ lng: 10.4, lat: 45.8 }), getZoom: () => 14, getPitch: () => 0, getBearing: () => 0 });
    stato.setMapLoaded(true);
    const legenda = { hidden: true };
    elementi.set('adv-map-controls', legenda);
    for (const id of ['osm', 'sat', 'topo', 'acqua', 'outdoor', 'adv']) elementi.set(`map-style-${id}`, { className: '' });
    const tracce = [{ id: 'originale', segments: [], waypoints: [], color: '#aabbcc' }];
    stato.setTracks(tracce);
    const undo = ['precedente'];
    stato.setUndoStack(undo);
    for (const stile of ['outdoor', 'adv', 'sat', 'adv']) setBaseMap(stile);
    assert.equal(stato.currentStyle, 'adv');
    assert.equal(legenda.hidden, false);
    assert.match(elementi.get('map-style-adv').className, /bg-blue-600/);
    archivioSessione.schedulePersistAppSession({ immediate: true });
    assert.equal(archivioSessione.loadPersistedAppSession().currentStyle, 'adv');
    assert.equal(stato.tracks, tracce);
    assert.equal(stato.undoStack, undo);
    assert.equal(stili.length, 4);
    setBaseMap('outdoor');
    assert.equal(legenda.hidden, true);
    stato.setMapLoaded(false);
    stato.setMap(null);
});

test('la riapertura senza GPX ripristina ADV e il bootstrap non sovrascrive la sessione', async () => {
    globalThis.indexedDB = { open() {
        const richiesta = {};
        queueMicrotask(() => {
            richiesta.result = { transaction() {
                const transazione = { objectStore: () => ({ getAll() {
                    const lettura = {};
                    queueMicrotask(() => { lettura.result = []; lettura.onsuccess?.(); queueMicrotask(() => transazione.oncomplete?.()); });
                    return lettura;
                } }) };
                return transazione;
            } };
            richiesta.onsuccess?.();
        });
        return richiesta;
    } };
    const schede = await import('../src/js/gis-tabs.js');
    const ui = await import('../src/js/ui.js');
    schede.initializeGisTabs([], null);
    stato.setTracks([]);
    stato.setCurrentStyle('adv');
    archivioSessione.schedulePersistAppSession({ immediate: true });
    archivioSessione.sospendiPersistenzaSessioneApp();
    stato.setCurrentStyle('osm');
    archivioSessione.schedulePersistAppSession({ immediate: true });
    assert.equal(archivioSessione.loadPersistedAppSession().currentStyle, 'adv');
    stato.setMap({ once: noop, setStyle: noop, getCenter: () => ({ lng: 10, lat: 45 }), getZoom: () => 14, getPitch: () => 0, getBearing: () => 0 });
    stato.setMapLoaded(true);
    ui.injectDeps({ setBaseMap });
    const risultato = await ui.restoreStoredTracksOnStartup();
    assert.equal(risultato.restoredCount, 0);
    assert.equal(stato.currentStyle, 'adv');
    archivioSessione.riprendiPersistenzaSessioneApp();
    assert.equal(archivioSessione.loadPersistedAppSession().currentStyle, 'adv');
    stato.setMapLoaded(false);
    stato.setMap(null);
});

test('ADV conserva la sorgente locale del wrapper Android', () => {
    globalThis.location = { origin: 'https://gpxsuite.local' };
    window.__GPXSUITE_ANDROID__ = true;
    try {
        const stile = createBaseMapStyle('adv');
        assert.deepEqual(stile.sources.openmaptiles.tiles, ['https://gpxsuite.local/__apk_tiles/{z}/{x}/{y}.pbf']);
        assert.equal(stile.sources.openmaptiles.maxzoom, 14);
    } finally {
        delete window.__GPXSUITE_ANDROID__;
        delete globalThis.location;
    }
});
