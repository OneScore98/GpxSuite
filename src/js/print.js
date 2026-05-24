// print.js — togglePrintPlanning, disablePrintPlanning, generateHighResPrintPreview,
//            renderPrintA4Pages, updatePrintGridDimensions, setupPrintDragEvents,
//            updatePrintGridLayout, updatePrintGridScale, setPrintPlanningOrientation

import {
    map, mapLoaded,
    tracks, activeTrackId,
    printPlanningMode, setPrintPlanningMode,
    printGrid, updatePrintGridProp
} from './state.js';

import { showToast, syncMobileBackdrop } from './ui.js';

let generazioneAnteprimaStampaInCorso = false;
const PRINT_RENDER_LONG_EDGE = 2800;
const PRINT_RENDER_MAX_EDGE = 3600;

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[char]));
}

function attendiMappaFerma(mapInstance = map, timeoutMs = 3000, allowImmediate = true) {
    return new Promise(resolve => {
        let done = false;
        let timeoutId = null;

        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timeoutId);
            mapInstance.off('idle', finish);
            resolve();
        };

        timeoutId = setTimeout(finish, timeoutMs);
        mapInstance.once('idle', finish);

        const tilesReady = typeof mapInstance.areTilesLoaded === 'function' ? mapInstance.areTilesLoaded() : true;
        const isMoving = typeof mapInstance.isMoving === 'function' ? mapInstance.isMoving() : false;
        if (allowImmediate && tilesReady && !isMoving) {
            requestAnimationFrame(() => requestAnimationFrame(finish));
        }
    });
}

function calcolaDimensioniRender(cellWidth, cellHeight) {
    const aspect = cellWidth / cellHeight;
    let width;
    let height;

    if (aspect >= 1) {
        width = PRINT_RENDER_LONG_EDGE;
        height = Math.round(width / aspect);
    } else {
        height = PRINT_RENDER_LONG_EDGE;
        width = Math.round(height * aspect);
    }

    return {
        width: Math.min(width, PRINT_RENDER_MAX_EDGE),
        height: Math.min(height, PRINT_RENDER_MAX_EDGE)
    };
}

function scegliPassoGriglia(deltaGradi) {
    const targetLinee = 5;
    const rawStep = Math.max(deltaGradi / targetLinee, 0.00001);
    const pow = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const normalized = rawStep / pow;
    const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
    return factor * pow;
}

function formattaCoordinata(value, isLat) {
    const hemi = isLat ? (value >= 0 ? 'N' : 'S') : (value >= 0 ? 'E' : 'W');
    return `${Math.abs(value).toFixed(3)}&deg;${hemi}`;
}

function generaLineeGriglia(sheet) {
    const sw = sheet.bounds.sw;
    const ne = sheet.bounds.ne;
    const lonMin = Math.min(sw.lng, ne.lng);
    const lonMax = Math.max(sw.lng, ne.lng);
    const latMin = Math.min(sw.lat, ne.lat);
    const latMax = Math.max(sw.lat, ne.lat);
    const lonStep = scegliPassoGriglia(lonMax - lonMin);
    const latStep = scegliPassoGriglia(latMax - latMin);
    const lines = [];

    const firstLon = Math.ceil(lonMin / lonStep) * lonStep;
    for (let lon = firstLon; lon < lonMax; lon += lonStep) {
        if (lon <= lonMin) continue;
        const pct = ((lon - lonMin) / (lonMax - lonMin)) * 100;
        lines.push(`
            <div class="print-coord-line print-coord-line-vertical" style="left:${pct}%"></div>
            <span class="print-coord-label print-coord-label-top" style="left:${pct}%">${formattaCoordinata(lon, false)}</span>
            <span class="print-coord-label print-coord-label-bottom" style="left:${pct}%">${formattaCoordinata(lon, false)}</span>
        `);
    }

    const firstLat = Math.ceil(latMin / latStep) * latStep;
    for (let lat = firstLat; lat < latMax; lat += latStep) {
        if (lat <= latMin) continue;
        const pct = (1 - ((lat - latMin) / (latMax - latMin))) * 100;
        lines.push(`
            <div class="print-coord-line print-coord-line-horizontal" style="top:${pct}%"></div>
            <span class="print-coord-label print-coord-label-left" style="top:${pct}%">${formattaCoordinata(lat, true)}</span>
            <span class="print-coord-label print-coord-label-right" style="top:${pct}%">${formattaCoordinata(lat, true)}</span>
        `);
    }

    return lines.join('');
}

