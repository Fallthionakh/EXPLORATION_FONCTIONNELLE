// API du Carnet d'exploration fonctionnelle (Cloudflare Workers + D1).
// Toutes les routes /api/* exigent une session ouverte avec le mot de passe APP_PASSWORD.
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
async function isAuthed(req, env) {
  const m = (req.headers.get('cookie') || '').match(/(?:^|;\s*)ef_session=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await sign(env.APP_PASSWORD, 'session:' + exp));
}

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS items (col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY (col, id))'),
    db.prepare('CREATE TABLE IF NOT EXISTS files (key TEXT PRIMARY KEY, name TEXT, type TEXT, size INTEGER, data BLOB NOT NULL, created TEXT NOT NULL)'),
  ]);
  schemaReady = true;
}

async function api(req, env, url) {
  const path = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const method = req.method;
  if (!env.APP_PASSWORD) return json({ error: 'APP_PASSWORD non configuré sur le serveur' }, 503);

  if (path[0] === 'login' && method === 'POST') {
    const { password } = await req.json().catch(() => ({}));
    if (typeof password !== 'string' || !safeEqual(await sign('pw', password), await sign('pw', env.APP_PASSWORD))) {
      await new Promise(r => setTimeout(r, 800));
      return json({ error: 'Mot de passe incorrect' }, 401);
    }
    const exp = String(Date.now() + SESSION_DAYS * 864e5);
    const token = exp + '.' + (await sign(env.APP_PASSWORD, 'session:' + exp));
    return json({ ok: true }, 200, { 'set-cookie': `ef_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}` });
  }
  if (path[0] === 'logout') return json({ ok: true }, 200, { 'set-cookie': 'ef_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0' });
  if (!(await isAuthed(req, env))) return json({ error: 'Connexion requise' }, 401);
  if (path[0] === 'me') return json({ ok: true });

  const db = env.DB;
  await ensureSchema(db);

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
      try { if (typeof JSON.parse(body) !== 'object') throw 0; } catch { return json({ error: 'JSON invalide' }, 400); }
      await db.prepare('INSERT INTO items (col, id, data, updated) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(col, id) DO UPDATE SET data = ?3, updated = ?4')
        .bind(col, id, body, new Date().toISOString()).run();
      return json({ ok: true });
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
