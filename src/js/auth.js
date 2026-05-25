// auth.js — autenticazione Google Identity Services + account locale WebCrypto

const LOCAL_ACCOUNTS_KEY = 'gpxsuite-local-accounts-v1';
const AUTH_SESSION_KEY = 'gpxsuite-auth-session-v1';
const GOOGLE_CLIENT_ID_KEY = 'gpxsuite-google-client-id-v1';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const PBKDF2_ITERATIONS = 600000;
const PASSWORD_MIN_LENGTH = 12;

let currentUser = null;
let authUiBound = false;
let googleInitClientId = null;
let googleJwksPromise = null;
let googleRetryTimer = null;
const listeners = new Set();

function now() {
    return Date.now();
}

function hasWebCrypto() {
    return Boolean(window.crypto?.subtle && window.crypto?.getRandomValues);
}

function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function base64ToBytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function decodeBase64Url(value) {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    const bytes = base64ToBytes(padded);
    return new TextDecoder().decode(bytes);
}

function base64UrlToBytes(value) {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    return base64ToBytes(padded);
}

function randomBase64(length) {
    const bytes = new Uint8Array(length);
    window.crypto.getRandomValues(bytes);
    return bytesToBase64(bytes);
}

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePassword(password) {
    if (String(password || '').length < PASSWORD_MIN_LENGTH) {
        throw new Error(`Usa almeno ${PASSWORD_MIN_LENGTH} caratteri.`);
    }
    const classes = [
        /[a-z]/.test(password),
        /[A-Z]/.test(password),
        /\d/.test(password),
        /[^A-Za-z0-9]/.test(password)
    ].filter(Boolean).length;
    if (classes < 3) {
        throw new Error('Usa maiuscole, minuscole, numeri o simboli.');
    }
}

async function derivePasswordHash(password, saltBase64, iterations = PBKDF2_ITERATIONS) {
    if (!hasWebCrypto()) throw new Error('WebCrypto non disponibile.');
    const material = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(password),
        'PBKDF2',
        false,
        ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits({
        name: 'PBKDF2',
        salt: base64ToBytes(saltBase64),
        iterations,
        hash: 'SHA-256'
    }, material, 256);
    return bytesToBase64(new Uint8Array(bits));
}

function constantTimeEqual(a, b) {
    const aBytes = base64ToBytes(a);
    const bBytes = base64ToBytes(b);
    let diff = aBytes.length ^ bBytes.length;
    const len = Math.max(aBytes.length, bBytes.length);
    for (let i = 0; i < len; i++) {
        diff |= (aBytes[i] || 0) ^ (bBytes[i] || 0);
    }
    return diff === 0;
}

