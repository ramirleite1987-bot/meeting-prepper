/**
 * Tiny SQLite migration runner.
 *
 * Why hand-rolled instead of a library: this project is single-process,
 * single-user, embeddable. The whole runner fits in <100 lines and adds
 * zero dependencies. Anything bigger (Umzug, Drizzle Kit) is overkill.
 *
 * How it works:
 *   - Each migration is a `.sql` file under `src/db/migrations/`.
 *   - Files are applied in lexicographic order (use a 3-digit prefix:
 *     001-initial.sql, 002-add-X.sql, ...).
 *   - A `migrations` table records what's already applied, by filename.
 *   - Each migration runs inside a transaction; failure rolls back and
 *     the migration is *not* recorded → safe to re-run after a fix.
 *   - Reaplication is a no-op (skips rows already in `migrations`).
 *
 * The first migration (001-initial.sql) uses `CREATE TABLE IF NOT EXISTS`
 * so it can be applied to existing databases that predate this tooling
 * without conflict. Future migrations should use plain DDL so any
 * unexpected drift surfaces as a hard error.
 */

import type { Database } from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';

const log = logger.child('Migrate');

export interface Migration {
  /** Filename used as primary key in the migrations table (e.g. "001-initial.sql"). */
  id: string;
  sql: string;
}

/** Load and sort migration files from a directory. */
export function loadMigrations(dir: string): Migration[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  return files.map((f) => ({
    id: f,
    sql: readFileSync(join(dir, f), 'utf-8'),
  }));
}

/** Ensure the bookkeeping table exists. Idempotent. */
function ensureMigrationsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id TEXT PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

/** Returns the IDs of migrations already applied to this DB. */
export function getAppliedMigrationIds(db: Database): Set<string> {
  ensureMigrationsTable(db);
  const rows = db.prepare('SELECT id FROM migrations').all() as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/**
 * Apply pending migrations in order. Returns the IDs that were applied
 * in this run (empty array if everything was already up to date).
 *
 * Each migration runs in its own transaction. If a migration fails the
 * transaction is rolled back and the loop aborts — leaving the DB in a
 * known-good state at the most recent successful migration.
 */
export function applyMigrations(db: Database, migrations: Migration[]): string[] {
  const applied = getAppliedMigrationIds(db);
  const newlyApplied: string[] = [];
  const insertRow = db.prepare('INSERT INTO migrations (id) VALUES (?)');

  for (const m of migrations) {
    if (applied.has(m.id)) {
      log.debug('Migration already applied', { id: m.id });
      continue;
    }
    log.info('Applying migration', { id: m.id });
    const tx = db.transaction(() => {
      db.exec(m.sql);
      insertRow.run(m.id);
    });
    tx();
    newlyApplied.push(m.id);
  }

  if (newlyApplied.length > 0) {
    log.info('Migrations applied', { count: newlyApplied.length, ids: newlyApplied });
  }

  return newlyApplied;
}

/**
 * Resolve the default migrations directory based on the location of
 * this compiled module. In dev (tsx) this points at `src/db/migrations`;
 * in prod (after `npm run build`), at `dist/db/migrations` — the build
 * step copies the SQL files into place.
 */
export function getDefaultMigrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'migrations');
}

/** Convenience: load + apply, using the default directory. */
export function runMigrations(db: Database, dir: string = getDefaultMigrationsDir()): string[] {
  const migrations = loadMigrations(dir);
  return applyMigrations(db, migrations);
}
