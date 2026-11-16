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
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

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
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) { json(res, 500, { error: e.message }); }
});

// ---------- WebSocket: pareamento prompter <-> controle ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 1024, verifyClient: ({ req }) => isAuthed(req) });
const rooms = new Map(); // room -> Set<ws>
wss.on('connection', (ws, req) => {
  const u = new URL(req.url, 'http://x');
  const room = u.searchParams.get('room') || '';
  if (!/^[A-Za-z0-9]{4,16}$/.test(room)) return ws.close(1008, 'sala inválida');
  ws.role = u.searchParams.get('role') === 'prompter' ? 'prompter' : 'controller';
  if (!rooms.has(room)) rooms.set(room, new Set());
  const set = rooms.get(room); set.add(ws);
  const notify = () => { const has = [...set].some(c => c.role === 'prompter'); set.forEach(c => c.readyState === 1 && c.send(JSON.stringify({ type: 'presence', prompter: has, controllers: [...set].filter(c => c.role === 'controller').length }))); };
  notify();
  ws.on('message', data => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    msg = { type: msg.type, cmd: msg.cmd, state: msg.state, value: msg.value };
    set.forEach(c => { if (c !== ws && c.role !== ws.role && c.readyState === 1) c.send(JSON.stringify(msg)); });
  });
  ws.on('close', () => { set.delete(ws); if (!set.size) rooms.delete(room); else notify(); });
});

if (APP_PASSWORD) console.log('Login ativado (APP_PASSWORD).'); else console.log('AVISO: sem APP_PASSWORD — acesso aberto a quem alcançar o servidor.');
server.listen(PORT, () => console.log(`Teleprompter em http://localhost:${PORT}`));
