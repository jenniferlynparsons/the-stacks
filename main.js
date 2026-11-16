'use strict';
/*
 * The Stacks — a home library of thousands of books in Obsidian.
 * One note per book. Find any book fast, browse by author, genre or topic,
 * keep shelf locations loosely, catch duplicates, log reading by year,
 * and import whole lists at once. Plain JavaScript, no build step.
 */
const obsidian = require('obsidian');
const {
  Plugin, ItemView, Modal, Notice, Setting, PluginSettingTab, TFile, Menu,
  MarkdownRenderChild, normalizePath, requestUrl, setIcon, debounce,
} = obsidian;

const VIEW_TYPE = 'the-stacks-view';
const STATUSES = ['unread', 'reading', 'read'];
const STATUS_LABEL = { '': 'Not set', unread: 'Unread', reading: 'Reading', read: 'Read' };
const DEFAULT_FORMATS = ['Hardcover', 'Paperback', 'Mass market', 'Graphic novel', 'Comic', 'Zine', 'Ebook', 'Audiobook'];

const DEFAULT_SETTINGS = {
  booksFolder: 'Books',
  importsFolder: 'Imports',
  exportsFolder: 'Exports',
  pageSize: 100,
  formats: DEFAULT_FORMATS,
  defaultStatus: 'unread',
  openOnStartup: true,
  showCovers: true,
  ignoredDupes: [],
};

/* Fields a book note can have, in frontmatter order. */
const FIELDS = ['title', 'author', 'status', 'genre', 'topics', 'format', 'owned', 'source', 'room', 'shelf', 'signed', 'edition',
  'isbn', 'year', 'read', 'started', 'added', 'cover', 'link'];

/* ------------------------------------------------------------------ */
/* Pure helpers                                                       */
/* ------------------------------------------------------------------ */

