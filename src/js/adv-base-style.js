// ADV usa solo i campi verificati dello schema OpenMapTiles 3.16.
// surface nelle tessere è aggregato: paved / unpaved; nessun materiale è dedotto.
export function createAdventureBaseMapStyle(sorgente) {
    const strati = [{ id: 'adv-background', type: 'background', paint: { 'background-color': '#F4F1E8' } }];
    const area = (id, livello, filtro, colore, opacita = 1) => strati.push({
        id: `adv-${id}`, type: 'fill', source: 'openmaptiles', 'source-layer': livello,
        ...(filtro ? { filter: filtro } : {}), paint: { 'fill-color': colore, 'fill-opacity': opacita }
    });
    area('residential', 'landuse', ['==', ['get', 'class'], 'residential'], '#E8E4DC');
    area('park', 'park', null, '#E0E8CB', 0.45);
    area('grass', 'landcover', ['match', ['get', 'class'], ['grass', 'farmland'], true, false], '#E0E8CB');
    area('wood', 'landcover', ['==', ['get', 'class'], 'wood'], '#C8D8B6');
    area('rock', 'landcover', ['==', ['get', 'class'], 'rock'], '#D9D5CD');
    area('water', 'water', ['!=', ['get', 'brunnel'], 'tunnel'], '#9FCADB');
    area('building', 'building', null, '#D8D3C9', 0.65);
    strati[strati.length - 1].minzoom = 14;
    strati.push({
        id: 'adv-waterway', type: 'line', source: 'openmaptiles', 'source-layer': 'waterway',
        paint: { 'line-color': '#9FCADB', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 16, 2.3] }
    });

    const coloreFondo = ['match', ['get', 'surface'], 'paved', '#59616A', 'unpaved', '#A17A43', '#858780'];
    const gruppi = [
        { id: 'principal', classi: ['motorway', 'trunk', 'primary'], zoom: 4, larghezza: [0.8, 2.8, 8] },
        { id: 'secondary', classi: ['secondary', 'tertiary'], zoom: 8, larghezza: [0.5, 2.0, 6] },
        { id: 'local', classi: ['minor', 'service'], zoom: 12, larghezza: [0.3, 1.5, 4.5] },
        { id: 'track', classi: ['track'], zoom: 12, larghezza: [0.4, 2, 4.5], tratto: [3, 1.2] },
        // Pedonale, footway e cycleway sono subclass di path, non classi autonome.
        { id: 'path', classi: ['path'], zoom: 13, larghezza: [0.2, 0.9, 2], tratto: [1, 2], opacita: 0.66 }
    ];
    for (const gruppo of gruppi) {
        const filtro = ['all', ['==', ['geometry-type'], 'LineString'],
            ['match', ['get', 'class'], gruppo.classi, true, false]];
        const larghezza = extra => ['interpolate', ['exponential', 1.2], ['zoom'],
            6, gruppo.larghezza[0] + extra, 14, gruppo.larghezza[1] + extra, 19, gruppo.larghezza[2] + extra];
        strati.push({
            id: `adv-road-${gruppo.id}-casing`, type: 'line', source: 'openmaptiles', 'source-layer': 'transportation',
            minzoom: gruppo.zoom, filter: filtro, layout: { 'line-cap': 'butt', 'line-join': 'round' },
            paint: { 'line-color': '#FFFCF3', 'line-width': larghezza(1.5), 'line-opacity': gruppo.opacita || 1 }
        }, {
            id: `adv-road-${gruppo.id}`, type: 'line', source: 'openmaptiles', 'source-layer': 'transportation',
            minzoom: gruppo.zoom, filter: filtro, layout: { 'line-cap': 'butt', 'line-join': 'round' },
            paint: {
                'line-color': coloreFondo, 'line-width': larghezza(0), 'line-opacity': gruppo.opacita || 1,
                ...(gruppo.tratto ? { 'line-dasharray': gruppo.tratto } : {})
            }
        });
    }
    for (const [id, livello, zoom, dimensione] of [
        ['road-label', 'transportation_name', 13, 11], ['place-label', 'place', 3, 13]
    ]) {
        strati.push({
            id: `adv-${id}`, type: 'symbol', source: 'openmaptiles', 'source-layer': livello, minzoom: zoom,
            ...(livello === 'place' ? { filter: ['match', ['get', 'class'], ['city', 'town', 'village', 'hamlet', 'country', 'state'], true, false] } : {}),
            layout: {
                ...(livello === 'transportation_name' ? { 'symbol-placement': 'line' } : {}),
                'text-field': ['coalesce', ['get', 'name:it'], ['get', 'name'], ['get', 'ref'], ''],
                'text-font': ['Noto Sans Regular'], 'text-size': dimensione, 'text-max-width': 9
            },
            paint: { 'text-color': '#3F433B', 'text-halo-color': '#F4F1E8', 'text-halo-width': 1.5 }
        });
    }
    return {
        version: 8, glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
        sources: { openmaptiles: sorgente }, layers: strati
    };
}
