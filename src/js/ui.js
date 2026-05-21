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
let _setMapillaryCoverageVisible = null;
let _configureMapillaryToken = null;
let _closeMapillaryViewer = null;
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
let _trackContextMenu = null;
let _trackLongPressTimer = null;
let _trackNameLongPressTimer = null;
let _lastTrackNamePointer = { trackId: null, time: 0 };
let _lastTrackNameClick = { trackId: null, time: 0 };
let _treeSelection = [];
let _treeLastSelected = null;
let _treeClipboard = null;
const _compactLayoutMedia = window.matchMedia('(max-width: 767px)');
const TOOL_CURSORS = {
    draw: createSvgCursor('<line x1="5" y1="19" x2="19" y2="5" stroke="#f8fafc" stroke-width="3" stroke-linecap="round"/><line x1="4" y1="20" x2="9" y2="19" stroke="#f59e0b" stroke-width="3" stroke-linecap="round"/><path d="M16 4l4 4" stroke="#f8fafc" stroke-width="2" stroke-linecap="round"/>', 4, 20),
    cut: createSvgCursor('<circle cx="7" cy="7" r="3" fill="none" stroke="#f8fafc" stroke-width="2"/><circle cx="7" cy="17" r="3" fill="none" stroke="#f8fafc" stroke-width="2"/><path d="M10 9l11 9M10 15L21 6" stroke="#f8fafc" stroke-width="2.4" stroke-linecap="round"/>', 12, 12),
    box: createSvgCursor('<rect x="4" y="5" width="16" height="14" rx="1.5" fill="rgba(239,68,68,.18)" stroke="#ef4444" stroke-width="2.4" stroke-dasharray="4 2"/><path d="M7 8l10 8M17 8L7 16" stroke="#f8fafc" stroke-width="1.8" stroke-linecap="round"/>', 12, 12),
    waypoint: createSvgCursor('<path d="M12 22s7-6.2 7-12a7 7 0 10-14 0c0 5.8 7 12 7 12z" fill="#2563eb" stroke="#f8fafc" stroke-width="2"/><circle cx="12" cy="10" r="2.5" fill="#f8fafc"/>', 12, 22)
};