function pad(n) { return String(n).padStart(2, '0'); }
function todayStr(d) { d = d || new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function toDateStr(v) {
  if (!v) return '';
  if (v instanceof Date) return isNaN(v) ? '' : v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); // US m/d/yyyy
  if (m) return `${m[3]}-${pad(m[1])}-${pad(m[2])}`;
  m = s.match(/^(\d{4})$/);
  if (m) return m[1];
  return '';
}
function yearOf(d) { const m = String(d || '').match(/^(\d{4})/); return m ? m[1] : ''; }
function parseLocal(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); }
function shortDate(s) { return /^\d{4}-\d\d-\d\d$/.test(s || '') ? parseLocal(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : (s || ''); }
function niceDate(s) {
  if (!s) return '';
  if (/^\d{4}$/.test(s)) return s;
  return parseLocal(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtNum(n) { return Number(n).toLocaleString('en-US'); }

function stripLink(v) {
  let s = String(v == null ? '' : v).trim();
  const m = s.match(/^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]$/);
  if (m) s = m[2] || m[1].split('/').pop();
  return s.replace(/\.md$/i, '').trim();
}

/** YAML list, nested arrays, or a comma/semicolon string → clean unique list. */
function toList(v) {
  if (v == null || v === '' || v === false) return [];
  const arr = Array.isArray(v) ? v.flat(Infinity) : String(v).split(/[;,]/);
  const out = [];
  for (const x of arr) {
    if (x == null) continue;
    const s = stripLink(x);
    if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out;
}

function normStatus(v) {
  const s = String(v == null ? '' : v).toLowerCase().trim();
  if (!s) return '';
  if (/^(read|finished|done|complete|completed)$/.test(s)) return 'read';
  if (/^(reading|currently[ -]?reading|current|in progress|started)$/.test(s)) return 'reading';
  if (/^(unread|to[ -]?read|tbr|want to read|not read|owned|on shelf)$/.test(s)) return 'unread';
  return '';
}

function truthy(v) {
  if (v === true) return true;
  return /^(true|yes|y|1|x|signed|✓|✔)$/i.test(String(v == null ? '' : v).trim());
}

/** "A & B; illustrated by C" → ['A', 'B', 'C'] with roles stripped. */
function splitAuthors(s) {
  if (!s) return [];
  return String(s)
    .split(/\s*(?:;|&|\band\b|\bwith\b|\+)\s*/i)
    .map((a) => a
      .replace(/\((?:[^)]*)\)/g, '')
      .replace(/^(?:illustrated|edited|translated|introduced|foreword|afterword|compiled|selected|adapted|drawn|art|written)(?:\s+and\s+\w+)?\s+by\s+/i, '')
      .replace(/^(?:illustrations?|art|foreword|introduction|translation)\s*:\s*/i, '')
      .replace(/,?\s*\b(?:ed|eds|editor|editors|trans|translator|illustrator)\.?$/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^([^,]+),(?!\s*(?:jr|sr|ii|iii|iv|phd|md)\.?$)\s*([^,]+)$/i, '$2 $1')) // "Le Guin, Ursula K." → "Ursula K. Le Guin"
    .filter((a) => a && !/^(unknown|various|anonymous|n\/?a)$/i.test(a));
}

function foldText(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`´]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const VOL_RE = /\b(?:vol(?:ume)?|book|part|no|issue)\.?\s*#?\s*(\d+|[ivxlc]+)\b|#\s*(\d+)/i;

/**
 * Title used for duplicate checks. Drops a subtitle after ":" (unless the part before
 * the colon is just the author's name, as in "Andi Watson: Glister"), drops a trailing
 * "(Series, #2)", ignores punctuation, accents and a leading The/A/An, and keeps
 * volume numbers so "Volume 1" and "Volume 2" stay different books.
 */
function titleKey(t, author) {
  let s = String(t || '').replace(/\s*\([^)]*\)\s*$/, '');
  const colon = s.indexOf(':');
  if (colon > 2) {
    const pre = foldText(s.slice(0, colon));
    const names = splitAuthors(author).map(foldText);
    s = names.includes(pre) ? s.slice(colon + 1) : s.slice(0, colon);
  }
  let vol = '';
  const m = s.match(VOL_RE);
  if (m) { vol = ` v${(m[1] || m[2]).toLowerCase()}`; s = s.replace(VOL_RE, ' '); }
  s = foldText(s).replace(/^(the|a|an)\s+/, '');
  return s ? s + vol : '';
}

function surnameKey(author) {
  const first = splitAuthors(author)[0] || '';
  if (!first) return '';
  let name = first;
  if (name.includes(',')) name = name.split(',')[0]; // "Le Guin, Ursula"
  const parts = foldText(name).split(' ').filter((p) => !/^(jr|sr|ii|iii|iv|dr|phd|md)$/.test(p));
  return parts.length ? parts[parts.length - 1] : '';
}

function dupKey(title, author) {
  const t = titleKey(title, author);
  return t ? `${t}|${surnameKey(author)}` : '';
}

function cleanIsbn(v) {
  const s = String(v || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  return s.length === 10 || s.length === 13 ? s : '';
}

function bookFromFrontmatter(path, basename, fm) {
  fm = fm || {};
  const read = toList(fm.read).map(toDateStr).filter(Boolean).sort();
  return {
    path,
    basename,
    title: String(fm.title || basename),
    author: fm.author ? String(Array.isArray(fm.author) ? fm.author.join('; ') : fm.author) : '',
    status: normStatus(fm.status),
    genres: toList(fm.genre),
    topics: toList(fm.topics),
    format: fm.format ? String(fm.format) : '',
    room: fm.room ? String(fm.room) : '',
    shelf: fm.shelf ? String(fm.shelf) : '',
    owned: fm.owned == null || fm.owned === '' ? true : truthy(fm.owned),
    source: fm.source ? String(fm.source) : '',
    signed: truthy(fm.signed),
    edition: fm.edition ? String(fm.edition) : '',
    isbn: cleanIsbn(fm.isbn),
    year: fm.year ? String(fm.year) : '',
    read,
    started: toDateStr(fm.started),
    added: toDateStr(fm.added),
    cover: fm.cover ? String(fm.cover) : '',
    link: fm.link ? String(fm.link) : '',
  };
}

function sortTitle(b) {
  if (b._st === undefined) b._st = foldText(b.title).replace(/^(the|a|an)\s+/, '');
  return b._st;
}
function sortAuthor(b) {
  if (b._sa === undefined) b._sa = surnameKey(b.author) || '~';
  return b._sa;
}
function byTitle(a, b) { return sortTitle(a).localeCompare(sortTitle(b)) || a.title.localeCompare(b.title); }
function byAuthor(a, b) { return sortAuthor(a).localeCompare(sortAuthor(b)) || byTitle(a, b); }
function lastRead(b) { return b.read.length ? b.read[b.read.length - 1] : ''; }

function locationOf(b) { return [b.room, b.shelf].filter(Boolean).join(' / '); }

function safeFileName(s) {
  return String(s).replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled';
}
function yamlStr(s) { return JSON.stringify(String(s == null ? '' : s)); }
function yamlKey(s) {
  const k = foldText(s).replace(/ /g, '_');
  return k && !FIELDS.includes(k) ? k : (k ? `${k}_note` : '');
}

/** Frontmatter + small body for a new book note. */
function buildBookNote(b) {
  const L = ['---'];
  L.push(`title: ${yamlStr(b.title)}`);
  L.push(`author: ${yamlStr(b.author || '')}`);
  L.push(`status: ${b.status || ''}`.trimEnd());
  const list = (key, vals) => {
    if (vals && vals.length) { L.push(`${key}:`); vals.forEach((v) => L.push(`  - ${yamlStr(v)}`)); } else L.push(`${key}: []`);
  };
  list('genre', b.genres);
  list('topics', b.topics);
  L.push(`format: ${yamlStr(b.format || '')}`);
  L.push(`owned: ${b.owned === false ? 'false' : 'true'}`);
  if (b.owned === false || b.source) L.push(`source: ${yamlStr(b.source || '')}`);
  L.push(`room: ${yamlStr(b.room || '')}`);
  L.push(`shelf: ${yamlStr(b.shelf || '')}`);
  L.push(`signed: ${b.signed ? 'true' : 'false'}`);
  L.push(`edition: ${yamlStr(b.edition || '')}`);
  L.push(`isbn: ${yamlStr(b.isbn || '')}`);
  L.push(`year: ${yamlStr(b.year || '')}`);
  if (b.read && b.read.length) { L.push('read:'); b.read.forEach((d) => L.push(`  - ${d}`)); } else L.push('read: []');
  L.push(b.started ? `started: ${b.started}` : 'started:');
  L.push(`added: ${b.added || todayStr()}`);
  L.push(`cover: ${yamlStr(b.cover || '')}`);
  L.push(`link: ${yamlStr(b.link || '')}`);
  for (const [k, v] of Object.entries(b.extra || {})) {
    const key = yamlKey(k);
    if (key && v !== '' && v != null) L.push(`${key}: ${yamlStr(v)}`);
  }
  L.push('---', '', '```stacks', 'show: book', '```', '', '## Notes', '');
  if (b.notes && String(b.notes).trim()) L.push(String(b.notes).trim(), '');
  L.push('');
  return L.join('\n');
}

/* ---------------------------- Import parsing ---------------------------- */

const HEADER_ALIASES = {
  title: ['title', 'book', 'book title', 'name', 'work'],
  author: ['author', 'authors', 'author s', 'author creator', 'creator', 'creators', 'writer', 'by', 'primary author', 'author l f', 'author first last'],
  status: ['status', 'read status', 'reading status', 'exclusive shelf', 'state'],
  genre: ['genre', 'genres', 'category', 'categories', 'section'],
  topics: ['topic', 'topics', 'subject', 'subjects', 'tags', 'bookshelves', 'collections'],
  format: ['format', 'binding', 'media', 'medium', 'type'],
  room: ['room'],
  shelf: ['shelf', 'shelf location', 'bookcase'],
  location: ['location', 'where'],
  signed: ['signed', 'autographed', 'signature'],
  owned: ['owned', 'own', 'i own', 'in library', 'owned copy'],
  source: ['source', 'where from', 'service', 'borrowed from', 'platform'],
  edition: ['edition', 'special edition', 'special'],
  isbn: ['isbn', 'isbn13', 'isbn 13', 'isbn10', 'isbn 10', 'ean'],
  year: ['year', 'year published', 'publication year', 'original publication year', 'pub year', 'published', 'date published'],
  read: ['date read', 'read date', 'read dates', 'date finished', 'finished', 'read on'],
  notes: ['notes', 'note', 'comments', 'private notes', 'my review', 'review'],
  cover: ['cover', 'cover url', 'image'],
  link: ['link', 'url', 'bookpile', 'goodreads url'],
  added: ['added', 'date added', 'acquired', 'date acquired'],
};
const TARGETS = ['title', 'author', 'status', 'genre', 'topics', 'format', 'owned', 'source', 'room', 'shelf', 'location', 'signed', 'edition', 'isbn', 'year', 'read', 'added', 'notes', 'cover', 'link'];
const TARGET_LABEL = {
  title: 'Title', author: 'Author', status: 'Status', genre: 'Genre', topics: 'Topics', format: 'Format', room: 'Room',
  shelf: 'Shelf', owned: 'Owned (yes / no)', source: 'Where from (if not owned)', location: 'Location (room / shelf)', signed: 'Signed', edition: 'Special edition', isbn: 'ISBN', year: 'Year published',
  read: 'Date read', added: 'Date added', notes: 'Notes', cover: 'Cover URL', link: 'Link', keep: 'Keep as its own property', ignore: 'Ignore',
};

function guessTarget(header) {
  const h = foldText(header);
  if (/^(batch|source photos?|photos?|image file|img)$/.test(h)) return 'ignore';
  for (const [t, aliases] of Object.entries(HEADER_ALIASES)) if (aliases.includes(h)) return t;
  return 'keep';
}

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const counts = { ',': 0, '\t': 0, ';': 0 };
  let q = false;
  for (const ch of firstLine) { if (ch === '"') q = !q; else if (!q && ch in counts) counts[ch]++; }
  const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim());
  return [{ name: 'CSV', headers, rows: rows.slice(1).map((r) => headers.map((_, i) => (r[i] || '').trim())) }];
}

function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; } else if (s[i] === '|') { cells.push(cur.trim()); cur = ''; } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

function stripMd(s) {
  return String(s || '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/(^|\s)\*([^*]+)\*/g, '$1$2')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/<br\s*\/?>/gi, '; ').trim();
}

/** One list line → { title, author }. Handles **Title** — Author, Title by Author, Title - Author, Title<TAB>Author. */
function parseListItem(line) {
  let s = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/^\[[ xX]\]\s+/, '').trim();
  if (!s) return null;
  if (s.includes('\t')) { const [t, a] = s.split('\t'); return { title: stripMd(t), author: stripMd(a || '') }; }
  let m = s.match(/^\*\*(.+?)\*\*\s*(?:[—–-]|by|,)?\s*(.*)$/i) || s.match(/^\*(.+?)\*\s*(?:[—–-]|by|,)?\s*(.*)$/i) || s.match(/^_(.+?)_\s*(?:[—–-]|by|,)?\s*(.*)$/i);
  if (m) return { title: m[1].trim(), author: stripMd(m[2]) };
  m = s.match(/^(.+?)\s+[—–]\s+(.+)$/) || s.match(/^(.+?)\s+-\s+(.+)$/) || s.match(/^(.+?)\s+by\s+(.+)$/i);
  if (m) return { title: stripMd(m[1]), author: stripMd(m[2]) };
  return { title: stripMd(s), author: '' };
}

/**
 * Markdown/plain text → tables (each with headers/rows) plus one synthetic "List" table
 * built from bullet or plain lines, using ## headings as a "Section" column.
 */
function parseMarkdown(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const tables = [];
  const list = { name: 'List', headers: ['Title', 'Author', 'Section'], rows: [] };
  let section = '';
  let anyBullets = lines.some((l) => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(l));
  let inCode = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) { inCode = !inCode; continue; }
    if (inCode) continue;
    const h = line.match(/^#{1,6}\s+(.+?)\s*(?:\(\d[\d,]*\))?\s*$/);
    if (h) { section = stripMd(h[1]); continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const headers = splitTableRow(line).map(stripMd);
      const rows = [];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        const cells = splitTableRow(lines[i]).map(stripMd);
        rows.push(headers.map((_, k) => cells[k] || ''));
        i++;
      }
      i--;
      tables.push({ name: section ? `Table: ${section}` : `Table ${tables.length + 1}`, headers, rows });
      continue;
    }
    if (anyBullets) {
      if (!/^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line)) continue;
    } else if (!line.trim()) continue;
    const item = parseListItem(line);
    if (item && item.title && !/^https?:\/\//.test(item.title)) list.rows.push([item.title, item.author, section]);
  }
  // A file with tables uses the tables; bullet lines in it are usually commentary.
  if (list.rows.length && !tables.length) tables.push(list);
  return tables;
}

function parseImport(text, fileName) {
  const ext = String(fileName || '').toLowerCase().split('.').pop();
  if (ext === 'csv' || ext === 'tsv') return parseCsv(text);
  const first = (text.split(/\r?\n/).find((l) => l.trim()) || '');
  const looksCsv = !/^\s*[#|*\-+]/.test(first) && (first.split(',').length >= 3 || first.split('\t').length >= 2)
    && /title/i.test(first);
  return looksCsv ? parseCsv(text) : parseMarkdown(text);
}

/** Drop photo-file references ("Also visible in IMG_0976.jpeg") from imported notes. */
function cleanNote(v) {
  return String(v || '')
    .split(/\s*;\s*/)
    .filter((part) => !/\b(?:IMG|DSC|PXL|photo)[_-]?[\w()-]*\.(?:jpe?g|heic|png)\b/i.test(part))
    .join('; ')
    .trim();
}

/** Apply a column mapping to one table → candidate books. */
function rowsToBooks(table, mapping, defaults) {
  const out = [];
  for (const row of table.rows) {
    const b = { title: '', author: '', status: '', genres: [], topics: [], format: '', owned: null, source: '', room: '', shelf: '', signed: false, edition: '',
      isbn: '', year: '', read: [], notes: '', cover: '', link: '', added: '', extra: {} };
    const notes = [];
    table.headers.forEach((h, i) => {
      const t = mapping[i] || 'ignore';
      const v = (row[i] || '').trim();
      if (!v || t === 'ignore') return;
      switch (t) {
        case 'title': b.title = v; break;
        case 'author': b.author = b.author ? `${b.author}; ${v}` : v; break;
        case 'status': b.status = normStatus(v) || b.status; break;
        case 'genre': b.genres.push(...toList(v)); break;
        case 'topics': b.topics.push(...toList(v)); break;
        case 'format': b.format = v; break;
        case 'room': b.room = v; break;
        case 'shelf': b.shelf = v; break;
        case 'location': { const p = v.split(/\s*(?:\/|>|›|»|—|–)\s*/); b.room = p[0] || ''; b.shelf = p.slice(1).join(' / '); break; }
        case 'signed': b.signed = truthy(v); break;
        case 'owned': b.owned = !/^(no|n|false|0|not owned|borrowed|library)$/i.test(v); break;
        case 'source': b.source = v; break;
        case 'edition': b.edition = v; break;
        case 'isbn': b.isbn = cleanIsbn(v.replace(/^="?|"$/g, '')); break;
        case 'year': b.year = (v.match(/\d{4}/) || [''])[0]; break;
        case 'read': b.read.push(...v.split(/[;,]/).map(toDateStr).filter(Boolean)); break;
        case 'notes': { const n = cleanNote(v); if (n) notes.push(n); break; }
        case 'added': b.added = toDateStr(v); break;
        case 'cover': b.cover = v; break;
        case 'link': b.link = v; break;
        case 'keep': b.extra[h] = v; break;
        default: break;
      }
    });
    if (!b.title) continue;
    b.title = b.title.replace(/\s+/g, ' ').trim();
    b.notes = notes.join('\n\n');
    if (!b.status) b.status = b.read.length ? 'read' : (defaults.status || '');
    if (!b.format && defaults.format) b.format = defaults.format;
    if (b.owned === null) b.owned = defaults.owned !== false;
    if (!b.source && defaults.source) b.source = defaults.source;
    if (!b.room && defaults.room) b.room = defaults.room;
    if (!b.shelf && defaults.shelf) b.shelf = defaults.shelf;
    if (defaults.genre) b.genres.push(...toList(defaults.genre));
    if (defaults.topic) b.topics.push(...toList(defaults.topic));
    b.genres = toList(b.genres);
    b.topics = toList(b.topics);
    b.read = [...new Set(b.read)].sort();
    out.push(b);
  }
  return out;
}

/** Sort candidates into new / already in library / repeated within this import. */
function planImport(candidates, library, ignored) {
  const byKey = new Map();
  const byIsbn = new Map();
  for (const b of library) {
    const k = dupKey(b.title, b.author);
    if (k) { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(b); }
    if (b.isbn) byIsbn.set(b.isbn, b);
  }
  const ign = new Set(ignored || []);
  const seen = new Map();
  const plan = { fresh: [], inLibrary: [], repeated: [] };
  for (const c of candidates) {
    const k = dupKey(c.title, c.author);
    const match = (c.isbn && byIsbn.get(c.isbn)) || (k && !ign.has(k) && byKey.get(k) && byKey.get(k)[0]);
    if (match) { plan.inLibrary.push({ book: c, match }); continue; }
    if (k && seen.has(k)) { plan.repeated.push({ book: c, first: seen.get(k) }); continue; }
    if (k) seen.set(k, c);
    plan.fresh.push(c);
  }
  return plan;
}

/** Groups of likely duplicates already in the library. */
function findDuplicateGroups(books, ignored) {
  const ign = new Set(ignored || []);
  const map = new Map();
  for (const b of books) {
    const k = dupKey(b.title, b.author);
    if (!k || ign.has(k)) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(b);
  }
  // Same title where one side has no author: likely the same book too.
  const byTitleOnly = new Map();
  for (const [k, list] of map) {
    const t = k.split('|')[0];
    if (!byTitleOnly.has(t)) byTitleOnly.set(t, []);
    byTitleOnly.get(t).push(k);
  }
  for (const keys of byTitleOnly.values()) {
    const blank = keys.find((k) => k.endsWith('|'));
    if (blank && keys.length === 2) {
      const other = keys.find((k) => k !== blank);
      if (!ign.has(`${blank}+${other}`)) {
        map.set(`${blank}+${other}`, [...map.get(blank), ...map.get(other)]);
        map.delete(blank); map.delete(other);
      }
    }
  }
  return [...map.entries()].filter(([, l]) => l.length > 1).map(([key, list]) => ({ key, books: list.sort(byTitle) }))
    .sort((a, b) => byTitle(a.books[0], b.books[0]));
}

/* ---------------------------- Grouping / browsing ---------------------------- */

const DIMENSIONS = {
  author: { label: 'Authors', values: (b) => splitAuthors(b.author) },
  genre: { label: 'Genres', values: (b) => b.genres },
  topic: { label: 'Topics', values: (b) => b.topics },
  location: { label: 'Locations', values: (b) => [locationOf(b) || 'No location'] },
  format: { label: 'Formats', values: (b) => [b.format || 'No format'] },
  status: { label: 'Status', values: (b) => [STATUS_LABEL[b.status]] },
  year: { label: 'Year read', values: (b) => [...new Set(b.read.map(yearOf))] },
};

function tally(books, dim) {
  const f = DIMENSIONS[dim].values;
  const m = new Map();
  for (const b of books) for (const v of f(b)) {
    if (!v) continue;
    const key = v.toLowerCase();
    if (!m.has(key)) m.set(key, { value: v, count: 0, read: 0 });
    const e = m.get(key);
    e.count++;
    if (b.read.length) e.read++;
  }
  return [...m.values()];
}

function authorSortKey(name) {
  const parts = foldText(name).split(' ');
  return `${parts[parts.length - 1] || ''} ${parts.slice(0, -1).join(' ')}`;
}

function matchesFilter(b, f) {
  if (f.status !== undefined && f.status !== 'any' && b.status !== f.status) return false;
  if (f.format && (b.format || '').toLowerCase() !== f.format.toLowerCase()) return false;
  if (f.genre && !b.genres.some((g) => g.toLowerCase() === f.genre.toLowerCase())) return false;
  if (f.topic && !b.topics.some((g) => g.toLowerCase() === f.topic.toLowerCase())) return false;
  if (f.room && (b.room || '').toLowerCase() !== f.room.toLowerCase()) return false;
  if (f.shelf && (b.shelf || '').toLowerCase() !== f.shelf.toLowerCase()) return false;
  if (f.noLocation && (b.room || b.shelf)) return false;
  if (f.author) { const a = f.author.toLowerCase(); if (!splitAuthors(b.author).some((x) => x.toLowerCase() === a)) return false; }
  if (f.owned === 'owned' && !b.owned) return false;
  if (f.owned === 'not' && b.owned) return false;
  if (f.special === 'signed' && !b.signed) return false;
  if (f.special === 'edition' && !b.edition) return false;
  if (f.special === 'either' && !b.signed && !b.edition) return false;
  if (f.year && !b.read.some((d) => d.startsWith(f.year))) return false;
  if (f.query) {
    const q = foldText(f.query);
    const hay = foldText(`${b.title} ${b.author} ${b.isbn}`);
    if (!q.split(' ').every((w) => hay.includes(w))) return false;
  }
  return true;
}

/* ---------------------------- Exports ---------------------------- */

const CSV_COLS = ['Title', 'Author', 'Status', 'Genre', 'Topics', 'Format', 'Owned', 'Source', 'Room', 'Shelf', 'Signed', 'Edition', 'ISBN', 'Year', 'Date read', 'Added', 'Cover', 'Link'];
function exportCsv(books) {
  const q = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
  const rows = [...books].sort(byAuthor).map((b) => [b.title, b.author, b.status, b.genres.join('; '), b.topics.join('; '), b.format,
    b.owned ? 'yes' : 'no', b.source, b.room, b.shelf, b.signed ? 'yes' : '', b.edition, b.isbn, b.year, b.read.join('; '), b.added, b.cover, b.link]);
  return [CSV_COLS, ...rows].map((r) => r.map(q).join(',')).join('\n') + '\n';
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function md(s) { return String(s || '').replace(/([*_`[\]])/g, '\\$1'); }
function htmlAttr(s) { return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
function coverImg(b, width) {
  return b.cover ? `<img src="${htmlAttr(b.cover)}" alt="${htmlAttr(`Cover of ${b.title}`)}" width="${width}">` : '';
}
function plural(n, one, many) { return `${n} ${n === 1 ? one : (many || `${one}s`)}`; }
function barOf(n, max, width) { return n ? '█'.repeat(Math.max(1, Math.round((n / max) * width))) : ''; }

/** Lines like "- 2026-03-02 · Finished. Loved it." from a note's Reading log → { date: text }. */
function readingLogThoughts(content) {
  const out = {};
  const m = /^##[ \t]+Reading log[ \t]*$/im.exec(content || '');
  if (!m) return out;
  const rest = content.slice(m.index + m[0].length);
  const next = /^#{1,2}\s/m.exec(rest);
  for (const line of (next ? rest.slice(0, next.index) : rest).split('\n')) {
    const x = line.match(/^\s*-\s+(\d{4}(?:-\d\d-\d\d)?)\s+·\s+Finished\.?\s*(.*)$/);
    if (x && x[2].trim()) out[x[1]] = x[2].trim();
  }
  return out;
}

/**
 * Year-end report: every book read that year with its cover, and a look at how
 * the year went: formats, shelves vs. elsewhere, genres, authors, rereads.
 */
function exportYear(books, year, thoughts) {
  thoughts = thoughts || {};
  const y = String(year);
  const entries = [];
  for (const b of books) for (const d of b.read) if (d.startsWith(y)) entries.push({ d, b });
  const sortDate = (d) => (/^\d{4}$/.test(d) ? `${d}-99` : d); // year-only reads go last
  entries.sort((x, z) => sortDate(x.d).localeCompare(sortDate(z.d)) || byTitle(x.b, z.b));
  const out = [`# ${y} in reading`, '', `*Made ${niceDate(todayStr())} from The Stacks.*`, ''];
  if (!entries.length) { out.push(`No books marked read in ${y}.`, ''); return out.join('\n'); }
  const read = [...new Set(entries.map((e) => e.b))];

  const covers = read.filter((b) => b.cover);
  if (covers.length) out.push(covers.map((b) => coverImg(b, 72)).join(' '), '');

  // At a glance
  const owned = read.filter((b) => b.owned).length;
  const fmt = tally(read, 'format').filter((x) => x.value !== 'No format').sort((a, b) => b.count - a.count);
  const rereads = read.filter((b) => b.read.some((d) => d < y));
  out.push('## At a glance', '', '| | |', '| --- | --- |', `| Books read | ${read.length} |`);
  if (owned !== read.length) out.push(`| From my shelves | ${owned} |`, `| Read elsewhere | ${read.length - owned} |`);
  for (const f of fmt) out.push(`| ${f.value} | ${f.count} |`);
  if (rereads.length) out.push(`| Rereads | ${rereads.length} |`);
  out.push('');

  // Highlights
  const hi = [];
  const months = MONTH_NAMES.map((_, i) => entries.filter((e) => e.d.slice(5, 7) === String(i + 1).padStart(2, '0')).length);
  const peak = Math.max(...months);
  if (peak > 1) hi.push(`**Busiest month:** ${MONTH_NAMES.filter((_, i) => months[i] === peak).join(' and ')}, with ${plural(peak, 'book')}.`);
  const authors = tally(read, 'author').sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  if (authors.length && authors[0].count > 1) hi.push(`**Most-read author:** ${authors[0].value}, ${plural(authors[0].count, 'book')}.`);
  const genres = tally(read, 'genre').sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  if (genres.length) hi.push(`**Top genre:** ${genres[0].value} (${genres[0].count} of ${read.length}).${genres.length > 2 ? ` ${genres.length} genres in all.` : ''}`);
  const priorAuthors = new Set(books.filter((b) => b.read.some((d) => d < y)).flatMap((b) => splitAuthors(b.author).map((a) => a.toLowerCase())));
  const newAuthors = [...new Set(read.flatMap((b) => splitAuthors(b.author)))].filter((a) => !priorAuthors.has(a.toLowerCase()));
  if (priorAuthors.size && newAuthors.length) hi.push(`**New to me:** ${plural(newAuthors.length, 'author')} I hadn't logged reading before.`);
  const dated = read.filter((b) => /^\d{4}$/.test(b.year)).sort((a, b) => a.year.localeCompare(b.year));
  if (dated.length > 1) hi.push(`**Oldest and newest:** *${md(dated[0].title)}* (${dated[0].year}) and *${md(dated[dated.length - 1].title)}* (${dated[dated.length - 1].year}).`);
  if (rereads.length) hi.push(`**Back again:** ${rereads.map((b) => `*${md(b.title)}*`).join(', ')}.`);
  const special = read.filter((b) => b.owned && (b.signed || b.edition));
  if (special.length) hi.push(`**Special copies read:** ${special.map((b) => `*${md(b.title)}*${b.signed ? ' (signed)' : ''}`).join(', ')}.`);
  const shelfTotal = books.filter((b) => b.owned).length;
  const shelfUnread = books.filter((b) => b.owned && !b.read.length && b.status !== 'read').length;
  if (shelfTotal && owned) hi.push(`**The shelves:** ${owned} read from home this year. ${fmtNum(shelfUnread)} of ${fmtNum(shelfTotal)} books on the shelves ${shelfUnread === 1 ? 'is' : 'are'} still unread.`);
  out.push('## Highlights', '', ...hi.map((h) => `- ${h}`), '');

  out.push('## Month by month', '', '```');
  MONTH_NAMES.forEach((m, i) => out.push(`${m.slice(0, 3)}  ${barOf(months[i], peak, 24).padEnd(25)}${months[i] || ''}`));
  out.push('```', '');

  // The books, by month
  out.push('## The books', '');
  let lastMonth = '';
  for (const { d, b } of entries) {
    const mo = /^\d{4}$/.test(d) ? 'Sometime this year' : MONTH_NAMES[Number(d.slice(5, 7)) - 1];
    if (mo !== lastMonth) { out.push(`### ${mo}`, ''); lastMonth = mo; }
    const meta = [b.author && `*${md(b.author)}*`, b.format, !b.owned && (b.source ? `via ${b.source}` : 'not owned'),
      b.genres.join(', '), /^\d{4}-\d\d-\d\d$/.test(d) && shortDate(d), b.read.length > 1 && `read ${b.read.length} times`].filter(Boolean);
    const lines = [];
    if (b.cover) lines.push(`${coverImg(b, 90)}`, '');
    lines.push(`**${md(b.title)}**  `, meta.join(' · '));
    const note = (thoughts[b.path] || {})[d];
    if (note) lines.push('', `> ${note}`);
    out.push(...lines, '');
  }

  if (genres.length > 1) {
    out.push('## By genre', '', '| Genre | Books |', '| --- | --- |', ...genres.map((g) => `| ${g.value} | ${g.count} |`), '');
  }
  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* Plugin                                                             */
/* ------------------------------------------------------------------ */

class StacksPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.busy = false;
    this.registerView(VIEW_TYPE, (leaf) => new StacksView(leaf, this));
    this.addRibbonIcon('library-big', 'Open The Stacks', () => this.activateView());
    this.registerMarkdownCodeBlockProcessor('stacks', (source, el, ctx) => ctx.addChild(new StacksBlock(el, this, source, ctx.sourcePath)));

    this.addCommand({ id: 'open', name: 'Open the library', callback: () => this.activateView() });
    this.addCommand({ id: 'add-book', name: 'Add a book', callback: () => new AddBookModal(this).open() });
    this.addCommand({ id: 'log-elsewhere', name: "Log a book I read but don't own", callback: () => new AddBookModal(this, { elsewhere: true }).open() });
    this.addCommand({ id: 'import', name: 'Import books from a file or list', callback: () => new ImportModal(this).open() });
    this.addCommand({ id: 'start-current', name: 'Start reading this book', checkCallback: (c) => this.withCurrentBook(c, (b) => this.startReading(b)) });
    this.addCommand({ id: 'read-current', name: 'Mark this book read', checkCallback: (c) => this.withCurrentBook(c, (b) => new ReadModal(this, b).open()) });
    this.addCommand({ id: 'move-current', name: 'Move this book', checkCallback: (c) => this.withCurrentBook(c, (b) => new MoveModal(this, [b]).open()) });
    this.addCommand({ id: 'cover-current', name: 'Find a cover for this book', checkCallback: (c) => this.withCurrentBook(c, (b) => new CoverModal(this, b).open()) });
    this.addCommand({ id: 'duplicates', name: 'Review possible duplicates', callback: () => this.activateView('duplicates') });
    this.addCommand({ id: 'export-csv', name: 'Export the library as CSV', callback: () => this.exportLibrary() });
    this.addCommand({ id: 'export-year', name: 'Year-end report', callback: () => new PromptModal(this.app, 'Which year?', String(new Date().getFullYear()), (y) => this.exportReadingYear(y)).open() });

    this.addSettingTab(new StacksSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => { if (this.settings.openOnStartup) this.activateView(); });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!Array.isArray(this.settings.formats) || !this.settings.formats.length) this.settings.formats = [...DEFAULT_FORMATS];
    if (!Array.isArray(this.settings.ignoredDupes)) this.settings.ignoredDupes = [];
  }
  async saveSettings() { await this.saveData(this.settings); }

  /* ---------- data ---------- */

  inFolder(path) { const f = normalizePath(this.settings.booksFolder || ''); return !f || f === '/' || path.startsWith(`${f}/`); }

  readBook(file) {
    const b = bookFromFrontmatter(file.path, file.basename, this.app.metadataCache.getFileCache(file)?.frontmatter);
    b.file = file;
    return b;
  }

  getBooks() {
    return this.app.vault.getMarkdownFiles().filter((f) => this.inFolder(f.path)).map((f) => this.readBook(f));
  }

  getBook(path) {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile && this.inFolder(f.path) ? this.readBook(f) : null;
  }

  withCurrentBook(checking, fn) {
    const file = this.app.workspace.getActiveFile();
    const book = file && this.getBook(file.path);
    if (!book) return false;
    if (!checking) fn(book);
    return true;
  }

  values(books, dim) {
    return tally(books, dim).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)).map((x) => x.value);
  }

  async ensureFolder(path) {
    const p = normalizePath(path);
    if (!this.app.vault.getAbstractFileByPath(p)) await this.app.vault.createFolder(p);
  }

  async writeFile(path, content) {
    path = normalizePath(path);
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) { await this.app.vault.modify(f, content); return f; }
    return this.app.vault.create(path, content);
  }

  openBook(book, sourcePath, newLeaf) { this.app.workspace.openLinkText(book.path, sourcePath || '', newLeaf === undefined ? 'tab' : newLeaf); }
  async openFile(file) { await this.app.workspace.getLeaf('tab').openFile(file); }

  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) if (leaf.view && leaf.view.renderNow) leaf.view.renderNow();
  }

  /** Unique path for a new book: Title.md, then "Title (Surname).md", then numbered. */
  pathFor(book, taken) {
    const folder = this.settings.booksFolder;
    const free = (p) => !this.app.vault.getAbstractFileByPath(p) && !(taken && taken.has(p.toLowerCase()));
    const base = safeFileName(book.title);
    let p = normalizePath(`${folder}/${base}.md`);
    if (free(p)) return p;
    const sur = splitAuthors(book.author)[0];
    if (sur) { p = normalizePath(`${folder}/${safeFileName(`${base} (${sur})`)}.md`); if (free(p)) return p; }
    for (let i = 2; ; i++) { p = normalizePath(`${folder}/${base} (${i}).md`); if (free(p)) return p; }
  }

  async createBook(book) {
    await this.ensureFolder(this.settings.booksFolder);
    const path = this.pathFor(book);
    return this.app.vault.create(path, buildBookNote({ ...book, added: book.added || todayStr() }));
  }

  /* ---------- actions ---------- */

  async startReading(book) {
    await this.app.fileManager.processFrontMatter(book.file, (fm) => { fm.status = 'reading'; fm.started = todayStr(); });
    await this.appendLog(book, `${todayStr()} · Started`);
    new Notice(`Reading ${book.title}`);
  }

  async markRead(book, date, thoughts) {
    await this.app.fileManager.processFrontMatter(book.file, (fm) => {
      const list = toList(fm.read).map(toDateStr).filter(Boolean);
      if (!list.includes(date)) list.push(date);
      fm.read = list.sort();
      fm.status = 'read';
      fm.started = null;
    });
    await this.appendLog(book, `${date} · Finished${thoughts && thoughts.trim() ? `. ${thoughts.trim().replace(/\s*\n+\s*/g, ' ')}` : ''}`);
    new Notice(`${book.title}: read`);
  }

  async appendLog(book, line) {
    await this.app.vault.process(book.file, (data) => {
      const m = /^##[ \t]+Reading log[ \t]*$/im.exec(data);
      if (!m) return `${data.replace(/\s*$/, '')}\n\n## Reading log\n\n- ${line}\n`;
      const start = m.index + m[0].length;
      const next = /^#{1,2}\s/m.exec(data.slice(start));
      const end = next ? start + next.index : data.length;
      const before = data.slice(0, end).replace(/\s*$/, '');
      const after = data.slice(end);
      return `${before}\n- ${line}\n${after ? `\n${after}` : ''}`;
    });
  }

  /** Apply a frontmatter change to many books, with progress. */
  async bulk(books, label, fn) {
    if (!books.length) return;
    this.busy = true;
    const note = new Notice(`${label}… 0 of ${fmtNum(books.length)}`, 0);
    try {
      for (let i = 0; i < books.length; i++) {
        await this.app.fileManager.processFrontMatter(books[i].file, fn);
        if (i % 25 === 0) { note.setMessage(`${label}… ${fmtNum(i + 1)} of ${fmtNum(books.length)}`); await sleep(0); }
      }
    } finally {
      note.hide();
      this.busy = false;
    }
    new Notice(`${label}: ${fmtNum(books.length)} ${books.length === 1 ? 'book' : 'books'}`);
    window.setTimeout(() => this.refreshViews(), 400);
  }

  moveBooks(books, room, shelf) {
    return this.bulk(books, 'Moving', (fm) => { fm.room = room; fm.shelf = shelf; });
  }

  async trashBook(book) { await this.app.vault.trash(book.file, false); }

  async runImport(plan, opts) {
    const toCreate = [...plan.fresh, ...(opts.includeInLibrary ? plan.inLibrary.map((x) => x.book) : []), ...(opts.includeRepeated ? plan.repeated.map((x) => x.book) : [])];
    if (!toCreate.length) { new Notice('Nothing new to import'); return null; }
    await this.ensureFolder(this.settings.booksFolder);
    this.busy = true;
    const note = new Notice(`Importing… 0 of ${fmtNum(toCreate.length)}`, 0);
    const created = [];
    const taken = new Set();
    const today = todayStr();
    try {
      for (let i = 0; i < toCreate.length; i++) {
        const b = toCreate[i];
        const path = this.pathFor(b, taken);
        taken.add(path.toLowerCase());
        try {
          await this.app.vault.create(path, buildBookNote({ ...b, added: b.added || today }));
          created.push(path);
        } catch (e) { console.error('The Stacks: could not create', path, e); }
        if (i % 20 === 0) { note.setMessage(`Importing… ${fmtNum(i + 1)} of ${fmtNum(toCreate.length)}`); await sleep(0); }
      }
    } finally {
      note.hide();
      this.busy = false;
    }
    // Import log
    await this.ensureFolder(this.settings.importsFolder);
    const stamp = new Date();
    const name = `${todayStr(stamp)} ${pad(stamp.getHours())}${pad(stamp.getMinutes())} ${safeFileName((opts.source || 'import').replace(/\.(md|markdown|txt|csv|tsv)$/i, ''))}`;
    const log = [`# Import — ${niceDate(today)}`, '', `Source: ${opts.source || 'pasted list'}`, '',
      `- Added: ${fmtNum(created.length)}`,
      `- Skipped, already in the library: ${fmtNum(opts.includeInLibrary ? 0 : plan.inLibrary.length)}`,
      `- Skipped, repeated in the list: ${fmtNum(opts.includeRepeated ? 0 : plan.repeated.length)}`, ''];
    if (created.length) log.push('## Added', '', ...created.map((p) => `- [[${p.replace(/\.md$/, '')}|${p.split('/').pop().replace(/\.md$/, '')}]]`), '');
    if (!opts.includeInLibrary && plan.inLibrary.length) {
      log.push('## Already in the library', '', ...plan.inLibrary.map((x) => `- ${x.book.title}${x.book.author ? ` — ${x.book.author}` : ''} → [[${x.match.path.replace(/\.md$/, '')}|${x.match.title}]]`), '');
    }
    if (!opts.includeRepeated && plan.repeated.length) {
      log.push('## Repeated in the list', '', ...plan.repeated.map((x) => `- ${x.book.title}${x.book.author ? ` — ${x.book.author}` : ''}`), '');
    }
    const logFile = await this.writeFile(`${this.settings.importsFolder}/${name}.md`, log.join('\n'));
    new Notice(`Imported ${fmtNum(created.length)} ${created.length === 1 ? 'book' : 'books'}`);
    window.setTimeout(() => this.refreshViews(), 800);
    return logFile;
  }

  async exportLibrary() {
    await this.ensureFolder(this.settings.exportsFolder);
    const f = await this.writeFile(`${this.settings.exportsFolder}/${todayStr()} Library.csv`, exportCsv(this.getBooks()));
    new Notice(`Exported to ${f.path}`);
  }

  async exportReadingYear(year) {
    if (!/^\d{4}$/.test(String(year).trim())) { new Notice('Enter a four-digit year'); return; }
    await this.ensureFolder(this.settings.exportsFolder);
    year = String(year).trim();
    const books = this.getBooks();
    const thoughts = {};
    for (const b of books) if (b.read.some((d) => d.startsWith(year))) thoughts[b.path] = readingLogThoughts(await this.app.vault.cachedRead(b.file));
    const f = await this.writeFile(`${this.settings.exportsFolder}/${year} in reading.md`, exportYear(books, year, thoughts));
    this.openFile(f);
  }

  async findCovers(books) {
    if (this.coverJob) { new Notice('Already looking for covers'); return; }
    const todo = books.filter((b) => !b.cover);
    if (!todo.length) { new Notice('These books all have covers'); return; }
    this.coverJob = true;
    const note = new Notice(`Looking for ${todo.length} covers…`, 0);
    let found = 0;
    try {
      for (let i = 0; i < todo.length; i++) {
        note.setMessage(`Looking for covers… ${i + 1} of ${todo.length} (${found} found)`);
        try {
          const res = await searchOpenLibrary(todo[i].title, splitAuthors(todo[i].author)[0] || '', 1);
          if (res.length) {
            await this.app.fileManager.processFrontMatter(todo[i].file, (fm) => { if (!fm.cover) fm.cover = res[0].cover; });
            found++;
          }
        } catch (e) { /* skip */ }
        await sleep(350);
      }
    } finally {
      this.coverJob = false;
      note.hide();
    }
    new Notice(`Found ${found} of ${todo.length} covers`);
  }

  async activateView(tab) {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) { leaf = workspace.getLeaf('tab'); await leaf.setViewState({ type: VIEW_TYPE, active: true }); }
    await workspace.revealLeaf(leaf);
    if (tab && leaf.view && leaf.view.showTab) leaf.view.showTab(tab);
  }
}

