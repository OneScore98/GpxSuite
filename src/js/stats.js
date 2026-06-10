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

import { chart, setChart, tracks, activeTrackId } from './state.js';
import { loadScriptOnce } from './utils.js';

const CHART_JS_URL = 'https://cdn.jsdelivr.net/npm/chart.js';
let _chartLoadPromise = null;
let _statsControlsBound = false;
let _chartPluginRegistered = false;

// Crosshair: pixel X del mouse sul canvas chart
let _chartCrosshairPx = null;
let _chartCrosshairRaf = null;

// Modalità colorazione traccia: null | 'altitude' | 'speed' | 'slope' | 'tilt' | 'pitch' | 'vibration'
let _trackColorMode = null;
export function getTrackColorMode() { return _trackColorMode; }

const CHART_METRICS = {
    altitude: {
        label: 'Altitudine (m)',
        color: '#38bdf8',
        unit: 'm',
        tick: value => `${Math.round(Number(value))} m`,
        spanGaps: true
    },
    speed: {
        label: 'Velocità (km/h)',
        color: '#f59e0b',
        unit: 'km/h',
        tick: value => `${Number(value).toFixed(1)} km/h`,
        spanGaps: false
    },
    slope: {
        label: 'Pendenza (%)',
        color: '#ef4444',
        unit: '%',
        tick: value => `${Number(value).toFixed(1)}%`,
        spanGaps: false
    },
    tilt: {
        label: 'Inclinazione (°)',
        color: '#a78bfa',
        unit: '°',
        tick: value => `${Number(value).toFixed(1)}°`,
        spanGaps: false
    },
    vibration: {
        label: 'Vibrazioni (liv.)',
        color: '#f87171',
        unit: '',
        tick: value => `${Math.round(Number(value))}`,
        spanGaps: false
    }
};

const SURFACE_STYLES = {
    paved: {
        label: 'Asfalto',
        fill: 'rgba(14, 165, 233, 0.13)'
    },
    offroad: {
        label: 'Offroad',
        fill: 'rgba(245, 158, 11, 0.18)'
    },
    unknown: {
        label: 'N/D',
        fill: 'rgba(100, 116, 139, 0.10)'
    }
};

let _chartMetric = 'altitude';
let _chartXAxis = 'distance';

// Lookup geografico per il marker di hover sul grafico: {x, lat, lon}[]
let _chartPointsGeo = [];

// Plugin Chart.js: crosshair verticale tratteggiato alla posizione del mouse
const crosshairPlugin = {
    id: 'gpxsuiteCrosshair',
    afterDraw(chartInstance) {
        const px = _chartCrosshairPx;
        if (!Number.isFinite(px)) return;
        const { ctx, chartArea } = chartInstance;
        if (!ctx || !chartArea || px < chartArea.left || px > chartArea.right) return;
        ctx.save();
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255,255,255,0.4)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.moveTo(px, chartArea.top);
        ctx.lineTo(px, chartArea.bottom);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
    }
};

const surfaceBandsPlugin = {
    id: 'gpxsuiteSurfaceBands',
    beforeDatasetsDraw(chartInstance) {
        const bands = chartInstance.$surfaceBands;
        if (!bands || bands.length === 0) return;

        const { ctx, chartArea, scales } = chartInstance;
        const xScale = scales?.x;
        if (!ctx || !chartArea || !xScale) return;

        ctx.save();
        for (let i = 0; i < bands.length; i++) {
            const band = bands[i];
            const style = SURFACE_STYLES[band.surface] || SURFACE_STYLES.unknown;
            const x1 = xScale.getPixelForValue(band.start);
            const x2 = xScale.getPixelForValue(band.end);
            if (!Number.isFinite(x1) || !Number.isFinite(x2)) continue;
            const left = Math.max(chartArea.left, Math.min(x1, x2));
            const right = Math.min(chartArea.right, Math.max(x1, x2));
            const width = right - left;
            if (width <= 0) continue;
            ctx.fillStyle = style.fill;
            ctx.fillRect(left, chartArea.top, Math.max(1, width), chartArea.bottom - chartArea.top);
        }
        ctx.restore();
    }
};