function createSvgCursor(svgBody, hotX, hotY) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${svgBody}</svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotX} ${hotY}, crosshair`;
}

function updateMapToolCursor() {
    if (!map) return;
    const canvas = map.getCanvas();
    if (!canvas) return;
    if (isDrawing) canvas.style.cursor = TOOL_CURSORS.draw;
    else if (isCutting) canvas.style.cursor = TOOL_CURSORS.cut;
    else if (isBoxDeleting) canvas.style.cursor = TOOL_CURSORS.box;
    else if (isAddingWaypoint) canvas.style.cursor = TOOL_CURSORS.waypoint;
    else canvas.style.cursor = '';
}

function setToolButtonState(buttonId, active) {
    document.getElementById(buttonId)?.classList.toggle('bg-blue-600', active);
    document.getElementById(buttonId)?.classList.toggle('text-white', active);
}

function updateToolButtons() {
    setToolButtonState('btn-draw-track', isDrawing);
    setToolButtonState('btn-cut-track', isCutting);
    setToolButtonState('btn-box-delete', isBoxDeleting);
    setToolButtonState('btn-add-waypoint', isAddingWaypoint);
}

function updateBoxDeletePreview(endLngLat = null) {
    const src = mapLoaded && map ? map.getSource('box-delete-preview') : null;
    if (!src) return;
    if (!boxDeleteCoords || !endLngLat) {
        src.setData({ type: 'FeatureCollection', features: [] });
        return;
    }
    const minLng = Math.min(boxDeleteCoords.lng, endLngLat.lng);
    const maxLng = Math.max(boxDeleteCoords.lng, endLngLat.lng);
    const minLat = Math.min(boxDeleteCoords.lat, endLngLat.lat);
    const maxLat = Math.max(boxDeleteCoords.lat, endLngLat.lat);
    src.setData({
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'Polygon',
                coordinates: [[[minLng, minLat], [maxLng, minLat], [maxLng, maxLat], [minLng, maxLat], [minLng, minLat]]]
            }
        }]
    });
}

function updateMapillaryToolbarButton() {
    const btn = document.getElementById('btn-mapillary-layer');
    const toggle = document.getElementById('toggle-mapillary');
    if (!btn || !toggle) return;
    const active = toggle.checked;
    btn.classList.toggle('bg-emerald-700', active);
    btn.classList.toggle('text-white', active);
    btn.classList.toggle('text-gray-300', !active);
}

function clearBoxDeleteSelection() {
    setBoxDeleteCoords(null);
    updateBoxDeletePreview();
    if (boxDeleteMarker) {
        boxDeleteMarker.remove();
        setBoxDeleteMarker(null);
    }
}

export function injectDeps(deps) {
    _updateMapData = deps.updateMapData;
    _saveHistoryState = deps.saveHistoryState;
    _setBaseMap = deps.setBaseMap;
    _setDimensionMode = deps.setDimensionMode;
    _setMapillaryCoverageVisible = deps.setMapillaryCoverageVisible;
    _configureMapillaryToken = deps.configureMapillaryToken;
    _closeMapillaryViewer = deps.closeMapillaryViewer;
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

function focusPointsOnMap(points) {
    if (!mapLoaded || !points || points.length === 0) return;

    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    const firstPoint = points[0];

    for (let pi = 0; pi < points.length; pi++) {
        const point = points[pi];
        if (point.lon < minLon) minLon = point.lon;
        if (point.lon > maxLon) maxLon = point.lon;
        if (point.lat < minLat) minLat = point.lat;
        if (point.lat > maxLat) maxLat = point.lat;
    }

    if (points.length === 1 || (minLon === maxLon && minLat === maxLat)) {
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

function focusTrackOnMap(track) {
    if (!track) return;
    const allPoints = [];

    for (let si = 0; si < track.segments.length; si++) {
        const seg = track.segments[si];
        for (let pi = 0; pi < seg.points.length; pi++) {
            allPoints.push(seg.points[pi]);
        }
    }

    if (allPoints.length === 0) return;
    focusPointsOnMap(allPoints);
}

function focusSegmentOnMap(trackId, segId) {
    const track = tracks.find(tr => tr.id === trackId);
    const segment = track?.segments.find(seg => seg.id === segId);
    if (!segment || segment.points.length === 0) return;
    focusPointsOnMap(segment.points);
}

function makeTreeKey(type, trackId, segId = null) {
    return type === 'segment' ? `segment:${trackId}:${segId}` : `track:${trackId}`;
}

function parseTreeKey(key) {
    const parts = String(key || '').split(':');
    return {
        type: parts[0],
        trackId: parts[1] || null,
        segId: parts[2] || null
    };
}

function getTreeItemOrder() {
    const order = [];
    tracks.forEach(track => {
        order.push(makeTreeKey('track', track.id));
        track.segments.forEach(seg => order.push(makeTreeKey('segment', track.id, seg.id)));
    });
    return order;
}

function selectionHas(key) {
    return _treeSelection.includes(key);
}

function normalizeTreeSelection() {
    const valid = new Set(getTreeItemOrder());
    _treeSelection = _treeSelection.filter(key => valid.has(key));
    if (_treeLastSelected && !valid.has(_treeLastSelected)) _treeLastSelected = _treeSelection[_treeSelection.length - 1] || null;
}

function setTreeSelection(keys, lastKey = null) {
    const valid = new Set(getTreeItemOrder());
    _treeSelection = [...new Set(keys.filter(key => valid.has(key)))];
    _treeLastSelected = lastKey && valid.has(lastKey) ? lastKey : (_treeSelection[_treeSelection.length - 1] || null);
}

function selectTreeItem(type, trackId, segId, event = null) {
    const key = makeTreeKey(type, trackId, segId);
    const isRange = event && event.shiftKey && _treeLastSelected;
    const isToggle = event && (event.ctrlKey || event.metaKey);

    if (isRange) {
        const order = getTreeItemOrder();
        const start = order.indexOf(_treeLastSelected);
        const end = order.indexOf(key);
        if (start !== -1 && end !== -1) {
            const range = order.slice(Math.min(start, end), Math.max(start, end) + 1);
            setTreeSelection(isToggle ? [..._treeSelection, ...range] : range, key);
            return;
        }
    }

    if (isToggle) {
        const next = selectionHas(key)
            ? _treeSelection.filter(item => item !== key)
            : [..._treeSelection, key];
        setTreeSelection(next, key);
        return;
    }

    setTreeSelection([key], key);
}

function ensureTreeItemSelected(type, trackId, segId = null) {
    const key = makeTreeKey(type, trackId, segId);
    if (!selectionHas(key)) setTreeSelection([key], key);
}

function getSelectedItems() {
    normalizeTreeSelection();
    return _treeSelection.map(parseTreeKey);
}

function getSelectedTracks() {
    return getSelectedItems()
        .filter(item => item.type === 'track')
        .map(item => tracks.find(track => track.id === item.trackId))
        .filter(Boolean);
}

function getSelectedSegments() {
    return getSelectedItems()
        .filter(item => item.type === 'segment')
        .map(item => {
            const track = tracks.find(tr => tr.id === item.trackId);
            const segment = track?.segments.find(seg => seg.id === item.segId);
            return track && segment ? { track, segment } : null;
        })
        .filter(Boolean);
}

function uid(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function cloneSegmentForPaste(segment, suffix = ' copia') {
    return {
        ...JSON.parse(JSON.stringify(segment)),
        id: uid('seg'),
        name: `${segment.name || 'Tracciato'}${suffix}`
    };
}

function cloneTrackForPaste(track, suffix = ' copia') {
    const cloned = JSON.parse(JSON.stringify(track));
    cloned.id = uid('track');
    cloned.localFileId = uid('local');
    cloned.localCreatedAt = Date.now();
    cloned.localUpdatedAt = Date.now();
    cloned.localSource = 'created';
    cloned.name = `${track.name || 'Traccia'}${suffix}`;
    cloned.segments = (cloned.segments || []).map(seg => ({
        ...seg,
        id: uid('seg')
    }));
    cloned.waypoints = (cloned.waypoints || []).map(wp => ({
        ...wp,
        id: uid('wp')
    }));
    return cloned;
}

function getClipboardPayloadFromSelection() {
    const selectedTracks = getSelectedTracks();
    const selectedTrackIds = new Set(selectedTracks.map(track => track.id));
    const selectedSegments = getSelectedSegments()
        .filter(item => !selectedTrackIds.has(item.track.id));
    if (selectedTracks.length === 0 && selectedSegments.length === 0) return null;
    return {
        tracks: selectedTracks.map(track => JSON.parse(JSON.stringify(track))),
        segments: selectedSegments.map(item => ({
            sourceTrackId: item.track.id,
            segment: JSON.parse(JSON.stringify(item.segment))
        }))
    };
}

function refreshAfterTreeClipboardMutation(message) {
    if (_saveHistoryState) _saveHistoryState();
    if (_updateMapData) _updateMapData(true);
    updateActiveTracksHeader();
    renderGisTree();
    renderLocalGpxLibrary();
    schedulePersistAppSession();
    if (message) showToast(message, 'success');
}

function removeSelectionForCut() {
    const selectedTrackIds = new Set(getSelectedTracks().map(track => track.id));
    const selectedSegments = getSelectedSegments()
        .filter(item => !selectedTrackIds.has(item.track.id));

    if (selectedSegments.length > 0) {
        selectedSegments.forEach(({ track, segment }) => {
            track.segments = track.segments.filter(seg => seg.id !== segment.id);
        });
    }

    if (selectedTrackIds.size > 0) {
        setTracks(tracks.filter(track => !selectedTrackIds.has(track.id)));
    }

    if (!tracks.some(track => track.id === activeTrackId)) {
        const nextTrack = tracks[0] || null;
        setActiveTrackId(nextTrack?.id || null);
        setActiveSegmentId(nextTrack?.segments[0]?.id || null);
    } else {
        const activeTrack = tracks.find(track => track.id === activeTrackId);
        if (activeTrack && !activeTrack.segments.some(seg => seg.id === activeSegmentId)) {
            setActiveSegmentId(activeTrack.segments[0]?.id || null);
        }
    }
    setTreeSelection([]);
}

function pasteTreeClipboard(target = {}) {
    if (!_treeClipboard || ((_treeClipboard.tracks || []).length === 0 && (_treeClipboard.segments || []).length === 0)) {
        showToast('Niente da incollare', 'info');
        return;
    }

    const pastedKeys = [];
    const trackTargetIndex = target.trackId ? tracks.findIndex(track => track.id === target.trackId) : -1;
    let insertTrackIndex = trackTargetIndex === -1 ? tracks.length : trackTargetIndex + 1;

    (_treeClipboard.tracks || []).forEach(trackData => {
        const cloned = cloneTrackForPaste(trackData, _treeClipboard.mode === 'cut' ? '' : ' copia');
        tracks.splice(insertTrackIndex, 0, cloned);
        insertTrackIndex++;
        pastedKeys.push(makeTreeKey('track', cloned.id));
        setActiveTrackId(cloned.id);
        setActiveSegmentId(cloned.segments[0]?.id || null);
    });

    if ((_treeClipboard.segments || []).length > 0) {
        const targetTrack = tracks.find(track => track.id === target.trackId)
            || tracks.find(track => track.id === activeTrackId)
            || tracks[0];
        if (!targetTrack) return;

        let insertSegmentIndex = target.segId
            ? targetTrack.segments.findIndex(seg => seg.id === target.segId) + 1
            : targetTrack.segments.length;
        if (insertSegmentIndex < 0) insertSegmentIndex = targetTrack.segments.length;

        _treeClipboard.segments.forEach(item => {
            const cloned = cloneSegmentForPaste(item.segment, _treeClipboard.mode === 'cut' ? '' : ' copia');
            targetTrack.segments.splice(insertSegmentIndex, 0, cloned);
            insertSegmentIndex++;
            pastedKeys.push(makeTreeKey('segment', targetTrack.id, cloned.id));
            setActiveTrackId(targetTrack.id);
            setActiveSegmentId(cloned.id);
        });
    }

    setTreeSelection(pastedKeys);
    if (_treeClipboard.mode === 'cut') _treeClipboard = null;
    refreshAfterTreeClipboardMutation('Elementi incollati');
}

function createTreeContextMenuButton(icon, label, action, disabled = false, danger = false) {
    return `
      <button onclick="${action}" ${disabled ? 'disabled' : ''}
              class="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-left ${danger ? 'text-red-300 hover:bg-red-950' : 'hover:bg-gray-800'} ${disabled ? 'opacity-40 cursor-not-allowed hover:bg-transparent' : ''}">
        <i data-lucide="${icon}" class="w-3.5 h-3.5"></i><span>${label}</span>
      </button>`;
}

function isInteractiveTreeTarget(target) {
    return Boolean(target?.closest('button, input, select, textarea, label, [data-tree-control="true"]'));
}

function isTextEditingTarget(target) {
    return Boolean(target?.closest('input, textarea, select, [contenteditable="true"]'));
}

function closeTrackContextMenu() {
    if (_trackContextMenu) {
        _trackContextMenu.remove();
        _trackContextMenu = null;
    }
    document.removeEventListener('pointerdown', handleOutsideTrackContextMenu);
    document.removeEventListener('keydown', handleTrackContextMenuKeydown);
}

function handleOutsideTrackContextMenu(event) {
    if (!_trackContextMenu || _trackContextMenu.contains(event.target)) return;
    closeTrackContextMenu();
}

function handleTrackContextMenuKeydown(event) {
    if (event.key === 'Escape') closeTrackContextMenu();
}

function openTrackContextMenuAt(trackId, clientX, clientY) {
    const track = tracks.find(tr => tr.id === trackId);
    if (!track) return;
    ensureTreeItemSelected('track', trackId);
    normalizeTreeSelection();
    const selectedCount = _treeSelection.length;
    const hasClipboard = !!_treeClipboard && (((_treeClipboard.tracks || []).length + (_treeClipboard.segments || []).length) > 0);

    closeTrackContextMenu();
    const menu = document.createElement('div');
    menu.className = 'gpx-track-context-menu fixed z-50 w-60 rounded-xl border border-gray-700 bg-gray-950 shadow-2xl p-2 text-xs text-gray-200';
    menu.innerHTML = `
      <div class="px-2 pb-2 border-b border-gray-800">
        <div class="font-bold truncate">${escapeXml(track.name)}</div>
        <div class="text-[10px] text-gray-500">${selectedCount > 1 ? `${selectedCount} elementi selezionati` : 'File GPX selezionato'}</div>
      </div>
      ${createTreeContextMenuButton('copy', 'Copia', 'copyTreeSelection()')}
      ${createTreeContextMenuButton('clipboard-paste', 'Incolla', `pasteTreeSelection('${track.id}')`, !hasClipboard)}
      ${createTreeContextMenuButton('scissors', 'Taglia', 'cutTreeSelection()')}
      ${createTreeContextMenuButton('copy-plus', 'Duplica', `duplicateTreeSelection('${track.id}')`)}
      <div class="my-1 border-t border-gray-800"></div>
      <button onclick="openTrackNameEditor('${track.id}')" class="w-full flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-gray-800 text-left">
        <i data-lucide="pencil" class="w-3.5 h-3.5"></i><span>Rinomina</span>
      </button>
      <label class="flex items-center justify-between gap-2 px-2 py-2 rounded-lg hover:bg-gray-800 cursor-pointer">
        <span class="flex items-center gap-2"><i data-lucide="palette" class="w-3.5 h-3.5"></i> Colore</span>
        <input type="color" value="${track.color || '#3b82f6'}" onchange="changeTrackColor('${track.id}', this.value)" class="w-6 h-6 rounded border-0 bg-transparent cursor-pointer">
      </label>
      <label class="block px-2 py-2 rounded-lg hover:bg-gray-800 cursor-pointer">
        <span class="flex items-center justify-between mb-1">
          <span class="flex items-center gap-2"><i data-lucide="minus" class="w-3.5 h-3.5"></i> Spessore</span>
          <span class="text-gray-400">${track.width || 3}px</span>
        </span>
        <input type="range" min="1" max="12" step="1" value="${track.width || 3}" oninput="changeTrackWidth('${track.id}', this.value)" class="w-full accent-blue-500">
      </label>
      <button onclick="toggleTrackVisibility('${track.id}')" class="w-full flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-gray-800 text-left">
        <i data-lucide="${track.visible === false ? 'eye' : 'eye-off'}" class="w-3.5 h-3.5"></i><span>${track.visible === false ? 'Mostra file' : 'Nascondi file'}</span>
      </button>
      ${createTreeContextMenuButton('trash-2', selectedCount > 1 ? 'Elimina selezione' : 'Elimina file', selectedCount > 1 ? 'deleteTreeSelection()' : `deleteTrack('${track.id}')`, false, true)}`;
    document.body.appendChild(menu);
    lucide.createIcons();

    const padding = 8;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(padding, Math.min(clientX, window.innerWidth - rect.width - padding))}px`;
    menu.style.top = `${Math.max(padding, Math.min(clientY, window.innerHeight - rect.height - padding))}px`;
    _trackContextMenu = menu;
    setTimeout(() => {
        document.addEventListener('pointerdown', handleOutsideTrackContextMenu);
        document.addEventListener('keydown', handleTrackContextMenuKeydown);
    }, 0);
}

