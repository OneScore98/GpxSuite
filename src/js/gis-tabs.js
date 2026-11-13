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

function gisTabNameKey(name) {
    return String(name || '').trim().toLocaleLowerCase('it');
}

function firstAvailableGisTabName(usedNames) {
    let number = 1;
    while (usedNames.has(gisTabNameKey(`Scheda ${number}`))) number += 1;
    return `Scheda ${number}`;
}

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
    const usedNames = new Set();
    for (let i = 0; i < session.gisTabs.length; i++) {
        const savedTab = session.gisTabs[i];
        const id = typeof savedTab?.id === 'string' ? savedTab.id.trim() : '';
        if (!id || ids.has(id)) continue;
        ids.add(id);
        const requestedName = typeof savedTab.name === 'string' ? savedTab.name.trim() : '';
        const requestedNameKey = gisTabNameKey(requestedName);
        const name = requestedName && !usedNames.has(requestedNameKey)
            ? requestedName
            : (id === PRIMARY_GIS_TAB_ID && !usedNames.has(gisTabNameKey('Principale'))
                ? 'Principale'
                : firstAvailableGisTabName(usedNames));
        usedNames.add(gisTabNameKey(name));
        normalized.push({
            id,
            name,
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

export function areTracksInSameGisTab(trackIds, trackList, requiredGisTabId = null) {
    const ids = Array.isArray(trackIds) ? trackIds : [];
    const tracks = Array.isArray(trackList) ? trackList : [];
    if (ids.length === 0) return false;

    const firstTrack = tracks.find(track => track.id === ids[0]);
    const ownerGisTabId = requiredGisTabId || firstTrack?.gisTabId;
    if (!ownerGisTabId) return false;
    return ids.every(trackId => tracks.some(track => (
        track.id === trackId && track.gisTabId === ownerGisTabId
    )));
}

export function isTrackEffectivelyVisible(track) {
    if (!track || track.visible === false) return false;
    const ownerTab = gisTabs.find(tab => tab.id === track.gisTabId);
    return Boolean(ownerTab) && ownerTab.visible !== false;
}

export function isSegmentEffectivelyVisible(track, segment) {
    return isTrackEffectivelyVisible(track) && Boolean(segment) && segment.visible !== false;
}

export function isGeometryEditable(track, segment = null) {
    return segment === null
        ? isTrackEffectivelyVisible(track)
        : isSegmentEffectivelyVisible(track, segment);
}

export function isWaypointEffectivelyVisible(track, waypoint) {
    return isTrackEffectivelyVisible(track)
        && track.waypointsVisible !== false
        && Boolean(waypoint)
        && waypoint.visible !== false;
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

export function moveTrackToGisTab(trackId, destinationGisTabId, trackList) {
    const tracks = Array.isArray(trackList) ? trackList : [];
    const trackIndex = tracks.findIndex(track => track.id === trackId);
    const movedTrack = tracks[trackIndex];
    const sourceGisTabId = movedTrack?.gisTabId;
    if (
        trackIndex === -1 ||
        sourceGisTabId === destinationGisTabId ||
        !gisTabs.some(tab => tab.id === sourceGisTabId) ||
        !gisTabs.some(tab => tab.id === destinationGisTabId)
    ) {
        return null;
    }

    const sourceTab = gisTabs.find(tab => tab.id === sourceGisTabId);
    const sourceTracks = getTracksForGisTab(sourceGisTabId, tracks);
    const sourceTrackIndex = sourceTracks.findIndex(track => track.id === trackId);
    const sourceActiveTrackId = sourceTab.activeTrackId === trackId
        ? (sourceTracks[sourceTrackIndex - 1]?.id || sourceTracks[sourceTrackIndex + 1]?.id || null)
        : sourceTab.activeTrackId;
    if (sourceActiveTrackId !== sourceTab.activeTrackId) {
        setGisTabs(gisTabs.map(tab => tab.id === sourceGisTabId
            ? { ...tab, activeTrackId: sourceActiveTrackId }
            : tab));
    }

    tracks.splice(trackIndex, 1);
    let destinationLastIndex = -1;
    for (let i = 0; i < tracks.length; i++) {
        if (tracks[i].gisTabId === destinationGisTabId) destinationLastIndex = i;
    }
    movedTrack.gisTabId = destinationGisTabId;
    tracks.splice(destinationLastIndex + 1, 0, movedTrack);

    return {
        trackId: movedTrack.id,
        sourceGisTabId,
        destinationGisTabId,
        sourceActiveTrackId
    };
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
    const usedNames = new Set(gisTabs.map(tab => gisTabNameKey(tab.name)));

    const tab = {
        id: createUniqueGisTabId(),
        name: firstAvailableGisTabName(usedNames),
        visible: true,
        activeTrackId: null
    };
    setGisTabs([...gisTabs, tab]);
    setSelectedGisTabId(tab.id);
    return { ...tab };
}

export function deleteGisTab(gisTabId, trackList) {
    if (gisTabs.length <= 1) return null;
    const tabIndex = gisTabs.findIndex(tab => tab.id === gisTabId);
    if (tabIndex === -1) return null;
    const tracks = Array.isArray(trackList) ? trackList : [];
    const deletedTab = gisTabs[tabIndex];
    const deletedTracks = tracks.filter(track => track.gisTabId === gisTabId);
    for (let i = tracks.length - 1; i >= 0; i--) {
        if (tracks[i].gisTabId === gisTabId) tracks.splice(i, 1);
    }

    const nextTabs = gisTabs.filter(tab => tab.id !== gisTabId);
    let nextSelectedGisTabId = selectedGisTabId;
    if (selectedGisTabId === gisTabId) {
        nextSelectedGisTabId = nextTabs[tabIndex - 1]?.id || nextTabs[tabIndex]?.id || null;
    }
    const selectedTab = nextTabs.find(tab => tab.id === nextSelectedGisTabId);
    const selectedTracks = getTracksForGisTab(nextSelectedGisTabId, tracks);
    const nextActiveTrackId = selectedTracks.some(track => track.id === selectedTab?.activeTrackId)
        ? selectedTab.activeTrackId
        : (selectedTracks[0]?.id || null);

    setGisTabs(nextTabs);
    setSelectedGisTabId(nextSelectedGisTabId);
    return {
        deletedTab: { ...deletedTab },
        deletedTracks,
        selectedGisTabId: nextSelectedGisTabId,
        activeTrackId: nextActiveTrackId
    };
}

export function renameGisTab(gisTabId, requestedName) {
    const tab = gisTabs.find(item => item.id === gisTabId);
    const cleanName = String(requestedName || '').trim();
    if (!tab) return null;
    if (!cleanName) return tab.name;
    const comparisonName = gisTabNameKey(cleanName);
    const hasCollision = gisTabs.some(item => item.id !== gisTabId &&
        gisTabNameKey(item.name) === comparisonName);
    if (hasCollision) return null;
    setGisTabs(gisTabs.map(item => item.id === gisTabId
        ? { ...item, name: cleanName }
        : item));
    return cleanName;
}

export function reorderGisTab(gisTabId, targetGisTabId, position = 'before') {
    const fromIndex = gisTabs.findIndex(tab => tab.id === gisTabId);
    const targetIndex = gisTabs.findIndex(tab => tab.id === targetGisTabId);
    if (fromIndex === -1 || targetIndex === -1 || fromIndex === targetIndex) return false;

    const nextTabs = gisTabs.slice();
    const [movedTab] = nextTabs.splice(fromIndex, 1);
    const adjustedTargetIndex = nextTabs.findIndex(tab => tab.id === targetGisTabId);
    const insertIndex = adjustedTargetIndex + (position === 'after' ? 1 : 0);
    nextTabs.splice(insertIndex, 0, movedTab);
    setGisTabs(nextTabs);
    return true;
}

export function toggleGisTabVisibility(gisTabId) {
    const tab = gisTabs.find(item => item.id === gisTabId);
    if (!tab) return null;
    const nextVisible = tab.visible === false;
    setGisTabs(gisTabs.map(item => item.id === gisTabId
        ? { ...item, visible: nextVisible }
        : item));
    return nextVisible;
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

export function activateTrackOwnerGisTab(trackId, trackList) {
    const tracks = Array.isArray(trackList) ? trackList : [];
    const track = tracks.find(item => item.id === trackId);
    if (!track || !gisTabs.some(tab => tab.id === track.gisTabId)) return null;

    selectGisTab(track.gisTabId, tracks);
    rememberActiveTrackForSelectedGisTab(track.id, tracks);
    return {
        gisTabId: track.gisTabId,
        trackId: track.id
    };
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

function persistedTrackId(track) {
    return track?.localFileId || track?.id || null;
}

export function serializeGisTabsSession(trackList) {
    const tracks = Array.isArray(trackList) ? trackList : [];
    return {
        ...serializeGisTabsState(),
        trackOrder: tracks.map(persistedTrackId).filter(Boolean)
    };
}

export function restoreGisTabsSession(trackList, session = null) {
    const tracks = Array.isArray(trackList) ? trackList : [];
    const requestedOrder = Array.isArray(session?.trackOrder) ? session.trackOrder : [];
    if (requestedOrder.length > 0) {
        const orderById = new Map();
        for (let i = 0; i < requestedOrder.length; i++) {
            if (!orderById.has(requestedOrder[i])) orderById.set(requestedOrder[i], i);
        }
        const originalIndex = new Map(tracks.map((track, index) => [track, index]));
        tracks.sort((a, b) => {
            const aIndex = orderById.get(persistedTrackId(a));
            const bIndex = orderById.get(persistedTrackId(b));
            const aOrder = aIndex === undefined ? Number.MAX_SAFE_INTEGER : aIndex;
            const bOrder = bIndex === undefined ? Number.MAX_SAFE_INTEGER : bIndex;
            return aOrder - bOrder || originalIndex.get(a) - originalIndex.get(b);
        });
    }

    const ownersBeforeRestore = new Map(tracks.map(track => [track, track?.gisTabId]));
    const state = initializeGisTabs(tracks, session);
    const repairedTrackIds = tracks
        .filter(track => ownersBeforeRestore.get(track) !== track.gisTabId)
        .map(track => track.id);
    const canonicalSession = serializeGisTabsSession(tracks);
    const persistedShape = {
        version: session?.version,
        gisTabs: session?.gisTabs,
        selectedGisTabId: session?.selectedGisTabId,
        trackOrder: session?.trackOrder
    };

    return {
        ...state,
        repairedTrackIds,
        needsPersistence: JSON.stringify(persistedShape) !== JSON.stringify(canonicalSession)
    };
}
