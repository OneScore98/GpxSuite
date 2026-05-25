// main.js — Entry point: importa tutto, chiama init al DOMContentLoaded

import {
    MAPILLARY_TOKEN_KEY,
    setMap,
    setMapLoaded,
    NEXTZEN_TERRAIN_SOURCE,
    is3D,
    setTracks,
    setActiveTrackId,
    setActiveSegmentId,
    setUndoStack,
    setIsDrawing,
    setIsCutting,
    setIsBoxDeleting,
    setIsAddingWaypoint
} from './state.js';

import {
    setupLayers, updateMapData, setBaseMap, setDimensionMode, flyToPOI,
    configureMapillaryToken, setMapillaryCoverageVisible, closeMapillaryViewer
} from './map.js';
import { initChart } from './stats.js';
import { importGPX, exportGPX } from './gpx.js';
import { addPointToActiveSegment, cutTrackAtPoint, handleBoxDeleteClick, saveHistoryState, triggerUndo, setSnapProfile } from './tracks.js';
import { addWaypointAtCoords, saveWaypointModifications, openWaypointEditor, updateWaypointsOnMap } from './waypoints.js';
import { flushPersistedStateNow, schedulePersistAppSession } from './storage.js';
import {
    togglePrintPlanning, disablePrintPlanning,
    setupPrintDragEvents, updatePrintGridLayout, updatePrintGridScale,
    setPrintPlanningOrientation, generateHighResPrintPreview, syncPrintOutputFromPreview
} from './print.js';
import {
    injectDeps, setupEvents, setupPrintUiEvents, createNewTrack, renderGisTree,
    restoreStoredTracksOnStartup,
    openStoredTrackFromLibrary, deleteStoredTrackFromLibrary,
    handleGisDragStart, handleGisDragOver, handleGisDrop, handleGisDragEnd,
    updateActiveTracksHeader, showToast,
    setTrackActive, renameTrack, changeTrackColor, changeTrackWidth, toggleTrackVisibility,
    handleTrackContextMenu, handleTrackPointerDown, clearTrackLongPress,
    handleTrackTreeClick, handleSegmentTreeClick, handleSegmentContextMenu, handleSegmentPointerDown,
    copyTreeSelection, cutTreeSelection, pasteTreeSelection, duplicateTreeSelection, deleteTreeSelection,
    handleTrackNamePointerDown, clearTrackNameLongPress,
    handleTrackNameClick, openTrackNameEditor, finishTrackNameEditor, handleTrackNameKeydown,
    toggleAllWaypointsVisibility, toggleWaypointVisibility, toggleSegmentVisibility,
    deleteTrack, addNewSegmentToTrack, renameSegment, renameSegmentFromMenu, extractOffroadFromTrack, extractOffroadFromSegment, setSegmentActive, deleteSegment,
    zoomToWaypoint, deleteWaypoint, searchNominatim
} from './ui.js';
import { initAuth, onAuthChange, isAuthenticated } from './auth.js';

// Inietta le dipendenze circolari in ui.js prima che venga usata
injectDeps({
    updateMapData,
    saveHistoryState,
    setBaseMap,
    setDimensionMode,
    setMapillaryCoverageVisible,
    configureMapillaryToken,
    closeMapillaryViewer,
    flyToPOI,
    triggerUndo,
    importGPX,
    exportGPX,
    addPointToActiveSegment,
    cutTrackAtPoint,
    handleBoxDeleteClick,
    addWaypointAtCoords,
    saveWaypointModifications,
    setSnapProfile,
    togglePrintPlanning,
    disablePrintPlanning,
    updatePrintGridLayout,
    updatePrintGridScale,
    setPrintPlanningOrientation,
    generateHighResPrintPreview,
    syncPrintOutputFromPreview
});

