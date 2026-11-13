// gis-tabs.js — dominio delle Schede GIS: invarianti, proprietà e persistenza

import {
    gisTabs,
    selectedGisTabId,
    setGisTabs,
    setSelectedGisTabId
} from './state.js';

export const VERSIONE_SESSIONE_SCHEDE_GIS = 2;
export const ID_SCHEDA_GIS_PRINCIPALE = 'gis-tab-principale';
export const GIS_TABS_SESSION_VERSION = VERSIONE_SESSIONE_SCHEDE_GIS;
export const PRIMARY_GIS_TAB_ID = ID_SCHEDA_GIS_PRINCIPALE;
export const MESSAGGIO_GEOMETRIA_NON_MODIFICABILE =
    'Modifica geometrica non disponibile: rendi visibili la Scheda GIS, la traccia e il segmento.';
let prossimaSequenzaSchedaGis = 0;

function chiaveNomeSchedaGis(name) {
    return String(name || '').trim().toLocaleLowerCase('it');
}

function primoNomeSchedaGisDisponibile(nomiUsati) {
    let number = 1;
    while (nomiUsati.has(chiaveNomeSchedaGis(`Scheda ${number}`))) number += 1;
    return `Scheda ${number}`;
}

function creaIdSchedaGisUnivoco() {
    let id;
    do {
        prossimaSequenzaSchedaGis += 1;
        id = `gis-tab-${Date.now()}-${prossimaSequenzaSchedaGis}`;
    } while (gisTabs.some(tab => tab.id === id));
    return id;
}

function creaSchedaGisPrincipale(trackList, activeTrackId = null) {
    const requestedTrack = trackList.find(track => track.id === activeTrackId);
    return {
        id: PRIMARY_GIS_TAB_ID,
        name: 'Principale',
        visible: true,
        activeTrackId: requestedTrack?.id || trackList[0]?.id || null
    };
}

function normalizzaSchedeGisPersistite(session, trackList) {
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
        const requestedNameKey = chiaveNomeSchedaGis(requestedName);
        const name = requestedName && !usedNames.has(requestedNameKey)
            ? requestedName
            : (id === PRIMARY_GIS_TAB_ID && !usedNames.has(chiaveNomeSchedaGis('Principale'))
                ? 'Principale'
                : primoNomeSchedaGisDisponibile(usedNames));
        usedNames.add(chiaveNomeSchedaGis(name));
        normalized.push({
            id,
            name,
            visible: savedTab.visible !== false,
            activeTrackId: typeof savedTab.activeTrackId === 'string' ? savedTab.activeTrackId : null
        });
    }

    if (!ids.has(PRIMARY_GIS_TAB_ID)) {
        normalized.unshift(creaSchedaGisPrincipale(trackList, session?.activeTrackId));
    }
    return normalized;
}

export function inizializzaSchedeGis(trackList, session = null) {
    const tracks = Array.isArray(trackList) ? trackList : [];
    const savedTabs = normalizzaSchedeGisPersistite(session, tracks);
    const nextTabs = savedTabs.length > 0
        ? savedTabs
        : [creaSchedaGisPrincipale(tracks, session?.activeTrackId)];
    const validTabIds = new Set(nextTabs.map(tab => tab.id));

    for (let i = 0; i < tracks.length; i++) {
        if (!validTabIds.has(tracks[i].gisTabId)) {
            tracks[i].gisTabId = PRIMARY_GIS_TAB_ID;
        }
    }

    for (let i = 0; i < nextTabs.length; i++) {
        const tab = nextTabs[i];
        const ownedTracks = tracceDellaSchedaGis(tab.id, tracks);
        if (!ownedTracks.some(track => track.id === tab.activeTrackId)) {
            tab.activeTrackId = ownedTracks[0]?.id || null;
        }
    }

    const nextSelectedId = validTabIds.has(session?.selectedGisTabId)
        ? session.selectedGisTabId
        : PRIMARY_GIS_TAB_ID;
    setGisTabs(nextTabs);
    setSelectedGisTabId(nextSelectedId);
    return leggiStatoSchedeGis();
}

export function tracceDellaSchedaGis(gisTabId, trackList) {
    const tracks = Array.isArray(trackList) ? trackList : [];
    return tracks.filter(track => track.gisTabId === gisTabId);
}

export function tracceDellaSchedaGisSelezionata(trackList) {
    return tracceDellaSchedaGis(selectedGisTabId, trackList);
}

