# codex.md

Guida operativa estremamente dettagliata per lavorare su **GpxSuite** con Codex.

Questo documento descrive come leggere, modificare, verificare e mantenere il progetto senza rompere i vincoli principali dell'applicazione. Va considerato una guida pratica per interventi futuri: prima di modificare codice, leggere le sezioni pertinenti e rispettare l'architettura esistente.

---

## 1. Identita del progetto

**Nome applicazione:** GpxSuite

**Scopo:** applicazione web per:

- importare file GPX;
- creare nuove tracce manualmente;
- disegnare segmenti su mappa;
- usare snap-to-road tramite routing esterno;
- tagliare tracce;
- eliminare punti in un'area rettangolare;
- gestire waypoint;
- visualizzare mappa 2D e terreno 3D;
- consultare profilo altimetrico e statistiche;
- pianificare e generare anteprime di stampa topografica A4;
- salvare stato e libreria locale nel browser;
- proteggere l'accesso tramite Supabase Auth, blocco dispositivi e dashboard amministratore.

**Lingua del codice e dell'interfaccia:** italiano.

Usare italiano per:

- testo visibile in UI;
- messaggi toast;
- titoli modali;
- nomi di azioni utente;
- commenti aggiunti nel codice;
- nomi di nuove funzioni o variabili quando coerente con lo stile locale.

Sono presenti nomi tecnici inglesi o misti per API, librerie, eventi browser, oggetti standard e compatibilita storica. Non rinominarli per "pulizia" se non richiesto.

---

## 2. Regola fondamentale: progetto zero-build

Il progetto e una web app **senza build step**.

Non introdurre:

- bundler;
- Vite;
- Webpack;
- Rollup;
- package manager obbligatorio per il frontend;
- transpiler;
- framework SPA;
- TypeScript nel frontend esistente;
- import da pacchetti locali `node_modules`;
- dipendenze che richiedono installazione per usare l'app.

Il frontend usa:

- HTML statico;
- CSS statico;
- JavaScript nativo con ES modules;
- librerie caricate via CDN.

La pagina principale e `index.html`. Il codice applicativo vive in `src/js/`. Gli stili custom vivono in `src/css/style.css`.

Per provare l'app:

```bash
python3 -m http.server 8080
```

Poi aprire:

```text
http://localhost:8080
```

Esiste anche `avvia.command`, che apre `http://localhost:8080` e avvia `python3 -m http.server 8080` dalla cartella del progetto.

Nota importante: l'app e stata refattorizzata da una vecchia forma monolitica in una struttura modulare. Non suggerire e non applicare un ritorno a un singolo `index.html`.

---

## 3. Stack tecnologico effettivo

Tutto il frontend operativo viene caricato via CDN o browser API.

### Librerie frontend

- **MapLibre GL JS 3.6.2**
  - rendering WebGL;
  - mappa raster OSM;
  - layer vettoriali GeoJSON;
  - terreno 3D tramite raster DEM;
  - capture canvas per stampa.

- **Tailwind CSS**
  - classi utility direttamente nel markup HTML generato staticamente e dinamicamente;
  - non c'e pipeline Tailwind locale;
  - gli stili custom restano in `src/css/style.css`.

- **Lucide Icons**
  - icone SVG dichiarate con `data-lucide`;
  - dopo HTML dinamico chiamare `refreshLucideIcons()` o affidarsi ai flussi esistenti.

- **Chart.js**
  - profilo altimetrico;
  - grafico pendenza/elevazione;
  - inizializzazione lazy in `stats.js`.

- **Turf.js**
  - disponibile per calcoli GIS dove gia usato o dove serve davvero;
  - non sostituire loop hot-path con Turf.

- **Supabase JS 2**
  - caricato dinamicamente da `https://esm.sh/@supabase/supabase-js@2`;
  - usato da `auth.js`;
  - nessun secret deve finire nel frontend.

- **Mapillary JS 4.1.2**
  - caricato lazy solo se necessario;
  - usato dal viewer Mapillary in `map.js`;
  - CSS e JS caricati tramite helper `loadStylesheetOnce()` e `loadScriptOnce()`.

### API esterne

- **OpenStreetMap tile server**
  - layer base OSM raster.

- **Waymarked Trails**
  - overlay sentieri hiking.

- **Nextzen/AWS Terrarium DEM**
  - sorgente elevazione;
  - usata sia per terreno MapLibre sia per query altimetriche puntuali.

- **BRouter**
  - primo candidato per snap-to-road in alcuni profili.

- **OSRM**
  - fallback o provider per routing foot/bike/car/moto.

- **Nominatim**
  - ricerca luoghi.

- **Overpass API**
  - analisi offroad in `ui.js`.

- **Mapillary Graph API e vector tiles**
  - copertura immagini e viewer immagini.

---

## 4. Struttura file

```text
GPXSuite/
  index.html
  codex.md
  AGENTS.md
  CLAUDE.md
  gmini.md
  avvia.command
  favicon.svg
  apple-touch-icon.png
  test.gpx
  src/
    css/
      style.css
    js/
      auth-config.js
      auth.js
      gpx.js
      main.js
      map.js
      print.js
      state.js
      stats.js
      storage.js
      tracks.js
      ui.js
      utils.js
      waypoints.js
      workers/
        gpx-parser.worker.js
  supabase/
    README.md
    schema.sql
    migrations/
      20260602120000_gpxsuite_auth_admin.sql
      20260602143000_fix_pgcrypto_search_path.sql
    functions/
      gpxsuite-admin-users/
        index.ts
```

### `index.html`

Contiene:

- `head` con meta, favicon, preconnect, preload CDN;
- caricamento MapLibre CSS/JS;
- caricamento `src/css/style.css`;
- patch sandbox per `window.parent` quando l'app gira in contesti Blob/sandbox;
- markup del gate autenticazione;
- contenitore mappa `#map`;
- toolbar sinistra;
- pannelli principali;
- sidebar GIS;
- pannelli statistiche, stampa, Mapillary e admin;
- script finale `type="module"` verso `src/js/main.js`.

Regola: mantenere `index.html` principalmente come markup e dichiarazione dipendenze. La logica applicativa deve stare nei moduli JS.

### `src/css/style.css`

Contiene:

- variabili viewport e safe-area;
- dimensionamento full-screen mappa;
- blocco UI durante auth;
- stili admin dashboard;
- layout Mapillary viewer;
- compattazione GIS tree;
- scrollbar;
- griglia di stampa trascinabile;
- regole responsive;
- regole `@media print`;
- classi custom non Tailwind.

Regola: se una cosa e un comportamento dinamico, va in JS; se e presentazione stabile o print CSS, va qui.

### `src/js/state.js`

Single source of truth per stato globale mutabile.

Contiene:

