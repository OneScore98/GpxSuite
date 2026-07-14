// main.js — Entry point: importa tutto, chiama init al DOMContentLoaded

import { MAPILLARY_TOKEN_KEY, setMap, setMapLoaded, NEXTZEN_TERRAIN_SOURCE, is3D, tracks } from './state.js';
import { ensureLucideIcons } from './utils.js';

import {
    setupLayers,
    updateMapData,
    setBaseMap,
    setDimensionMode,
    flyToPOI,
    configureMapillaryToken,
    setMapillaryCoverageVisible,
    closeMapillaryViewer,
    createBaseMapStyle,
    setStyleRestoredHook
} from './map.js?v=logger-chart-focus-map-point-20260714';
import { importGPX, exportGPX } from './gpx.js?v=logger-auto-chart-20260713';
import { addPointToActiveSegment, cutTrackAtPoint, handleBoxDeleteClick, saveHistoryState, triggerUndo, setSnapProfile } from './tracks.js';
import { addWaypointAtCoords, saveWaypointModifications, openWaypointEditor, updateWaypointsOnMap } from './waypoints.js';
import { flushPersistedStateNow, schedulePersistAppSession, schedulePersistTracks } from './storage.js';
import {
    initDeviceLocation,
    setDeviceLocationStatusHandler,
    toggleDeviceLocation,
    orientMapToMovementHeading,
    stopDeviceLocation,
    requestDeviceLocationPermission,
    requestDeviceOrientationPermission,
    setDeviceOrientationEnabled,
    setDeviceRecordingStatusHandler,
    startDeviceRecording,
    pauseDeviceRecording,
    resumeDeviceRecording,
    finishDeviceRecording,
    getDeviceRecordingStatus,
    getRecordingSettings,
    updateRecordingSettings,
    getDefaultRecordingName,
    restoreDeviceOverlays,
    isDeviceLocationActive,
    setExternalFixProvider,
    feedExternalFix,
    startDeviceLocation
} from './location.js?v=device-logger-20260707';
import {
    initDeviceModule,
    toggleDeviceRecording,
    setDeviceRate,
    calibrateDeviceImu,
    saveGpsReceiverConfig,
    restartGpsReceiver,
    standbyGpsReceiver,
    loadDeviceSettings,
    saveDeviceSettings,
    loadDeviceSessions,
    importDeviceSession,
    deleteDeviceSession,
    isDeviceConnected,
    getDeviceSessionId,
    startLoggerRecording,
    pauseLoggerRecording,
    resumeLoggerRecording,
    stopLoggerRecording,
    openLoggerInterface
} from './device.js?v=logger-simple-xhr-20260713';
import {
    togglePrintPlanning,
    disablePrintPlanning,
    setupPrintDragEvents,
    updatePrintGridLayout,
    updatePrintGridScale,
    setPrintPlanningOrientation,
    generateHighResPrintPreview,
    syncPrintOutputFromPreview
} from './print.js';
import { initAuthGate, bindAuthUi, trackAnalyticsEvent } from './auth.js?v=logger-auth-bypass-20260713';
import {
    injectDeps,
    setupEvents,
    setupPrintUiEvents,
    createNewTrack,
    renderGisTree,
    restoreStoredTracksOnStartup,
    openStoredTrackFromLibrary,
    deleteStoredTrackFromLibrary,
    handleGisDragStart,
    handleGisDragOver,
    handleGisDrop,
    handleGisDragEnd,
    updateActiveTracksHeader,
    showToast,
    setTrackActive,
    renameTrack,
    changeTrackColor,
    changeTrackWidth,
    toggleTrackVisibility,
    handleTrackContextMenu,
    downloadTrackGPX,
    handleTrackPointerDown,
    clearTrackLongPress,
    handleTrackTreeClick,
    handleSegmentTreeClick,
    handleSegmentContextMenu,
    handleSegmentPointerDown,
    copyTreeSelection,
    cutTreeSelection,
    pasteTreeSelection,
    duplicateTreeSelection,
    deleteTreeSelection,
    handleTrackNamePointerDown,
    clearTrackNameLongPress,
    handleTrackNameClick,
    openTrackNameEditor,
    finishTrackNameEditor,
    handleTrackNameKeydown,
    toggleAllWaypointsVisibility,
    toggleWaypointVisibility,
    toggleSegmentVisibility,
    deleteTrack,
    addNewSegmentToTrack,
    renameSegment,
    renameSegmentFromMenu,
    fetchSurfaceDataForTrack,
    extractOffroadFromTrack,
    extractOffroadFromSegment,
    cancelOffroadAnalysis,
    setSegmentActive,
    deleteSegment,
    zoomToWaypoint,
    deleteWaypoint,
    searchNominatim,
    getCurrentRecordingSensorData,
    setExternalSensorFeed,
    feedExternalDashboardSensors,
    feedExternalDashboardMeta,
    setDeviceDashboardVisualSettings,
    showMoreGisSegments,
    showMoreGisWaypoints,
    moveTrackUp,
    moveTrackDown,
    openMergeTracksModal,
    mergeTwoTracks,
    mergeSelectedTracks,
    updateDeviceRecordingUi
    // NB: importare './ui.js' senza query string: gli altri moduli (map.js, tracks.js,
    // gpx.js, print.js, waypoints.js) lo importano senza versione e un URL diverso
    // creerebbe UNA SECONDA ISTANZA del modulo con stato interno duplicato
    // (selezione GIS tree, dipendenze iniettate, job offroad). Il cache-busting
    // avviene tramite la versione di main.js in index.html.
} from './ui.js';

