// API du Carnet d'exploration fonctionnelle (Cloudflare Workers + D1).
// Toutes les routes /api/* exigent une session ouverte avec un identifiant et un mot de passe.
// Comptes : table D1 « users » (mots de passe hachés PBKDF2). Au premier démarrage, l'identifiant
// « admin » se connecte avec le secret APP_PASSWORD ; il crée ensuite le compte du service.
// APP_PASSWORD sert aussi de clé de signature des sessions.
const COLS = new Set(['examens', 'rendezvous']);
const MAX_FILE = 1_900_000; // limite d'une valeur D1 (2 Mo)
const SESSION_DAYS = 30;
const enc = new TextEncoder();

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function sign(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
async function hashPw(password, saltB64) {
  const salt = saltB64 ? Uint8Array.from(atob(saltB64), c => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return { salt: b64(salt), hash: b64(bits) };
}
const LOGIN_RE = /^[a-z0-9._-]{2,32}$/;
const cleanLogin = l => String(l || '').trim().toLowerCase();
const pwOk = p => typeof p === 'string' && p.length >= 8 && p.length <= 200;

// Session : login.ver.exp.signature (ver change à chaque changement de mot de passe → déconnecte les autres appareils)
async function sessionUser(req, env, db) {
  const m = (req.headers.get('cookie') || '').match(/(?:^|;\s*)ef_session=([^;]+)/);
  if (!m) return null;
  const parts = decodeURIComponent(m[1]).split('.');
  if (parts.length !== 4) return null;
  const [login, ver, exp, sig] = parts;
  if (Number(exp) < Date.now()) return null;
  if (!safeEqual(sig, await sign(env.APP_PASSWORD, `session:${login}:${ver}:${exp}`))) return null;
  const u = await db.prepare('SELECT login, role, ver FROM users WHERE login = ?1').bind(login).first();
  if (!u || String(u.ver) !== ver) return null;
  return u;
}
async function sessionCookie(env, u) {
  const exp = String(Date.now() + SESSION_DAYS * 864e5);
  const token = `${u.login}.${u.ver}.${exp}.` + (await sign(env.APP_PASSWORD, `session:${u.login}:${u.ver}:${exp}`));
  return `ef_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`;
}
async function setPassword(db, login, role, password) {
  const { salt, hash } = await hashPw(password);
  await db.prepare(`INSERT INTO users (login, role, salt, hash, ver, updated) VALUES (?1, ?2, ?3, ?4, 1, ?5)
    ON CONFLICT(login) DO UPDATE SET salt = ?3, hash = ?4, ver = users.ver + 1, updated = ?5`)
    .bind(login, role, salt, hash, new Date().toISOString()).run();
}
const slow = () => new Promise(r => setTimeout(r, 800));

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS items (col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY (col, id))'),
    db.prepare('CREATE TABLE IF NOT EXISTS files (key TEXT PRIMARY KEY, name TEXT, type TEXT, size INTEGER, data BLOB NOT NULL, created TEXT NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS users (login TEXT PRIMARY KEY, role TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, ver INTEGER NOT NULL DEFAULT 1, updated TEXT NOT NULL)'),
  ]);
  schemaReady = true;
}

