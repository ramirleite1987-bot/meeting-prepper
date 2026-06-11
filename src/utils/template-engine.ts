/**
 * Tiny Handlebars-lite template engine used by the HTML view layer.
 *
 * Supported syntax:
 *   {{key}}            – HTML-escaped interpolation; dotted paths supported
 *   {{{key}}}          – raw (unescaped) interpolation, for pre-rendered HTML
 *   {{#if value}}…{{/if}}
 *   {{#if value}}…{{else}}…{{/if}}
 *   {{#each items}}…{{/each}}     – inside the loop, `{{this}}` is the
 *                                   current item and `{{this.prop}}` is a
 *                                   property of the current item; outer scope
 *                                   variables remain accessible by name
 *
 * Block tags are paired by walking the template and tracking nesting depth,
 * so nested `{{#if}}` / `{{#each}}` are handled correctly at any depth.
 */

const BLOCK_TAG_RE = /\{\{(#if\s+[\w.]+|#each\s+[\w.]+|else|\/if|\/each)\}\}/g;
const ELSE_TAG = '{{else}}';

interface BlockBounds {
  elseIdx: number;
  closeIdx: number;
  closeEnd: number;
}

function findBlockBounds(
  template: string,
  innerStart: number,
  blockType: 'if' | 'each',
): BlockBounds | null {
  const re = new RegExp(BLOCK_TAG_RE.source, 'g');
  re.lastIndex = innerStart;
  let depth = 1;
  let elseIdx = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    const tag = m[1];
    if (tag.startsWith('#if ') || tag.startsWith('#each ')) {
      depth++;
    } else if (tag === '/if' || tag === '/each') {
      depth--;
      if (depth === 0) {
        const expected = blockType === 'if' ? '/if' : '/each';
        if (tag !== expected) return null;
        return { elseIdx, closeIdx: m.index, closeEnd: m.index + m[0].length };
      }
    } else if (tag === 'else' && depth === 1 && blockType === 'if' && elseIdx === -1) {
      elseIdx = m.index;
    }
  }
  return null;
}

export function render(template: string, data: Record<string, unknown>): string {
  return renderBlocks(template, data);
}

function renderBlocks(template: string, data: Record<string, unknown>): string {
  const openRe = /\{\{#(if|each)\s+([\w.]+)\}\}/g;
  let out = '';
  let cursor = 0;

  for (;;) {
    openRe.lastIndex = cursor;
    const m = openRe.exec(template);
    if (!m) {
      out += renderInline(template.slice(cursor), data);
      break;
    }

    out += renderInline(template.slice(cursor, m.index), data);

    const blockType = m[1] as 'if' | 'each';
    const blockKey = m[2];
    const innerStart = m.index + m[0].length;
    const bounds = findBlockBounds(template, innerStart, blockType);
    if (!bounds) {
      // Malformed template: surface the broken region verbatim so the bug is visible.
      out += template.slice(m.index);
      cursor = template.length;
      break;
    }

    if (blockType === 'if') {
      const ifSrc =
        bounds.elseIdx >= 0
          ? template.slice(innerStart, bounds.elseIdx)
          : template.slice(innerStart, bounds.closeIdx);
      const elseSrc =
        bounds.elseIdx >= 0
          ? template.slice(bounds.elseIdx + ELSE_TAG.length, bounds.closeIdx)
          : '';
      out += isTruthy(resolveValue(data, blockKey))
        ? renderBlocks(ifSrc, data)
        : renderBlocks(elseSrc, data);
    } else {
      const body = template.slice(innerStart, bounds.closeIdx);
      const arr = resolveValue(data, blockKey);
      if (Array.isArray(arr)) {
        for (const item of arr) {
          out += renderBlocks(body, { ...data, this: item });
        }
      }
    }

    cursor = bounds.closeEnd;
  }

  return out;
}

function renderInline(text: string, data: Record<string, unknown>): string {
  // Unescaped {{{x}}} runs first so the {{x}} pass doesn't strip the inner braces.
  let result = text.replace(/\{\{\{([\w.]+)\}\}\}/g, (_m: string, key: string) => {
    const val = resolveValue(data, key);
    return val !== null && val !== undefined ? String(val) : '';
  });
  result = result.replace(/\{\{([\w.]+)\}\}/g, (_m: string, key: string) => {
    const val = resolveValue(data, key);
    return val !== null && val !== undefined ? escapeHtml(String(val)) : '';
  });
  return result;
}

function resolveValue(data: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((obj, key) => {
    if (obj && typeof obj === 'object') {
      return (obj as Record<string, unknown>)[key];
    }
    return undefined;
  }, data);
}

function isTruthy(val: unknown): boolean {
  if (Array.isArray(val)) return val.length > 0;
  return Boolean(val);
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