function creaContenitoreRender(width, height) {
    const container = document.createElement('div');
    container.style.position = 'fixed';
    container.style.left = '-100000px';
    container.style.top = '0';
    // Usa dimensioni CSS reali alte: MapLibre calcola zoom e tile in CSS px.
    // Dividere per devicePixelRatio renderebbe il render nitido solo in pixel,
    // ma con uno zoom geografico troppo basso e quindi visivamente sfocato.
    container.style.width = `${Math.max(1, Math.round(width))}px`;
    container.style.height = `${Math.max(1, Math.round(height))}px`;
    container.style.pointerEvents = 'none';
    container.style.overflow = 'hidden';
    document.body.appendChild(container);
    return container;
}

async function renderizzaRiquadroAltaRisoluzione(swGeo, neGeo, cellWidth, cellHeight) {
    const renderSize = calcolaDimensioniRender(cellWidth, cellHeight);
    const container = creaContenitoreRender(renderSize.width, renderSize.height);
    let renderMap = null;

    try {
        const style = JSON.parse(JSON.stringify(map.getStyle()));
        renderMap = new maplibregl.Map({
            container,
            style,
            interactive: false,
            attributionControl: false,
            preserveDrawingBuffer: true,
            fadeDuration: 0,
            maxTileCacheSize: 0
        });

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timeout inizializzazione mappa stampa')), 9000);
            renderMap.once('load', () => {
                clearTimeout(timeout);
                resolve();
            });
            renderMap.once('error', (event) => {
                if (!renderMap.loaded()) return;
                console.warn('Avviso render stampa:', event?.error || event);
            });
        });

        renderMap.jumpTo({
            pitch: map.getPitch(),
            bearing: map.getBearing()
        });
        renderMap.fitBounds([swGeo.toArray(), neGeo.toArray()], {
            animate: false,
            padding: 0,
            bearing: map.getBearing()
        });
        renderMap.resize();
        renderMap.triggerRepaint();
        await attendiMappaFerma(renderMap, 10000, false);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        const canvas = renderMap.getCanvas();
        return {
            dataUrl: canvas.toDataURL('image/png'),
            width: canvas.width,
            height: canvas.height
        };
    } finally {
        if (renderMap) renderMap.remove();
        container.remove();
    }
}

function setPulsanteGenerazioneOccupato(isBusy) {
    const btn = document.getElementById('btn-generate-previews');
    if (!btn) return;

    btn.disabled = isBusy;
    btn.classList.toggle('opacity-60', isBusy);
    btn.classList.toggle('cursor-wait', isBusy);
}

function limitaCentroGriglia(x, y) {
    const mapEl = document.getElementById('map');
    if (!mapEl) return { x, y };

    const totalW = printGrid.cols * printGrid.width;
    const totalH = printGrid.rows * printGrid.height;
    const padding = 14;
    let safeLeft = padding;
    let safeRight = padding;
    let safeTop = padding;
    let safeBottom = padding;

    const panelEl = document.getElementById('panel-print-setup');
    if (panelEl && !panelEl.classList.contains('hidden')) {
        const mapRect = mapEl.getBoundingClientRect();
        const panelRect = panelEl.getBoundingClientRect();
        const mapWidth = mapEl.clientWidth;
        const mapHeight = mapEl.clientHeight;
        const panelSovrapposto = panelRect.right > mapRect.left
            && panelRect.left < mapRect.right
            && panelRect.bottom > mapRect.top
            && panelRect.top < mapRect.bottom;

        if (panelSovrapposto) {
            const panelLeft = panelRect.left - mapRect.left;
            const panelRight = panelRect.right - mapRect.left;
            const panelTop = panelRect.top - mapRect.top;
            const panelBottom = panelRect.bottom - mapRect.top;

            if (panelLeft <= padding && panelRight > padding) {
                safeLeft = Math.max(safeLeft, Math.min(mapWidth - padding, panelRight + 18));
            }

            if (panelRight >= mapWidth - padding && panelLeft < mapWidth - padding) {
                safeRight = Math.max(safeRight, Math.min(mapWidth - padding, mapWidth - panelLeft + 18));
            }

            if (panelTop <= padding && panelBottom > padding) {
                safeTop = Math.max(safeTop, Math.min(mapHeight - padding, panelBottom + 18));
            }

            if (panelBottom >= mapHeight - padding && panelTop < mapHeight - padding) {
                safeBottom = Math.max(safeBottom, Math.min(mapHeight - padding, mapHeight - panelTop + 18));
            }
        }
    }

    const minX = safeLeft + totalW / 2;
    const maxX = mapEl.clientWidth - safeRight - totalW / 2;
    const minY = safeTop + totalH / 2;
    const maxY = mapEl.clientHeight - safeBottom - totalH / 2;
    const fallbackX = safeLeft + Math.max(0, mapEl.clientWidth - safeLeft - safeRight) / 2;
    const fallbackY = safeTop + Math.max(0, mapEl.clientHeight - safeTop - safeBottom) / 2;

    return {
        x: minX <= maxX ? Math.max(minX, Math.min(maxX, x)) : fallbackX,
        y: minY <= maxY ? Math.max(minY, Math.min(maxY, y)) : fallbackY
    };
}

