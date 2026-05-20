// ui.js — renderGisTree, modal management, toolbar handlers, createNewTrack,
//          updateActiveTracksHeader, searchNominatim, showToast, GIS tree operations

import {
    tracks, setTracks,
    activeTrackId, setActiveTrackId,
    activeSegmentId, setActiveSegmentId,
    undoStack,
    isDrawing, setIsDrawing,
    isCutting, setIsCutting,
    isBoxDeleting, setIsBoxDeleting,
    boxDeleteCoords, setBoxDeleteCoords,
    boxDeleteMarker, setBoxDeleteMarker,
    isAddingWaypoint, setIsAddingWaypoint,
    currentSnapProfile,
    currentStyle,
    map, mapLoaded, is3D,
    activeWpForEdit, setActiveWpForEdit
} from './state.js';

import { escapeXml, generateDistinctTrackColor } from './utils.js';
import { forceUpdateStats } from './stats.js';
import {
    listStoredTracks,
    loadStoredTrack,
    deleteStoredTrack,
    ensureTrackStorageMeta,
    onLibraryChanged,
    loadPersistedAppSession,
    schedulePersistAppSession
} from './storage.js';

// Riferimenti a funzioni degli altri moduli — iniettati da main.js per evitare
// dipendenze circolari tra ui.js e gli altri moduli
let _updateMapData = null;
let _saveHistoryState = null;
let _setBaseMap = null;
let _setDimensionMode = null;
let _flyToPOI = null;
let _triggerUndo = null;
let _importGPX = null;
let _exportGPX = null;
let _addPointToActiveSegment = null;
let _cutTrackAtPoint = null;
let _handleBoxDeleteClick = null;
let _addWaypointAtCoords = null;
let _saveWaypointModifications = null;
let _setSnapProfile = null;
let _togglePrintPlanning = null;
let _disablePrintPlanning = null;
let _updatePrintGridLayout = null;
let _updatePrintGridScale = null;
let _setPrintPlanningOrientation = null;
let _generateHighResPrintPreview = null;
let _localLibraryBound = false;
let _gisDragPayload = null;
const _compactLayoutMedia = window.matchMedia('(max-width: 767px)');

export function injectDeps(deps) {
    _updateMapData = deps.updateMapData;
    _saveHistoryState = deps.saveHistoryState;
    _setBaseMap = deps.setBaseMap;
    _setDimensionMode = deps.setDimensionMode;
    _flyToPOI = deps.flyToPOI;
    _triggerUndo = deps.triggerUndo;
    _importGPX = deps.importGPX;
    _exportGPX = deps.exportGPX;
    _addPointToActiveSegment = deps.addPointToActiveSegment;
    _cutTrackAtPoint = deps.cutTrackAtPoint;
    _handleBoxDeleteClick = deps.handleBoxDeleteClick;
    _addWaypointAtCoords = deps.addWaypointAtCoords;
    _saveWaypointModifications = deps.saveWaypointModifications;
    _setSnapProfile = deps.setSnapProfile;
    _togglePrintPlanning = deps.togglePrintPlanning;
    _disablePrintPlanning = deps.disablePrintPlanning;
    _updatePrintGridLayout = deps.updatePrintGridLayout;
    _updatePrintGridScale = deps.updatePrintGridScale;
    _setPrintPlanningOrientation = deps.setPrintPlanningOrientation;
    _generateHighResPrintPreview = deps.generateHighResPrintPreview;
}

export function createNewTrack(name) {
    const trackName = name || `Traccia ${tracks.length + 1}`;
    const color = generateDistinctTrackColor(tracks.map(track => track.color));
    const newTrack = {
        id: 'track_' + Date.now(),
        localFileId: 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        localCreatedAt: Date.now(),
        localUpdatedAt: Date.now(),
        localSource: 'created',
        name: trackName,
        desc: 'Nessuna descrizione',
        color,
        width: 3,
        visible: true,
        waypointsVisible: true,
        segments: [{
            id: 'seg_' + Date.now() + '_1',
            name: 'Tracciato 1',
            points: [],
            visible: true
        }],
        waypoints: []
    };
    tracks.push(newTrack);
    setActiveTrackId(newTrack.id);
    setActiveSegmentId(newTrack.segments[0].id);

    if (_saveHistoryState) _saveHistoryState();
    updateActiveTracksHeader();
    renderGisTree();
    showToast(`Creata: ${trackName}`, 'info');
    return newTrack;
}

function focusTrackOnMap(track) {
    if (!mapLoaded || !track) return;

    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    let pointsCount = 0;
    let firstPoint = null;

    for (let si = 0; si < track.segments.length; si++) {
        const seg = track.segments[si];
        for (let pi = 0; pi < seg.points.length; pi++) {
            const point = seg.points[pi];
            if (!firstPoint) firstPoint = point;
            if (point.lon < minLon) minLon = point.lon;
            if (point.lon > maxLon) maxLon = point.lon;
            if (point.lat < minLat) minLat = point.lat;
            if (point.lat > maxLat) maxLat = point.lat;
            pointsCount++;
        }
    }

    if (!firstPoint) return;

    if (pointsCount === 1 || (minLon === maxLon && minLat === maxLat)) {
        map.flyTo({ center: [firstPoint.lon, firstPoint.lat], zoom: 15, pitch: 45 });
        return;
    }

    map.fitBounds([[minLon, minLat], [maxLon, maxLat]], {
        padding: 60,
        duration: 900,
        pitch: is3D ? map.getPitch() : 0,
        bearing: is3D ? map.getBearing() : 0
    });
}

