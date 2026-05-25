// gpx.js — importGPX (Web Worker), exportGPX, simplifyDouglasPeucker
//
// IMPORT GPX: il parsing avviene in un Worker (src/js/workers/gpx-parser.worker.js)
// per evitare di bloccare il main thread su file enormi. Se il Worker non è
// disponibile (es. apertura via file://) si ricade sul parsing inline a chunk.

import { tracks, map, setActiveSegmentId } from './state.js';
import { createNewTrack, showToast } from './ui.js';
import { saveHistoryState } from './tracks.js';
import { updateMapData } from './map.js';
import { escapeXml } from './utils.js';

// Singleton del worker: lo creiamo lazy e lo riutilizziamo
let _gpxWorker = null;
let _workerUnavailable = false;

function getWorker() {
    if (_workerUnavailable) return null;
    if (_gpxWorker) return _gpxWorker;
    try {
        // Path relativo al modulo: import.meta.url assicura risoluzione corretta
        _gpxWorker = new Worker(
            new URL('./workers/gpx-parser.worker.js', import.meta.url),
            { type: 'classic' }
        );
        return _gpxWorker;
    } catch (err) {
        console.warn('Web Worker non disponibile, parsing inline:', err);
        _workerUnavailable = true;
        return null;
    }
}

// Cede il controllo al browser per un frame — evita il freeze del main thread (fallback)
function yieldToMain() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

export async function importGPX(xmlText, fileName) {
    showToast("Importazione in corso...", "info");

    try {
        const result = await parseInWorker(xmlText, fileName)
            .catch(() => parseInline(xmlText, fileName));

        if (!result) {
            showToast("Errore durante il parsing del file GPX", "error");
            return;
        }

        // Costruisci il nuovo track con i dati pre-parsati
        const newTrack = createNewTrack(fileName.replace('.gpx', ''));
        newTrack.localSource = 'imported';
        newTrack.segments = result.segments.length > 0 ? result.segments : [{
            id: 'seg_' + Date.now() + '_import',
            name: 'Tracciato 1',
            points: [],
            visible: true
        }];
        newTrack.visible = true;
        newTrack.waypointsVisible = true;
        setActiveSegmentId(newTrack.segments[0].id);
        // I waypoint vengono aggiunti a quelli esistenti del nuovo track (se presenti)
        for (let i = 0; i < result.waypoints.length; i++) {
            newTrack.waypoints.push(result.waypoints[i]);
        }

        if (result.firstPoint) {
            map.flyTo({ center: [result.firstPoint.lon, result.firstPoint.lat], zoom: 11 });
        }

        saveHistoryState();
        updateMapData(true);

        const total = result.totalPoints || 0;
        const ptsLabel = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : total;
        showToast(`GPX importato: ${result.segments.length} segmenti, ${ptsLabel} punti`, "success");
    } catch (err) {
        console.error(err);
        showToast("Errore durante il parsing del file GPX", "error");
    }
}

// Parsing nel Worker (preferito) — non blocca l'UI
function parseInWorker(xmlText, fileName) {
    return new Promise((resolve, reject) => {
        const w = getWorker();
        if (!w) return reject(new Error('no-worker'));

        const onMessage = (e) => {
            // Messaggi di progresso: ignorali (potresti collegarci una progress bar)
            if (e.data && e.data.progress) return;
            w.removeEventListener('message', onMessage);
            w.removeEventListener('error', onError);
            if (e.data && e.data.ok) {
                resolve(e.data.result);
            } else {
                reject(new Error(e.data && e.data.error ? e.data.error : 'parse-failed'));
            }
        };
        const onError = (e) => {
            w.removeEventListener('message', onMessage);
            w.removeEventListener('error', onError);
            reject(e);
        };

        w.addEventListener('message', onMessage);
        w.addEventListener('error', onError);
        w.postMessage({ xmlText, fileName });
    });
}

