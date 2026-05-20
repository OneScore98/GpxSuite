// state.js — Variabili globali condivise (GIS Tree, editor, snapping, stampa)

export const NEXTZEN_TERRAIN_SOURCE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const OSRM_ENDPOINTS = {
    foot: 'https://routing.openstreetmap.de/routed-foot/route/v1/driving/',
    bike: 'https://routing.openstreetmap.de/routed-bicycle/route/v1/driving/',
    moto: 'https://routing.openstreetmap.de/routed-car/route/v1/driving/',
    car: 'https://routing.openstreetmap.de/routed-car/route/v1/driving/'
};
export const MAPILLARY_TILES_URL = 'https://tiles.mapillary.com/maps/vtp/mly1_public/2/{z}/{x}/{y}?access_token=';
export const MAPILLARY_GRAPH_URL = 'https://graph.mapillary.com/';
export const MAPILLARY_TOKEN_KEY = 'gpxsuite-mapillary-token-v1';

// Riferimenti agli oggetti principali
export let map = null;
export let chart = null;
export let mapLoaded = false;
export let is3D = false;
export let currentStyle = 'osm';
export let undoStack = [];
export let isMapillaryVisible = false;
export let mapillaryToken = '';

// Stato GPX / GIS
export let tracks = [];
export let activeTrackId = null;
export let activeSegmentId = null;

// Stato Editor
export let isDrawing = false;
export let drawingPoints = [];
export let isCutting = false;
export let isBoxDeleting = false;
export let boxDeleteCoords = null;
export let boxDeleteMarker = null;

// Stato Snapping
export let isSnapActive = false;
export let currentSnapProfile = 'off';

// Stato Waypoint
export let isAddingWaypoint = false;
export let activeWpForEdit = {
    trackId: null,
    wpId: null
};

// Stato Progettazione Stampa
export let printPlanningMode = false;
export let printGrid = {
    cols: 1,
    rows: 1,
    scale: 1.0,
    orientation: 'portrait',
    width: 150,
    height: 212,
    x: 350,
    y: 250,
    isDragging: false,
    dragOffsetX: 0,
    dragOffsetY: 0
};

// Setter per variabili primitive (necessari per la mutazione cross-modulo)
export function setMap(m) { map = m; }
export function setChart(c) { chart = c; }
export function setMapLoaded(v) { mapLoaded = v; }
export function setIs3D(v) { is3D = v; }
export function setCurrentStyle(v) { currentStyle = v; }
export function setUndoStack(v) { undoStack = v; }
export function setIsMapillaryVisible(v) { isMapillaryVisible = v; }
export function setMapillaryToken(v) { mapillaryToken = v; }
export function setTracks(v) { tracks = v; }
export function setActiveTrackId(v) { activeTrackId = v; }
export function setActiveSegmentId(v) { activeSegmentId = v; }
export function setIsDrawing(v) { isDrawing = v; }
export function setIsCutting(v) { isCutting = v; }
export function setIsBoxDeleting(v) { isBoxDeleting = v; }
export function setBoxDeleteCoords(v) { boxDeleteCoords = v; }
export function setBoxDeleteMarker(v) { boxDeleteMarker = v; }
export function setIsSnapActive(v) { isSnapActive = v; }
export function setCurrentSnapProfile(v) { currentSnapProfile = v; }
export function setIsAddingWaypoint(v) { isAddingWaypoint = v; }
export function setActiveWpForEdit(v) { activeWpForEdit = v; }
export function setPrintPlanningMode(v) { printPlanningMode = v; }
export function setPrintGrid(v) { printGrid = v; }
export function updatePrintGridProp(key, value) { printGrid[key] = value; }
