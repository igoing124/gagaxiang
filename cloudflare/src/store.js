'use strict';

// Durable Object SQLite 文档存储：把原来 data/*.json 的内容按文件名存成一行 JSON。
// DO 里 ctx.storage.sql 是同步 API，和 Node 的同步文件写入语义一致，
// 因此单个门店的所有请求天然串行，不会出现两个订单互相覆盖。

export class DocStore {
  constructor(sql) {
    this.sql = sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS docs (
         name TEXT PRIMARY KEY,
         body TEXT NOT NULL,
         updated_at INTEGER NOT NULL
       )`
    );
  }

  has(name) {
    const rows = this.sql
      .exec('SELECT name FROM docs WHERE name = ? LIMIT 1', name)
      .toArray();
    return rows.length > 0;
  }

  read(name, fallback) {
    const rows = this.sql
      .exec('SELECT body FROM docs WHERE name = ? LIMIT 1', name)
      .toArray();

    if (rows.length === 0) return fallback;
    return JSON.parse(rows[0].body);
  }

  write(name, value) {
    this.sql.exec(
      `INSERT INTO docs (name, body, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
      name,
      JSON.stringify(value),
      Date.now()
    );
  }

  list(prefix) {
    const rows = this.sql
      .exec(
        'SELECT name, body FROM docs WHERE name LIKE ? ORDER BY name',
        String(prefix || '') + '%'
      )
      .toArray();

    return rows.map((row) => ({
      name: row.name,
      value: JSON.parse(row.body),
    }));
  }
}

// 内存版存储，给 Node 测试和本地预览用，接口与 DocStore 相同。
export class MemoryStore {
  constructor(initial) {
    this.docs = new Map(Object.entries(initial || {}));
  }

  has(name) {
    return this.docs.has(name);
  }

  read(name, fallback) {
    if (!this.docs.has(name)) return fallback;
    return JSON.parse(JSON.stringify(this.docs.get(name)));
  }

  write(name, value) {
    this.docs.set(name, JSON.parse(JSON.stringify(value)));
  }

  list(prefix) {
    const keyPrefix = String(prefix || '');
    return Array.from(this.docs.entries())
      .filter(([name]) => name.startsWith(keyPrefix))
      .map(([name, value]) => ({
        name,
        value: JSON.parse(JSON.stringify(value)),
      }));
  }
}
