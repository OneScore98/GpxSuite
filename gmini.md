# GeoViewer 3D - Pro GPX Suite & Print Studio

**Documentazione di Progetto (gmini.md)**

Questo documento fornisce una visione dettagliata dell'architettura, delle librerie e delle dinamiche di stato utilizzate nella suite *GeoViewer 3D*.

---

## 1. Stack Tecnologico

Il progetto si fonda su un'architettura **Vanilla JavaScript** racchiusa in un singolo file (`index.html`), progettato per essere ultra-portabile, rapido e senza dipendenze build-step.

- **Mappa e GIS Rendering**: `MapLibre GL JS` (Rendering WebGL vettoriale, supporta il terreno 3D)
- **Calcoli Geospaziali**: `Turf.js` (Usato per calcolare distanze, aree, intersezioni e semplificazioni geometriche)
- **Visualizzazione Dati**: `Chart.js` (Rendering dinamico del profilo altimetrico e della pendenza)
- **Stile & UI**: `Tailwind CSS` via CDN (Per la costruzione dell'interfaccia utente tramite classi utility)
- **Iconografia**: `Lucide Icons` (Libreria leggera di icone SVG)
- **Routing**: `OSRM` (Open Source Routing Machine) richiamato per lo "snap-to-road" dei percorsi escursionistici o veicolari.
- **Geocoding**: `Nominatim` di OpenStreetMap per la ricerca di località.

---

## 2. Struttura dello Stato GIS Globale

L'applicazione gestisce un "Memory Store" in variabili globali, il quale simula un albero geospaziale (GIS Tree):

```javascript
// Struttura tipica della variabile globale "tracks"
[
  {
    id: "track_1234",
    name: "Traccia Dolomiti",
    desc: "...",
    color: "#3b82f6",
    width: 3,
    visible: true,
    waypointsVisible: true,
    segments: [
      {
        id: "seg_1",
        name: "Tracciato 1",
        points: [ { lat, lon, ele, isUserClicked: true }, ... ]
      }
    ],
    waypoints: [
      {
        id: "wp_123", name: "Rifugio", lat: 46.5, lon: 12.0, ele: 2000, symbol: "🏠", visible: true
      }
    ]
  }
]
```

Tutte le entità (Tracce, Segmenti, Waypoint) comunicano tra di loro, e l'interfaccia si aggiorna dinamicamente chiamando funzioni centralizzate come `updateMapData()` e `renderGisTree()`. 

È supportato il salvataggio progressivo in una variabile `undoStack` per implementare lo standard "CTRL+Z".

---

## 3. Motore di Stampa Avanzato

Una delle funzionalità più sofisticate dell'applicazione è il modulo di stampa topografica. 
Il flusso si divide in:
1. **Pianificazione**: Una griglia virtuale (A4, 1x1, 2x2, ecc.) appare sopra l'interfaccia. Tramite eventi touch e mouse (ottimizzati usando `requestAnimationFrame`), l'utente definisce la zona di stampa.
2. **Cattura Screenshot (MapLibre)**: Attraverso l'uso del flag `preserveDrawingBuffer: true`, il sistema effettua uno *screen-capture* reale del buffer WebGL. L'applicazione utilizza i listener sull'evento `idle` per spostare la mappa sotto ciascun riquadro virtuale e assicurarsi che le tile raster e 3D siano interamente caricate prima dello scatto.
3. **Paginazione**: Le immagini catturate vengono composte tramite codice DOM iniettando blocchi HTML formattati per le regole CSS `@media print`, nascondendo la UI web e mostrando soltanto i template cartografici impaginati, completi di statistiche.

---

## 4. Ottimizzazioni di Performance Presenti

- **Douglas-Peucker Algorithm**: Durante l'esportazione GPX, il codice riduce dinamicamente i punti troppo ravvicinati sulla medesima linea per minimizzare la dimensione del file e limitare lo stress lato parsing di terze parti.
- **WebWorkers e GeoJSON-VT**: È stato rimosso l'ascoltatore sul `zoomend` per il rendering. I file enormi (es. 100.000 punti) sono ora passati direttamente alla GPU, demandando la semplificazione visiva e la tassellatura ai WebWorkers nativi di MapLibre GL per una visualizzazione fluida.
- **Matematica Raw (Haversine)**: Le iterazioni sui punti GPX (calcoli di statistiche, pendenze e distanze) usano una formula di Haversine nativa invece di creare oggetti temporanei, risparmiando centinaia di migliaia di allocazioni in memoria e garantendo un calcolo fluido senza micro-lag.

---

## 5. Gestione Avanzata dei Livelli (Layer Management)

L'applicativo implementa un sistema di visibilità gerarchica per ottimizzare il rendering e l'analisi dei dati, rispondendo all'esigenza di una gestione pulita e granulare dei livelli:
- **Toggle Visibilità Tracce e Segmenti**: Tramite la GIS Tree (barra laterale destra), l'utente può nascondere o mostrare i singoli elementi usando l'apposito pulsante (icona "occhio").
- **Gruppo Waypoint per Traccia**: Tutti i waypoint sono strutturalmente raggruppati all'interno della traccia di appartenenza e possiedono, oltre alla visibilità singola, un comando di gruppo per accenderli o nasconderli collettivamente (`waypointsVisible`).
- **Filtro Real-Time**: Disattivando la visibilità di un layer, la funzione `updateMapData()` omette la compilazione delle feature relative. Questo riduce istantaneamente il carico sulla GPU di MapLibre e lo stress sul ciclo JS.
- **Analisi Dinamica e Statistiche**: Le statistiche (distanza, dislivello, grafici altimetrici e superficie) escludono rigorosamente i livelli nascosti. Questo permette di confrontare varianti di percorso isolando visivamente e analiticamente solo i segmenti di interesse. Le tracce nascoste risulteranno depotenziate (opacità ridotta/sbarrate) anche nei tab di selezione rapida.