function sleep(ms) { return new Promise((r) => window.setTimeout(r, ms)); }

/* ------------------------------------------------------------------ */
/* Shared UI bits                                                     */
/* ------------------------------------------------------------------ */

function renderCover(parent, book, cls) {
  const wrap = parent.createDiv({ cls: `stx-cover ${cls || ''}` });
  const blank = () => { wrap.empty(); wrap.addClass('stx-cover-blank'); wrap.createSpan({ text: (book.title.replace(/^(the|a|an)\s+/i, '')[0] || '?').toUpperCase() }); };
  if (book.cover) wrap.createEl('img', { attr: { src: book.cover, alt: '', loading: 'lazy' } }).addEventListener('error', blank);
  else blank();
  return wrap;
}

function chip(parent, text, cls) { return parent.createSpan({ cls: `stx-chip ${cls || ''}`, text }); }

function datalist(parent, id, values) {
  const dl = parent.createEl('datalist', { attr: { id } });
  for (const v of values) dl.createEl('option', { attr: { value: v } });
  return dl;
}

function selectEl(parent, options, value, onChange, cls) {
  const sel = parent.createEl('select', { cls: `dropdown ${cls || ''}` });
  for (const [v, l] of options) sel.createEl('option', { value: v, text: l });
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

function bookMeta(b) {
  const bits = [];
  if (b.format) bits.push(b.format);
  if (b.genres.length) bits.push(b.genres.join(', '));
  const loc = b.owned ? locationOf(b) : '';
  if (loc) bits.push(loc);
  return bits.join(' · ');
}

/* ------------------------------------------------------------------ */
/* Main view                                                          */
/* ------------------------------------------------------------------ */

class StacksView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.tab = 'library';
    this.filter = { status: 'any', query: '', owned: 'owned' };
    this.sort = 'title';
    this.groupBy = 'none';
    this.shown = plugin.settings.pageSize;
    this.selecting = false;
    this.selected = new Set();
    this.browseDim = 'author';
    this.browseQuery = '';
    this.browseShown = 200;
    this.year = '';
    this.render = debounce(() => { if (!this.plugin.busy) this.renderNow(); }, 400, true);
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'The Stacks'; }
  getIcon() { return 'library-big'; }

  async onOpen() {
    this.registerEvent(this.app.metadataCache.on('changed', (file) => { if (this.plugin.inFolder(file.path)) this.render(); }));
    this.registerEvent(this.app.vault.on('delete', () => this.render()));
    this.registerEvent(this.app.vault.on('rename', () => this.render()));
    this.renderNow();
  }

  showTab(tab) { this.tab = tab; this.renderNow(); }

  renderNow() {
    const c = this.contentEl;
    const scroll = c.scrollTop;
    c.empty();
    c.addClass('stx-view');
    const books = this.plugin.getBooks();
    this.books = books;

    const head = c.createDiv({ cls: 'stx-head' });
    const t = head.createDiv();
    t.createEl('h2', { text: 'The Stacks' });
    const reading = books.filter((b) => b.status === 'reading').length;
    const read = books.filter((b) => b.read.length).length;
    const elsewhere = books.filter((b) => !b.owned).length;
    t.createDiv({ cls: 'stx-muted', text: [`${fmtNum(books.length - elsewhere)} books on the shelves`, elsewhere && `${fmtNum(elsewhere)} read elsewhere`,
      `${fmtNum(read)} read`, `${fmtNum(reading)} reading now`].filter(Boolean).join(' · ') });
    const acts = head.createDiv({ cls: 'stx-head-actions' });
    const add = acts.createEl('button', { cls: 'mod-cta', text: 'Add book' });
    add.addEventListener('click', () => new AddBookModal(this.plugin).open());
    const logBtn = acts.createEl('button', { text: 'Log a read' });
    logBtn.setAttr('aria-label', "Log a book you read but don't own");
    logBtn.addEventListener('click', () => new AddBookModal(this.plugin, { elsewhere: true }).open());
    const imp = acts.createEl('button', { text: 'Import' });
    imp.addEventListener('click', () => new ImportModal(this.plugin).open());
    const more = acts.createEl('button', { attr: { 'aria-label': 'More' } });
    setIcon(more, 'more-horizontal');
    more.addEventListener('click', (evt) => {
      const m = new Menu();
      m.addItem((i) => i.setTitle('Export the library as CSV').setIcon('table').onClick(() => this.plugin.exportLibrary()));
      m.addItem((i) => i.setTitle('Year-end report').setIcon('calendar').onClick(() => new PromptModal(this.app, 'Which year?', String(new Date().getFullYear()), (y) => this.plugin.exportReadingYear(y)).open()));
      m.showAtMouseEvent(evt);
    });

    const tabs = c.createDiv({ cls: 'stx-tabs' });
    for (const [key, label] of [['library', 'Library'], ['browse', 'Browse'], ['reading', 'Reading'], ['duplicates', 'Duplicates']]) {
      const b = tabs.createEl('button', { cls: `stx-tab ${this.tab === key ? 'is-active' : ''}`, text: label });
      b.addEventListener('click', () => { this.tab = key; this.renderNow(); });
    }

    if (!books.length) {
      const e = c.createDiv({ cls: 'stx-empty-state' });
      e.createEl('p', { text: 'Your library is empty.' });
      e.createEl('p', { cls: 'stx-muted', text: 'Add a book by hand, or import a CSV, a Markdown table, or a plain list of "Title — Author" lines.' });
      const r = e.createDiv({ cls: 'stx-actions' });
      r.createEl('button', { cls: 'mod-cta', text: 'Import books' }).addEventListener('click', () => new ImportModal(this.plugin).open());
      r.createEl('button', { text: 'Add a book' }).addEventListener('click', () => new AddBookModal(this.plugin).open());
      return;
    }

    if (this.tab === 'library') this.renderLibrary(c, books);
    else if (this.tab === 'browse') this.renderBrowse(c, books);
    else if (this.tab === 'reading') this.renderReading(c, books);
    else this.renderDuplicates(c, books);
    c.scrollTop = scroll;
  }

  /* ----- Library ----- */

  setFilter(patch) {
    this.filter = { status: 'any', query: '', owned: 'owned', ...patch };
    this.shown = this.plugin.settings.pageSize;
    this.selected.clear();
    this.tab = 'library';
    this.renderNow();
  }

  renderLibrary(c, books) {
    const p = this.plugin, f = this.filter;
    const bar = c.createDiv({ cls: 'stx-filterbar' });
    const search = bar.createEl('input', { type: 'search', cls: 'stx-search', attr: { placeholder: 'Search title, author or ISBN' } });
    search.value = f.query || '';
    const values = (dim) => p.values(books, dim);
    const opt = (all, list) => [['', all], ...list.map((v) => [v, v])];
    selectEl(bar, [['owned', 'On my shelves'], ['not', 'Read elsewhere'], ['all', 'Everything']], f.owned || 'all', (v) => { f.owned = v; this.shown = p.settings.pageSize; this.renderNow(); });
    selectEl(bar, [['any', 'Any status'], ['', 'Not set'], ...STATUSES.map((s) => [s, STATUS_LABEL[s]])], f.status === undefined ? 'any' : f.status, (v) => { f.status = v; this.shown = p.settings.pageSize; this.renderNow(); });
    selectEl(bar, opt('Any genre', values('genre')), f.genre || '', (v) => { f.genre = v; this.renderNow(); });
    selectEl(bar, opt('Any topic', values('topic')), f.topic || '', (v) => { f.topic = v; this.renderNow(); });
    selectEl(bar, opt('Any format', [...new Set([...values('format').filter((x) => x !== 'No format')])]), f.format || '', (v) => { f.format = v; this.renderNow(); });
    const rooms = [...new Set(books.map((b) => b.room).filter(Boolean))].sort();
    selectEl(bar, [['', 'Any room'], ['__none', 'No location'], ...rooms.map((r) => [r, r])], f.noLocation ? '__none' : (f.room || ''), (v) => {
      f.noLocation = v === '__none'; f.room = v === '__none' ? '' : v; f.shelf = ''; this.renderNow();
    });
    selectEl(bar, [['', 'Any edition'], ['either', 'Signed or special'], ['signed', 'Signed'], ['edition', 'Special edition']], f.special || '', (v) => { f.special = v; this.renderNow(); });

    // Active narrow filters (author, shelf, year) as removable chips
    const active = [];
    if (f.author) active.push(['author', `Author: ${f.author}`]);
    if (f.shelf) active.push(['shelf', `Shelf: ${f.shelf}`]);
    if (f.year) active.push(['year', `Read in ${f.year}`]);
    if (active.length) {
      const chips = c.createDiv({ cls: 'stx-chips' });
      for (const [k, label] of active) {
        const b = chips.createEl('button', { cls: 'stx-chip is-active', text: `${label} ×` });
        b.addEventListener('click', () => { f[k] = ''; this.renderNow(); });
      }
    }

    const list = books.filter((b) => matchesFilter(b, f));
    const sorters = {
      title: byTitle,
      author: byAuthor,
      added: (a, b) => (b.added || '').localeCompare(a.added || '') || byTitle(a, b),
      read: (a, b) => lastRead(b).localeCompare(lastRead(a)) || byTitle(a, b),
    };
    list.sort(sorters[this.sort] || byTitle);

    const tools = c.createDiv({ cls: 'stx-toolbar' });
    tools.createSpan({ cls: 'stx-count', text: `${fmtNum(list.length)} ${list.length === 1 ? 'book' : 'books'}` });
    const right = tools.createDiv({ cls: 'stx-toolbar-right' });
    right.createSpan({ cls: 'stx-muted', text: 'Sort' });
    selectEl(right, [['title', 'Title'], ['author', 'Author'], ['added', 'Recently added'], ['read', 'Recently read']], this.sort, (v) => { this.sort = v; this.renderNow(); });
    right.createSpan({ cls: 'stx-muted', text: 'Group' });
    selectEl(right, [['none', 'None'], ['author', 'Author'], ['genre', 'Genre'], ['topic', 'Topic'], ['location', 'Location'], ['format', 'Format'], ['status', 'Status']], this.groupBy, (v) => { this.groupBy = v; this.renderNow(); });
    const sel = right.createEl('button', { cls: this.selecting ? 'is-active' : '', text: this.selecting ? 'Done' : 'Select' });
    sel.addEventListener('click', () => { this.selecting = !this.selecting; this.selected.clear(); this.renderNow(); });

    if (this.selecting) this.renderBulkBar(c, list);

    const box = c.createDiv({ cls: 'stx-list' });
    const draw = () => {
      box.empty();
      const q = this.filter.query;
      const visible = q ? list.filter((b) => matchesFilter(b, { query: q })) : list;
      let rows = visible;
      if (this.groupBy !== 'none') {
        const dim = DIMENSIONS[this.groupBy === 'topic' ? 'topic' : this.groupBy];
        const groups = new Map();
        for (const b of visible) {
          const vals = dim.values(b);
          const keys = vals.length ? vals : ['—'];
          for (const v of keys) { if (!groups.has(v)) groups.set(v, []); groups.get(v).push(b); }
        }
        const names = [...groups.keys()].sort((a, b) => (this.groupBy === 'author' ? authorSortKey(a).localeCompare(authorSortKey(b)) : a.localeCompare(b)));
        rows = [];
        for (const n of names) { rows.push({ heading: n, count: groups.get(n).length }); rows.push(...groups.get(n)); }
      }
      let drawn = 0;
      for (const r of rows) {
        if (drawn >= this.shown) break;
        if (r.heading !== undefined) { box.createDiv({ cls: 'stx-group', text: `${r.heading} · ${fmtNum(r.count)}` }); continue; }
        this.row(box, r);
        drawn++;
      }
      const total = rows.filter((r) => r.heading === undefined).length;
      if (!total) box.createDiv({ cls: 'stx-empty', text: 'No books match.' });
      if (total > drawn) {
        const m = box.createEl('button', { cls: 'stx-more', text: `Show more (${fmtNum(total - drawn)} left)` });
        m.addEventListener('click', () => { this.shown += p.settings.pageSize; draw(); });
      }
    };
    search.addEventListener('input', debounce(() => { this.filter.query = search.value; this.shown = p.settings.pageSize; draw(); }, 200, true));
    draw();
  }

  renderBulkBar(c, list) {
    const p = this.plugin;
    const bar = c.createDiv({ cls: 'stx-bulk' });
    bar.createSpan({ text: `${fmtNum(this.selected.size)} selected` });
    const all = bar.createEl('button', { text: `Select all ${fmtNum(list.length)}` });
    all.addEventListener('click', () => { list.forEach((b) => this.selected.add(b.path)); this.renderNow(); });
    const none = bar.createEl('button', { text: 'Clear' });
    none.addEventListener('click', () => { this.selected.clear(); this.renderNow(); });
    const chosen = () => this.books.filter((b) => this.selected.has(b.path));
    const act = (label, fn) => {
      const b = bar.createEl('button', { cls: 'mod-cta', text: label });
      b.addEventListener('click', () => { const s = chosen(); if (!s.length) { new Notice('Select some books first'); return; } fn(s); });
    };
    act('Move…', (s) => new MoveModal(p, s).open());
    act('Set…', (s) => new BulkEditModal(p, s).open());
  }

  row(parent, b) {
    const p = this.plugin;
    const row = parent.createDiv({ cls: `stx-row ${this.selected.has(b.path) ? 'is-selected' : ''}` });
    if (this.selecting) {
      const cb = row.createEl('input', { type: 'checkbox', cls: 'stx-check' });
      cb.checked = this.selected.has(b.path);
      cb.addEventListener('change', () => { if (cb.checked) this.selected.add(b.path); else this.selected.delete(b.path); row.toggleClass('is-selected', cb.checked); this.updateBulkCount(); });
    }
    if (p.settings.showCovers) renderCover(row, b, 'stx-cover-xs');
    const body = row.createDiv({ cls: 'stx-row-body' });
    const a = body.createEl('a', { cls: 'stx-title', text: b.title, href: '#' });
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (this.selecting) { const on = !this.selected.has(b.path); if (on) this.selected.add(b.path); else this.selected.delete(b.path); this.renderNow(); return; }
      p.openBook(b);
    });
    if (b.author) {
      const au = body.createDiv({ cls: 'stx-author' });
      splitAuthors(b.author).forEach((name, i) => {
        if (i) au.appendText(', ');
        const l = au.createEl('a', { cls: 'stx-author-link', text: name, href: '#' });
        l.addEventListener('click', (e) => { e.preventDefault(); this.setFilter({ author: name }); });
      });
    }
    const meta = bookMeta(b);
    if (meta) body.createDiv({ cls: 'stx-meta', text: meta });
    const tags = row.createDiv({ cls: 'stx-row-tags' });
    if (b.status) chip(tags, STATUS_LABEL[b.status], `stx-s-${b.status}`);
    if (!b.owned) chip(tags, b.source || 'Not owned', 'stx-elsewhere');
    if (b.signed) chip(tags, 'Signed', 'stx-special');
    if (b.edition) chip(tags, 'Special', 'stx-special').setAttr('title', b.edition);
    if (b.read.length > 1) chip(tags, `Read ×${b.read.length}`);
  }

  updateBulkCount() {
    const el = this.contentEl.querySelector('.stx-bulk span');
    if (el) el.setText(`${fmtNum(this.selected.size)} selected`);
  }

  /* ----- Browse ----- */

  renderBrowse(c, books) {
    const bar = c.createDiv({ cls: 'stx-chips stx-dims' });
    for (const [k, d] of Object.entries(DIMENSIONS)) {
      const b = bar.createEl('button', { cls: `stx-chip ${this.browseDim === k ? 'is-active' : ''}`, text: d.label });
      b.addEventListener('click', () => { this.browseDim = k; this.browseQuery = ''; this.browseShown = 200; this.renderNow(); });
    }
    const search = c.createEl('input', { type: 'search', cls: 'stx-search', attr: { placeholder: `Find ${DIMENSIONS[this.browseDim].label.toLowerCase()}` } });
    search.value = this.browseQuery;
    const pool = this.browseDim === 'year' ? books : books.filter((b) => b.owned);
    let values = tally(pool, this.browseDim);
    if (this.browseDim === 'author') values.sort((a, b) => authorSortKey(a.value).localeCompare(authorSortKey(b.value)));
    else if (this.browseDim === 'year') values.sort((a, b) => b.value.localeCompare(a.value));
    else values.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    const sortRow = c.createDiv({ cls: 'stx-toolbar' });
    sortRow.createSpan({ cls: 'stx-count', text: `${fmtNum(values.length)} ${DIMENSIONS[this.browseDim].label.toLowerCase()}` });
    const listEl = c.createDiv({ cls: 'stx-browse' });
    const draw = () => {
      listEl.empty();
      const q = foldText(this.browseQuery);
      const shown = q ? values.filter((v) => foldText(v.value).includes(q)) : values;
      let letter = '';
      for (const v of shown.slice(0, this.browseShown)) {
        if (this.browseDim === 'author' && !q) {
          const l = (authorSortKey(v.value)[0] || '#').toUpperCase();
          if (l !== letter) { letter = l; listEl.createDiv({ cls: 'stx-letter', text: l }); }
        }
        const row = listEl.createDiv({ cls: 'stx-browse-row' });
        const a = row.createEl('a', { text: v.value, href: '#' });
        a.addEventListener('click', (e) => { e.preventDefault(); this.applyBrowse(v.value); });
        row.createSpan({ cls: 'stx-muted', text: `${fmtNum(v.count)}${v.read ? ` · ${fmtNum(v.read)} read` : ''}` });
      }
      if (shown.length > this.browseShown) {
        const m = listEl.createEl('button', { cls: 'stx-more', text: `Show more (${fmtNum(shown.length - this.browseShown)} left)` });
        m.addEventListener('click', () => { this.browseShown += 200; draw(); });
      }
      if (!shown.length) listEl.createDiv({ cls: 'stx-empty', text: 'Nothing matches.' });
    };
    search.addEventListener('input', debounce(() => { this.browseQuery = search.value; this.browseShown = 200; draw(); }, 150, true));
    draw();
  }

  applyBrowse(value) {
    const d = this.browseDim;
    if (d === 'author') return this.setFilter({ author: value });
    if (d === 'genre') return this.setFilter({ genre: value });
    if (d === 'topic') return this.setFilter({ topic: value });
    if (d === 'format') return this.setFilter(value === 'No format' ? {} : { format: value });
    if (d === 'status') return this.setFilter({ status: Object.keys(STATUS_LABEL).find((k) => STATUS_LABEL[k] === value) ?? 'any' });
    if (d === 'year') return this.setFilter({ year: value, owned: 'all' });
    if (d === 'location') {
      if (value === 'No location') return this.setFilter({ noLocation: true });
      const [room, ...rest] = value.split(' / ');
      return this.setFilter({ room, shelf: rest.join(' / ') });
    }
  }

  /* ----- Reading ----- */

  renderReading(c, books) {
    const p = this.plugin;
    const now = books.filter((b) => b.status === 'reading').sort(byTitle);
    c.createDiv({ cls: 'stx-label', text: `Reading now · ${now.length}` });
    if (!now.length) c.createDiv({ cls: 'stx-empty', text: 'Nothing in progress. "Start reading" on any book puts it here.' });
    for (const b of now) {
      const row = c.createDiv({ cls: 'stx-row' });
      renderCover(row, b, 'stx-cover-xs');
      const body = row.createDiv({ cls: 'stx-row-body' });
      body.createEl('a', { cls: 'stx-title', text: b.title, href: '#' }).addEventListener('click', (e) => { e.preventDefault(); p.openBook(b); });
      body.createDiv({ cls: 'stx-author', text: [b.author, b.started && `since ${niceDate(b.started)}`].filter(Boolean).join(' · ') });
      row.createEl('button', { cls: 'mod-cta', text: 'Finished' }).addEventListener('click', () => new ReadModal(p, b).open());
    }

    const years = new Map();
    let undated = 0;
    for (const b of books) {
      for (const d of b.read) { const y = yearOf(d); years.set(y, (years.get(y) || 0) + 1); }
      if (b.status === 'read' && !b.read.length) undated++;
    }
    const ys = [...years.keys()].sort().reverse();
    c.createDiv({ cls: 'stx-label', text: 'Read by year' });
    if (!ys.length) {
      c.createDiv({ cls: 'stx-empty', text: 'No reading dates yet. "Mark read" logs the date, and a CSV import can bring in "Date read".' });
    } else {
      if (!this.year || !years.has(this.year)) this.year = ys[0];
      const chips = c.createDiv({ cls: 'stx-chips' });
      for (const y of ys) {
        const b = chips.createEl('button', { cls: `stx-chip ${this.year === y ? 'is-active' : ''}`, text: `${y} · ${years.get(y)}` });
        b.addEventListener('click', () => { this.year = y; this.renderNow(); });
      }
      const max = Math.max(...years.values());
      const chart = c.createDiv({ cls: 'stx-years' });
      for (const y of [...ys].reverse().slice(-15)) {
        const col = chart.createDiv({ cls: `stx-year ${y === this.year ? 'is-active' : ''}` });
        const bar = col.createDiv({ cls: 'stx-year-bar' });
        bar.setCssProps({ '--stx-h': `${Math.max(4, Math.round((years.get(y) / max) * 100))}%` });
        col.createDiv({ cls: 'stx-year-label', text: `'${y.slice(2)}` });
        col.setAttr('title', `${y}: ${years.get(y)}`);
        col.addEventListener('click', () => { this.year = y; this.renderNow(); });
      }
      const entries = [];
      for (const b of books) for (const d of b.read) if (d.startsWith(this.year)) entries.push({ d, b });
      entries.sort((x, y) => y.d.localeCompare(x.d));
      const head = c.createDiv({ cls: 'stx-toolbar' });
      head.createSpan({ cls: 'stx-count', text: `${entries.length} read in ${this.year}` });
      head.createEl('button', { text: 'Year-end report' }).addEventListener('click', () => p.exportReadingYear(this.year));
      for (const { d, b } of entries) {
        const row = c.createDiv({ cls: 'stx-row' });
        renderCover(row, b, 'stx-cover-xs');
        const body = row.createDiv({ cls: 'stx-row-body' });
        body.createEl('a', { cls: 'stx-title', text: b.title, href: '#' }).addEventListener('click', (e) => { e.preventDefault(); p.openBook(b); });
        const how = [b.author, b.format, !b.owned && (b.source ? `via ${b.source}` : 'not owned')].filter(Boolean).join(' · ');
        if (how) body.createDiv({ cls: 'stx-author', text: how });
        row.createSpan({ cls: 'stx-muted', text: /^\d{4}$/.test(d) ? 'year only' : niceDate(d) });
      }
    }
    if (undated) c.createDiv({ cls: 'stx-muted stx-note', text: `${fmtNum(undated)} books are marked read with no date.` });
  }

  /* ----- Duplicates ----- */

  renderDuplicates(c, books) {
    const p = this.plugin;
    const groups = findDuplicateGroups(books, p.settings.ignoredDupes);
    c.createEl('p', { cls: 'stx-muted', text: 'Books whose title and first author match, ignoring subtitles, punctuation and "The". Open them to compare. Keep the one with the better details and move the other to the trash, or mark the pair as not duplicates.' });
    if (!groups.length) { c.createDiv({ cls: 'stx-empty', text: 'No likely duplicates. Nice.' }); return; }
    c.createDiv({ cls: 'stx-count', text: `${groups.length} possible ${groups.length === 1 ? 'duplicate' : 'duplicates'}` });
    for (const g of groups.slice(0, 200)) {
      const box = c.createDiv({ cls: 'stx-dupe' });
      for (const b of g.books) {
        const row = box.createDiv({ cls: 'stx-row' });
        const body = row.createDiv({ cls: 'stx-row-body' });
        body.createEl('a', { cls: 'stx-title', text: b.title, href: '#' }).addEventListener('click', (e) => { e.preventDefault(); p.openBook(b); });
        body.createDiv({ cls: 'stx-author', text: [b.author || 'no author', bookMeta(b), b.edition && `Edition: ${b.edition}`].filter(Boolean).join(' · ') });
        const del = row.createEl('button', { cls: 'mod-warning', attr: { 'aria-label': `Move ${b.title} to the trash` } });
        setIcon(del, 'trash-2');
        del.addEventListener('click', () => new ConfirmModal(this.app, `Trash this copy of ${b.title}?`, `${b.path} goes to the vault's trash. You can restore it from there.`, 'Move to trash', async () => { await p.trashBook(b); }).open());
      }
      const acts = box.createDiv({ cls: 'stx-actions' });
      acts.createEl('button', { text: 'Not duplicates' }).addEventListener('click', async () => {
        p.settings.ignoredDupes.push(g.key);
        await p.saveSettings();
        this.renderNow();
      });
    }
    if (groups.length > 200) c.createDiv({ cls: 'stx-muted', text: `Showing the first 200 of ${groups.length}.` });
  }
}

