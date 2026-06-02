// auth-config.js — configurazione pubblica Supabase per GitHub Pages.
// La publishable/anon key e l'URL progetto sono pubblici per design; non
// inserire mai service_role key o segreti in questo file.

export const AUTH_REQUIRED = true;
export const SUPABASE_URL = 'https://cnndckqocciwepgdruun.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_3VSrBd5Jqy3w_BLp5vx_Nw_TxDsjpCN';

// Lascia vuoto per usare automaticamente:
// `${SUPABASE_URL}/functions/v1/gpxsuite-admin-users`
export const ADMIN_USERS_FUNCTION_URL = 'https://cnndckqocciwepgdruun.supabase.co/functions/v1/gpxsuite-admin-users';