- costanti endpoint;
- riferimenti principali (`map`, `chart`);
- stato mappa;
- stato GPX/GIS;
- stato editor;
- stato snapping;
- stato waypoint;
- stato stampa;
- setter per mutazioni cross-module.

Non redeclarare in altri moduli variabili gia esportate da `state.js`.

### `src/js/main.js`

Entry point.

Responsabilita:

- importa tutti i moduli;
- esegue `injectDeps()` per risolvere dipendenze circolari di `ui.js`;
- espone su `window` le funzioni usate da handler inline generati dinamicamente;
- calcola metriche viewport;
- inizializza auth gate;
- crea istanza MapLibre;
- configura gesture 3D;
- registra persistenza su `moveend`, `pagehide`, `visibilitychange`;
- inizializza layer, eventi, storage, UI e analytics dopo `map.load`.

### `src/js/map.js`

Responsabilita:

- setup layer MapLibre;
- costruzione GeoJSON tracce;
- rendering waypoint tramite funzioni di `waypoints.js`;
- cache multi-LOD per grandi GPX;
- cambio basemap;
- cambio 2D/3D;
- terreno DEM;
- query elevazione;
- overlay hiking;
- Mapillary coverage;
- Mapillary viewer;
- ordinamento layer applicativi sopra la mappa base;
- aggiornamento box delete preview;
- aggiornamento statistiche dopo refresh dati.

E uno dei moduli piu sensibili: modificare con cautela.

### `src/js/stats.js`

Responsabilita:

- inizializzare Chart.js;
- calcolare statistiche;
- aggiornare profilo altimetrico;
- calcolare distanza Haversine;
- ignorare tracce/segmenti nascosti nelle statistiche.

Regola: i loop Haversine sono hot-path. Non sostituirli con oggetti Turf in massa.

### `src/js/tracks.js`

Responsabilita:

- creazione punti nel segmento attivo;
- snap-to-road;
- fallback routing;
- undo history;
- taglio tracce;
- eliminazione punti in box;
- profilo snapping;
- persistenza dopo mutazioni.

Regola: prima di mutazioni distruttive chiamare `saveHistoryState()`, salvo flussi gia gestiti.

### `src/js/waypoints.js`

Responsabilita:

- creazione waypoint;
- layer waypoint MapLibre;
- clustering o sorgente GeoJSON waypoint;
- interazioni drag/click;
- editor waypoint;
- salvataggio modifiche waypoint;
- refresh waypoint su mappa.

I waypoint appartengono a una traccia. Non creare uno store waypoint separato.

### `src/js/gpx.js`

Responsabilita:

- import GPX;
- parsing tramite Web Worker;
- fallback parsing inline con yield;
- export GPX;
- semplificazione Douglas-Peucker iterativa.

Regola: il Worker e intenzionale. Non riportare parsing pesante sul main thread.

### `src/js/workers/gpx-parser.worker.js`

Dedicated Worker per parsing GPX.

Riceve:

```javascript
{ xmlText, fileName }
```

Risponde con:

```javascript
{ ok: true, result }
```

o:

```javascript
{ ok: false, error }
```

Durante parsing puo inviare messaggi di progresso:

```javascript
{ progress: true, totalPoints }
```

### `src/js/print.js`

Responsabilita:

- modalita pianificazione stampa;
- griglia A4 trascinabile;
- dimensioni/orientamento/scala;
- cattura mappa ad alta risoluzione;
- attesa `idle` MapLibre;
- composizione pagine A4;
- sincronizzazione anteprima/output stampa.

Regola: non rompere `preserveDrawingBuffer` e non rimuovere l'attesa mappa ferma/idle.

### `src/js/ui.js`

Responsabilita:

- dependency injection;
- setup eventi DOM;
- gestione menu;
- gestione GIS tree;
- selezione tracce/segmenti;
- drag and drop nel GIS tree;
- menu contestuali;
- copia/taglia/incolla/duplica/elimina selezione;
- rinomina inline;
- visibilita tracce/segmenti/waypoint;
- creazione nuove tracce/segmenti;
- focus/zoom;
- libreria locale;
- ricerca Nominatim;
- analisi offroad Overpass;
- toast;
- header tracce attive;
- layout mobile/backdrop.

E il modulo piu ampio e contiene sia UI sia molte operazioni utente ad alto livello.

### `src/js/storage.js`

Responsabilita:

- IndexedDB locale per tracce;
- snapshot sessione in `localStorage`;
- debounce salvataggi;
- restore ultimo stato;
- lista libreria locale;
- apertura/cancellazione tracce salvate;
- evento custom `gpxsuite:local-library-changed`.

### `src/js/auth-config.js`

Configurazione pubblica Supabase:

- `AUTH_REQUIRED`;
- `SUPABASE_URL`;
- `SUPABASE_PUBLISHABLE_KEY`;
- `ADMIN_USERS_FUNCTION_URL`.

Non inserire mai service role key o segreti.

### `src/js/auth.js`

Responsabilita:

- gate login;
- password login;
- magic link;
- reset password;
- sessione Supabase;
- completamento login tramite RPC;
- device key locale;
- blocco dispositivo;
- logout;
- pannello account;
- dashboard admin;
- analytics eventi.

### `src/js/utils.js`

Responsabilita:

- escape XML;
- caricamento script/style una sola volta;
- refresh/ensure Lucide;
- distanza perpendicolare;
- colori distinti tracce.

Regola: qui mettere solo utility pure o quasi-pure e riutilizzabili.

### `supabase/`

Backend gestito:

- schema SQL;
- migrazioni;
- funzione Edge per creazione utenti da dashboard admin.

Il frontend resta hostabile staticamente, ma auth/admin richiedono Supabase configurato.

---

## 5. Modello dati principale

Lo stato GIS principale e `tracks`, esportato da `state.js`.

Forma attesa:

```javascript
{
  id: "track_...",
  name: "Nome traccia",
  desc: "",
  color: "#3b82f6",
  width: 3,
  visible: true,
  waypointsVisible: true,
  localFileId: "local_...",
  localCreatedAt: 1710000000000,
  localUpdatedAt: 1710000000000,
  localSource: "created",
  segments: [
    {
      id: "seg_...",
      name: "Tracciato 1",
      visible: true,
      points: [
        {
          lat: 46.123456,
          lon: 11.123456,
          ele: 1200,
          isUserClicked: true,
          needsElevation: false
        }
      ]
    }
  ],
  waypoints: [
    {
      id: "wp_...",
      name: "Rifugio",
      desc: "",
      symbol: "pin",
      lat: 46.123456,
      lon: 11.123456,
      ele: 1200,
      visible: true
    }
  ]
}
```

Campi importanti:

- `id`: identita runtime della traccia;
- `localFileId`: identita persistita IndexedDB;
- `visible`: se `false`, la traccia viene omessa da rendering e statistiche;
- `waypointsVisible`: toggle gruppo waypoint per traccia;
- `segments[].visible`: se `false`, il segmento viene omesso da rendering e statistiche;
- `points[].isUserClicked`: distingue punti esplicitamente cliccati da punti generati da routing/import;
- `points[].needsElevation`: usato per idratazione elevazione.

Non creare strutture parallele per tracce, segmenti o waypoint se non strettamente necessarie. La UI, la mappa, le statistiche, l'export e lo storage si aspettano che la sorgente canonica sia `tracks`.

---

## 6. Stato globale e setter

`state.js` esporta variabili live binding ES module e setter.

Esempio:

```javascript
export let activeTrackId = null;
export function setActiveTrackId(v) { activeTrackId = v; }
```

Per primitive e riferimenti globali usare i setter:

- `setMap`;
- `setChart`;
- `setMapLoaded`;
- `setIs3D`;
- `setCurrentStyle`;
- `setUndoStack`;
- `setTracks`;
- `setActiveTrackId`;
- `setActiveSegmentId`;
- `setIsDrawing`;
- `setIsCutting`;
- `setIsBoxDeleting`;
- `setIsSnapActive`;
- `setCurrentSnapProfile`;
- `setIsAddingWaypoint`;
- `setPrintPlanningMode`;
- `setPrintGrid`;
- `updatePrintGridProp`.

Per mutazioni interne di array/oggetti gia esistenti il codice spesso modifica direttamente:

```javascript
track.visible = false;
segment.points.push(point);
```

Dopo queste mutazioni e necessario chiamare le funzioni di refresh/persistenza appropriate.

---

## 7. Funzioni master di refresh

Dopo una mutazione dello stato GIS, ragionare sempre su tre livelli:

1. mappa;
2. UI tree/header/pannelli;
3. persistenza/statistiche.

### `updateMapData(immediate = false)`

Definita in `map.js`.

Fa o coordina:

- ricostruzione sorgenti GeoJSON;
- invalidazione cache LOD;
- applicazione LOD corrente;
- refresh waypoint;
- refresh box-delete preview;
- refresh statistiche/profilo;
- persistenza tracce;
- idratazione quote mancanti.

Usarla quando cambiano:

- punti;
- segmenti;
- visibilita;
- colore;
- spessore;
- waypoint;
- stato editing che impatta layer.

### `renderGisTree()`

Definita in `ui.js`.

Ricostruisce:

- albero tracce;
- segmenti;
- waypoint;
- comandi inline;
- stati selezione/espansione;
- icone;
- menu correlati.

Usarla quando cambiano:

- struttura tracce;
- nomi;
- ordine;
- selezione;
- visibilita mostrata nel pannello;
- waypoint elencati;
- elementi della libreria locale.

### `updateActiveTracksHeader()`

Definita in `ui.js`.

Aggiorna l'header compatto con tracce attive. Usarla quando cambiano:

- traccia attiva;
- visibilita tracce;
- nomi;
- colori;
- lista tracce.

### Persistenza

Per persistenza locale:

- `schedulePersistTracks(tracks)` dopo modifiche alle tracce;
- `schedulePersistAppSession()` dopo modifiche a vista mappa, stile, stato app;
- `flushPersistedStateNow()` su uscita/visibilita hidden.

Molte funzioni gia lo fanno. Se si aggiunge un nuovo flusso mutante, verificare esplicitamente.

---

## 8. Undo history

La history vive in `undoStack` in `state.js` ed e gestita da `tracks.js`.

Funzioni:

- `saveHistoryState(options = {})`;
- `triggerUndo()`.

Caratteristiche:

- snapshot tramite `JSON.stringify({ tracks })`;
- salvataggio differito con `requestIdleCallback` o `setTimeout`;
- massimo 30 snapshot;
- abilita/disabilita `#btn-undo`;
- dopo undo chiama `updateMapData()`;
- persiste stato.

Regola pratica:

- prima di mutazioni distruttive o non banali su `tracks`, chiamare `saveHistoryState()`;
- per disegno continuo o modifiche rapide usare timeout idle piu alto se coerente con il pattern esistente;
- non fare snapshot enormi sincroni in loop o gesture continue;
- non salvare undo per meri cambi UI non distruttivi.

Esempi di mutazioni che richiedono undo:

- eliminare traccia;
- eliminare segmento;
- eliminare waypoint;
- tagliare segmento;
- eliminare punti in box;
- rinominare o modificare proprieta importanti;
- importare GPX;
- incollare/duplicare selezione;
- estrarre offroad in nuova traccia.

---

## 9. Bootstrap applicazione

Flusso principale:

1. browser carica `index.html`;
2. `main.js` viene eseguito come ES module;
3. `injectDeps()` passa a `ui.js` le dipendenze necessarie;
4. vengono esposte funzioni su `window` per handler inline;
5. `bootstrapApp()` parte a `DOMContentLoaded` o subito se DOM gia pronto;
6. `initAuthGate({ onAuthorized: initApp })` controlla auth;
7. se autorizzato, `initApp()` crea mappa MapLibre;
8. su `map.load` vengono aggiunti sorgenti/layer e inizializzata la UI;
9. viene tentato `restoreStoredTracksOnStartup()`;
10. se non c'e sessione locale, viene creata `Traccia 1`;
11. viene loggato evento analytics `app_ready`.

Dettaglio importante: con `AUTH_REQUIRED = true`, l'app fallisce chiusa se Supabase non e configurato.

---

## 10. Autenticazione e autorizzazione

Auth e implementata in `auth.js`.

### Stati principali

`_authState` contiene:

- `ready`;
- `allowed`;
- `session`;
- `profile`;
- `device`;
- `status`.

### Configurazione

In `auth-config.js`:

```javascript
export const AUTH_REQUIRED = true;
export const SUPABASE_URL = "...";
export const SUPABASE_PUBLISHABLE_KEY = "...";
export const ADMIN_USERS_FUNCTION_URL = "...";
```

La publishable key e pubblica per design. Non aggiungere service role key o token segreti.

### Login

Modalita supportate:

- username/email + password;
- magic link;
- reset password.

Lo username viene risolto in email con RPC:

```text
gpxsuite_resolve_login_identifier
```

Il completamento login passa da:

```text
gpxsuite_complete_login
```

Questa RPC:

- controlla profilo;
- controlla stato utente;
- registra o aggiorna dispositivo;
- verifica blocco device;
- applica limite dispositivi;
- ritorna allowed/status/profile/device.

### Device lock

Il browser genera o riusa una chiave locale:

```text
gpxsuite-device-key-v1
```

La label dispositivo e salvata in:

```text
gpxsuite-device-label-v1
```

Stati possibili:

- `pending`;
- `approved`;
- `rejected`;
- `revoked`;
- `suspended`;
- `profile_missing`;
- `device_limit`.