/* ------------------------------------------------------------------ */
/* Code block: ```stacks```                                            */
/* ------------------------------------------------------------------ */

class StacksBlock extends MarkdownRenderChild {
  constructor(el, plugin, source, sourcePath) {
    super(el);
    this.plugin = plugin;
    this.sourcePath = sourcePath;
    this.opts = {};
    for (const line of source.split('\n')) { const m = line.match(/^\s*([\w ]+?)\s*:\s*(.*?)\s*$/); if (m) this.opts[m[1].toLowerCase()] = m[2]; }
    this.render = debounce(() => { if (!this.plugin.busy) this.renderNow(); }, 300, true);
  }
  onload() {
    this.registerEvent(this.plugin.app.metadataCache.on('changed', (f) => { if (f.path === this.sourcePath || this.opts.show !== 'book') this.render(); }));
    this.renderNow();
  }

  list(el, books, note) {
    const p = this.plugin;
    if (!books.length) { el.createDiv({ cls: 'stx-empty', text: 'None yet.' }); return; }
    const ul = el.createEl('ul', { cls: 'stx-plain' });
    for (const b of books.slice(0, 500)) {
      const li = ul.createEl('li');
      const a = li.createEl('a', { cls: 'internal-link', text: b.title, href: b.path, attr: { 'data-href': b.path } });
      a.addEventListener('click', (e) => { e.preventDefault(); p.openBook(b, this.sourcePath); });
      const extra = note ? note(b) : b.author;
      if (extra) li.createSpan({ cls: 'stx-muted', text: ` — ${extra}` });
    }
    if (books.length > 500) el.createDiv({ cls: 'stx-muted', text: `…and ${fmtNum(books.length - 500)} more` });
  }

