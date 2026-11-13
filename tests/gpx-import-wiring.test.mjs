import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { importaFileGpxInOrdine } from '../src/js/gpx-import.js';
import { deveCreareTracciaIniziale } from '../src/js/startup.js';

test('il selettore GPX accetta davvero più file', async () => {
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    assert.match(html, /id="file-import-gpx"[^>]*\bmultiple\b/);
});

test('il wiring importa i file in ordine nella destinazione catturata una sola volta', async () => {
    const chiamate = [];
    let catture = 0;
    const file = nome => ({ name: nome, size: nome.length });

    await importaFileGpxInOrdine([file('uno.gpx'), file('due.gpx')], {
        catturaDestinazione: () => {
            catture += 1;
            return 'scheda-alpi';
        },
        leggiTesto: async elemento => {
            await new Promise(resolve => setTimeout(resolve, elemento.name === 'uno.gpx' ? 5 : 0));
            return `<gpx>${elemento.name}</gpx>`;
        },
        importaGpx: async (testo, nome, opzioni) => {
            chiamate.push({ testo, nome, opzioni });
        }
    });

    assert.equal(catture, 1);
    assert.deepEqual(chiamate, [
        {
            testo: '<gpx>uno.gpx</gpx>',
            nome: 'uno.gpx',
            opzioni: { destinationGisTabId: 'scheda-alpi' }
        },
        {
            testo: '<gpx>due.gpx</gpx>',
            nome: 'due.gpx',
            opzioni: { destinationGisTabId: 'scheda-alpi' }
        }
    ]);
});

test('crea Traccia 1 solo al primo avvio, non dopo una sessione vuota persistita', () => {
    assert.equal(deveCreareTracciaIniziale({ restoredCount: 0, session: null }), true);
    assert.equal(deveCreareTracciaIniziale({ restoredCount: 0, session: { trackOrder: [] } }), false);
    assert.equal(deveCreareTracciaIniziale({ restoredCount: 2, session: null }), false);
});

test('il wiring arriva al vero importGPX e conserva ordine e proprietà delle tracce', async () => {
    const noop = () => {};
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
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => []
    };
    globalThis.localStorage = { getItem: () => null, setItem: noop };
    globalThis.Worker = class WorkerFinto {
        constructor() { this.gestori = new Map(); }
        addEventListener(tipo, gestore) { this.gestori.set(tipo, gestore); }
        removeEventListener(tipo) { this.gestori.delete(tipo); }
        postMessage({ fileName }) {
            queueMicrotask(() => this.gestori.get('message')?.({
                data: {
                    ok: true,
                    result: {
                        segments: [{ id: `seg-${fileName}`, name: fileName, points: [], visible: true }],
                        waypoints: [],
                        firstPoint: null,
                        totalPoints: 0
                    }
                }
            }));
        }
    };

    const stato = await import('../src/js/state.js');
    const schede = await import('../src/js/gis-tabs.js');
    const { importGPX } = await import('../src/js/gpx.js');
    stato.setTracks([]);
    schede.initializeGisTabs(stato.tracks, {
        version: schede.GIS_TABS_SESSION_VERSION,
        gisTabs: [
            { id: schede.PRIMARY_GIS_TAB_ID, name: 'Principale', visible: true },
            { id: 'scheda-import', name: 'Import', visible: true }
        ],
        selectedGisTabId: 'scheda-import'
    });

    let importati = 0;
    await importaFileGpxInOrdine([
        { name: 'prima.gpx', size: 1 },
        { name: 'seconda.gpx', size: 1 }
    ], {
        catturaDestinazione: schede.catturaDestinazioneIngressoTraccia,
        leggiTesto: async file => `<gpx>${file.name}</gpx>`,
        importaGpx: async (testo, nome, opzioni) => {
            const risultato = await importGPX(testo, nome, {
                ...opzioni, silent: true, activate: false, updateMap: false, saveHistory: false
            });
            importati += 1;
            if (importati === 1) schede.selectGisTab(schede.PRIMARY_GIS_TAB_ID, stato.tracks);
            return risultato;
        }
    });

    assert.deepEqual(stato.tracks.map(traccia => traccia.name), ['prima', 'seconda']);
    assert.deepEqual(stato.tracks.map(traccia => traccia.gisTabId), ['scheda-import', 'scheda-import']);
});

test('i comandi pubblici dell’albero non mutano geometrie nella scheda nascosta', async () => {
    const noop = () => {};
    const contenitoreToast = { appendChild: noop };
    globalThis.document = {
        readyState: 'loading',
        visibilityState: 'visible',
        addEventListener: noop,
        removeEventListener: noop,
        getElementById: id => id === 'toast-container' ? contenitoreToast : null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => ({ className: '', innerHTML: '', remove: noop })
    };
    const timeoutReale = globalThis.setTimeout;
    globalThis.setTimeout = funzione => {
        funzione();
        return 0;
    };

    try {
        const stato = await import('../src/js/state.js');
        const schede = await import('../src/js/gis-tabs.js');
        const ui = await import('../src/js/ui.js');
        const traccia = {
            id: 'traccia-nascosta',
            name: 'Nascosta',
            gisTabId: 'scheda-nascosta',
            visible: true,
            waypointsVisible: true,
            segments: [{ id: 'segmento-1', name: 'Uno', visible: true, points: [] }],
            waypoints: [{ id: 'wp-1', name: 'WP', visible: true, lat: 45, lon: 9 }]
        };
        stato.setTracks([traccia]);
        stato.setActiveTrackId(traccia.id);
        stato.setActiveSegmentId('segmento-1');
        schede.initializeGisTabs(stato.tracks, {
            version: schede.GIS_TABS_SESSION_VERSION,
            gisTabs: [
                { id: schede.PRIMARY_GIS_TAB_ID, name: 'Principale', visible: true },
                { id: 'scheda-nascosta', name: 'Nascosta', visible: false }
            ],
            selectedGisTabId: 'scheda-nascosta'
        });

        ui.handleTrackTreeClick({ target: null }, traccia.id);
        ui.copyTreeSelection();
        ui.pasteTreeSelection();
        ui.cutTreeSelection();
        ui.addNewSegmentToTrack(traccia.id);
        ui.deleteSegment(traccia.id, 'segmento-1');
        ui.deleteWaypoint(traccia.id, 'wp-1');

        assert.deepEqual(stato.tracks.map(elemento => elemento.id), ['traccia-nascosta']);
        assert.deepEqual(traccia.segments.map(segmento => segmento.id), ['segmento-1']);
        assert.deepEqual(traccia.waypoints.map(waypoint => waypoint.id), ['wp-1']);
        assert.equal(schede.getGisTabsState().gisTabs.find(scheda => scheda.id === 'scheda-nascosta').visible, false);
    } finally {
        globalThis.setTimeout = timeoutReale;
    }
});
