import test from 'node:test';
import assert from 'node:assert/strict';

import {
    GIS_TABS_SESSION_VERSION,
    PRIMARY_GIS_TAB_ID,
    activateTrackOwnerGisTab,
    appendTracksAtIngress,
    assignTrackToGisTab,
    captureTrackIngressGisTabId,
    createGisTab,
    getGisTabsState,
    getSelectedGisTabTracks,
    getTracksForGisTab,
    inheritTrackGisTab,
    initializeGisTabs,
    isSegmentEffectivelyVisible,
    isTrackEffectivelyVisible,
    isWaypointEffectivelyVisible,
    rememberActiveTrackForSelectedGisTab,
    selectGisTab,
    serializeGisTabsState,
    toggleGisTabVisibility
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

test('la destinazione catturata all\'avvio di un flusso live resta stabile dopo il cambio scheda', () => {
    initializeGisTabs([], {
        version: GIS_TABS_SESSION_VERSION,
        gisTabs: [
            { id: PRIMARY_GIS_TAB_ID, name: 'Principale', visible: true },
            { id: 'gis-tab-live', name: 'Live', visible: true }
        ],
        selectedGisTabId: 'gis-tab-live'
    });

    const destinationId = captureTrackIngressGisTabId();
    selectGisTab(PRIMARY_GIS_TAB_ID, []);
    const liveTrack = track('track-live');

    assignTrackToGisTab(liveTrack, destinationId);

    assert.equal(liveTrack.gisTabId, 'gis-tab-live');
});

test('una traccia derivata eredita il proprietario della sorgente e recupera gli orfani in Principale', () => {
    initializeGisTabs([], {
        version: GIS_TABS_SESSION_VERSION,
        gisTabs: [
            { id: PRIMARY_GIS_TAB_ID, name: 'Principale', visible: true },
            { id: 'gis-tab-sorgente', name: 'Sorgente', visible: true }
        ],
        selectedGisTabId: PRIMARY_GIS_TAB_ID
    });
    const derivedTrack = track('track-derived');
    const recoveredTrack = track('track-recovered');

    inheritTrackGisTab(derivedTrack, track('track-source', 'gis-tab-sorgente'));
    inheritTrackGisTab(recoveredTrack, track('track-orphan', 'gis-tab-missing'));

    assert.equal(derivedTrack.gisTabId, 'gis-tab-sorgente');
    assert.equal(recoveredTrack.gisTabId, PRIMARY_GIS_TAB_ID);
});

test('l\'incolla usa la scheda di destinazione catturata e sovrascrive il proprietario copiato', () => {
    initializeGisTabs([], {
        version: GIS_TABS_SESSION_VERSION,
        gisTabs: [
            { id: PRIMARY_GIS_TAB_ID, name: 'Principale', visible: true },
            { id: 'gis-tab-a', name: 'A', visible: true },
            { id: 'gis-tab-b', name: 'B', visible: true }
        ],
        selectedGisTabId: 'gis-tab-a'
    });
    const copiedTrack = track('track-copy', 'gis-tab-a');

    selectGisTab('gis-tab-b', []);
    const pasteDestinationId = captureTrackIngressGisTabId();
    const pastedTrack = JSON.parse(JSON.stringify(copiedTrack));
    pastedTrack.id = 'track-pasted';
    assignTrackToGisTab(pastedTrack, pasteDestinationId);

    assert.equal(pastedTrack.gisTabId, 'gis-tab-b');
    assert.equal(copiedTrack.gisTabId, 'gis-tab-a');
});

test('crea in coda una scheda vuota con il primo nome disponibile e la seleziona', () => {
    initializeGisTabs([], {
        version: GIS_TABS_SESSION_VERSION,
        gisTabs: [
            { id: PRIMARY_GIS_TAB_ID, name: 'Principale', visible: true },
            { id: 'gis-tab-uno', name: 'Scheda 1', visible: true },
            { id: 'gis-tab-tre', name: 'Scheda 3', visible: true }
        ],
        selectedGisTabId: PRIMARY_GIS_TAB_ID
    });

    const created = createGisTab();
    const state = getGisTabsState();

    assert.equal(created.name, 'Scheda 2');
    assert.equal(created.activeTrackId, null);
    assert.equal(state.gisTabs.at(-1).id, created.id);
    assert.equal(state.selectedGisTabId, created.id);
});

test('seleziona la scheda con fallback alla prima traccia e ricorda l\'ultima attiva', () => {
    const tracks = [
        track('main-1', PRIMARY_GIS_TAB_ID),
        track('main-2', PRIMARY_GIS_TAB_ID),
        track('alpi-1', 'gis-tab-alpi')
    ];
    initializeGisTabs(tracks, {
        version: GIS_TABS_SESSION_VERSION,
        gisTabs: [
            { id: PRIMARY_GIS_TAB_ID, name: 'Principale', visible: true, activeTrackId: 'main-1' },
            { id: 'gis-tab-alpi', name: 'Alpi', visible: true, activeTrackId: null }
        ],
        selectedGisTabId: PRIMARY_GIS_TAB_ID
    });

    rememberActiveTrackForSelectedGisTab('main-2', tracks);
    assert.equal(selectGisTab('gis-tab-alpi', tracks), 'alpi-1');
    assert.equal(selectGisTab(PRIMARY_GIS_TAB_ID, tracks), 'main-2');
    const persisted = serializeGisTabsState();
    assert.equal(persisted.selectedGisTabId, PRIMARY_GIS_TAB_ID);
    assert.equal(persisted.gisTabs.find(tab => tab.id === PRIMARY_GIS_TAB_ID).activeTrackId, 'main-2');
    assert.equal(persisted.gisTabs.find(tab => tab.id === 'gis-tab-alpi').activeTrackId, 'alpi-1');
});

test('una scheda vuota non mantiene tracce esterne e la selezione non cambia la visibilità', () => {
    const tracks = [
        { ...track('main-visible', PRIMARY_GIS_TAB_ID), visible: true },
        { ...track('main-hidden', PRIMARY_GIS_TAB_ID), visible: false }
    ];
    initializeGisTabs(tracks, {
        version: GIS_TABS_SESSION_VERSION,
        gisTabs: [
            { id: PRIMARY_GIS_TAB_ID, name: 'Principale', visible: true, activeTrackId: 'main-visible' },
            { id: 'gis-tab-vuota', name: 'Vuota', visible: true, activeTrackId: 'main-hidden' }
        ],
        selectedGisTabId: PRIMARY_GIS_TAB_ID
    });
    const visibilityBefore = tracks.map(item => item.visible);

    assert.equal(selectGisTab('gis-tab-vuota', tracks), null);
    assert.deepEqual(getSelectedGisTabTracks(tracks), []);
    assert.deepEqual(tracks.map(item => item.visible), visibilityBefore);
    assert.equal(getGisTabsState().gisTabs.find(tab => tab.id === 'gis-tab-vuota').activeTrackId, null);
});

test('nascondere una Scheda GIS esclude le sue tracce senza riscriverne le preferenze', () => {
    const tracks = [
        {
            ...track('alpi-visible', 'gis-tab-alpi'),
            visible: true,
            waypointsVisible: false,
            segments: [{ id: 'seg-visible', visible: true }, { id: 'seg-hidden', visible: false }],
            waypoints: [{ id: 'wp-visible', visible: true }, { id: 'wp-hidden', visible: false }]
        },
        { ...track('alpi-hidden', 'gis-tab-alpi'), visible: false }
    ];
    initializeGisTabs(tracks, {
        version: GIS_TABS_SESSION_VERSION,
        gisTabs: [
            { id: PRIMARY_GIS_TAB_ID, name: 'Principale', visible: true },
            { id: 'gis-tab-alpi', name: 'Alpi', visible: true }
        ],
        selectedGisTabId: PRIMARY_GIS_TAB_ID
    });
    const preferencesBefore = tracks.map(item => ({
        visible: item.visible,
        waypointsVisible: item.waypointsVisible,
        segments: item.segments.map(segment => segment.visible),
        waypoints: item.waypoints.map(waypoint => waypoint.visible)
    }));

    assert.equal(isTrackEffectivelyVisible(tracks[0]), true);
    assert.equal(isTrackEffectivelyVisible(tracks[1]), false);
    assert.equal(toggleGisTabVisibility('gis-tab-alpi'), false);
    assert.deepEqual(tracks.map(item => ({
        visible: item.visible,
        waypointsVisible: item.waypointsVisible,
        segments: item.segments.map(segment => segment.visible),
        waypoints: item.waypoints.map(waypoint => waypoint.visible)
    })), preferencesBefore);
    assert.deepEqual(tracks.map(isTrackEffectivelyVisible), [false, false]);
    assert.equal(toggleGisTabVisibility('gis-tab-alpi'), true);
    assert.deepEqual(tracks.map(item => ({
        visible: item.visible,
        waypointsVisible: item.waypointsVisible,
        segments: item.segments.map(segment => segment.visible),
        waypoints: item.waypoints.map(waypoint => waypoint.visible)
    })), preferencesBefore);
    assert.deepEqual(tracks.map(isTrackEffectivelyVisible), [true, false]);
});

test('la visibilità effettiva dei segmenti segue la matrice scheda × traccia × segmento', () => {
    const matrix = [
        [true, true, true, true],
        [true, true, false, false],
        [true, false, true, false],
        [true, false, false, false],
        [false, true, true, false],
        [false, true, false, false],
        [false, false, true, false],
        [false, false, false, false]
    ];

    for (const [tabVisible, trackVisible, segmentVisible, expected] of matrix) {
        const ownerId = 'gis-tab-matrice';
        initializeGisTabs([], {
            version: GIS_TABS_SESSION_VERSION,
            gisTabs: [
                { id: PRIMARY_GIS_TAB_ID, name: 'Principale', visible: true },
                { id: ownerId, name: 'Matrice', visible: tabVisible }
            ],
            selectedGisTabId: PRIMARY_GIS_TAB_ID
        });
        const candidateTrack = { ...track('matrix-track', ownerId), visible: trackVisible };
        const candidateSegment = { id: 'matrix-segment', visible: segmentVisible, points: [] };

        assert.equal(
            isSegmentEffectivelyVisible(candidateTrack, candidateSegment),
            expected,
            `scheda=${tabVisible}, traccia=${trackVisible}, segmento=${segmentVisible}`
        );
    }
});

test('la visibilità effettiva dei waypoint segue scheda, traccia, gruppo e preferenza individuale', () => {
    const matrix = [
        [true, true, true, true, true],
        [true, true, true, false, false],
        [true, true, false, true, false],
        [true, true, false, false, false],
        [true, false, true, true, false],
        [true, false, true, false, false],
        [true, false, false, true, false],
        [true, false, false, false, false],
        [false, true, true, true, false],
        [false, true, true, false, false],
        [false, true, false, true, false],
        [false, true, false, false, false],
        [false, false, true, true, false],
        [false, false, true, false, false],
        [false, false, false, true, false],
        [false, false, false, false, false]
    ];

    for (const [tabVisible, trackVisible, groupVisible, waypointVisible, expected] of matrix) {
        const ownerId = 'gis-tab-waypoint-matrix';
        initializeGisTabs([], {
            version: GIS_TABS_SESSION_VERSION,
            gisTabs: [
                { id: PRIMARY_GIS_TAB_ID, name: 'Principale', visible: true },
                { id: ownerId, name: 'Waypoint', visible: tabVisible }
            ],
            selectedGisTabId: PRIMARY_GIS_TAB_ID
        });
        const candidateTrack = {
            ...track('waypoint-track', ownerId),
            visible: trackVisible,
            waypointsVisible: groupVisible
        };
        const candidateWaypoint = { id: 'matrix-waypoint', visible: waypointVisible };

        assert.equal(
            isWaypointEffectivelyVisible(candidateTrack, candidateWaypoint),
            expected,
            `scheda=${tabVisible}, traccia=${trackVisible}, gruppo=${groupVisible}, waypoint=${waypointVisible}`
        );
    }
});

test('la creazione manuale usa la Scheda GIS catturata all\'inizio dell\'ingresso', () => {
    const tracks = [];
    initializeGisTabs(tracks, {
        version: GIS_TABS_SESSION_VERSION,
        gisTabs: [
            { id: PRIMARY_GIS_TAB_ID, name: 'Principale', visible: true },
            { id: 'gis-tab-alpi', name: 'Alpi', visible: true }
        ],
        selectedGisTabId: 'gis-tab-alpi'
    });
    const destinationGisTabId = captureTrackIngressGisTabId();
    selectGisTab(PRIMARY_GIS_TAB_ID, tracks);

    const created = track('manuale');
    appendTracksAtIngress(tracks, [created], { destinationGisTabId });

    assert.equal(created.gisTabId, 'gis-tab-alpi');
    assert.deepEqual(tracks.map(item => item.id), ['manuale']);
});

test('la libreria preserva un proprietario persistito valido e recupera gli orfani nella destinazione catturata', () => {
    const tracks = [];
    initializeGisTabs(tracks, {
        version: GIS_TABS_SESSION_VERSION,
        gisTabs: [
            { id: PRIMARY_GIS_TAB_ID, name: 'Principale', visible: true },
            { id: 'gis-tab-alpi', name: 'Alpi', visible: true }
        ],
        selectedGisTabId: 'gis-tab-alpi'
    });
    const destinationGisTabId = captureTrackIngressGisTabId();
    const persisted = track('persistita', PRIMARY_GIS_TAB_ID);
    const orphan = track('orfana', 'gis-tab-rimossa');

    appendTracksAtIngress(tracks, [persisted, orphan], {
        destinationGisTabId,
        preserveValidOwner: true
    });

    assert.equal(persisted.gisTabId, PRIMARY_GIS_TAB_ID);
    assert.equal(orphan.gisTabId, 'gis-tab-alpi');
});

test('gli import multipli mantengono ordine relativo e destinazione anche se la selezione cambia', () => {
    const tracks = [track('preesistente', PRIMARY_GIS_TAB_ID)];
    initializeGisTabs(tracks, {
        version: GIS_TABS_SESSION_VERSION,
        gisTabs: [
            { id: PRIMARY_GIS_TAB_ID, name: 'Principale', visible: true },
            { id: 'gis-tab-alpi', name: 'Alpi', visible: true }
        ],
        selectedGisTabId: 'gis-tab-alpi'
    });
    const destinationGisTabId = captureTrackIngressGisTabId();
    selectGisTab(PRIMARY_GIS_TAB_ID, tracks);
    const imported = [track('import-1'), track('import-2'), track('import-3')];

    appendTracksAtIngress(tracks, imported, { destinationGisTabId });

    assert.deepEqual(tracks.map(item => item.id), [
        'preesistente',
        'import-1',
        'import-2',
        'import-3'
    ]);
    assert.deepEqual(imported.map(item => item.gisTabId), [
        'gis-tab-alpi',
        'gis-tab-alpi',
        'gis-tab-alpi'
    ]);
});

test('il click cartografico seleziona la scheda proprietaria e la traccia senza cambiare visibilità', () => {
    const tracks = [
        {
            ...track('track-principale', PRIMARY_GIS_TAB_ID),
            visible: false,
            waypointsVisible: true,
            segments: [{ id: 'segmento-principale', visible: true }]
        },
        {
            ...track('track-alpi', 'gis-tab-alpi'),
            visible: true,
            waypointsVisible: false,
            segments: [{ id: 'segmento-alpi', visible: false }],
            waypoints: [{ id: 'waypoint-alpi', visible: true }]
        }
    ];
    initializeGisTabs(tracks, {
        version: GIS_TABS_SESSION_VERSION,
        gisTabs: [
            { id: PRIMARY_GIS_TAB_ID, name: 'Principale', visible: true, activeTrackId: 'track-principale' },
            { id: 'gis-tab-alpi', name: 'Alpi', visible: true, activeTrackId: null }
        ],
        selectedGisTabId: PRIMARY_GIS_TAB_ID
    });
    const visibilityBefore = JSON.parse(JSON.stringify({
        tabs: getGisTabsState().gisTabs.map(tab => tab.visible),
        tracks: tracks.map(item => ({
            visible: item.visible,
            waypointsVisible: item.waypointsVisible,
            segments: item.segments.map(segment => segment.visible),
            waypoints: item.waypoints.map(waypoint => waypoint.visible)
        }))
    }));

    assert.deepEqual(activateTrackOwnerGisTab('track-alpi', tracks), {
        gisTabId: 'gis-tab-alpi',
        trackId: 'track-alpi'
    });
    assert.equal(getGisTabsState().selectedGisTabId, 'gis-tab-alpi');
    assert.equal(
        getGisTabsState().gisTabs.find(tab => tab.id === 'gis-tab-alpi').activeTrackId,
        'track-alpi'
    );
    assert.deepEqual({
        tabs: getGisTabsState().gisTabs.map(tab => tab.visible),
        tracks: tracks.map(item => ({
            visible: item.visible,
            waypointsVisible: item.waypointsVisible,
            segments: item.segments.map(segment => segment.visible),
            waypoints: item.waypoints.map(waypoint => waypoint.visible)
        }))
    }, visibilityBefore);
});