// ── Hover chart → marker sulla traccia ───────────────────────────────────
function _getActiveTrackColor() {
    if (activeTrackId) {
        const t = tracks.find(t => t.id === activeTrackId);
        if (t?.color) return t.color;
    }
    for (const t of tracks) {
        if (t.visible !== false && t.color) return t.color;
    }
    return '#3b82f6';
}

function _findNearestGeoPoint(xValue) {
    const pts = _chartPointsGeo;
    if (!pts.length) return null;
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (pts[mid].x < xValue) lo = mid + 1;
        else hi = mid;
    }
    if (lo > 0 && Math.abs(pts[lo - 1].x - xValue) < Math.abs(pts[lo].x - xValue)) lo--;
    return pts[lo];
}

function _dispatchChartHover(geo) {
    if (!geo) return;
    window.dispatchEvent(new CustomEvent('gpxsuite:chart-hover', {
        detail: { lat: geo.lat, lon: geo.lon, color: _getActiveTrackColor() }
    }));
}

function _dispatchChartHoverClear() {
    window.dispatchEvent(new CustomEvent('gpxsuite:chart-hover-clear'));
}
// ─────────────────────────────────────────────────────────────────────────

export function initChart() {
    bindStatsControls();
    return ensureChart();
}

function ensureChart() {
    if (chart) return Promise.resolve(chart);
    if (_chartLoadPromise) return _chartLoadPromise;

    _chartLoadPromise = loadScriptOnce(CHART_JS_URL, { id: 'chartjs-cdn' })
        .then(() => createChart())
        .catch(err => {
            _chartLoadPromise = null;
            console.error('Errore caricamento Chart.js:', err);
            return null;
        });

    return _chartLoadPromise;
}

function createChart() {
    if (chart) return chart;
    if (!window.Chart) throw new Error('Chart.js non disponibile');
    if (!_chartPluginRegistered) {
        window.Chart.register(surfaceBandsPlugin);
        window.Chart.register(crosshairPlugin);
        _chartPluginRegistered = true;
    }

    const ctx = document.getElementById('altitudeChart').getContext('2d');
    const metric = CHART_METRICS[_chartMetric];
    const newChart = new window.Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: metric.label,
                data: [],
                borderColor: metric.color,
                backgroundColor: 'transparent',
                borderWidth: 2,
                fill: false,
                pointRadius: 0,
                pointHoverRadius: 5,
                spanGaps: true,
                tension: 0.1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,           // animazioni disabilitate per dataset grandi
            parsing: false,             // Chart.js skip parsing — i dati arrivano già in formato {x,y}
            normalized: true,           // i dati sono ordinati: skip ulteriori ordinamenti interni
            onHover: (event, _elements, chartInstance) => {
                if (!event?.native) return;
                const rect = chartInstance.canvas.getBoundingClientRect();
                const xPx = event.native.clientX - rect.left;
                const { chartArea } = chartInstance;
                if (chartArea && xPx >= chartArea.left && xPx <= chartArea.right) {
                    _chartCrosshairPx = xPx;
                } else {
                    _chartCrosshairPx = null;
                }
                // Ridisegna con crosshair tramite RAF (al massimo un frame per movimento)
                if (!_chartCrosshairRaf) {
                    _chartCrosshairRaf = requestAnimationFrame(() => {
                        _chartCrosshairRaf = null;
                        chartInstance.draw();
                    });
                }
                // Dispatch hover marker sulla mappa
                if (!_chartPointsGeo.length) return;
                const xScale = chartInstance.scales?.x;
                if (!xScale) return;
                const xValue = xScale.getValueForPixel(xPx);
                if (!Number.isFinite(xValue)) return;
                _dispatchChartHover(_findNearestGeoPoint(xValue));
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: items => formatChartTooltipTitle(items?.[0]?.parsed?.x),
                        label: context => formatChartTooltipLabel(context.parsed?.y)
                    }
                }
            },
            scales: {
                x: {
                    type: 'linear',
                    grid: { display: false },
                    ticks: {
                        color: '#6b7280',
                        font: { size: 9 },
                        callback: value => formatXAxisTick(value)
                    }
                },
                y: {
                    grid: { color: '#374151' },
                    ticks: {
                        color: '#6b7280',
                        font: { size: 9 },
                        callback: value => formatYAxisTick(value)
                    }
                }
            }
        }
    });
    setChart(newChart);

    // Rimuovi crosshair e marker quando il mouse esce dal grafico
    ctx.canvas.addEventListener('mouseleave', () => {
        _chartCrosshairPx = null;
        newChart.draw();
        _dispatchChartHoverClear();
    });

    return newChart;
}

