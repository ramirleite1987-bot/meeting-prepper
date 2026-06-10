import { describe, it, expect } from 'vitest';
import { render, escapeHtml } from '../../src/utils/template-engine.js';

describe('template-engine', () => {
  describe('escapeHtml', () => {
    it('escapes HTML special characters', () => {
      expect(escapeHtml('<script>alert("x")</script>')).toBe(
        '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
      );
    });

    it('escapes ampersands first so other escapes do not get double-encoded', () => {
      expect(escapeHtml('Tom & Jerry > all')).toBe('Tom &amp; Jerry &gt; all');
    });
  });

  describe('simple substitutions', () => {
    it('replaces {{key}} with HTML-escaped values', () => {
      expect(render('Hello {{name}}', { name: '<b>World</b>' })).toBe(
        'Hello &lt;b&gt;World&lt;/b&gt;',
      );
    });

    it('replaces {{{key}}} with raw values', () => {
      expect(render('Hello {{{name}}}', { name: '<b>World</b>' })).toBe('Hello <b>World</b>');
    });

    it('resolves dotted paths', () => {
      expect(render('{{user.name}}', { user: { name: 'Ana' } })).toBe('Ana');
    });

    it('renders empty string for missing keys', () => {
      expect(render('Hello {{missing}}!', {})).toBe('Hello !');
    });

    it('renders empty string for null and undefined values', () => {
      expect(render('a={{a}};b={{b}}', { a: null, b: undefined })).toBe('a=;b=');
    });
  });

  describe('{{#if}} blocks', () => {
    it('renders the body when truthy', () => {
      expect(render('{{#if show}}YES{{/if}}', { show: true })).toBe('YES');
    });

    it('skips the body when falsy', () => {
      expect(render('{{#if show}}YES{{/if}}', { show: false })).toBe('');
    });

    it('renders the else branch when falsy', () => {
      expect(render('{{#if show}}YES{{else}}NO{{/if}}', { show: false })).toBe('NO');
    });

    it('treats empty arrays as falsy', () => {
      expect(render('{{#if items}}some{{else}}none{{/if}}', { items: [] })).toBe('none');
    });

    it('treats non-empty arrays as truthy', () => {
      expect(render('{{#if items}}some{{else}}none{{/if}}', { items: [1] })).toBe('some');
    });
  });

  describe('{{#each}} blocks', () => {
    it('iterates and exposes {{this.prop}}', () => {
      const tpl = '{{#each items}}<li>{{this.name}}</li>{{/each}}';
      const out = render(tpl, { items: [{ name: 'a' }, { name: 'b' }] });
      expect(out).toBe('<li>a</li><li>b</li>');
    });

    it('exposes {{this}} for primitive items', () => {
      expect(render('{{#each items}}{{this}}|{{/each}}', { items: [1, 2, 3] })).toBe('1|2|3|');
    });

    it('emits nothing for empty arrays', () => {
      expect(render('<ul>{{#each items}}<li>{{this}}</li>{{/each}}</ul>', { items: [] })).toBe(
        '<ul></ul>',
      );
    });

    it('emits nothing when the key is missing or not an array', () => {
      expect(render('{{#each items}}x{{/each}}', {})).toBe('');
      expect(render('{{#each items}}x{{/each}}', { items: 'not-array' })).toBe('');
    });

    it('keeps outer-scope variables accessible inside the loop', () => {
      const tpl = '{{#each items}}{{prefix}}{{this}};{{/each}}';
      expect(render(tpl, { prefix: 'item ', items: ['a', 'b'] })).toBe('item a;item b;');
    });
  });

  describe('nested blocks (the original engine bug)', () => {
    it('handles {{#each}} nested directly inside {{#each}}', () => {
      const tpl = '{{#each rows}}[{{#each this.cells}}{{this}},{{/each}}]{{/each}}';
      const out = render(tpl, {
        rows: [{ cells: [1, 2] }, { cells: [3, 4, 5] }],
      });
      expect(out).toBe('[1,2,][3,4,5,]');
    });

    it('handles top-level nested {{#if}} blocks', () => {
      const tpl = '{{#if a}}A({{#if b}}B{{/if}}){{/if}}';
      expect(render(tpl, { a: true, b: true })).toBe('A(B)');
      expect(render(tpl, { a: true, b: false })).toBe('A()');
      expect(render(tpl, { a: false, b: true })).toBe('');
    });

    it('handles {{#each}} containing nested {{#if}} with {{else}}', () => {
      const tpl =
        '{{#each items}}<li>{{this.name}}{{#if this.starred}} ★{{else}} ☆{{/if}}</li>{{/each}}';
      const out = render(tpl, {
        items: [
          { name: 'a', starred: true },
          { name: 'b', starred: false },
        ],
      });
      expect(out).toBe('<li>a ★</li><li>b ☆</li>');
    });

    it('handles {{#if}} inside {{else}} inside {{#each}} (deeply nested)', () => {
      const tpl =
        '{{#each items}}{{#if this.ok}}OK{{else}}{{#if this.retryable}}retry{{else}}fail{{/if}}{{/if}};{{/each}}';
      const out = render(tpl, {
        items: [{ ok: true }, { ok: false, retryable: true }, { ok: false, retryable: false }],
      });
      expect(out).toBe('OK;retry;fail;');
    });

    it('does not leak template tags when nested blocks are used', () => {
      const tpl =
        '<ul>{{#if hasItems}}{{#each items}}<li>{{this.name}}</li>{{/each}}{{else}}<li>empty</li>{{/if}}</ul>';
      const empty = render(tpl, { hasItems: false, items: [] });
      const full = render(tpl, { hasItems: true, items: [{ name: 'x' }] });
      expect(empty).toBe('<ul><li>empty</li></ul>');
      expect(full).toBe('<ul><li>x</li></ul>');
      for (const out of [empty, full]) {
        expect(out).not.toMatch(/\{\{[#/]/);
        expect(out).not.toContain('{{else}}');
      }
    });
  });

  describe('robustness', () => {
    it('emits the broken region verbatim for an unclosed block (so the bug is visible)', () => {
      const out = render('before {{#if a}}inside', { a: true });
      expect(out).toContain('{{#if a}}inside');
    });

    it('does not mistake {{else}} of an outer if for an inner else', () => {
      const tpl = '{{#if outer}}before;{{#if inner}}IN{{/if}};after{{else}}OUT{{/if}}';
      expect(render(tpl, { outer: true, inner: true })).toBe('before;IN;after');
      expect(render(tpl, { outer: false })).toBe('OUT');
    });
  });
});
