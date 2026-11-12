import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildHistoryStateJson,
    parseHistoryStateJson
} from '../src/js/history-state.js';

test('uno snapshot undo conserva atomicamente schede, selezione, ultime attive, ordine e proprietari', () => {
    const json = buildHistoryStateJson({
        gisTabs: [
            { id: 'tab-a', name: 'A', visible: false, activeTrackId: 'track-a' },
            { id: 'tab-b', name: 'B', visible: true, activeTrackId: 'track-b' }
        ],
        selectedGisTabId: 'tab-b',
        activeTrackId: 'track-b',
        activeSegmentId: 'segment-b'
    }, [
        JSON.stringify({ id: 'track-a', gisTabId: 'tab-a', segments: [], waypoints: [] }),
        JSON.stringify({ id: 'track-b', gisTabId: 'tab-b', segments: [{ id: 'segment-b' }], waypoints: [] })
    ]);

    assert.deepEqual(parseHistoryStateJson(json), {
        gisTabs: [
            { id: 'tab-a', name: 'A', visible: false, activeTrackId: 'track-a' },
            { id: 'tab-b', name: 'B', visible: true, activeTrackId: 'track-b' }
        ],
        selectedGisTabId: 'tab-b',
        activeTrackId: 'track-b',
        activeSegmentId: 'segment-b',
        tracks: [
            { id: 'track-a', gisTabId: 'tab-a', segments: [], waypoints: [] },
            { id: 'track-b', gisTabId: 'tab-b', segments: [{ id: 'segment-b' }], waypoints: [] }
        ]
    });
});