export function togglePrintPlanning() {
    setPrintPlanningMode(!printPlanningMode);

    if (printPlanningMode) {
        // Nascondi sidebar e pannello altitudine per massimizzare la mappa
        document.getElementById('panel-bottom-stats').classList.add('translate-y-60');
        document.getElementById('sidebar-tracks-right').classList.add('translate-x-96');
        document.getElementById('panel-main-menu').classList.add('-translate-x-80');

        // Mostra la griglia e la plancia
        document.getElementById('print-drag-grid').classList.remove('hidden');
        document.getElementById('panel-print-setup').classList.remove('hidden');

        // Posiziona inizialmente la griglia al centro dello schermo
        const mapEl = document.getElementById('map');
        updatePrintGridProp('x', mapEl.clientWidth / 2);
        updatePrintGridProp('y', mapEl.clientHeight / 2);

        updatePrintGridDimensions();
        showToast("Progettazione Stampa Attiva. Trascina la griglia blu sul tracciato.", "success");
        syncMobileBackdrop();
    } else {
        disablePrintPlanning();
    }
}

export function disablePrintPlanning() {
    setPrintPlanningMode(false);
    document.getElementById('print-drag-grid').classList.add('hidden');
    document.getElementById('panel-print-setup').classList.add('hidden');
    syncMobileBackdrop();
}

export function updatePrintGridDimensions() {
    const isPortrait = printGrid.orientation === 'portrait';
    updatePrintGridProp('width', (isPortrait ? 180 : 254) * printGrid.scale);
    updatePrintGridProp('height', (isPortrait ? 254 : 180) * printGrid.scale);

    const gridEl = document.getElementById('print-drag-grid');

    const totalW = printGrid.cols * printGrid.width;
    const totalH = printGrid.rows * printGrid.height;
    const clampedCenter = limitaCentroGriglia(printGrid.x, printGrid.y);
    updatePrintGridProp('x', clampedCenter.x);
    updatePrintGridProp('y', clampedCenter.y);

    gridEl.style.width = `${totalW}px`;
    gridEl.style.height = `${totalH}px`;
    gridEl.style.left = `${printGrid.x - totalW / 2}px`;
    gridEl.style.top = `${printGrid.y - totalH / 2}px`;
    gridEl.style.gridTemplateColumns = `repeat(${printGrid.cols}, ${printGrid.width}px)`;
    gridEl.style.gridTemplateRows = `repeat(${printGrid.rows}, ${printGrid.height}px)`;

    // Genera i singoli quadranti tratteggiati per l'anteprima
    gridEl.innerHTML = '';
    for (let r = 0; r < printGrid.rows; r++) {
        for (let c = 0; c < printGrid.cols; c++) {
            const index = r * printGrid.cols + c + 1;
            const cell = document.createElement('div');
            cell.className = 'print-grid-cell';
            cell.style.width = `${printGrid.width}px`;
            cell.style.height = `${printGrid.height}px`;
            cell.innerHTML = `
                <span class="print-grid-cell-badge">FOGLIO ${index}</span>
                <span class="print-grid-cell-number">${index}</span>
                <span class="print-grid-cell-label">AREA STAMPATA</span>
            `;
            gridEl.appendChild(cell);
        }
    }
}

