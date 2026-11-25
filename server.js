// Servidor do Teleprompter: arquivos estáticos + controle remoto (WebSocket) + caixa de entrada de e-mail.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data');
const INBOX_FILE = path.join(DATA, 'inbox.json');
const INBOUND_TOKEN = process.env.INBOUND_TOKEN || ''; // protege o webhook de e-mail
const APP_PASSWORD = process.env.APP_PASSWORD || ''; // se definido, exige login
const authToken = APP_PASSWORD ? crypto.createHmac('sha256', APP_PASSWORD).update('tp-session').digest('hex') : '';
const parseCookies = h => Object.fromEntries((h || '').split(';').map(c => c.trim().split(/=(.*)/s).slice(0, 2)).filter(a => a[0]));
function isAuthed(req) {
  if (!APP_PASSWORD) return true;
  const c = parseCookies(req.headers.cookie).tp_auth || '';
  const a = Buffer.from(c), b = Buffer.from(authToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const fails = new Map(); // ip -> {n, t}
const tooMany = ip => { const f = fails.get(ip); return f && Date.now() - f.t < 600000 && f.n >= 10; };
const LOGIN_HTML = (msg = '') => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TELEPROMPTER UNIÃO – Login</title>
<style>body{margin:0;background:#0b0c0f;color:#eee;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}
form{background:#16181c;border:1px solid #2c3036;border-radius:14px;padding:24px;width:min(340px,90vw);display:flex;flex-direction:column;gap:12px}
input,button{font:inherit;padding:.7rem;border-radius:10px;border:1px solid #2c3036;background:#0b0c0f;color:#fff}button{background:#2563eb;border-color:#2563eb;font-weight:600;cursor:pointer}p{color:#f87171;margin:0}</style></head>
<body><form method="post" action="/login"><h2 style="margin:0">🎬 TELEPROMPTER UNIÃO</h2><input type="password" name="password" placeholder="Senha" autofocus required><button>Entrar</button><p>${msg}</p></form></body></html>`;
const PUBLIC_PATHS = new Set(['/login', '/manifest.webmanifest', '/icon.svg', '/sw.js', '/api/inbound-email', '/healthz']);

const MAX_BODY = 200 * 1024 * 1024; // praticamente ilimitado

fs.mkdirSync(DATA, { recursive: true });
let inbox = [];
try { inbox = JSON.parse(fs.readFileSync(INBOX_FILE, 'utf8')); } catch {}
const saveInbox = () => fs.writeFileSync(INBOX_FILE, JSON.stringify(inbox));

function addMail({ subject, text, from, date }) {
  text = (text || '').trim();
  if (!text) return null;
  const item = {
    id: crypto.randomUUID(),
    subject: (subject || 'Sem assunto').trim(),
    from: from || '',
    date: (date ? new Date(date) : new Date()).toISOString(),
    text,
  };
  inbox.unshift(item);
  saveInbox();
  return item;
}

// ---------- Envio de texto por link (push direto ao app) ----------
const PENDING_FILE = path.join(DATA, 'pending.json');
const pending = new Map(); // sala -> [{title,text,update,ts}] aguardando o app abrir
try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')))) pending.set(k, v); } catch {}
const savePending = () => fs.writeFileSync(PENDING_FILE, JSON.stringify(Object.fromEntries(pending)));
const rooms = new Map(); // sala -> Set<ws>
function deliverPush(room, push) {
  let n = 0;
  for (const c of rooms.get(room) || []) if (c.role === 'prompter' && c.readyState === 1) { c.send(JSON.stringify({ type: 'push', ...push })); n++; }
  return n;
}

// ---------- Biblioteca sincronizada por código (web + app) ----------
// Armazenamento: arquivos em data/ (efêmero no Render grátis) ou, se UPSTASH_REDIS_REST_URL/TOKEN estiverem definidos, Redis Upstash (durável e grátis).
// Os aparelhos também guardam cópia local e reenviam o que faltar, então um reinício do servidor não perde textos que ainda estejam em algum aparelho.
const syncRooms = new Map(); // código -> Set<ws>
const store = (() => {
  const U = process.env.UPSTASH_REDIS_REST_URL, T = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (U && T) {
    const call = async cmd => {
      const r = await fetch(U, { method: 'POST', headers: { Authorization: 'Bearer ' + T, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
      const j = await r.json(); if (j.error) throw new Error(j.error); return j.result;
    };
    return {
      kind: 'upstash',
      async meta(code) { const a = (await call(['HGETALL', 'tpm:' + code])) || []; const o = {}; for (let i = 0; i < a.length; i += 2) o[a[i]] = JSON.parse(a[i + 1]); return o; },
      async texts(code, ids) { if (!ids.length) return {}; const v = await call(['HMGET', 'tpt:' + code, ...ids]); const o = {}; ids.forEach((id, i) => o[id] = v[i] || ''); return o; },
      async put(code, items) {
        if (!items.length) return;
        await call(['HSET', 'tpm:' + code, ...items.flatMap(i => [i.id, JSON.stringify({ title: i.title, updated: i.updated, deleted: !!i.deleted, size: (i.text || '').length })])]);
        const withText = items.filter(i => !i.deleted); if (withText.length) await call(['HSET', 'tpt:' + code, ...withText.flatMap(i => [i.id, i.text || ''])]);
        const gone = items.filter(i => i.deleted); if (gone.length) await call(['HDEL', 'tpt:' + code, ...gone.map(i => i.id)]);
      },
    };
  }
  const cache = new Map(); const file = c => path.join(DATA, 'lib-' + c + '.json');
  const load = c => { if (!cache.has(c)) { let d = { meta: {}, texts: {} }; try { d = JSON.parse(fs.readFileSync(file(c), 'utf8')); } catch {} cache.set(c, d); } return cache.get(c); };
  return {
    kind: 'file',
    async meta(code) { return load(code).meta; },
    async texts(code, ids) { const d = load(code), o = {}; ids.forEach(id => o[id] = d.texts[id] || ''); return o; },
    async put(code, items) {
      const d = load(code);
      for (const i of items) { d.meta[i.id] = { title: i.title, updated: i.updated, deleted: !!i.deleted, size: (i.text || '').length }; if (i.deleted) delete d.texts[i.id]; else d.texts[i.id] = i.text || ''; }
      fs.writeFileSync(file(code), JSON.stringify(d));
    },
  };
})();
const notifySync = code => { for (const c of syncRooms.get(code) || []) if (c.readyState === 1) c.send(JSON.stringify({ type: 'libChanged' })); };
const okCode = c => /^[A-Z0-9]{4,16}$/.test(c);
const cleanItem = i => ({ id: String(i.id).slice(0, 64), title: String(i.title || '').slice(0, 200), text: String(i.text || ''), updated: +i.updated || Date.now(), deleted: !!i.deleted });

// ---------- IMAP (opcional) ----------
async function pollImap() {
  const { IMAP_HOST, IMAP_USER, IMAP_PASS } = process.env;
  if (!IMAP_HOST || !IMAP_USER || !IMAP_PASS) return;
  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: +(process.env.IMAP_PORT || 993),
    secure: process.env.IMAP_SECURE !== 'false',
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false,
  });
  client.on('error', () => {});
  try {
    await client.connect();
    const lock = await client.getMailboxLock(process.env.IMAP_FOLDER || 'INBOX');
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      for (const uid of uids || []) {
        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        const mail = await simpleParser(msg.source);
        const text = mail.text || (mail.html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '');
        addMail({ subject: mail.subject, text, from: mail.from && mail.from.text, date: mail.date });
        await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
      }
    } finally { lock.release(); }
    await client.logout();
  } catch (e) { console.error('[imap]', e.message); }
}
if (process.env.IMAP_HOST) {
  const every = (+process.env.IMAP_POLL_SEC || 60) * 1000;
  pollImap(); setInterval(pollImap, every);
  console.log('IMAP ativo, verificando a cada', every / 1000, 's');
}

// ---------- HTTP ----------
const MIME = { '.apk': 'application/vnd.android.package-archive', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Token');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    if (url.pathname === '/healthz') return json(res, 200, { ok: true });
    if (url.pathname === '/login') {
      const ip = req.socket.remoteAddress;
      if (req.method === 'POST') {
        if (tooMany(ip)) { res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(LOGIN_HTML('Muitas tentativas. Aguarde alguns minutos.')); }
        const pw = new URLSearchParams(await readBody(req)).get('password') || '';
        const ok = APP_PASSWORD && crypto.timingSafeEqual(crypto.createHash('sha256').update(pw).digest(), crypto.createHash('sha256').update(APP_PASSWORD).digest());
        if (!ok) { const f = fails.get(ip) || { n: 0, t: 0 }; fails.set(ip, { n: Date.now() - f.t > 600000 ? 1 : f.n + 1, t: Date.now() }); res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(LOGIN_HTML('Senha incorreta.')); }
        fails.delete(ip);
        const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
        res.writeHead(303, { 'Set-Cookie': `tp_auth=${authToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`, Location: url.searchParams.get('next')?.startsWith('/') ? url.searchParams.get('next') : '/' });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(LOGIN_HTML());
    }
    if (!PUBLIC_PATHS.has(url.pathname) && !isAuthed(req)) {
      if (url.pathname.startsWith('/api/')) return json(res, 401, { error: 'login necessário' });
      res.writeHead(302, { Location: '/login?next=' + encodeURIComponent(url.pathname + url.search) }); return res.end();
    }
    if (url.pathname === '/api/inbox' && req.method === 'GET') {
      return json(res, 200, inbox.map(({ text, ...m }) => ({ ...m, preview: text.slice(0, 140), size: text.length })));
    }
    let m;
    if ((m = url.pathname.match(/^\/api\/inbox\/([\w-]+)$/))) {
      const i = inbox.findIndex(x => x.id === m[1]);
      if (i < 0) return json(res, 404, { error: 'not found' });
      if (req.method === 'GET') return json(res, 200, inbox[i]);
      if (req.method === 'DELETE') { inbox.splice(i, 1); saveInbox(); return json(res, 200, { ok: true }); }
    }
    if (url.pathname.startsWith('/api/lib/') && req.method === 'POST') {
      const f = JSON.parse(await readBody(req) || '{}'); const code = String(f.code || '').toUpperCase();
      if (!okCode(code)) return json(res, 400, { error: 'código inválido' });
      const srv = await store.meta(code);
      if (url.pathname === '/api/lib/sync') {            // compara listas e devolve o que cada lado precisa
        const need = [], haveIds = [], seen = new Set();
        for (const c of f.items || []) { seen.add(c.id); const sv = srv[c.id]; if (!sv || c.updated > sv.updated) need.push(c.id); else if (sv.updated > c.updated) haveIds.push(c.id); }
        for (const id of Object.keys(srv)) if (!seen.has(id)) haveIds.push(id);
        const texts = await store.texts(code, haveIds.filter(id => !srv[id].deleted));
        return json(res, 200, { need, have: haveIds.map(id => ({ id, title: srv[id].title, updated: srv[id].updated, deleted: !!srv[id].deleted, text: texts[id] || '' })) });
      }
      if (url.pathname === '/api/lib/put') {             // aparelho envia itens novos/alterados/apagados
        const items = (f.items || []).map(cleanItem).filter(i => !srv[i.id] || i.updated > srv[i.id].updated);
        await store.put(code, items); if (items.length) notifySync(code);
        return json(res, 200, { ok: true, accepted: items.length });
      }
      if (url.pathname === '/api/lib/send') {            // página /enviar: cria ou atualiza (mesmo título) direto na biblioteca
        const text = String(f.text || ''); if (!text.trim()) return json(res, 400, { error: 'texto vazio' });
        const title = String(f.title || '').trim().slice(0, 200) || 'Sem título';
        let id = null;
        if (f.update !== false) { let best = 0; for (const [k, v] of Object.entries(srv)) if (!v.deleted && v.title === title && v.updated >= best) { id = k; best = v.updated; } }
        const existed = !!(id && srv[id]);
        id = id || crypto.randomUUID();
        await store.put(code, [{ id, title, text, updated: Date.now() }]); notifySync(code);
        let n = 0; for (const c of syncRooms.get(code) || []) if (c.readyState === 1) n++;
        return json(res, 200, { ok: true, id, delivered: n > 0, updated: existed });
      }
    }
    if (url.pathname === '/api/push' && req.method === 'POST') {
      const f = JSON.parse(await readBody(req) || '{}');
      const room = String(f.room || '').toUpperCase();
      if (!/^[A-Z0-9]{4,16}$/.test(room)) return json(res, 400, { error: 'código da sala inválido' });
      const text = String(f.text || '');
      if (!text.trim()) return json(res, 400, { error: 'texto vazio' });
      const push = { title: String(f.title || '').slice(0, 200), text, update: f.update !== false, ts: Date.now() };
      const n = deliverPush(room, push);
      if (!n) { const q = pending.get(room) || []; q.push(push); while (q.length > 50) q.shift(); pending.set(room, q); savePending(); }
      return json(res, 200, { ok: true, delivered: n > 0 });
    }
    if (url.pathname === '/api/inbound-email' && req.method === 'POST') {
      if (!INBOUND_TOKEN) return json(res, 503, { error: 'defina INBOUND_TOKEN para habilitar o webhook' });
      const tok = url.searchParams.get('token') || req.headers['x-token'];
      if (tok !== INBOUND_TOKEN) return json(res, 403, { error: 'token inválido' });
      const raw = await readBody(req);
      let f;
      if ((req.headers['content-type'] || '').includes('json')) f = JSON.parse(raw);
      else f = Object.fromEntries(new URLSearchParams(raw));
      const item = addMail({
        subject: f.subject, from: f.from || f.sender,
        text: f.text || f['body-plain'] || f.plain || f.body || '',
      });
      return item ? json(res, 200, { ok: true, id: item.id }) : json(res, 400, { error: 'sem texto' });
    }
    // estáticos
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    if (p === '/remote') p = '/remote.html';
    if (p === '/enviar') p = '/enviar.html';
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('404'); }
    const ext = path.extname(file);
    const hdr = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (ext === '.apk') { hdr['Content-Length'] = fs.statSync(file).size; hdr['Content-Disposition'] = 'attachment; filename="TELEPROMPTER-UNIAO.apk"'; }
    if (p === '/app/version.json') hdr['Cache-Control'] = 'no-store';
    res.writeHead(200, hdr);
    fs.createReadStream(file).pipe(res);
  } catch (e) { json(res, 500, { error: e.message }); }
});

// ---------- WebSocket: pareamento prompter <-> controle ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 * 1024, verifyClient: ({ req }) => isAuthed(req) });
wss.on('connection', (ws, req) => {
  const u = new URL(req.url, 'http://x');
  const room = (u.searchParams.get('room') || '').toUpperCase();
  if (!/^[A-Z0-9]{4,16}$/.test(room)) return ws.close(1008, 'sala inválida');
  ws.role = u.searchParams.get('role') === 'prompter' ? 'prompter' : 'controller';
  const syncCode = (u.searchParams.get('sync') || '').toUpperCase();
  if (okCode(syncCode)) { if (!syncRooms.has(syncCode)) syncRooms.set(syncCode, new Set()); syncRooms.get(syncCode).add(ws); ws.on('close', () => { const st = syncRooms.get(syncCode); if (st) { st.delete(ws); if (!st.size) syncRooms.delete(syncCode); } }); }
  if (!rooms.has(room)) rooms.set(room, new Set());
  const set = rooms.get(room); set.add(ws);
  const notify = () => { const has = [...set].some(c => c.role === 'prompter'); set.forEach(c => c.readyState === 1 && c.send(JSON.stringify({ type: 'presence', prompter: has, controllers: [...set].filter(c => c.role === 'controller').length }))); };
  notify();
  if (ws.role === 'prompter') { // entrega o que foi enviado enquanto o app estava fechado
    const q = pending.get(room);
    if (q && q.length) { pending.delete(room); savePending(); for (const p of q) ws.send(JSON.stringify({ type: 'push', ...p })); }
  }
  ws.on('message', data => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (!['cmd', 'state', 'text', 'needText'].includes(msg.type)) return;
    msg = { type: msg.type, cmd: msg.cmd, state: msg.state, value: msg.value };
    set.forEach(c => { if (c !== ws && c.role !== ws.role && c.readyState === 1) c.send(JSON.stringify(msg)); });
  });
  ws.on('close', () => { set.delete(ws); if (!set.size) rooms.delete(room); else notify(); });
});

if (APP_PASSWORD) console.log('Login ativado (APP_PASSWORD).'); else console.log('AVISO: sem APP_PASSWORD — acesso aberto a quem alcançar o servidor.');
server.listen(PORT, () => console.log(`Teleprompter em http://localhost:${PORT} (biblioteca: ${store.kind})`));