export function handleTrackContextMenu(event, trackId) {
    event.preventDefault();
    event.stopPropagation();
    if (!selectionHas(makeTreeKey('track', trackId))) selectTreeItem('track', trackId, null, event);
    setTrackActive(trackId, false);
    openTrackContextMenuAt(trackId, event.clientX, event.clientY);
}

export function handleTrackPointerDown(event, trackId) {
    if (event.pointerType === 'mouse' || isInteractiveTreeTarget(event.target)) return;
    clearTimeout(_trackLongPressTimer);
    _trackLongPressTimer = setTimeout(() => {
        selectTreeItem('track', trackId);
        setTrackActive(trackId, false);
        openTrackContextMenuAt(trackId, event.clientX, event.clientY);
    }, 650);
}

function openSegmentContextMenuAt(trackId, segId, clientX, clientY) {
    const track = tracks.find(tr => tr.id === trackId);
    const segment = track?.segments.find(seg => seg.id === segId);
    if (!track || !segment) return;
    ensureTreeItemSelected('segment', trackId, segId);
    normalizeTreeSelection();
    const selectedCount = _treeSelection.length;
    const hasClipboard = !!_treeClipboard && (((_treeClipboard.tracks || []).length + (_treeClipboard.segments || []).length) > 0);

    closeTrackContextMenu();
    const menu = document.createElement('div');
    menu.className = 'gpx-track-context-menu fixed z-50 w-60 rounded-xl border border-gray-700 bg-gray-950 shadow-2xl p-2 text-xs text-gray-200';
    menu.innerHTML = `
      <div class="px-2 pb-2 border-b border-gray-800">
        <div class="font-bold truncate">${escapeXml(segment.name)}</div>
        <div class="text-[10px] text-gray-500">${selectedCount > 1 ? `${selectedCount} elementi selezionati` : 'Segmento selezionato'}</div>
      </div>
      ${createTreeContextMenuButton('copy', 'Copia', 'copyTreeSelection()')}
      ${createTreeContextMenuButton('clipboard-paste', 'Incolla', `pasteTreeSelection('${trackId}', '${segId}')`, !hasClipboard)}
      ${createTreeContextMenuButton('scissors', 'Taglia', 'cutTreeSelection()')}
      ${createTreeContextMenuButton('copy-plus', 'Duplica', `duplicateTreeSelection('${trackId}', '${segId}')`)}
      <div class="my-1 border-t border-gray-800"></div>
      <button onclick="renameSegmentFromMenu('${trackId}', '${segId}')" class="w-full flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-gray-800 text-left">
        <i data-lucide="pencil" class="w-3.5 h-3.5"></i><span>Rinomina</span>
      </button>
      <button onclick="toggleSegmentVisibility('${trackId}', '${segId}')" class="w-full flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-gray-800 text-left">
        <i data-lucide="${segment.visible === false ? 'eye' : 'eye-off'}" class="w-3.5 h-3.5"></i><span>${segment.visible === false ? 'Mostra segmento' : 'Nascondi segmento'}</span>
      </button>
      ${createTreeContextMenuButton('trash-2', selectedCount > 1 ? 'Elimina selezione' : 'Elimina segmento', selectedCount > 1 ? 'deleteTreeSelection()' : `deleteSegment('${trackId}', '${segId}')`, false, true)}`;
    document.body.appendChild(menu);
    lucide.createIcons();

    const padding = 8;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(padding, Math.min(clientX, window.innerWidth - rect.width - padding))}px`;
    menu.style.top = `${Math.max(padding, Math.min(clientY, window.innerHeight - rect.height - padding))}px`;
    _trackContextMenu = menu;
    setTimeout(() => {
        document.addEventListener('pointerdown', handleOutsideTrackContextMenu);
        document.addEventListener('keydown', handleTrackContextMenuKeydown);
    }, 0);
}

export function handleSegmentContextMenu(event, trackId, segId) {
    event.preventDefault();
    event.stopPropagation();
    if (!selectionHas(makeTreeKey('segment', trackId, segId))) selectTreeItem('segment', trackId, segId, event);
    setSegmentActive(trackId, segId, false);
    openSegmentContextMenuAt(trackId, segId, event.clientX, event.clientY);
}

export function handleSegmentPointerDown(event, trackId, segId) {
    if (event.pointerType === 'mouse' || isInteractiveTreeTarget(event.target)) return;
    clearTimeout(_trackLongPressTimer);
    _trackLongPressTimer = setTimeout(() => {
        selectTreeItem('segment', trackId, segId);
        setSegmentActive(trackId, segId, false);
        openSegmentContextMenuAt(trackId, segId, event.clientX, event.clientY);
    }, 650);
}

export function clearTrackLongPress() {
    clearTimeout(_trackLongPressTimer);
    _trackLongPressTimer = null;
}

export function handleTrackTreeClick(event, trackId, shouldFocus = false) {
    if (isInteractiveTreeTarget(event.target)) return;
    selectTreeItem('track', trackId, null, event);
    setTrackActive(trackId, shouldFocus);
}

export function handleSegmentTreeClick(event, trackId, segId, shouldFocus = false) {
    if (isInteractiveTreeTarget(event.target)) return;
    event.stopPropagation();
    selectTreeItem('segment', trackId, segId, event);
    setSegmentActive(trackId, segId, shouldFocus);
}

export function copyTreeSelection() {
    const payload = getClipboardPayloadFromSelection();
    if (!payload) {
        showToast('Nessun elemento selezionato', 'info');
        return;
    }
    _treeClipboard = { ...payload, mode: 'copy' };
    closeTrackContextMenu();
    showToast('Selezione copiata', 'success');
}

export function cutTreeSelection() {
    const payload = getClipboardPayloadFromSelection();
    if (!payload) {
        showToast('Nessun elemento selezionato', 'info');
        return;
    }
    _treeClipboard = { ...payload, mode: 'cut' };
    removeSelectionForCut();
    closeTrackContextMenu();
    refreshAfterTreeClipboardMutation('Selezione tagliata');
}

export function pasteTreeSelection(trackId = null, segId = null) {
    closeTrackContextMenu();
    pasteTreeClipboard({ trackId, segId });
}

export function duplicateTreeSelection(trackId = null, segId = null) {
    const payload = getClipboardPayloadFromSelection();
    if (!payload) {
        showToast('Nessun elemento selezionato', 'info');
        return;
    }
    const previousClipboard = _treeClipboard;
    _treeClipboard = { ...payload, mode: 'copy' };
    pasteTreeClipboard({ trackId, segId });
    _treeClipboard = previousClipboard;
}

export function deleteTreeSelection() {
    if (_treeSelection.length === 0) {
        showToast('Nessun elemento selezionato', 'info');
        return;
    }
    removeSelectionForCut();
    closeTrackContextMenu();
    refreshAfterTreeClipboardMutation('Selezione eliminata');
}

export function selectAllTreeItems() {
    setTreeSelection(getTreeItemOrder());
    renderGisTree();
    showToast('Tutti gli elementi del tree selezionati', 'info');
}

export function handleTreeKeyboardShortcuts(event) {
    if (!isSidebarOpen() || isTextEditingTarget(event.target)) return;
    const key = event.key.toLowerCase();
    const hasModifier = event.ctrlKey || event.metaKey;
    if (!hasModifier && event.key !== 'Delete' && event.key !== 'Backspace') return;

    if (hasModifier && key === 'a') {
        event.preventDefault();
        selectAllTreeItems();
    } else if (hasModifier && key === 'c') {
        event.preventDefault();
        copyTreeSelection();
    } else if (hasModifier && key === 'x') {
        event.preventDefault();
        cutTreeSelection();
    } else if (hasModifier && key === 'v') {
        event.preventDefault();
        pasteTreeSelection(activeTrackId, activeSegmentId);
    } else if (hasModifier && key === 'd') {
        event.preventDefault();
        duplicateTreeSelection(activeTrackId, activeSegmentId);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        deleteTreeSelection();
    }
}

export function renameSegmentFromMenu(trackId, segId) {
    closeTrackContextMenu();
    const input = document.getElementById(`segment-name-${segId}`);
    if (!input) return;
    input.focus();
    input.select();
}

export function handleTrackNamePointerDown(event, trackId) {
    if (event.pointerType === 'mouse') {
        const now = Date.now();
        if (_lastTrackNamePointer.trackId === trackId && now - _lastTrackNamePointer.time < 450) {
            event.preventDefault();
            openTrackNameEditor(trackId);
        }
        _lastTrackNamePointer = { trackId, time: now };
        return;
    }
    event.stopPropagation();
    clearTimeout(_trackNameLongPressTimer);
    _trackNameLongPressTimer = setTimeout(() => {
        openTrackNameEditor(trackId);
    }, 650);
}

export function clearTrackNameLongPress() {
    clearTimeout(_trackNameLongPressTimer);
    _trackNameLongPressTimer = null;
}

export function handleTrackNameClick(event, trackId) {
    event.stopPropagation();
    const now = Date.now();
    const isSecondClick = _lastTrackNameClick.trackId === trackId && now - _lastTrackNameClick.time < 800;
    _lastTrackNameClick = { trackId, time: now };
    if (event.detail >= 2 || isSecondClick) {
        event.preventDefault();
        openTrackNameEditor(trackId);
        return;
    }
    setTrackActive(trackId, true);
}

export function openTrackNameEditor(trackId) {
    closeTrackContextMenu();
    const nameEl = document.getElementById(`track-name-${trackId}`);
    if (!nameEl) return;
    nameEl.contentEditable = 'true';
    nameEl.classList.remove('cursor-pointer');
    nameEl.classList.add('cursor-text');
    nameEl.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(nameEl);
    selection.removeAllRanges();
    selection.addRange(range);
}

export function finishTrackNameEditor(trackId, newName) {
    const nameEl = document.getElementById(`track-name-${trackId}`);
    if (nameEl) {
        nameEl.contentEditable = 'false';
        nameEl.classList.add('cursor-pointer');
        nameEl.classList.remove('cursor-text');
    }
    renameTrack(trackId, newName);
}

export function handleTrackNameKeydown(event, trackId) {
    if (event.key === 'Enter') {
        event.preventDefault();
        finishTrackNameEditor(trackId, event.currentTarget.textContent);
        event.currentTarget.blur();
    } else if (event.key === 'Escape') {
        event.preventDefault();
        const track = tracks.find(tr => tr.id === trackId);
        if (track) event.currentTarget.textContent = track.name;
        event.currentTarget.blur();
    }
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
    if (document.getElementById('toggle-mapillary')) {
        document.getElementById('toggle-mapillary').checked = session?.mapillaryVisible === true;
    }
    if (_setMapillaryCoverageVisible) {
        _setMapillaryCoverageVisible(session?.mapillaryVisible === true, { silent: true });
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
    document.getElementById('btn-mobile-stats')?.classList.remove('bg-blue-600', 'text-white');
}

function closeOtherPanels(except) {
    closeMobileToolbar();
    if (except !== 'main') closeMainMenu();
    if (except !== 'sidebar') closeSidebar();
    if (except !== 'stats') closeStatsPanel();
    if (except !== 'print' && _disablePrintPlanning) _disablePrintPlanning();
}

function closeMobileToolbar() {
    document.body.classList.remove('mobile-tools-open');
    document.getElementById('btn-mobile-toolbar-toggle')?.classList.remove('bg-blue-600', 'text-white');
}

function toggleMobileToolbar() {
    const isOpen = document.body.classList.toggle('mobile-tools-open');
    const btn = document.getElementById('btn-mobile-toolbar-toggle');
    btn?.classList.toggle('bg-blue-600', isOpen);
    btn?.classList.toggle('text-white', isOpen);
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
    normalizeTreeSelection();
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
            const isSelected = selectionHas(makeTreeKey('track', track.id));
            const isExpanded = isActive;
            const segmentCount = track.segments.length;
            const pointCount = track.segments.reduce((sum, seg) => sum + seg.points.length, 0);
            html += `
            <div class="group bg-gray-900/95 border ${isSelected ? 'border-cyan-400/80 bg-cyan-950/20' : (isActive ? 'border-blue-500/60 shadow-blue-950/30' : 'border-gray-800')} rounded-xl overflow-hidden shadow-lg"
                 onclick="handleTrackTreeClick(event, '${track.id}', true)"
                 oncontextmenu="handleTrackContextMenu(event, '${track.id}')"
                 onpointerdown="handleTrackPointerDown(event, '${track.id}')"
                 onpointerup="clearTrackLongPress()"
                 onpointercancel="clearTrackLongPress()"
                 onpointerleave="clearTrackLongPress()"
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
                      <div class="min-w-0 cursor-pointer">
                        <div class="flex items-center gap-1.5 min-w-0">
                          <i data-lucide="${isExpanded ? 'chevron-down' : 'chevron-right'}" class="w-3 h-3 ${isActive ? 'text-blue-300' : 'text-gray-500'} shrink-0"></i>
                          <i data-lucide="file-map" class="w-3.5 h-3.5 ${isActive ? 'text-blue-300' : 'text-gray-500'} shrink-0"></i>
                          <span id="track-name-${track.id}" data-track-name-id="${track.id}" role="button" tabindex="0" contenteditable="false"
                                class="track-name-label block text-xs font-bold ${track.visible === false ? 'text-gray-500 line-through' : 'text-white'} border-b border-transparent focus:border-blue-500 focus:outline-none min-w-0 w-36 truncate cursor-pointer select-none">${escapeXml(track.name)}</span>
                        </div>
                        <div class="text-[10px] text-gray-500 mt-0.5 pl-5">
                          File ${trackIndex + 1} · ${segmentCount} segmenti · ${pointCount} pt · ${track.waypoints.length} wp · ${track.width || 3}px
                        </div>
                      </div>
                    </div>
                    <div class="flex items-center gap-1.5 shrink-0">
                      <button onclick="toggleTrackVisibility('${track.id}')" class="text-gray-400 hover:text-white" title="Mostra/Nascondi File"><i data-lucide="${track.visible === false ? 'eye-off' : 'eye'}" class="w-3.5 h-3.5"></i></button>
                      <input type="color" value="${track.color}" onchange="changeTrackColor('${track.id}', this.value)" class="w-4 h-4 rounded border-0 bg-transparent cursor-pointer" title="Colore traccia">
                      <button onclick="handleTrackContextMenu(event, '${track.id}')" class="text-gray-500 hover:text-white" title="Menu file"><i data-lucide="more-vertical" class="w-3.5 h-3.5"></i></button>
                      <button onclick="deleteTrack('${track.id}')" class="text-gray-500 hover:text-red-400" title="Elimina file"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                    </div>
                  </div>

                  ${isExpanded ? `
                  <div class="ml-5 pl-3 border-l border-gray-800/90 space-y-1"
                       ondragover="handleGisDragOver(event)"
                       ondrop="handleGisDrop(event, 'track-segments', '${track.id}')">
                    <div class="text-[9px] text-gray-600 font-bold uppercase tracking-wider flex items-center gap-1 pb-0.5">
                      <i data-lucide="git-branch" class="w-3 h-3"></i> Segmenti
                    </div>
                    ${track.segments.map((seg, segIndex) => {
                        const isSegActive = seg.id === activeSegmentId;
                        const isSegSelected = selectionHas(makeTreeKey('segment', track.id, seg.id));
                        return `
                        <div class="flex items-center justify-between text-xs py-1.5 px-1.5 rounded border ${isSegSelected ? 'bg-cyan-950/45 text-cyan-200 border-cyan-700/70' : (isSegActive ? 'bg-blue-950/40 text-blue-300 border-blue-900/60' : 'text-gray-400 border-transparent hover:bg-gray-800/45 hover:border-gray-800')} ${seg.visible === false ? 'opacity-55' : ''}"
                             onclick="handleSegmentTreeClick(event, '${track.id}', '${seg.id}', true)"
                             oncontextmenu="handleSegmentContextMenu(event, '${track.id}', '${seg.id}')"
                             onpointerdown="handleSegmentPointerDown(event, '${track.id}', '${seg.id}')"
                             onpointerup="clearTrackLongPress()"
                             onpointercancel="clearTrackLongPress()"
                             onpointerleave="clearTrackLongPress()"
                             ondragover="handleGisDragOver(event)"
                             ondrop="handleGisDrop(event, 'segment', '${track.id}', '${seg.id}')">
                          <div class="flex items-center gap-1.5 min-w-0 cursor-pointer">
                            <button draggable="true"
                                    ondragstart="handleGisDragStart(event, 'segment', '${track.id}', '${seg.id}')"
                                    ondragend="handleGisDragEnd(event)"
                                    class="text-gray-600 hover:text-gray-300 cursor-grab active:cursor-grabbing shrink-0"
                                    title="Trascina per riordinare o spostare questo segmento">
                              <i data-lucide="grip-vertical" class="w-3.5 h-3.5"></i>
                            </button>
                            <i data-lucide="milestone" class="w-3 h-3 text-gray-500 shrink-0"></i>
                            <input id="segment-name-${seg.id}" type="text" value="${escapeXml(seg.name)}" onchange="renameSegment('${track.id}', '${seg.id}', this.value)" onclick="event.stopPropagation()" class="bg-transparent text-[11px] border-b border-transparent hover:border-gray-700 focus:border-blue-500 focus:outline-none min-w-0 w-24 ${seg.visible === false ? 'line-through' : ''}">
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
                ` : '') : ''}
                </div>
              </div>
            </div>`;
        });
        html += `</div>`;
    }
    container.innerHTML = html;
    lucide.createIcons();
    container.querySelectorAll('[data-track-name-id]').forEach(nameEl => {
        const trackId = nameEl.dataset.trackNameId;
        nameEl.addEventListener('click', event => handleTrackNameClick(event, trackId));
        nameEl.addEventListener('dblclick', event => {
            event.preventDefault();
            openTrackNameEditor(trackId);
        });
        nameEl.addEventListener('pointerdown', event => handleTrackNamePointerDown(event, trackId));
        nameEl.addEventListener('pointerup', clearTrackNameLongPress);
        nameEl.addEventListener('pointercancel', clearTrackNameLongPress);
        nameEl.addEventListener('pointerleave', clearTrackNameLongPress);
        nameEl.addEventListener('keydown', event => handleTrackNameKeydown(event, trackId));
        nameEl.addEventListener('blur', event => finishTrackNameEditor(trackId, event.currentTarget.textContent));
    });
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

    const wasActive = activeTrackId === trackId;
    setActiveTrackId(trackId);
    if (track.segments.length > 0) {
        setActiveSegmentId(track.segments[track.segments.length - 1].id);
    }
    if (shouldFocus) focusTrackOnMap(track);
    if (_updateMapData) _updateMapData();
    updateActiveTracksHeader();
    if (!wasActive) renderGisTree();
    schedulePersistAppSession();
}

