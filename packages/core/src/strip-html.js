// Pure. HTML string in, plain text out.
//
// Used only by the optional "strip HTML from email bodies" toggle, and only on
// actions.*.metadata.body. Unlike trim.js this is a transformation, not a
// subtraction: it rewrites values rather than removing keys. That is precisely
// why it is a separate toggle. Anything that rewrites content cannot carry the
// guarantee that every value in the output came verbatim from the input.
//
// Structured, not naive. Deleting every tag saves about 5 percent more on a
// real workflow and destroys the list structure, emphasis, and paragraph breaks
// that carry the meaning in a rep-facing task body. Converting costs roughly a
// thousand tokens on a 200-action flow, which is a trade worth making.
//
// Merge tokens are plain text, not markup, so they are untouched by every rule
// here. That matters: they are the part of a body an AI actually reasons about.

const ENTITIES = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&mdash;': ', ',
  '&ndash;': '-',
  '&hellip;': '...',
  '&rsquo;': "'",
  '&lsquo;': "'",
  '&rdquo;': '"',
  '&ldquo;': '"',
};

function decodeEntities(text) {
  return text
    .replace(/&[a-zA-Z]+;/g, (match) => (match in ENTITIES ? ENTITIES[match] : match))
    .replace(/&#(\d+);/g, (match, code) => {
      const point = Number(code);
      return Number.isFinite(point) && point > 0 && point < 0x10ffff
        ? String.fromCodePoint(point)
        : match;
    });
}

const innerText = (html) => html.replace(/<[^>]+>/g, '').trim();

/**
 * True when the string looks like it contains markup worth converting. Used so
 * a plain-text body is left byte-identical rather than round-tripped through
 * whitespace collapsing for no reason.
 */
export function looksLikeHtml(value) {
  return typeof value === 'string' && /<[a-zA-Z][a-zA-Z0-9]*\b[^>]*>|<\/[a-zA-Z]/.test(value);
}

/**
 * @param {string} html
 * @returns {string} plain text with markdown-ish structure preserved
 */
export function stripHtml(html) {
  if (typeof html !== 'string' || html === '') return html;

  try {
    let text = html;

    // Style and script blocks are pure noise: remove content and all.
    text = text.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');

    // Links before generic tag removal, so the href survives. Only 4 anchors
    // appeared in the flow this was measured against, but a marketing-heavy
    // portal is a different story and a dropped URL is unrecoverable.
    //
    // Markdown link syntax specifically, because an angle-bracket form like
    // `label <url>` gets eaten by the generic tag stripper further down.
    text = text.replace(
      /<a\b[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a\s*>/gi,
      (match, href, inner) => {
        const label = innerText(inner);
        if (!href) return label;
        return label && label !== href ? `[${label}](${href})` : href;
      },
    );

    // Emphasis to markdown. Nested tags inside are flattened.
    text = text.replace(
      /<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi,
      (match, tag, inner) => {
        const label = innerText(inner);
        return label ? `**${label}**` : '';
      },
    );
    text = text.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (match, tag, inner) => {
      const label = innerText(inner);
      return label ? `*${label}*` : '';
    });

    // Block structure to newlines. List items become bullets: a checklist that
    // collapses into one run-on paragraph is materially harder to follow.
    // Opening <li> starts the bullet, so </li> must not add a second break.
    // Same reasoning for block tags generally: break on the close only, or
    // every paragraph ends up separated by a blank line it did not have.
    text = text.replace(/<li\b[^>]*>/gi, '\n- ');
    text = text.replace(/<hr\s*\/?>/gi, '\n---\n');
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/(p|div|tr|h[1-6]|ul|ol|table|blockquote)\s*>/gi, '\n');

    // Everything left over goes.
    text = text.replace(/<[^>]+>/g, '');

    text = decodeEntities(text);

    // Collapse runs of spaces and blank lines, but keep single breaks.
    text = text
      .replace(/[ \t ]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return text;
  } catch {
    // A body that defeats the converter is returned untouched. Degrading to the
    // original HTML is always better than losing the content.
    return html;
  }
}
