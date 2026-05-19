// print.js — togglePrintPlanning, disablePrintPlanning, generateHighResPrintPreview,
//            renderPrintA4Pages, updatePrintGridDimensions, setupPrintDragEvents,
//            updatePrintGridLayout, updatePrintGridScale, setPrintPlanningOrientation

import {
    map, mapLoaded,
    tracks, activeTrackId,
    printPlanningMode, setPrintPlanningMode,
    printGrid, updatePrintGridProp
} from './state.js';

import { showToast } from './ui.js';

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
    } else {
        disablePrintPlanning();
    }
}

export function disablePrintPlanning() {
    setPrintPlanningMode(false);
    document.getElementById('print-drag-grid').classList.add('hidden');
    document.getElementById('panel-print-setup').classList.add('hidden');
}

export function updatePrintGridDimensions() {
    const isPortrait = printGrid.orientation === 'portrait';
    updatePrintGridProp('width', (isPortrait ? 180 : 254) * printGrid.scale);
    updatePrintGridProp('height', (isPortrait ? 254 : 180) * printGrid.scale);

    const gridEl = document.getElementById('print-drag-grid');

    const totalW = printGrid.cols * printGrid.width;
    const totalH = printGrid.rows * printGrid.height;

    gridEl.style.width = `${totalW}px`;
    gridEl.style.height = `${totalH}px`;
    gridEl.style.left = `${printGrid.x - totalW / 2}px`;
    gridEl.style.top = `${printGrid.y - totalH / 2}px`;

    // Genera i singoli quadranti tratteggiati per l'anteprima
    gridEl.innerHTML = '';
    for (let r = 0; r < printGrid.rows; r++) {
        for (let c = 0; c < printGrid.cols; c++) {
            const index = r * printGrid.cols + c + 1;
            const cell = document.createElement('div');
            cell.className = 'border border-dashed border-blue-400 relative flex items-center justify-center text-[10px] font-bold text-blue-400/80 bg-blue-500/5';
            cell.style.width = `${printGrid.width}px`;
            cell.style.height = `${printGrid.height}px`;
            cell.innerHTML = `
                <span class="absolute top-2 left-2 bg-blue-600 text-white text-[9px] font-extrabold px-1.5 py-0.5 rounded">FOGLIO ${index}</span>
                <span class="pointer-events-none opacity-45 select-none">Area di taglio sormonto (A4)</span>
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

        let newX = clientX - printGrid.dragOffsetX;
        let newY = clientY - printGrid.dragOffsetY;

        // Limita l'uscita dai bordi
        const mapEl = document.getElementById('map');
        newX = Math.max(50, Math.min(mapEl.clientWidth - 50, newX));
        newY = Math.max(50, Math.min(mapEl.clientHeight - 50, newY));

        updatePrintGridProp('x', newX);
        updatePrintGridProp('y', newY);

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
    if (!mapLoaded) return;

    showToast("Cattura in corso dei quadranti cartografici...", "info");

    // Calcola le coordinate geografiche di ciascun foglio
    const totalW = printGrid.cols * printGrid.width;
    const totalH = printGrid.rows * printGrid.height;
    const startX = printGrid.x - totalW / 2;
    const startY = printGrid.y - totalH / 2;

    // Salviamo lo stato della telecamera corrente della mappa per poterlo ripristinare
    const originalCenter = map.getCenter();
    const originalZoom = map.getZoom();
    const originalPitch = map.getPitch();
    const originalBearing = map.getBearing();

    const sheetScreenshots = [];

    // Nascondiamo temporaneamente gli elementi grafici dell'editor per lo scatto
    document.getElementById('print-drag-grid').classList.add('hidden');

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

            // Spostiamo la mappa per centrarla su questo specifico riquadro di stampa
            map.fitBounds([swGeo.toArray(), neGeo.toArray()], { animate: false, padding: 0 });

            // Attendiamo che MapLibre abbia finito di caricare tutti i tasselli (evento idle)
            // Fallback a setTimeout se idle non si triggera entro 3s
            await new Promise(resolve => {
                const timeout = setTimeout(resolve, 3000);
                map.once('idle', () => { clearTimeout(timeout); resolve(); });
            });

            // Catturiamo lo screenshot del canvas di MapLibre
            const imgData = map.getCanvas().toDataURL('image/jpeg', 0.9);
            sheetScreenshots.push({
                index: r * printGrid.cols + c + 1,
                dataUrl: imgData,
                bounds: { sw: swGeo, ne: neGeo }
            });
        }
    }

    // Ripristiniamo la telecamera originale dell'utente
    map.jumpTo({
        center: originalCenter,
        zoom: originalZoom,
        pitch: originalPitch,
        bearing: originalBearing
    });

    // Rendi nuovamente visibile la griglia di pianificazione
    document.getElementById('print-drag-grid').classList.remove('hidden');

    // Generazione e visualizzazione delle pagine A4 pronte
    renderPrintA4Pages(sheetScreenshots);
}

export function renderPrintA4Pages(screenshots) {
    const previewWrapper = document.getElementById('print-pages-wrapper');
    const printProductionContainer = document.getElementById('print-output-container');

    previewWrapper.innerHTML = '';
    printProductionContainer.innerHTML = '';

    const isPortrait = printGrid.orientation === 'portrait';
    const sizeClass = isPortrait ? 'print-a4-page-portrait' : 'print-a4-page-landscape';

    const activeTrack = tracks.find(t => t.id === activeTrackId) || tracks[0];
    const statsDist = document.getElementById('stat-dist').innerText;
    const statsAsc = document.getElementById('stat-ascent').innerText;
    const statsDes = document.getElementById('stat-descent').innerText;
    const statsMax = document.getElementById('stat-max-alt').innerText;

    screenshots.forEach(sheet => {
        // Template HTML comune per ciascun foglio A4
        const pageHtml = `
          <div class="print-page print-a4-page ${sizeClass} bg-white shadow-2xl rounded-sm p-8 text-black border border-stone-300 flex flex-col justify-between">
            <div class="border-b-2 border-stone-900 pb-2 mb-3 flex justify-between items-center">
              <div>
                <h1 class="text-lg font-black uppercase tracking-tight" contenteditable="true">${activeTrack.name}</h1>
                <span class="text-[9px] text-stone-500 font-mono">Coordinate SW: ${sheet.bounds.sw.lat.toFixed(4)}, ${sheet.bounds.sw.lng.toFixed(4)}</span>
              </div>
              <div class="text-right">
                <span class="text-[10px] font-bold uppercase bg-stone-950 text-white px-2 py-0.5 rounded">FOGLIO ${sheet.index} DI ${screenshots.length}</span>
                <p class="text-[8px] text-stone-400 font-mono mt-0.5">${new Date().toLocaleDateString('it-IT')}</p>
              </div>
            </div>

            <!-- Mappa Cartografica dello Screenshot -->
            <div class="print-map-frame flex-1 border border-stone-300 rounded-lg overflow-hidden bg-stone-50 relative mb-3">
              <img src="${sheet.dataUrl}" class="w-full h-full object-cover">
              <span class="absolute bottom-1 right-1 bg-white/95 text-stone-800 text-[8px] font-bold px-1 py-0.5 rounded border border-stone-200">
                Scala dinamica locale ~ 1:25.000
              </span>
            </div>

            <!-- Tabella Riepilogo Statistiche -->
            <div class="grid grid-cols-4 gap-2 bg-stone-50 p-2.5 rounded-lg border border-stone-200 text-center mb-3">
              <div>
                <span class="text-[8px] text-stone-500 block uppercase font-bold">Distanza</span>
                <span class="text-xs font-bold text-stone-900">${statsDist}</span>
              </div>
              <div>
                <span class="text-[8px] text-stone-500 block uppercase font-bold">Dislivello +</span>
                <span class="text-xs font-bold text-green-600">${statsAsc}</span>
              </div>
              <div>
                <span class="text-[8px] text-stone-500 block uppercase font-bold">Dislivello -</span>
                <span class="text-xs font-bold text-red-600">${statsDes}</span>
              </div>
              <div>
                <span class="text-[8px] text-stone-500 block uppercase font-bold">Quota Max</span>
                <span class="text-xs font-bold text-blue-600">${statsMax}</span>
              </div>
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

        // Inserisci nel contenitore nascosto per l'invio alla stampante fisica
        const printElement = document.createElement('div');
        printElement.innerHTML = pageHtml;
        printProductionContainer.appendChild(printElement.firstElementChild);
    });

    // Apriamo il modale di anteprima
    document.getElementById('print-preview-modal').classList.remove('hidden');
}
