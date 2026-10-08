'use strict';
// Minimal in-memory Firestore stand-in (collections, docs, queries, transactions).
// Transactions are serialised like Firestore's optimistic retry would end up.

const FieldValue = {
  increment: (n) => ({ __inc: n }),
  serverTimestamp: () => ({ __ts: true }),
};

function applyData(existing, data, merge) {
  const base = merge && existing ? { ...existing } : {};
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && '__inc' in v) base[k] = (Number(base[k]) || 0) + v.__inc;
    else if (v && typeof v === 'object' && '__ts' in v) base[k] = 'TS';
    else base[k] = v;
  }
  return base;
}

class FakeFirestore {
  constructor() { this.store = new Map(); this.lock = Promise.resolve(); this.autoId = 0; }
  collection(name) { return new Collection(this, name); }
  seed(path, data) { this.store.set(path, JSON.parse(JSON.stringify(data))); }
  read(path) { const d = this.store.get(path); return d ? JSON.parse(JSON.stringify(d)) : undefined; }
  async runTransaction(fn) {
    const run = this.lock.then(async () => {
      const writes = [];
      const tx = {
        get: async (target) => target.get(),
        set: (ref, data, opts) => writes.push(() => ref._write(data, !!(opts && opts.merge))),
        update: (ref, data) => writes.push(() => {
          if (!this.store.has(ref.path)) throw new Error('NOT_FOUND ' + ref.path);
          ref._write(data, true);
        }),
      };
      const out = await fn(tx);
      writes.forEach((w) => w());
      return out;
    });
    this.lock = run.catch(() => {});
    return run;
  }
}

class Collection {
  constructor(db, name) { this.db = db; this.name = name; this.filters = []; }
  doc(id) { return new DocRef(this.db, this.name, id || 'auto' + (++this.db.autoId)); }
  async add(data) { const r = this.doc(); r._write(data, false); return r; }
  where(f, op, v) { const c = new Collection(this.db, this.name); c.filters = [...this.filters, [f, op, v]]; return c; }
  async get() {
    const docs = [];
    for (const [path, data] of this.db.store) {
      if (!path.startsWith(this.name + '/')) continue;
      if (this.filters.every(([f, , v]) => data[f] === v)) {
        docs.push({ id: path.slice(this.name.length + 1), data: () => JSON.parse(JSON.stringify(data)) });
      }
    }
    return { empty: docs.length === 0, size: docs.length, docs };
  }
}

class DocRef {
  constructor(db, col, id) { this.db = db; this.id = id; this.path = col + '/' + id; this.col = col; }
  _write(data, merge) { this.db.store.set(this.path, applyData(this.db.store.get(this.path), data, merge)); }
  async get() {
    const d = this.db.read(this.path);
    return { exists: d !== undefined, id: this.id, data: () => d };
  }
  async set(data, opts) { this._write(data, !!(opts && opts.merge)); }
  async update(data) { this._write(data, true); }
  async create(data) {
    if (this.db.store.has(this.path)) { const e = new Error('6 ALREADY_EXISTS: Document already exists'); e.code = 6; throw e; }
    this._write(data, false);
  }
}

module.exports = { FakeFirestore, FieldValue };
