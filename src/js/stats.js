// stats.js — initChart, updateStatsAndProfile, calcoli Haversine
// NOTA: i loop Haversine usano matematica raw senza allocazione oggetti — non refactorare!
//
// FLUIDITÀ: questo modulo era una causa primaria di freeze su file enormi.
// Cambiamenti:
//   1. Il calcolo è skippato se il pannello stats è chiuso
//   2. Il polygon Turf (devastante su 100k+ punti) viene sostituito da una
//      bounding-box area-approx: O(1) extra rispetto al loop principale
//   3. Tutto il lavoro viene eseguito in un requestIdleCallback per non
//      competere con il rendering della mappa durante pan/zoom

import { chart, setChart, tracks } from './state.js';

export function initChart() {
    const ctx = document.getElementById('altitudeChart').getContext('2d');
    const newChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Quota (m)',
                data: [],
                borderColor: '#3b82f6',
                backgroundColor: 'rgba(59, 130, 246, 0.1)',
                borderWidth: 2,
                fill: true,
                pointRadius: 0,
                pointHoverRadius: 5,
                tension: 0.1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,           // animazioni disabilitate per dataset grandi
            parsing: false,             // Chart.js skip parsing — i dati arrivano già in formato {x,y}
            normalized: true,           // i dati sono ordinati: skip ulteriori ordinamenti interni
            plugins: { legend: { display: false } },
            scales: {
                x: { grid: { display: false }, ticks: { color: '#6b7280', font: { size: 9 } } },
                y: { grid: { color: '#374151' }, ticks: { color: '#6b7280', font: { size: 9 } } }
            }
        }
    });
    setChart(newChart);
}

// Verifica se il pannello statistiche è effettivamente visibile sullo schermo.
// Se è chiuso (translate-y-60), non ha senso ricalcolare nulla.
function isStatsPanelVisible() {
    const panel = document.getElementById('panel-bottom-stats');
    if (!panel) return false;
    return !panel.classList.contains('translate-y-60');
}

// Debounce + idle: il calcolo non blocca pan/zoom della mappa
let _statsTimer = null;
let _statsIdleHandle = null;

export function updateStatsAndProfile() {
    clearTimeout(_statsTimer);
    _statsTimer = setTimeout(() => {
        if (_statsIdleHandle !== null) {
            if (window.cancelIdleCallback) window.cancelIdleCallback(_statsIdleHandle);
        }
        // Esegui in idle: solo quando il browser non sta facendo altro
        if (window.requestIdleCallback) {
            _statsIdleHandle = window.requestIdleCallback(_doUpdateStats, { timeout: 1000 });
        } else {
            _doUpdateStats();
        }
    }, 150);
}

// Forza l'esecuzione immediata (es. quando l'utente apre il pannello)
export function forceUpdateStats() {
    clearTimeout(_statsTimer);
    if (_statsIdleHandle !== null && window.cancelIdleCallback) {
        window.cancelIdleCallback(_statsIdleHandle);
    }
    _doUpdateStats();
}

