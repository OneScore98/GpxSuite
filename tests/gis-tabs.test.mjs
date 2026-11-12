import test from 'node:test';
import assert from 'node:assert/strict';

import {
    GIS_TABS_SESSION_VERSION,
    PRIMARY_GIS_TAB_ID,
    assignTrackToGisTab,
    getGisTabsState,
    getTracksForGisTab,
    initializeGisTabs,
    serializeGisTabsState
} from '../src/js/gis-tabs.js';

function track(id, gisTabId) {
    return {
        id,
        name: `Traccia ${id}`,
        segments: [],
        waypoints: [],
        ...(gisTabId === undefined ? {} : { gisTabId })
    };
}

test('crea sempre Principale anche all\'avvio senza tracce o sessione', () => {
    const state = initializeGisTabs([], null);

    assert.deepEqual(state, {
        gisTabs: [{
            id: PRIMARY_GIS_TAB_ID,
            name: 'Principale',
            visible: true,
            activeTrackId: null
        }],
        selectedGisTabId: PRIMARY_GIS_TAB_ID
    });
});

test('migra una sessione piatta in Principale conservando l\'ordine delle tracce', () => {
    const tracks = [track('track-b'), track('track-a')];
    const legacySession = {
        version: 1,
        trackOrder: ['track-b', 'track-a'],
        activeTrackId: 'track-b'
    };

    const state = initializeGisTabs(tracks, legacySession);

    assert.deepEqual(state.gisTabs, [{
        id: PRIMARY_GIS_TAB_ID,
        name: 'Principale',
        visible: true,
        activeTrackId: 'track-b'
    }]);
    assert.equal(state.selectedGisTabId, PRIMARY_GIS_TAB_ID);
    assert.deepEqual(tracks.map(item => item.gisTabId), [PRIMARY_GIS_TAB_ID, PRIMARY_GIS_TAB_ID]);
    assert.deepEqual(getTracksForGisTab(PRIMARY_GIS_TAB_ID, tracks).map(item => item.id), ['track-b', 'track-a']);
});

test('recupera in Principale le tracce orfane o con proprietario non valido', () => {
    const tracks = [
        track('track-main', PRIMARY_GIS_TAB_ID),
        track('track-valid', 'gis-tab-alpi'),
        track('track-orphan'),
        track('track-invalid', 'gis-tab-missing'),
        track('track-multiple', [PRIMARY_GIS_TAB_ID, 'gis-tab-alpi'])
    ];
    const session = {
        version: GIS_TABS_SESSION_VERSION,
        gisTabs: [
            { id: PRIMARY_GIS_TAB_ID, name: 'Principale', visible: true, activeTrackId: 'track-main' },
            { id: 'gis-tab-alpi', name: 'Alpi', visible: false, activeTrackId: 'track-valid' }
        ],
        selectedGisTabId: 'gis-tab-alpi'
    };

    const state = initializeGisTabs(tracks, session);

    assert.equal(state.selectedGisTabId, 'gis-tab-alpi');
    assert.deepEqual(tracks.map(item => item.gisTabId), [
        PRIMARY_GIS_TAB_ID,
        'gis-tab-alpi',
        PRIMARY_GIS_TAB_ID,
        PRIMARY_GIS_TAB_ID,
        PRIMARY_GIS_TAB_ID
    ]);
    assert.deepEqual(getTracksForGisTab(PRIMARY_GIS_TAB_ID, tracks).map(item => item.id), [
        'track-main',
        'track-orphan',
        'track-invalid',
        'track-multiple'
    ]);
});

test('serializza e ripristina lo schema versionato mantenendo un solo proprietario per traccia', () => {
    const originalTracks = [track('track-main'), track('track-alpi', 'gis-tab-alpi')];
    initializeGisTabs(originalTracks, {
        version: GIS_TABS_SESSION_VERSION,
        gisTabs: [
            { id: PRIMARY_GIS_TAB_ID, name: 'Principale', visible: true, activeTrackId: 'track-main' },
            { id: 'gis-tab-alpi', name: 'Alpi', visible: false, activeTrackId: 'track-alpi' }
        ],
        selectedGisTabId: 'gis-tab-alpi'
    });

    const serialized = serializeGisTabsState();
    const persistedTracks = JSON.parse(JSON.stringify(originalTracks));
    const restored = initializeGisTabs(persistedTracks, JSON.parse(JSON.stringify(serialized)));

    assert.equal(serialized.version, GIS_TABS_SESSION_VERSION);
    assert.deepEqual(restored, getGisTabsState());
    assert.deepEqual(persistedTracks.map(item => item.gisTabId), [PRIMARY_GIS_TAB_ID, 'gis-tab-alpi']);
    assert.ok(persistedTracks.every(item => typeof item.gisTabId === 'string'));
    assert.ok(persistedTracks.every(item => !Array.isArray(item.gisTabId)));
});

test('assegna la proprietà attraverso il modulo e usa Principale per destinazioni non valide', () => {
    initializeGisTabs([], {
        version: GIS_TABS_SESSION_VERSION,
        gisTabs: [
            { id: PRIMARY_GIS_TAB_ID, name: 'Principale', visible: true },
            { id: 'gis-tab-alpi', name: 'Alpi', visible: true }
        ],
        selectedGisTabId: 'gis-tab-alpi'
    });
    const selectedTrack = track('track-selected');
    const recoveredTrack = track('track-recovered');

    assert.equal(assignTrackToGisTab(selectedTrack), 'gis-tab-alpi');
    assert.equal(assignTrackToGisTab(recoveredTrack, 'gis-tab-missing'), PRIMARY_GIS_TAB_ID);
    assert.equal(selectedTrack.gisTabId, 'gis-tab-alpi');
    assert.equal(recoveredTrack.gisTabId, PRIMARY_GIS_TAB_ID);
});
