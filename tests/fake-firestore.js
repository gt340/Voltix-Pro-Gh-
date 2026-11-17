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
  constructor(db, name) {
    this.db = db; this.name = name; this.filters = [];
    this.orderBys = []; this.maxDocs = null; this.cursorValues = null;
  }
  doc(id) { return new DocRef(this.db, this.name, id || 'auto' + (++this.db.autoId)); }
  async add(data) { const r = this.doc(); r._write(data, false); return r; }
  where(f, op, v) {
    const c = this._copy(); c.filters = [...this.filters, [f, op, v]]; return c;
  }
  orderBy(field, direction) {
    const c = this._copy(); c.orderBys = [...this.orderBys, [field, direction || 'asc']]; return c;
  }
  limit(n) {
    const c = this._copy(); c.maxDocs = n; return c;
  }
  startAfter(...values) {
    const c = this._copy(); c.cursorValues = values; return c;
  }
  _copy() {
    const c = new Collection(this.db, this.name);
    c.filters = [...this.filters]; c.orderBys = [...this.orderBys];
    c.maxDocs = this.maxDocs; c.cursorValues = this.cursorValues;
    return c;
  }
  async get() {
    const docs = [];
    for (const [path, data] of this.db.store) {
      if (!path.startsWith(this.name + '/')) continue;
      if (this.filters.every(([f, op, v]) => {
        const actual = data[f];
        if (op === '==') return actual === v;
        if (op === '<=') return actual !== undefined && actual <= v;
        if (op === '<') return actual !== undefined && actual < v;
        if (op === '>=') return actual !== undefined && actual >= v;
        if (op === '>') return actual !== undefined && actual > v;
        return false;
      })) {
        docs.push({ id: path.slice(this.name.length + 1), data: () => JSON.parse(JSON.stringify(data)) });
      }
    }
    const compare = (a, b) => {
      for (const [field, direction] of this.orderBys) {
        const av = field === '__name__' ? a.id : a.data()[field];
        const bv = field === '__name__' ? b.id : b.data()[field];
        if (av === bv) continue;
        const result = av < bv ? -1 : 1;
        return direction === 'desc' ? -result : result;
      }
      return 0;
    };
    if (this.orderBys.length) docs.sort(compare);
    let page = docs;
    if (this.cursorValues && this.orderBys.length === this.cursorValues.length) {
      page = page.filter(doc => {
        for (let i = 0; i < this.orderBys.length; i++) {
          const [field, direction] = this.orderBys[i];
          const actual = field === '__name__' ? doc.id : doc.data()[field];
          const cursor = this.cursorValues[i];
          if (actual === cursor) continue;
          const result = actual < cursor ? -1 : 1;
          return (direction === 'desc' ? -result : result) > 0;
        }
        return false;
      });
    }
    if (Number.isSafeInteger(this.maxDocs)) page = page.slice(0, this.maxDocs);
    return { empty: page.length === 0, size: page.length, docs: page };
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
