const path = require('node:path');
class WhatsApp {
  constructor(dir, remoteStore = null) { this.dir = dir; this.remoteStore = remoteStore; this.ready = false; this.state = 'disconnected'; this.qr = null; this.client = null; }
  async connect() {
    if (this.client) return;
    const { Client, LocalAuth, RemoteAuth } = require('whatsapp-web.js');
    class SafeRemoteAuth extends RemoteAuth {
      async storeRemoteSession(options) { try { await super.storeRemoteSession(options); } catch { console.error('WhatsApp session backup failed; a restart may require linking again.'); } }
    }
    const QR = require('qrcode');
    this.state = 'starting';
    const client = this.client = new Client({
      authStrategy: this.remoteStore ? new SafeRemoteAuth({ clientId: 'personal', store: this.remoteStore, dataPath: path.join(this.dir, 'whatsapp-session'), backupSyncIntervalMs: 21600000 }) : new LocalAuth({ dataPath: path.join(this.dir, 'whatsapp-session') }),
      puppeteer: { headless: true, args: ['--disable-dev-shm-usage', ...(process.env.MM_CONTAINER === '1' ? ['--no-sandbox', '--disable-setuid-sandbox'] : [])], ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) }
    });
    client.on('qr', async value => { const qr = await QR.toDataURL(value); if (!this.ready) { this.qr = qr; this.state = 'scan-qr'; } });
    client.on('authenticated', () => { this.qr = null; this.state = 'authenticating'; });
    client.on('ready', () => { this.ready = true; this.qr = null; this.state = 'connected'; });
    client.on('auth_failure', () => { this.ready = false; this.qr = null; this.state = 'authentication-failed'; });
    client.on('disconnected', () => { this.ready = false; this.qr = null; this.state = 'disconnected'; });
    try { await client.initialize(); } catch { this.ready = false; this.qr = null; this.state = 'connection-failed'; await client.destroy().catch(() => {}); this.client = null; throw new Error('Could not start WhatsApp. Check Chromium installation and internet connection.'); }
  }
  async reconnect() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    try { if (this.client) await this.client.destroy().catch(() => {}); this.client = null; this.ready = false; this.qr = null; await this.connect(); }
    finally { this.reconnecting = false; }
  }
  async lookup(phone) { const id = await this.client.getNumberId(phone.slice(1)); return id?._serialized || null; }
  async send(chat, text) { const result = await this.client.sendMessage(chat, text, { waitUntilMsgSent: true }); return { id: result.id._serialized }; }
  async close() { this.ready = false; if (this.client) await this.client.destroy().catch(() => {}); }
}
module.exports = { WhatsApp };
