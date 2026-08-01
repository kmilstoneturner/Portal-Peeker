import { describe, expect, it } from 'vitest';
import { stripHtml, looksLikeHtml } from '../src/strip-html.js';

describe('stripHtml: structure is converted, not deleted', () => {
  it('keeps list items as bullets', () => {
    // A checklist that collapses into one run-on paragraph is materially
    // harder to follow, and task bodies are rep-facing instructions.
    const out = stripHtml('<ul><li>First step</li><li>Second step</li></ul>');
    expect(out).toBe('- First step\n- Second step');
  });

  it('keeps emphasis as markdown', () => {
    expect(stripHtml('<p>Call <strong>today</strong> or <em>tomorrow</em></p>')).toBe(
      'Call **today** or *tomorrow*',
    );
  });

  it('keeps paragraph breaks', () => {
    expect(stripHtml('<p>One</p><p>Two</p>')).toBe('One\nTwo');
  });

  it('keeps the href, not just the link text', () => {
    expect(stripHtml('<a href="https://example.invalid/x">the doc</a>')).toBe(
      '[the doc](https://example.invalid/x)',
    );
  });

  it('deletes style and script blocks including their contents', () => {
    expect(stripHtml('<style>p{color:red}</style><p>Body</p>')).toBe('Body');
    expect(stripHtml('<script>var x = 1 < 2;</script><p>Body</p>')).toBe('Body');
  });

  it('drops presentational attributes without dropping the text', () => {
    expect(stripHtml('<div style="color:#333"><span class="x">Text</span></div>')).toBe('Text');
  });
});

describe('stripHtml: what must survive untouched', () => {
  it('preserves every merge token', () => {
    // Merge tokens are text, not markup. They are the part of a body that
    // actually tells you what data the email reads.
    const html = '<p>Hi <strong>{{ contact.firstname }}</strong> {{ _0_1.lastname }}</p>';
    const out = stripHtml(html);
    expect(out.match(/\{\{[^}]*\}\}/g)).toEqual(['{{ contact.firstname }}', '{{ _0_1.lastname }}']);
  });

  it('decodes entities', () => {
    expect(stripHtml('<p>A &amp; B&nbsp;C &lt;tag&gt; &#39;quoted&#39;</p>')).toBe(
      "A & B C <tag> 'quoted'",
    );
  });

  it('leaves a plain-text body alone', () => {
    const plain = 'no markup at all';
    expect(looksLikeHtml(plain)).toBe(false);
    expect(stripHtml(plain)).toBe(plain);
  });

  it('never throws on hostile input', () => {
    for (const input of ['<<<>>>', '<p unclosed', '<a href=>x</a>', '', '<'.repeat(500)]) {
      expect(() => stripHtml(input)).not.toThrow();
    }
    expect(stripHtml(null)).toBeNull();
  });
});

describe('looksLikeHtml', () => {
  it('detects markup', () => {
    expect(looksLikeHtml('<p>x</p>')).toBe(true);
    expect(looksLikeHtml('<br>')).toBe(true);
  });

  it('does not treat a bare comparison as markup', () => {
    expect(looksLikeHtml('price < 5 and qty > 2')).toBe(false);
  });
});