// Esponi le funzioni richiamate dagli handler inline HTML (onclick="...")
window.flyToPOI = flyToPOI;
window.setTrackActive = setTrackActive;
window.renameTrack = renameTrack;
window.changeTrackColor = changeTrackColor;
window.changeTrackWidth = changeTrackWidth;
window.toggleTrackVisibility = toggleTrackVisibility;
window.handleTrackContextMenu = handleTrackContextMenu;
window.handleTrackPointerDown = handleTrackPointerDown;
window.clearTrackLongPress = clearTrackLongPress;
window.handleTrackTreeClick = handleTrackTreeClick;
window.handleSegmentTreeClick = handleSegmentTreeClick;
window.handleSegmentContextMenu = handleSegmentContextMenu;
window.handleSegmentPointerDown = handleSegmentPointerDown;
window.copyTreeSelection = copyTreeSelection;
window.cutTreeSelection = cutTreeSelection;
window.pasteTreeSelection = pasteTreeSelection;
window.duplicateTreeSelection = duplicateTreeSelection;
window.deleteTreeSelection = deleteTreeSelection;
window.handleTrackNamePointerDown = handleTrackNamePointerDown;
window.clearTrackNameLongPress = clearTrackNameLongPress;
window.handleTrackNameClick = handleTrackNameClick;
window.openTrackNameEditor = openTrackNameEditor;
window.finishTrackNameEditor = finishTrackNameEditor;
window.handleTrackNameKeydown = handleTrackNameKeydown;
window.toggleAllWaypointsVisibility = toggleAllWaypointsVisibility;
window.toggleWaypointVisibility = toggleWaypointVisibility;
window.toggleSegmentVisibility = toggleSegmentVisibility;
window.deleteTrack = deleteTrack;
window.addNewSegmentToTrack = addNewSegmentToTrack;
window.renameSegment = renameSegment;
window.renameSegmentFromMenu = renameSegmentFromMenu;
window.extractOffroadFromTrack = extractOffroadFromTrack;
window.extractOffroadFromSegment = extractOffroadFromSegment;
window.setSegmentActive = setSegmentActive;
window.deleteSegment = deleteSegment;
window.zoomToWaypoint = zoomToWaypoint;
window.deleteWaypoint = deleteWaypoint;
window.openWaypointEditor = openWaypointEditor;
window.openStoredTrackFromLibrary = openStoredTrackFromLibrary;
window.deleteStoredTrackFromLibrary = deleteStoredTrackFromLibrary;
window.handleGisDragStart = handleGisDragStart;
window.handleGisDragOver = handleGisDragOver;
window.handleGisDrop = handleGisDrop;
window.handleGisDragEnd = handleGisDragEnd;

function updateViewportMetrics() {
    const vv = window.visualViewport;
    const viewportHeight = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-height', `${Math.round(viewportHeight)}px`);
}

function configureMapInteractions(mapInstance) {
    // Desktop: MapLibre usa il drag con Ctrl per rotazione/inclinazione.
    if (mapInstance.dragRotate) {
        mapInstance.dragRotate.enable();
    }

    // Touch: abilita il pitch con trascinamento a due dita in stile globe/mappe 3D.
    if ((navigator.maxTouchPoints || 0) > 0 && mapInstance.touchPitch) {
        mapInstance.touchPitch.enable();
    }

    const enableTerrainForCameraGesture = () => {
        if (!isAuthenticated()) return;
        if (is3D) return;
        setDimensionMode(true, { silent: true, preserveCamera: true });
    };
    mapInstance.on('pitchstart', enableTerrainForCameraGesture);
    mapInstance.on('rotatestart', enableTerrainForCameraGesture);

    const canvas = mapInstance.getCanvas();
    const maybeEnableTerrainForMouse = (e) => {
        if (e.ctrlKey && e.buttons === 1) enableTerrainForCameraGesture();
    };
    canvas.addEventListener('mousedown', maybeEnableTerrainForMouse);
    canvas.addEventListener('mousemove', maybeEnableTerrainForMouse);
    canvas.addEventListener('touchstart', (e) => {
        if (e.touches && e.touches.length >= 2) enableTerrainForCameraGesture();
    }, { passive: true });
}

let workspaceLoadedForAuth = false;

async function restoreWorkspaceForAuthenticatedUser() {
    if (!isAuthenticated() || workspaceLoadedForAuth) return;
    workspaceLoadedForAuth = true;
    configureMapillaryToken(localStorage.getItem(MAPILLARY_TOKEN_KEY) || '', { allowUnauthenticated: false });

    try {
        const restoreResult = await restoreStoredTracksOnStartup();
        if (restoreResult.restoredCount === 0) {
            createNewTrack("Traccia 1");
        } else {
            showToast("Ripristinato l'ultimo stato locale", "success");
        }
    } catch (err) {
        console.error(err);
        showToast("Archivio locale non disponibile in questo browser", "error");
        createNewTrack("Traccia 1");
    }
}