  renderNow() {
    const el = this.containerEl, p = this.plugin, o = this.opts;
    el.empty();
    el.addClass('stx-block');
    const show = (o.show || '').toLowerCase();
    const books = p.getBooks();

    if (show === 'book') {
      const b = books.find((x) => x.path === this.sourcePath);
      if (!b) return;
      const bar = el.createDiv({ cls: 'stx-bookbar' });
      chip(bar, STATUS_LABEL[b.status], b.status ? `stx-s-${b.status}` : '');
      if (b.format) chip(bar, b.format);
      if (b.owned) chip(bar, locationOf(b) || 'No location', 'stx-loc');
      else chip(bar, b.source ? `Read via ${b.source}` : 'Not owned', 'stx-elsewhere');
      if (b.signed) chip(bar, 'Signed', 'stx-special');
      if (b.edition) chip(bar, b.edition, 'stx-special');
      if (b.read.length) bar.createSpan({ cls: 'stx-muted', text: `Read ${b.read.map(niceDate).join(', ')}` });
      const acts = bar.createDiv({ cls: 'stx-bar-actions' });
      const btn = (label, fn, cta) => acts.createEl('button', { cls: cta ? 'mod-cta' : '', text: label }).addEventListener('click', fn);
      if (b.status !== 'reading') btn(b.read.length ? 'Read again' : 'Start reading', () => p.startReading(b));
      btn('Mark read', () => new ReadModal(p, b).open(), b.status === 'reading');
      if (b.owned) btn('Move…', () => new MoveModal(p, [b]).open());
      if (!b.cover) btn('Find cover', () => new CoverModal(p, b).open());
      const mine = new Set(splitAuthors(b.author).map((a) => a.toLowerCase()));
      if (mine.size) {
        const others = books.filter((x) => x.path !== b.path && splitAuthors(x.author).some((a) => mine.has(a.toLowerCase()))).sort(byTitle);
        if (others.length) {
          const det = el.createEl('details', { cls: 'stx-more-by' });
          det.createEl('summary', { text: `More by ${splitAuthors(b.author).join(', ')} · ${others.length}` });
          this.list(det, others, (x) => [x.year, STATUS_LABEL[x.status] !== 'Not set' && STATUS_LABEL[x.status]].filter(Boolean).join(' · '));
        }
      }
      return;
    }

    let list = null, note;
    if (show === 'author' || o.author) {
      const a = (o.author || '').toLowerCase();
      list = books.filter((b) => splitAuthors(b.author).some((x) => x.toLowerCase() === a)).sort(byTitle);
      note = (b) => [b.year, STATUS_LABEL[b.status] !== 'Not set' && STATUS_LABEL[b.status]].filter(Boolean).join(' · ');
    } else if (show === 'genre' || o.genre) list = books.filter((b) => matchesFilter(b, { genre: o.genre })).sort(byAuthor);
    else if (show === 'topic' || o.topic) list = books.filter((b) => matchesFilter(b, { topic: o.topic })).sort(byAuthor);
    else if (show === 'reading') list = books.filter((b) => b.status === 'reading').sort(byTitle);
    else if (show === 'year' || o.year) {
      const y = o.year || String(new Date().getFullYear());
      const entries = [];
      for (const b of books) for (const d of b.read) if (d.startsWith(y)) entries.push({ d, b });
      entries.sort((x, z) => x.d.localeCompare(z.d));
      el.createDiv({ cls: 'stx-label', text: `Read in ${y} · ${entries.length}` });
      this.list(el, entries.map((e) => e.b), (b) => b.author);
      return;
    } else if (show === 'signed') list = books.filter((b) => b.signed || b.edition).sort(byAuthor);
    else if (show === 'shelf' || o.room || o.shelf) list = books.filter((b) => matchesFilter(b, { room: o.room, shelf: o.shelf })).sort(byAuthor);
    if (!list) { el.createDiv({ cls: 'stx-empty', text: 'stacks: use show: book, author, genre, topic, reading, year, signed or shelf.' }); return; }
    el.createDiv({ cls: 'stx-label', text: `${fmtNum(list.length)} ${list.length === 1 ? 'book' : 'books'}` });
    this.list(el, list, note);
  }
}

