// Post-tsc step: copy non-TS assets into the dist tree so runtime loaders can
// find them next to the compiled JS.
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

rmSync('dist/db/migrations', { recursive: true, force: true });
mkdirSync('dist/db/migrations', { recursive: true });

for (const filename of readdirSync('src/db/migrations')) {
  if (filename.endsWith('.sql') && !filename.startsWith('._')) {
    copyFileSync(join('src/db/migrations', filename), join('dist/db/migrations', filename));
  }
}

if (existsSync('src/db/schema.sql')) {
  cpSync('src/db/schema.sql', 'dist/db/schema.sql');
}

if (existsSync('src/views')) {
  mkdirSync('dist/views', { recursive: true });
  cpSync('src/views', 'dist/views', { recursive: true });
}
