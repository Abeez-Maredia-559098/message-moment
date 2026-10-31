const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { Store } = require('./store.cjs');
const { Scheduler } = require('./scheduler.cjs');
const { WhatsApp } = require('./whatsapp.cjs');

async function start(options = {}) {
  const dir = options.dir || process.env.MM_DATA_DIR || path.join(os.homedir(), '.message-moment');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, 'service.lock');
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    let alive = true; try { process.kill(pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; }
    if (alive) throw new Error('Another Message Moment sender is running. Close it first.');
    fs.unlinkSync(lock); fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  }
  let server, remoteServer, timer, adapter, mongo;
  try {
    const cloud = process.env.MM_CLOUD === '1';
    if (cloud && (!process.env.MONGODB_URI || !/^[a-f0-9]{64}$/i.test(process.env.MM_ACCESS_TOKEN || '') || !/^[a-f0-9]{64}$/i.test(process.env.MM_SESSION_KEY || ''))) throw new Error('Cloud mode requires MONGODB_URI, MM_ACCESS_TOKEN and MM_SESSION_KEY (64-character random hex keys).');
    const tokenFile = path.join(dir, 'access-token');
    if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    const token = cloud ? process.env.MM_ACCESS_TOKEN : fs.readFileSync(tokenFile, 'utf8').trim();
    let store, sessionStore;
    if (cloud) {
      const { MongoClient } = require('mongodb');
      mongo = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 3, serverSelectionTimeoutMS: 15000 }); await mongo.connect();
      const db = mongo.db('message_moment');
      const { MongoStore } = require('./mongo-store.cjs'); store = new MongoStore(db); await store.init();
      const { RemoteSessionStore } = require('./remote-session.cjs'); sessionStore = new RemoteSessionStore(db, path.join(dir, 'whatsapp-session'), process.env.MM_SESSION_KEY);
    } else store = new Store(dir);
    adapter = options.adapter || new WhatsApp(dir, sessionStore);
    const scheduler = new Scheduler(store, adapter);
    const secure = !!(process.env.MM_TLS_CERT && process.env.MM_TLS_KEY);
    const host = process.env.MM_HOST || '127.0.0.1';
    if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !secure) throw new Error('Mobile/LAN access requires HTTPS. Set MM_TLS_CERT and MM_TLS_KEY before setting MM_HOST.');
    const allowedOrigins = new Set(['capacitor://localhost', 'http://localhost', 'https://localhost', 'null']);
    const publicOrigin = process.env.MM_PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL;
    if (publicOrigin) { const parsed = new URL(publicOrigin); if (parsed.protocol !== 'https:') throw new Error('Public cloud address must use HTTPS'); allowedOrigins.add(parsed.origin); }
    const www = path.join(__dirname, '..', 'www');
    const handler = async (req, res) => {
      const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
      const origin = req.headers.origin;
      const localOrigin = /^(http|https):\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin || '');
      const ownOrigin = origin === `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
      if (origin && !allowedOrigins.has(origin) && !localOrigin && !ownOrigin) return reply(403, { error: 'Origin not allowed' });
      if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https: http://127.0.0.1:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/api/')) {
        if (url.pathname === '/health' && req.method === 'GET') return reply(200, { ok: true });
        const file = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/manifest.webmanifest': 'manifest.webmanifest', '/sw.js': 'sw.js', '/icon.svg': 'icon.svg' }[url.pathname];
        if (!file || req.method !== 'GET') return reply(404, { error: 'Not found' });
        res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.webmanifest') ? 'application/manifest+json' : 'text/html', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(path.join(www, file)));
      }
      const supplied = Buffer.from((req.headers.authorization || '').replace(/^Bearer /, ''));
      const expected = Buffer.from(token);
      const cron = Buffer.from(process.env.MM_CRON_TOKEN || '');
      const adminOK = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
      const cronOK = url.pathname === '/api/tick' && req.method === 'POST' && cron.length >= 32 && supplied.length === cron.length && crypto.timingSafeEqual(supplied, cron);
      if (!adminOK && !cronOK) return reply(401, { error: 'Connection key is incorrect' });
      try {
        let body = {};
        if (['POST', 'PUT'].includes(req.method)) {
          let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 20000) return reply(413, { error: 'Message is too large' }); }
          try { body = JSON.parse(raw || '{}'); } catch { return reply(400, { error: 'Invalid request' }); }
        }
        if (req.method === 'GET' && url.pathname === '/api/status') return reply(200, { state: adapter.state, qr: adapter.qr, ready: adapter.ready, now: Date.now() });
        if (req.method === 'GET' && url.pathname === '/api/messages') return reply(200, await store.list());
        if (req.method === 'POST' && url.pathname === '/api/tick') { await scheduler.tick(); return reply(200, { ok: true }); }
        if (req.method === 'POST' && url.pathname === '/api/connect') { adapter.reconnect().catch(() => {}); return reply(202, { ok: true }); }
        if (req.method === 'POST' && url.pathname === '/api/messages') return reply(201, await store.add(body));
        const match = url.pathname.match(/^\/api\/messages\/([a-f0-9-]+)$/);
        if (match && req.method === 'PUT') { await store.edit(match[1], body); return reply(200, { ok: true }); }
        if (match && req.method === 'DELETE') { await store.cancel(match[1]); return reply(200, { ok: true }); }
        return reply(404, { error: 'Not found' });
      } catch (error) { return reply(400, { error: error.message }); }
    };
    server = http.createServer(handler);
    server.requestTimeout = 15000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? Number(process.env.PORT || process.env.MM_PORT || 47831), cloud ? '0.0.0.0' : '127.0.0.1', resolve); });
    if (secure) {
      remoteServer = https.createServer({ cert: fs.readFileSync(process.env.MM_TLS_CERT), key: fs.readFileSync(process.env.MM_TLS_KEY) }, handler);
      remoteServer.requestTimeout = 15000;
      await new Promise((resolve, reject) => { remoteServer.once('error', reject); remoteServer.listen(Number(process.env.MM_TLS_PORT || 47832), host, resolve); });
    }
    timer = setInterval(() => scheduler.tick().catch(() => console.error('Scheduler storage error; check database connectivity.')), cloud ? 15000 : 1000);
    adapter.connect().catch(() => {});
    return { token, dir, url: `http://127.0.0.1:${server.address().port}`,
      async close() { clearInterval(timer); await adapter.close(); await Promise.all([new Promise(resolve => server.close(resolve)), remoteServer ? new Promise(resolve => remoteServer.close(resolve)) : Promise.resolve()]); if (mongo) await mongo.close(); fs.unlinkSync(lock); } };
  } catch (e) { clearInterval(timer); if (server?.listening) server.close(); if (remoteServer?.listening) remoteServer.close(); if (adapter) await adapter.close(); if (mongo) await mongo.close(); fs.unlinkSync(lock); throw e; }
}
if (require.main === module) start().then(service => {
  console.log(`Message Moment is running at ${service.url}. ${process.env.MM_CLOUD === '1' ? 'Use the MM_ACCESS_TOKEN configured in your hosting secret settings to connect.' : 'Connection key is stored in ' + path.join(service.dir, 'access-token') + '.'}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await service.close(); process.exit(0); });
}).catch(e => { console.error(e.message); process.exit(1); });
module.exports = { start };