/* ------------------------------------------------------------------ */
/* Modals                                                             */
/* ------------------------------------------------------------------ */

async function searchOpenLibrary(title, author, limit) {
  const fields = 'key,title,author_name,cover_i,first_publish_year,isbn';
  const go = async (withAuthor) => {
    const q = new URLSearchParams({ title, limit: String(limit ? Math.max(limit, 5) : 8), fields });
    if (withAuthor && author) q.set('author', author);
    const res = await requestUrl({ url: `https://openlibrary.org/search.json?${q}` });
    return res.json.docs || [];
  };
  let docs = await go(true);
  if (!docs.length && author) docs = await go(false);
  if (limit) docs = docs.filter((d) => d.cover_i).slice(0, limit);
  return docs.map((d) => ({
    title: d.title,
    author: (d.author_name || []).slice(0, 3).join('; '),
    year: d.first_publish_year ? String(d.first_publish_year) : '',
    isbn: (d.isbn || []).find((i) => i.length === 13) || (d.isbn || [])[0] || '',
    cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : '',
  }));
}

class AddBookModal extends Modal {
  constructor(plugin, opts) {
    super(plugin.app);
    this.plugin = plugin;
    this.elsewhere = !!(opts && opts.elsewhere);
    this.sticky = this.elsewhere
      ? { status: 'read', format: '', room: '', shelf: '', owned: false, source: '' }
      : { status: plugin.settings.defaultStatus, format: '', room: '', shelf: '', owned: true, source: '' };
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('stx-modal');
    this.titleEl.setText(this.elsewhere ? 'Log a book you read' : 'Add a book');
    this.books = this.plugin.getBooks();
    this.index = new Map();
    for (const b of this.books) { const k = dupKey(b.title, b.author); if (k) { if (!this.index.has(k)) this.index.set(k, []); this.index.get(k).push(b); } }
    this.draw();
  }

