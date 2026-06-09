// gpx-parser.worker.js — Parsing GPX in background thread.
// Riceve un messaggio { xmlText, fileName } e risponde con la struttura
// { segments: [...], waypoints: [...], firstPoint: {lat,lon} } pronta per
// essere agganciata a un newTrack lato main.
//
// Perché un Worker:
//   DOMParser su un file GPX di decine di MB blocca completamente l'UI per
//   diversi secondi (tutto il parsing + l'iterazione dei nodi avviene sincrono).
//   Spostandolo qui il main thread resta libero per rendering mappa e UI.

self.onmessage = function(e) {
    const { xmlText, fileName } = e.data;
    try {
        const result = parseGpx(xmlText, fileName);
        self.postMessage({ ok: true, result });
    } catch (err) {
        self.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
    }
};

function readSensorExtensions(node) {
    const result = {};
    const fields = [
        { tag: 'tilt',      prefixed: 'gpxsuite:tilt',      key: 'tilt' },
        { tag: 'pitch',     prefixed: 'gpxsuite:pitch',     key: 'pitch' },
        { tag: 'vibration', prefixed: 'gpxsuite:vibration', key: 'vibrationLevel' }
    ];
    for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        const el = node.getElementsByTagName(f.prefixed)[0] ||
                   node.getElementsByTagName(f.tag)[0] ||
                   (typeof node.getElementsByTagNameNS === 'function' ? node.getElementsByTagNameNS('*', f.tag)[0] : null);
        if (el && el.textContent) {
            const val = parseFloat(el.textContent);
            if (Number.isFinite(val)) result[f.key] = val;
        }
    }
    return result;
}

function readSurfaceExtension(node) {
    const direct = node.getElementsByTagName("surface")[0];
    if (direct && direct.textContent) return direct.textContent.trim();

    if (typeof node.getElementsByTagNameNS === 'function') {
        const namespaced = node.getElementsByTagNameNS('*', 'surface')[0];
        if (namespaced && namespaced.textContent) return namespaced.textContent.trim();
    }

    const prefixed = node.getElementsByTagName("gpxsuite:surface")[0];
    return prefixed && prefixed.textContent ? prefixed.textContent.trim() : '';
}

function parseGpx(xmlText, fileName) {
    // DOMParser è disponibile nei DedicatedWorker dei browser moderni
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, "text/xml");

    // Verifica errori di parsing
    const parserError = xmlDoc.getElementsByTagName("parsererror");
    if (parserError.length > 0) {
        throw new Error("XML malformato: " + parserError[0].textContent.substring(0, 200));
    }

    const segments = [];
    const waypoints = [];
    let firstPoint = null;
    let totalPoints = 0;

    const baseId = Date.now();

    // ── Tracce / segmenti / punti ─────────────────────────────────────────────
    const trkNodes = xmlDoc.getElementsByTagName("trk");
    for (let i = 0; i < trkNodes.length; i++) {
        const trkNode = trkNodes[i];
        const nameNode = trkNode.getElementsByTagName("name")[0];
        const trkName = nameNode ? nameNode.textContent : `Tracciato ${i + 1}`;
        const segNodes = trkNode.getElementsByTagName("trkseg");

        for (let j = 0; j < segNodes.length; j++) {
            const segNode = segNodes[j];
            const ptNodes = segNode.getElementsByTagName("trkpt");
            const n = ptNodes.length;
            // Pre-alloca l'array: evita reallocazioni su segmenti enormi
            const parsedPoints = new Array(n);

            for (let k = 0; k < n; k++) {
                const pt = ptNodes[k];
                const lat = parseFloat(pt.getAttribute("lat"));
                const lon = parseFloat(pt.getAttribute("lon"));
                const eleNode = pt.getElementsByTagName("ele")[0];
                const ele = eleNode ? parseFloat(eleNode.textContent) : 0;
                const timeNode = pt.getElementsByTagName("time")[0];
                const time = timeNode ? Date.parse(timeNode.textContent) : NaN;
                const surface = readSurfaceExtension(pt);
                const sensors = readSensorExtensions(pt);
                parsedPoints[k] = { lat, lon, ele, isUserClicked: false };
                if (Number.isFinite(time)) parsedPoints[k].time = time;
                if (surface) {
                    parsedPoints[k].surface = surface;
                    parsedPoints[k].surfaceFromPrev = surface;
                }
                if (Number.isFinite(sensors.tilt)) parsedPoints[k].tilt = sensors.tilt;
                if (Number.isFinite(sensors.pitch)) parsedPoints[k].pitch = sensors.pitch;
                if (Number.isFinite(sensors.vibrationLevel)) parsedPoints[k].vibrationLevel = sensors.vibrationLevel;

                if (firstPoint === null) firstPoint = { lat, lon };
            }
            totalPoints += n;

            segments.push({
                id: 'seg_' + baseId + `_${i}_${j}`,
                name: `${trkName} (Seg ${j + 1})`,
                points: parsedPoints,
                visible: true
            });

            // Notifica progresso ogni segmento — utile per file con molti segmenti
            self.postMessage({ progress: true, totalPoints });
        }
    }

    // ── Waypoint ──────────────────────────────────────────────────────────────
    const wptNodes = xmlDoc.getElementsByTagName("wpt");
    for (let i = 0; i < wptNodes.length; i++) {
        const wptNode = wptNodes[i];
        const lat = parseFloat(wptNode.getAttribute("lat"));
        const lon = parseFloat(wptNode.getAttribute("lon"));
        const nameNode = wptNode.getElementsByTagName("name")[0];
        const descNode = wptNode.getElementsByTagName("desc")[0];
        const eleNode  = wptNode.getElementsByTagName("ele")[0];

        waypoints.push({
            id: 'wp_imp_' + baseId + `_${i}`,
            name: nameNode ? nameNode.textContent : `Imported WP ${i + 1}`,
            desc: descNode ? descNode.textContent : '',
            symbol: '📍',
            lat, lon,
            ele: eleNode ? parseFloat(eleNode.textContent) : 0,
            visible: true
        });
    }

    return {
        fileName,
        segments,
        waypoints,
        firstPoint,
        totalPoints
    };
}
