// history-state.js — formato atomico degli snapshot undo, senza dipendenze UI

export function buildHistoryStateJson(state, serializedTracks) {
    const headerJson = JSON.stringify({
        gisTabs: state.gisTabs,
        selectedGisTabId: state.selectedGisTabId,
        activeTrackId: state.activeTrackId,
        activeSegmentId: state.activeSegmentId
    });
    return headerJson.slice(0, -1) + ',"tracks":[' + serializedTracks.join(',') + ']}';
}

export function parseHistoryStateJson(json) {
    return JSON.parse(json);
}