function readAccounts() {
    try {
        const parsed = JSON.parse(localStorage.getItem(LOCAL_ACCOUNTS_KEY) || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeAccounts(accounts) {
    localStorage.setItem(LOCAL_ACCOUNTS_KEY, JSON.stringify(accounts));
}

function readStoredSession() {
    try {
        const parsed = JSON.parse(sessionStorage.getItem(AUTH_SESSION_KEY) || 'null');
        if (!parsed || typeof parsed !== 'object') return null;
        if (isSessionExpired(parsed)) return null;
        return parsed;
    } catch {
        return null;
    }
}

function saveStoredSession(user) {
    if (!user) {
        sessionStorage.removeItem(AUTH_SESSION_KEY);
        return;
    }
    sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(user));
}

function isSessionExpired(user) {
    if (!user) return true;
    const expiresAt = Number(user.sessionExpiresAt || 0);
    const jwtExp = Number(user.exp || 0) * 1000;
    if (expiresAt && now() > expiresAt) return true;
    if (jwtExp && now() > jwtExp) return true;
    return false;
}

function makeSessionUser(user) {
    const expiresAt = Math.min(
        now() + SESSION_TTL_MS,
        Number(user.exp || 0) ? Number(user.exp) * 1000 : now() + SESSION_TTL_MS
    );
    return {
        provider: user.provider,
        id: String(user.id || ''),
        email: normalizeEmail(user.email),
        name: String(user.name || user.email || 'Utente'),
        picture: user.picture || '',
        exp: user.exp || null,
        sessionExpiresAt: expiresAt,
        signedAt: now()
    };
}

function setAuthError(message, type = 'error') {
    const el = document.getElementById('auth-message');
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('hidden', !message);
    el.classList.toggle('text-red-300', type === 'error');
    el.classList.toggle('text-emerald-300', type === 'success');
    el.classList.toggle('text-gray-400', type === 'info');
}

function notifyAuthChange() {
    window.dispatchEvent(new CustomEvent('gpxsuite:auth-changed', { detail: { user: currentUser } }));
    listeners.forEach(listener => listener(currentUser));
}

function setCurrentUser(user) {
    currentUser = user ? makeSessionUser(user) : null;
    saveStoredSession(currentUser);
    updateAuthUi();
    notifyAuthChange();
}

function getGoogleClientId() {
    return String(
        window.GPXSUITE_GOOGLE_CLIENT_ID ||
        document.querySelector('meta[name="google-signin-client_id"]')?.content ||
        localStorage.getItem(GOOGLE_CLIENT_ID_KEY) ||
        ''
    ).trim();
}

function setGoogleClientId(clientId) {
    const clean = String(clientId || '').trim();
    if (clean) localStorage.setItem(GOOGLE_CLIENT_ID_KEY, clean);
    else localStorage.removeItem(GOOGLE_CLIENT_ID_KEY);
    googleInitClientId = null;
    renderGoogleButton();
}

function parseGoogleCredential(credential) {
    const parts = String(credential || '').split('.');
    if (parts.length !== 3) throw new Error('Token Google non valido.');
    return JSON.parse(decodeBase64Url(parts[1]));
}

function parseGoogleHeader(credential) {
    const parts = String(credential || '').split('.');
    if (parts.length !== 3) throw new Error('Token Google non valido.');
    return JSON.parse(decodeBase64Url(parts[0]));
}

async function getGoogleJwks() {
    if (!googleJwksPromise) {
        googleJwksPromise = fetch(GOOGLE_JWKS_URL, { cache: 'reload' })
            .then(response => {
                if (!response.ok) throw new Error(`JWK Google ${response.status}`);
                return response.json();
            })
            .catch(err => {
                googleJwksPromise = null;
                throw err;
            });
    }
    return googleJwksPromise;
}

async function verifyGoogleSignature(credential) {
    if (!hasWebCrypto()) throw new Error('WebCrypto non disponibile.');
    const parts = String(credential || '').split('.');
    if (parts.length !== 3) throw new Error('Token Google non valido.');

    const header = parseGoogleHeader(credential);
    if (header.alg !== 'RS256' || !header.kid) throw new Error('Firma Google non supportata.');

    const jwks = await getGoogleJwks();
    const jwk = (jwks.keys || []).find(key => key.kid === header.kid && key.kty === 'RSA');
    if (!jwk) throw new Error('Chiave pubblica Google non trovata.');

    const key = await crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify']
    );
    const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signature = base64UrlToBytes(parts[2]);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signedData);
    if (!valid) throw new Error('Firma Google non valida.');
}

function validateGoogleClaims(claims, clientId) {
    const issuer = claims.iss;
    if (issuer !== 'accounts.google.com' && issuer !== 'https://accounts.google.com') {
        throw new Error('Issuer Google non valido.');
    }
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audience.includes(clientId)) throw new Error('Client ID Google non coerente.');
    if (!claims.sub || !claims.email) throw new Error('Profilo Google incompleto.');
    if (claims.email_verified === false) throw new Error('Email Google non verificata.');
    if (Number(claims.exp || 0) * 1000 <= now()) throw new Error('Sessione Google scaduta.');
}

async function handleGoogleCredential(response) {
    try {
        const clientId = getGoogleClientId();
        const credential = response?.credential;
        await verifyGoogleSignature(credential);
        const claims = parseGoogleCredential(credential);
        validateGoogleClaims(claims, clientId);
        setCurrentUser({
            provider: 'google',
            id: claims.sub,
            email: claims.email,
            name: claims.name || claims.email,
            picture: claims.picture || '',
            exp: claims.exp
        });
        closeAuthModal();
        setAuthError('');
    } catch (err) {
        console.error(err);
        setAuthError(err.message || 'Accesso Google non riuscito.');
    }
}

