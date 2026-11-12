// gis-tabs.js — dominio delle Schede GIS: invarianti, proprietà e persistenza

import {
    gisTabs,
    selectedGisTabId,
    setGisTabs,
    setSelectedGisTabId
} from './state.js';

export const GIS_TABS_SESSION_VERSION = 2;
export const PRIMARY_GIS_TAB_ID = 'gis-tab-principale';
let nextGisTabSequence = 0;

function createUniqueGisTabId() {
    let id;
    do {
        nextGisTabSequence += 1;
        id = `gis-tab-${Date.now()}-${nextGisTabSequence}`;
    } while (gisTabs.some(tab => tab.id === id));
    return id;
}

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

export function getSelectedGisTabTracks(trackList) {
    return getTracksForGisTab(selectedGisTabId, trackList);
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

export function inheritTrackGisTab(track, sourceTrack) {
    return assignTrackToGisTab(track, sourceTrack?.gisTabId);
}

export function captureTrackIngressGisTabId() {
    return gisTabs.some(tab => tab.id === selectedGisTabId)
        ? selectedGisTabId
        : PRIMARY_GIS_TAB_ID;
}

export function assignTrackAtIngress(track, options = {}) {
    const hasValidOwner = options.preserveValidOwner === true &&
        gisTabs.some(tab => tab.id === track?.gisTabId);
    if (hasValidOwner) return track.gisTabId;
    return assignTrackToGisTab(
        track,
        options.destinationGisTabId || captureTrackIngressGisTabId()
    );
}

export function appendTracksAtIngress(trackList, incomingTracks, options = {}) {
    const targetTracks = Array.isArray(trackList) ? trackList : [];
    const tracksToAppend = Array.isArray(incomingTracks) ? incomingTracks : [];

    for (let i = 0; i < tracksToAppend.length; i++) {
        const track = tracksToAppend[i];
        assignTrackAtIngress(track, options);
        targetTracks.push(track);
    }
    return tracksToAppend;
}

export function createGisTab() {
    if (gisTabs.length === 0) initializeGisTabs([], null);
    const usedNames = new Set(gisTabs.map(tab => String(tab.name || '').trim().toLocaleLowerCase('it')));
    let number = 1;
    while (usedNames.has(`scheda ${number}`)) number += 1;

    const tab = {
        id: createUniqueGisTabId(),
        name: `Scheda ${number}`,
        visible: true,
        activeTrackId: null
    };
    setGisTabs([...gisTabs, tab]);
    setSelectedGisTabId(tab.id);
    return { ...tab };
}

export function selectGisTab(gisTabId, trackList) {
    const tab = gisTabs.find(item => item.id === gisTabId);
    if (!tab) return null;

    const ownedTracks = getTracksForGisTab(tab.id, trackList);
    const nextActiveTrackId = ownedTracks.some(track => track.id === tab.activeTrackId)
        ? tab.activeTrackId
        : (ownedTracks[0]?.id || null);
    if (nextActiveTrackId !== tab.activeTrackId) {
        setGisTabs(gisTabs.map(item => item.id === tab.id
            ? { ...item, activeTrackId: nextActiveTrackId }
            : item));
    }
    setSelectedGisTabId(tab.id);
    return nextActiveTrackId;
}

export function rememberActiveTrackForSelectedGisTab(trackId, trackList) {
    const track = getTracksForGisTab(selectedGisTabId, trackList)
        .find(item => item.id === trackId);
    if (!track) return false;
    setGisTabs(gisTabs.map(tab => tab.id === selectedGisTabId
        ? { ...tab, activeTrackId: track.id }
        : tab));
    return true;
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