Se il dispositivo non e autorizzato, l'app mostra vista `device` e non chiama `initApp()`.

### Dashboard admin

Accessibile solo se:

```javascript
_authState.profile?.role === 'admin'
```

Funzioni coinvolte:

- `openAdminDashboard()`;
- `renderAdminShell()`;
- `loadAdminData()`;
- `renderAdminDashboard()`;
- RPC admin per summary, utenti, dispositivi, eventi;
- Edge Function `gpxsuite-admin-users` per creazione account.

### Analytics

Usare:

```javascript
trackAnalyticsEvent(eventName, metadata)
```

La funzione non fa nulla se:

- Supabase non e inizializzato;
- non c'e sessione;
- accesso non allowed.

Non bloccare flussi UI su analytics. Il pattern esistente usa `.catch(err => console.warn(err))`.

---

## 11. Supabase backend

La cartella `supabase/` contiene:

- schema SQL;
- migrazioni;
- Edge Function Deno.

### Tabelle principali

`gpxsuite_profiles`:

- profilo utente;
- username;
- email;
- ruolo;
- stato;
- device lock;
- max dispositivi;
- ultimo login.

`gpxsuite_user_devices`:

- device hash;
- label;
- user agent;
- stato;
- first/last seen;
- approvazione/rifiuto.

`gpxsuite_analytics_events`:

- evento;
- metadati JSON;
- user/device;
- timestamp.

### RLS

Le tabelle hanno Row Level Security attiva.

Pattern:

- utente vede se stesso;
- admin vede tutto;
- eventi visibili ad admin;
- funzioni `security definer` incapsulano logiche sensibili.

### Edge Function `gpxsuite-admin-users`

Percorso:

```text
supabase/functions/gpxsuite-admin-users/index.ts
```

Responsabilita:

- riceve POST da dashboard admin;
- verifica Bearer token;
- usa anon key per validare sessione utente;
- usa service role solo lato Supabase Edge;
- controlla che l'utente chiamante sia admin attivo;
- crea utente Auth;
- upserta profilo in `gpxsuite_profiles`;
- ritorna dati account creato.

Non portare mai questa logica nel frontend.

---

## 12. Storage locale

Implementato in `storage.js`.

### IndexedDB

Database:

```text
gpxsuite-local-db
```

Object store:

```text
gpx-files
```

Record salvato:

```javascript
{
  id,
  name,
  source,
  createdAt,
  updatedAt,
  pointsCount,
  segmentsCount,
  waypointCount,
  track
}
```

Le tracce vengono clonate con `JSON.parse(JSON.stringify(track))`.

### Sessione in localStorage

Chiave:

```text
gpxsuite-last-session-v1
```

Snapshot:

- versione;
- timestamp;
- activeTrackId;
- activeSegmentId;
- currentStyle;
- currentSnapProfile;
- stato 3D;
- visibilita hiking trails;
- visibilita Mapillary;
- ordine tracce;
- vista mappa.

### Debounce

Tracce:

- `schedulePersistTracks(trackList)`;
- delay circa 250 ms.

Sessione:

- `schedulePersistAppSession()`;
- delay circa 150 ms.

Flush:

- `flushPersistedStateNow()` su pagehide o document hidden.

### Evento libreria

```text
gpxsuite:local-library-changed
```

Usato per aggiornare viste libreria dopo salvataggi/cancellazioni.

---

## 13. Mappa e rendering GPX

`map.js` gestisce rendering e sorgenti MapLibre.

### Sorgenti principali

- OSM raster base iniziale;
- terrain Nextzen Terrarium;
- Waymarked Trails hiking;
- GPX lines GeoJSON;
- punti editing;
- box delete preview;
- waypoint;
- Mapillary layers.

### Layer ordering

`APPLICATION_LAYER_ORDER` garantisce che layer applicativi restino sopra mappa base/stile.

Se si aggiunge un layer applicativo:

1. aggiungerlo alla creazione layer;
2. aggiungerlo a `APPLICATION_LAYER_ORDER` nella posizione corretta;
3. verificare dopo cambio basemap;
4. verificare dopo toggle 3D.

### Cache multi-LOD

Per grandi GPX, `map.js` non invia sempre tutti i punti alla sorgente linee.

Usa:

- RDP iterativo;
- livelli LOD con tolleranze diverse;
- scelta LOD in base allo zoom;
- prebuild degli altri LOD in idle.

Livelli:

- zoom 0-7: silhouette molto semplificata;
- zoom 7-10: forma generale;
- zoom 10-12: fedelta media;
- zoom 12-14: fedelta alta;
- zoom 14+: tutti i punti.

Regole:

- non reintrodurre rendering pesante su `zoom`;
- evitare allocazioni superflue durante pan/zoom;
- invalidare cache solo quando i dati cambiano;
- non modificare i dati originali in `tracks` durante semplificazione per rendering.

### Visibilita

`updateMapData()` deve omettere:

- tracce con `visible === false`;
- segmenti con `visible === false`;
- waypoint nascosti o appartenenti a gruppo waypoint nascosto.

Le statistiche devono seguire la stessa logica.

---

## 14. Modalita 2D/3D e terreno

La mappa parte in 2D.

`setDimensionMode(enable3D, options = {})` controlla:

- terrain;
- pitch;
- camera;
- stato `is3D`;
- UI.

`configureMapInteractions()` in `main.js` abilita automaticamente il 3D quando l'utente:

- inizia pitch;
- inizia rotate;
- usa mouse con Ctrl e drag;
- usa gesture touch a due dita.

Vincolo critico:

```javascript
preserveDrawingBuffer: true
```

Questo deve restare nella creazione MapLibre. Serve alla cattura canvas per stampa.

Non rimuoverlo per presunte ottimizzazioni senza sostituire l'intero pipeline di stampa con una soluzione equivalente verificata.

---

## 15. Elevazione

L'elevazione usa DEM Terrarium.

Funzione pubblica:

```javascript
queryElevation(lon, lat)
```

Internamente:

- calcola tile z/x/y;
- scarica tile Terrarium;
- disegna su canvas;
- legge pixel;
- decodifica quota;
- mantiene cache `_terrainTileCache`;
- gestisce fallback/errori.

Le tracce importate possono gia avere `ele`. Punti creati manualmente possono partire da 0 e poi essere idratati.

Regole:

- non fare fetch elevazione punto-per-punto sincrono in loop lunghi;
- usare batching/limiti gia presenti;
- mantenere cache tile;
- aggiornare mappa e persistenza dopo idratazione quote.

---

## 16. GPX import

Funzione:

```javascript
importGPX(xmlText, fileName)
```

Flusso:

1. mostra toast importazione;
2. prova parsing nel Worker;
3. fallback a parsing inline se Worker non disponibile;
4. crea nuova traccia con `createNewTrack()`;
5. imposta `localSource = 'imported'`;
6. sostituisce segmenti con quelli importati;
7. aggiunge waypoint;
8. vola al primo punto;
9. salva history;
10. chiama `updateMapData(true)`;
11. mostra toast riepilogo.

### Worker

Usato per evitare freeze su GPX grandi.

Non rimuovere.

### Fallback inline

Usa `yieldToMain()` ogni chunk di punti. Serve quando Worker non e disponibile, ad esempio in alcuni scenari `file://`.

### Parsing

Sono gestiti:

- `trk`;
- `trkseg`;
- `trkpt`;
- `ele`;
- `wpt`;
- `name`;
- `desc`.

Se si aggiungono estensioni GPX, mantenere compatibilita con file senza quei nodi.

---

## 17. GPX export

Funzione:

```javascript
exportGPX()
```

Flusso:

1. verifica presenza tracce;
2. costruisce XML tramite array `parts`;
3. esporta waypoint;
4. esporta tracce/segmenti;
5. semplifica segmenti con piu di 150 punti;
6. crea Blob `application/gpx+xml`;
7. scarica file;
8. mostra toast.

### Semplificazione

Funzione:

```javascript
simplifyDouglasPeucker(points, tolerance)
```

E iterativa per evitare stack overflow su tracce da decine di migliaia di punti.

Regole:

- non sostituire con ricorsione;
- non mutare `points` originali;
- mantenere `escapeXml()` per testi XML;
- valutare con file grandi prima di cambiare tolleranza.

---

## 18. Editing tracce

Modulo: `tracks.js`.

### Aggiunta punti

Funzione:

```javascript
addPointToActiveSegment(lon, lat)
```

Prima assicura che esista una traccia/segmento editabile:

- se manca una traccia, chiama `createNewTrack()`;
- se la traccia e nascosta, la rende visibile;
- se manca un segmento, lo crea;
- se il segmento e nascosto, lo rende visibile.

Senza snap:

- aggiunge punto diretto;
- salva history in idle;
- aggiorna mappa;
- query quota asincrona;
- persiste.

Con snap:

- prende ultimo punto;
- mostra toast "Calcolo percorso...";
- prova route provider;
- aggiunge punti intermedi;
- marca endpoint come `isUserClicked`;
- imposta `needsElevation`;
- fallback a linea d'aria se routing fallisce.

### Snap route

Provider candidati:

1. BRouter;
2. OSRM primario;
3. fallback OSRM.

Profili:

- `foot`;
- `bike`;
- `moto`;
- `car`;
- `off`.

Timeout:

- default 9000 ms;
- BRouter 12000 ms.

Analytics:

- evento `richiesta_routing`;
- include label, ok, durata.

Regole:

- non bloccare UI durante fetch;
- gestire errori provider;
- mantenere fallback;
- non assumere che routing restituisca quota.

### Taglio traccia

Funzione:

```javascript
cutTrackAtPoint(lngLat)
```

Logica:

- cerca il punto piu vicino entro circa 0.2 km;
- richiede segmenti con almeno 4 punti;
- evita tagli troppo vicini agli estremi;
- divide in due segmenti;
- imposta nuovo segmento attivo;
- salva history;
- aggiorna mappa;
- disattiva modalita taglio.

### Eliminazione box

Funzione:

```javascript
handleBoxDeleteClick(lngLat)
```

Primo click:

- salva coordinata iniziale;
- mostra preview;
- aggiunge marker rosso;
- chiede secondo punto.

Secondo click:

- calcola bounding box;
- filtra punti dentro area;
- conta punti eliminati;
- salva history;
- aggiorna mappa;
- pulisce marker/preview.

---

## 19. Waypoint

Modulo: `waypoints.js`.

Funzioni pubbliche principali:

- `addWaypointAtCoords(lon, lat)`;
- `setupWaypointLayers()`;
- `updateWaypointsOnMap()`;
- `bindWaypointInteractions()`;
- `openWaypointEditor(trackId, wpId)`;
- `saveWaypointModifications()`.

Regole:

- waypoint appartengono a `track.waypoints`;
- rispettare `track.waypointsVisible`;
- rispettare `wp.visible`;
- aggiornare sia mappa sia GIS tree dopo modifiche;
- preservare drag/click interazioni MapLibre;
- non creare marker DOM per grandi quantita se il layer MapLibre e sufficiente;
- usare editor esistente per modifiche utente.

---

## 20. GIS tree

Modulo: `ui.js`.

Il GIS tree e la UI principale per:

- tracce;
- segmenti;
- waypoint;
- visibilita;
- selezione;
- rinomina;
- colore;
- spessore;
- drag and drop;
- copia/taglia/incolla/duplica/elimina;
- menu contestuali;
- analisi offroad.

### Handler inline

`renderGisTree()` genera HTML con attributi tipo:

```html
onclick="window.setTrackActive(...)"
```

Ogni nuova funzione richiamata inline deve essere esposta in `main.js`:

```javascript
window.nomeFunzione = nomeFunzione;
```

Se ci si dimentica, la UI sembrera renderizzata correttamente ma il click fallira a runtime.

### Selezione

La selezione usa chiavi interne:

```text
track:<trackId>
segment:<trackId>:<segId>
```

Funzioni private gestiscono:

- normalizzazione;
- shift/multiselect;
- clipboard tree;
- selezione corrente.

Quando si modifica il tree, verificare:

- click singolo;
- ctrl/cmd click;
- shift click;
- tastiera;
- menu contestuale;
- long press mobile.

### Drag and drop

Funzioni:

- `handleGisDragStart`;
- `handleGisDragOver`;
- `handleGisDrop`;
- `handleGisDragEnd`.

Supporta riordino/spostamento nel tree. Dopo un drop valido:

- mutare `tracks`;
- salvare history;
- renderizzare tree;
- aggiornare mappa;
- persistere.

### Menu contestuali

Sono gestiti separatamente per:

- tracce;
- segmenti.

Esistono handler pointer/long press per mobile.

### Rinomina inline

Funzioni:

- `openTrackNameEditor`;
- `finishTrackNameEditor`;
- `handleTrackNameKeydown`;
- `renameSegmentFromMenu`;
- `renameSegment`.

Regole:

- evitare propagation accidentale;
- gestire Enter/Escape;
- non perdere selezione;
- refresh UI e persist.

---

## 21. Analisi offroad

Modulo: `ui.js`.

Funzioni pubbliche:

- `extractOffroadFromTrack(trackId)`;
- `extractOffroadFromSegment(trackId, segId)`.

La logica usa Overpass/OpenStreetMap per confrontare punti traccia con vie note.

Componenti:

- normalizzazione tag OSM;
- split in chunk;
- bounding box;
- query Overpass;
- retry delay;
- merge ways;
- costruzione segmenti OSM;
- distanza punto-segmento;
- classificazione superficie;
- estrazione range offroad;
- creazione nuova traccia offroad.