initDeviceLocation({
    showToast,
    updateMapData,
    renderGisTree,
    updateActiveTracksHeader,
    schedulePersistTracks,
    saveHistoryState,
    getSensorData: getCurrentRecordingSensorData
});

// Ricrea overlay registrazione/localizzazione dopo ogni cambio basemap.
setStyleRestoredHook(restoreDeviceOverlays);

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
    syncPrintOutputFromPreview,
    toggleDeviceLocation,
    orientMapToMovementHeading,
    stopDeviceLocation,
    requestDeviceLocationPermission,
    requestDeviceOrientationPermission,
    setDeviceOrientationEnabled,
    setDeviceLocationStatusHandler,
    setDeviceRecordingStatusHandler,
    startDeviceRecording,
    pauseDeviceRecording,
    resumeDeviceRecording,
    finishDeviceRecording,
    getDeviceRecordingStatus,
    getRecordingSettings,
    updateRecordingSettings,
    getDefaultRecordingName
});

// Esponi le funzioni richiamate dagli handler inline HTML (onclick="...")
window.flyToPOI = flyToPOI;
window.setTrackActive = setTrackActive;
window.renameTrack = renameTrack;
window.changeTrackColor = changeTrackColor;
window.changeTrackWidth = changeTrackWidth;
window.toggleTrackVisibility = toggleTrackVisibility;
window.handleTrackContextMenu = handleTrackContextMenu;
window.downloadTrackGPX = downloadTrackGPX;
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
window.fetchSurfaceDataForTrack = fetchSurfaceDataForTrack;
window.extractOffroadFromTrack = extractOffroadFromTrack;
window.extractOffroadFromSegment = extractOffroadFromSegment;
window.cancelOffroadAnalysis = cancelOffroadAnalysis;
window.setSegmentActive = setSegmentActive;
window.deleteSegment = deleteSegment;
window.zoomToWaypoint = zoomToWaypoint;
window.deleteWaypoint = deleteWaypoint;
window.openWaypointEditor = openWaypointEditor;
window.openStoredTrackFromLibrary = openStoredTrackFromLibrary;
window.deleteStoredTrackFromLibrary = deleteStoredTrackFromLibrary;
window.showMoreGisSegments = showMoreGisSegments;
window.showMoreGisWaypoints = showMoreGisWaypoints;
window.handleGisDragStart = handleGisDragStart;
window.handleGisDragOver = handleGisDragOver;
window.handleGisDrop = handleGisDrop;
window.handleGisDragEnd = handleGisDragEnd;
window.moveTrackUp = moveTrackUp;
window.moveTrackDown = moveTrackDown;
window.openMergeTracksModal = openMergeTracksModal;
window.mergeTwoTracks = mergeTwoTracks;
window.mergeSelectedTracks = mergeSelectedTracks;
// Strumento esterno (GPXSuite Logger): handler usati dal pannello Dispositivo
window.toggleDeviceRecording = toggleDeviceRecording;
window.startLoggerRecording = startLoggerRecording;
window.pauseLoggerRecording = pauseLoggerRecording;
window.resumeLoggerRecording = resumeLoggerRecording;
window.stopLoggerRecording = stopLoggerRecording;
window.isDeviceConnected = isDeviceConnected;
window.setDeviceRate = setDeviceRate;
window.calibrateDeviceImu = calibrateDeviceImu;
window.saveGpsReceiverConfig = saveGpsReceiverConfig;
window.restartGpsReceiver = restartGpsReceiver;
window.standbyGpsReceiver = standbyGpsReceiver;
window.loadDeviceSettings = loadDeviceSettings;
window.saveDeviceSettings = saveDeviceSettings;
window.loadDeviceSessions = loadDeviceSessions;
window.importDeviceSession = importDeviceSession;
window.deleteDeviceSession = deleteDeviceSession;
window.getDeviceSessionId = getDeviceSessionId;
window.openLoggerInterface = openLoggerInterface;

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

