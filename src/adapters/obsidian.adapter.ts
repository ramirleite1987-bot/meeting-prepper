/**
 * Obsidian adapter for the Client Briefing Generator.
 * Reads markdown files from a configured vault path and searches
 * for client-related notes by filename and content matching.
 */

import { readdir, readFile, access } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { IContextAdapter, ContextEntry } from './types.js';

interface ObsidianFrontmatter {
  [key: string]: unknown;
}

function parseFrontmatter(content: string): {
  data: ObsidianFrontmatter;
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { data: {}, body: content };
  }

  const data: ObsidianFrontmatter = {};
  const lines = match[1].split('\n');
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) {
      data[key] = value;
    }
  }

  return { data, body: match[2] };
}

async function findMarkdownFiles(dirPath: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      const nested = await findMarkdownFiles(fullPath);
      files.push(...nested);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }

  return files;
}

export class ObsidianAdapter implements IContextAdapter {
  readonly name = 'obsidian';
  readonly source = 'obsidian';

  private vaultPath: string | undefined;

  constructor(vaultPath?: string) {
    this.vaultPath = vaultPath ?? process.env.OBSIDIAN_VAULT_PATH;
  }

  async initialize(): Promise<void> {
    // Vault path is resolved lazily; nothing to initialize
  }

  async isAvailable(): Promise<boolean> {
    if (!this.vaultPath) return false;
    try {
      await access(this.vaultPath);
      return true;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    // No persistent connections to clean up
  }

  async getClientContext(
    clientName: string,
    options?: { since?: Date; limit?: number },
  ): Promise<ContextEntry[]> {
    if (!(await this.isAvailable())) {
      return [];
    }

    const files = await findMarkdownFiles(this.vaultPath!);
    const pattern = clientName.toLowerCase();
    const entries: ContextEntry[] = [];

    for (const filePath of files) {
      const fileName = basename(filePath, '.md').toLowerCase();
      const raw = await readFile(filePath, 'utf-8');
      const nameInFile = fileName.includes(pattern);
      const contentMatch = raw.toLowerCase().includes(pattern);

      if (!nameInFile && !contentMatch) continue;

      const { data, body } = parseFrontmatter(raw);

      const timestamp = data.date
        ? new Date(data.date as string)
        : new Date();

      if (options?.since && timestamp < options.since) continue;

      entries.push({
        source: this.source,
        type: 'note',
        title: basename(filePath, '.md'),
        content: body.trim(),
        timestamp,
        metadata: Object.keys(data).length > 0 ? data : undefined,
      });

      if (options?.limit && entries.length >= options.limit) break;
    }

    return entries;
  }
}