Regole:

- Overpass puo fallire, essere lento o limitare richieste;
- mantenere messaggi errore chiari;
- non bloccare UI;
- non fare query enormi in un unico bounding box se il chunking esistente serve a contenerle;
- salvare history prima di creare nuove tracce derivate.

---

## 22. Stampa topografica

Modulo: `print.js`.

E uno dei flussi piu delicati.

### Stato stampa

In `state.js`:

```javascript
printGrid = {
  cols: 1,
  rows: 1,
  scale: 1.0,
  orientation: 'portrait',
  width: 150,
  height: 212,
  x: 350,
  y: 250,
  isDragging: false,
  dragOffsetX: 0,
  dragOffsetY: 0
}
```

### Funzioni principali

- `togglePrintPlanning()`;
- `disablePrintPlanning()`;
- `updatePrintGridDimensions()`;
- `setupPrintDragEvents()`;
- `updatePrintGridLayout(e)`;
- `updatePrintGridScale(e)`;
- `setPrintPlanningOrientation(orient)`;
- `generateHighResPrintPreview()`;
- `renderPrintA4Pages(screenshots)`;
- `syncPrintOutputFromPreview()`.

### Pipeline

1. L'utente abilita pianificazione stampa.
2. La griglia A4 appare sopra la mappa.
3. L'utente imposta righe, colonne, scala, orientamento.
4. L'utente trascina la griglia sulla zona desiderata.
5. La generazione anteprima calcola le celle.
6. La mappa viene spostata sotto ogni cella.
7. Il codice attende che la mappa sia ferma/caricata.
8. Viene catturato il canvas WebGL.
9. Le immagini vengono composte in pagine A4.
10. CSS `@media print` nasconde la UI e mostra solo output stampa.

### Vincoli critici

Non rimuovere:

```javascript
preserveDrawingBuffer: true
```

Non sostituire l'attesa MapLibre `idle` con timeout ciechi.

Non rompere:

- griglia drag su mouse;
- griglia drag su touch;
- calcolo orientamento portrait/landscape;
- output A4;
- CSS print;
- cattura canvas.

### Verifica minima dopo modifiche stampa

- aprire app in browser;
- creare/importare traccia;
- entrare in modalita stampa;
- cambiare orientamento;
- cambiare righe/colonne;
- trascinare griglia;
- generare anteprima;
- verificare che le pagine non siano nere/vuote;
- verificare che `window.print()` mostri solo pagine di stampa.

---

## 23. Mapillary

Implementato in `map.js`.

Costanti in `state.js`:

- `MAPILLARY_TILES_URL`;
- `MAPILLARY_GRAPH_URL`;
- `MAPILLARY_TOKEN_KEY`.

Stato:

- `isMapillaryVisible`;
- `mapillaryToken`.

Funzioni pubbliche:

- `configureMapillaryToken(token)`;
- `setMapillaryCoverageVisible(visible, options = {})`;
- `closeMapillaryViewer()`.

Caratteristiche:

- token salvato in `localStorage`;
- coverage layer visibile solo con token;
- Mapillary JS caricato lazy;
- viewer resizable;
- marker immagine corrente;
- campo visivo corrente;
- sequenza immagini;
- autoplay sequenza;
- cache sequenze.

Regole:

- non caricare Mapillary JS all'avvio se non necessario;
- gestire token mancante con UI/toast;
- mantenere layer current image sopra altri layer;
- ripulire timer playback quando viewer chiude;
- non esporre token in log inutili.

---

## 24. Ricerca luoghi

Funzione:

```javascript
searchNominatim()
```

In `ui.js`.

Usa Nominatim/OpenStreetMap.

Regole:

- gestire input vuoto;
- gestire zero risultati;
- evitare spam richieste;
- mostrare feedback utente;
- usare `flyToPOI()` per spostare mappa.

---

## 25. Responsive e mobile

L'app e full-screen e deve funzionare su desktop e mobile.

Meccanismi:

- `--app-height` aggiornato da `visualViewport`;
- safe-area CSS env;
- backdrop mobile;
- toolbar mobile espandibile;
- pannelli chiudibili;
- long press per menu contestuali;
- gesture touch per pitch 3D;
- griglia stampa con touch-action controllato.

Funzioni UI correlate:

- `syncMobileBackdrop()`;
- `closeOtherPanels()`;
- `toggleMobileToolbar()`;
- controlli `isCompactLayout()`, `isSidebarOpen()`, `isStatsPanelOpen()`, ecc.

Quando si modifica UI:

- provare larghezze desktop e mobile;
- verificare pannelli sovrapposti;
- verificare che il gate auth copra tutto;
- verificare che la mappa resti full-screen;
- verificare scroll interni dei pannelli;
- non introdurre testi che escono dai pulsanti.

---

## 26. CSS e stile visuale

Pattern esistente:

- tema scuro;
- pannelli grigio/nero;
- accenti blu/ciano/emerald/amber/red;
- Tailwind per layout e utility;
- CSS custom per comportamenti complessi.

Regole:

- non aggiungere framework CSS;
- non spostare tutto il CSS inline se e riutilizzabile;
- non duplicare regole print in JS;
- mantenere dimensioni stabili per controlli piccoli;
- dopo HTML dinamico, refresh Lucide;
- non introdurre palette incoerenti.

### Auth locked

Quando `body` ha classe:

```text
auth-locked
```

la UI principale viene nascosta da CSS. Non rimuovere questa protezione.

### Tailwind readiness

Esiste una regola:

```css
html:not(.tw-ready) body > :not(#map):not(#auth-gate) {
    visibility: hidden;
}
```

Prima di cambiare caricamento Tailwind o classi iniziali, verificare come viene impostata `tw-ready`.

---

## 27. Performance

Questo progetto manipola file GPX potenzialmente enormi. Prestare attenzione a ogni loop su punti.

### Regole generali

- evitare allocazioni oggetto dentro loop hot-path;
- evitare Turf per calcoli ripetuti su ogni punto se una formula diretta e gia presente;
- non fare `JSON.stringify(tracks)` sincrono in gesture continue;
- non aggiornare DOM per ogni punto;
- non chiamare `renderGisTree()` dentro loop;
- non chiamare `updateMapData()` dentro loop se si puo chiamare una volta dopo;
- non fare fetch elevazione per migliaia di punti senza batching;
- non spostare parsing GPX grande sul main thread;
- non usare ricorsione per Douglas-Peucker su grandi tracce.

### Hot-path dichiarati

- Haversine in `stats.js`;
- RDP/LOD in `map.js`;
- Douglas-Peucker export in `gpx.js`;
- parsing worker GPX;
- rendering MapLibre source updates;
- drag griglia stampa;
- tree rendering su molte tracce/segmenti.