  draw() {
    const { contentEl } = this, p = this.plugin;
    contentEl.empty();
    const d = { title: '', author: '', status: this.sticky.status, genres: [], topics: [], format: this.sticky.format, room: this.sticky.room,
      shelf: this.sticky.shelf, owned: this.sticky.owned, source: this.sticky.source, readDate: todayStr(),
      signed: false, edition: '', isbn: '', year: '', cover: '', notes: '' };
    const uid = Math.random().toString(36).slice(2, 7);
    datalist(contentEl, `stx-genres-${uid}`, p.values(this.books, 'genre'));
    datalist(contentEl, `stx-topics-${uid}`, p.values(this.books, 'topic'));
    datalist(contentEl, `stx-rooms-${uid}`, [...new Set(this.books.map((b) => b.room).filter(Boolean))].sort());
    datalist(contentEl, `stx-shelves-${uid}`, [...new Set(this.books.map((b) => b.shelf).filter(Boolean))].sort());
    datalist(contentEl, `stx-sources-${uid}`, [...new Set(['Spotify', 'Libby', 'Kindle', 'Audible', 'Public library', ...this.books.map((b) => b.source).filter(Boolean)])]);
    datalist(contentEl, `stx-authors-${uid}`, [...new Set(this.books.flatMap((b) => splitAuthors(b.author)))].sort().slice(0, 3000));

    const warn = contentEl.createDiv({ cls: 'stx-dup-warn' });
    const checkDup = () => {
      warn.empty();
      const k = dupKey(d.title, d.author);
      const hits = (k && this.index.get(k)) || [];
      const titleOnly = !hits.length && d.title.length > 3 && !d.author
        ? this.books.filter((b) => titleKey(b.title) === titleKey(d.title)) : [];
      const all = hits.length ? hits : titleOnly;
      if (!all.length) { warn.removeClass('is-on'); return; }
      warn.addClass('is-on');
      warn.createSpan({ text: hits.length ? 'Already in The Stacks: ' : 'Same title in The Stacks: ' });
      all.slice(0, 3).forEach((b, i) => {
        if (i) warn.appendText(', ');
        const a = warn.createEl('a', { text: `${b.title}${b.author ? ` (${b.author})` : ''}${locationOf(b) ? ` — ${locationOf(b)}` : ''}`, href: '#' });
        a.addEventListener('click', (e) => { e.preventDefault(); p.openBook(b); });
      });
    };

    let titleIn, authorIn, yearIn, isbnIn, coverIn;
    new Setting(contentEl).setName('Title').addText((t) => {
      titleIn = t;
      t.setPlaceholder('Required').onChange((v) => { d.title = v.trim(); checkDup(); });
      window.setTimeout(() => t.inputEl.focus(), 50);
    });
    new Setting(contentEl).setName('Author').setDesc('Separate co-authors with ";" or "&".').addText((t) => {
      authorIn = t;
      t.inputEl.setAttr('list', `stx-authors-${uid}`);
      t.onChange((v) => { d.author = v.trim(); checkDup(); });
    });
    contentEl.appendChild(warn);

    // Open Library lookup
    const look = contentEl.createDiv({ cls: 'stx-lookup' });
    const lookBtn = look.createEl('button', { text: 'Look up details' });
    const results = look.createDiv({ cls: 'stx-lookup-results' });
    lookBtn.addEventListener('click', async () => {
      if (!d.title) { new Notice('Type a title first'); return; }
      results.empty();
      results.createDiv({ cls: 'stx-muted', text: 'Searching Open Library…' });
      try {
        const found = await searchOpenLibrary(d.title, splitAuthors(d.author)[0] || '');
        results.empty();
        if (!found.length) { results.createDiv({ cls: 'stx-muted', text: 'Nothing found.' }); return; }
        for (const r of found.slice(0, 6)) {
          const opt = results.createEl('button', { cls: 'stx-lookup-option' });
          if (r.cover) opt.createEl('img', { attr: { src: r.cover, alt: '', loading: 'lazy' } });
          const tx = opt.createDiv();
          tx.createDiv({ cls: 'stx-title', text: r.title });
          tx.createDiv({ cls: 'stx-muted', text: [r.author, r.year].filter(Boolean).join(' · ') });
          opt.addEventListener('click', () => {
            if (!d.author && r.author) { d.author = r.author; authorIn.setValue(r.author); }
            if (r.year) { d.year = r.year; yearIn.setValue(r.year); }
            if (r.isbn) { d.isbn = r.isbn; isbnIn.setValue(r.isbn); }
            if (r.cover) { d.cover = r.cover; coverIn.setValue(r.cover); }
            results.empty();
            results.createDiv({ cls: 'stx-muted', text: 'Details filled in.' });
            checkDup();
          });
        }
      } catch (e) { results.empty(); results.createDiv({ cls: 'stx-muted', text: "Couldn't reach Open Library." }); }
    });

    let readRow;
    new Setting(contentEl).setName('Status').addDropdown((dd) => {
      dd.addOption('', 'Not set');
      STATUSES.forEach((s) => dd.addOption(s, STATUS_LABEL[s]));
      dd.setValue(d.status).onChange((v) => { d.status = v; this.sticky.status = v; readRow.settingEl.toggleClass('stx-hidden', v !== 'read'); });
    });
    readRow = new Setting(contentEl).setName('Date finished').setDesc('Or type just a year, like 2009.').addText((t) => {
      t.setValue(d.readDate).onChange((v) => { d.readDate = toDateStr(v); });
    });
    readRow.settingEl.toggleClass('stx-hidden', d.status !== 'read');
    new Setting(contentEl).setName('Format').addDropdown((dd) => {
      dd.addOption('', '—');
      p.settings.formats.forEach((f) => dd.addOption(f, f));
      if (d.format && !p.settings.formats.includes(d.format)) dd.addOption(d.format, d.format);
      dd.setValue(d.format).onChange((v) => { d.format = v; this.sticky.format = v; });
    });
    new Setting(contentEl).setName('Genre').setDesc('Comma-separated.').addText((t) => { t.inputEl.setAttr('list', `stx-genres-${uid}`); t.onChange((v) => { d.genres = toList(v); }); });
    new Setting(contentEl).setName('Topics').setDesc('Comma-separated.').addText((t) => { t.inputEl.setAttr('list', `stx-topics-${uid}`); t.onChange((v) => { d.topics = toList(v); }); });
    let loc, srcRow;
    const showOwned = () => {
      loc.settingEl.toggleClass('stx-hidden', !d.owned);
      srcRow.settingEl.toggleClass('stx-hidden', d.owned);
    };
    new Setting(contentEl).setName('I own this copy').addToggle((t) => t.setValue(d.owned).onChange((v) => { d.owned = v; this.sticky.owned = v; showOwned(); }));
    srcRow = new Setting(contentEl).setName('Where from').setDesc('Spotify, Libby, a friend…').addText((t) => {
      t.setValue(d.source); t.inputEl.setAttr('list', `stx-sources-${uid}`);
      t.onChange((v) => { d.source = v.trim(); this.sticky.source = d.source; });
    });
    loc = new Setting(contentEl).setName('Location').setDesc('Optional. Room and shelf.');
    loc.addText((t) => { t.setPlaceholder('Room').setValue(d.room); t.inputEl.setAttr('list', `stx-rooms-${uid}`); t.onChange((v) => { d.room = v.trim(); this.sticky.room = d.room; }); });
    loc.addText((t) => { t.setPlaceholder('Shelf').setValue(d.shelf); t.inputEl.setAttr('list', `stx-shelves-${uid}`); t.onChange((v) => { d.shelf = v.trim(); this.sticky.shelf = d.shelf; }); });
    showOwned();
    new Setting(contentEl).setName('Signed').addToggle((t) => t.onChange((v) => { d.signed = v; }));
    new Setting(contentEl).setName('Special edition').setDesc('First edition, illustrated, slipcased…').addText((t) => t.onChange((v) => { d.edition = v.trim(); }));
    const det = contentEl.createEl('details', { cls: 'stx-extra' });
    det.createEl('summary', { text: 'More details' });
    new Setting(det).setName('Year published').addText((t) => { yearIn = t; t.onChange((v) => { d.year = v.trim(); }); });
    new Setting(det).setName('ISBN').addText((t) => { isbnIn = t; t.onChange((v) => { d.isbn = cleanIsbn(v); }); });
    new Setting(det).setName('Cover URL').addText((t) => { coverIn = t; t.onChange((v) => { d.cover = v.trim(); }); });
    contentEl.createDiv({ cls: 'stx-label', text: 'Notes' });
    const notes = contentEl.createEl('textarea', { cls: 'stx-textarea', attr: { rows: '3', placeholder: 'Optional' } });
    notes.addEventListener('input', () => { d.notes = notes.value; });

    const save = async (another) => {
      if (!d.title) { new Notice('A title is the one thing I need'); return; }
      const k = dupKey(d.title, d.author);
      const book = { ...d, title: d.title.replace(/\s+/g, ' '), read: d.status === 'read' && d.readDate ? [d.readDate] : [] };
      if (!d.owned) { book.room = ''; book.shelf = ''; }
      const f = await p.createBook(book);
      if (k) { if (!this.index.has(k)) this.index.set(k, []); this.index.get(k).push(p.readBook(f)); }
      this.books.push({ ...bookFromFrontmatter(f.path, f.basename, { title: d.title, author: d.author }), file: f });
      new Notice(d.owned ? `Added ${d.title}` : `Logged ${d.title}`);
      if (another) this.draw(); else this.close();
    };
    new Setting(contentEl)
      .addButton((b) => b.setButtonText('Add and add another').onClick(() => save(true)))
      .addButton((b) => b.setButtonText(this.elsewhere ? 'Log it' : 'Add book').setCta().onClick(() => save(false)));
    titleIn.inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save(true); });
  }

  onClose() { this.contentEl.empty(); }
}

class ImportModal extends Modal {
  constructor(plugin) { super(plugin.app); this.plugin = plugin; this.text = ''; this.source = ''; this.tables = []; this.tableIdx = 0; this.mapping = []; this.defaults = { status: '', format: '', owned: true, source: '', room: '', shelf: '', genre: '', topic: '' }; }

  onOpen() {
    this.titleEl.setText('Import books');
    this.contentEl.addClass('stx-modal', 'stx-import');
    this.step1();
  }

  step1() {
    const c = this.contentEl;
    c.empty();
    c.createEl('p', { cls: 'stx-muted', text: 'Bring in a CSV (including Goodreads and LibraryThing exports), a Markdown file with a table or a bulleted list, or paste lines like "Title — Author". Nothing is written until you review the preview.' });
    const fileRow = c.createDiv({ cls: 'stx-actions' });
    const input = fileRow.createEl('input', { type: 'file', attr: { accept: '.csv,.tsv,.md,.markdown,.txt' } });
    input.addEventListener('change', async () => {
      const f = input.files && input.files[0];
      if (!f) return;
      this.text = await f.text();
      this.source = f.name;
      this.parse();
    });
    c.createDiv({ cls: 'stx-label', text: 'Or paste' });
    const ta = c.createEl('textarea', { cls: 'stx-textarea', attr: { rows: '10', placeholder: 'Bird by Bird — Anne Lamott\nDune by Frank Herbert\n…' } });
    new Setting(c).addButton((b) => b.setButtonText('Next').setCta().onClick(() => {
      if (!ta.value.trim()) { new Notice('Choose a file or paste a list'); return; }
      this.text = ta.value;
      this.source = 'pasted list';
      this.parse();
    }));
  }

  parse() {
    this.tables = parseImport(this.text, this.source).filter((t) => t.rows.length);
    if (!this.tables.length) { new Notice('No books found in that'); return; }
    // Prefer the first table that has a title column.
    const idx = this.tables.findIndex((t) => t.headers.some((h) => guessTarget(h) === 'title'));
    this.tableIdx = idx >= 0 ? idx : 0;
    this.resetMapping();
    this.step2();
  }

  resetMapping() {
    const t = this.tables[this.tableIdx];
    this.mapping = t.headers.map((h) => (h === 'Section' && t.name === 'List' ? 'genre' : guessTarget(h)));
    if (!this.mapping.includes('title') && this.mapping.length) this.mapping[0] = 'title';
  }

  step2() {
    const c = this.contentEl, p = this.plugin;
    c.empty();
    const t = this.tables[this.tableIdx];
    if (this.tables.length > 1) {
      new Setting(c).setName('Which table?').setDesc(`${this.tables.length} found in ${this.source}.`).addDropdown((dd) => {
        this.tables.forEach((x, i) => dd.addOption(String(i), `${x.name} — ${fmtNum(x.rows.length)} rows (${x.headers.slice(0, 4).join(', ')}${x.headers.length > 4 ? '…' : ''})`));
        dd.setValue(String(this.tableIdx)).onChange((v) => { this.tableIdx = Number(v); this.resetMapping(); this.step2(); });
      });
    }
    new Setting(c).setName('Columns').setHeading();
    c.createEl('p', { cls: 'stx-muted', text: 'What each column becomes. "Keep as its own property" saves it on the book note under the column\'s name.' });
    t.headers.forEach((h, i) => {
      const sample = t.rows.map((r) => r[i]).find((v) => v) || '';
      new Setting(c).setName(h || `Column ${i + 1}`).setDesc(sample.length > 60 ? `${sample.slice(0, 60)}…` : sample).addDropdown((dd) => {
        [...TARGETS, 'keep', 'ignore'].forEach((x) => dd.addOption(x, TARGET_LABEL[x]));
        dd.setValue(this.mapping[i]).onChange((v) => { this.mapping[i] = v; });
      });
    });
    new Setting(c).setName('Apply to every book').setHeading();
    c.createEl('p', { cls: 'stx-muted', text: 'Used when a row doesn\'t say otherwise. Handy when one file is one bookcase.' });
    new Setting(c).setName('Status').addDropdown((dd) => {
      dd.addOption('', 'Not set');
      STATUSES.forEach((s) => dd.addOption(s, STATUS_LABEL[s]));
      dd.setValue(this.defaults.status).onChange((v) => { this.defaults.status = v; });
    });
    new Setting(c).setName('Format').addDropdown((dd) => {
      dd.addOption('', '—');
      p.settings.formats.forEach((f) => dd.addOption(f, f));
      dd.setValue(this.defaults.format).onChange((v) => { this.defaults.format = v; });
    });
    new Setting(c).setName('Owned').setDesc('Turn off for a list of books you read but don\'t own, like a Spotify or Libby history.').addToggle((tg) => tg.setValue(this.defaults.owned).onChange((v) => { this.defaults.owned = v; }));
    new Setting(c).setName('Where from').setDesc('Only used for books you don\'t own.').addText((x) => x.setPlaceholder('Spotify, Libby, Kindle…').setValue(this.defaults.source).onChange((v) => { this.defaults.source = v.trim(); }));
    const loc = new Setting(c).setName('Location');
    loc.addText((x) => x.setPlaceholder('Room').setValue(this.defaults.room).onChange((v) => { this.defaults.room = v.trim(); }));
    loc.addText((x) => x.setPlaceholder('Shelf').setValue(this.defaults.shelf).onChange((v) => { this.defaults.shelf = v.trim(); }));
    new Setting(c).setName('Add genre').addText((x) => x.setValue(this.defaults.genre).onChange((v) => { this.defaults.genre = v; }));
    new Setting(c).setName('Add topic').addText((x) => x.setValue(this.defaults.topic).onChange((v) => { this.defaults.topic = v; }));
    new Setting(c)
      .addButton((b) => b.setButtonText('Back').onClick(() => this.step1()))
      .addButton((b) => b.setButtonText('Preview').setCta().onClick(() => {
        if (!this.mapping.includes('title')) { new Notice('Choose which column is the title'); return; }
        this.step3();
      }));
  }

