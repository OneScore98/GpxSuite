// Decisione di bootstrap: una sessione vuota è uno stato intenzionale,
// distinto dall'assenza completa di una sessione al primo avvio.
export function deveCreareTracciaIniziale(ripristino) {
    return ripristino?.restoredCount === 0 && ripristino?.session == null;
}
