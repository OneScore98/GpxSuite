# ADV: verifica sorgente base — 13 novembre 2026

Verifica effettuata **prima dei filtri ADV**, scaricando il TileJSON e decodificando tre tessere PBF effettive con un lettore protobuf temporaneo. Non si sono usate le assunzioni di OUT.

- TileJSON: https://tiles.openfreemap.org/planet — TileJSON 3.0.0, schema OpenMapTiles 3.16.0, dataset `20261101_080013_pt`, maxzoom 14.
- Documentazione primaria: https://openmaptiles.org/docs/schema/ (transportation, class/subclass, surface, brunnel); https://github.com/openmaptiles/openmaptiles/blob/master/layers/transportation/transportation.yaml
- Provider/attribuzioni: https://openfreemap.org/quick_start/

## Campioni realmente decodificati

Prefisso comune `https://tiles.openfreemap.org/planet/20261101_080013_pt/14/`:

| Area | Tessera | transportation | paved | unpaved | surface assente |
| --- | --- | ---: | ---: | ---: | ---: |
| Brescia urbana | 8657/5858.pbf | 474 | 351 | 13 | 110 |
| Bagolino rurale | 8668/5840.pbf | 41 | 18 | 3 | 20 |
| Tremalzo montana | 8678/5838.pbf | 11 | 2 | 3 | 6 |

Campioni di proprietà esatte:

- Brescia: `{surface:'unpaved',class:'track'}`; `{subclass:'pedestrian',class:'path'}`; `{access:'no',surface:'unpaved',class:'service',service:'parking_aisle'}`.
- Bagolino: `{class:'track'}`; `{surface:'paved',class:'track'}`; `{bicycle:'designated',surface:'paved',class:'track',foot:'designated'}`.
- Tremalzo: `{surface:'unpaved',class:'track',mtb_scale:'0'}`; `{class:'track',access:'no'}`.

Le classi osservate includono secondary, tertiary, minor, service, track e path. Classi motorway/trunk/primary sono dichiarate dallo schema, non osservate nelle tre tessere selezionate. Pedestrian/footway/cycleway sono subclass di path. Landcover osservato: wood, grass, farmland, rock. I filtri naturali e delle piste usano questi campi/valori verificati.

## Informazioni disponibili e limiti

Transportation dichiara class/subclass, surface, access, bicycle, foot, horse, mtb_scale, brunnel e attributi di viabilità. Surface è **aggregato in paved/unpaved**; i campioni confermano anche l'assenza. Non contiene il materiale OSM originale: la base non può distinguere ghiaia, terra, compattato, asfalto ecc. Nessuna deduzione da tracktype (non dichiarato).

Non sono dichiarati in transportation: tracktype, smoothness, width/maxwidth/maxheight/maxweight, incline, 4wd_only, vehicle/motor_vehicle/motorcar, conditional, ford, barrier, seasonal, opening_hours. Brunnel supporta ford nella documentazione, ma nessun guado è stato osservato nei tre campioni: **assenza nel campione non significa assenza globale**. Intermittent esiste per acque, non attesta stagionalità di una pista. POI ha class/subclass e nomi, non i tag completi del luogo. Transportation non dichiara un ID OSM: non si abbinano geometrie delle tessere ai dettagli per ID o nome.

Per materiali e altre caratteristiche servono i dettagli OSM indipendenti. La base mantiene grigio neutro per valori assenti/non riconosciuti e non esprime transitabilità o difficoltà.

## Artefatti temporanei riproducibili

`/tmp/adv-tilejson.json`, `/tmp/adv-brescia.pbf`, `/tmp/adv-bagolino.pbf`, `/tmp/adv-tremalzo.pbf`, `/tmp/adv-feature-samples.json`, `/tmp/adv-sample.py` (decoder; usare file locali perché subprocess non ha DNS nel sandbox). I campioni contengono solo dati cartografici pubblici, nessun GPX o credenziale.

## Implementazione e verifiche ticket16

Base originale in adv-base-style.js, sorgente condivisa openMapTilesSource (Android instradato al wrapper), registro adv in map.js, selettore e legenda details HTML. OUT non modificato. Ripristino mappa esteso anche a sessioni prive di GPX; guard bootstrap invariato. Nessun layer/live hook o ordine overlay alterato.

Test Node: selezione/normalizzazione, oggetti indipendenti, OUT→ADV→SAT→ADV, legenda, persistenza, tracce/undo intatti e riapertura senza GPX protetta dal guard bootstrap. Suite 52/52 e smoke import riusciti. Prova browser delegata al coordinatore sull'integrazione. Android: controllo della sorgente con flag; nessuna prova fisica dispositivo/offline o pacchetti/font disponibili.
