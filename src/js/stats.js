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

import { chart, setChart, tracks, activeTrackId, map } from './state.js';
import { loadScriptOnce, vibrationLevelColor } from './utils.js';

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
        label: 'Rollio (°)',
        color: '#a78bfa',
        unit: '°',
        tick: value => `${Number(value).toFixed(1)}°`,
        spanGaps: false
    },
    pitch: {
        label: 'Pitch (°)',
        color: '#34d399',
        unit: '°',
        tick: value => `${Number(value).toFixed(1)}°`,
        spanGaps: false
    },
    vibration: {
        label: 'Vibrazioni (1-20)',
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
let _chartZoomRange = null;
let _chartFullXRange = { min: 0, max: 0 };
let _chartPanState = null;
const _chartPointers = new Map();
let _chartPinchState = null;
let _selectedPointDragState = null;

// Lookup geografico per hover/righello sul grafico.
// _chartPointsGeo resta campionato come il grafico; _chartPointIndex contiene
// tutti i punti reali per mostrare la card del punto corretto.
let _chartPointsGeo = [];
let _chartPointIndex = [];
let _chartPointLookup = new Map();
let _selectedTrackPoint = null;
let _selectedTrackPointKey = '';
let _selectedChartXValue = null;
let _selectedPointSource = 'chart';
let _pointCardRaf = null;
let _chartMapFocusRaf = null;
let _pendingChartMapFocusDetail = null;
let _panelObserverBound = false;
let _mapPositionEventsBound = false;
let _pointCardCloseBound = false;
const _chartOverlays = {
    tilt: false,
    pitch: false,
    vibration: false
};
const SENSOR_OVERLAY_METRICS = ['tilt', 'pitch', 'vibration'];

// Plugin Chart.js: crosshair verticale tratteggiato alla posizione del mouse
const crosshairPlugin = {
    id: 'gpxsuiteCrosshair',
    afterDraw(chartInstance) {
        const { ctx, chartArea } = chartInstance;
        if (!ctx || !chartArea) return;

        const drawLine = (px, style, width = 1, dash = []) => {
            if (!Number.isFinite(px) || px < chartArea.left || px > chartArea.right) return;
            ctx.save();
            ctx.beginPath();
            ctx.strokeStyle = style;
            ctx.lineWidth = width;
            ctx.setLineDash(dash);
            ctx.moveTo(px, chartArea.top);
            ctx.lineTo(px, chartArea.bottom);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
        };

        if (Number.isFinite(_selectedChartXValue)) {
            const selectedPx = chartInstance.scales?.x?.getPixelForValue(_selectedChartXValue);
            drawLine(selectedPx, 'rgba(248,250,252,0.9)', 1.5, []);
        }
        drawLine(_chartCrosshairPx, 'rgba(255,255,255,0.4)', 1, [4, 4]);
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
    const pts = _chartPointIndex.length ? _chartPointIndex : _chartPointsGeo;
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
    if (_selectedTrackPoint) {
        _dispatchChartHover(_selectedTrackPoint);
        return;
    }
    window.dispatchEvent(new CustomEvent('gpxsuite:chart-hover-clear'));
}
// ─────────────────────────────────────────────────────────────────────────

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[c]));
}

function pointKey(trackId, segmentId, pointIndex) {
    return `${trackId || ''}:${segmentId || ''}:${Number(pointIndex) || 0}`;
}

function formatOptionalNumber(value, decimals = 1, suffix = '') {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return `${numeric.toFixed(decimals)}${suffix}`;
}

function formatOptionalInt(value, suffix = '') {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return `${Math.round(numeric)}${suffix}`;
}