export function renameTrack(trackId, newName) {
    const t = tracks.find(tr => tr.id === trackId);
    const cleanName = String(newName || '').trim();
    if (t && cleanName && t.name !== cleanName) {
        t.name = cleanName;
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
        renderGisTree();
    }
}

export function changeTrackWidth(trackId, newWidth) {
    const t = tracks.find(tr => tr.id === trackId);
    const width = Math.max(1, Math.min(12, Number(newWidth) || 3));
    if (t && t.width !== width) {
        t.width = width;
        if (_saveHistoryState) _saveHistoryState();
        if (_updateMapData) _updateMapData();
        renderGisTree();
    }
}

export function toggleTrackVisibility(trackId) {
    const t = tracks.find(tr => tr.id === trackId);
    if (t) {
        t.visible = t.visible === false ? true : false;
        if (_saveHistoryState) _saveHistoryState();
        if (_updateMapData) _updateMapData();
        renderGisTree();
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

export function setSegmentActive(trackId, segId, shouldFocus = false) {
    setActiveTrackId(trackId);
    setActiveSegmentId(segId);
    if (shouldFocus) focusSegmentOnMap(trackId, segId);
    if (_updateMapData) _updateMapData();
    updateActiveTracksHeader();
    renderGisTree();
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
          <div onclick="setTrackActive('${t.id}', true)" class="cursor-pointer flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold whitespace-nowrap transition-all ${isActive ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-400 hover:text-white'} ${t.visible === false ? 'opacity-50' : ''}">
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

    document.getElementById('btn-mobile-toolbar-toggle').onclick = () => {
        if (isCompactLayout()) {
            closeMainMenu();
            closeSidebar();
            closeStatsPanel();
            if (_disablePrintPlanning) _disablePrintPlanning();
            toggleMobileToolbar();
            syncMobileBackdrop();
        }
    };

    document.getElementById('btn-main-menu').onclick = () => {
        const p = document.getElementById('panel-main-menu');
        const willOpen = p.classList.contains('-translate-x-80');
        if (willOpen && isCompactLayout()) closeOtherPanels('main');
        else closeMobileToolbar();
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
        else closeMobileToolbar();
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
            else closeMobileToolbar();
            panel.classList.remove('translate-y-60');
            btn.classList.add('bg-blue-600', 'text-white');
            btn.classList.remove('text-gray-300');
            document.getElementById('btn-mobile-stats')?.classList.add('bg-blue-600', 'text-white');
            // Forza un ricalcolo: il pannello era chiuso e abbiamo saltato i refresh
            forceUpdateStats();
        }
        syncMobileBackdrop();
    };

    document.getElementById('btn-mobile-stats').onclick = () => {
        closeMobileToolbar();
        document.getElementById('btn-toggle-stats').click();
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

    document.getElementById('toggle-mapillary').onchange = (e) => {
        if (_setMapillaryCoverageVisible) _setMapillaryCoverageVisible(e.target.checked);
        updateMapillaryToolbarButton();
    };

    document.getElementById('btn-save-mapillary-token').onclick = () => {
        const token = document.getElementById('input-mapillary-token').value;
        if (_configureMapillaryToken) _configureMapillaryToken(token);
        updateMapillaryToolbarButton();
        showToast(token.trim() ? "Token Mapillary salvato" : "Token Mapillary rimosso", "success");
    };

    document.getElementById('btn-clear-mapillary-token').onclick = () => {
        document.getElementById('input-mapillary-token').value = '';
        if (_configureMapillaryToken) _configureMapillaryToken('');
        updateMapillaryToolbarButton();
        showToast("Token Mapillary rimosso", "success");
    };

    document.getElementById('btn-close-mapillary-viewer').onclick = () => {
        if (_closeMapillaryViewer) _closeMapillaryViewer();
    };

    document.getElementById('view-mode-2d').onclick = () => _setDimensionMode(false);
    document.getElementById('view-mode-3d').onclick = () => _setDimensionMode(true);

    document.getElementById('btn-draw-track').onclick = () => {
        setIsDrawing(!isDrawing);
        setIsCutting(false);
        setIsBoxDeleting(false);
        setIsAddingWaypoint(false);
        _disablePrintPlanning();
        clearBoxDeleteSelection();

        const btn = document.getElementById('btn-draw-track');
        if (isDrawing) {
            btn.classList.add('bg-blue-600', 'text-white');
            showToast("Clicca sulla mappa per iniziare a tracciare", "info");
        } else {
            btn.classList.remove('bg-blue-600', 'text-white');
            if (_updateMapData) _updateMapData(true);
        }
        updateToolButtons();
        updateMapToolCursor();
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

    document.getElementById('btn-mapillary-layer').onclick = () => {
        const toggle = document.getElementById('toggle-mapillary');
        if (!toggle) return;
        toggle.checked = !toggle.checked;
        if (_setMapillaryCoverageVisible) _setMapillaryCoverageVisible(toggle.checked);
        updateMapillaryToolbarButton();
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
        if (isBoxDeleting && boxDeleteCoords) updateBoxDeletePreview(e.lngLat);
        updateMapToolCursor();
    });

    document.getElementById('btn-cut-track').onclick = () => {
        setIsCutting(!isCutting);
        setIsDrawing(false);
        setIsBoxDeleting(false);
        setIsAddingWaypoint(false);
        _disablePrintPlanning();
        clearBoxDeleteSelection();
        updateToolButtons();
        updateMapToolCursor();
        showToast(isCutting ? "Clicca su un punto della traccia per tagliarla in due segmenti" : "Taglio disattivato", "info");
    };

    document.getElementById('btn-box-delete').onclick = () => {
        setIsBoxDeleting(!isBoxDeleting);
        setIsDrawing(false);
        setIsCutting(false);
        setIsAddingWaypoint(false);
        _disablePrintPlanning();
        clearBoxDeleteSelection();
        updateToolButtons();
        updateMapToolCursor();
        showToast(isBoxDeleting ? "Clicca due punti per definire il rettangolo d'eliminazione" : "Cancellazione box disattivata", "info");
    };

    document.getElementById('btn-add-waypoint').onclick = () => {
        setIsAddingWaypoint(!isAddingWaypoint);
        setIsDrawing(false);
        setIsCutting(false);
        setIsBoxDeleting(false);
        _disablePrintPlanning();
        clearBoxDeleteSelection();
        updateToolButtons();
        updateMapToolCursor();
        showToast(isAddingWaypoint ? "Clicca sulla mappa per inserire un Waypoint" : "Inserimento waypoint disattivato", "info");
    };

    updateToolButtons();
    updateMapToolCursor();
    updateMapillaryToolbarButton();

    document.getElementById('btn-undo').onclick = _triggerUndo;

    window.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
            e.preventDefault();
            _triggerUndo();
            return;
        }
        handleTreeKeyboardShortcuts(e);
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
