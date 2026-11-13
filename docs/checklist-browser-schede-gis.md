# Checklist browser — Schede GIS

Versione checklist: 1.0  
Specifica: GitHub #1  
Ticket di accettazione: GitHub #12

## Preparazione

- [ ] Avviare l'app con `python3 -m http.server` e aprirla in un browser desktop supportato.
- [ ] Se richiesto, accedere usando esclusivamente le credenziali locali in `.env`; non copiarle in screenshot, log o issue.
- [ ] Preparare almeno tre GPX riconoscibili e una Scheda GIS vuota.
- [ ] Aprire gli strumenti sviluppatore e verificare che non compaiano nuove eccezioni durante i passaggi seguenti.

## Desktop — schede, ordine e proprietà

- [ ] Creare tre Schede GIS: il pulsante `+` resta raggiungibile anche quando i chip scorrono orizzontalmente.
- [ ] Rinominare una scheda con doppio click, quindi verificare Enter, Escape e perdita del focus.
- [ ] Verificare che spazi esterni, nome vuoto e collisioni senza distinzione maiuscole/minuscole siano gestiti senza nomi duplicati.
- [ ] Riordinare i chip via drag e verificare che nome, visibilità e conteggio tracce restino associati alla scheda corretta.
- [ ] Aprire il menu contestuale di una scheda e quello di una traccia; spostare una traccia con `Sposta in…`.
- [ ] Spostare tracce tramite drop sui chip, inclusa una destinazione vuota e una nascosta; la traccia va in fondo alla destinazione.
- [ ] Verificare il fallback della Traccia attiva nella sorgente: precedente, poi successiva, poi nessuna.
- [ ] Creare, importare e aprire dalla libreria tracce in schede diverse; nessuna traccia deve essere persa o duplicata.
- [ ] Copiare una traccia in una scheda, cambiare scheda e incollare: la copia deve appartenere alla destinazione con un nuovo id.
- [ ] Verificare che estrazioni/derivati ereditino la scheda sorgente e che merge o selezioni multiple non attraversino schede diverse.

## Desktop — visibilità, mappa e modifica

- [ ] Lasciare visibili almeno due schede: la mappa mostra contemporaneamente le tracce visibili di entrambe, indipendentemente dalla scheda selezionata.
- [ ] Nascondere una scheda: tracce, segmenti e waypoint della scheda scompaiono senza modificare i rispettivi occhi individuali.
- [ ] Modificare un occhio individuale mentre la scheda è nascosta, poi riattivarla e verificare che la preferenza sia stata conservata.
- [ ] Cliccare sulla linea di una traccia appartenente a un'altra scheda: vengono selezionate scheda e traccia proprietarie senza cambiare alcuna visibilità.
- [ ] Cliccare un waypoint di un'altra scheda: il pannello si sincronizza prima dell'apertura dell'editor.
- [ ] Con la scheda selezionata nascosta, provare disegno, taglio, box-delete, aggiunta e drag waypoint: la geometria non cambia e compare il messaggio italiano previsto.
- [ ] Nascondere la scheda durante una modalità geometrica: cursore, anteprima, punti di modifica, marker e rettangoli temporanei vengono rimossi.
- [ ] Verificare lo stato vuoto delle statistiche per una scheda nascosta e il ripristino immediato quando torna visibile.

## Cancellazione e undo atomico

- [ ] Eliminare una scheda vuota e verificare il fallback a sinistra, oppure a destra se manca la sinistra.
- [ ] Eliminare una scheda con più tracce dopo la conferma con nome e conteggio; scheda e figlie scompaiono insieme.
- [ ] Premere Ctrl+Z una sola volta: nome, posizione, visibilità, tracce, ordine, proprietà, selezione e ultime Tracce attive tornano allo stato precedente.
- [ ] Tentare di eliminare l'ultima scheda rimasta: l'operazione viene rifiutata.

## Stampa e visibilità effettiva

- [ ] Con una scheda visibile non selezionata, generare l'anteprima A4: le sue tracce devono essere presenti.
- [ ] Nascondere una scheda e rigenerare l'anteprima: le sue tracce e waypoint devono essere assenti, senza alterare gli occhi individuali.
- [ ] Verificare che tutte le tile siano caricate prima di ogni pagina e che non compaiano pagine vuote o catture parziali.
- [ ] Ripetere con griglia multipagina, orientamento verticale e orizzontale.

## Persistenza, riapertura e migrazione

- [ ] Preparare più schede rinominate e riordinate, con visibilità differenti, tracce spostate, una scheda vuota e ultime Tracce attive diverse.
- [ ] Ricaricare la pagina: nomi, ordine schede, visibilità, proprietà, ordine tracce, scheda selezionata, Traccia attiva e segmento attivo risultano identici.
- [ ] Ripetere rinomina, spostamento ed eliminazione, ricaricando dopo ogni operazione: nessuna perdita, ricomparsa o duplicazione.
- [ ] Caricare una sessione legacy v1: viene creata una sola `Principale`, l'ordine storico è conservato e tutte le tracce hanno un solo proprietario.
- [ ] Ricaricare di nuovo la sessione migrata: l'ordine non cambia e la migrazione non viene ripetuta.
- [ ] Simulare una traccia senza proprietario o con id scheda inesistente: al primo avvio viene riparata in `Principale` e al secondo avvio resta lì.

## Touch / viewport compatto

- [ ] Ripetere creazione, selezione e scorrimento orizzontale dei chip su viewport mobile reale o emulato; `+` resta sempre toccabile.
- [ ] Aprire rinomina e menu tramite il percorso touch/pressione lunga senza click fantasma.
- [ ] Spostare una traccia tramite `Sposta in…`; il percorso non deve dipendere dal drag HTML5.
- [ ] Verificare occhio scheda, click mappa/waypoint, guard delle modifiche e undo con controlli touch.
- [ ] Ruotare il dispositivo/viewport e verificare che chip, pannelli, mappa e griglia di stampa restino utilizzabili.

## Esito

- Browser/versione desktop: ____________________
- Dispositivo/browser touch: ____________________
- Data e commit verificati: ____________________
- Note o issue aperte: ____________________
