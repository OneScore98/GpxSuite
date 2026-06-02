// auth.js — login Supabase, blocco dispositivi, dashboard admin, analytics

import {
    AUTH_REQUIRED,
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY,
    ADMIN_USERS_FUNCTION_URL
} from './auth-config.js';
import { ensureLucideIcons, refreshLucideIcons } from './utils.js';

const DEVICE_KEY_STORAGE = 'gpxsuite-device-key-v1';
const DEVICE_LABEL_STORAGE = 'gpxsuite-device-label-v1';
const SUPABASE_JS_URL = 'https://esm.sh/@supabase/supabase-js@2';

let _supabase = null;
let _authState = {
    ready: false,
    allowed: false,
    session: null,
    profile: null,
    device: null,
    status: 'unknown'
};
let _authorizedStarted = false;
let _onAuthorized = null;
let _authCheckPromise = null;
let _adminDashboardBound = false;
let _passwordRecoveryMode = false;

function cleanString(value) {
    return String(value || '').trim();
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function isSupabaseConfigured() {
    return cleanString(SUPABASE_URL) !== '' && cleanString(SUPABASE_PUBLISHABLE_KEY) !== '';
}

function adminUsersFunctionUrl() {
    const configured = cleanString(ADMIN_USERS_FUNCTION_URL);
    if (configured) return configured;
    return `${cleanString(SUPABASE_URL).replace(/\/+$/, '')}/functions/v1/gpxsuite-admin-users`;
}

async function getSupabaseClient() {
    if (_supabase) return _supabase;
    if (!isSupabaseConfigured()) return null;
    const mod = await
    import (SUPABASE_JS_URL);
    _supabase = mod.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
        auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true
        }
    });
    return _supabase;
}

