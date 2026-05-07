import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  getAppliedMigrationIds,
  loadMigrations,
} from '../../../src/db/migrate.js';

function makeMigrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-test-'));
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(join(dir, name), sql);
  }
  return dir;
}

describe('migration runner', () => {
  let db: Database.Database;
  let migrationsDir: string | null = null;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
    if (migrationsDir) {
      rmSync(migrationsDir, { recursive: true, force: true });
      migrationsDir = null;
    }
  });

  it('loads migrations sorted by filename', () => {
    migrationsDir = makeMigrationsDir({
      '002-second.sql': 'CREATE TABLE b (id TEXT);',
      '001-first.sql': 'CREATE TABLE a (id TEXT);',
      '010-tenth.sql': 'CREATE TABLE c (id TEXT);',
      'README.md': 'not a migration',
    });

    const migrations = loadMigrations(migrationsDir);
    expect(migrations.map((m) => m.id)).toEqual([
      '001-first.sql',
      '002-second.sql',
      '010-tenth.sql',
    ]);
  });

  it('applies pending migrations in order on a fresh DB', () => {
    const migrations = [
      { id: '001-first.sql', sql: 'CREATE TABLE a (id TEXT);' },
      { id: '002-second.sql', sql: 'CREATE TABLE b (id TEXT);' },
    ];

    const applied = applyMigrations(db, migrations);

    expect(applied).toEqual(['001-first.sql', '002-second.sql']);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('a');
    expect(tables.map((t) => t.name)).toContain('b');
    expect(tables.map((t) => t.name)).toContain('migrations');
  });

  it('is idempotent: re-running applies nothing', () => {
    const migrations = [{ id: '001-first.sql', sql: 'CREATE TABLE a (id TEXT);' }];

    expect(applyMigrations(db, migrations)).toEqual(['001-first.sql']);
    expect(applyMigrations(db, migrations)).toEqual([]);
  });

  it('applies only pending when DB is partially up to date', () => {
    const m1 = { id: '001-first.sql', sql: 'CREATE TABLE a (id TEXT);' };
    const m2 = { id: '002-second.sql', sql: 'CREATE TABLE b (id TEXT);' };

    applyMigrations(db, [m1]);
    const applied = applyMigrations(db, [m1, m2]);

    expect(applied).toEqual(['002-second.sql']);
  });

  it('rolls back a failing migration and does not record it', () => {
    const good = { id: '001-good.sql', sql: 'CREATE TABLE a (id TEXT);' };
    const bad = { id: '002-bad.sql', sql: 'CREATE TABLE a (id TEXT); /* dup */' };

    applyMigrations(db, [good]);
    expect(() => applyMigrations(db, [good, bad])).toThrow();

    const ids = getAppliedMigrationIds(db);
    expect(ids.has('001-good.sql')).toBe(true);
    expect(ids.has('002-bad.sql')).toBe(false);
  });

  it('records applied_at when a migration runs', () => {
    applyMigrations(db, [{ id: '001-first.sql', sql: 'CREATE TABLE a (id TEXT);' }]);
    const row = db
      .prepare('SELECT id, applied_at FROM migrations WHERE id = ?')
      .get('001-first.sql') as { id: string; applied_at: string };
    expect(row.id).toBe('001-first.sql');
    expect(row.applied_at).toBeTruthy();
  });

  it('the real 001-initial.sql migration produces all expected tables', async () => {
    // Smoke test: load the actual migration directory used in production
    // and verify the schema exists after applying.
    const realDir = join(process.cwd(), 'src/db/migrations');
    const migrations = loadMigrations(realDir);
    applyMigrations(db, migrations);

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((t) => t.name);

    for (const expected of [
      'clients',
      'meetings',
      'meeting_sources',
      'action_items',
      'linear_sync',
      'client_history',
      'migrations',
    ]) {
      expect(tables).toContain(expected);
    }
  });
});