function clearWorkspaceAfterLogout() {
    workspaceLoadedForAuth = false;
    setIsDrawing(false);
    setIsCutting(false);
    setIsBoxDeleting(false);
    setIsAddingWaypoint(false);
    setSnapProfile('off', { silent: true, allowUnauthenticated: true });
    setTracks([]);
    setActiveTrackId(null);
    setActiveSegmentId(null);
    setUndoStack([]);
    closeMapillaryViewer();
    setMapillaryCoverageVisible(false, { silent: true, allowUnauthenticated: true });
    configureMapillaryToken('', { allowUnauthenticated: true });
    setDimensionMode(false, { silent: true, allowUnauthenticated: true });
    renderGisTree();
    updateActiveTracksHeader();
    updateMapData(true);
}

window.onload = function() {
    updateViewportMetrics();
    window.addEventListener('resize', updateViewportMetrics);
    window.addEventListener('orientationchange', updateViewportMetrics);
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', updateViewportMetrics);
        window.visualViewport.addEventListener('scroll', updateViewportMetrics);
    }
    window.addEventListener('pagehide', () => { flushPersistedStateNow().catch(err => console.error(err)); });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            flushPersistedStateNow().catch(err => console.error(err));
        }
    });

    lucide.createIcons();

    const mapInstance = new maplibregl.Map({
        container: 'map',
        style: {
            version: 8,
            glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
            sources: {
                'osm-raster': {
                    type: 'raster',
                    tiles: ['https://a.tile.openstreetmap.org/{z}/{x}/{y}.png'],
                    tileSize: 256,
                    attribution: '&copy; OpenStreetMap contributors'
                }
            },
            layers: [{
                id: 'osm-layer',
                type: 'raster',
                source: 'osm-raster',
                minzoom: 0,
                maxzoom: 19
            }]
        },
        center: [12.5, 41.9],
        zoom: 6,
        pitch: 0,
        bearing: 0,
        preserveDrawingBuffer: true // Fondamentale per catturare lo screenshot reale della mappa!
    });

    setMap(mapInstance);
    configureMapInteractions(mapInstance);
    mapInstance.on('moveend', schedulePersistAppSession);
    setupPrintUiEvents();
    setupPrintDragEvents();

    const riallineaMappaAlViewport = () => {
        const aggiorna = () => {
            updateViewportMetrics();
            mapInstance.resize();
        };
        requestAnimationFrame(aggiorna);
        setTimeout(aggiorna, 120);
        setTimeout(aggiorna, 360);
    };
    window.addEventListener('gpxsuite:auth-modal-closed', riallineaMappaAlViewport);

    const resizeObserver = new ResizeObserver(() => {
        if (mapInstance) mapInstance.resize();
    });
    resizeObserver.observe(document.getElementById('map'));

    mapInstance.on('load', async() => {
        setMapLoaded(true);

        mapInstance.addSource('terrain-nextzen', {
            type: 'raster-dem',
            tiles: [NEXTZEN_TERRAIN_SOURCE],
            tileSize: 512,
            maxzoom: 14,
            encoding: 'terrarium'
        });

        mapInstance.addSource('waymarked-hiking', {
            type: 'raster',
            tiles: ['https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '&copy; Waymarked Trails'
        });
        mapInstance.addLayer({
            id: 'hiking-trails-layer',
            type: 'raster',
            source: 'waymarked-hiking',
            paint: {
                'raster-opacity': 0.8
            },
            layout: {
                visibility: 'none'
            }
        });

        setupLayers();
        initAuth({ forceModal: false });
        onAuthChange(user => {
            riallineaMappaAlViewport();
            if (user) {
                restoreWorkspaceForAuthenticatedUser();
            } else {
                clearWorkspaceAfterLogout();
            }
        });
        setupEvents();
        initChart();
        renderGisTree();
        updateActiveTracksHeader();
        await restoreWorkspaceForAuthenticatedUser();
    });
};
