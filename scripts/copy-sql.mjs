// Post-tsc step: copy non-TS assets (SQL files) into the dist tree so the
// runtime migration loader can find them next to the compiled JS.
import { cpSync, existsSync, mkdirSync } from 'node:fs';

mkdirSync('dist/db/migrations', { recursive: true });
cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });

if (existsSync('src/db/schema.sql')) {
  cpSync('src/db/schema.sql', 'dist/db/schema.sql');
}
