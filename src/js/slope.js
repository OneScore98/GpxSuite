// Stima robusta della pendenza per tracce campionate molto fitte.
//
// La pendenza non viene calcolata tra due punti consecutivi: la quota del logger
// e' quantizzata al metro e, con punti distanti pochi metri, quel rapporto e'
// inevitabilmente rumoroso. Usiamo invece una regressione locale su una finestra
// di distanza. Prima del calcolo isoliamo anche eventuali guasti barometrici e
// interpoliamo solo la quota derivata: i punti originali non vengono modificati.

const EARTH_RADIUS_M = 6371000;
const DEFAULT_HALF_WINDOW_M = 30;
const MIN_BASELINE_M = 20;
const MIN_ELEVATION_M = -500;
const MAX_ELEVATION_M = 9000;
const BARO_STEP_BASE_M = 20;
const BARO_FAULT_JUMP_M = 500;
const BARO_JUMP_MAX_DISTANCE_M = 100;
const BARO_RECOVERY_M = 120;

function distanceMeters(a, b) {
    const lat1 = Number(a?.lat) * Math.PI / 180;
    const lat2 = Number(b?.lat) * Math.PI / 180;
    const dLat = lat2 - lat1;
    const dLon = (Number(b?.lon) - Number(a?.lon)) * Math.PI / 180;
    if (![lat1, lat2, dLat, dLon].every(Number.isFinite)) return 0;
    const sinLat = Math.sin(dLat / 2);
    const sinLon = Math.sin(dLon / 2);
    const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
    return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function isLoggerSeries(points) {
    const samples = Math.min(points.length, 32);
    for (let i = 0; i < samples; i++) {
        const point = points[Math.floor(i * (points.length - 1) / Math.max(1, samples - 1))];
        if (Number.isFinite(point?.seq) || Number.isFinite(point?.pitch) || Number.isFinite(point?.tilt)) return true;
    }
    return false;
}

function interpolateInvalidElevations(values, valid, cumulative) {
    const n = values.length;
    let firstValid = -1;
    for (let i = 0; i < n; i++) {
        if (valid[i]) { firstValid = i; break; }
    }
    if (firstValid < 0) return;

    for (let i = 0; i < firstValid; i++) values[i] = values[firstValid];
    let left = firstValid;
    while (left < n) {
        let right = left + 1;
        while (right < n && !valid[right]) right++;
        if (right >= n) {
            for (let i = left + 1; i < n; i++) values[i] = values[left];
            break;
        }
        const span = cumulative[right] - cumulative[left];
        for (let i = left + 1; i < right; i++) {
            const ratio = span > 0 ? (cumulative[i] - cumulative[left]) / span : (i - left) / (right - left);
            values[i] = values[left] + (values[right] - values[left]) * ratio;
        }
        left = right;
    }
}

function sanitizeElevations(points, cumulative) {
    const n = points.length;
    const values = new Float64Array(n);
    const valid = new Uint8Array(n);
    const repaired = new Uint8Array(n);
    const loggerSeries = isLoggerSeries(points);
    let lastGood = -1;
    let baroFault = false;
    let faultAnchor = NaN;
    let baroCorrection = 0;

    for (let i = 0; i < n; i++) {
        const elevation = Number(points[i]?.ele);
        values[i] = elevation + baroCorrection;
        const absoluteValid = Number.isFinite(elevation)
            && elevation >= MIN_ELEVATION_M
            && elevation <= MAX_ELEVATION_M;
        if (!absoluteValid) {
            if (loggerSeries && lastGood >= 0) {
                baroFault = true;
                faultAnchor = values[lastGood];
            }
            continue;
        }

        if (loggerSeries && lastGood >= 0 && !baroFault) {
            const horizontal = cumulative[i] - cumulative[lastGood];
            const delta = values[i] - values[lastGood];
            if (horizontal <= BARO_JUMP_MAX_DISTANCE_M
                && Math.abs(delta) > BARO_STEP_BASE_M + horizontal) {
                if (Math.abs(delta) <= BARO_FAULT_JUMP_M) {
                    // Salto di riferimento del barometro: riallinea la coda
                    // senza inventare una rampa verticale tra due punti vicini.
                    baroCorrection -= delta;
                    values[i] = elevation + baroCorrection;
                    repaired[i] = 1;
                } else {
                    baroFault = true;
                    faultAnchor = values[lastGood];
                }
            }
        }

        if (baroFault) {
            // Un campione QMP non valido puo' generare un'intera coda di quote
            // in discesa da decine di km. La serie torna valida solo quando si
            // riavvicina all'ultima quota certamente buona.
            if (Math.abs(values[i] - faultAnchor) > BARO_RECOVERY_M) continue;
            baroFault = false;
        }

        valid[i] = 1;
        if (baroCorrection !== 0) repaired[i] = 1;
        lastGood = i;
    }

    // Un controllo anche a ritroso elimina picchi o code isolate agli estremi,
    // senza imporre limiti geografici alle normali salite lunghe.
    if (loggerSeries) {
        let nextGood = -1;
        for (let i = n - 1; i >= 0; i--) {
            if (!valid[i]) continue;
            if (nextGood >= 0) {
                const horizontal = cumulative[nextGood] - cumulative[i];
                if (horizontal <= BARO_JUMP_MAX_DISTANCE_M
                    && Math.abs(values[i] - values[nextGood]) > BARO_FAULT_JUMP_M + horizontal) {
                    valid[i] = 0;
                    repaired[i] = 1;
                    continue;
                }
            }
            nextGood = i;
        }
    }

    interpolateInvalidElevations(values, valid, cumulative);
    return { values, valid, repaired };
}

function pitchToGrade(pitchDegrees) {
    const pitch = Number(pitchDegrees);
    if (!Number.isFinite(pitch) || Math.abs(pitch) > 45) return NaN;
    return Math.tan(pitch * Math.PI / 180) * 100;
}

/**
 * Restituisce array tipizzati, uno per punto:
 * - elevations: quota ripulita e smussata usata solo per la visualizzazione
 * - slopes: pendenza percentuale geografica; fallback IMU solo senza baseline
 * - slopeSources: 1=altimetria robusta, 2=pitch IMU, 0=non disponibile
 * - pitchGrades: conversione geometrica tan(pitch)*100, sempre separata
 */
export function computeSlopeProfile(points, options = {}) {
    const n = Array.isArray(points) ? points.length : 0;
    const cumulative = new Float64Array(n);
    const slopes = new Float64Array(n);
    const elevations = new Float64Array(n);
    const pitchGrades = new Float64Array(n);
    const slopeSources = new Uint8Array(n);
    slopes.fill(NaN);
    elevations.fill(NaN);
    pitchGrades.fill(NaN);
    if (!n) return { cumulative, elevations, slopes, slopeSources, pitchGrades, repairedCount: 0 };

    for (let i = 1; i < n; i++) cumulative[i] = cumulative[i - 1] + distanceMeters(points[i - 1], points[i]);
    const sanitized = sanitizeElevations(points, cumulative);
    let repairedCount = 0;
    for (let i = 0; i < n; i++) {
        elevations[i] = sanitized.values[i];
        if (!sanitized.valid[i] || sanitized.repaired[i]) repairedCount++;
        pitchGrades[i] = pitchToGrade(points[i]?.pitch);
    }

    const halfWindow = Number.isFinite(options.halfWindowM)
        ? Math.max(10, options.halfWindowM)
        : DEFAULT_HALF_WINDOW_M;
    const prefixY = new Float64Array(n + 1);
    const prefixX = new Float64Array(n + 1);
    const prefixXX = new Float64Array(n + 1);
    const prefixXY = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
        const x = cumulative[i];
        const y = elevations[i];
        prefixX[i + 1] = prefixX[i] + x;
        prefixY[i + 1] = prefixY[i] + y;
        prefixXX[i + 1] = prefixXX[i] + x * x;
        prefixXY[i + 1] = prefixXY[i] + x * y;
    }

    let left = 0;
    let right = 0;
    const smoothed = new Float64Array(n);
    smoothed.set(elevations);
    for (let i = 0; i < n; i++) {
        while (left < i && cumulative[left] < cumulative[i] - halfWindow) left++;
        if (right < i) right = i;
        while (right + 1 < n && cumulative[right + 1] <= cumulative[i] + halfWindow) right++;
        const count = right - left + 1;
        const baseline = cumulative[right] - cumulative[left];
        if (count >= 3 && baseline >= MIN_BASELINE_M) {
            const sumX = prefixX[right + 1] - prefixX[left];
            const sumY = prefixY[right + 1] - prefixY[left];
            const sumXX = prefixXX[right + 1] - prefixXX[left];
            const sumXY = prefixXY[right + 1] - prefixXY[left];
            const denominator = count * sumXX - sumX * sumX;
            if (Math.abs(denominator) > 1e-6) {
                const beta = (count * sumXY - sumX * sumY) / denominator;
                const intercept = (sumY - beta * sumX) / count;
                const grade = beta * 100;
                if (Number.isFinite(grade) && Math.abs(grade) <= 200) {
                    slopes[i] = grade;
                    slopeSources[i] = 1;
                    smoothed[i] = intercept + beta * cumulative[i];
                }
            }
        }
    }
    elevations.set(smoothed);

    // Il pitch e' utile su una traccia molto corta, ma resta riconoscibile come
    // fallback: accelerazioni/frenate e montaggio possono inclinarlo senza che
    // la strada abbia la stessa pendenza.
    if (options.pitchFallback !== false && isLoggerSeries(points)) {
        for (let i = 0; i < n; i++) {
            if (!Number.isFinite(slopes[i]) && Number.isFinite(pitchGrades[i])) {
                slopes[i] = pitchGrades[i];
                slopeSources[i] = 2;
            }
        }
    }

    return { cumulative, elevations, slopes, slopeSources, pitchGrades, repairedCount };
}
