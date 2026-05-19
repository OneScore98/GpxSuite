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
    map, mapLoaded,
    activeWpForEdit, setActiveWpForEdit
} from './state.js';

import { escapeXml } from './utils.js';
import { forceUpdateStats } from './stats.js';
import {
    listStoredTracks,
    loadStoredTrack,
    deleteStoredTrack,
    ensureTrackStorageMeta,
    onLibraryChanged
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
    const newTrack = {
        id: 'track_' + Date.now(),
        localFileId: 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        localCreatedAt: Date.now(),
        localUpdatedAt: Date.now(),
        localSource: 'created',
        name: trackName,
        desc: 'Nessuna descrizione',
        color: '#3b82f6',
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
                  <span class="${loadedTrack ? 'text-green-400' : 'text-gray-600'}">${loadedTrack ? 'In memoria' : 'Solo archivio'}</span>
                </div>
                <div class="flex gap-2">
                  <button onclick="openStoredTrackFromLibrary('${file.id}')" class="flex-1 bg-emerald-600/20 hover:bg-emerald-600/35 text-emerald-300 border border-emerald-900/80 rounded-lg py-1.5 text-[11px] font-semibold">
                    ${loadedTrack ? 'Apri/Focalizza' : 'Carica in memoria'}
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
    showToast(`Caricato da archivio: ${storedTrack.name}`, 'success');
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
            <i data-lucide="route" class="w-3.5 h-3.5"></i> Tracce GPX (${tracks.length})
          </span>`;

        tracks.forEach(track => {
            const isActive = track.id === activeTrackId;
            html += `
            <div class="bg-gray-900 border ${isActive ? 'border-blue-500/50' : 'border-gray-800'} rounded-xl p-2.5 space-y-2">
              <div class="flex items-center justify-between gap-1"><input type="text" value="${escapeXml(track.name)}" onchange="renameTrack('${track.id}', this.value)" class="bg-transparent text-xs font-bold text-white border-b border-transparent hover:border-gray-700 focus:border-blue-500 focus:outline-none w-32">
                <div class="flex items-center gap-1.5">
                  <button onclick="toggleTrackVisibility('${track.id}')" class="text-gray-400 hover:text-white" title="Mostra/Nascondi Livello"><i data-lucide="${track.visible === false ? 'eye-off' : 'eye'}" class="w-3.5 h-3.5"></i></button>
                  <input type="color" value="${track.color}" onchange="changeTrackColor('${track.id}', this.value)" class="w-4 h-4 rounded border-0 bg-transparent cursor-pointer">
                  <button onclick="setTrackActive('${track.id}')" class="text-[10px] px-1.5 py-0.5 rounded ${isActive ? 'bg-blue-600 text-white font-bold' : 'bg-gray-800 text-gray-400'}" title="Rendi Attiva">Usa</button>
                  <button onclick="deleteTrack('${track.id}')" class="text-gray-500 hover:text-red-400"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                </div>
              </div>

              <div class="pl-2 border-l border-gray-800 space-y-1">
                ${track.segments.map(seg => {
                    const isSegActive = seg.id === activeSegmentId;
                    return `
                    <div class="flex items-center justify-between text-xs py-1 px-1.5 rounded ${isSegActive ? 'bg-blue-950/40 text-blue-300' : 'text-gray-400'}">
                      <div class="flex items-center gap-1">
                        <i data-lucide="milestone" class="w-3 h-3 text-gray-500"></i><input type="text" value="${escapeXml(seg.name)}" onchange="renameSegment('${track.id}', '${seg.id}', this.value)" class="bg-transparent text-[11px] border-b border-transparent hover:border-gray-700 focus:border-blue-500 focus:outline-none w-28">
                      </div>
                      <div class="flex items-center gap-1.5">
                        <span class="text-[10px] text-gray-500">${seg.points.length} pt</span>
                        <button onclick="toggleSegmentVisibility('${track.id}', '${seg.id}')" class="text-gray-500 hover:text-white" title="Mostra/Nascondi"><i data-lucide="${seg.visible === false ? 'eye-off' : 'eye'}" class="w-3 h-3"></i></button>
                        <button onclick="setSegmentActive('${track.id}', '${seg.id}')" class="text-[9px] hover:underline">${isSegActive ? '⚡' : 'Usa'}</button>
                        <button onclick="deleteSegment('${track.id}', '${seg.id}')" class="text-gray-600 hover:text-red-400"><i data-lucide="x" class="w-3 h-3"></i></button>
                      </div>
                    </div>
                  `;
                }).join('')}
                <button onclick="addNewSegmentToTrack('${track.id}')" class="text-[10px] text-blue-400 hover:underline flex items-center gap-0.5 pt-1 pl-1">
                  <i data-lucide="plus" class="w-3 h-3"></i> Aggiungi Tracciato/Segmento
                </button>
              </div>` + (track.waypoints.length > 0 ? `
      <div class="flex items-center justify-between ml-1 mb-1">
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
      ` : '') + `</div>`;
        });
        html += `</div>`;
    }
    container.innerHTML = html;
    lucide.createIcons();
}

export function setTrackActive(trackId) {
    setActiveTrackId(trackId);
    const t = tracks.find(tr => tr.id === trackId);
    if (t && t.segments.length > 0) {
        setActiveSegmentId(t.segments[t.segments.length - 1].id);
    }
    if (_updateMapData) _updateMapData();
    updateActiveTracksHeader();
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

export function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');

    let colors = 'bg-gray-950/95 border-gray-800 text-gray-200';
    if (type === 'success') colors = 'bg-green-950/95 border-green-800 text-green-300';
    if (type === 'error') colors = 'bg-red-950/95 border-red-800 text-red-300';
    if (type === 'info') colors = 'bg-blue-950/95 border-blue-800 text-blue-300';

    toast.className = `${colors} border px-4 py-2 rounded-xl shadow-2xl text-xs font-semibold tracking-wide flex items-center gap-2 transform translate-y-4 opacity-0 transition-all duration-300`;
    toast.innerHTML = `
        <div class="w-1.5 h-1.5 rounded-full ${type === 'success' ? 'bg-green-500' : type === 'error' ? 'bg-red-500' : 'bg-blue-500'}"></div>
        <span>${message}</span>
      `;

    container.appendChild(toast);

    setTimeout(() => {
        toast.className = toast.className.replace('translate-y-4 opacity-0', 'translate-y-0 opacity-100');
    }, 50);

    setTimeout(() => {
        toast.className = toast.className.replace('translate-y-0 opacity-100', 'translate-y-4 opacity-0');
        setTimeout(() => {
            toast.remove();
        }, 300);
    }, 3500);
}

export function setupEvents() {
    initLocalLibrary();

    document.getElementById('btn-main-menu').onclick = () => {
        const p = document.getElementById('panel-main-menu');
        p.classList.toggle('-translate-x-80');
    };
    document.getElementById('btn-close-main-menu').onclick = () => {
        document.getElementById('panel-main-menu').classList.add('-translate-x-80');
    };

    document.getElementById('btn-open-sidebar-right').onclick = () => {
        const sb = document.getElementById('sidebar-tracks-right');
        sb.classList.toggle('translate-x-96');
        // Se l'abbiamo appena aperto e ci sono modifiche pendenti, rendi ora
        if (!sb.classList.contains('translate-x-96')) {
            flushGisTreeIfDirty();
        }
    };
    document.getElementById('btn-close-sidebar-right').onclick = () => {
        document.getElementById('sidebar-tracks-right').classList.add('translate-x-96');
    };

    document.getElementById('btn-close-bottom').onclick = () => {
        document.getElementById('panel-bottom-stats').classList.add('translate-y-60');
        document.getElementById('btn-toggle-stats').classList.remove('bg-blue-600', 'text-white');
        document.getElementById('btn-toggle-stats').classList.add('text-gray-300');
    };

    document.getElementById('btn-toggle-stats').onclick = () => {
        const panel = document.getElementById('panel-bottom-stats');
        const btn = document.getElementById('btn-toggle-stats');
        const isOpen = !panel.classList.contains('translate-y-60');
        if (isOpen) {
            panel.classList.add('translate-y-60');
            btn.classList.remove('bg-blue-600', 'text-white');
            btn.classList.add('text-gray-300');
        } else {
            panel.classList.remove('translate-y-60');
            btn.classList.add('bg-blue-600', 'text-white');
            btn.classList.remove('text-gray-300');
            // Forza un ricalcolo: il pannello era chiuso e abbiamo saltato i refresh
            forceUpdateStats();
        }
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

    map.on('click', async(e) => {
        const coords = e.lngLat;
        if (isDrawing) {
            await _addPointToActiveSegment(coords.lng, coords.lat);
        } else if (isCutting) {
            _cutTrackAtPoint(coords);
        } else if (isBoxDeleting) {
            _handleBoxDeleteClick(coords);
        } else if (isAddingWaypoint) {
            _addWaypointAtCoords(coords.lng, coords.lat);
        }
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
}
