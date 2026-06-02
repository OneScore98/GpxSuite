import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}

function cleanString(value: unknown) {
  return String(value || '').trim();
}

function generatedPassword() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Metodo non consentito.' });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse(500, { error: 'Variabili Supabase mancanti.' });
  }

  const authorization = req.headers.get('Authorization') || '';
  if (!authorization.startsWith('Bearer ')) {
    return jsonResponse(401, { error: 'Token mancante.' });
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: authData, error: authError } = await userClient.auth.getUser();
  if (authError || !authData.user) {
    return jsonResponse(401, { error: 'Sessione non valida.' });
  }

  const { data: adminProfile, error: profileError } = await serviceClient
    .from('gpxsuite_profiles')
    .select('role,status')
    .eq('id', authData.user.id)
    .single();

  if (profileError || adminProfile?.role !== 'admin' || adminProfile?.status !== 'active') {
    return jsonResponse(403, { error: 'Permesso amministratore richiesto.' });
  }

  const body = await req.json().catch(() => ({}));
  const username = cleanString(body.username).toLowerCase();
  const email = cleanString(body.email).toLowerCase();
  const displayName = cleanString(body.displayName);
  const suppliedPassword = String(body.password || '');
  const password = suppliedPassword || generatedPassword();
  const role = cleanString(body.role) === 'admin' ? 'admin' : 'user';
  const status = cleanString(body.status) === 'suspended' ? 'suspended' : 'active';
  const maxDevices = Math.max(1, Math.min(Number(body.maxDevices || 1), 20));
  const deviceLockEnabled = body.deviceLockEnabled !== false;

  if (!/^[a-z0-9_.-]{3,32}$/.test(username)) {
    return jsonResponse(400, { error: 'Username non valido. Usa 3-32 caratteri: lettere, numeri, punto, trattino o underscore.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse(400, { error: 'Email non valida.' });
  }
  if (suppliedPassword && suppliedPassword.length < 8) {
    return jsonResponse(400, { error: 'La password deve avere almeno 8 caratteri.' });
  }

  const { data: created, error: createError } = await serviceClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      username,
      displayName,
    },
  });

  if (createError || !created.user) {
    return jsonResponse(400, { error: createError?.message || 'Creazione utente non riuscita.' });
  }

  const { error: upsertError } = await serviceClient
    .from('gpxsuite_profiles')
    .upsert({
      id: created.user.id,
      username,
      email,
      display_name: displayName || null,
      role,
      status,
      max_devices: maxDevices,
      device_lock_enabled: deviceLockEnabled,
      created_by: authData.user.id,
    }, { onConflict: 'id' });

  if (upsertError) {
    await serviceClient.auth.admin.deleteUser(created.user.id).catch(() => {});
    return jsonResponse(400, { error: upsertError.message || 'Profilo utente non creato.' });
  }

  return jsonResponse(201, {
    ok: true,
    user: {
      id: created.user.id,
      username,
      email,
      role,
      status,
      maxDevices,
      deviceLockEnabled,
      passwordGenerated: !suppliedPassword,
    },
  });
});