function _doUpdateStats() {
    // Skip totale se il pannello è chiuso — risparmio enorme su file grandi
    if (!isStatsPanelVisible()) return;

    let totalDistance = 0;
    let totalAscent   = 0;
    let totalDescent  = 0;
    let maxElevation  = -Infinity;
    let maxSlope      = 0;
    let totalSegments = 0;
    let totalPoints   = 0;

    // Bounding box per area approssimata (sostituisce turf.polygon che esplode su tracce enormi)
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;

    // Profilo altimetrico campionato in-loop (no array intermedio gigante)
    const MAX_CHART_PTS = 500;
    const chartXs = [];
    const chartYs = [];
    let cumulativeDist = 0;
    let prevPt = null;
    let pointIndex = 0;

    // ── Conteggio rapido punti totali per il sampling step ────────────────────
    let pointsTotalEstimate = 0;
    for (let ti = 0; ti < tracks.length; ti++) {
        const t = tracks[ti];
        if (t.visible === false) continue;
        for (let si = 0; si < t.segments.length; si++) {
            const s = t.segments[si];
            if (s.visible === false) continue;
            pointsTotalEstimate += s.points.length;
        }
    }
    // Step di sampling per il grafico — 1 ogni N punti
    const chartStep = pointsTotalEstimate > MAX_CHART_PTS
        ? Math.ceil(pointsTotalEstimate / MAX_CHART_PTS)
        : 1;

    // ── Loop singolo: distanza, ascesa, discesa, quota max, pendenza max, chart ──
    for (let ti = 0; ti < tracks.length; ti++) {
        const track = tracks[ti];
        if (track.visible === false) continue;
        const segs = track.segments;
        for (let si = 0; si < segs.length; si++) {
            const seg = segs[si];
            if (seg.visible === false) continue;
            totalSegments++;
            prevPt = null;

            const pts = seg.points;
            const n = pts.length;
            for (let i = 0; i < n; i++) {
                const pt = pts[i];
                totalPoints++;

                // Bounding box
                if (pt.lat < minLat) minLat = pt.lat;
                if (pt.lat > maxLat) maxLat = pt.lat;
                if (pt.lon < minLon) minLon = pt.lon;
                if (pt.lon > maxLon) maxLon = pt.lon;

                if (prevPt !== null) {
                    const d = haversineDistance(prevPt.lon, prevPt.lat, pt.lon, pt.lat);
                    totalDistance  += d;
                    cumulativeDist += d;

                    const deltaH = pt.ele - prevPt.ele;
                    if (deltaH > 0) totalAscent  += deltaH;
                    else            totalDescent  += -deltaH;

                    // Pendenza: ignora passi troppo corti (rumore GPS)
                    const distM = d * 1000;
                    if (distM > 15) {
                        const slope = (Math.abs(deltaH) / distM) * 100;
                        if (slope > maxSlope) maxSlope = slope;
                    }
                }

                if (pt.ele > maxElevation) maxElevation = pt.ele;

                // Sampling inline per il chart — niente array intermedio
                if (pointIndex % chartStep === 0) {
                    chartXs.push(cumulativeDist);
                    chartYs.push(pt.ele);
                }
                pointIndex++;
                prevPt = pt;
            }
        }
    }

    // ── Area approssimata via bounding box (km² → ha) ────────────────────────
    // Approssimazione: area del bbox sferico. Per tracce questo è solo indicativo
    // ma non blocca il main thread.
    let areaHa = 0;
    if (totalPoints > 3 && minLat !== Infinity) {
        const meanLat = (minLat + maxLat) / 2;
        const heightKm = (maxLat - minLat) * 111.32;
        const widthKm  = (maxLon - minLon) * 111.32 * Math.cos(meanLat * Math.PI / 180);
        const areaKm2 = Math.abs(heightKm * widthKm);
        areaHa = (areaKm2 * 100).toFixed(1);
    }

    // ── Aggiorna DOM statistiche ─────────────────────────────────────────────
    const $ = (id) => document.getElementById(id);
    $('stat-dist').innerText        = totalDistance.toFixed(2) + ' km';
    $('stat-ascent').innerText      = `+${Math.round(totalAscent)} m`;
    $('stat-descent').innerText     = `-${Math.round(totalDescent)} m`;
    $('stat-max-alt').innerText     = maxElevation === -Infinity ? '0 m' : `${Math.round(maxElevation)} m`;
    $('stat-area').innerText        = `${areaHa} ha`;
    $('stat-segments-count').innerText = totalSegments;
    $('stat-avg-slope').innerText   = totalDistance > 0
        ? `${((totalAscent / (totalDistance * 1000)) * 100).toFixed(1)}%`
        : '0%';
    $('stat-max-slope').innerText   = `${maxSlope.toFixed(1)}%`;

    // ── Aggiorna il grafico altimetrico ──────────────────────────────────────
    const currentChart = chart;
    if (currentChart && chartXs.length > 0) {
        // Costruisci labels e data senza nuove map() — già pronti dal sampling
        const labels = new Array(chartXs.length);
        for (let i = 0; i < chartXs.length; i++) labels[i] = chartXs[i].toFixed(2) + ' km';
        currentChart.data.labels = labels;
        currentChart.data.datasets[0].data = chartYs;
        currentChart.update('none');
    }
}

// Haversine raw — non refactorare, critico per performance
export function haversineDistance(lon1, lat1, lon2, lat2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}