function formatLibraryDate(ts) {
    if (!ts) return 'Data sconosciuta';
    return new Date(ts).toLocaleString('it-IT', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

export async function renderLocalGpxLibrary() {
    const container = document.getElementById('local-gpx-library');
    if (!container) return;

    try {
        const files = await listStoredTracks();
        if (files.length === 0) {
            container.innerHTML = `
              <div class="text-center py-4 text-gray-500 text-[11px] italic">
                Nessun GPX salvato sul dispositivo.
              </div>`;
            return;
        }

        container.innerHTML = files.map(file => {
            const loadedTrack = tracks.find(track => track.localFileId === file.id);
            const stateLabel = loadedTrack
                ? (loadedTrack.visible === false ? 'Nascosta' : 'Visibile')
                : (file.visible === false ? 'Nascosta salvata' : 'Visibile salvata');
            return `
              <div class="bg-gray-900 border border-gray-800 rounded-xl p-2.5 space-y-2">
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0">
                    <div class="text-xs font-semibold text-white truncate">${escapeXml(file.name)}</div>
                    <div class="text-[10px] text-gray-500">
                      ${file.source === 'imported' ? 'Importato' : 'Creato in app'} · Agg. ${formatLibraryDate(file.updatedAt)}
                    </div>
                  </div>
                  <button onclick="deleteStoredTrackFromLibrary('${file.id}')" class="text-gray-500 hover:text-red-400 shrink-0" title="Elimina dal dispositivo">
                    <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                  </button>
                </div>
                <div class="flex items-center justify-between gap-2 text-[10px] text-gray-500">
                  <span>${file.pointsCount} pt · ${file.segmentsCount} seg · ${file.waypointCount} wp</span>
                  <span class="${loadedTrack && loadedTrack.visible !== false ? 'text-green-400' : 'text-gray-500'}">${stateLabel}</span>
                </div>
                <div class="flex gap-2">
                  <button onclick="openStoredTrackFromLibrary('${file.id}')" class="flex-1 bg-emerald-600/20 hover:bg-emerald-600/35 text-emerald-300 border border-emerald-900/80 rounded-lg py-1.5 text-[11px] font-semibold ${loadedTrack ? 'opacity-60 cursor-default' : ''}">
                    ${loadedTrack ? 'Gia caricato' : 'Carica'}
                  </button>
                </div>
              </div>
            `;
        }).join('');
        lucide.createIcons();
    } catch (err) {
        console.error(err);
        container.innerHTML = `
          <div class="text-center py-4 text-red-400 text-[11px] italic">
            Archivio locale non disponibile.
          </div>`;
    }
}

export async function openStoredTrackFromLibrary(fileId) {
    const existing = tracks.find(track => track.localFileId === fileId);
    if (existing) {
        setTrackActive(existing.id);
        showToast(`Già in memoria: ${existing.name}`, 'info');
        return;
    }

    const storedTrack = await loadStoredTrack(fileId);
    if (!storedTrack) {
        showToast("File locale non trovato", "error");
        renderLocalGpxLibrary();
        return;
    }

    ensureTrackStorageMeta(storedTrack, storedTrack.localSource || 'imported');
    tracks.push(storedTrack);
    setActiveTrackId(storedTrack.id);
    setActiveSegmentId(storedTrack.segments[0]?.id || null);
    if (_saveHistoryState) _saveHistoryState();
    if (_updateMapData) _updateMapData(true);
    updateActiveTracksHeader();
    renderGisTree();
    renderLocalGpxLibrary();
    schedulePersistAppSession();
    showToast(`Caricato da archivio: ${storedTrack.name}`, 'success');
}

export async function restoreStoredTracksOnStartup() {
    const session = loadPersistedAppSession();
    const files = await listStoredTracks();
    if (files.length === 0) return { restoredCount: 0, session };

    const restoredTracks = [];
    for (let i = 0; i < files.length; i++) {
        const storedTrack = await loadStoredTrack(files[i].id);
        if (!storedTrack) continue;
        ensureTrackStorageMeta(storedTrack, storedTrack.localSource || 'imported');
        if (!Array.isArray(storedTrack.segments) || storedTrack.segments.length === 0) {
            storedTrack.segments = [{
                id: 'seg_' + Date.now() + '_' + i,
                name: 'Tracciato 1',
                points: [],
                visible: true
            }];
        }
        restoredTracks.push(storedTrack);
    }

    if (restoredTracks.length === 0) return { restoredCount: 0, session };

    if (Array.isArray(session?.trackOrder) && session.trackOrder.length > 0) {
        const orderMap = new Map(session.trackOrder.map((id, index) => [id, index]));
        restoredTracks.sort((a, b) => {
            const aIndex = orderMap.has(a.localFileId) ? orderMap.get(a.localFileId) : Number.MAX_SAFE_INTEGER;
            const bIndex = orderMap.has(b.localFileId) ? orderMap.get(b.localFileId) : Number.MAX_SAFE_INTEGER;
            return aIndex - bIndex;
        });
    }

    setTracks(restoredTracks);
    const activeTrack = restoredTracks.find(track => track.id === session?.activeTrackId)
        || restoredTracks.find(track => track.visible !== false)
        || restoredTracks[0];
    setActiveTrackId(activeTrack?.id || null);

    const activeSegment = activeTrack?.segments.find(segment => segment.id === session?.activeSegmentId)
        || activeTrack?.segments[0]
        || null;
    setActiveSegmentId(activeSegment?.id || null);

    if (typeof session?.hikingTrailsVisible === 'boolean') {
        const hikingToggle = document.getElementById('toggle-hiking-trails');
        if (hikingToggle) hikingToggle.checked = session.hikingTrailsVisible;
        if (mapLoaded && map.getLayer('hiking-trails-layer')) {
            map.setLayoutProperty('hiking-trails-layer', 'visibility', session.hikingTrailsVisible ? 'visible' : 'none');
        }
    }

    if (_setSnapProfile) {
        _setSnapProfile(session?.currentSnapProfile || 'off', { silent: true });
    }

    if (_updateMapData) _updateMapData(true);
    updateActiveTracksHeader();
    renderGisTree();
    renderLocalGpxLibrary();

    const applyMapSession = () => {
        if (session?.mapView && mapLoaded && map) {
            map.jumpTo({
                center: session.mapView.center,
                zoom: session.mapView.zoom,
                pitch: session.mapView.pitch,
                bearing: session.mapView.bearing
            });
        }
        if (_setDimensionMode) {
            _setDimensionMode(!!session?.is3D, { silent: true });
        }
    };

    if (session?.currentStyle && session.currentStyle !== currentStyle && _setBaseMap) {
        map.once('idle', applyMapSession);
        _setBaseMap(session.currentStyle);
    } else {
        applyMapSession();
    }

    schedulePersistAppSession();
    return { restoredCount: restoredTracks.length, session };
}

export async function deleteStoredTrackFromLibrary(fileId) {
    const track = tracks.find(item => item.localFileId === fileId);
    if (track) {
        deleteTrack(track.id);
        return;
    }

    await deleteStoredTrack(fileId);
    renderLocalGpxLibrary();
    showToast("GPX eliminato dal dispositivo", "info");
}

export function initLocalLibrary() {
    renderLocalGpxLibrary();
    if (_localLibraryBound) return;
    onLibraryChanged(() => {
        renderLocalGpxLibrary();
    });
    _localLibraryBound = true;
}

// Verifica se l'albero GIS è visibile sullo schermo. Quando il pannello è chiuso
// non ricostruiamo il DOM (risparmio enorme su tracce enormi con tanti segmenti).
export function isGisTreeVisible() {
    const el = document.getElementById('sidebar-tracks-right');
    if (!el) return false;
    return !el.classList.contains('translate-x-96');
}

function isCompactLayout() {
    return _compactLayoutMedia.matches;
}

function isMainMenuOpen() {
    const el = document.getElementById('panel-main-menu');
    return !!el && !el.classList.contains('-translate-x-80');
}

function isSidebarOpen() {
    const el = document.getElementById('sidebar-tracks-right');
    return !!el && !el.classList.contains('translate-x-96');
}

function isStatsPanelOpen() {
    const el = document.getElementById('panel-bottom-stats');
    return !!el && !el.classList.contains('translate-y-60');
}

function isPrintSetupOpen() {
    const el = document.getElementById('panel-print-setup');
    return !!el && !el.classList.contains('hidden');
}

function closeMainMenu() {
    document.getElementById('panel-main-menu').classList.add('-translate-x-80');
}

function closeSidebar() {
    document.getElementById('sidebar-tracks-right').classList.add('translate-x-96');
}

function closeStatsPanel() {
    document.getElementById('panel-bottom-stats').classList.add('translate-y-60');
    document.getElementById('btn-toggle-stats').classList.remove('bg-blue-600', 'text-white');
    document.getElementById('btn-toggle-stats').classList.add('text-gray-300');
}

function closeOtherPanels(except) {
    if (except !== 'main') closeMainMenu();
    if (except !== 'sidebar') closeSidebar();
    if (except !== 'stats') closeStatsPanel();
    if (except !== 'print' && _disablePrintPlanning) _disablePrintPlanning();
}

export function syncMobileBackdrop() {
    const backdrop = document.getElementById('mobile-panel-backdrop');
    if (!backdrop) return;

    if (!isCompactLayout()) {
        backdrop.classList.add('hidden');
        return;
    }

    const hasOpenPanel = isMainMenuOpen() || isSidebarOpen() || isStatsPanelOpen() || isPrintSetupOpen();
    backdrop.classList.toggle('hidden', !hasOpenPanel);
}

// Debounce interno: evita di ricostruire il tree DOM ad ogni singola modifica
let _gisTreeTimer = null;
let _gisTreeDirty = false;
export function renderGisTree() {
    // Marca sempre come dirty — verrà ridisegnato all'apertura del pannello
    _gisTreeDirty = true;
    if (!isGisTreeVisible()) return;
    clearTimeout(_gisTreeTimer);
    _gisTreeTimer = setTimeout(_doRenderGisTree, 100);
}

// Forza un rendering immediato (chiamato quando l'utente apre il pannello)
export function flushGisTreeIfDirty() {
    if (!_gisTreeDirty) return;
    clearTimeout(_gisTreeTimer);
    _doRenderGisTree();
}

function _doRenderGisTree() {
    _gisTreeDirty = false;
    const container = document.getElementById('gis-file-tree');
    if (tracks.length === 0) {
        container.innerHTML = `
          <div class="text-center py-6 text-gray-500 text-xs italic">
            Nessuna traccia o waypoint caricati in memoria.
          </div>`;
        return;
    }

    let html = '';

    if (tracks.length > 0) {
        html += `<div class="space-y-2">
          <span class="text-[10px] text-gray-400 font-bold uppercase tracking-wider flex items-center gap-1">
            <i data-lucide="folder-tree" class="w-3.5 h-3.5"></i> File GPX in mappa (${tracks.length})
          </span>`;

        tracks.forEach((track, trackIndex) => {
            const isActive = track.id === activeTrackId;
            const segmentCount = track.segments.length;
            const pointCount = track.segments.reduce((sum, seg) => sum + seg.points.length, 0);
            html += `
            <div class="group bg-gray-900/95 border ${isActive ? 'border-blue-500/60 shadow-blue-950/30' : 'border-gray-800'} rounded-xl overflow-hidden shadow-lg"
                 ondragover="handleGisDragOver(event)"
                 ondrop="handleGisDrop(event, 'track', '${track.id}')">
              <div class="flex items-stretch">
                <div class="w-1.5" style="background-color: ${track.color || '#3b82f6'}"></div>
                <div class="flex-1 min-w-0 p-2.5 space-y-2">
                  <div class="flex items-start justify-between gap-2">
                    <div class="flex items-start gap-2 min-w-0">
                      <button draggable="true"
                              ondragstart="handleGisDragStart(event, 'track', '${track.id}')"
                              ondragend="handleGisDragEnd(event)"
                              class="mt-0.5 text-gray-600 hover:text-gray-300 cursor-grab active:cursor-grabbing"
                              title="Trascina per riordinare questo file GPX">
                        <i data-lucide="grip-vertical" class="w-4 h-4"></i>
                      </button>
                      <div class="min-w-0 cursor-pointer" onclick="setTrackActive('${track.id}', true)">
                        <div class="flex items-center gap-1.5 min-w-0">
                          <i data-lucide="file-map" class="w-3.5 h-3.5 ${isActive ? 'text-blue-300' : 'text-gray-500'} shrink-0"></i>
                          <input type="text" value="${escapeXml(track.name)}" onchange="renameTrack('${track.id}', this.value)" class="bg-transparent text-xs font-bold ${track.visible === false ? 'text-gray-500 line-through' : 'text-white'} border-b border-transparent hover:border-gray-700 focus:border-blue-500 focus:outline-none min-w-0 w-36">
                        </div>
                        <div class="text-[10px] text-gray-500 mt-0.5 pl-5">
                          File ${trackIndex + 1} · ${segmentCount} segmenti · ${pointCount} pt · ${track.waypoints.length} wp
                        </div>
                      </div>
                    </div>
                    <div class="flex items-center gap-1.5 shrink-0">
                      <button onclick="toggleTrackVisibility('${track.id}')" class="text-gray-400 hover:text-white" title="Mostra/Nascondi File"><i data-lucide="${track.visible === false ? 'eye-off' : 'eye'}" class="w-3.5 h-3.5"></i></button>
                      <input type="color" value="${track.color}" onchange="changeTrackColor('${track.id}', this.value)" class="w-4 h-4 rounded border-0 bg-transparent cursor-pointer" title="Colore traccia">
                      <button onclick="deleteTrack('${track.id}')" class="text-gray-500 hover:text-red-400" title="Elimina file"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                    </div>
                  </div>

                  <div class="ml-5 pl-3 border-l border-gray-800/90 space-y-1"
                       ondragover="handleGisDragOver(event)"
                       ondrop="handleGisDrop(event, 'track-segments', '${track.id}')">
                    <div class="text-[9px] text-gray-600 font-bold uppercase tracking-wider flex items-center gap-1 pb-0.5">
                      <i data-lucide="git-branch" class="w-3 h-3"></i> Segmenti
                    </div>
                    ${track.segments.map((seg, segIndex) => {
                        const isSegActive = seg.id === activeSegmentId;
                        return `
                        <div class="flex items-center justify-between text-xs py-1.5 px-1.5 rounded border ${isSegActive ? 'bg-blue-950/40 text-blue-300 border-blue-900/60' : 'text-gray-400 border-transparent hover:bg-gray-800/45 hover:border-gray-800'} ${seg.visible === false ? 'opacity-55' : ''}"
                             ondragover="handleGisDragOver(event)"
                             ondrop="handleGisDrop(event, 'segment', '${track.id}', '${seg.id}')">
                          <div class="flex items-center gap-1.5 min-w-0">
                            <button draggable="true"
                                    ondragstart="handleGisDragStart(event, 'segment', '${track.id}', '${seg.id}')"
                                    ondragend="handleGisDragEnd(event)"
                                    class="text-gray-600 hover:text-gray-300 cursor-grab active:cursor-grabbing shrink-0"
                                    title="Trascina per riordinare o spostare questo segmento">
                              <i data-lucide="grip-vertical" class="w-3.5 h-3.5"></i>
                            </button>
                            <i data-lucide="milestone" class="w-3 h-3 text-gray-500 shrink-0"></i>
                            <input type="text" value="${escapeXml(seg.name)}" onchange="renameSegment('${track.id}', '${seg.id}', this.value)" class="bg-transparent text-[11px] border-b border-transparent hover:border-gray-700 focus:border-blue-500 focus:outline-none min-w-0 w-24 ${seg.visible === false ? 'line-through' : ''}">
                          </div>
                          <div class="flex items-center gap-1.5 shrink-0">
                            <span class="text-[10px] text-gray-500">${segIndex + 1}/${seg.points.length} pt</span>
                            <button onclick="toggleSegmentVisibility('${track.id}', '${seg.id}')" class="text-gray-500 hover:text-white" title="Mostra/Nascondi Segmento"><i data-lucide="${seg.visible === false ? 'eye-off' : 'eye'}" class="w-3 h-3"></i></button>
                            <button onclick="deleteSegment('${track.id}', '${seg.id}')" class="text-gray-600 hover:text-red-400" title="Elimina segmento"><i data-lucide="x" class="w-3 h-3"></i></button>
                          </div>
                        </div>
                      `;
                    }).join('')}
                    <button onclick="addNewSegmentToTrack('${track.id}')" class="text-[10px] text-blue-400 hover:text-blue-300 flex items-center gap-0.5 pt-1 pl-1">
                      <i data-lucide="plus" class="w-3 h-3"></i> Aggiungi Segmento
                    </button>
                  </div>` + (track.waypoints.length > 0 ? `
                  <div class="ml-5 pl-3 border-l border-gray-800/60 pt-1">
                    <div class="flex items-center justify-between mb-1">
                      <span class="text-[9px] text-gray-500 font-bold uppercase tracking-wider flex items-center gap-1">
                        <i data-lucide="map-pinned" class="w-3 h-3"></i> Waypoints (${track.waypoints.length})
                      </span>
                      <button onclick="toggleAllWaypointsVisibility('${track.id}')" class="text-gray-500 hover:text-white" title="Mostra/Nascondi Gruppo Waypoint"><i data-lucide="${track.waypointsVisible === false ? 'eye-off' : 'eye'}" class="w-3.5 h-3.5"></i></button>
                    </div>
                    <div class="${track.waypointsVisible === false ? 'hidden' : 'space-y-1'}">
                      ${track.waypoints.map(wp => `
                          <div class="flex items-center justify-between gap-1 text-xs hover:bg-gray-800/40 p-1 rounded transition-all ${wp.visible === false ? 'opacity-50' : ''}">
                            <div class="flex items-center gap-1.5 min-w-0">
                              <span class="text-sm">${wp.symbol}</span>
                              <span class="font-medium text-gray-200 truncate cursor-pointer" onclick="zoomToWaypoint(${wp.lon}, ${wp.lat})">${escapeXml(wp.name)}</span>
                              <span class="text-[9px] text-gray-500">${wp.ele}m</span>
                            </div>
                            <div class="flex items-center gap-1">
                              <button onclick="toggleWaypointVisibility('${track.id}', '${wp.id}')" class="text-gray-500 hover:text-white" title="Mostra/Nascondi"><i data-lucide="${wp.visible === false ? 'eye-off' : 'eye'}" class="w-3 h-3"></i></button>
                              <button onclick="openWaypointEditor('${track.id}', '${wp.id}')" class="text-gray-500 hover:text-white"><i data-lucide="edit-3" class="w-3 h-3"></i></button>
                              <button onclick="deleteWaypoint('${track.id}', '${wp.id}')" class="text-gray-500 hover:text-red-400"><i data-lucide="trash" class="w-3 h-3"></i></button>
                            </div>
                          </div>
                      `).join('')}
                    </div>
                  </div>
                ` : '') + `
                </div>
              </div>
            </div>`;
        });
        html += `</div>`;
    }
    container.innerHTML = html;
    lucide.createIcons();
}

function getDropPosition(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

function finishGisTreeMove(message) {
    if (_saveHistoryState) _saveHistoryState();
    if (_updateMapData) _updateMapData(true);
    updateActiveTracksHeader();
    renderGisTree();
    renderLocalGpxLibrary();
    showToast(message, 'success');
}

export function handleGisDragStart(event, type, trackId, segId = null) {
    _gisDragPayload = { type, trackId, segId };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', JSON.stringify(_gisDragPayload));
}

export function handleGisDragOver(event) {
    if (!_gisDragPayload) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
}

export function handleGisDragEnd() {
    _gisDragPayload = null;
}

export function handleGisDrop(event, targetType, targetTrackId, targetSegId = null) {
    if (!_gisDragPayload) return;

    if (_gisDragPayload.type === 'track' && targetType !== 'track') return;

    event.preventDefault();
    event.stopPropagation();

    if (_gisDragPayload.type === 'track' && targetType === 'track') {
        const fromIndex = tracks.findIndex(track => track.id === _gisDragPayload.trackId);
        const targetIndex = tracks.findIndex(track => track.id === targetTrackId);
        if (fromIndex === -1 || targetIndex === -1 || fromIndex === targetIndex) return;

        let toIndex = targetIndex + (getDropPosition(event) === 'after' ? 1 : 0);
        if (fromIndex < toIndex) toIndex--;
        tracks.splice(toIndex, 0, tracks.splice(fromIndex, 1)[0]);
        setActiveTrackId(_gisDragPayload.trackId);
        const activeTrack = tracks.find(track => track.id === _gisDragPayload.trackId);
        setActiveSegmentId(activeTrack?.segments[0]?.id || null);
        _gisDragPayload = null;
        finishGisTreeMove("Ordine dei file aggiornato");
        return;
    }

    if (_gisDragPayload.type !== 'segment') return;

    const sourceTrack = tracks.find(track => track.id === _gisDragPayload.trackId);
    const targetTrack = tracks.find(track => track.id === targetTrackId);
    if (!sourceTrack || !targetTrack) return;

    if (
        targetType === 'segment' &&
        sourceTrack.id === targetTrack.id &&
        _gisDragPayload.segId === targetSegId
    ) {
        _gisDragPayload = null;
        return;
    }

    const sourceIndex = sourceTrack.segments.findIndex(seg => seg.id === _gisDragPayload.segId);
    if (sourceIndex === -1) return;

    const [segment] = sourceTrack.segments.splice(sourceIndex, 1);
    let targetIndex = targetTrack.segments.length;

    if (targetType === 'segment' && targetSegId) {
        targetIndex = targetTrack.segments.findIndex(seg => seg.id === targetSegId);
        if (targetIndex === -1) targetIndex = targetTrack.segments.length;
        else if (getDropPosition(event) === 'after') targetIndex++;
    }

    if (sourceTrack.id === targetTrack.id && sourceIndex < targetIndex) targetIndex--;
    targetTrack.segments.splice(Math.max(0, targetIndex), 0, segment);
    setActiveTrackId(targetTrack.id);
    setActiveSegmentId(segment.id);
    _gisDragPayload = null;
    finishGisTreeMove(sourceTrack.id === targetTrack.id ? "Segmento riordinato" : "Segmento spostato in un altro file");
}

export function setTrackActive(trackId, shouldFocus = false) {
    const track = tracks.find(tr => tr.id === trackId);
    if (!track) return;

    setActiveTrackId(trackId);
    if (track.segments.length > 0) {
        setActiveSegmentId(track.segments[track.segments.length - 1].id);
    }
    if (shouldFocus) focusTrackOnMap(track);
    if (_updateMapData) _updateMapData();
    updateActiveTracksHeader();
    schedulePersistAppSession();
}

export function renameTrack(trackId, newName) {
    const t = tracks.find(tr => tr.id === trackId);
    if (t) {
        t.name = newName;
        if (_saveHistoryState) _saveHistoryState();
        updateActiveTracksHeader();
        renderGisTree();
    }
}

export function changeTrackColor(trackId, newColor) {
    const t = tracks.find(tr => tr.id === trackId);
    if (t) {
        t.color = newColor;
        if (_saveHistoryState) _saveHistoryState();
        if (_updateMapData) _updateMapData();
    }
}

export function toggleTrackVisibility(trackId) {
    const t = tracks.find(tr => tr.id === trackId);
    if (t) {
        t.visible = t.visible === false ? true : false;
        if (_saveHistoryState) _saveHistoryState();
        if (_updateMapData) _updateMapData();
    }
}

export function toggleAllWaypointsVisibility(trackId) {
    const track = tracks.find(t => t.id === trackId);
    if (track) {
        track.waypointsVisible = track.waypointsVisible === false ? true : false;
        if (_saveHistoryState) _saveHistoryState();
        if (_updateMapData) _updateMapData();
    }
}

export function toggleWaypointVisibility(trackId, wpId) {
    const track = tracks.find(t => t.id === trackId);
    if (track) {
        const wp = track.waypoints.find(w => w.id === wpId);
        if (wp) {
            wp.visible = wp.visible === false ? true : false;
            if (_saveHistoryState) _saveHistoryState();
            if (_updateMapData) _updateMapData();
        }
    }
}

export function toggleSegmentVisibility(trackId, segId) {
    const t = tracks.find(tr => tr.id === trackId);
    if (t) {
        const s = t.segments.find(sg => sg.id === segId);
        if (s) {
            s.visible = s.visible === false ? true : false;
            if (_saveHistoryState) _saveHistoryState();
            if (_updateMapData) _updateMapData();
        }
    }
}

export function deleteTrack(trackId) {
    const trackToDelete = tracks.find(t => t.id === trackId);
    const remainingTracks = tracks.filter(t => t.id !== trackId);
    setTracks(remainingTracks);
    if (activeTrackId === trackId) {
        const nextTrack = remainingTracks.length > 0 ? remainingTracks[0] : null;
        setActiveTrackId(nextTrack ? nextTrack.id : null);
        setActiveSegmentId(nextTrack && nextTrack.segments.length > 0 ? nextTrack.segments[0].id : null);
    }
    if (trackToDelete?.localFileId) {
        deleteStoredTrack(trackToDelete.localFileId).catch(err => console.error(err));
    }
    if (_saveHistoryState) _saveHistoryState();
    if (_updateMapData) _updateMapData();
    updateActiveTracksHeader();
    renderLocalGpxLibrary();
}

export function addNewSegmentToTrack(trackId) {
    const t = tracks.find(tr => tr.id === trackId);
    if (t) {
        const newSegId = 'seg_' + Date.now();
        t.segments.push({
            id: newSegId,
            name: `Tracciato ${t.segments.length + 1}`,
            points: [],
            visible: true
        });
        setActiveSegmentId(newSegId);
        setActiveTrackId(trackId);

        if (_saveHistoryState) _saveHistoryState();
        if (_updateMapData) _updateMapData();
        showToast("Nuovo sotto-tracciato creato!", "success");
    }
}

export function renameSegment(trackId, segId, newName) {
    const t = tracks.find(tr => tr.id === trackId);
    if (t) {
        const s = t.segments.find(sg => sg.id === segId);
        if (s) {
            s.name = newName;
            if (_saveHistoryState) _saveHistoryState();
            renderGisTree();
        }
    }
}

export function setSegmentActive(trackId, segId) {
    setActiveTrackId(trackId);
    setActiveSegmentId(segId);
    if (_updateMapData) _updateMapData();
    updateActiveTracksHeader();
    schedulePersistAppSession();
}

export function deleteSegment(trackId, segId) {
    const t = tracks.find(tr => tr.id === trackId);
    if (t) {
        t.segments = t.segments.filter(sg => sg.id !== segId);
        if (activeSegmentId === segId) {
            setActiveSegmentId(t.segments.length > 0 ? t.segments[0].id : null);
        }
    }
    if (_saveHistoryState) _saveHistoryState();
    if (_updateMapData) _updateMapData();
}

export function zoomToWaypoint(lon, lat) {
    if (!mapLoaded) return;
    map.flyTo({ center: [lon, lat], zoom: 15, pitch: 45 });
}

export function deleteWaypoint(trackId, wpId) {
    const track = tracks.find(t => t.id === trackId);
    if (track) {
        track.waypoints = track.waypoints.filter(w => w.id !== wpId);
        if (_saveHistoryState) _saveHistoryState();
        if (_updateMapData) _updateMapData();
        showToast("Waypoint rimosso", "info");
    }
}

export function updateActiveTracksHeader() {
    const list = document.getElementById('active-tracks-list');
    if (tracks.length === 0) {
        list.innerHTML = `<span class="text-gray-500 italic whitespace-nowrap">Nessuna traccia creata</span>`;
        return;
    }

    list.innerHTML = tracks.map(t => {
        const isActive = t.id === activeTrackId;
        return `
          <div onclick="setTrackActive('${t.id}')" class="cursor-pointer flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold whitespace-nowrap transition-all ${isActive ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-400 hover:text-white'} ${t.visible === false ? 'opacity-50' : ''}">
            <span class="w-2 h-2 rounded-full" style="background-color: ${t.color}"></span>
            <span class="${t.visible === false ? 'line-through' : ''}">${t.name}</span>
          </div>
        `;
    }).join('');
}

export async function searchNominatim() {
    const q = document.getElementById('input-search').value;
    if (!q) return;

    showToast("Ricerca in corso...", "info");
    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`);
        const data = await res.json();
        if (data && data.length > 0) {
            const loc = data[0];
            map.flyTo({
                center: [parseFloat(loc.lon), parseFloat(loc.lat)],
                zoom: 12,
                pitch: 0
            });
            showToast(`Trovato: ${loc.display_name}`, "success");
        } else {
            showToast("Località non trovata", "error");
        }
    } catch {
        showToast("Errore di connessione al servizio di ricerca", "error");
    }
}

function updateCursorCoordinates(lngLat) {
    const el = document.getElementById('cursor-coordinates');
    if (!el || !lngLat) return;
    el.textContent = `${lngLat.lat.toFixed(6)}, ${lngLat.lng.toFixed(6)}`;
}

export function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');

    let accent = 'bg-gray-500';
    if (type === 'success') accent = 'bg-emerald-400';
    if (type === 'error') accent = 'bg-red-400';
    if (type === 'info') accent = 'bg-sky-400';

    toast.className = `bg-gray-950/88 border border-gray-800 text-gray-300 px-2.5 py-1.5 rounded-md shadow-lg text-[11px] font-medium flex items-center gap-2 transform -translate-x-2 opacity-0 transition-all duration-200`;
    toast.innerHTML = `
        <div class="w-1 h-1 rounded-full ${accent} shrink-0"></div>
        <span class="leading-snug">${message}</span>
      `;

    container.appendChild(toast);

    setTimeout(() => {
        toast.className = toast.className.replace('-translate-x-2 opacity-0', 'translate-x-0 opacity-100');
    }, 50);

    setTimeout(() => {
        toast.className = toast.className.replace('translate-x-0 opacity-100', '-translate-x-2 opacity-0');
        setTimeout(() => {
            toast.remove();
        }, 220);
    }, 2800);
}

export function setupEvents() {
    document.getElementById('mobile-panel-backdrop').onclick = () => {
        closeOtherPanels(null);
        syncMobileBackdrop();
    };

    document.getElementById('btn-main-menu').onclick = () => {
        const p = document.getElementById('panel-main-menu');
        const willOpen = p.classList.contains('-translate-x-80');
        if (willOpen && isCompactLayout()) closeOtherPanels('main');
        p.classList.toggle('-translate-x-80');
        syncMobileBackdrop();
    };
    document.getElementById('btn-close-main-menu').onclick = () => {
        closeMainMenu();
        syncMobileBackdrop();
    };

    document.getElementById('btn-open-sidebar-right').onclick = () => {
        const sb = document.getElementById('sidebar-tracks-right');
        const willOpen = sb.classList.contains('translate-x-96');
        if (willOpen && isCompactLayout()) closeOtherPanels('sidebar');
        sb.classList.toggle('translate-x-96');
        // Se l'abbiamo appena aperto e ci sono modifiche pendenti, rendi ora
        if (!sb.classList.contains('translate-x-96')) {
            flushGisTreeIfDirty();
        }
        syncMobileBackdrop();
    };
    document.getElementById('btn-close-sidebar-right').onclick = () => {
        closeSidebar();
        syncMobileBackdrop();
    };

    document.getElementById('btn-close-bottom').onclick = () => {
        closeStatsPanel();
        syncMobileBackdrop();
    };

    document.getElementById('btn-toggle-stats').onclick = () => {
        const panel = document.getElementById('panel-bottom-stats');
        const btn = document.getElementById('btn-toggle-stats');
        const isOpen = !panel.classList.contains('translate-y-60');
        if (isOpen) {
            closeStatsPanel();
        } else {
            if (isCompactLayout()) closeOtherPanels('stats');
            panel.classList.remove('translate-y-60');
            btn.classList.add('bg-blue-600', 'text-white');
            btn.classList.remove('text-gray-300');
            // Forza un ricalcolo: il pannello era chiuso e abbiamo saltato i refresh
            forceUpdateStats();
        }
        syncMobileBackdrop();
    };

    document.getElementById('map-style-osm').onclick = () => _setBaseMap('osm');
    document.getElementById('map-style-sat').onclick = () => _setBaseMap('sat');
    document.getElementById('map-style-topo').onclick = () => _setBaseMap('topo');

    document.getElementById('toggle-hybrid').onchange = () => {
        if (currentStyle === 'sat') _setBaseMap('sat');
    };

    document.getElementById('toggle-hiking-trails').onchange = (e) => {
        if (!mapLoaded) return;
        const visible = e.target.checked ? 'visible' : 'none';
        map.setLayoutProperty('hiking-trails-layer', 'visibility', visible);
        schedulePersistAppSession();
        showToast(e.target.checked ? "Sentieri OSM Visibili" : "Sentieri OSM Nascosti", "success");
    };

    document.getElementById('view-mode-2d').onclick = () => _setDimensionMode(false);
    document.getElementById('view-mode-3d').onclick = () => _setDimensionMode(true);

    document.getElementById('btn-draw-track').onclick = () => {
        setIsDrawing(!isDrawing);
        setIsCutting(false);
        setIsBoxDeleting(false);
        setIsAddingWaypoint(false);
        _disablePrintPlanning();

        const btn = document.getElementById('btn-draw-track');
        if (isDrawing) {
            btn.classList.add('bg-blue-600', 'text-white');
            showToast("Clicca sulla mappa per iniziare a tracciare", "info");
        } else {
            btn.classList.remove('bg-blue-600', 'text-white');
            if (_updateMapData) _updateMapData(true);
        }
    };

    const profiles = ['off', 'foot', 'bike', 'moto', 'car'];
    profiles.forEach(p => {
        document.getElementById(`snap-profile-${p}`).onclick = () => {
            _setSnapProfile(p);
        };
    });

    document.getElementById('btn-snap-toggle').onclick = () => {
        if (currentSnapProfile === 'off') {
            _setSnapProfile('foot');
        } else {
            _setSnapProfile('off');
        }
    };

    map.on('click', (e) => {
        const coords = e.lngLat;
        if (isDrawing) {
            _addPointToActiveSegment(coords.lng, coords.lat);
        } else if (isCutting) {
            _cutTrackAtPoint(coords);
        } else if (isBoxDeleting) {
            _handleBoxDeleteClick(coords);
        } else if (isAddingWaypoint) {
            _addWaypointAtCoords(coords.lng, coords.lat);
        }
    });

    map.on('mousemove', (e) => {
        updateCursorCoordinates(e.lngLat);
    });

    document.getElementById('btn-cut-track').onclick = () => {
        setIsCutting(!isCutting);
        setIsDrawing(false);
        setIsBoxDeleting(false);
        setIsAddingWaypoint(false);
        _disablePrintPlanning();
        document.getElementById('btn-draw-track').classList.remove('bg-blue-600', 'text-white');
        showToast(isCutting ? "Clicca su un punto della traccia per tagliarla in due segmenti" : "Taglio disattivato", "info");
    };

    document.getElementById('btn-box-delete').onclick = () => {
        setIsBoxDeleting(!isBoxDeleting);
        setIsDrawing(false);
        setIsCutting(false);
        setIsAddingWaypoint(false);
        _disablePrintPlanning();
        setBoxDeleteCoords(null);
        if (boxDeleteMarker) {
            boxDeleteMarker.remove();
            setBoxDeleteMarker(null);
        }
        document.getElementById('btn-draw-track').classList.remove('bg-blue-600', 'text-white');
        showToast(isBoxDeleting ? "Clicca due punti per definire il rettangolo d'eliminazione" : "Cancellazione box disattivata", "info");
    };

    document.getElementById('btn-add-waypoint').onclick = () => {
        setIsAddingWaypoint(!isAddingWaypoint);
        setIsDrawing(false);
        setIsCutting(false);
        setIsBoxDeleting(false);
        _disablePrintPlanning();
        document.getElementById('btn-draw-track').classList.remove('bg-blue-600', 'text-white');
        showToast(isAddingWaypoint ? "Clicca sulla mappa per inserire un Waypoint" : "Inserimento waypoint disattivato", "info");
    };

    document.getElementById('btn-undo').onclick = _triggerUndo;

    window.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
            e.preventDefault();
            _triggerUndo();
        }
    });

    document.getElementById('file-import-gpx').onchange = (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = function(evt) {
                _importGPX(evt.target.result, file.name);
            };
            reader.readAsText(file);
        }
    };

    document.getElementById('btn-export-gpx').onclick = () => {
        _exportGPX();
    };

    document.getElementById('btn-tree-new-track').onclick = () => {
        createNewTrack();
    };

    document.getElementById('btn-search').onclick = searchNominatim;
    document.getElementById('input-search').onkeydown = (e) => {
        if (e.key === 'Enter') searchNominatim();
    };

    document.getElementById('btn-wp-cancel').onclick = () => {
        document.getElementById('modal-waypoint').classList.add('hidden');
        setActiveWpForEdit({ trackId: null, wpId: null });
    };
    document.getElementById('btn-wp-save').onclick = _saveWaypointModifications;

    // Eventi di pianificazione stampa
    document.getElementById('btn-open-print').onclick = _togglePrintPlanning;
    document.getElementById('btn-close-print-setup').onclick = _disablePrintPlanning;
    document.getElementById('print-grid-select').onchange = _updatePrintGridLayout;
    document.getElementById('print-scale-slider').oninput = _updatePrintGridScale;
    document.getElementById('btn-print-port').onclick = () => _setPrintPlanningOrientation('portrait');
    document.getElementById('btn-print-land').onclick = () => _setPrintPlanningOrientation('landscape');

    document.getElementById('btn-generate-previews').onclick = _generateHighResPrintPreview;
    document.getElementById('btn-print-preview-cancel').onclick = () => {
        document.getElementById('print-preview-modal').classList.add('hidden');
    };
    document.getElementById('btn-print-preview-confirm').onclick = () => {
        window.print();
    };

    if (typeof _compactLayoutMedia.addEventListener === 'function') {
        _compactLayoutMedia.addEventListener('change', syncMobileBackdrop);
    } else if (typeof _compactLayoutMedia.addListener === 'function') {
        _compactLayoutMedia.addListener(syncMobileBackdrop);
    }

    window.addEventListener('resize', syncMobileBackdrop);
}