export function setupPrintDragEvents() {
    const gridEl = document.getElementById('print-drag-grid');

    function onPointerDown(e) {
        updatePrintGridProp('isDragging', true);

        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;

        // Salva l'offset rispetto al centro
        updatePrintGridProp('dragOffsetX', clientX - printGrid.x);
        updatePrintGridProp('dragOffsetY', clientY - printGrid.y);

        gridEl.style.cursor = 'grabbing';
    }

    function onPointerMove(e) {
        if (!printGrid.isDragging) return;

        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;

        const newCenter = limitaCentroGriglia(clientX - printGrid.dragOffsetX, clientY - printGrid.dragOffsetY);

        updatePrintGridProp('x', newCenter.x);
        updatePrintGridProp('y', newCenter.y);

        updatePrintGridDimensions();
    }

    function onPointerUp() {
        updatePrintGridProp('isDragging', false);
        gridEl.style.cursor = 'grab';
    }

    gridEl.addEventListener('mousedown', onPointerDown);
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', onPointerUp);

    gridEl.addEventListener('touchstart', onPointerDown, { passive: true });
    window.addEventListener('touchmove', onPointerMove, { passive: true });
    window.addEventListener('touchend', onPointerUp);

    const riallineaGrigliaVisibile = () => {
        if (!printPlanningMode) return;
        requestAnimationFrame(updatePrintGridDimensions);
    };

    window.addEventListener('resize', riallineaGrigliaVisibile);
    window.addEventListener('orientationchange', riallineaGrigliaVisibile);
    window.visualViewport?.addEventListener('resize', riallineaGrigliaVisibile);
}

export function updatePrintGridLayout(e) {
    const [c, r] = e.target.value.split('x').map(Number);
    updatePrintGridProp('cols', c);
    updatePrintGridProp('rows', r);
    updatePrintGridDimensions();
}

export function updatePrintGridScale(e) {
    updatePrintGridProp('scale', Number(e.target.value) / 100);
    document.getElementById('print-scale-lbl').innerText = `${e.target.value}%`;
    updatePrintGridDimensions();
}

export function setPrintPlanningOrientation(orient) {
    updatePrintGridProp('orientation', orient);

    const btnPort = document.getElementById('btn-print-port');
    const btnLand = document.getElementById('btn-print-land');

    if (orient === 'portrait') {
        btnPort.className = "py-2 rounded-lg bg-blue-600 text-white font-bold text-xs";
        btnLand.className = "py-2 rounded-lg bg-stone-900 hover:bg-stone-800 border border-stone-800 text-stone-400 hover:text-white text-xs";
    } else {
        btnLand.className = "py-2 rounded-lg bg-blue-600 text-white font-bold text-xs";
        btnPort.className = "py-2 rounded-lg bg-stone-900 hover:bg-stone-800 border border-stone-800 text-stone-400 hover:text-white text-xs";
    }

    updatePrintGridDimensions();
}

export async function generateHighResPrintPreview() {
    if (generazioneAnteprimaStampaInCorso) return;

    if (!mapLoaded || !map) {
        showToast("La mappa non è ancora pronta per la stampa.", "error");
        return;
    }

    showToast("Cattura in corso dei quadranti cartografici...", "info");
    generazioneAnteprimaStampaInCorso = true;
    setPulsanteGenerazioneOccupato(true);

    // Calcola le coordinate geografiche di ciascun foglio
    const totalW = printGrid.cols * printGrid.width;
    const totalH = printGrid.rows * printGrid.height;
    const startX = printGrid.x - totalW / 2;
    const startY = printGrid.y - totalH / 2;

    const sheetScreenshots = [];
    const gridEl = document.getElementById('print-drag-grid');
    const wasGridHidden = gridEl?.classList.contains('hidden') ?? true;

    try {
        await attendiMappaFerma();

        // Loop di cattura sui fogli
        for (let r = 0; r < printGrid.rows; r++) {
            for (let c = 0; c < printGrid.cols; c++) {
                const cellLeft = startX + c * printGrid.width;
                const cellTop = startY + r * printGrid.height;

                // Calcola il bounding box geografico della cella sul viewport
                const neScreen = [cellLeft + printGrid.width, cellTop];
                const swScreen = [cellLeft, cellTop + printGrid.height];

                const neGeo = map.unproject(neScreen);
                const swGeo = map.unproject(swScreen);

                // Renderizza lo stesso riquadro geografico in alta risoluzione:
                // cosi il foglio corrisponde alla cella scelta senza ingrandire pixel a schermo.
                const renderedImage = await renderizzaRiquadroAltaRisoluzione(swGeo, neGeo, printGrid.width, printGrid.height);
                sheetScreenshots.push({
                    index: r * printGrid.cols + c + 1,
                    dataUrl: renderedImage.dataUrl,
                    pixelWidth: renderedImage.width,
                    pixelHeight: renderedImage.height,
                    bounds: { sw: swGeo, ne: neGeo }
                });
            }
        }

        // Generazione e visualizzazione delle pagine A4 pronte
        renderPrintA4Pages(sheetScreenshots);
        showToast("Anteprime di stampa pronte.", "success");
    } catch (err) {
        console.error('Errore durante la generazione delle anteprime di stampa:', err);
        showToast("Impossibile generare le anteprime di stampa.", "error");
    } finally {
        if (gridEl && !wasGridHidden && printPlanningMode) {
            gridEl.classList.remove('hidden');
        }

        setPulsanteGenerazioneOccupato(false);
        generazioneAnteprimaStampaInCorso = false;
    }
}

