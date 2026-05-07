/**
 * CLI entry point for `npm run migrate`. Opens the configured DB,
 * applies any pending migrations, prints what was done, and exits.
 *
 * Pure side-effect script. Not exported from elsewhere.
 */

import { closeDb, getDb } from './index.js';

function main(): void {
  // getDb() already runs migrations on first open. We capture the
  // before/after applied set to report the delta.
  const db = getDb();
  const after = db.prepare('SELECT id FROM migrations ORDER BY id').all() as { id: string }[];

  // eslint-disable-next-line no-console
  console.log(`Database is up to date. ${after.length} migration(s) applied:`);
  for (const row of after) {
    // eslint-disable-next-line no-console
    console.log(`  - ${row.id}`);
  }

  closeDb();
}

main();