function renderGoogleButton() {
    const container = document.getElementById('google-signin-button');
    const input = document.getElementById('input-google-client-id');
    if (!container) return;

    const clientId = getGoogleClientId();
    if (input && input.value !== clientId) input.value = clientId;
    container.replaceChildren();

    if (!clientId) {
        const disabled = document.createElement('div');
        disabled.className = 'auth-google-disabled';
        disabled.textContent = 'Google non configurato';
        container.appendChild(disabled);
        return;
    }

    if (!window.google?.accounts?.id) {
        const waiting = document.createElement('div');
        waiting.className = 'auth-google-disabled';
        waiting.textContent = 'Google non disponibile';
        container.appendChild(waiting);
        clearTimeout(googleRetryTimer);
        googleRetryTimer = setTimeout(renderGoogleButton, 500);
        return;
    }

    if (googleInitClientId !== clientId) {
        window.google.accounts.id.initialize({
            client_id: clientId,
            callback: handleGoogleCredential,
            auto_select: false,
            cancel_on_tap_outside: true,
            use_fedcm_for_prompt: true
        });
        googleInitClientId = clientId;
    }

    window.google.accounts.id.renderButton(container, {
        type: 'standard',
        theme: 'outline',
        size: 'large',
        text: 'signin_with',
        shape: 'rectangular',
        logo_alignment: 'left',
        width: Math.min(320, container.clientWidth || 320)
    });
}

function setAuthMode(mode) {
    const isRegister = mode === 'register';
    document.getElementById('auth-login-form')?.classList.toggle('hidden', isRegister);
    document.getElementById('auth-register-form')?.classList.toggle('hidden', !isRegister);
    document.getElementById('btn-auth-tab-login')?.classList.toggle('auth-tab-active', !isRegister);
    document.getElementById('btn-auth-tab-register')?.classList.toggle('auth-tab-active', isRegister);
    setAuthError('');
}

function protectedFeatureLabel(el) {
    return el?.dataset?.authFeature ||
        el?.getAttribute?.('title') ||
        el?.getAttribute?.('aria-label') ||
        'questa funzione';
}

function handleProtectedControlRequest(event) {
    if (isAuthenticated()) return;
    const protectedEl = event.target?.closest?.('[data-auth-required]');
    if (!protectedEl || protectedEl.closest('#auth-modal')) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    openAuthModal(`Accedi per usare ${protectedFeatureLabel(protectedEl)}.`);
}

async function handleLocalLogin(event) {
    event.preventDefault();
    try {
        const email = normalizeEmail(document.getElementById('auth-login-email')?.value);
        const password = document.getElementById('auth-login-password')?.value || '';
        const accounts = readAccounts();
        const account = accounts[email];
        if (!account) throw new Error('Credenziali non valide.');
        const hash = await derivePasswordHash(password, account.salt, account.iterations);
        if (!constantTimeEqual(hash, account.passwordHash)) throw new Error('Credenziali non valide.');
        setCurrentUser({
            provider: 'local',
            id: account.id,
            email: account.email,
            name: account.name || account.email
        });
        closeAuthModal();
        event.target.reset();
    } catch (err) {
        console.error(err);
        setAuthError(err.message || 'Accesso non riuscito.');
    }
}

async function handleLocalRegister(event) {
    event.preventDefault();
    try {
        const name = String(document.getElementById('auth-register-name')?.value || '').trim();
        const email = normalizeEmail(document.getElementById('auth-register-email')?.value);
        const password = document.getElementById('auth-register-password')?.value || '';
        const confirm = document.getElementById('auth-register-confirm')?.value || '';
        if (!isValidEmail(email)) throw new Error('Email non valida.');
        if (password !== confirm) throw new Error('Le password non coincidono.');
        validatePassword(password);
        const accounts = readAccounts();
        if (accounts[email]) throw new Error('Account gia presente.');
        const salt = randomBase64(32);
        const passwordHash = await derivePasswordHash(password, salt, PBKDF2_ITERATIONS);
        const account = {
            id: crypto.randomUUID ? crypto.randomUUID() : `local_${now()}_${Math.random().toString(36).slice(2, 8)}`,
            provider: 'local',
            email,
            name: name || email,
            salt,
            passwordHash,
            iterations: PBKDF2_ITERATIONS,
            createdAt: now()
        };
        accounts[email] = account;
        writeAccounts(accounts);
        setCurrentUser(account);
        closeAuthModal();
        event.target.reset();
    } catch (err) {
        console.error(err);
        setAuthError(err.message || 'Creazione account non riuscita.');
    }
}

