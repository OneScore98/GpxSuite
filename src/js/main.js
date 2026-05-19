// main.js — Entry point: importa tutto, chiama init al DOMContentLoaded

import { setMap, setMapLoaded, NEXTZEN_TERRAIN_SOURCE } from './state.js';

import { setupLayers, updateMapData, setBaseMap, setDimensionMode, flyToPOI } from './map.js';
import { initChart } from './stats.js';
import { importGPX, exportGPX } from './gpx.js';
import { addPointToActiveSegment, cutTrackAtPoint, handleBoxDeleteClick, saveHistoryState, triggerUndo, setSnapProfile } from './tracks.js';
import { addWaypointAtCoords, saveWaypointModifications, openWaypointEditor, updateWaypointsOnMap } from './waypoints.js';
import {
    togglePrintPlanning, disablePrintPlanning,
    setupPrintDragEvents, updatePrintGridLayout, updatePrintGridScale,
    setPrintPlanningOrientation, generateHighResPrintPreview
} from './print.js';
import {
    injectDeps, setupEvents, createNewTrack, renderGisTree,
    initLocalLibrary, renderLocalGpxLibrary, openStoredTrackFromLibrary, deleteStoredTrackFromLibrary,
    updateActiveTracksHeader, showToast,
    setTrackActive, renameTrack, changeTrackColor, toggleTrackVisibility,
    toggleAllWaypointsVisibility, toggleWaypointVisibility, toggleSegmentVisibility,
    deleteTrack, addNewSegmentToTrack, renameSegment, setSegmentActive, deleteSegment,
    zoomToWaypoint, deleteWaypoint, searchNominatim
} from './ui.js';
import { hasStoredTracks } from './storage.js';

// Inietta le dipendenze circolari in ui.js prima che venga usata
injectDeps({
    updateMapData,
    saveHistoryState,
    setBaseMap,
    setDimensionMode,
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
    generateHighResPrintPreview
});

// Esponi le funzioni richiamate dagli handler inline HTML (onclick="...")
window.flyToPOI = flyToPOI;
window.setTrackActive = setTrackActive;
window.renameTrack = renameTrack;
window.changeTrackColor = changeTrackColor;
window.toggleTrackVisibility = toggleTrackVisibility;
window.toggleAllWaypointsVisibility = toggleAllWaypointsVisibility;
window.toggleWaypointVisibility = toggleWaypointVisibility;
window.toggleSegmentVisibility = toggleSegmentVisibility;
window.deleteTrack = deleteTrack;
window.addNewSegmentToTrack = addNewSegmentToTrack;
window.renameSegment = renameSegment;
window.setSegmentActive = setSegmentActive;
window.deleteSegment = deleteSegment;
window.zoomToWaypoint = zoomToWaypoint;
window.deleteWaypoint = deleteWaypoint;
window.openWaypointEditor = openWaypointEditor;
window.openStoredTrackFromLibrary = openStoredTrackFromLibrary;
window.deleteStoredTrackFromLibrary = deleteStoredTrackFromLibrary;

window.onload = function() {
    lucide.createIcons();

    const mapInstance = new maplibregl.Map({
        container: 'map',
        style: {
            version: 8,
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
        setupEvents();
        initLocalLibrary();
        initChart();
        setupPrintDragEvents();
        renderGisTree();
        updateActiveTracksHeader();
        renderLocalGpxLibrary();

        try {
            if (!(await hasStoredTracks())) {
                createNewTrack("Traccia 1");
            } else {
                showToast("Archivio locale GPX pronto", "info");
            }
        } catch (err) {
            console.error(err);
            showToast("Archivio locale non disponibile in questo browser", "error");
            createNewTrack("Traccia 1");
        }
    });
};
