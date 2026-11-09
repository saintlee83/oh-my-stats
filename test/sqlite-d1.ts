import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Db, Statement } from '../src/server/db.ts';

/** D1's statement API over plain SQLite, with the real migrations, so tests run anywhere. */
class SqliteStatement implements Statement {
  private database: DatabaseSync;
  private sql: string;
  private values: unknown[] = [];

  constructor(database: DatabaseSync, sql: string) {
    this.database = database;
    this.sql = sql;
  }

  bind(...values: unknown[]): Statement {
    this.values = values;
    return this;
  }

  private params() {
    return this.values as (string | number | null)[];
  }

  async run() {
    return this.database.prepare(this.sql).run(...this.params());
  }

  async all<T>() {
    return { results: this.database.prepare(this.sql).all(...this.params()) as T[] };
  }

  async first<T>() {
    return (this.database.prepare(this.sql).get(...this.params()) as T | undefined) ?? null;
  }
}

export function testDb(): Db & { raw: DatabaseSync } {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(readFileSync(resolve(import.meta.dirname, '../migrations/0001_init.sql'), 'utf8'));
  return {
    raw: database,
    prepare: (sql) => new SqliteStatement(database, sql),
    async batch(statements) {
      database.exec('BEGIN');
      try {
        const out: unknown[] = [];
        for (const statement of statements) out.push(await statement.run());
        database.exec('COMMIT');
        return out;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
