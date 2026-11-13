// Orchestrazione dell'import GPX multiplo, separata dal DOM per rendere
// verificabile il vero percorso usato dall'input file.

export function leggiFileComeTesto(file) {
    return new Promise((resolve, reject) => {
        const lettore = new FileReader();
        lettore.onload = evento => resolve(evento.target.result);
        lettore.onerror = () => reject(lettore.error || new Error(`Lettura non riuscita: ${file.name}`));
        lettore.readAsText(file);
    });
}

export async function importaFileGpxInOrdine(elencoFile, dipendenze) {
    const file = Array.from(elencoFile || []);
    if (file.length === 0) return [];

    const idSchedaDestinazione = dipendenze.catturaDestinazione();
    const risultati = [];
    for (let indice = 0; indice < file.length; indice++) {
        const elemento = file[indice];
        dipendenze.notificaFile?.(elemento);
        const testo = await dipendenze.leggiTesto(elemento);
        risultati.push(await dipendenze.importaGpx(testo, elemento.name, {
            // Nome dello schema persistito mantenuto per compatibilità con le
            // sessioni già salvate e con importGPX.
            destinationGisTabId: idSchedaDestinazione
        }));
    }
    return risultati;
}