### Debounce/idle gia presenti

- history snapshot idle;
- storage tracks debounce;
- session storage debounce;
- LOD prebuild idle;
- parsing inline con yield;
- elevazione mancanti con scheduler.

Non rimuovere questi meccanismi per "semplificare".

---

## 28. Dependency injection in `ui.js`

`ui.js` usa:

```javascript
injectDeps(deps)
```

Motivo:

- evitare problemi di valutazione circolare fra moduli ES;
- permettere a `ui.js` di chiamare funzioni di `map.js`, `tracks.js`, `gpx.js`, `print.js`, ecc.

`main.js` deve chiamare `injectDeps()` prima di `setupEvents()` e prima di flussi UI che usano quelle dipendenze.

Se si aggiunge a `ui.js` una chiamata verso una funzione esportata da un modulo che gia importa `ui.js`, preferire:

1. aggiungere slot in `injectDeps`;
2. passare funzione da `main.js`;
3. usare la dipendenza in `ui.js` tramite oggetto/variabile interna.

Non risolvere aggiungendo import circolari casuali.

---

## 29. Window globals

Necessari per handler inline generati in HTML dinamico.

In `main.js` sono esposti esempi come:

- `window.setTrackActive`;
- `window.renameTrack`;
- `window.changeTrackColor`;
- `window.toggleTrackVisibility`;
- `window.handleTrackContextMenu`;
- `window.copyTreeSelection`;
- `window.deleteTreeSelection`;
- `window.toggleWaypointVisibility`;
- `window.deleteTrack`;
- `window.renameSegment`;
- `window.setSegmentActive`;
- `window.zoomToWaypoint`;
- `window.deleteWaypoint`;
- `window.openWaypointEditor`;
- `window.openStoredTrackFromLibrary`;
- `window.handleGisDragStart`.

Checklist quando si aggiunge un handler inline:

- la funzione e esportata dal modulo corretto;
- `main.js` la importa;
- `main.js` la assegna a `window`;
- il nome usato nell'HTML corrisponde esattamente;
- i parametri sono serializzati in modo sicuro;
- valori stringa sono escaped se derivano da input utente.

---

## 30. Sicurezza frontend

### XSS

Dove si genera HTML con dati utente usare escape.

Sono presenti helper:

- `escapeHtml()` privati in alcuni moduli;
- `escapeXml()` per GPX.

Non interpolare direttamente:

- nomi tracce;
- descrizioni;
- nomi waypoint;
- email/username;
- dati admin;
- risultati esterni.

### Secret

Mai inserire nel frontend:

- Supabase service role key;
- token personali;
- chiavi private;
- segreti Mapillary non pubblici;
- credenziali admin.

### External API

Gestire sempre:

- timeout;
- response non OK;
- JSON malformato;
- assenza risultati;
- CORS;
- rate limit.

### Auth fail-closed

Con `AUTH_REQUIRED = true`, se Supabase non e configurato l'app non deve concedere accesso.

Non cambiare questo comportamento senza richiesta esplicita.

---

## 31. Convenzioni di modifica

### Prima di modificare

1. Leggere il modulo interessato.
2. Cercare funzioni correlate con `rg`.
3. Capire quali refresh servono.
4. Capire se serve undo.
5. Capire se serve persistenza.
6. Capire se ci sono handler inline da esporre.
7. Capire se la modifica impatta mobile/stampa/auth.

### Durante la modifica

- mantenere scope stretto;
- non refactorare moduli interi se la richiesta e locale;
- usare pattern esistenti;
- aggiungere commenti solo quando spiegano logica non ovvia;
- mantenere italiano;
- evitare dipendenze nuove;
- non cambiare formati dati persistiti senza migrazione/compatibilita;
- non rompere GPX import/export.

### Dopo la modifica

Verificare almeno:

- console browser senza errori evidenti;
- app avviabile;
- flusso toccato;
- refresh mappa;
- refresh GIS tree;
- persistenza se rilevante;
- undo se rilevante;
- mobile se UI;
- stampa se map/canvas/layout.

---

## 32. Checklist per aggiungere una nuova azione traccia

1. Decidere se l'azione opera su traccia, segmento o waypoint.
2. Implementare in `ui.js` se e azione UI/albero.
3. Implementare in `tracks.js` se e editing geometria.
4. Chiamare `saveHistoryState()` prima della mutazione se serve undo.
5. Mutare `tracks`.
6. Chiamare `updateMapData()`.
7. Chiamare `renderGisTree()` se cambia UI tree.
8. Chiamare `updateActiveTracksHeader()` se cambia header.
9. Chiamare `schedulePersistTracks(tracks)` se non gia chiamato.
10. Mostrare `showToast()` se e azione utente con risultato.
11. Se richiamata da HTML inline, esportare e aggiungere `window.*` in `main.js`.
12. Aggiornare eventuali menu contestuali.
13. Verificare selezione e focus.

---

## 33. Checklist per aggiungere un nuovo layer MapLibre

1. Definire sorgente se necessaria.
2. Aggiungere layer dopo che la mappa e caricata.
3. Usare id univoco.
4. Aggiungere id a `APPLICATION_LAYER_ORDER` se layer applicativo.
5. Gestire cambio stile/base map.
6. Gestire visibilita.
7. Gestire cleanup se temporaneo.
8. Verificare con 2D e 3D.
9. Verificare dopo `setBaseMap()`.
10. Verificare dopo import GPX e updateMapData.

---

## 34. Checklist per aggiungere/modificare campi traccia

Se si aggiunge un campo a track/segment/point/waypoint:

1. Aggiornare creazione in `createNewTrack()` o funzione pertinente.
2. Aggiornare import GPX se serve.
3. Aggiornare export GPX se il campo deve uscire.
4. Aggiornare clone/paste/duplicate in `ui.js`.
5. Aggiornare storage se il campo richiede metadati record.
6. Aggiornare restore per default retrocompatibili.
7. Aggiornare render GIS tree se visibile.
8. Aggiornare map GeoJSON properties se serve al layer.
9. Aggiornare documentazione.
10. Testare vecchie tracce salvate in IndexedDB senza quel campo.

---

## 35. Checklist per modifiche auth/admin

1. Capire se il cambio e frontend, SQL o Edge Function.
2. Non mettere segreti nel frontend.
3. Verificare `AUTH_REQUIRED`.
4. Verificare login password.
5. Verificare magic link.
6. Verificare reset password.
7. Verificare dispositivo pending/approved/rejected.
8. Verificare utente suspended.
9. Verificare admin dashboard visibile solo ad admin.
10. Verificare create user via Edge Function.
11. Verificare RLS se si tocca SQL.
12. Verificare messaggi errore in italiano.

---

## 36. Checklist per modifiche storage

