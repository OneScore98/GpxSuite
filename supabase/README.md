# Supabase per GpxSuite

Questa cartella contiene il backend gestito necessario per account, dashboard admin, analytics e blocco dispositivi mantenendo l'app hostabile su GitHub Pages.

## Setup

1. Crea un progetto Supabase.
2. Esegui `schema.sql` nel SQL editor Supabase.
3. Crea il tuo utente in `Authentication > Users`.
4. Inserisci il tuo profilo admin con lo UUID dell'utente:

```sql
insert into public.gpxsuite_profiles (id, username, email, role)
values ('UUID_UTENTE_AUTH', 'admin', 'tua-email@example.com', 'admin');
```

5. Deploya la Edge Function:

```bash
supabase functions deploy gpxsuite-admin-users
```

6. Compila `src/js/auth-config.js` con:

```javascript
export const SUPABASE_URL = 'https://PROJECT_REF.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = '...';
export const AUTH_REDIRECT_URL = 'https://onescore98.github.io/GpxSuite/';
```

Non inserire mai la `service_role key` nel frontend. La usa solo la Edge Function su Supabase.

## URL Auth

In Supabase, apri `Authentication > URL Configuration` e imposta:

- `Site URL`: `https://onescore98.github.io/GpxSuite/`
- `Redirect URLs`: `https://onescore98.github.io/GpxSuite/`

Per test locali puoi aggiungere anche `http://localhost:8080/`, ma non usarlo come `Site URL` di produzione.
Se una mail di reset contiene ancora `localhost:3000`, significa che e stata generata prima della modifica/configurazione: richiedi un nuovo reset password.
