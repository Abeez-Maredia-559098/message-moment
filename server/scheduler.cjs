class Scheduler {
  constructor(store, adapter, now = Date.now) { this.store = store; this.adapter = adapter; this.now = now; this.busy = false; }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const due = this.store.due ? await this.store.due(this.now()) : (await this.store.list()).filter(m => m.status === 'scheduled' && m.scheduledAt <= this.now()).sort((a,b) => a.scheduledAt-b.scheduledAt);
      for (const m of due) {
        // Avoid unexpected hours-late sends after a sleeping/offline computer returns.
        if (this.now() - m.scheduledAt > 15 * 60000) { await this.store.update(m.id, { status: 'missed', error: 'More than 15 minutes late. Create a new schedule if still needed.' }); continue; }
        if (!this.adapter.ready) break;
        // Check registration before attempting a send; failures here cannot deliver a message.
        let chat;
        try { chat = await this.adapter.lookup(m.phone); } catch { break; }
        if (!chat) { await this.store.update(m.id, { status: 'failed', error: 'This phone number is not registered on WhatsApp.' }); continue; }
        if (!await this.store.claim(m, this.now())) continue;
        try {
          const result = await this.adapter.send(chat, m.text);
          await this.store.update(m.id, { status: 'sent', sentAt: this.now(), whatsappId: result.id });
        } catch {
          await this.store.update(m.id, { status: 'uncertain', error: 'WhatsApp did not confirm the send. Check the chat before creating another schedule.' });
        }
      }
    } finally { this.busy = false; }
  }
}
module.exports = { Scheduler };
