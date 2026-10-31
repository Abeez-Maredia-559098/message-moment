const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
class Store {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, 'messages.json');
    this.rows = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : [];
    if (!Array.isArray(this.rows)) throw new Error('Message database is invalid. Restore a backup before starting.');
    // Never silently repeat a send whose outcome is unknown after a crash.
    this.commit(this.rows.map(m => m.status === 'sending' ? { ...m, status: 'uncertain', error: 'App stopped during sending. Check WhatsApp before scheduling again.' } : m));
  }
  commit(rows) {
    const tmp = this.file + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(rows, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
    this.rows = rows;
  }
  list() { return structuredClone(this.rows); }
  claim(m, now) {
    const current = this.rows.find(x => x.id === m.id);
    if (!current || current.status !== 'scheduled' || current.scheduledAt !== m.scheduledAt || current.phone !== m.phone || current.text !== m.text) return false;
    this.update(m.id, { status: 'sending', attemptedAt: now }); return true;
  }
  add(input, now = Date.now()) {
    const data = validate(input, now);
    const item = { id: crypto.randomUUID(), ...data, status: 'scheduled', createdAt: now };
    this.commit([...this.rows, item]); return item;
  }
  update(id, patch) {
    if (!this.rows.some(m => m.id === id)) throw new Error('Message not found');
    this.commit(this.rows.map(m => m.id === id ? { ...m, ...patch } : m));
  }
  edit(id, input) {
    const m = this.rows.find(x => x.id === id);
    if (!m || m.status !== 'scheduled') throw new Error('Only scheduled messages can be edited');
    this.update(id, validate(input));
  }
  cancel(id) {
    const m = this.rows.find(x => x.id === id);
    if (!m || m.status !== 'scheduled') throw new Error('Only scheduled messages can be cancelled');
    this.update(id, { status: 'cancelled' });
  }
}
function validate(input, now = Date.now()) {
  if (!input || typeof input !== 'object') throw new Error('Message is required');
  const name = String(input.name || '').trim(), phone = String(input.phone || '').replace(/[\s().-]/g, ''), text = String(input.text || '').trim();
  const scheduledAt = Number(input.scheduledAt);
  if (!name || name.length > 80) throw new Error('Enter a recipient name (up to 80 characters)');
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error('Enter a phone number with country code, starting with +');
  if (!text || text.length > 4000) throw new Error('Enter a message between 1 and 4,000 characters');
  if (!Number.isFinite(scheduledAt) || scheduledAt <= now || scheduledAt > now + 366 * 86400000) throw new Error('Choose a future date within the next year');
  return { name, phone, text, scheduledAt };
}
module.exports = { Store, validate };