// Parsing inline — fallback se il Worker non è disponibile.
// Usa yield() ogni CHUNK punti per non bloccare l'UI.
async function parseInline(xmlText, fileName) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, "text/xml");

    const segments = [];
    const waypoints = [];
    let firstPoint = null;
    let totalPoints = 0;
    const baseId = Date.now();

    const trkNodes = xmlDoc.getElementsByTagName("trk");
    for (let i = 0; i < trkNodes.length; i++) {
        const trkNode = trkNodes[i];
        const nameNode = trkNode.getElementsByTagName("name")[0];
        const segNodes = trkNode.getElementsByTagName("trkseg");
        const trkName = nameNode ? nameNode.textContent : `Tracciato ${i + 1}`;

        for (let j = 0; j < segNodes.length; j++) {
            const segNode = segNodes[j];
            const ptNodes = segNode.getElementsByTagName("trkpt");
            const n = ptNodes.length;
            const parsedPoints = new Array(n);

            const CHUNK = 5000;
            for (let k = 0; k < n; k++) {
                const pt = ptNodes[k];
                const lat = parseFloat(pt.getAttribute("lat"));
                const lon = parseFloat(pt.getAttribute("lon"));
                const eleNode = pt.getElementsByTagName("ele")[0];
                const ele = eleNode ? parseFloat(eleNode.textContent) : 0;
                parsedPoints[k] = { lat, lon, ele, isUserClicked: false };
                if (firstPoint === null) firstPoint = { lat, lon };

                if (k > 0 && k % CHUNK === 0) await yieldToMain();
            }
            totalPoints += n;

            segments.push({
                id: 'seg_' + baseId + `_${i}_${j}`,
                name: `${trkName} (Seg ${j + 1})`,
                points: parsedPoints,
                visible: true
            });
            await yieldToMain();
        }
    }

    const wptNodes = xmlDoc.getElementsByTagName("wpt");
    for (let i = 0; i < wptNodes.length; i++) {
        const wptNode = wptNodes[i];
        waypoints.push({
            id: 'wp_imp_' + baseId + `_${i}`,
            name: wptNode.getElementsByTagName("name")[0]?.textContent || `Imported WP ${i + 1}`,
            desc: wptNode.getElementsByTagName("desc")[0]?.textContent || '',
            symbol: '📍',
            lat: parseFloat(wptNode.getAttribute("lat")),
            lon: parseFloat(wptNode.getAttribute("lon")),
            ele: wptNode.getElementsByTagName("ele")[0]
                ? parseFloat(wptNode.getElementsByTagName("ele")[0].textContent) : 0,
            visible: true
        });
    }

    return { fileName, segments, waypoints, firstPoint, totalPoints };
}

// ─── Export GPX ──────────────────────────────────────────────────────────────

export function exportGPX() {
    if (tracks.length === 0) {
        showToast("Nessun dato GIS da esportare", "error");
        return;
    }

    // Build con array di stringhe + join: molto più veloce di concatenazione su 100k+ punti
    const parts = [];
    parts.push(`<?xml version="1.0" encoding="UTF-8"?>\n`);
    parts.push(`<gpx version="1.1" creator="GeoViewer3D" xmlns="http://www.topografix.com/GPX/1/1">\n`);

    tracks.forEach(track => {
        track.waypoints.forEach(wp => {
            parts.push(`  <wpt lat="${wp.lat.toFixed(6)}" lon="${wp.lon.toFixed(6)}">\n`);
            parts.push(`    <ele>${wp.ele}</ele>\n`);
            parts.push(`    <name>${escapeXml(wp.name)}</name>\n`);
            parts.push(`    <desc>${escapeXml(wp.desc)}</desc>\n`);
            parts.push(`  </wpt>\n`);
        });
    });

    tracks.forEach(track => {
        parts.push(`  <trk>\n`);
        parts.push(`    <name>${escapeXml(track.name)}</name>\n`);
        parts.push(`    <desc>${escapeXml(track.desc)}</desc>\n`);

        track.segments.forEach(seg => {
            parts.push(`    <trkseg>\n`);

            // Sull'export usiamo la versione iterativa (non ricorsiva): la versione
            // ricorsiva esplode lo stack su tracce con decine di migliaia di punti.
            const exportPoints = seg.points.length > 150
                ? simplifyDouglasPeucker(seg.points, 0.00005)
                : seg.points;

            for (let i = 0; i < exportPoints.length; i++) {
                const pt = exportPoints[i];
                parts.push(`      <trkpt lat="${pt.lat.toFixed(6)}" lon="${pt.lon.toFixed(6)}">\n`);
                if (pt.ele) parts.push(`        <ele>${pt.ele}</ele>\n`);
                parts.push(`      </trkpt>\n`);
            }

            parts.push(`    </trkseg>\n`);
        });
        parts.push(`  </trk>\n`);
    });

    parts.push(`</gpx>`);

    const blob = new Blob(parts, { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${tracks[0]?.name || 'geoviewer_export'}.gpx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast("GPX esportato correttamente con minificazione!", "success");
}

// Douglas-Peucker ITERATIVO (sostituisce la versione ricorsiva che faceva
// stack-overflow su tracce con 50k+ punti). Stessa firma per compatibilità.
export function simplifyDouglasPeucker(points, tolerance) {
    const n = points.length;
    if (n <= 2) return points;
    const tol2 = tolerance * tolerance;
    const keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
        const [start, end] = stack.pop();
        const x1 = points[start].lon, y1 = points[start].lat;
        const x2 = points[end].lon,   y2 = points[end].lat;
        const dx = x2 - x1, dy = y2 - y1;
        const lenSq = dx * dx + dy * dy;
        let dmax = 0, index = start;
        for (let i = start + 1; i < end; i++) {
            const px = points[i].lon - x1, py = points[i].lat - y1;
            let d;
            if (lenSq === 0) {
                d = px * px + py * py;
            } else {
                const t = Math.max(0, Math.min(1, (px * dx + py * dy) / lenSq));
                const ex = px - t * dx, ey = py - t * dy;
                d = ex * ex + ey * ey;
            }
            if (d > dmax) { dmax = d; index = i; }
        }
        if (dmax > tol2) {
            keep[index] = 1;
            if (index - start > 1) stack.push([start, index]);
            if (end - index > 1)   stack.push([index, end]);
        }
    }
    const result = [];
    for (let i = 0; i < n; i++) if (keep[i]) result.push(points[i]);
    return result;
}