function randomToken() {
    if (window.crypto ?.randomUUID) return window.crypto.randomUUID();
    const bytes = new Uint8Array(24);
    window.crypto ?.getRandomValues ?.(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('') || `${Date.now()}_${Math.random()}`;
}

function getDeviceKey() {
    let key = localStorage.getItem(DEVICE_KEY_STORAGE);
    if (!key) {
        key = `dev_${randomToken()}_${Date.now()}`;
        localStorage.setItem(DEVICE_KEY_STORAGE, key);
    }
    return key;
}

function defaultDeviceLabel() {
    const platform = navigator.userAgentData ?.platform || navigator.platform || 'Browser';
    const agent = navigator.userAgent || '';
    let browser = 'Browser';
    if (agent.includes('Edg/')) browser = 'Edge';
    else if (agent.includes('Chrome/')) browser = 'Chrome';
    else if (agent.includes('Safari/') && !agent.includes('Chrome/')) browser = 'Safari';
    else if (agent.includes('Firefox/')) browser = 'Firefox';
    return `${browser} · ${platform}`;
}

function getDeviceLabel() {
    const saved = cleanString(localStorage.getItem(DEVICE_LABEL_STORAGE));
    if (saved) return saved;
    const label = defaultDeviceLabel();
    localStorage.setItem(DEVICE_LABEL_STORAGE, label);
    return label;
}

function setPanelMessage(elementId, message, type = 'info') {
    const el = document.getElementById(elementId);
    if (!el) return;
    const color = type === 'error' ? 'text-red-300 border-red-900/70 bg-red-950/30' :
        (type === 'success' ? 'text-emerald-300 border-emerald-900/70 bg-emerald-950/30' : 'text-sky-300 border-sky-900/70 bg-sky-950/30');
    el.className = `text-[11px] leading-relaxed border rounded-lg px-3 py-2 ${color}`;
    el.textContent = message;
    el.classList.toggle('hidden', !message);
}

function setAuthMessage(message, type = 'info') {
    setPanelMessage('auth-message', message, type);
}

function setResetMessage(message, type = 'info') {
    setPanelMessage('reset-message', message, type);
}

function setAuthBusy(isBusy) {
    document.querySelectorAll('[data-auth-action]').forEach(btn => {
        btn.disabled = isBusy;
        btn.classList.toggle('opacity-60', isBusy);
        btn.classList.toggle('cursor-wait', isBusy);
    });
}

function showAuthView(viewName) {
    const gate = document.getElementById('auth-gate');
    if (!gate) return;
    gate.classList.remove('hidden');
    document.body.classList.add('auth-locked');
    document.querySelectorAll('[data-auth-view]').forEach(view => {
        view.classList.toggle('hidden', view.dataset.authView !== viewName);
    });
    ensureLucideIcons().catch(err => console.warn(err));
}

function hideAuthGate() {
    document.getElementById('auth-gate') ?.classList.add('hidden');
    document.body.classList.remove('auth-locked');
}

function updateAccountPanel() {
    const profile = _authState.profile;
    const identity = document.getElementById('auth-current-user');
    const adminButton = document.getElementById('btn-open-admin-dashboard');
    if (identity) {
        identity.innerHTML = profile ? `
            <div class="flex items-center gap-2 min-w-0">
              <span class="w-2 h-2 rounded-full bg-emerald-400 shrink-0"></span>
              <div class="min-w-0">
                <div class="text-xs text-white font-semibold truncate">${escapeHtml(profile.username || profile.email || 'Utente')}</div>
                <div class="text-[10px] text-gray-500 truncate">${escapeHtml(profile.email || '')}</div>
              </div>
            </div>` : `<span class="text-xs text-gray-500">Sessione non attiva</span>`;
    }
    if (adminButton) adminButton.classList.toggle('hidden', profile ?.role !== 'admin');
}

function bindAuthForm() {
    document.getElementById('btn-auth-login') ?.addEventListener('click', handlePasswordLogin);
    document.getElementById('btn-auth-magic') ?.addEventListener('click', handleMagicLinkLogin);
    document.getElementById('btn-auth-forgot') ?.addEventListener('click', handlePasswordResetRequest);
    document.getElementById('btn-reset-save') ?.addEventListener('click', handleRecoveryPasswordUpdate);
    document.getElementById('btn-reset-back-login') ?.addEventListener('click', async() => {
        _passwordRecoveryMode = false;
        const client = await getSupabaseClient();
        if (client) await client.auth.signOut();
        setResetMessage('');
        showAuthView('login');
    });
    document.getElementById('auth-password') ?.addEventListener('keydown', e => {
        if (e.key === 'Enter') handlePasswordLogin();
    });
    document.getElementById('reset-password-confirm') ?.addEventListener('keydown', e => {
        if (e.key === 'Enter') handleRecoveryPasswordUpdate();
    });
    document.getElementById('auth-identifier') ?.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            const password = cleanString(document.getElementById('auth-password') ?.value);
            if (password) handlePasswordLogin();
            else handleMagicLinkLogin();
        }
    });
    document.getElementById('btn-device-retry') ?.addEventListener('click', () => verifyCurrentSession());
    document.getElementById('btn-device-logout') ?.addEventListener('click', signOut);
}

export function bindAuthUi() {
    updateAccountPanel();
    document.getElementById('btn-logout') ?.addEventListener('click', signOut);
    document.getElementById('btn-open-admin-dashboard') ?.addEventListener('click', openAdminDashboard);
}

async function resolveLoginEmail(identifier) {
    const client = await getSupabaseClient();
    const clean = cleanString(identifier).toLowerCase();
    if (!client || !clean) throw new Error('Inserisci username o email.');
    const { data, error } = await client.rpc('gpxsuite_resolve_login_identifier', { p_identifier: clean });
    if (error) throw error;
    const email = data ?.email || data;
    if (!email) throw new Error('Account non trovato o non attivo.');
    return email;
}

