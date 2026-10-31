const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
class RemoteSessionStore {
  constructor(db, directory, encryptionKey) {
    const { GridFSBucket } = require('mongodb');
    if (!/^[a-f0-9]{64}$/i.test(encryptionKey || '')) throw new Error('MM_SESSION_KEY must be a 64-character random hex encryption key');
    this.key = Buffer.from(encryptionKey, 'hex'); this.directory = directory;
    this.bucket = new GridFSBucket(db, { bucketName: 'whatsapp_sessions' }); this.sessions = db.collection('session_pointers');
  }
  async sessionExists({ session }) { return !!(await this.sessions.findOne({ _id: session })); }
  async save({ session }) {
    const file = path.join(this.directory, session + '.zip');
    if (fs.statSync(file).size > 100 * 1024 * 1024) throw new Error('WhatsApp session backup is larger than the 100 MB personal limit');
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const upload = this.bucket.openUploadStream(session);
    try {
      await pipeline(fs.createReadStream(file), cipher, upload);
      const previous = await this.sessions.findOne({ _id: session });
      await this.sessions.updateOne({ _id: session }, { $set: { fileId: upload.id, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), savedAt: new Date() } }, { upsert: true });
      if (previous?.fileId) await this.bucket.delete(previous.fileId).catch(() => {});
    } catch (e) { await this.bucket.delete(upload.id).catch(() => {}); throw e; }
  }
  async extract({ session, path: target }) {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const saved = await this.sessions.findOne({ _id: session }); if (!saved) throw new Error('Session backup not found');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(saved.iv, 'hex')); decipher.setAuthTag(Buffer.from(saved.tag, 'hex'));
    try { await pipeline(this.bucket.openDownloadStream(saved.fileId), decipher, fs.createWriteStream(target, { mode: 0o600 })); }
    catch (e) { fs.rmSync(target, { force: true }); throw e; }
  }
  async delete({ session }) { const saved = await this.sessions.findOne({ _id: session }); await this.sessions.deleteOne({ _id: session }); if (saved?.fileId) await this.bucket.delete(saved.fileId).catch(() => {}); }
}
module.exports = { RemoteSessionStore };