  step3() {
    const c = this.contentEl, p = this.plugin;
    c.empty();
    const candidates = rowsToBooks(this.tables[this.tableIdx], this.mapping, this.defaults);
    const plan = planImport(candidates, p.getBooks(), p.settings.ignoredDupes);
    const opts = { includeInLibrary: false, includeRepeated: false, source: this.source };
    const sum = c.createDiv({ cls: 'stx-summary' });
    const stat = (n, label, cls) => { const d = sum.createDiv({ cls: `stx-stat ${cls || ''}` }); d.createDiv({ cls: 'stx-stat-n', text: fmtNum(n) }); d.createDiv({ text: label }); };
    stat(plan.fresh.length, 'new', 'is-new');
    stat(plan.inLibrary.length, 'already in the library');
    stat(plan.repeated.length, 'repeated in this list');

    if (plan.inLibrary.length) {
      const det = c.createEl('details', { cls: 'stx-extra' });
      det.createEl('summary', { text: `Already in the library (${fmtNum(plan.inLibrary.length)})` });
      const ul = det.createEl('ul', { cls: 'stx-plain' });
      for (const x of plan.inLibrary.slice(0, 200)) ul.createEl('li', { text: `${x.book.title}${x.book.author ? ` — ${x.book.author}` : ''}  →  ${x.match.title}${x.match.author ? ` (${x.match.author})` : ''}` });
      new Setting(det).setName('Import these anyway').setDesc('For a second copy or a different edition.').addToggle((tg) => tg.onChange((v) => { opts.includeInLibrary = v; }));
    }
    if (plan.repeated.length) {
      const det = c.createEl('details', { cls: 'stx-extra' });
      det.createEl('summary', { text: `Repeated in this list (${fmtNum(plan.repeated.length)})` });
      const ul = det.createEl('ul', { cls: 'stx-plain' });
      for (const x of plan.repeated.slice(0, 200)) ul.createEl('li', { text: `${x.book.title}${x.book.author ? ` — ${x.book.author}` : ''}` });
      new Setting(det).setName('Import repeats as separate copies').addToggle((tg) => tg.onChange((v) => { opts.includeRepeated = v; }));
    }

    c.createDiv({ cls: 'stx-label', text: `First ${Math.min(25, plan.fresh.length)} new books` });
    const tbl = c.createEl('table', { cls: 'stx-preview' });
    const hr = tbl.createEl('tr');
    ['Title', 'Author', 'Status', 'Genre', 'Location', 'Notes'].forEach((h) => hr.createEl('th', { text: h }));
    for (const b of plan.fresh.slice(0, 25)) {
      const tr = tbl.createEl('tr');
      [b.title, b.author, STATUS_LABEL[b.status], b.genres.join(', '), locationOf(b), b.notes.slice(0, 50)].forEach((v) => tr.createEl('td', { text: v || '' }));
    }
    new Setting(c)
      .addButton((b) => b.setButtonText('Back').onClick(() => this.step2()))
      .addButton((b) => b.setButtonText(`Import ${fmtNum(plan.fresh.length)} books`).setCta().onClick(async () => {
        this.close();
        const log = await p.runImport(plan, opts);
        if (log) p.openFile(log);
      }));
  }

  onClose() { this.contentEl.empty(); }
}

class MoveModal extends Modal {
  constructor(plugin, books) { super(plugin.app); this.plugin = plugin; this.books = books; }
  onOpen() {
    const c = this.contentEl, p = this.plugin;
    c.addClass('stx-modal');
    this.titleEl.setText(this.books.length === 1 ? `Move ${this.books[0].title}` : `Move ${fmtNum(this.books.length)} books`);
    const all = p.getBooks();
    const uid = Math.random().toString(36).slice(2, 7);
    datalist(c, `stx-mrooms-${uid}`, [...new Set(all.map((b) => b.room).filter(Boolean))].sort());
    datalist(c, `stx-mshelves-${uid}`, [...new Set(all.map((b) => b.shelf).filter(Boolean))].sort());
    const first = this.books[0];
    let room = this.books.every((b) => b.room === first.room) ? first.room : '';
    let shelf = this.books.every((b) => b.shelf === first.shelf) ? first.shelf : '';
    new Setting(c).setName('Room').addText((t) => { t.setValue(room); t.inputEl.setAttr('list', `stx-mrooms-${uid}`); t.onChange((v) => { room = v.trim(); }); window.setTimeout(() => t.inputEl.focus(), 50); });
    new Setting(c).setName('Shelf').addText((t) => { t.setValue(shelf); t.inputEl.setAttr('list', `stx-mshelves-${uid}`); t.onChange((v) => { shelf = v.trim(); }); });
    new Setting(c)
      .addButton((b) => b.setButtonText('Clear location').onClick(async () => { this.close(); await p.moveBooks(this.books, '', ''); }))
      .addButton((b) => b.setButtonText('Move').setCta().onClick(async () => { this.close(); await p.moveBooks(this.books, room, shelf); }));
  }
  onClose() { this.contentEl.empty(); }
}

class BulkEditModal extends Modal {
  constructor(plugin, books) { super(plugin.app); this.plugin = plugin; this.books = books; }
  onOpen() {
    const c = this.contentEl, p = this.plugin;
    c.addClass('stx-modal');
    this.titleEl.setText(`Change ${fmtNum(this.books.length)} books`);
    const ch = { status: null, format: null, addGenre: '', removeGenre: '', addTopic: '', removeTopic: '', signed: null, owned: null };
    new Setting(c).setName('Status').addDropdown((dd) => {
      dd.addOption('__keep', 'Leave as is'); dd.addOption('', 'Not set');
      STATUSES.forEach((s) => dd.addOption(s, STATUS_LABEL[s]));
      dd.setValue('__keep').onChange((v) => { ch.status = v === '__keep' ? null : v; });
    });
    new Setting(c).setName('Format').addDropdown((dd) => {
      dd.addOption('__keep', 'Leave as is'); dd.addOption('', '—');
      p.settings.formats.forEach((f) => dd.addOption(f, f));
      dd.setValue('__keep').onChange((v) => { ch.format = v === '__keep' ? null : v; });
    });
    new Setting(c).setName('Add genre').addText((t) => t.onChange((v) => { ch.addGenre = v; }));
    new Setting(c).setName('Remove genre').addText((t) => t.onChange((v) => { ch.removeGenre = v; }));
    new Setting(c).setName('Add topic').addText((t) => t.onChange((v) => { ch.addTopic = v; }));
    new Setting(c).setName('Remove topic').addText((t) => t.onChange((v) => { ch.removeTopic = v; }));
    new Setting(c).setName('Owned').addDropdown((dd) => {
      dd.addOption('__keep', 'Leave as is'); dd.addOption('true', 'On my shelves'); dd.addOption('false', "Don't own it");
      dd.setValue('__keep').onChange((v) => { ch.owned = v === '__keep' ? null : v === 'true'; });
    });
    new Setting(c).setName('Signed').addDropdown((dd) => {
      dd.addOption('__keep', 'Leave as is'); dd.addOption('true', 'Signed'); dd.addOption('false', 'Not signed');
      dd.setValue('__keep').onChange((v) => { ch.signed = v === '__keep' ? null : v === 'true'; });
    });
    new Setting(c).addButton((b) => b.setButtonText('Apply').setCta().onClick(async () => {
      this.close();
      const edit = (list, add, remove) => {
        let out = toList(list);
        toList(add).forEach((x) => { if (!out.some((o) => o.toLowerCase() === x.toLowerCase())) out.push(x); });
        const rm = toList(remove).map((x) => x.toLowerCase());
        out = out.filter((o) => !rm.includes(o.toLowerCase()));
        return out;
      };
      await p.bulk(this.books, 'Updating', (fm) => {
        if (ch.status !== null) fm.status = ch.status;
        if (ch.format !== null) fm.format = ch.format;
        if (ch.addGenre || ch.removeGenre) fm.genre = edit(fm.genre, ch.addGenre, ch.removeGenre);
        if (ch.addTopic || ch.removeTopic) fm.topics = edit(fm.topics, ch.addTopic, ch.removeTopic);
        if (ch.signed !== null) fm.signed = ch.signed;
        if (ch.owned !== null) fm.owned = ch.owned;
      });
    }));
  }
  onClose() { this.contentEl.empty(); }
}

class ReadModal extends Modal {
  constructor(plugin, book) { super(plugin.app); this.plugin = plugin; this.book = book; }
  onOpen() {
    const c = this.contentEl;
    c.addClass('stx-modal');
    this.titleEl.setText(`Finished ${this.book.title}`);
    let date = todayStr(), yearOnly = '', thoughts = '';
    new Setting(c).setName('Date finished').addText((t) => { t.inputEl.type = 'date'; t.setValue(date).onChange((v) => { date = toDateStr(v); }); });
    new Setting(c).setName('Or just the year').setDesc('For books read long ago.').addText((t) => t.setPlaceholder('e.g. 2009').onChange((v) => { yearOnly = v.trim(); }));
    c.createDiv({ cls: 'stx-label', text: 'A line for the reading log (optional)' });
    const ta = c.createEl('textarea', { cls: 'stx-textarea', attr: { rows: '3' } });
    ta.addEventListener('input', () => { thoughts = ta.value; });
    if (this.book.read.length) c.createDiv({ cls: 'stx-muted', text: `Also read: ${this.book.read.map(niceDate).join(', ')}` });
    new Setting(c).addButton((b) => b.setButtonText('Save').setCta().onClick(async () => {
      const d = /^\d{4}$/.test(yearOnly) ? yearOnly : date;
      if (!d) { new Notice('Pick a date or type a year'); return; }
      this.close();
      await this.plugin.markRead(this.book, d, thoughts);
    }));
  }
  onClose() { this.contentEl.empty(); }
}

class CoverModal extends Modal {
  constructor(plugin, book) { super(plugin.app); this.plugin = plugin; this.book = book; }
  onOpen() {
    const c = this.contentEl;
    c.addClass('stx-modal');
    this.titleEl.setText(`Cover for ${this.book.title}`);
    let url = this.book.cover;
    const results = c.createDiv({ cls: 'stx-cover-results' });
    const status = c.createDiv({ cls: 'stx-muted', text: 'Searching Open Library…' });
    let input;
    new Setting(c).setName('Image URL').addText((t) => { input = t; t.setValue(url).onChange((v) => { url = v.trim(); }); });
    new Setting(c).addButton((b) => b.setButtonText('Save').setCta().onClick(async () => {
      await this.plugin.app.fileManager.processFrontMatter(this.book.file, (fm) => { fm.cover = url; });
      this.close();
    }));
    searchOpenLibrary(this.book.title, splitAuthors(this.book.author)[0] || '').then((found) => {
      const withCovers = found.filter((r) => r.cover);
      status.setText(withCovers.length ? 'Tap the right cover.' : 'No covers found. Paste an image URL instead.');
      for (const r of withCovers) {
        const btn = results.createEl('button', { cls: 'stx-cover-option', attr: { title: `${r.title} ${r.year}` } });
        btn.createEl('img', { attr: { src: r.cover, alt: r.title, loading: 'lazy' } });
        btn.addEventListener('click', () => { url = r.cover; input.setValue(url); results.querySelectorAll('.stx-cover-option').forEach((x) => x.removeClass('is-picked')); btn.addClass('is-picked'); });
      }
    }).catch(() => status.setText("Couldn't reach Open Library."));
  }
  onClose() { this.contentEl.empty(); }
}

class PromptModal extends Modal {
  constructor(app, title, value, onSubmit) { super(app); this.t = title; this.value = value || ''; this.onSubmit = onSubmit; }
  onOpen() {
    this.titleEl.setText(this.t);
    let input;
    const submit = () => { const v = input.getValue(); this.close(); this.onSubmit(v); };
    new Setting(this.contentEl).addText((t) => {
      input = t; t.setValue(this.value);
      t.inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
      window.setTimeout(() => { t.inputEl.focus(); t.inputEl.select(); }, 50);
    });
    new Setting(this.contentEl).addButton((b) => b.setButtonText('OK').setCta().onClick(submit));
  }
  onClose() { this.contentEl.empty(); }
}

class ConfirmModal extends Modal {
  constructor(app, title, body, yes, onYes) { super(app); this.t = title; this.b = body; this.yes = yes; this.onYes = onYes; }
  onOpen() {
    this.titleEl.setText(this.t);
    this.contentEl.createEl('p', { text: this.b });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((b) => b.setButtonText(this.yes).setWarning().onClick(() => { this.close(); this.onYes(); }));
  }
  onClose() { this.contentEl.empty(); }
}

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */

class StacksSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this, s = this.plugin.settings, save = () => this.plugin.saveSettings();
    containerEl.empty();
    new Setting(containerEl).setName('Open the library when the vault opens').addToggle((t) => t.setValue(s.openOnStartup).onChange(async (v) => { s.openOnStartup = v; await save(); }));
    new Setting(containerEl).setName('Show covers in lists').addToggle((t) => t.setValue(s.showCovers).onChange(async (v) => { s.showCovers = v; await save(); }));
    new Setting(containerEl).setName('Books per page').setDesc('How many rows to draw before "Show more".').addText((t) => t.setValue(String(s.pageSize)).onChange(async (v) => {
      const n = parseInt(v, 10); if (n >= 10) { s.pageSize = n; await save(); }
    }));
    new Setting(containerEl).setName('Status for new books').addDropdown((dd) => {
      dd.addOption('', 'Not set'); STATUSES.forEach((x) => dd.addOption(x, STATUS_LABEL[x]));
      dd.setValue(s.defaultStatus).onChange(async (v) => { s.defaultStatus = v; await save(); });
    });
    new Setting(containerEl).setName('Formats').setDesc('Comma-separated list for the Format menus.').addTextArea((t) => t.setValue(s.formats.join(', ')).onChange(async (v) => {
      const list = toList(v); if (list.length) { s.formats = list; await save(); }
    }));
    new Setting(containerEl).setName('Folders').setHeading();
    const folder = (name, key) => new Setting(containerEl).setName(name).addText((t) => t.setValue(s[key]).onChange(async (v) => { s[key] = v.trim() || DEFAULT_SETTINGS[key]; await save(); }));
    folder('Books', 'booksFolder');
    folder('Import logs', 'importsFolder');
    folder('Exports', 'exportsFolder');
    new Setting(containerEl).setName('Duplicates').setHeading();
    new Setting(containerEl).setName('Forget "not duplicates" choices').setDesc(`${s.ignoredDupes.length} pairs marked as not duplicates.`)
      .addButton((b) => b.setButtonText('Reset').onClick(async () => { s.ignoredDupes = []; await save(); this.display(); }));
  }
}

module.exports = StacksPlugin;
module.exports.default = StacksPlugin;
module.exports.helpers = {
  todayStr, toDateStr, toList, normStatus, truthy, splitAuthors, foldText, titleKey, surnameKey, dupKey, cleanIsbn,
  cleanNote, bookFromFrontmatter, buildBookNote, parseCsv, parseMarkdown, parseImport, parseListItem, guessTarget, rowsToBooks,
  readingLogThoughts, planImport, findDuplicateGroups, tally, matchesFilter, exportCsv, exportYear, DIMENSIONS, DEFAULT_SETTINGS,
};
