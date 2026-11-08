// Prose extraction for the spell check. maskNonProse returns the text with
// everything that is not prose replaced by spaces, newlines kept, so offsets
// and line numbers in the result are the ones in the source file.
//
// Kept: the title and description frontmatter values, and body text outside
// code. Blanked: the rest of the frontmatter, fenced and indented code blocks,
// inline code, HTML comments and tags, Hugo shortcodes, link and image
// targets, bare URLs, email addresses, and file-path-like tokens.
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const PROSE_KEYS = /^(title|description)\s*:/i;

const blank = (s) => s.replace(/[^\n]/g, ' ');

// Inline patterns, applied to one line at a time, in order.
const INLINE = [
  /`+[^`]*`+/g, // inline code
  /<!--.*?-->/g, // one-line HTML comment
  /\{\{[<%].*?[>%]\}\}/g, // Hugo shortcode
  /<\/?[A-Za-z][^>]*>/g, // HTML tag
  /\]\([^)]*\)/g, // link or image target
  /^\s*\[[^\]]+\]:\s*\S+.*$/g, // reference link definition
  /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, // URL
  /\bwww\.\S+/gi,
  /\S+@\S+\.\S+/g, // email
  /(?:^|\s)[~.]?\/\S+/g, // absolute or relative path
  /\S+\.(?:ya?ml|json|toml|conf|cfg|sh|py|go|js|mjs|ts|md|txt|log|tgz|tar|gz|zip|service|socket|crt|key|pem|csr|ini|xml|html?|css|env)\b/gi,
  /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, // shell variable
  /\b[A-Za-z0-9]+(?:[_.:/=][A-Za-z0-9]+)+\b/g, // snake_case, dotted.names, key=value, a/b
];

export function maskNonProse(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const delim = lines[0] !== undefined && lines[0].trimEnd();
  if (delim === '---' || delim === '+++') {
    out.push(blank(lines[0]));
    i = 1;
    for (; i < lines.length && lines[i].trimEnd() !== delim; i++) {
      const m = lines[i].match(PROSE_KEYS);
      if (m) out.push(blank(lines[i].slice(0, m[0].length)) + maskInline(lines[i].slice(m[0].length)));
      else out.push(blank(lines[i]));
    }
    if (i < lines.length) out.push(blank(lines[i]));
    i++;
  }
  let fence = null;
  let comment = false;
  let prevBlank = true;
  let indented = false;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (comment) {
      out.push(blank(line));
      if (line.includes('-->')) comment = false;
      continue;
    }
    const f = FENCE.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
      out.push(blank(line));
      continue;
    }
    if (fence) {
      out.push(blank(line));
      continue;
    }
    if (line.includes('<!--') && !line.includes('-->')) {
      comment = true;
      out.push(blank(line));
      continue;
    }
    // An indented code block starts after a blank line and runs while lines
    // stay indented (or blank).
    const isBlank = line.trim() === '';
    const isIndented = /^(?: {4}|\t)/.test(line) && !/^\s*(?:[-*+]|\d+[.)])\s/.test(line);
    if (!isBlank) indented = isIndented && (prevBlank || indented);
    prevBlank = isBlank;
    if (indented && !isBlank) {
      out.push(blank(line));
      continue;
    }
    out.push(maskInline(line));
  }
  return out.join('\n');
}

export function maskInline(line) {
  let s = line;
  for (const re of INLINE) s = s.replace(re, blank);
  return s;
}
