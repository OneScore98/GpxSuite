// gis-tabs.js — dominio delle Schede GIS: invarianti, proprietà e persistenza

import {
    gisTabs,
    selectedGisTabId,
    setGisTabs,
    setSelectedGisTabId
} from './state.js';

export const GIS_TABS_SESSION_VERSION = 2;
export const PRIMARY_GIS_TAB_ID = 'gis-tab-principale';

function createPrimaryGisTab(trackList, activeTrackId = null) {
    const requestedTrack = trackList.find(track => track.id === activeTrackId);
    return {
        id: PRIMARY_GIS_TAB_ID,
        name: 'Principale',
        visible: true,
        activeTrackId: requestedTrack?.id || trackList[0]?.id || null
    };
}

function normalizePersistedTabs(session, trackList) {
    if (!Array.isArray(session?.gisTabs)) return [];

    const normalized = [];
    const ids = new Set();
    for (let i = 0; i < session.gisTabs.length; i++) {
        const savedTab = session.gisTabs[i];
        const id = typeof savedTab?.id === 'string' ? savedTab.id.trim() : '';
        if (!id || ids.has(id)) continue;
        ids.add(id);
        normalized.push({
            id,
            name: typeof savedTab.name === 'string' && savedTab.name.trim()
                ? savedTab.name.trim()
                : (id === PRIMARY_GIS_TAB_ID ? 'Principale' : `Scheda ${normalized.length + 1}`),
            visible: savedTab.visible !== false,
            activeTrackId: typeof savedTab.activeTrackId === 'string' ? savedTab.activeTrackId : null
        });
    }

    if (!ids.has(PRIMARY_GIS_TAB_ID)) {
        normalized.unshift(createPrimaryGisTab(trackList, session?.activeTrackId));
    }
    return normalized;
}

export function initializeGisTabs(trackList, session = null) {
    const tracks = Array.isArray(trackList) ? trackList : [];
    const savedTabs = normalizePersistedTabs(session, tracks);
    const nextTabs = savedTabs.length > 0
        ? savedTabs
        : [createPrimaryGisTab(tracks, session?.activeTrackId)];
    const validTabIds = new Set(nextTabs.map(tab => tab.id));

    for (let i = 0; i < tracks.length; i++) {
        if (!validTabIds.has(tracks[i].gisTabId)) {
            tracks[i].gisTabId = PRIMARY_GIS_TAB_ID;
        }
    }

    for (let i = 0; i < nextTabs.length; i++) {
        const tab = nextTabs[i];
        const ownedTracks = getTracksForGisTab(tab.id, tracks);
        if (!ownedTracks.some(track => track.id === tab.activeTrackId)) {
            tab.activeTrackId = ownedTracks[0]?.id || null;
        }
    }

    const nextSelectedId = validTabIds.has(session?.selectedGisTabId)
        ? session.selectedGisTabId
        : PRIMARY_GIS_TAB_ID;
    setGisTabs(nextTabs);
    setSelectedGisTabId(nextSelectedId);
    return getGisTabsState();
}

export function getTracksForGisTab(gisTabId, trackList) {
    const tracks = Array.isArray(trackList) ? trackList : [];
    return tracks.filter(track => track.gisTabId === gisTabId);
}

export function assignTrackToGisTab(track, requestedGisTabId = selectedGisTabId) {
    if (!track || typeof track !== 'object') return null;
    if (!gisTabs.some(tab => tab.id === PRIMARY_GIS_TAB_ID)) {
        initializeGisTabs([track], null);
    }
    const destinationId = gisTabs.some(tab => tab.id === requestedGisTabId)
        ? requestedGisTabId
        : PRIMARY_GIS_TAB_ID;
    track.gisTabId = destinationId;
    return destinationId;
}

export function getGisTabsState() {
    return {
        gisTabs: gisTabs.map(tab => ({ ...tab })),
        selectedGisTabId
    };
}

export function serializeGisTabsState() {
    return {
        version: GIS_TABS_SESSION_VERSION,
        ...getGisTabsState()
    };
}