function bindStatsControls() {
    if (_statsControlsBound) return;
    _statsControlsBound = true;

    document.querySelectorAll('[data-stats-metric]').forEach(button => {
        button.addEventListener('click', () => {
            const metric = button.dataset.statsMetric;
            if (!CHART_METRICS[metric] || metric === _chartMetric) return;
            _chartMetric = metric;
            syncStatsControls();
            forceUpdateStats();
        });
    });

    document.querySelectorAll('[data-stats-x]').forEach(button => {
        button.addEventListener('click', () => {
            const axis = button.dataset.statsX;
            if (!['distance', 'time'].includes(axis) || axis === _chartXAxis) return;
            _chartXAxis = axis;
            syncStatsControls();
            forceUpdateStats();
        });
    });

    document.querySelectorAll('[data-stats-colorby]').forEach(button => {
        button.addEventListener('click', () => {
            const mode = button.dataset.statsColorby;
            const newMode = (mode === 'none' || mode === _trackColorMode) ? null : mode;
            _trackColorMode = newMode;
            syncColorControls();
            // Notifica map.js del cambio modalità colore
            window.dispatchEvent(new CustomEvent('gpxsuite:colormode-changed', {
                detail: { mode: _trackColorMode }
            }));
        });
    });

    syncStatsControls();
    syncColorControls();
}

function syncColorControls() {
    document.querySelectorAll('[data-stats-colorby]').forEach(button => {
        const mode = button.dataset.statsColorby;
        const isActive = (mode === 'none' && _trackColorMode === null) || mode === _trackColorMode;
        button.dataset.active = isActive ? 'true' : 'false';
    });
    // Mostra/nascondi legenda colore
    const legend = document.getElementById('stats-color-legend');
    if (legend) legend.style.display = _trackColorMode ? 'flex' : 'none';
}

function syncStatsControls() {
    document.querySelectorAll('[data-stats-metric]').forEach(button => {
        button.dataset.active = button.dataset.statsMetric === _chartMetric ? 'true' : 'false';
    });
    document.querySelectorAll('[data-stats-x]').forEach(button => {
        button.dataset.active = button.dataset.statsX === _chartXAxis ? 'true' : 'false';
    });
}

function formatXAxisTick(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '';
    return _chartXAxis === 'time' ? formatElapsedMinutes(numeric, true) : `${numeric.toFixed(2)} km`;
}

function formatYAxisTick(value) {
    const metric = CHART_METRICS[_chartMetric] || CHART_METRICS.altitude;
    return metric.tick(value);
}

function formatElapsedMinutes(value, compact = false) {
    const minutes = Math.max(0, Number(value) || 0);
    if (minutes < 60) return compact ? `${Math.round(minutes)}m` : `${Math.round(minutes)} min`;

    const hours = Math.floor(minutes / 60);
    const mins = Math.round(minutes % 60);
    if (compact) return `${hours}h${String(mins).padStart(2, '0')}`;
    return `${hours} h ${String(mins).padStart(2, '0')} min`;
}

function formatChartTooltipTitle(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '';
    return _chartXAxis === 'time'
        ? `Tempo: ${formatElapsedMinutes(numeric)}`
        : `Distanza: ${numeric.toFixed(2)} km`;
}

function formatChartTooltipLabel(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '';
    const metric = CHART_METRICS[_chartMetric] || CHART_METRICS.altitude;
    if (_chartMetric === 'altitude') return `${metric.label}: ${Math.round(numeric)} ${metric.unit}`;
    return `${metric.label}: ${numeric.toFixed(1)} ${metric.unit}`;
}

