// history-state.js — formato atomico degli snapshot undo, senza dipendenze UI

export function costruisciJsonStatoCronologia(stato, tracceSerializzate) {
    const intestazioneJson = JSON.stringify({
        gisTabs: stato.gisTabs,
        selectedGisTabId: stato.selectedGisTabId,
        activeTrackId: stato.activeTrackId,
        activeSegmentId: stato.activeSegmentId
    });
    return intestazioneJson.slice(0, -1) + ',"tracks":[' + tracceSerializzate.join(',') + ']}';
}

export function analizzaJsonStatoCronologia(json) {
    return JSON.parse(json);
}

// Alias di compatibilità per gli snapshot e le integrazioni già distribuite.
export const buildHistoryStateJson = costruisciJsonStatoCronologia;
export const parseHistoryStateJson = analizzaJsonStatoCronologia;
