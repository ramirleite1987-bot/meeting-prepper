/**
 * Restrict post-form redirects to in-app relative paths.
 * Rejects absolute URLs, protocol-relative hosts, backslashes, and header-breaking control chars.
 */
export function safeInternalPath(target: unknown, fallback: string): string {
  if (typeof target !== 'string' || target.length === 0) {
    return fallback;
  }
  if (target.includes('\\') || /[\r\n\0]/.test(target)) {
    return fallback;
  }
  if (!target.startsWith('/') || target.startsWith('//')) {
    return fallback;
  }
  if (target.includes('://')) {
    return fallback;
  }
  return target;
}