function initApp() {
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

    ensureLucideIcons();
    initDeviceModule({
        showToast,
        updateMapData,
        renderGisTree,
        updateActiveTracksHeader,
        schedulePersistTracks,
        saveHistoryState,
        importGPX,
        setExternalFixProvider,
        feedExternalFix,
        startDeviceLocation,
        isDeviceLocationActive,
        setExternalSensorFeed,
        feedExternalDashboardSensors,
        feedExternalDashboardMeta,
        setDeviceDashboardVisualSettings,
        updateDeviceRecordingUi
    });

    const mapInstance = new maplibregl.Map({
        container: 'map',
        style: createBaseMapStyle('osm', false),
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

    const resizeObserver = new ResizeObserver(() => {
        if (mapInstance) mapInstance.resize();
    });
    resizeObserver.observe(document.getElementById('map'));

    mapInstance.on('load', async () => {
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
            paint: { 'raster-opacity': 0.8 },
            layout: { visibility: 'none' }
        });

        setupLayers();
        setupEvents();
        bindAuthUi();

        configureMapillaryToken(localStorage.getItem(MAPILLARY_TOKEN_KEY) || '');
        renderGisTree();
        updateActiveTracksHeader();

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

        // Strumento esterno (GPXSuite Logger): parte dopo il ripristino locale,
        // cosi' una sessione live gia' salvata riprende dall'ultimo seq noto.
        initDeviceModule({
            showToast,
            updateMapData,
            renderGisTree,
            updateActiveTracksHeader,
            schedulePersistTracks,
            saveHistoryState,
            importGPX,
            setExternalFixProvider,
            feedExternalFix,
            startDeviceLocation,
            isDeviceLocationActive,
            setExternalSensorFeed,
            feedExternalDashboardSensors,
            feedExternalDashboardMeta,
            setDeviceDashboardVisualSettings,
            updateDeviceRecordingUi
        });
        trackAnalyticsEvent('app_ready', { restoredTracks: tracks.length }).catch(err => console.warn(err));
    });
}

function bootstrapApp() {
    updateViewportMetrics();
    let stopAuthMapBackground = () => {};
    const host = window.location.hostname;
    const isLoggerHost = host === 'gpx.local' || host === 'gpx.local.' || host === '192.168.4.1';
    if (isLoggerHost) {
        document.getElementById('auth-gate')?.classList.add('hidden');
        document.body.classList.remove('auth-locked');
        initApp();
        return;
    }
    if (!isLoggerHost) {
        import('./auth-map-background.js').then(mod => {
            stopAuthMapBackground = mod.stopAuthMapBackground;
            mod.startAuthMapBackground();
        }).catch(err => console.warn('[auth-bg] non avviato:', err));
    }
    initAuthGate({
        onAuthorized: () => {
            stopAuthMapBackground(); // Free resources properly on successful login
            initApp();
        }
    }).catch(err => {
        console.error(err);
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrapApp, { once: true });
} else {
    bootstrapApp();
}
