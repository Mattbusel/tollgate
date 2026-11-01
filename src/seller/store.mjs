// Seller-side storage: the newest voucher per channel (this is the seller's money, so the file
// store writes it to disk before the paid response is sent) and a ring buffer of receipts.
import fs from 'node:fs';
import path from 'node:path';

export class MemoryStore {
  constructor({ maxReceipts = 1000 } = {}) {
    this.data = { channels: {}, receipts: [] };
    this.maxReceipts = maxReceipts;
  }
  getChannel(id) {
    const c = this.data.channels[String(id)];
    return c ? { ...c } : null;
  }
  putChannel(id, c) {
    this.data.channels[String(id)] = { ...c };
    this.persist();
  }
  *channels() {
    for (const [id, c] of Object.entries(this.data.channels)) yield [id, { ...c }];
  }
  addReceipt(r) {
    this.data.receipts.push(r);
    if (this.data.receipts.length > this.maxReceipts) this.data.receipts.splice(0, this.data.receipts.length - this.maxReceipts);
    this.persist();
  }
  receipts(limit = 100) {
    return this.data.receipts.slice(-limit).reverse();
  }
  markSettled(id, nonce, tx) {
    for (const r of this.data.receipts) {
      if (r.channel_id === String(id) && BigInt(r.nonce) <= nonce && !r.settled) {
        r.settled = true;
        r.settle_tx = tx;
      }
    }
    this.persist();
  }
  persist() {}
}

/** JSON file store. Synchronous writes keep check-and-commit atomic in one Node process. */
export class FileStore extends MemoryStore {
  constructor(file, opts) {
    super(opts);
    this.file = file;
    if (fs.existsSync(file)) {
      try {
        this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        throw new Error(`seller store ${file} is not valid JSON; refusing to start and lose vouchers`);
      }
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
  }
  persist() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}