1. Non bloccare main thread con salvataggi immediati ripetuti.
2. Preservare debounce.
3. Preservare `localFileId`.
4. Preservare `localCreatedAt`.
5. Aggiornare `localUpdatedAt`.
6. Gestire IndexedDB non disponibile.
7. Gestire JSON vecchi o incompleti.
8. Emittere `gpxsuite:local-library-changed` quando cambia libreria.
9. Flush su uscita se rilevante.
10. Verificare restore startup.

---

## 37. Checklist per modifiche GPX

1. Testare import file piccolo.
2. Testare import `test.gpx` o file grande.
3. Verificare worker.
4. Verificare fallback inline se possibile.
5. Verificare waypoint importati.
6. Verificare quote.
7. Verificare flyTo primo punto.
8. Verificare export scaricato.
9. Aprire export o controllare XML ben formato.
10. Verificare escaping nomi/descrizioni.
11. Verificare performance su 50k+ punti se si tocca parsing/semplificazione.

---

## 38. Checklist per modifiche stampa

1. Confermare `preserveDrawingBuffer: true`.
2. Confermare attesa `idle`/mappa ferma.
3. Verificare griglia visibile.
4. Verificare drag mouse.
5. Verificare drag touch se possibile.
6. Verificare portrait/landscape.
7. Verificare righe/colonne multiple.
8. Verificare scala.
9. Generare anteprima.
10. Verificare immagini non nere.
11. Verificare CSS print.
12. Verificare che UI normale ritorni dopo stampa/anteprima.

---

## 39. Comandi utili

Avviare server locale:

```bash
python3 -m http.server 8080
```

Cercare file:

```bash
rg --files
```

Cercare funzioni esportate:

```bash
rg "^export (async )?function|^export const|^export let" src/js
```

Cercare uso di una funzione:

```bash
rg "nomeFunzione" src/js index.html
```

Controllare stato git:

```bash
git status --short
```

Servire e aprire su macOS con script esistente:

```bash
./avvia.command
```

---

## 40. File e aree da non modificare casualmente

Modificare solo con motivo chiaro:

- `preserveDrawingBuffer` in `main.js`;
- pipeline `idle` in `print.js`;
- RDP/LOD in `map.js`;
- Haversine in `stats.js`;
- worker GPX;
- Douglas-Peucker iterativo;
- schema Supabase/RLS;
- gestione device lock;
- struttura `tracks`;
- handler `window.*` usati da GIS tree.

Non fare refactor estetici su questi punti durante task non correlati.

---

## 41. Errori comuni da evitare

- Aggiungere una funzione in `renderGisTree()` ma non esporla in `main.js`.
- Mutare `tracks` senza `updateMapData()`.
- Mutare nomi/ordine/visibilita senza `renderGisTree()`.
- Dimenticare `saveHistoryState()` prima di eliminazioni.
- Fare import circolari invece di usare `injectDeps()`.
- Inserire service role key in `auth-config.js`.
- Fare query Overpass enormi senza chunking.
- Fare `JSON.stringify(tracks)` sincrono in drag/mousemove.
- Rimuovere fallback routing.
- Rompere fallback import GPX senza Worker.
- Usare ricorsione su tracce grandi.
- Salvare solo in UI senza persistenza IndexedDB/localStorage.
- Aggiungere dipendenze npm al frontend.
- Cambiare testo UI in inglese senza motivo.

---

## 42. Procedura consigliata per task futuri

Per ogni richiesta:

1. Identificare il dominio:
   - mappa;
   - tracce;
   - waypoint;
   - GPX;
   - stampa;
   - UI;
   - auth;
   - storage;
   - Supabase.

2. Leggere i moduli coinvolti.

3. Cercare funzioni gia esistenti da riusare.

4. Implementare il minimo cambiamento coerente.

5. Aggiornare refresh/undo/persistenza.

6. Verificare manualmente o con server locale.

7. Documentare eventuali nuove convenzioni.

---

## 43. Sintesi delle responsabilita per modulo

| File | Responsabilita primaria | Sensibilita |
|---|---|---|
| `index.html` | Markup, CDN, pannelli, modali, bootstrap script | Alta per UI/auth |
| `src/css/style.css` | CSS custom, responsive, print, griglia | Alta per stampa/mobile |
| `src/js/state.js` | Stato globale e setter | Molto alta |
| `src/js/main.js` | Bootstrap, MapLibre init, deps, window globals | Molto alta |
| `src/js/map.js` | Mappa, layer, LOD, 3D, elevazione, Mapillary | Molto alta |
| `src/js/stats.js` | Chart e calcoli profilo/statistiche | Alta performance |
| `src/js/tracks.js` | Editing tracce, undo, snap, taglio, box delete | Molto alta |
| `src/js/waypoints.js` | Waypoint layer/editor/interazioni | Alta |
| `src/js/gpx.js` | Import/export GPX, worker fallback, semplificazione | Alta performance |
| `src/js/print.js` | Pianificazione/cattura/stampa A4 | Molto alta |
| `src/js/ui.js` | GIS tree, pannelli, eventi, offroad, toast | Molto alta |
| `src/js/storage.js` | IndexedDB/localStorage/sessione | Alta |
| `src/js/auth.js` | Auth, device lock, admin, analytics | Molto alta sicurezza |
| `src/js/auth-config.js` | Config pubblica Supabase | Alta sicurezza |
| `src/js/utils.js` | Utility comuni | Media |
| `src/js/workers/gpx-parser.worker.js` | Parsing GPX in background | Alta performance |
| `supabase/schema.sql` | Schema, RPC, RLS | Molto alta sicurezza |
| `supabase/functions/.../index.ts` | Creazione account admin | Molto alta sicurezza |

---

## 44. Definizione di "fatto" per modifiche codice

Una modifica e completa solo se:

- il codice e coerente con la struttura modulare;
- non introduce build step;
- non rompe auth gate;
- non rompe import/export GPX;
- non rompe mappa 2D/3D;
- non rompe stampa se ha toccato mappa/canvas/CSS;
- aggiorna mappa/UI/persistenza come necessario;
- mantiene undo dove l'utente se lo aspetta;
- gestisce errori esterni;
- resta performante su tracce grandi;
- mantiene UI/testi in italiano;
- non introduce segreti.

---

## 45. Nota finale per Codex

Questo progetto e piccolo come deployment, ma complesso come comportamento runtime. La priorita non e "modernizzare" lo stack: la priorita e preservare portabilita, performance su GPX grandi, stampa WebGL affidabile e coerenza dello stato condiviso.

Quando una richiesta sembra semplice, controllare comunque se tocca:

- `tracks`;
- `updateMapData()`;
- `renderGisTree()`;
- undo;
- storage;
- handler inline;
- auth;
- stampa.

La maggior parte dei bug futuri nascera da uno di questi collegamenti dimenticati.