export function renderPrintA4Pages(screenshots) {
    const previewWrapper = document.getElementById('print-pages-wrapper');
    const printProductionContainer = document.getElementById('print-output-container');

    previewWrapper.innerHTML = '';
    printProductionContainer.innerHTML = '';

    const isPortrait = printGrid.orientation === 'portrait';
    const sizeClass = isPortrait ? 'print-a4-page-portrait' : 'print-a4-page-landscape';

    const activeTrack = tracks.find(t => t.id === activeTrackId) || tracks[0];
    const trackName = escapeHtml(activeTrack?.name || 'Mappa GPX');

    screenshots.forEach(sheet => {
        // Template HTML comune per ciascun foglio A4
        const pageHtml = `
          <div class="print-page print-a4-page ${sizeClass} bg-white shadow-2xl rounded-sm p-8 text-black border border-stone-300 flex flex-col justify-between">
            <div class="print-page-header border-b-2 border-stone-900 pb-2 mb-3 flex justify-between items-start gap-4">
              <div class="min-w-0">
                <h1 class="text-lg font-black uppercase tracking-tight" contenteditable="true">${trackName}</h1>
                <span class="text-[9px] text-stone-500 font-mono">Coordinate SW: ${sheet.bounds.sw.lat.toFixed(4)}, ${sheet.bounds.sw.lng.toFixed(4)}</span>
              </div>
              <div class="print-page-header-meta text-right shrink-0">
                <span class="text-[10px] font-bold uppercase bg-stone-950 text-white px-2 py-0.5 rounded">FOGLIO ${sheet.index} DI ${screenshots.length}</span>
                <p class="text-[8px] text-stone-500 font-mono mt-0.5">${new Date().toLocaleDateString('it-IT')}</p>
              </div>
            </div>

            <!-- Mappa Cartografica dello Screenshot -->
            <div class="print-map-frame flex-1 border border-stone-300 rounded-lg overflow-hidden bg-stone-50 relative mb-3">
              <img src="${sheet.dataUrl}" width="${sheet.pixelWidth}" height="${sheet.pixelHeight}" class="w-full h-full object-contain">
              <div class="print-coordinate-grid absolute inset-0 pointer-events-none">
                ${generaLineeGriglia(sheet)}
              </div>
              <span class="print-scale-label absolute bottom-1 right-1 bg-white/95 text-stone-800 text-[8px] font-bold px-1 py-0.5 rounded border border-stone-200">
                Scala dinamica locale ~ 1:25.000
              </span>
            </div>

            <!-- Footer con spazio note pieghevole -->
            <div class="flex justify-between items-end border-t border-stone-200 pt-2 text-[8px] text-stone-500 font-mono">
              <div>
                Note: <span contenteditable="true" class="italic hover:bg-stone-50 p-1 rounded">Inserisci qui note fisiche sul percorso...</span>
              </div>
              <div>
                Progettato tramite GeoViewer Pro Print Engine
              </div>
            </div>
          </div>
        `;

        // Inserisci nell'anteprima schermo
        const previewElement = document.createElement('div');
        previewElement.innerHTML = pageHtml;
        previewWrapper.appendChild(previewElement.firstElementChild);
    });

    previewWrapper.oninput = syncPrintOutputFromPreview;
    syncPrintOutputFromPreview();

    // Apriamo il modale di anteprima
    document.getElementById('print-preview-modal').classList.remove('hidden');
}

export function syncPrintOutputFromPreview() {
    const previewWrapper = document.getElementById('print-pages-wrapper');
    const printProductionContainer = document.getElementById('print-output-container');
    if (!previewWrapper || !printProductionContainer) return;

    printProductionContainer.innerHTML = '';
    previewWrapper.querySelectorAll('.print-page').forEach(page => {
        const clone = page.cloneNode(true);
        clone.querySelectorAll('[contenteditable]').forEach(el => {
            el.removeAttribute('contenteditable');
        });
        printProductionContainer.appendChild(clone);
    });
}