function bindAuthUi() {
    if (authUiBound) return;
    authUiBound = true;

    document.getElementById('btn-auth-open')?.addEventListener('click', () => openAuthModal());
    document.getElementById('btn-auth-logout')?.addEventListener('click', signOut);
    document.getElementById('btn-auth-tab-login')?.addEventListener('click', () => setAuthMode('login'));
    document.getElementById('btn-auth-tab-register')?.addEventListener('click', () => setAuthMode('register'));
    document.getElementById('auth-login-form')?.addEventListener('submit', handleLocalLogin);
    document.getElementById('auth-register-form')?.addEventListener('submit', handleLocalRegister);
    document.addEventListener('click', handleProtectedControlRequest, true);
    document.addEventListener('change', handleProtectedControlRequest, true);
    document.getElementById('btn-google-client-save')?.addEventListener('click', () => {
        setGoogleClientId(document.getElementById('input-google-client-id')?.value || '');
        setAuthError('Client ID Google salvato.', 'success');
    });
    document.getElementById('btn-google-client-clear')?.addEventListener('click', () => {
        setGoogleClientId('');
        setAuthError('Client ID Google rimosso.', 'info');
    });
}

function updateAuthUi() {
    const authenticated = Boolean(currentUser && !isSessionExpired(currentUser));
    document.body.classList.toggle('auth-locked', !authenticated);
    document.body.classList.toggle('auth-unlocked', authenticated);

    const openBtn = document.getElementById('btn-auth-open');
    const logoutBtn = document.getElementById('btn-auth-logout');
    const status = document.getElementById('auth-status-text');
    const userEmail = document.getElementById('auth-user-email');
    const avatar = document.getElementById('auth-avatar');

    if (openBtn) openBtn.classList.toggle('hidden', authenticated);
    if (logoutBtn) logoutBtn.classList.toggle('hidden', !authenticated);
    if (status) status.textContent = authenticated ? (currentUser.name || currentUser.email) : 'Accedi';
    if (userEmail) userEmail.textContent = authenticated ? currentUser.email : '';
    if (avatar) {
        avatar.textContent = authenticated ? (currentUser.name || currentUser.email || 'U').trim().slice(0, 1).toUpperCase() : '';
        avatar.classList.toggle('hidden', !authenticated);
    }

    document.querySelectorAll('[data-auth-required]').forEach(el => {
        el.classList.toggle('auth-control-locked', !authenticated);
        el.setAttribute('aria-disabled', authenticated ? 'false' : 'true');
    });

    if (authenticated) closeAuthModal();
}

export function initAuth(options = {}) {
    bindAuthUi();
    currentUser = readStoredSession();
    updateAuthUi();
    setAuthMode('login');
    renderGoogleButton();
    if (!currentUser && options.forceModal === true) openAuthModal();
    return currentUser;
}

export function openAuthModal(message = '') {
    const modal = document.getElementById('auth-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    if (message) setAuthError(message, 'info');
    requestAnimationFrame(() => {
        if (window.matchMedia('(pointer: coarse)').matches) return;
        const field = document.getElementById('auth-login-email');
        if (field && !currentUser) field.focus({ preventScroll: true });
    });
}

export function closeAuthModal() {
    const modal = document.getElementById('auth-modal');
    if (!modal) return;
    if (modal.contains(document.activeElement)) {
        document.activeElement.blur();
    }
    const wasOpen = !modal.classList.contains('hidden');
    modal.classList.add('hidden');
    setAuthError('');
    if (wasOpen) {
        requestAnimationFrame(() => {
            window.dispatchEvent(new CustomEvent('gpxsuite:auth-modal-closed'));
        });
    }
}

export function isAuthenticated() {
    if (currentUser && isSessionExpired(currentUser)) {
        signOut();
        return false;
    }
    return Boolean(currentUser);
}

export function requireAuth(feature = 'questa funzione') {
    if (isAuthenticated()) return true;
    openAuthModal(`Accedi per usare ${feature}.`);
    return false;
}

export function getCurrentUser() {
    return isAuthenticated() ? currentUser : null;
}

export function onAuthChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function signOut() {
    window.google?.accounts?.id?.disableAutoSelect?.();
    setCurrentUser(null);
}
