// waypointTypes.js — categorie waypoint condivise tra mappa e pannello GIS

export const TIPI_WAYPOINT = [
    {
        chiave: 'bivacco',
        simbolo: '🏕️',
        sigla: 'T',
        etichetta: 'Campeggio / Bivacco',
        colore: '#16a34a'
    },
    {
        chiave: 'vetta',
        simbolo: '🏔️',
        sigla: '^',
        etichetta: 'Vetta / Punto panoramico',
        colore: '#0f766e'
    },
    {
        chiave: 'acqua',
        simbolo: '🚰',
        sigla: 'A',
        etichetta: "Fonte d'Acqua",
        colore: '#0284c7'
    },
    {
        chiave: 'parcheggio',
        simbolo: '🚗',
        sigla: 'P',
        etichetta: 'Parcheggio',
        colore: '#475569'
    },
    {
        chiave: 'rifugio',
        simbolo: '🏠',
        sigla: 'R',
        etichetta: 'Rifugio / Baita',
        colore: '#b45309'
    },
    {
        chiave: 'pericolo',
        simbolo: '⚠️',
        sigla: '!',
        etichetta: 'Pericolo / Attenzione',
        colore: '#dc2626'
    },
    {
        chiave: 'generico',
        simbolo: '📍',
        sigla: 'WP',
        etichetta: 'Generico',
        colore: '#2563eb'
    }
];

const TIPO_GENERICO = TIPI_WAYPOINT[TIPI_WAYPOINT.length - 1];
const TIPI_PER_SIMBOLO = new Map(TIPI_WAYPOINT.map(tipo => [tipo.simbolo, tipo]));

export function trovaTipoWaypoint(simbolo) {
    return TIPI_PER_SIMBOLO.get(simbolo || TIPO_GENERICO.simbolo) || TIPO_GENERICO;
}