async function api(req, env, url) {
  const path = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const method = req.method;
  if (!env.APP_PASSWORD) return json({ error: 'APP_PASSWORD non configuré sur le serveur' }, 503);

  const db = env.DB;
  await ensureSchema(db);

  if (path[0] === 'login' && method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const login = cleanLogin(body.login), password = body.password;
    if (!LOGIN_RE.test(login) || typeof password !== 'string') { await slow(); return json({ error: 'Identifiant ou mot de passe incorrect' }, 401); }
    let u = await db.prepare('SELECT login, role, salt, hash, ver FROM users WHERE login = ?1').bind(login).first();
    if (!u && login === 'admin') {
      // Premier démarrage : aucun administrateur encore enregistré → le secret APP_PASSWORD fait foi.
      const admins = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").first();
      if (!admins.n && safeEqual(await sign('pw', password), await sign('pw', env.APP_PASSWORD))) {
        await setPassword(db, 'admin', 'admin', password);
        u = await db.prepare('SELECT login, role, salt, hash, ver FROM users WHERE login = ?1').bind(login).first();
      }
    }
    if (!u || !safeEqual((await hashPw(password, u.salt)).hash, u.hash)) { await slow(); return json({ error: 'Identifiant ou mot de passe incorrect' }, 401); }
    return json({ ok: true, login: u.login, role: u.role }, 200, { 'set-cookie': await sessionCookie(env, u) });
  }
  if (path[0] === 'logout') return json({ ok: true }, 200, { 'set-cookie': 'ef_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0' });
  const me = await sessionUser(req, env, db);
  if (!me) return json({ error: 'Connexion requise' }, 401);
  if (path[0] === 'me') return json({ ok: true, login: me.login, role: me.role });

  // Changer son propre mot de passe
  if (path[0] === 'password' && method === 'POST') {
    const { current, next } = await req.json().catch(() => ({}));
    const u = await db.prepare('SELECT salt, hash FROM users WHERE login = ?1').bind(me.login).first();
    if (typeof current !== 'string' || !safeEqual((await hashPw(current, u.salt)).hash, u.hash)) { await slow(); return json({ error: 'Mot de passe actuel incorrect' }, 403); }
    if (!pwOk(next)) return json({ error: 'Le nouveau mot de passe doit faire au moins 8 caractères' }, 400);
    await setPassword(db, me.login, me.role, next);
    const nu = await db.prepare('SELECT login, role, ver FROM users WHERE login = ?1').bind(me.login).first();
    return json({ ok: true }, 200, { 'set-cookie': await sessionCookie(env, nu) });
  }

  // Gestion des comptes (administrateur uniquement)
  if (path[0] === 'users') {
    if (me.role !== 'admin') return json({ error: 'Réservé à l’administrateur' }, 403);
    if (method === 'GET' && path.length === 1) {
      const { results } = await db.prepare('SELECT login, role, updated FROM users ORDER BY role, login').all();
      return json(results);
    }
    const login = cleanLogin(path[1]);
    if (!LOGIN_RE.test(login)) return json({ error: 'Identifiant invalide (2 à 32 caractères : lettres minuscules, chiffres, . _ -)' }, 400);
    if (method === 'PUT') {
      const { password, role } = await req.json().catch(() => ({}));
      if (!pwOk(password)) return json({ error: 'Le mot de passe doit faire au moins 8 caractères' }, 400);
      const ex = await db.prepare('SELECT role FROM users WHERE login = ?1').bind(login).first();
      const r = ex ? ex.role : (role === 'admin' ? 'admin' : 'service');
      await setPassword(db, login, r, password);
      if (login === me.login) {
        const nu = await db.prepare('SELECT login, role, ver FROM users WHERE login = ?1').bind(login).first();
        return json({ ok: true }, 200, { 'set-cookie': await sessionCookie(env, nu) });
      }
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      if (login === me.login) return json({ error: 'Vous ne pouvez pas supprimer votre propre compte' }, 400);
      await db.prepare('DELETE FROM users WHERE login = ?1').bind(login).run();
      return json({ ok: true });
    }
  }

  if (path[0] === 'items') {
    if (method === 'GET' && path.length === 1) {
      const { results } = await db.prepare('SELECT col, id, data FROM items').all();
      const out = { examens: [], rendezvous: [] };
      for (const r of results) if (out[r.col]) out[r.col].push({ ...JSON.parse(r.data), id: r.id });
      return json(out);
    }
    const [, col, id] = path;
    if (!COLS.has(col) || !id || !/^[\w.-]{1,80}$/.test(id)) return json({ error: 'Chemin invalide' }, 400);
    if (method === 'PUT') {
      const body = await req.text();
      if (body.length > 500_000) return json({ error: 'Fiche trop volumineuse' }, 413);
      let data;
      try { data = JSON.parse(body); if (!data || typeof data !== 'object' || Array.isArray(data)) throw 0; } catch { return json({ error: 'JSON invalide' }, 400); }
      // Traçabilité : qui a saisi la fiche, qui l'a modifiée en dernier (fixé par le serveur)
      const old = await db.prepare('SELECT data FROM items WHERE col = ?1 AND id = ?2').bind(col, id).first();
      const prev = old ? JSON.parse(old.data) : null, now = new Date().toISOString();
      data.saisiPar = prev ? (prev.saisiPar || '') : me.login;
      data.saisiLe = prev ? (prev.saisiLe || '') : now;
      data.modifPar = me.login; data.modifLe = now;
      await db.prepare('INSERT INTO items (col, id, data, updated) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(col, id) DO UPDATE SET data = ?3, updated = ?4')
        .bind(col, id, JSON.stringify(data), now).run();
      return json({ ok: true, saisiPar: data.saisiPar, saisiLe: data.saisiLe, modifPar: data.modifPar, modifLe: data.modifLe });
    }
    if (method === 'DELETE') {
      await db.prepare('DELETE FROM items WHERE col = ?1 AND id = ?2').bind(col, id).run();
      return json({ ok: true });
    }
  }

  if (path[0] === 'files') {
    if (method === 'POST' && path.length === 1) {
      const buf = await req.arrayBuffer();
      if (!buf.byteLength) return json({ error: 'Fichier vide' }, 400);
      if (buf.byteLength > MAX_FILE) return json({ error: 'Fichier trop lourd (max 1,9 Mo). Prenez plutôt une photo ou compressez le PDF.' }, 413);
      const type = (req.headers.get('content-type') || '').split(';')[0];
      if (!/^(image\/(jpeg|png|webp|gif)|application\/pdf)$/.test(type)) return json({ error: 'Seules les images et les PDF sont acceptés' }, 415);
      const key = crypto.randomUUID();
      const name = decodeURIComponent(req.headers.get('x-filename') || 'document').slice(0, 200);
      await db.prepare('INSERT INTO files (key, name, type, size, data, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
        .bind(key, name, type, buf.byteLength, buf, new Date().toISOString()).run();
      return json({ key, url: '/api/files/' + key, name, type, size: buf.byteLength });
    }
    const key = path[1];
    if (!key || !/^[0-9a-f-]{36}$/.test(key)) return json({ error: 'Clé invalide' }, 400);
    if (method === 'GET') {
      const row = await db.prepare('SELECT name, type, data FROM files WHERE key = ?1').bind(key).first();
      if (!row) return json({ error: 'Introuvable' }, 404);
      return new Response(new Uint8Array(row.data), { headers: {
        'content-type': row.type, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff',
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(row.name || 'document')}` } });
    }
    if (method === 'DELETE') {
      await db.prepare('DELETE FROM files WHERE key = ?1').bind(key).run();
      return json({ ok: true });
    }
  }
  return json({ error: 'Route inconnue' }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await api(req, env, url); }
      catch (e) { return json({ error: 'Erreur serveur', detail: String(e && e.message || e) }, 500); }
    }
    return env.ASSETS.fetch(req);
  },
};