function readPointTimeMs(point) {
    const raw = point?.time;
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSurfaceValue(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return 'unknown';

    if (
        raw.includes('offroad') ||
        raw.includes('sterrato') ||
        raw.includes('non asfalt') ||
        raw.includes('unpaved') ||
        raw.includes('gravel') ||
        raw.includes('dirt') ||
        raw.includes('ground') ||
        raw.includes('track') ||
        raw.includes('trail') ||
        raw.includes('sand') ||
        raw.includes('grass')
    ) {
        return 'offroad';
    }

    if (
        raw.includes('asfalto') ||
        raw.includes('asphalt') ||
        raw.includes('paved') ||
        raw.includes('concrete') ||
        raw.includes('tarmac')
    ) {
        return 'paved';
    }

    return 'unknown';
}

function resolveSegmentSurface(track, segment) {
    return normalizeSurfaceValue(
        segment?.surface ||
        segment?.surfaceClass ||
        segment?.surfaceType ||
        track?.surface ||
        track?.surfaceClass ||
        track?.surfaceType ||
        track?.desc ||
        track?.name
    );
}

function resolveLegSurface(track, segment, fromPoint, toPoint, fallbackSurface) {
    return normalizeSurfaceValue(
        toPoint?.surfaceFromPrev ||
        toPoint?.surface ||
        fromPoint?.surfaceNext ||
        fromPoint?.surface ||
        fallbackSurface ||
        segment?.surface ||
        track?.surface
    );
}

function pushSurfaceBand(bands, surface, start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    const normalizedSurface = surface || 'unknown';
    const last = bands[bands.length - 1];
    if (last && last.surface === normalizedSurface && Math.abs(last.end - start) < 0.000001) {
        last.end = end;
        return;
    }
    bands.push({ surface: normalizedSurface, start, end });
}

// Scale Y di riferimento per metrica: evita che valori bassi occupino tutto il grafico.
// Usa suggestedMin/suggestedMax (morbidi) o min/max (duri) a seconda del tipo.
function computeYAxisBounds(metric, chartData) {
    const result = { min: undefined, max: undefined, suggestedMin: undefined, suggestedMax: undefined };
    let dataMin = Infinity, dataMax = -Infinity;
    for (let i = 0; i < chartData.length; i++) {
        const v = chartData[i]?.y;
        if (Number.isFinite(v)) {
            if (v < dataMin) dataMin = v;
            if (v > dataMax) dataMax = v;
        }
    }
    if (!Number.isFinite(dataMin)) return result;

    switch (metric) {
        case 'altitude': {
            // Auto-scala ma con range minimo 50 m e padding 12%
            const range = Math.max(50, dataMax - dataMin);
            const pad = range * 0.12;
            result.suggestedMin = Math.max(0, Math.floor(dataMin - pad));
            result.suggestedMax = Math.ceil(dataMax + pad);
            break;
        }
        case 'speed': {
            // Asse fisso dal basso a 0; ceiling contestuale in base alla velocità max reale
            result.min = 0;
            result.suggestedMax = dataMax <= 10 ? 30
                : dataMax <= 25 ? 50
                : dataMax <= 60 ? 90
                : dataMax <= 100 ? 130
                : 200;
            break;
        }
        case 'slope': {
            // Simmetrico intorno allo zero, almeno ±20%
            const ext = Math.max(20, Math.ceil(Math.max(Math.abs(dataMin), Math.abs(dataMax)) * 1.25));
            result.suggestedMin = -ext;
            result.suggestedMax = ext;
            break;
        }
        case 'tilt': {
            // Simmetrico, almeno ±30°
            const ext = Math.max(30, Math.ceil(Math.max(Math.abs(dataMin), Math.abs(dataMax)) * 1.25));
            result.suggestedMin = -ext;
            result.suggestedMax = ext;
            break;
        }
        case 'vibration':
            // Scala fissa 0-10 (la scala assoluta ha senso sempre)
            result.min = 0;
            result.max = 10;
            break;
    }
    return result;
}

function updateChartAppearance(currentChart) {
    const metric = CHART_METRICS[_chartMetric] || CHART_METRICS.altitude;
    const dataset = currentChart.data.datasets[0];
    dataset.label = metric.label;
    dataset.borderColor = metric.color;
    dataset.backgroundColor = 'transparent';
    dataset.fill = false;
    // spanGaps: true solo per altitudine (dati GPS possono avere buchi)
    // false per slope/speed/tilt/vibrazione per non collegare segmenti diversi
    dataset.spanGaps = metric.spanGaps !== false;
    currentChart.options.scales.x.ticks.callback = value => formatXAxisTick(value);
    currentChart.options.scales.y.ticks.callback = value => formatYAxisTick(value);
}

function formatSpeed(value) {
    return Number.isFinite(value) && value > 0 ? `${value.toFixed(1)} km/h` : '0.0 km/h';
}

function formatSurfaceSummary(surfaceKm) {
    const total = surfaceKm.paved + surfaceKm.offroad + surfaceKm.unknown;
    if (total <= 0) return 'N/D';

    const known = surfaceKm.paved + surfaceKm.offroad;
    if (known <= 0) return 'N/D';

    const dominant = surfaceKm.offroad >= surfaceKm.paved ? 'offroad' : 'paved';
    const percent = Math.round((surfaceKm[dominant] / total) * 100);
    return `${SURFACE_STYLES[dominant].label} ${percent}%`;
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
    bindStatsControls();
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
    bindStatsControls();
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
    let maxSpeed      = 0;
    let timedDistance = 0;
    let timedHours    = 0;
    let totalSegments = 0;
    let maxTilt       = 0;
    let maxVibration  = 0;
    let totalVibration = 0;
    let vibrationCount = 0;
    let hasTiltData    = false;
    let hasVibrationData = false;
    const surfaceKm = { paved: 0, offroad: 0, unknown: 0 };

    // Profilo campionato in-loop (no array intermedio gigante)
    const MAX_CHART_PTS = 500;
    const chartData = [];
    const surfaceBands = [];
    // Lookup geografico per hover marker: {x, lat, lon}[] — parallelo a chartData
    _chartPointsGeo = [];
    let cumulativeDist = 0;
    let prevPt = null;
    let prevTimeMs = null;
    let pointIndex = 0;
    let minTimeMs = Infinity;
    let maxTimeMs = -Infinity;
    // Flag: primo segmento assoluto (non inserire separatore prima)
    let isFirstSegment = true;

    // ── Conteggio rapido punti totali e range temporale per il sampling ───────
    let pointsTotalEstimate = 0;
    for (let ti = 0; ti < tracks.length; ti++) {
        const t = tracks[ti];
        if (activeTrackId && t.id !== activeTrackId) continue;
        if (t.visible === false) continue;
        for (let si = 0; si < t.segments.length; si++) {
            const s = t.segments[si];
            if (s.visible === false) continue;
            pointsTotalEstimate += s.points.length;
            for (let pi = 0; pi < s.points.length; pi++) {
                const timeMs = readPointTimeMs(s.points[pi]);
                if (timeMs === null) continue;
                if (timeMs < minTimeMs) minTimeMs = timeMs;
                if (timeMs > maxTimeMs) maxTimeMs = timeMs;
            }
        }
    }

    // Step di sampling per il grafico — 1 ogni N punti
    const chartStep = pointsTotalEstimate > MAX_CHART_PTS
        ? Math.ceil(pointsTotalEstimate / MAX_CHART_PTS)
        : 1;
    let useTimeAxis = _chartXAxis === 'time' && minTimeMs !== Infinity && maxTimeMs > minTimeMs;
    if (_chartXAxis === 'time' && !useTimeAxis) {
        _chartXAxis = 'distance';
        syncStatsControls();
        useTimeAxis = false;
    }

    // ── Loop singolo: distanza, dislivello, velocita, pendenza, chart ─────────
    // Le statistiche si riferiscono solo alla traccia attiva
    for (let ti = 0; ti < tracks.length; ti++) {
        const track = tracks[ti];
        if (activeTrackId && track.id !== activeTrackId) continue;
        if (track.visible === false) continue;
        const segs = track.segments;
        for (let si = 0; si < segs.length; si++) {
            const seg = segs[si];
            if (seg.visible === false) continue;
            totalSegments++;
            prevPt = null;
            prevTimeMs = null;

            const pts = seg.points;
            const n = pts.length;
            const segmentSurface = resolveSegmentSurface(track, seg);
            // Traccia l'indice iniziale in chartData per inserire il separatore
            const segChartStartIndex = chartData.length;
            let segSeparatorInserted = false;

            for (let i = 0; i < n; i++) {
                const pt = pts[i];
                const ele = Number(pt.ele) || 0;
                const timeMs = readPointTimeMs(pt);
                let currentSpeed = null;
                let currentSlope = null;
                let currentTilt = null;
                let currentVibration = null;

                if (prevPt !== null) {
                    const startDist = cumulativeDist;
                    const d = haversineDistance(prevPt.lon, prevPt.lat, pt.lon, pt.lat);
                    totalDistance  += d;
                    cumulativeDist += d;

                    const deltaH = ele - (Number(prevPt.ele) || 0);
                    if (deltaH > 0) totalAscent  += deltaH;
                    else            totalDescent  += -deltaH;

                    // Pendenza: ignora passi troppo corti (rumore GPS)
                    const distM = d * 1000;
                    if (distM > 15) {
                        currentSlope = (deltaH / distM) * 100;
                        const absSlope = Math.abs(currentSlope);
                        if (absSlope > maxSlope) maxSlope = absSlope;
                    }

                    if (timeMs !== null && prevTimeMs !== null) {
                        const dtMs = timeMs - prevTimeMs;
                        if (dtMs > 0) {
                            currentSpeed = d / (dtMs / 3600000);
                            if (currentSpeed >= 0 && currentSpeed <= 250) {
                                timedDistance += d;
                                timedHours += dtMs / 3600000;
                                if (currentSpeed > maxSpeed) maxSpeed = currentSpeed;
                            } else {
                                currentSpeed = null;
                            }
                        }
                    }

                    const surface = resolveLegSurface(track, seg, prevPt, pt, segmentSurface);
                    surfaceKm[surface] = (surfaceKm[surface] || 0) + d;
                    if (useTimeAxis) {
                        if (prevTimeMs !== null && timeMs !== null) {
                            pushSurfaceBand(
                                surfaceBands,
                                surface,
                                (prevTimeMs - minTimeMs) / 60000,
                                (timeMs - minTimeMs) / 60000
                            );
                        }
                    } else {
                        pushSurfaceBand(surfaceBands, surface, startDist, cumulativeDist);
                    }
                }

                if (ele > maxElevation) maxElevation = ele;

                // Dati sensori inclinometro e vibrazioni (da registrazione)
                if (Number.isFinite(pt.tilt)) {
                    currentTilt = pt.tilt;
                    const absTilt = Math.abs(pt.tilt);
                    if (absTilt > maxTilt) maxTilt = absTilt;
                    hasTiltData = true;
                }
                if (Number.isFinite(pt.vibrationLevel)) {
                    currentVibration = pt.vibrationLevel;
                    totalVibration += pt.vibrationLevel;
                    vibrationCount++;
                    if (pt.vibrationLevel > maxVibration) maxVibration = pt.vibrationLevel;
                    hasVibrationData = true;
                }

                const pointX = useTimeAxis && timeMs !== null
                    ? (timeMs - minTimeMs) / 60000
                    : (!useTimeAxis ? cumulativeDist : null);
                let pointY = ele;
                if (_chartMetric === 'speed') {
                    pointY = currentSpeed;
                } else if (_chartMetric === 'slope') {
                    pointY = currentSlope;
                } else if (_chartMetric === 'tilt') {
                    pointY = currentTilt;
                } else if (_chartMetric === 'vibration') {
                    pointY = currentVibration;
                }

                // Separatore null tra segmenti: rompe la linea tra segmenti diversi
                // (spanGaps:false per slope/speed/tilt/vibrazione lo rende visivo)
                if (!isFirstSegment && !segSeparatorInserted && Number.isFinite(pointX)) {
                    chartData.push({ x: pointX, y: null });
                    segSeparatorInserted = true;
                }

                // Sampling inline per il chart — niente array intermedio
                if (pointIndex % chartStep === 0 && Number.isFinite(pointX) && Number.isFinite(pointY)) {
                    chartData.push({ x: pointX, y: pointY });
                    // Lookup geografico per hover marker
                    _chartPointsGeo.push({ x: pointX, lat: pt.lat, lon: pt.lon });
                }
                pointIndex++;
                prevPt = pt;
                prevTimeMs = timeMs;
            }

            if (chartData.length > segChartStartIndex) {
                isFirstSegment = false;
            }
        }
    }

    if (_chartXAxis === 'time') {
        chartData.sort((a, b) => a.x - b.x);
    }

    const avgSpeed = timedHours > 0 ? timedDistance / timedHours : 0;
    const surfaceSummary = formatSurfaceSummary(surfaceKm);
    const axisMax = useTimeAxis ? (maxTimeMs - minTimeMs) / 60000 : totalDistance;

    // ── Aggiorna DOM statistiche ─────────────────────────────────────────────
    const $ = (id) => document.getElementById(id);
    const setText = (id, text) => {
        const el = $(id);
        if (el) el.textContent = text;
    };
    setText('stat-dist', totalDistance.toFixed(2) + ' km');
    setText('stat-ascent', `+${Math.round(totalAscent)} m`);
    setText('stat-descent', `-${Math.round(totalDescent)} m`);
    setText('stat-max-alt', maxElevation === -Infinity ? '0 m' : `${Math.round(maxElevation)} m`);
    setText('stat-avg-speed', formatSpeed(avgSpeed));
    setText('stat-max-speed', formatSpeed(maxSpeed));
    setText('stat-segments-count', totalSegments);
    setText('stat-avg-slope', totalDistance > 0
        ? `${((totalAscent / (totalDistance * 1000)) * 100).toFixed(1)}%`
        : '0%');
    setText('stat-max-slope', `${maxSlope.toFixed(1)}%`);
    setText('stat-surface-summary', surfaceSummary);
    const surfaceEl = $('stat-surface-summary');
    if (surfaceEl) {
        surfaceEl.title = `Asfalto ${surfaceKm.paved.toFixed(2)} km, Offroad ${surfaceKm.offroad.toFixed(2)} km, N/D ${surfaceKm.unknown.toFixed(2)} km`;
    }
    // Statistiche sensori (disponibili solo se la traccia è stata registrata con sensori attivi)
    setText('stat-max-tilt', hasTiltData ? `${maxTilt.toFixed(1)}°` : '--');
    setText('stat-avg-vibration', hasVibrationData ? `${(totalVibration / vibrationCount).toFixed(1)}` : '--');
    setText('stat-max-vibration', hasVibrationData ? `${maxVibration}` : '--');

    // ── Aggiorna il grafico selezionato ──────────────────────────────────────
    const applyChartData = (currentChart) => {
        if (!currentChart) return;
        updateChartAppearance(currentChart);
        currentChart.$surfaceBands = surfaceBands;
        currentChart.data.labels = [];
        currentChart.data.datasets[0].data = chartData;

        // Scala X
        if (axisMax > 0) {
            currentChart.options.scales.x.min = 0;
            currentChart.options.scales.x.max = axisMax;
        } else {
            delete currentChart.options.scales.x.min;
            delete currentChart.options.scales.x.max;
        }

        // Scala Y contestualizzata: valori bassi non occupano tutta l'altezza
        const yBounds = computeYAxisBounds(_chartMetric, chartData);
        currentChart.options.scales.y.min = yBounds.min;
        currentChart.options.scales.y.max = yBounds.max;
        currentChart.options.scales.y.suggestedMin = yBounds.suggestedMin;
        currentChart.options.scales.y.suggestedMax = yBounds.suggestedMax;

        currentChart.resize();
        currentChart.update('none');
    };

    if (chartData.length > 0 || surfaceBands.length > 0) {
        // Chart.js viene caricato solo quando il pannello statistiche viene aperto.
        ensureChart().then(applyChartData);
    } else if (chart) {
        chart.$surfaceBands = [];
        chart.data.labels = [];
        chart.data.datasets[0].data = [];
        chart.update('none');
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