export function tracceNellaStessaSchedaGis(trackIds, trackList, requiredGisTabId = null) {
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

export function tracciaVisibileEffettivamente(track) {
    if (!track || track.visible === false) return false;
    const ownerTab = gisTabs.find(tab => tab.id === track.gisTabId);
    return Boolean(ownerTab) && ownerTab.visible !== false;
}

export function segmentoVisibileEffettivamente(track, segment) {
    return tracciaVisibileEffettivamente(track) && Boolean(segment) && segment.visible !== false;
}

export function puoModificareGeometria(track, segment = null) {
    return segment === null
        ? tracciaVisibileEffettivamente(track)
        : segmentoVisibileEffettivamente(track, segment);
}

// Alias di compatibilità per le integrazioni nate con la prima API.
export const isGeometryEditable = puoModificareGeometria;

export function sonoElementiGeometriciModificabili(elementi) {
    const elenco = Array.isArray(elementi) ? elementi : [];
    return elenco.length > 0 && elenco.every(elemento => (
        puoModificareGeometria(elemento?.traccia, elemento?.segmento || null)
    ));
}

export function waypointVisibileEffettivamente(track, waypoint) {
    return tracciaVisibileEffettivamente(track)
        && track.waypointsVisible !== false
        && Boolean(waypoint)
        && waypoint.visible !== false;
}

export function assegnaTracciaASchedaGis(track, requestedGisTabId = selectedGisTabId) {
    if (!track || typeof track !== 'object') return null;
    if (!gisTabs.some(tab => tab.id === PRIMARY_GIS_TAB_ID)) {
        inizializzaSchedeGis([track], null);
    }
    const destinationId = gisTabs.some(tab => tab.id === requestedGisTabId)
        ? requestedGisTabId
        : PRIMARY_GIS_TAB_ID;
    track.gisTabId = destinationId;
    return destinationId;
}

export function ereditaSchedaGisDallaTraccia(track, sourceTrack) {
    return assegnaTracciaASchedaGis(track, sourceTrack?.gisTabId);
}

export function spostaTracciaInSchedaGis(trackId, destinationGisTabId, trackList) {
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
    const sourceTracks = tracceDellaSchedaGis(sourceGisTabId, tracks);
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

export function catturaDestinazioneIngressoTraccia() {
    return gisTabs.some(tab => tab.id === selectedGisTabId)
        ? selectedGisTabId
        : PRIMARY_GIS_TAB_ID;
}
export const captureTrackIngressGisTabId = catturaDestinazioneIngressoTraccia;

export function assegnaTracciaInIngresso(track, options = {}) {
    const hasValidOwner = options.preserveValidOwner === true &&
        gisTabs.some(tab => tab.id === track?.gisTabId);
    if (hasValidOwner) return track.gisTabId;
    return assegnaTracciaASchedaGis(
        track,
        options.idSchedaDestinazione || options.destinationGisTabId || catturaDestinazioneIngressoTraccia()
    );
}
export const assignTrackAtIngress = assegnaTracciaInIngresso;

export function inserisciTracceInIngresso(trackList, incomingTracks, options = {}) {
    const targetTracks = Array.isArray(trackList) ? trackList : [];
    const tracksToAppend = Array.isArray(incomingTracks) ? incomingTracks : [];

    const indiceRichiesto = options.indiceInserimento ?? options.insertionIndex;
    let insertionIndex = Number.isInteger(indiceRichiesto)
        ? Math.max(0, Math.min(indiceRichiesto, targetTracks.length))
        : targetTracks.length;

    for (let i = 0; i < tracksToAppend.length; i++) {
        const track = tracksToAppend[i];
        assegnaTracciaInIngresso(track, options);
        targetTracks.splice(insertionIndex, 0, track);
        insertionIndex += 1;
    }
    return tracksToAppend;
}
export const appendTracksAtIngress = inserisciTracceInIngresso;

export function creaSchedaGis() {
    if (gisTabs.length === 0) inizializzaSchedeGis([], null);
    const usedNames = new Set(gisTabs.map(tab => chiaveNomeSchedaGis(tab.name)));

    const tab = {
        id: creaIdSchedaGisUnivoco(),
        name: primoNomeSchedaGisDisponibile(usedNames),
        visible: true,
        activeTrackId: null
    };
    setGisTabs([...gisTabs, tab]);
    setSelectedGisTabId(tab.id);
    return { ...tab };
}

export function eliminaSchedaGis(gisTabId, trackList) {
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
    const selectedTracks = tracceDellaSchedaGis(nextSelectedGisTabId, tracks);
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

export function rinominaSchedaGis(gisTabId, requestedName) {
    const tab = gisTabs.find(item => item.id === gisTabId);
    const cleanName = String(requestedName || '').trim();
    if (!tab) return null;
    if (!cleanName) return tab.name;
    const comparisonName = chiaveNomeSchedaGis(cleanName);
    const hasCollision = gisTabs.some(item => item.id !== gisTabId &&
        chiaveNomeSchedaGis(item.name) === comparisonName);
    if (hasCollision) return null;
    setGisTabs(gisTabs.map(item => item.id === gisTabId
        ? { ...item, name: cleanName }
        : item));
    return cleanName;
}

export function riordinaSchedaGis(gisTabId, targetGisTabId, position = 'before') {
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

export function alternaVisibilitaSchedaGis(gisTabId) {
    const tab = gisTabs.find(item => item.id === gisTabId);
    if (!tab) return null;
    const nextVisible = tab.visible === false;
    setGisTabs(gisTabs.map(item => item.id === gisTabId
        ? { ...item, visible: nextVisible }
        : item));
    return nextVisible;
}

export function selezionaSchedaGis(gisTabId, trackList) {
    const tab = gisTabs.find(item => item.id === gisTabId);
    if (!tab) return null;

    const ownedTracks = tracceDellaSchedaGis(tab.id, trackList);
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

export function ricordaTracciaAttivaDellaScheda(trackId, trackList) {
    const track = tracceDellaSchedaGis(selectedGisTabId, trackList)
        .find(item => item.id === trackId);
    if (!track) return false;
    setGisTabs(gisTabs.map(tab => tab.id === selectedGisTabId
        ? { ...tab, activeTrackId: track.id }
        : tab));
    return true;
}

export function attivaSchedaProprietariaDellaTraccia(trackId, trackList) {
    const tracks = Array.isArray(trackList) ? trackList : [];
    const track = tracks.find(item => item.id === trackId);
    if (!track || !gisTabs.some(tab => tab.id === track.gisTabId)) return null;

    selezionaSchedaGis(track.gisTabId, tracks);
    ricordaTracciaAttivaDellaScheda(track.id, tracks);
    return {
        gisTabId: track.gisTabId,
        trackId: track.id
    };
}

export function leggiStatoSchedeGis() {
    return {
        gisTabs: gisTabs.map(tab => ({ ...tab })),
        selectedGisTabId
    };
}

export function serializzaStatoSchedeGis() {
    return {
        version: GIS_TABS_SESSION_VERSION,
        ...leggiStatoSchedeGis()
    };
}

function persistedTrackId(track) {
    return track?.localFileId || track?.id || null;
}

export function serializzaSessioneSchedeGis(trackList) {
    const tracks = Array.isArray(trackList) ? trackList : [];
    return {
        ...serializzaStatoSchedeGis(),
        trackOrder: tracks.map(persistedTrackId).filter(Boolean)
    };
}

export function ripristinaSessioneSchedeGis(trackList, session = null) {
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
    const state = inizializzaSchedeGis(tracks, session);
    const repairedTrackIds = tracks
        .filter(track => ownersBeforeRestore.get(track) !== track.gisTabId)
        .map(track => track.id);
    const canonicalSession = serializzaSessioneSchedeGis(tracks);
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

// Alias inglesi di compatibilità per le sessioni e le integrazioni già distribuite.
export {
    inizializzaSchedeGis as initializeGisTabs,
    tracceDellaSchedaGis as getTracksForGisTab,
    tracceDellaSchedaGisSelezionata as getSelectedGisTabTracks,
    tracceNellaStessaSchedaGis as areTracksInSameGisTab,
    tracciaVisibileEffettivamente as isTrackEffectivelyVisible,
    segmentoVisibileEffettivamente as isSegmentEffectivelyVisible,
    waypointVisibileEffettivamente as isWaypointEffectivelyVisible,
    assegnaTracciaASchedaGis as assignTrackToGisTab,
    ereditaSchedaGisDallaTraccia as inheritTrackGisTab,
    spostaTracciaInSchedaGis as moveTrackToGisTab,
    creaSchedaGis as createGisTab,
    eliminaSchedaGis as deleteGisTab,
    rinominaSchedaGis as renameGisTab,
    riordinaSchedaGis as reorderGisTab,
    alternaVisibilitaSchedaGis as toggleGisTabVisibility,
    selezionaSchedaGis as selectGisTab,
    ricordaTracciaAttivaDellaScheda as rememberActiveTrackForSelectedGisTab,
    attivaSchedaProprietariaDellaTraccia as activateTrackOwnerGisTab,
    leggiStatoSchedeGis as getGisTabsState,
    serializzaStatoSchedeGis as serializeGisTabsState,
    serializzaSessioneSchedeGis as serializeGisTabsSession,
    ripristinaSessioneSchedeGis as restoreGisTabsSession
};