function formatPointTimestamp(timeMs) {
    if (!Number.isFinite(timeMs)) return null;
    try {
        return new Date(timeMs).toLocaleString('it-IT', {
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    } catch {
        return null;
    }
}

function formatSurfaceLabel(surface) {
    const style = SURFACE_STYLES[normalizeSurfaceValue(surface)] || SURFACE_STYLES.unknown;
    return style.label === 'N/D' ? null : style.label;
}

function valueColorForPointField(field, value) {
    const numeric = Number(value);
    switch (field) {
        case 'ele':
            return '#7dd3fc';
        case 'speedKmh':
            if (!Number.isFinite(numeric) || numeric <= 0) return '#cbd5e1';
            if (numeric >= 80) return '#f87171';
            if (numeric >= 40) return '#fb923c';
            return '#facc15';
        case 'slope':
            if (!Number.isFinite(numeric)) return '#cbd5e1';
            if (Math.abs(numeric) >= 10) return '#f87171';
            if (Math.abs(numeric) >= 5) return '#fb923c';
            return numeric >= 0 ? '#86efac' : '#93c5fd';
        case 'hdop':
            if (!Number.isFinite(numeric)) return '#cbd5e1';
            if (numeric <= 1.2) return '#86efac';
            if (numeric <= 2.5) return '#facc15';
            return '#f87171';
        case 'pitch':
            if (!Number.isFinite(numeric)) return '#cbd5e1';
            if (Math.abs(numeric) >= 15) return '#f87171';
            if (Math.abs(numeric) >= 8) return '#fb923c';
            return '#34d399';
        case 'tilt':
            if (!Number.isFinite(numeric)) return '#cbd5e1';
            if (Math.abs(numeric) >= 15) return '#f87171';
            if (Math.abs(numeric) >= 8) return '#fb923c';
            return '#a78bfa';
        case 'vibrationLevel':
            return Number.isFinite(numeric) ? vibrationLevelColor(numeric, { max: 20, saturation: 92, lightness: 62 }) : '#cbd5e1';
        case 'accPeak':
            if (!Number.isFinite(numeric)) return '#cbd5e1';
            if (numeric >= 14) return '#f87171';
            if (numeric >= 8) return '#fb923c';
            return '#e5e7eb';
        case 'surface':
            return normalizeSurfaceValue(value) === 'offroad' ? '#fbbf24' : '#38bdf8';
        case 'timeMs':
            return '#cbd5e1';
        case 'seq':
            return '#93c5fd';
        default:
            return '#f8fafc';
    }
}

function renderPointRows(rows) {
    return rows.length ? rows.map(({ label, value, raw, field }) => `
        <div class="stats-point-card-row">
            <span>${escapeHtml(label)}</span>
            <strong style="color:${valueColorForPointField(field, raw ?? value)}">${escapeHtml(value)}</strong>
        </div>
    `).join('') : '<div class="stats-point-card-empty">N/D</div>';
}

function pointCardRows(detail) {
    return [
        { label: 'Alt', value: formatOptionalInt(detail.ele, ' m'), raw: detail.ele, field: 'ele' },
        { label: 'Vel', value: formatOptionalNumber(detail.speedKmh, 1, ' km/h'), raw: detail.speedKmh, field: 'speedKmh' },
        { label: 'Pend', value: formatOptionalNumber(detail.slope, 1, '%'), raw: detail.slope, field: 'slope' },
        { label: 'HDOP', value: formatOptionalNumber(detail.hdop, 1, ''), raw: detail.hdop, field: 'hdop' },
        { label: 'Seq', value: formatOptionalInt(detail.seq, ''), raw: detail.seq, field: 'seq' },
        { label: 'Pitch', value: formatOptionalNumber(detail.pitch, 1, ' deg'), raw: detail.pitch, field: 'pitch' },
        { label: 'Roll', value: formatOptionalNumber(detail.tilt, 1, ' deg'), raw: detail.tilt, field: 'tilt' },
        { label: 'Vibr', value: formatOptionalNumber(detail.vibrationLevel, 1, ''), raw: detail.vibrationLevel, field: 'vibrationLevel' },
        { label: 'Picco', value: formatOptionalNumber(detail.accPeak, 1, ' m/s2'), raw: detail.accPeak, field: 'accPeak' },
        { label: 'Sup', value: formatSurfaceLabel(detail.surface), raw: detail.surface, field: 'surface' }
    ].filter(row => row.value !== null && row.value !== undefined && row.value !== '');
}

function renderMapPointCardHtml(detail) {
    if (!detail) return '';

    return `
        <div class="stats-point-card-head stats-point-card-head--map">
            <span>${escapeHtml(detail.trackName || 'Punto traccia')} #${Number(detail.pointIndex) + 1}</span>
            <button type="button" class="stats-point-card-close" data-point-card-close aria-label="Chiudi">×</button>
        </div>
        <div class="stats-point-card-grid">${renderPointRows(pointCardRows(detail))}</div>
    `;
}

function chartMetricPointValue(detail) {
    const metric = CHART_METRICS[_chartMetric] || CHART_METRICS.altitude;
    switch (_chartMetric) {
        case 'altitude':
            return { label: 'Quota', value: formatOptionalInt(detail.ele, ' m'), raw: detail.ele, field: 'ele', color: metric.color };
        case 'speed':
            return { label: 'Velocita', value: formatOptionalNumber(detail.speedKmh, 1, ' km/h'), raw: detail.speedKmh, field: 'speedKmh', color: metric.color };
        case 'slope':
            return { label: 'Pendenza', value: formatOptionalNumber(detail.slope, 1, '%'), raw: detail.slope, field: 'slope', color: metric.color };
        case 'tilt':
            return { label: 'Roll', value: formatOptionalNumber(detail.tilt, 1, ' deg'), raw: detail.tilt, field: 'tilt', color: metric.color };
        case 'pitch':
            return { label: 'Pitch', value: formatOptionalNumber(detail.pitch, 1, ' deg'), raw: detail.pitch, field: 'pitch', color: metric.color };
        case 'vibration':
            return { label: 'Vibrazioni', value: formatOptionalNumber(detail.vibrationLevel, 1, ''), raw: detail.vibrationLevel, field: 'vibrationLevel', color: metric.color };
        default:
            return { label: metric.label, value: null, field: _chartMetric, color: metric.color };
    }
}

function renderChartPointCardHtml(detail) {
    if (!detail) return '';
    const metric = chartMetricPointValue(detail);
    const value = metric.value || 'N/D';
    const color = valueColorForPointField(metric.field, metric.raw ?? metric.value);
    return `
        <div class="stats-point-card-inline">
            <span class="stats-point-card-chip">#${Number(detail.pointIndex) + 1}</span>
            <span class="stats-point-card-label">${escapeHtml(metric.label)}</span>
            <strong class="stats-point-card-value" style="color:${color}">${escapeHtml(value)}</strong>
        </div>
    `;
}

function getChartPointCard() {
    return document.getElementById('stats-point-card');
}

function getMapPointCard() {
    return document.getElementById('map-point-card');
}

function getStatsSummaryCard() {
    return document.querySelector('#panel-bottom-stats .stats-secondary-grid');
}

function hidePointCards() {
    getChartPointCard()?.classList.add('hidden');
    getMapPointCard()?.classList.add('hidden');
}

function bindPointCardClose() {
    if (_pointCardCloseBound) return;
    _pointCardCloseBound = true;
    document.addEventListener('click', event => {
        const closeButton = event.target?.closest?.('[data-point-card-close]');
        if (!closeButton) return;
        event.preventDefault();
        event.stopPropagation();
        clearSelectedTrackPoint();
    }, true);
}

function schedulePointCardPosition() {
    if (_pointCardRaf) return;
    _pointCardRaf = requestAnimationFrame(() => {
        _pointCardRaf = null;
        updatePointCardPositions();
    });
}

function clampPixel(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function rectsOverlap(a, b) {
    return a.left < b.right &&
        a.right > b.left &&
        a.top < b.bottom &&
        a.bottom > b.top;
}

function avoidChartFloatingControls(shell, left, top, width, height) {
    const controls = shell?.querySelector?.('.stats-chart-floating-controls');
    if (!controls) return { left, top };
    const shellRect = shell.getBoundingClientRect();
    const controlsRect = controls.getBoundingClientRect();
    if (controlsRect.width <= 0 || controlsRect.height <= 0) return { left, top };

    const gap = 6;
    const controlsBox = {
        left: controlsRect.left - shellRect.left - gap,
        right: controlsRect.right - shellRect.left + gap,
        top: controlsRect.top - shellRect.top - gap,
        bottom: controlsRect.bottom - shellRect.top + gap
    };
    const cardBox = {
        left,
        right: left + width,
        top,
        bottom: top + height
    };
    if (!rectsOverlap(cardBox, controlsBox)) return { left, top };

    const maxTop = Math.max(gap, shellRect.height - height - gap);
    const belowControls = controlsBox.bottom + gap;
    if (belowControls <= maxTop) {
        return { left, top: belowControls };
    }

    const leftOfControls = controlsBox.left - width - gap;
    if (leftOfControls >= gap) {
        return { left: leftOfControls, top };
    }

    return { left, top: maxTop };
}

function positionChartPointCard(card, detail) {
    if (!card || !chart || !detail || !Number.isFinite(detail.x)) return;
    const shell = card.closest('.stats-chart-shell');
    const area = chart.chartArea;
    const xScale = chart.scales?.x;
    if (!shell || !area || !xScale) return;

    const shellRect = shell.getBoundingClientRect();
    const px = xScale.getPixelForValue(detail.x);
    if (!Number.isFinite(px) || px < area.left || px > area.right) {
        clearSelectedTrackPoint();
        return;
    }
    const width = card.offsetWidth || 116;
    const height = card.offsetHeight || 34;
    let left = clampPixel(px - width / 2, 6, Math.max(6, shellRect.width - width - 6));
    let top = clampPixel(area.top + 6, 6, Math.max(6, shellRect.height - height - 6));
    ({ left, top } = avoidChartFloatingControls(shell, left, top, width, height));
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
}

function bottomOverlayLimitTop(viewportH, fallbackBottom) {
    let limit = fallbackBottom;
    const panel = document.getElementById('panel-bottom-stats');
    if (panel && !panel.classList.contains('translate-y-60')) {
        const rect = panel.getBoundingClientRect();
        if (rect.height > 0 && rect.top < viewportH) limit = Math.min(limit, rect.top);
    }

    document.querySelectorAll('#device-dashboard:not(.hidden) .device-dashboard-card').forEach(card => {
        const style = getComputedStyle(card);
        const rect = card.getBoundingClientRect();
        const isVisible = style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity) !== 0 &&
            rect.width > 0 &&
            rect.height > 0;
        if (isVisible && rect.bottom > viewportH * 0.55) {
            limit = Math.min(limit, rect.top);
        }
    });

    return limit;
}

function getVisibleMapRect(viewportW, viewportH) {
    const mapContainer = map?.getContainer?.();
    const mapRect = mapContainer?.getBoundingClientRect?.();
    const left = Math.max(0, mapRect ? mapRect.left : 0);
    const right = Math.min(viewportW, mapRect ? mapRect.right : viewportW);
    const top = Math.max(0, mapRect ? mapRect.top : 0);
    const bottom = Math.min(
        viewportH,
        mapRect ? mapRect.bottom : viewportH,
        bottomOverlayLimitTop(viewportH, viewportH)
    );
    return {
        left,
        right,
        top,
        bottom,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top)
    };
}

function isProjectedMapPointVisible(projected, viewportW, viewportH) {
    if (!projected || !Number.isFinite(projected.x) || !Number.isFinite(projected.y)) return false;
    const mapContainer = map?.getContainer?.();
    const mapRect = mapContainer?.getBoundingClientRect?.();
    const pointX = (mapRect ? mapRect.left : 0) + projected.x;
    const pointY = (mapRect ? mapRect.top : 0) + projected.y;
    const margin = 2;
    const visibleRect = getVisibleMapRect(viewportW, viewportH);
    const visibleLeft = visibleRect.left + margin;
    const visibleRight = visibleRect.right - margin;
    const visibleTop = visibleRect.top + margin;
    const visibleBottom = visibleRect.bottom - margin;

    return pointX >= visibleLeft &&
        pointX <= visibleRight &&
        pointY >= visibleTop &&
        pointY <= visibleBottom;
}

function focusMapOnChartPoint(detail) {
    if (!detail || !map || !Number.isFinite(detail.lat) || !Number.isFinite(detail.lon)) return;
    if (_selectedTrackPointKey && detail.key && detail.key !== _selectedTrackPointKey) return;
    const mapContainer = map.getContainer?.();
    const mapRect = mapContainer?.getBoundingClientRect?.();
    if (!mapRect || mapRect.width <= 0 || mapRect.height <= 0) return;

    const viewportW = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportH = window.innerHeight || document.documentElement.clientHeight || 0;
    const visibleRect = getVisibleMapRect(viewportW, viewportH);
    if (visibleRect.width < 80 || visibleRect.height < 80) return;

    const projected = map.project([detail.lon, detail.lat]);
    if (!projected || !Number.isFinite(projected.x) || !Number.isFinite(projected.y)) return;

    const targetAbsX = visibleRect.left + visibleRect.width * 0.5;
    const targetAbsY = visibleRect.top + visibleRect.height * 0.38;
    const targetX = targetAbsX - mapRect.left;
    const targetY = targetAbsY - mapRect.top;
    const centerX = mapRect.width / 2;
    const centerY = mapRect.height / 2;
    const nextCenter = map.unproject([
        projected.x + centerX - targetX,
        projected.y + centerY - targetY
    ]);
    if (!nextCenter) return;

    map.easeTo({
        center: [nextCenter.lng, nextCenter.lat],
        duration: 360,
        essential: true
    });
}

function scheduleChartMapFocus(detail) {
    _pendingChartMapFocusDetail = detail;
    if (_chartMapFocusRaf) return;
    _chartMapFocusRaf = requestAnimationFrame(() => {
        _chartMapFocusRaf = null;
        const pending = _pendingChartMapFocusDetail;
        _pendingChartMapFocusDetail = null;
        focusMapOnChartPoint(pending);
    });
}

function positionMapPointCard(card, detail) {
    if (!card || !map || !detail || !Number.isFinite(detail.lat) || !Number.isFinite(detail.lon)) return;
    const projected = map.project([detail.lon, detail.lat]);
    const viewportW = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportH = window.innerHeight || document.documentElement.clientHeight || 0;
    if (!isProjectedMapPointVisible(projected, viewportW, viewportH)) {
        clearSelectedTrackPoint();
        return;
    }
    const width = card.offsetWidth || 220;
    const height = card.offsetHeight || 120;
    const margin = 10;
    const bottomLimit = bottomOverlayLimitTop(viewportH, viewportH - margin) - 8;
    const maxTop = Math.max(margin, bottomLimit - height);
    const left = clampPixel(projected.x - width / 2, margin, Math.max(margin, viewportW - width - margin));
    const top = clampPixel(projected.y - height - 18, margin, maxTop);
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
}

function positionStatsSummaryCard() {
    const summary = getStatsSummaryCard();
    if (!summary) return;
    summary.style.left = '';
    summary.style.top = '';
}

function updatePointCardPositions() {
    positionStatsSummaryCard();
    if (!_selectedTrackPoint) return;
    const showChartCard = isStatsPanelVisible() && _selectedPointSource !== 'map';
    if (showChartCard) {
        positionChartPointCard(getChartPointCard(), _selectedTrackPoint);
    } else {
        positionMapPointCard(getMapPointCard(), _selectedTrackPoint);
    }
}

function bindSelectedPointPositionEvents() {
    if (_mapPositionEventsBound) return;
    _mapPositionEventsBound = true;
    window.addEventListener('resize', schedulePointCardPosition, { passive: true });
    if (map?.on) {
        map.on('move', schedulePointCardPosition);
        map.on('zoom', schedulePointCardPosition);
    }
}

function renderSelectedPointUi() {
    if (!_selectedTrackPoint) {
        hidePointCards();
        _selectedChartXValue = null;
        chart?.draw();
        schedulePointCardPosition();
        return;
    }

    bindSelectedPointPositionEvents();
    bindPointCardClose();
    const statsOpen = isStatsPanelVisible();
    const chartCard = getChartPointCard();
    const mapCard = getMapPointCard();
    const showChartCard = statsOpen && _selectedPointSource !== 'map';

    if (showChartCard) {
        if (chartCard) {
            chartCard.innerHTML = renderChartPointCardHtml(_selectedTrackPoint);
            chartCard.classList.remove('hidden');
        }
        mapCard?.classList.add('hidden');
    } else {
        if (mapCard) {
            mapCard.innerHTML = renderMapPointCardHtml(_selectedTrackPoint);
            mapCard.classList.remove('hidden');
        }
        chartCard?.classList.add('hidden');
    }

    _selectedChartXValue = Number.isFinite(_selectedTrackPoint.x) ? _selectedTrackPoint.x : null;
    _dispatchChartHover(_selectedTrackPoint);
    chart?.draw();
    schedulePointCardPosition();
}

function bindStatsPanelObserver() {
    if (_panelObserverBound) return;
    const panel = document.getElementById('panel-bottom-stats');
    if (!panel || typeof MutationObserver !== 'function') return;
    _panelObserverBound = true;
    const observer = new MutationObserver(() => renderSelectedPointUi());
    observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
}

function _hasValidChartRange(range = _chartFullXRange) {
    return Number.isFinite(range?.min) && Number.isFinite(range?.max) && range.max > range.min;
}

function _clampChartRange(min, max) {
    if (!_hasValidChartRange()) return null;
    const fullMin = _chartFullXRange.min;
    const fullMax = _chartFullXRange.max;
    const fullSpan = fullMax - fullMin;
    let span = max - min;
    if (!Number.isFinite(span) || span <= 0) return null;

    const minSpan = Math.max(fullSpan / 1000, _chartXAxis === 'time' ? 0.1 : 0.01);
    if (span < minSpan) {
        const center = (min + max) / 2;
        span = minSpan;
        min = center - span / 2;
        max = center + span / 2;
    }

    if (span >= fullSpan * 0.999) return null;
    if (min < fullMin) {
        max += fullMin - min;
        min = fullMin;
    }
    if (max > fullMax) {
        min -= max - fullMax;
        max = fullMax;
    }
    min = Math.max(fullMin, min);
    max = Math.min(fullMax, max);
    return max > min ? { min, max } : null;
}

function _applyChartXScale(currentChart = chart) {
    if (!currentChart) return;
    if (!_hasValidChartRange()) {
        delete currentChart.options.scales.x.min;
        delete currentChart.options.scales.x.max;
        return;
    }
    const range = _chartZoomRange || _chartFullXRange;
    currentChart.options.scales.x.min = range.min;
    currentChart.options.scales.x.max = range.max;
}

function _setChartFullXRange(axisMax) {
    if (Number.isFinite(axisMax) && axisMax > 0) {
        _chartFullXRange = { min: 0, max: axisMax };
        if (_chartZoomRange) {
            _chartZoomRange = _clampChartRange(_chartZoomRange.min, _chartZoomRange.max);
        }
    } else {
        _chartFullXRange = { min: 0, max: 0 };
        _chartZoomRange = null;
    }
}

function _setChartZoomRange(range, currentChart = chart) {
    _chartZoomRange = range ? _clampChartRange(range.min, range.max) : null;
    _applyChartXScale(currentChart);
    currentChart?.update('none');
    schedulePointCardPosition();
}

function _zoomChart(factor, anchorValue = null) {
    if (!chart || !_hasValidChartRange()) return;
    const current = _chartZoomRange || _chartFullXRange;
    const currentSpan = current.max - current.min;
    const anchor = Number.isFinite(anchorValue) ? anchorValue : (current.min + current.max) / 2;
    const ratio = currentSpan > 0 ? (anchor - current.min) / currentSpan : 0.5;
    const nextSpan = currentSpan * factor;
    const nextMin = anchor - nextSpan * ratio;
    const nextMax = nextMin + nextSpan;
    _setChartZoomRange(_clampChartRange(nextMin, nextMax), chart);
}

function _chartValueForClientX(currentChart, clientX) {
    const area = currentChart?.chartArea;
    const xScale = currentChart?.scales?.x;
    if (!area || !xScale) return null;
    const rect = currentChart.canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    if (px < area.left || px > area.right) return null;
    const value = xScale.getValueForPixel(px);
    return Number.isFinite(value) ? value : null;
}

function _selectedLinePixel(currentChart) {
    if (!currentChart || !Number.isFinite(_selectedChartXValue)) return null;
    const px = currentChart.scales?.x?.getPixelForValue(_selectedChartXValue);
    return Number.isFinite(px) ? px : null;
}

function _selectNearestChartPointForClientX(currentChart, clientX) {
    const xValue = _chartValueForClientX(currentChart, clientX);
    if (!Number.isFinite(xValue)) return false;
    const nearest = _findNearestGeoPoint(xValue);
    if (!nearest?.trackId || !nearest?.segmentId || !Number.isFinite(nearest.pointIndex)) return false;
    selectTrackPoint(nearest.trackId, nearest.segmentId, nearest.pointIndex, { source: 'chart' });
    return true;
}

function _chartPointerPair() {
    const points = Array.from(_chartPointers.values());
    return points.length >= 2 ? [points[0], points[1]] : null;
}

function _chartPointerDistance(a, b) {
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function _chartPointerCenter(a, b) {
    return {
        clientX: (a.clientX + b.clientX) / 2,
        clientY: (a.clientY + b.clientY) / 2
    };
}

function _startChartPinch(currentChart) {
    const pair = _chartPointerPair();
    if (!pair || !_hasValidChartRange()) return false;
    const [a, b] = pair;
    const distance = _chartPointerDistance(a, b);
    if (!Number.isFinite(distance) || distance < 8) return false;
    const center = _chartPointerCenter(a, b);
    const anchor = _chartValueForClientX(currentChart, center.clientX);
    if (!Number.isFinite(anchor)) return false;

    const startRange = _chartZoomRange || _chartFullXRange;
    _chartPanState = null;
    _chartPinchState = {
        startDistance: distance,
        startCenterX: center.clientX,
        startAnchor: anchor,
        startRange: { ...startRange }
    };
    currentChart.canvas.classList.add('stats-chart-canvas--panning');
    return true;
}

function _updateChartPinch(currentChart) {
    if (!_chartPinchState) return false;
    const pair = _chartPointerPair();
    if (!pair) return false;
    const [a, b] = pair;
    const distance = _chartPointerDistance(a, b);
    const area = currentChart?.chartArea;
    if (!Number.isFinite(distance) || distance < 8 || !area || area.right <= area.left) return true;

    const startSpan = _chartPinchState.startRange.max - _chartPinchState.startRange.min;
    if (!Number.isFinite(startSpan) || startSpan <= 0) return true;
    const factor = _chartPinchState.startDistance / distance;
    const nextSpan = startSpan * factor;
    const center = _chartPointerCenter(a, b);
    const unitsPerPx = nextSpan / (area.right - area.left);
    const centerValue = _chartPinchState.startAnchor - (center.clientX - _chartPinchState.startCenterX) * unitsPerPx;
    const ratio = (_chartPinchState.startAnchor - _chartPinchState.startRange.min) / startSpan;
    const nextMin = centerValue - nextSpan * ratio;
    _setChartZoomRange({ min: nextMin, max: nextMin + nextSpan }, currentChart);
    return true;
}

function _clearChartGestures(currentChart) {
    _chartPanState = null;
    _chartPinchState = null;
    _selectedPointDragState = null;
    _chartPointers.clear();
    currentChart?.canvas?.classList.remove('stats-chart-canvas--panning', 'stats-chart-canvas--ruler-drag');
}

function _bindChartNavigation(currentChart) {
    const canvas = currentChart?.canvas;
    if (!canvas || canvas.dataset.statsNavigationBound === 'true') return;
    canvas.dataset.statsNavigationBound = 'true';

    canvas.addEventListener('wheel', event => {
        if (!_hasValidChartRange()) return;
        const anchor = _chartValueForClientX(currentChart, event.clientX);
        if (!Number.isFinite(anchor)) return;
        event.preventDefault();
        _zoomChart(event.deltaY > 0 ? 1.25 : 0.8, anchor);
    }, { passive: false });

    canvas.addEventListener('pointerdown', event => {
        if (event.button !== undefined && event.button !== 0) return;
        if (!_hasValidChartRange()) return;
        _chartPointers.set(event.pointerId, {
            clientX: event.clientX,
            clientY: event.clientY
        });
        try { canvas.setPointerCapture(event.pointerId); } catch (err) { }

        if (_chartPointers.size >= 2) {
            event.preventDefault();
            _startChartPinch(currentChart);
            return;
        }

        const anchor = _chartValueForClientX(currentChart, event.clientX);
        if (!Number.isFinite(anchor)) return;
        const rect = canvas.getBoundingClientRect();
        const selectedPx = _selectedLinePixel(currentChart);
        const localX = event.clientX - rect.left;
        if (_selectedTrackPoint && Number.isFinite(selectedPx) && Math.abs(localX - selectedPx) <= 18) {
            event.preventDefault();
            _selectedPointDragState = { pointerId: event.pointerId };
            canvas.classList.add('stats-chart-canvas--ruler-drag');
            _selectNearestChartPointForClientX(currentChart, event.clientX);
            return;
        }
        const startRange = _chartZoomRange || _chartFullXRange;
        _chartPanState = {
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            hasPanned: false,
            startRange: { ...startRange }
        };
        canvas.classList.add('stats-chart-canvas--panning');
    });

    canvas.addEventListener('pointermove', event => {
        if (_chartPointers.has(event.pointerId)) {
            _chartPointers.set(event.pointerId, {
                clientX: event.clientX,
                clientY: event.clientY
            });
        }
        if (_selectedPointDragState && _selectedPointDragState.pointerId === event.pointerId) {
            event.preventDefault();
            if (!_selectNearestChartPointForClientX(currentChart, event.clientX)) {
                _selectedPointDragState = null;
                canvas.classList.remove('stats-chart-canvas--ruler-drag');
                clearSelectedTrackPoint();
            }
            return;
        }
        if (_chartPinchState || _chartPointers.size >= 2) {
            event.preventDefault();
            if (!_chartPinchState) _startChartPinch(currentChart);
            if (_updateChartPinch(currentChart)) return;
        }
        if (!_chartPanState || _chartPanState.pointerId !== event.pointerId) return;
        const moveDistance = Math.hypot(
            event.clientX - _chartPanState.startClientX,
            event.clientY - _chartPanState.startClientY
        );
        if (!_chartPanState.hasPanned && moveDistance < 6) return;
        _chartPanState.hasPanned = true;
        const area = currentChart.chartArea;
        if (!area || area.right <= area.left) return;
        const span = _chartPanState.startRange.max - _chartPanState.startRange.min;
        const unitsPerPx = span / (area.right - area.left);
        const delta = (event.clientX - _chartPanState.startClientX) * unitsPerPx;
        _setChartZoomRange({
            min: _chartPanState.startRange.min - delta,
            max: _chartPanState.startRange.max - delta
        }, currentChart);
    });

    const endPan = event => {
        _chartPointers.delete(event.pointerId);
        if (_selectedPointDragState && _selectedPointDragState.pointerId === event.pointerId) {
            const releaseValue = _chartValueForClientX(currentChart, event.clientX);
            _selectedPointDragState = null;
            canvas.classList.remove('stats-chart-canvas--ruler-drag');
            if (!Number.isFinite(releaseValue)) clearSelectedTrackPoint();
            return;
        }
        if (_chartPinchState) {
            _chartPinchState = null;
            _chartPanState = null;
            if (_chartPointers.size === 0) canvas.classList.remove('stats-chart-canvas--panning');
            return;
        }
        if (_chartPanState && _chartPanState.pointerId === event.pointerId) {
            const shouldSelectPoint = event.type === 'pointerup' && !_chartPanState.hasPanned;
            const selectClientX = Number.isFinite(event.clientX) ? event.clientX : _chartPanState.startClientX;
            _chartPanState = null;
            canvas.classList.remove('stats-chart-canvas--panning');
            if (shouldSelectPoint) _selectNearestChartPointForClientX(currentChart, selectClientX);
        }
    };
    canvas.addEventListener('pointerup', endPan);
    canvas.addEventListener('pointercancel', endPan);
    canvas.addEventListener('lostpointercapture', event => {
        if (_chartPointers.has(event.pointerId)) endPan(event);
    });
    window.addEventListener('blur', () => _clearChartGestures(currentChart));
}

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
                yAxisID: 'y',
                borderColor: metric.color,
                backgroundColor: 'transparent',
                borderWidth: 2,
                fill: false,
                pointRadius: 0,
                pointHoverRadius: 5,
                spanGaps: true,
                tension: 0.1
            }, {
                label: 'Rollio',
                data: [],
                yAxisID: 'ySensor',
                borderColor: CHART_METRICS.tilt.color,
                backgroundColor: 'transparent',
                borderWidth: 1.2,
                borderDash: [5, 3],
                fill: false,
                pointRadius: 0,
                pointHoverRadius: 0,
                spanGaps: false,
                tension: 0.08,
                hidden: true
            }, {
                label: 'Pitch',
                data: [],
                yAxisID: 'ySensor',
                borderColor: CHART_METRICS.pitch.color,
                backgroundColor: 'transparent',
                borderWidth: 1.2,
                borderDash: [2, 3],
                fill: false,
                pointRadius: 0,
                pointHoverRadius: 0,
                spanGaps: false,
                tension: 0.08,
                hidden: true
            }, {
                label: 'Vibrazioni',
                data: [],
                yAxisID: 'yVibration',
                borderColor: CHART_METRICS.vibration.color,
                backgroundColor: 'transparent',
                borderWidth: 1.2,
                fill: false,
                pointRadius: 0,
                pointHoverRadius: 0,
                spanGaps: false,
                tension: 0.08,
                hidden: true
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
                legend: {
                    display: false,
                    labels: { color: '#cbd5e1', boxWidth: 10, boxHeight: 2, font: { size: 10 } }
                },
                tooltip: {
                    callbacks: {
                        title: items => formatChartTooltipTitle(items?.[0]?.parsed?.x),
                        label: context => formatChartTooltipLabel(context.parsed?.y, context.dataset?.label)
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
                },
                ySensor: {
                    position: 'right',
                    display: false,
                    grid: { display: false },
                    ticks: {
                        color: '#94a3b8',
                        font: { size: 9 },
                        callback: value => `${Number(value).toFixed(0)} deg`
                    }
                },
                yVibration: {
                    position: 'right',
                    display: false,
                    min: 1,
                    max: 20,
                    grid: { display: false },
                    ticks: {
                        color: '#fb7185',
                        font: { size: 9 },
                        stepSize: 4,
                        callback: value => `${Math.round(Number(value))}`
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
    _bindChartNavigation(newChart);

    return newChart;
}

function bindStatsControls() {
    bindStatsPanelObserver();
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
            _chartZoomRange = null;
            syncStatsControls();
            forceUpdateStats();
        });
    });

    document.querySelectorAll('[data-stats-zoom]').forEach(button => {
        button.addEventListener('click', () => {
            const action = button.dataset.statsZoom;
            if (action === 'in') _zoomChart(0.7);
            else if (action === 'out') _zoomChart(1.4);
            else if (action === 'reset') _setChartZoomRange(null);
        });
    });

    document.querySelectorAll('[data-stats-overlay]').forEach(button => {
        button.addEventListener('click', () => {
            const metric = button.dataset.statsOverlay;
            if (!SENSOR_OVERLAY_METRICS.includes(metric)) return;
            _chartOverlays[metric] = !_chartOverlays[metric];
            syncOverlayControls();
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
    syncOverlayControls();
    syncColorControls();
}

function syncOverlayControls() {
    document.querySelectorAll('[data-stats-overlay]').forEach(button => {
        const metric = button.dataset.statsOverlay;
        button.dataset.active = _chartOverlays[metric] ? 'true' : 'false';
    });
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

function formatChartTooltipLabel(value, datasetLabel = '') {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '';
    if (datasetLabel === 'Rollio' || datasetLabel === 'Pitch') {
        return `${datasetLabel}: ${numeric.toFixed(1)} deg`;
    }
    if (datasetLabel === 'Vibrazioni') {
        return `${datasetLabel}: ${Math.round(numeric)}`;
    }
    const metric = CHART_METRICS[_chartMetric] || CHART_METRICS.altitude;
    if (_chartMetric === 'altitude') return `${metric.label}: ${Math.round(numeric)} ${metric.unit}`;
    if (_chartMetric === 'vibration') return `${metric.label}: ${Math.round(numeric)}`;
    return `${metric.label}: ${numeric.toFixed(1)} ${metric.unit}`;
}

function readPointTimeMs(point) {
    const raw = point?.time;
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
}

function findTrackAndSegment(trackId, segmentId) {
    const track = tracks.find(t => t.id === trackId);
    if (!track) return {};
    const segment = (track.segments || []).find(s => s.id === segmentId);
    return { track, segment };
}

function findChartTimeOrigin() {
    let minTimeMs = Infinity;
    for (let ti = 0; ti < tracks.length; ti++) {
        const track = tracks[ti];
        if (activeTrackId && track.id !== activeTrackId) continue;
        if (track.visible === false) continue;
        for (let si = 0; si < track.segments.length; si++) {
            const segment = track.segments[si];
            if (segment.visible === false) continue;
            const points = segment.points || [];
            for (let pi = 0; pi < points.length; pi++) {
                const timeMs = readPointTimeMs(points[pi]);
                if (timeMs !== null && timeMs < minTimeMs) minTimeMs = timeMs;
            }
        }
    }
    return Number.isFinite(minTimeMs) ? minTimeMs : null;
}

function resolvePointSurface(track, segment, pointIndex) {
    const points = segment?.points || [];
    const point = points[pointIndex];
    const prev = pointIndex > 0 ? points[pointIndex - 1] : null;
    return point?.surfaceFromPrev || point?.surface || prev?.surfaceNext || prev?.surface ||
        segment?.surface || segment?.surfaceClass || track?.surface || track?.surfaceClass || '';
}

function buildPointDetail(trackId, segmentId, pointIndex) {
    const { track, segment } = findTrackAndSegment(trackId, segmentId);
    const points = segment?.points || [];
    const index = Number(pointIndex);
    const point = points[index];
    if (!track || !segment || !point || !Number.isFinite(index)) return null;

    let cumulativeDist = 0;
    let selectedLegDistance = 0;
    let selectedSlope = null;
    let computedSpeed = null;
    let selectedTimeMs = readPointTimeMs(point);

    const segments = track.segments || [];
    for (let si = 0; si < segments.length; si++) {
        const currentSegment = segments[si];
        const pts = currentSegment.points || [];
        for (let pi = 0; pi < pts.length; pi++) {
            const currentPoint = pts[pi];
            if (pi > 0) {
                const prevPoint = pts[pi - 1];
                const d = haversineDistance(prevPoint.lon, prevPoint.lat, currentPoint.lon, currentPoint.lat);
                cumulativeDist += d;

                if (currentSegment.id === segmentId && pi === index) {
                    selectedLegDistance = d;
                    const distM = d * 1000;
                    const deltaH = (Number(currentPoint.ele) || 0) - (Number(prevPoint.ele) || 0);
                    if (distM > 15) selectedSlope = (deltaH / distM) * 100;

                    const currentTime = readPointTimeMs(currentPoint);
                    const prevTime = readPointTimeMs(prevPoint);
                    if (currentTime !== null && prevTime !== null && currentTime > prevTime) {
                        const speed = d / ((currentTime - prevTime) / 3600000);
                        if (speed >= 0 && speed <= 250) computedSpeed = speed;
                    }
                }
            }

            if (currentSegment.id === segmentId && pi === index) {
                const timeOrigin = _chartXAxis === 'time' ? findChartTimeOrigin() : null;
                const x = _chartXAxis === 'time' && selectedTimeMs !== null && timeOrigin !== null
                    ? (selectedTimeMs - timeOrigin) / 60000
                    : cumulativeDist;
                const pointSpeedKmh = Number.isFinite(point.speedMps)
                    ? point.speedMps * 3.6
                    : computedSpeed;
                return {
                    trackId,
                    segmentId,
                    pointIndex: index,
                    key: pointKey(trackId, segmentId, index),
                    trackName: track.name || 'Traccia',
                    segmentName: segment.name || '',
                    lat: point.lat,
                    lon: point.lon,
                    x,
                    ele: Number(point.ele),
                    timeMs: selectedTimeMs,
                    speedKmh: Number.isFinite(pointSpeedKmh) ? pointSpeedKmh : null,
                    slope: selectedSlope,
                    hdop: Number.isFinite(point.hdop) ? point.hdop : null,
                    seq: Number.isFinite(point.seq) ? point.seq : null,
                    pitch: Number.isFinite(point.pitch) ? point.pitch : null,
                    tilt: Number.isFinite(point.tilt) ? point.tilt : null,
                    vibrationLevel: Number.isFinite(point.vibrationLevel) ? point.vibrationLevel : null,
                    accPeak: Number.isFinite(point.accPeak) ? point.accPeak : null,
                    surface: resolvePointSurface(track, segment, index),
                    legDistanceKm: selectedLegDistance
                };
            }
        }
    }

    return null;
}

export function selectTrackPoint(trackId, segmentId, pointIndex, options = {}) {
    const detail = buildPointDetail(trackId, segmentId, pointIndex);
    if (!detail) return null;
    const source = options.source === 'map' ? 'map' : 'chart';
    _selectedTrackPoint = detail;
    _selectedTrackPointKey = detail.key;
    _selectedChartXValue = Number.isFinite(detail.x) ? detail.x : null;
    _selectedPointSource = source;
    renderSelectedPointUi();
    if (source === 'chart') scheduleChartMapFocus(detail);
    if (options.forceStatsRefresh && isStatsPanelVisible()) forceUpdateStats();
    return detail;
}

export function clearSelectedTrackPoint() {
    _selectedTrackPoint = null;
    _selectedTrackPointKey = '';
    _selectedChartXValue = null;
    _selectedPointSource = 'chart';
    _pendingChartMapFocusDetail = null;
    if (_chartMapFocusRaf) {
        cancelAnimationFrame(_chartMapFocusRaf);
        _chartMapFocusRaf = null;
    }
    hidePointCards();
    chart?.draw();
    window.dispatchEvent(new CustomEvent('gpxsuite:chart-hover-clear'));
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
        case 'tilt':
        case 'pitch': {
            // Simmetrico, almeno ±30°
            const ext = Math.max(30, Math.ceil(Math.max(Math.abs(dataMin), Math.abs(dataMax)) * 1.25));
            result.suggestedMin = -ext;
            result.suggestedMax = ext;
            break;
        }
        case 'vibration':
            // Scala fissa 1-20: il livello registrato ha significato assoluto.
            result.min = 1;
            result.max = 20;
            break;
    }
    return result;
}

function hasActiveOverlayData(overlayData) {
    return SENSOR_OVERLAY_METRICS.some(metric => _chartOverlays[metric] && (overlayData[metric]?.length || 0) > 0);
}

function computeSensorOverlayExtent(overlayData) {
    let ext = 30;
    ['tilt', 'pitch'].forEach(metric => {
        const values = overlayData[metric] || [];
        for (let i = 0; i < values.length; i++) {
            const value = Number(values[i]?.y);
            if (Number.isFinite(value)) ext = Math.max(ext, Math.ceil(Math.abs(value) * 1.25));
        }
    });
    return ext;
}

function updateChartAppearance(currentChart, overlayData = {}) {
    const metric = CHART_METRICS[_chartMetric] || CHART_METRICS.altitude;
    const dataset = currentChart.data.datasets[0];
    dataset.label = metric.label;
    dataset.yAxisID = 'y';
    dataset.borderColor = metric.color;
    dataset.segment = _chartMetric === 'vibration' ? {
        borderColor: context => chartVibrationColor(context.p1?.parsed?.y ?? context.p0?.parsed?.y)
    } : {};
    dataset.backgroundColor = 'transparent';
    dataset.fill = false;
    // spanGaps: true solo per altitudine (dati GPS possono avere buchi)
    // false per slope/speed/roll/pitch/vibrazione per non collegare segmenti diversi
    dataset.spanGaps = metric.spanGaps !== false;
    currentChart.options.scales.x.ticks.callback = value => formatXAxisTick(value);
    currentChart.options.scales.y.ticks.callback = value => formatYAxisTick(value);
    currentChart.options.scales.y.ticks.stepSize = _chartMetric === 'vibration' ? 2 : undefined;
    currentChart.options.scales.y.ticks.precision = _chartMetric === 'vibration' ? 0 : undefined;
    currentChart.options.scales.y.grid.color = _chartMetric === 'vibration' ?
        'rgba(148, 163, 184, 0.18)' :
        '#374151';

    const overlayDefs = [
        { key: 'tilt', index: 1, label: 'Rollio', yAxisID: 'ySensor', color: CHART_METRICS.tilt.color, dash: [5, 3] },
        { key: 'pitch', index: 2, label: 'Pitch', yAxisID: 'ySensor', color: CHART_METRICS.pitch.color, dash: [2, 3] },
        { key: 'vibration', index: 3, label: 'Vibrazioni', yAxisID: 'yVibration', color: CHART_METRICS.vibration.color, dash: [] }
    ];
    overlayDefs.forEach(def => {
        const ds = currentChart.data.datasets[def.index];
        if (!ds) return;
        ds.label = def.label;
        ds.yAxisID = def.yAxisID;
        ds.borderColor = def.color;
        ds.borderDash = def.dash;
        ds.hidden = !_chartOverlays[def.key] || !(overlayData[def.key]?.length > 0);
        ds.segment = def.key === 'vibration' ? {
            borderColor: context => chartVibrationColor(context.p1?.parsed?.y ?? context.p0?.parsed?.y)
        } : {};
    });

    const showSensorAxis = (_chartOverlays.tilt && (overlayData.tilt?.length || 0) > 0) ||
        (_chartOverlays.pitch && (overlayData.pitch?.length || 0) > 0);
    const showVibrationAxis = _chartOverlays.vibration && (overlayData.vibration?.length || 0) > 0;
    const sensorExt = computeSensorOverlayExtent(overlayData);
    if (currentChart.options.scales.ySensor) {
        currentChart.options.scales.ySensor.display = showSensorAxis;
        currentChart.options.scales.ySensor.suggestedMin = -sensorExt;
        currentChart.options.scales.ySensor.suggestedMax = sensorExt;
    }
    if (currentChart.options.scales.yVibration) {
        currentChart.options.scales.yVibration.display = showVibrationAxis;
    }
    if (currentChart.options.plugins?.legend) {
        currentChart.options.plugins.legend.display = hasActiveOverlayData(overlayData);
    }
}

function formatSpeed(value) {
    return Number.isFinite(value) && value > 0 ? `${value.toFixed(1)} km/h` : '0.0 km/h';
}

function chartVibrationColor(value) {
    return vibrationLevelColor(value, {
        max: 20,
        lowColor: 'rgba(148, 163, 184, 0.62)',
        saturation: 92,
        lightness: 56
    });
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
    const overlayData = {
        tilt: [],
        pitch: [],
        vibration: []
    };
    const surfaceBands = [];
    // Lookup geografico per hover marker: {x, lat, lon}[] — parallelo a chartData
    _chartPointsGeo = [];
    _chartPointIndex = [];
    _chartPointLookup = new Map();
    let cumulativeDist = 0;
    let prevPt = null;
    let prevTimeMs = null;
    let pointIndex = 0;
    let minTimeMs = Infinity;
    let maxTimeMs = -Infinity;
    // Flag: primo segmento assoluto (non inserire separatore prima)
    let isFirstSegment = true;

    // ── Conteggio rapido punti totali e range temporale per il sampling ───────
    // La scansione dei timestamp (Date.parse per punto!) serve solo con asse
    // tempo: con asse distanza viene saltata — su file enormi risparmia decine
    // di ms a ogni ricalcolo.
    const needsTimeScan = _chartXAxis === 'time';
    let pointsTotalEstimate = 0;
    for (let ti = 0; ti < tracks.length; ti++) {
        const t = tracks[ti];
        if (activeTrackId && t.id !== activeTrackId) continue;
        if (t.visible === false) continue;
        for (let si = 0; si < t.segments.length; si++) {
            const s = t.segments[si];
            if (s.visible === false) continue;
            pointsTotalEstimate += s.points.length;
            if (!needsTimeScan) continue;
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
                let currentPitch = null;
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
                if (Number.isFinite(pt.pitch)) {
                    currentPitch = pt.pitch;
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
                } else if (_chartMetric === 'pitch') {
                    pointY = currentPitch;
                } else if (_chartMetric === 'vibration') {
                    pointY = currentVibration;
                }

                // Separatore null tra segmenti: rompe la linea tra segmenti diversi
                // (spanGaps:false per slope/speed/roll/pitch/vibrazione lo rende visivo)
                if (!isFirstSegment && !segSeparatorInserted && Number.isFinite(pointX)) {
                    chartData.push({ x: pointX, y: null });
                    segSeparatorInserted = true;
                }

                let pointMeta = null;
                if (Number.isFinite(pointX)) {
                    const key = pointKey(track.id, seg.id, i);
                    pointMeta = {
                        x: pointX,
                        lat: pt.lat,
                        lon: pt.lon,
                        trackId: track.id,
                        segmentId: seg.id,
                        pointIndex: i,
                        key
                    };
                    _chartPointIndex.push(pointMeta);
                }

                // Sampling inline per il chart — niente array intermedio
                if (pointIndex % chartStep === 0 && Number.isFinite(pointX)) {
                    const meta = pointMeta || {
                        x: pointX,
                        lat: pt.lat,
                        lon: pt.lon,
                        trackId: track.id,
                        segmentId: seg.id,
                        pointIndex: i,
                        key: pointKey(track.id, seg.id, i)
                    };
                    _chartPointsGeo.push(meta);
                    _chartPointLookup.set(meta.key, meta);
                    if (Number.isFinite(pointY)) chartData.push({ x: pointX, y: pointY });
                    if (Number.isFinite(currentTilt)) overlayData.tilt.push({ x: pointX, y: currentTilt });
                    if (Number.isFinite(currentPitch)) overlayData.pitch.push({ x: pointX, y: currentPitch });
                    if (Number.isFinite(currentVibration)) overlayData.vibration.push({ x: pointX, y: currentVibration });
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
        _chartPointsGeo.sort((a, b) => a.x - b.x);
        _chartPointIndex.sort((a, b) => a.x - b.x);
        overlayData.tilt.sort((a, b) => a.x - b.x);
        overlayData.pitch.sort((a, b) => a.x - b.x);
        overlayData.vibration.sort((a, b) => a.x - b.x);
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
        updateChartAppearance(currentChart, overlayData);
        currentChart.$surfaceBands = surfaceBands;
        currentChart.data.labels = [];
        currentChart.data.datasets[0].data = chartData;
        currentChart.data.datasets[1].data = overlayData.tilt;
        currentChart.data.datasets[2].data = overlayData.pitch;
        currentChart.data.datasets[3].data = overlayData.vibration;

        // Scala X: dominio completo + eventuale finestra zoom/pan.
        _setChartFullXRange(axisMax);
        _applyChartXScale(currentChart);

        if (_selectedTrackPoint) {
            const refreshed = buildPointDetail(
                _selectedTrackPoint.trackId,
                _selectedTrackPoint.segmentId,
                _selectedTrackPoint.pointIndex
            );
            if (refreshed) {
                _selectedTrackPoint = refreshed;
                _selectedTrackPointKey = refreshed.key;
                _selectedChartXValue = Number.isFinite(refreshed.x) ? refreshed.x : null;
            }
        }

        // Scala Y contestualizzata: valori bassi non occupano tutta l'altezza
        const yBounds = computeYAxisBounds(_chartMetric, chartData);
        currentChart.options.scales.y.min = yBounds.min;
        currentChart.options.scales.y.max = yBounds.max;
        currentChart.options.scales.y.suggestedMin = yBounds.suggestedMin;
        currentChart.options.scales.y.suggestedMax = yBounds.suggestedMax;

        currentChart.resize();
        currentChart.update('none');
        const emptyEl = document.getElementById('stats-chart-empty');
        if (emptyEl) emptyEl.classList.toggle('hidden', chartData.length > 0);
        renderSelectedPointUi();
    };

    if (chartData.length > 0 || surfaceBands.length > 0 || hasActiveOverlayData(overlayData)) {
        // Chart.js viene caricato solo quando il pannello statistiche viene aperto.
        ensureChart().then(applyChartData);
    } else if (chart) {
        _setChartFullXRange(0);
        chart.$surfaceBands = [];
        chart.data.labels = [];
        chart.data.datasets[0].data = [];
        chart.data.datasets[1].data = [];
        chart.data.datasets[2].data = [];
        chart.data.datasets[3].data = [];
        _applyChartXScale(chart);
        chart.update('none');
        document.getElementById('stats-chart-empty')?.classList.remove('hidden');
        renderSelectedPointUi();
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
