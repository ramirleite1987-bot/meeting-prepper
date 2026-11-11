import { describe, it, expect } from 'vitest';
import { safeInternalPath } from '../../src/utils/internal-redirect.js';

describe('safeInternalPath', () => {
  const fallback = '/action-items';

  it('keeps in-app relative paths', () => {
    expect(safeInternalPath('/action-items', fallback)).toBe('/action-items');
    expect(safeInternalPath('/action-items?status=pending', fallback)).toBe(
      '/action-items?status=pending',
    );
  });

  it('rejects absolute and protocol-relative URLs', () => {
    expect(safeInternalPath('https://attacker.example/phish', fallback)).toBe(fallback);
    expect(safeInternalPath('http://attacker.example/phish', fallback)).toBe(fallback);
    expect(safeInternalPath('//attacker.example/phish', fallback)).toBe(fallback);
  });

  it('rejects missing, empty, and header-breaking values', () => {
    expect(safeInternalPath(undefined, fallback)).toBe(fallback);
    expect(safeInternalPath('', fallback)).toBe(fallback);
    expect(safeInternalPath('/ok\r\nLocation: https://evil', fallback)).toBe(fallback);
    expect(safeInternalPath('\\evil', fallback)).toBe(fallback);
  });
});