async function handlePasswordLogin() {
    const identifier = cleanString(document.getElementById('auth-identifier') ?.value);
    const password = String(document.getElementById('auth-password') ?.value || '');
    if (!identifier || !password) {
        setAuthMessage('Inserisci username e password.', 'error');
        return;
    }
    setAuthBusy(true);
    setAuthMessage('Accesso in corso...');
    try {
        const client = await getSupabaseClient();
        const email = await resolveLoginEmail(identifier);
        const { error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw error;
        await verifyCurrentSession();
    } catch (err) {
        console.error(err);
        setAuthMessage(err.message || 'Accesso non riuscito.', 'error');
    } finally {
        setAuthBusy(false);
    }
}

async function handleMagicLinkLogin() {
    const identifier = cleanString(document.getElementById('auth-identifier') ?.value);
    if (!identifier) {
        setAuthMessage('Inserisci username o email per ricevere il magic link.', 'error');
        return;
    }
    setAuthBusy(true);
    setAuthMessage('Invio magic link...');
    try {
        const client = await getSupabaseClient();
        const email = await resolveLoginEmail(identifier);
        const redirectTo = `${window.location.origin}${window.location.pathname}`;
        const { error } = await client.auth.signInWithOtp({
            email,
            options: {
                emailRedirectTo: redirectTo,
                shouldCreateUser: false
            }
        });
        if (error) throw error;
        setAuthMessage('Magic link inviato. Apri il link dalla tua email su questo dispositivo.', 'success');
    } catch (err) {
        console.error(err);
        setAuthMessage(err.message || 'Invio magic link non riuscito.', 'error');
    } finally {
        setAuthBusy(false);
    }
}

async function handlePasswordResetRequest() {
    const identifier = cleanString(document.getElementById('auth-identifier') ?.value);
    if (!identifier) {
        setAuthMessage('Inserisci username o email per ricevere il reset password.', 'error');
        return;
    }
    setAuthBusy(true);
    setAuthMessage('Invio email di reset...');
    try {
        const client = await getSupabaseClient();
        const email = await resolveLoginEmail(identifier);
        const redirectTo = `${window.location.origin}${window.location.pathname}`;
        const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
        if (error) throw error;
        setAuthMessage('Email reset inviata. Apri il link ricevuto e imposta la nuova password.', 'success');
    } catch (err) {
        console.error(err);
        setAuthMessage(err.message || 'Invio reset password non riuscito.', 'error');
    } finally {
        setAuthBusy(false);
    }
}

async function handleRecoveryPasswordUpdate() {
    const password = String(document.getElementById('reset-password') ?.value || '');
    const confirm = String(document.getElementById('reset-password-confirm') ?.value || '');
    if (password.length < 8) {
        setResetMessage('La password deve avere almeno 8 caratteri.', 'error');
        return;
    }
    if (password !== confirm) {
        setResetMessage('Le password non coincidono.', 'error');
        return;
    }
    setAuthBusy(true);
    setResetMessage('Aggiornamento password...');
    try {
        const client = await getSupabaseClient();
        const { data: sessionData } = await client.auth.getSession();
        if (!sessionData ?.session) {
            throw new Error('Link reset scaduto o sessione recovery non valida.');
        }
        const { error } = await client.auth.updateUser({ password });
        if (error) throw error;
        _passwordRecoveryMode = false;
        setResetMessage('Password aggiornata. Accesso in corso...', 'success');
        await verifyCurrentSession();
    } catch (err) {
        console.error(err);
        setResetMessage(err.message || 'Aggiornamento password non riuscito.', 'error');
    } finally {
        setAuthBusy(false);
    }
}

function normalizeLoginResult(data) {
    if (Array.isArray(data)) return data[0] || null;
    return data || null;
}

async function verifyCurrentSession(options = {}) {
    if (_authCheckPromise && !options.force) return _authCheckPromise;
    const promise = (async() => {
        const client = await getSupabaseClient();
        if (!client) return false;
        const { data: sessionData, error: sessionError } = await client.auth.getSession();
        if (sessionError) throw sessionError;
        const session = sessionData ?.session || null;
        _authState.session = session;
        if (!session) {
            if (_passwordRecoveryMode) {
                showAuthView('reset');
                return false;
            }
            _authState = { ready: true, allowed: false, session: null, profile: null, device: null, status: 'signed_out' };
            showAuthView('login');
            return false;
        }

        const { data, error } = await client.rpc('gpxsuite_complete_login', {
            p_device_key: getDeviceKey(),
            p_device_label: getDeviceLabel(),
            p_user_agent: navigator.userAgent || ''
        });
        if (error) throw error;
        const result = normalizeLoginResult(data);
        _authState = {
            ready: true,
            allowed: result ?.allowed === true,
            session,
            profile: result ?.profile || null,
            device: result ?.device || null,
            status: result ?.status || 'unknown'
        };

        if (_authState.allowed) {
            await finishAuthorizedBoot();
            return true;
        }

        showDeviceBlocked(result);
        return false;
    })();

    _authCheckPromise = promise;

    try {
        return await promise;
    } finally {
        if (_authCheckPromise === promise) _authCheckPromise = null;
    }
}

function showDeviceBlocked(result) {
    const title = document.getElementById('device-status-title');
    const body = document.getElementById('device-status-body');
    const badge = document.getElementById('device-status-badge');
    const status = result ?.status || 'pending';
    const device = result ?.device || {};
    const messages = {
        pending: 'Questo dispositivo è in attesa di autorizzazione amministratore.',
        rejected: 'Questo dispositivo è stato rifiutato. Contatta l’amministratore.',
        revoked: 'Questo dispositivo è stato revocato. Contatta l’amministratore.',
        suspended: 'Account sospeso. Contatta l’amministratore.',
        profile_missing: 'Account non abilitato nella dashboard amministratore.',
        device_limit: 'Limite dispositivi raggiunto per questo account.'
    };
    if (title) title.textContent = status === 'pending' ? 'Autorizzazione richiesta' : 'Accesso bloccato';
    if (body) {
        body.textContent = `${messages[status] || messages.pending} Dispositivo: ${device.label || getDeviceLabel()}.`;
    }
    if (badge) badge.textContent = status.toUpperCase();
    showAuthView('device');
}

async function finishAuthorizedBoot() {
    hideAuthGate();
    updateAccountPanel();
    if (!_authorizedStarted && _onAuthorized) {
        _authorizedStarted = true;
        await _onAuthorized(_authState);
    }
    trackAnalyticsEvent('app_start', { path: window.location.pathname }).catch(err => console.warn(err));
}

export async function initAuthGate({ onAuthorized } = {}) {
    _onAuthorized = onAuthorized || null;
    if (!AUTH_REQUIRED) {
        hideAuthGate();
        if (_onAuthorized && !_authorizedStarted) {
            _authorizedStarted = true;
            await _onAuthorized(_authState);
        }
        return;
    }

    showAuthView('loading');
    bindAuthForm();
    if (!isSupabaseConfigured()) {
        showAuthView('config');
        return;
    }

    try {
        const client = await getSupabaseClient();
        client.auth.onAuthStateChange((event, session) => {
            if (event === 'PASSWORD_RECOVERY') {
                _passwordRecoveryMode = true;
                _authState.session = session || null;
                setResetMessage('');
                showAuthView('reset');
                return;
            }
            if (event === 'SIGNED_OUT') {
                _authState = { ready: true, allowed: false, session: null, profile: null, device: null, status: 'signed_out' };
                _authorizedStarted = false;
                _passwordRecoveryMode = false;
                showAuthView('login');
                return;
            }
            if (_passwordRecoveryMode) {
                showAuthView('reset');
                return;
            }
            if (session && !_authState.allowed) {
                verifyCurrentSession().catch(err => {
                    console.error(err);
                    setAuthMessage(err.message || 'Verifica sessione non riuscita.', 'error');
                    showAuthView('login');
                });
            }
        });
        if (window.location.hash.includes('type=recovery') || window.location.search.includes('type=recovery')) {
            _passwordRecoveryMode = true;
            showAuthView('reset');
            return;
        }
        await verifyCurrentSession();
    } catch (err) {
        console.error(err);
        showAuthView('login');
        setAuthMessage(err.message || 'Impossibile inizializzare autenticazione.', 'error');
    }
}

export async function signOut() {
    const client = await getSupabaseClient();
    await trackAnalyticsEvent('logout', {}).catch(() => {});
    if (client) await client.auth.signOut();
    window.location.reload();
}

export function getAuthState() {
    return {..._authState };
}

export async function trackAnalyticsEvent(eventName, metadata = {}) {
    if (!_supabase || !_authState.session || !_authState.allowed) return;
    try {
        await _supabase.rpc('gpxsuite_log_event', {
            p_event_name: String(eventName || 'evento').slice(0, 80),
            p_event_meta: metadata || {},
            p_device_key: getDeviceKey()
        });
    } catch (err) {
        console.warn('Analytics non registrato:', err);
    }
}

function assertAdmin() {
    if (_authState.profile ?.role !== 'admin') throw new Error('Permesso amministratore richiesto.');
}

function adminMetricCard(label, value, icon, tone = 'text-blue-300') {
    return `
      <div class="bg-gray-900/80 border border-gray-800 rounded-lg p-3 min-w-0">
        <div class="flex items-center justify-between gap-2">
          <span class="text-[10px] text-gray-500 uppercase font-bold tracking-wider truncate">${escapeHtml(label)}</span>
          <i data-lucide="${icon}" class="w-3.5 h-3.5 ${tone}"></i>
        </div>
        <div class="mt-1 text-xl font-bold text-white">${escapeHtml(value)}</div>
      </div>`;
}

function renderAdminShell() {
    const modal = document.getElementById('admin-dashboard-modal');
    if (!modal) return;
    modal.innerHTML = `
      <div class="absolute inset-0 bg-black/70 backdrop-blur-sm" data-admin-close="true"></div>
      <div class="relative w-[min(96vw,72rem)] h-[min(92vh,48rem)] bg-gray-950 border border-gray-800 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        <div class="px-4 py-3 border-b border-gray-800 flex items-center justify-between gap-3 bg-gray-950">
          <div class="flex items-center gap-2 min-w-0">
            <i data-lucide="shield-check" class="w-4 h-4 text-cyan-300"></i>
            <div class="min-w-0">
              <h2 class="text-sm font-bold text-white uppercase tracking-wide">Dashboard Amministratore</h2>
              <p class="text-[10px] text-gray-500 truncate">Account, dispositivi e analytics di accesso</p>
            </div>
          </div>
          <button id="btn-admin-close" class="w-8 h-8 rounded-lg hover:bg-gray-800 flex items-center justify-center text-gray-400" title="Chiudi">
            <i data-lucide="x" class="w-4 h-4"></i>
          </button>
        </div>
        <div id="admin-dashboard-body" class="flex-1 overflow-y-auto p-4 space-y-4">
          <div class="text-xs text-gray-400">Caricamento dashboard...</div>
        </div>
      </div>`;
    modal.classList.remove('hidden');
    refreshLucideIcons();
}

async function rpc(name, params = {}) {
    const client = await getSupabaseClient();
    const { data, error } = await client.rpc(name, params);
    if (error) throw error;
    return data;
}

async function loadAdminData() {
    assertAdmin();
    const [summary, users, devices, events] = await Promise.all([
        rpc('gpxsuite_admin_summary'),
        rpc('gpxsuite_admin_list_users'),
        rpc('gpxsuite_admin_list_devices'),
        rpc('gpxsuite_admin_list_events', { p_limit: 80 })
    ]);
    return { summary: summary || {}, users: users || [], devices: devices || [], events: events || [] };
}

function renderAdminDashboard(data) {
    const body = document.getElementById('admin-dashboard-body');
    if (!body) return;
    const s = data.summary || {};
    body.innerHTML = `
      <div class="grid grid-cols-2 md:grid-cols-5 gap-2">
        ${adminMetricCard('Utenti', s.users_total ?? 0, 'users', 'text-cyan-300')}
        ${adminMetricCard('Attivi', s.active_users ?? 0, 'user-check', 'text-emerald-300')}
        ${adminMetricCard('Accessi 24h', s.logins_24h ?? 0, 'log-in', 'text-blue-300')}
        ${adminMetricCard('Richieste 24h', s.requests_24h ?? 0, 'activity', 'text-amber-300')}
        ${adminMetricCard('Device pendenti', s.pending_devices ?? 0, 'monitor-cog', 'text-red-300')}
      </div>

      <section class="bg-gray-950 border border-gray-800 rounded-xl overflow-hidden">
        <div class="px-3 py-2 border-b border-gray-800 flex items-center justify-between gap-2">
          <h3 class="text-xs font-bold text-gray-200 uppercase tracking-wider flex items-center gap-1.5">
            <i data-lucide="user-plus" class="w-3.5 h-3.5 text-blue-300"></i> Nuovo Account
          </h3>
        </div>
        <form id="admin-create-user-form" class="p-3 grid grid-cols-1 md:grid-cols-[1fr_1fr_1fr_8rem_8rem_auto] gap-2 items-end">
          <label class="space-y-1">
            <span class="text-[10px] text-gray-500 uppercase font-bold">Username</span>
            <input name="username" required minlength="3" maxlength="32" class="admin-input" placeholder="utente">
          </label>
          <label class="space-y-1">
            <span class="text-[10px] text-gray-500 uppercase font-bold">Email</span>
            <input name="email" required type="email" class="admin-input" placeholder="utente@email.it">
          </label>
          <label class="space-y-1">
            <span class="text-[10px] text-gray-500 uppercase font-bold">Password iniziale</span>
            <input name="password" type="password" minlength="8" class="admin-input" placeholder="opzionale">
          </label>
          <label class="space-y-1">
            <span class="text-[10px] text-gray-500 uppercase font-bold">Max device</span>
            <input name="maxDevices" type="number" min="1" max="20" value="1" class="admin-input">
          </label>
          <label class="flex items-center gap-2 h-9 px-2 bg-gray-900 border border-gray-800 rounded-lg">
            <input name="deviceLockEnabled" type="checkbox" checked class="accent-blue-500">
            <span class="text-[11px] text-gray-300">Blocco device</span>
          </label>
          <button type="submit" class="h-9 px-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold flex items-center justify-center gap-1.5">
            <i data-lucide="plus" class="w-3.5 h-3.5"></i><span>Crea</span>
          </button>
        </form>
      </section>

      <section class="bg-gray-950 border border-gray-800 rounded-xl overflow-hidden">
        <div class="px-3 py-2 border-b border-gray-800 flex items-center justify-between">
          <h3 class="text-xs font-bold text-gray-200 uppercase tracking-wider">Utenti</h3>
          <button data-admin-refresh="true" class="text-[11px] text-blue-300 hover:text-blue-200 flex items-center gap-1">
            <i data-lucide="refresh-cw" class="w-3 h-3"></i> Aggiorna
          </button>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs min-w-[58rem]">
            <thead class="text-[10px] text-gray-500 uppercase bg-gray-900/70">
              <tr>
                <th class="px-3 py-2">Account</th>
                <th class="px-3 py-2">Ruolo</th>
                <th class="px-3 py-2">Stato</th>
                <th class="px-3 py-2">Device</th>
                <th class="px-3 py-2">Blocco</th>
                <th class="px-3 py-2">Ultimo accesso</th>
                <th class="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-900">
              ${data.users.map(user => renderAdminUserRow(user)).join('')}
            </tbody>
          </table>
        </div>
      </section>

      <section class="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div class="bg-gray-950 border border-gray-800 rounded-xl overflow-hidden">
          <div class="px-3 py-2 border-b border-gray-800">
            <h3 class="text-xs font-bold text-gray-200 uppercase tracking-wider">Dispositivi</h3>
          </div>
          <div class="divide-y divide-gray-900 max-h-96 overflow-y-auto">
            ${data.devices.length ? data.devices.map(renderAdminDeviceRow).join('') : '<div class="p-4 text-xs text-gray-500">Nessun dispositivo registrato.</div>'}
          </div>
        </div>
        <div class="bg-gray-950 border border-gray-800 rounded-xl overflow-hidden">
          <div class="px-3 py-2 border-b border-gray-800">
            <h3 class="text-xs font-bold text-gray-200 uppercase tracking-wider">Eventi recenti</h3>
          </div>
          <div class="divide-y divide-gray-900 max-h-96 overflow-y-auto">
            ${data.events.length ? data.events.map(renderAdminEventRow).join('') : '<div class="p-4 text-xs text-gray-500">Nessun evento registrato.</div>'}
          </div>
        </div>
      </section>`;
    refreshLucideIcons();
}

function renderAdminUserRow(user) {
    const id = escapeHtml(user.id);
    return `
      <tr data-admin-user-row="${id}" class="hover:bg-gray-900/45">
        <td class="px-3 py-2">
          <div class="font-semibold text-white">${escapeHtml(user.username)}</div>
          <div class="text-[10px] text-gray-500">${escapeHtml(user.email)}</div>
        </td>
        <td class="px-3 py-2">
          <select data-admin-user-field="role" class="admin-input admin-input-compact">
            <option value="user" ${user.role === 'user' ? 'selected' : ''}>Utente</option>
            <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin</option>
          </select>
        </td>
        <td class="px-3 py-2">
          <select data-admin-user-field="status" class="admin-input admin-input-compact">
            <option value="active" ${user.status === 'active' ? 'selected' : ''}>Attivo</option>
            <option value="suspended" ${user.status === 'suspended' ? 'selected' : ''}>Sospeso</option>
          </select>
        </td>
        <td class="px-3 py-2">
          <div class="flex items-center gap-2">
            <input data-admin-user-field="max_devices" type="number" min="1" max="20" value="${Number(user.max_devices || 1)}" class="admin-input admin-input-compact w-16">
            <span class="text-[10px] text-gray-500">${Number(user.approved_devices || 0)} ok · ${Number(user.pending_devices || 0)} pending</span>
          </div>
        </td>
        <td class="px-3 py-2">
          <label class="flex items-center gap-2">
            <input data-admin-user-field="device_lock_enabled" type="checkbox" ${user.device_lock_enabled ? 'checked' : ''} class="accent-blue-500">
            <span class="text-[10px] text-gray-400">Attivo</span>
          </label>
        </td>
        <td class="px-3 py-2 text-[10px] text-gray-500">${formatDate(user.last_login_at)}</td>
        <td class="px-3 py-2 text-right">
          <button data-admin-save-user="${id}" class="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 text-[11px]">Salva</button>
        </td>
      </tr>`;
}

function renderAdminDeviceRow(device) {
    const id = escapeHtml(device.id);
    const statusClass = device.status === 'approved' ? 'text-emerald-300 bg-emerald-950/30 border-emerald-900' :
        (device.status === 'pending' ? 'text-amber-300 bg-amber-950/30 border-amber-900' : 'text-red-300 bg-red-950/30 border-red-900');
    return `
      <div class="p-3 flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <span class="font-semibold text-white text-xs truncate">${escapeHtml(device.label || 'Dispositivo')}</span>
            <span class="text-[9px] uppercase px-1.5 py-0.5 rounded border ${statusClass}">${escapeHtml(device.status)}</span>
          </div>
          <div class="text-[10px] text-gray-500 truncate">${escapeHtml(device.username || device.email || '')}</div>
          <div class="text-[10px] text-gray-600">Ultimo: ${formatDate(device.last_seen_at)}</div>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <button data-admin-device-status="${id}:approved" class="w-8 h-8 rounded-lg bg-emerald-700/30 hover:bg-emerald-700/50 text-emerald-300" title="Autorizza"><i data-lucide="check" class="w-3.5 h-3.5 mx-auto"></i></button>
          <button data-admin-device-status="${id}:rejected" class="w-8 h-8 rounded-lg bg-red-900/30 hover:bg-red-900/50 text-red-300" title="Rifiuta"><i data-lucide="x" class="w-3.5 h-3.5 mx-auto"></i></button>
          <button data-admin-device-status="${id}:revoked" class="w-8 h-8 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300" title="Revoca"><i data-lucide="ban" class="w-3.5 h-3.5 mx-auto"></i></button>
        </div>
      </div>`;
}

function renderAdminEventRow(event) {
    return `
      <div class="p-3">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-semibold text-gray-200">${escapeHtml(event.event_name)}</span>
          <span class="text-[10px] text-gray-600">${formatDate(event.created_at)}</span>
        </div>
        <div class="text-[10px] text-gray-500">${escapeHtml(event.username || event.email || 'Sistema')}</div>
      </div>`;
}

function formatDate(value) {
    if (!value) return 'Mai';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Mai';
    return date.toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
}

function bindAdminDashboard() {
    if (_adminDashboardBound) return;
    _adminDashboardBound = true;
    const modal = document.getElementById('admin-dashboard-modal');
    if (!modal) return;
    modal.addEventListener('click', async event => {
        const close = event.target.closest('[data-admin-close], #btn-admin-close');
        if (close) {
            modal.classList.add('hidden');
            return;
        }
        const refresh = event.target.closest('[data-admin-refresh]');
        if (refresh) {
            await refreshAdminDashboard();
            return;
        }
        const saveUser = event.target.closest('[data-admin-save-user]');
        if (saveUser) {
            await saveAdminUser(saveUser.dataset.adminSaveUser);
            return;
        }
        const deviceStatus = event.target.closest('[data-admin-device-status]');
        if (deviceStatus) {
            const [deviceId, status] = deviceStatus.dataset.adminDeviceStatus.split(':');
            await setAdminDeviceStatus(deviceId, status);
        }
    });
    modal.addEventListener('submit', async event => {
        if (event.target.id !== 'admin-create-user-form') return;
        event.preventDefault();
        await createAdminUser(new FormData(event.target));
    });
}

export async function openAdminDashboard() {
    try {
        assertAdmin();
        bindAdminDashboard();
        renderAdminShell();
        await refreshAdminDashboard();
        await trackAnalyticsEvent('admin_dashboard_open', {});
    } catch (err) {
        console.error(err);
        window.alert(err.message || 'Dashboard non disponibile.');
    }
}

async function refreshAdminDashboard() {
    const body = document.getElementById('admin-dashboard-body');
    if (body) body.innerHTML = '<div class="text-xs text-gray-400">Aggiornamento dati...</div>';
    const data = await loadAdminData();
    renderAdminDashboard(data);
}

async function saveAdminUser(userId) {
    const row = document.querySelector(`[data-admin-user-row="${CSS.escape(userId)}"]`);
    if (!row) return;
    const field = name => row.querySelector(`[data-admin-user-field="${name}"]`);
    await rpc('gpxsuite_admin_update_user', {
        p_user_id: userId,
        p_role: field('role') ?.value || 'user',
        p_status: field('status') ?.value || 'active',
        p_max_devices: Number(field('max_devices') ?.value || 1),
        p_device_lock_enabled: field('device_lock_enabled') ?.checked === true
    });
    await trackAnalyticsEvent('admin_user_update', { userId });
    await refreshAdminDashboard();
}

async function setAdminDeviceStatus(deviceId, status) {
    await rpc('gpxsuite_admin_set_device_status', {
        p_device_id: deviceId,
        p_status: status
    });
    await trackAnalyticsEvent('admin_device_status', { deviceId, status });
    await refreshAdminDashboard();
}

async function createAdminUser(formData) {
    const session = _authState.session;
    if (!session ?.access_token) throw new Error('Sessione admin non valida.');
    const payload = {
        username: cleanString(formData.get('username')),
        email: cleanString(formData.get('email')).toLowerCase(),
        password: String(formData.get('password') || ''),
        maxDevices: Number(formData.get('maxDevices') || 1),
        deviceLockEnabled: formData.get('deviceLockEnabled') === 'on',
        role: 'user',
        status: 'active'
    };
    const response = await fetch(adminUsersFunctionUrl(), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`
        },
        body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Creazione account non riuscita.');
    await trackAnalyticsEvent('admin_user_create', { username: payload.username });
    await refreshAdminDashboard();
}