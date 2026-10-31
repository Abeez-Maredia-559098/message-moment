const crypto = require('node:crypto');
const { validate } = require('./store.cjs');
class MongoStore {
  constructor(db) { this.collection = db.collection('messages'); }
  async init() {
    await this.collection.createIndex({ id: 1 }, { unique: true });
    await this.collection.createIndex({ status: 1, scheduledAt: 1 });
    await this.collection.updateMany({ status: 'sending' }, { $set: { status: 'uncertain', error: 'Sender restarted during sending. Check WhatsApp before scheduling again.' } });
  }
  async list() { return this.collection.find({}, { projection: { _id: 0 } }).sort({ scheduledAt: 1 }).limit(1000).toArray(); }
  async due(now) { return this.collection.find({ status: 'scheduled', scheduledAt: { $lte: now } }, { projection: { _id: 0 } }).sort({ scheduledAt: 1 }).limit(20).toArray(); }
  async add(input) {
    const data = validate(input);
    if (await this.collection.countDocuments({}) >= 1000) throw new Error('The free personal store is limited to 1,000 messages. Export and remove old records from the database before adding more.');
    const m = { id: crypto.randomUUID(), ...data, status: 'scheduled', createdAt: Date.now() }; await this.collection.insertOne({ ...m }); return m;
  }
  async update(id, patch) { const result = await this.collection.updateOne({ id }, { $set: patch }); if (!result.matchedCount) throw new Error('Message not found'); }
  async claim(m, now) {
    const result = await this.collection.updateOne({ id: m.id, status: 'scheduled', scheduledAt: m.scheduledAt, phone: m.phone, text: m.text }, { $set: { status: 'sending', attemptedAt: now } });
    return result.modifiedCount === 1;
  }
  async edit(id, input) { const result = await this.collection.updateOne({ id, status: 'scheduled' }, { $set: validate(input) }); if (!result.matchedCount) throw new Error('Only scheduled messages can be edited'); }
  async cancel(id) { const result = await this.collection.updateOne({ id, status: 'scheduled' }, { $set: { status: 'cancelled' } }); if (!result.matchedCount) throw new Error('Only scheduled messages can be cancelled'); }
}
module.exports = { MongoStore };
