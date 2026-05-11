import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

export interface GogExecutorOptions {
  bin?: string;
  account?: string;
  timeoutMs?: number;
}

export interface GogStatus {
  available: boolean;
  accountConfigured: boolean;
  message?: string;
}

export class GogExecutor {
  private readonly bin: string;
  private readonly account?: string;
  private readonly timeoutMs: number;

  constructor(options: GogExecutorOptions = {}) {
    this.bin = options.bin ?? config.gogBin;
    this.account = options.account ?? config.gogAccount;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async runJson<T>(args: string[]): Promise<T> {
    const stdout = await this.run([...this.accountArgs(), ...args, '--json', '--no-input']);
    try {
      return JSON.parse(stdout) as T;
    } catch (error) {
      throw new Error(`gog returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async status(): Promise<GogStatus> {
    try {
      await this.run(['--version']);
      return {
        available: true,
        accountConfigured: Boolean(this.account),
      };
    } catch (error) {
      return {
        available: false,
        accountConfigured: Boolean(this.account),
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private accountArgs(): string[] {
    return this.account ? ['--account', this.account] : [];
  }

  private async run(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync(this.bin, args, {
        timeout: this.timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout.trim();
    } catch (error) {
      throw this.toGogError(error);
    }
  }

  private toGogError(error: unknown): Error {
    if (!error || typeof error !== 'object') {
      return new Error(String(error));
    }

    const err = error as NodeJS.ErrnoException & { stderr?: string; code?: string | number };
    if (err.code === 'ENOENT') {
      return new Error(`gog binary not found at "${this.bin}"`);
    }

    const diagnostics = err.stderr?.trim();
    return new Error(diagnostics || err.message || 'gog command failed');
  }
}

