// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits), finds the lines each edit names even when their
// whitespace or indentation drifted, and changes every file or none.
// Node 22, standard library only. Run as: node main.ts [options] [PATCH]
//
// When MAKEFUN_ENV_URL is set this hands the trial over to runner.ts,
// which runs main.ts once per check and posts the results.

import { runTrial } from './runner.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';

// The entry point runs at the end of this file, after every declaration,
// so nothing it uses is still in its temporal dead zone.

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const opts = parseArgs(args);
  if (opts.usageError) return finish(2, ['error: usage']);

  let patchText;
  if (opts.patchArg === null || opts.patchArg === '-') {
    patchText = fs.readFileSync(0, 'utf8');
  } else {
    try {
      patchText = fs.readFileSync(opts.patchArg, 'utf8');
    } catch {
      return finish(2, ['error: no-patch']);
    }
  }

  const lines = splitPatchLines(patchText);
  let fmt = opts.format;
  if (fmt === 'auto') {
    fmt = detectFormat(lines);
    if (fmt === null) return finish(2, ['error: format']);
  }

  let parsed;
  if (fmt === 'unified') parsed = parseUnified(lines);
  else if (fmt === 'search-replace') parsed = parseSearchReplace(lines);
  else if (fmt === 'v4a') parsed = parseV4a(lines);
  else parsed = parseJson(lines, patchText);
  if (parsed.parseError !== undefined) return finish(2, [`error: parse ${parsed.parseError}`]);

  const edits = parsed.edits;
  const tree = new Tree();
  const failures = [];
  const moves = [];
  for (const edit of edits) {
    const bad = applyEdit(tree, edit, opts.strict, moves);
    if (bad) failures.push(bad);
  }

  if (failures.length > 0) {
    const out = failures.map((f) => `error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    return finish(1, out);
  }

  const changed = changeLines(tree, moves);
  const out = changed.slice();
  out.push(`ok: ${changed.length} ${changed.length === 1 ? 'file' : 'files'}`);
  if (!opts.check) writeTree(tree);
  return finish(0, out);
}

function finish(code, lines) {
  const text = lines.length === 0 ? '' : lines.join('\n') + '\n';
  if (text !== '') fs.writeSync(1, text);
  process.exitCode = code;
}

// ---------------------------------------------------------------------------
// Command line (SPEC section 1)
// ---------------------------------------------------------------------------

function parseArgs(args) {
  let format = 'auto';
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  const positional = [];
  let endOpts = false;
  for (const a of args) {
    if (!endOpts && a === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && a !== '-' && a.startsWith('-')) {
      if (a === '--check') {
        if (seenCheck) return { usageError: true };
        seenCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (seenStrict) return { usageError: true };
        seenStrict = true;
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (seenFormat) return { usageError: true };
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') {
          return { usageError: true };
        }
        format = v;
      } else {
        return { usageError: true };
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return { usageError: true };
  return { format, check, strict, patchArg: positional.length === 0 ? null : positional[0] };
}

// ---------------------------------------------------------------------------
// Lines, files and paths (SPEC section 3)
// ---------------------------------------------------------------------------

// A patch's lines: its text split at \n, each with one trailing \r removed,
// without the empty piece after a final \n. An empty text has no lines.
function splitPatchLines(text) {
  if (text === '') return [];
  const parts = text.split('\n');
  const lines = parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

// A file's lines: split at its own line break (CRLF when its first line
// feed follows a carriage return, LF otherwise). It ends with a line break
// when its text ends with that break; an empty file has no lines.
function splitFile(text) {
  if (text === '') return { br: '\n', lines: [], ends: false };
  let br = '\n';
  const i = text.indexOf('\n');
  if (i > 0 && text[i - 1] === '\r') br = '\r\n';
  const ends = text.endsWith(br);
  const parts = text.split(br);
  if (ends) parts.pop();
  return { br, lines: parts, ends };
}

function joinFile(f) {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.ends ? f.br : '');
}

function isSafe(p) {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

// The tree of files, loaded lazily from disk and changed only in memory
// until the end, so a failed run writes nothing.
class Tree {
  constructor() {
    this.map = new Map(); // path -> string content, or null when absent
    this.before = new Map(); // path -> disk content at first touch, or null
  }

  get(p) {
    if (!this.map.has(p)) {
      let content = null;
      try {
        if (fs.statSync(p).isFile()) content = fs.readFileSync(p, 'utf8');
      } catch {
        content = null;
      }
      this.map.set(p, content);
      this.before.set(p, content);
    }
    return this.map.get(p);
  }

  set(p, content) {
    if (!this.map.has(p)) this.get(p);
    this.map.set(p, content);
  }

  // Does something exist at p right now (in memory, else on disk)?
  existsNow(p) {
    if (this.map.has(p)) return this.map.get(p) !== null;
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  }
}

function writeTree(tree) {
  // Deletions first, so a file can make way for a directory and vice versa.
  for (const [p, after] of tree.map) {
    if (after !== null) continue;
    if (tree.before.get(p) === null) continue;
    try {
      fs.unlinkSync(p);
    } catch {
      // already gone
    }
  }
  for (const [p, after] of tree.map) {
    if (after === null) continue;
    if (after === tree.before.get(p)) continue;
    const dir = path.dirname(p);
    if (dir !== '.') fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, after, 'utf8');
  }
}

// ---------------------------------------------------------------------------
// Format detection (SPEC section 4)
// ---------------------------------------------------------------------------

function detectFormat(lines) {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first === -1) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first].trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  for (const l of lines) {
    if (l.replace(/\s+$/, '') === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      return 'unified';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Matching lines (SPEC section 5)
// ---------------------------------------------------------------------------

function stripTrailingWs(s) {
  return s.replace(/[ \t]+$/, '');
}

function stripBothWs(s) {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s) {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function lineEqAt(tier, a, b) {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailingWs(a) === stripTrailingWs(b);
  return stripBothWs(a) === stripBothWs(b);
}

// Positions where O occurs in lines[from..], at one tier.
function occurrencesAt(O, lines, tier, from) {
  const out = [];
  const n = O.length;
  if (n === 0) return out;
  for (let i = from; i + n <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (!lineEqAt(tier, O[j], lines[i + j])) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

// The first tier (0, then 1, then 2; only 0 with --strict) at which O
// occurs at least once at or after `from`.
function findTier(O, lines, strict, from) {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(O, lines, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

// Build the lines that replace a matched block. Context entries are written
// as the file's own matched line, never the patch's. At tier 2 every other
// line is re-indented: its leading spaces/tabs P (from O's first line) are
// replaced by F (from the file's first matched line).
function buildReplacement(entries, O, fileLines, pos, tier) {
  const out = [];
  let F = '';
  let P = '';
  if (tier === 2 && O.length > 0) {
    F = leadingWs(fileLines[pos]);
    P = leadingWs(O[0]);
  }
  for (const e of entries) {
    if (e.isContext) {
      out.push(fileLines[pos + e.oIndex]);
      continue;
    }
    let t = e.text;
    if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(P)) {
      t = F + t.slice(P.length);
    }
    out.push(t);
  }
  return out;
}

// Split an edit's body items into old lines O and new-line entries N.
// items: {type: 'ctx'|'del'|'add', text}. Context entries remember which
// line of O they are.
function splitBody(items) {
  const O = [];
  const entries = [];
  for (const it of items) {
    if (it.type === 'ctx') {
      entries.push({ text: it.text, isContext: true, oIndex: O.length });
      O.push(it.text);
    } else if (it.type === 'del') {
      O.push(it.text);
    } else {
      entries.push({ text: it.text, isContext: false });
    }
  }
  return { O, entries };
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

// A hunk body line is turned into an item; a `\` line marks the item
// before it. Trailing empty lines are not part of the body.
function finalizeHunk(rawBody) {
  const body = rawBody.slice();
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const items = [];
  for (const line of body) {
    if (line.startsWith('\\')) {
      if (items.length > 0) items[items.length - 1].backslashAfter = true;
      continue;
    }
    if (line === '') items.push({ type: 'ctx', text: '' });
    else if (line[0] === ' ') items.push({ type: 'ctx', text: line.slice(1) });
    else if (line[0] === '-') items.push({ type: 'del', text: line.slice(1) });
    else if (line[0] === '+') items.push({ type: 'add', text: line.slice(1) });
  }
  let noEol = false;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].type === 'ctx' || items[i].type === 'add') {
      noEol = !!items[i].backslashAfter;
      break;
    }
  }
  return { a: 0, items, noEol };
}

// The path after `--- ` or `+++ `: text after the four characters, up to
// the first tab, with surrounding spaces removed; a leading a/ or b/
// removed.
function headerPath(line) {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab !== -1) t = t.slice(0, tab);
  t = t.trim();
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function parseUnified(lines) {
  const sections = [];
  const n = lines.length;
  let cur = null;
  let inHeader = false;
  let inBody = false;
  let curHunk = null;

  function startSection(diffOld, diffNew) {
    if (cur) sections.push(cur);
    cur = {
      diffOld,
      diffNew,
      pairOld: null,
      pairNew: null,
      renameOld: null,
      renameNew: null,
      creation: false,
      deletion: false,
      hunks: [],
    };
    inHeader = true;
    inBody = false;
    curHunk = null;
  }

  function endHunk() {
    if (curHunk) {
      const h = finalizeHunk(curHunk.rawBody);
      h.a = curHunk.a;
      cur.hunks.push(h);
      curHunk = null;
    }
    inBody = false;
  }

  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (inBody) {
      if (line.startsWith('diff --git ')) {
        endHunk();
      } else if (line.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
        endHunk();
      } else if (line.startsWith('@@')) {
        endHunk();
      } else if (
        line === '' ||
        line[0] === ' ' ||
        line[0] === '-' ||
        line[0] === '+' ||
        line[0] === '\\'
      ) {
        curHunk.rawBody.push(line);
        i++;
        continue;
      } else {
        endHunk();
      }
      // The line ended the body; handle it again below without advancing.
    }

    if (line.startsWith('diff --git')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!m) return { parseError: i + 1 };
      startSection(m[1], m[2]);
      i++;
      continue;
    }

    if (line.startsWith('--- ')) {
      if (i + 1 < n && lines[i + 1].startsWith('+++ ')) {
        // A pair is part of this section's header only while the header
        // has no pair yet; a later pair starts a new section.
        if (inHeader && cur && cur.pairOld === null) {
          cur.pairOld = headerPath(lines[i]);
          cur.pairNew = headerPath(lines[i + 1]);
        } else {
          startSection(null, null);
          cur.pairOld = headerPath(lines[i]);
          cur.pairNew = headerPath(lines[i + 1]);
        }
        i += 2;
        continue;
      }
      if (inHeader) return { parseError: i + 2 };
      i++;
      continue;
    }

    if (line.startsWith('@@')) {
      if (!cur) return { parseError: i + 1 };
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (!m) return { parseError: i + 1 };
      curHunk = { a: parseInt(m[1], 10), rawBody: [] };
      inHeader = false;
      inBody = true;
      i++;
      continue;
    }

    if (inHeader && cur) {
      if (line.startsWith('rename from ')) {
        cur.renameOld = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        cur.renameNew = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        cur.creation = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.deletion = true;
      }
      i++;
      continue;
    }

    i++;
  }
  endHunk();
  if (cur) sections.push(cur);
  if (sections.length === 0) return { parseError: 1 };

  const edits = sections.map((s) => {
    const oldPath = s.pairOld !== null ? s.pairOld : s.renameOld !== null ? s.renameOld : s.diffOld;
    const newPath = s.pairNew !== null ? s.pairNew : s.renameNew !== null ? s.renameNew : s.diffNew;
    const creation = s.creation || oldPath === '/dev/null';
    const deletion = !creation && (s.deletion || newPath === '/dev/null');
    return { kind: 'unified', oldPath, newPath, creation, deletion, hunks: s.hunks };
  });
  return { edits };
}

// Apply a section's hunks in order to a working copy of a file.
// Returns true when a hunk fails (no-match).
function applyHunks(f, hunks, strict) {
  let d = 0;
  for (const h of hunks) {
    const { O, entries } = splitBody(h.items);
    if (O.length === 0) {
      let at = h.a + d;
      if (at < 0) at = 0;
      const oldLen = f.lines.length;
      if (at > oldLen) at = oldLen;
      const rep = entries.map((e) => e.text);
      f.lines = f.lines.slice(0, at).concat(rep, f.lines.slice(at));
      if (rep.length > 0 && at === oldLen) f.ends = !h.noEol;
      d += rep.length;
      continue;
    }
    const found = findTier(O, f.lines, strict, 0);
    if (!found) return true;
    const target = h.a - 1 + d;
    let pos = found.occ[0];
    let best = Math.abs(pos - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        best = dist;
        pos = p;
      }
    }
    const rep = buildReplacement(entries, O, f.lines, pos, found.tier);
    const oldLen = f.lines.length;
    f.lines = f.lines.slice(0, pos).concat(rep, f.lines.slice(pos + O.length));
    if (pos + O.length === oldLen) f.ends = !h.noEol;
    d += rep.length - O.length;
  }
  return false;
}

function applyUnified(tree, sec, strict, moves) {
  if (sec.creation) {
    const np = sec.newPath;
    if (!isSafe(np)) return { code: 'unsafe', path: np };
    if (tree.existsNow(np)) return { code: 'exists', path: np };
    const outLines = [];
    let lastAdd = null;
    for (const h of sec.hunks) {
      for (const it of h.items) {
        if (it.type === 'add') {
          outLines.push(it.text);
          lastAdd = it;
        }
      }
    }
    const noEol = lastAdd ? !!lastAdd.backslashAfter : false;
    const text = outLines.length === 0 ? '' : outLines.join('\n') + (noEol ? '' : '\n');
    tree.set(np, text);
    return null;
  }

  if (sec.deletion) {
    const op = sec.oldPath;
    if (!isSafe(op)) return { code: 'unsafe', path: op };
    if (tree.get(op) === null) return { code: 'missing', path: op };
    tree.set(op, null);
    return null;
  }

  if (sec.oldPath !== sec.newPath) {
    const op = sec.oldPath;
    const np = sec.newPath;
    if (!isSafe(op)) return { code: 'unsafe', path: op };
    if (!isSafe(np)) return { code: 'unsafe', path: np };
    const content = tree.get(op);
    if (content === null) return { code: 'missing', path: op };
    if (tree.existsNow(np)) return { code: 'exists', path: np };
    const f = splitFile(content);
    if (applyHunks(f, sec.hunks, strict)) return { code: 'no-match', path: op };
    tree.set(np, joinFile(f));
    tree.set(op, null);
    moves.push({ old: op, new: np });
    return null;
  }

  const p = sec.oldPath;
  if (!isSafe(p)) return { code: 'unsafe', path: p };
  const content = tree.get(p);
  if (content === null) return { code: 'missing', path: p };
  const f = splitFile(content);
  if (applyHunks(f, sec.hunks, strict)) return { code: 'no-match', path: p };
  tree.set(p, joinFile(f));
  return null;
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

function isSearchMarker(line) {
  return line.replace(/\s+$/, '') === '<<<<<<< SEARCH';
}

function isSeparator(line) {
  return line.replace(/\s+$/, '') === '=======';
}

function isReplaceMarker(line) {
  return line.replace(/\s+$/, '') === '>>>>>>> REPLACE';
}

function parseSearchReplace(lines) {
  const blocks = [];
  const n = lines.length;
  let prevEnd = -1;
  let prevPath = null;
  while (true) {
    let s = -1;
    for (let j = prevEnd + 1; j < n; j++) {
      if (isSearchMarker(lines[j])) {
        s = j;
        break;
      }
    }
    if (s === -1) break;

    let p = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      p = t;
      break;
    }
    if (p === null) {
      if (prevPath === null) return { parseError: s + 1 };
      p = prevPath;
    }

    let m = -1;
    for (let j = s + 1; j < n; j++) {
      if (isSeparator(lines[j])) {
        m = j;
        break;
      }
    }
    if (m === -1) return { parseError: s + 1 };
    let r = -1;
    for (let j = m + 1; j < n; j++) {
      if (isReplaceMarker(lines[j])) {
        r = j;
        break;
      }
    }
    if (r === -1) return { parseError: s + 1 };

    blocks.push({
      kind: 'sr',
      path: p,
      oldLines: lines.slice(s + 1, m),
      newLines: lines.slice(m + 1, r),
    });
    prevPath = p;
    prevEnd = r;
  }
  if (blocks.length === 0) return { parseError: 1 };
  return { edits: blocks };
}

function applySearchReplace(tree, block, strict) {
  const p = block.path;
  if (!isSafe(p)) return { code: 'unsafe', path: p };
  if (block.oldLines.length === 0) {
    if (tree.existsNow(p)) return { code: 'exists', path: p };
    const text = block.newLines.length === 0 ? '' : block.newLines.join('\n') + '\n';
    tree.set(p, text);
    return null;
  }
  const content = tree.get(p);
  if (content === null) return { code: 'missing', path: p };
  const f = splitFile(content);
  const found = findTier(block.oldLines, f.lines, strict, 0);
  if (!found) return { code: 'no-match', path: p };
  if (found.occ.length > 1) return { code: 'ambiguous', path: p };
  const pos = found.occ[0];
  const entries = block.newLines.map((t) => ({ text: t, isContext: false }));
  const rep = buildReplacement(entries, block.oldLines, f.lines, pos, found.tier);
  f.lines = f.lines.slice(0, pos).concat(rep, f.lines.slice(pos + block.oldLines.length));
  tree.set(p, joinFile(f));
  return null;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

const V4A_SECTION_RE = /^\*\*\* (Add File|Delete File|Update File): (.*)$/;

function parseV4a(lines) {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first === -1) return { parseError: 1 };
  if (lines[first].trim() !== '*** Begin Patch') return { parseError: first + 1 };
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') return { parseError: lines.length + 1 };

  const edits = [];
  let i = first + 1;
  while (i < last) {
    if (lines[i].trim() === '') {
      i++;
      continue;
    }
    const m = V4A_SECTION_RE.exec(lines[i]);
    if (!m) return { parseError: i + 1 };
    const kind = m[1];
    const p = m[2].trim();

    let j = i + 1;
    while (j < last && !V4A_SECTION_RE.test(lines[j])) j++;
    const raw = [];
    for (let k = i + 1; k < j; k++) raw.push({ text: lines[k], num: k + 1 });
    while (raw.length > 0 && raw[raw.length - 1].text.trim() === '') raw.pop();

    if (kind === 'Add File') {
      const fileLines = [];
      for (const r of raw) {
        if (r.text === '') fileLines.push('');
        else if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else return { parseError: r.num };
      }
      edits.push({ kind: 'v4a-add', path: p, fileLines });
    } else if (kind === 'Delete File') {
      if (raw.length > 0) return { parseError: raw[0].num };
      edits.push({ kind: 'v4a-delete', path: p });
    } else {
      let moveTo = null;
      let k = 0;
      if (raw.length > 0 && raw[0].text.startsWith('*** Move to: ')) {
        moveTo = raw[0].text.slice('*** Move to: '.length).trim();
        k = 1;
      }
      const chunks = [];
      let cur = null;
      let afterEof = false;
      for (; k < raw.length; k++) {
        const r = raw[k];
        const t = r.text;
        if (t.startsWith('@@')) {
          if (cur) chunks.push(cur);
          cur = { anchor: t.slice(2).trim(), hasAnchor: true, eof: false, body: [] };
          afterEof = false;
        } else if (t === '*** End of File') {
          if (!cur) return { parseError: r.num };
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          afterEof = true;
        } else if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (afterEof) {
            if (t === '') continue;
            return { parseError: r.num };
          }
          if (!cur) {
            if (chunks.length > 0) return { parseError: r.num };
            cur = { anchor: null, hasAnchor: false, eof: false, body: [] };
          }
          const type = t === '' || t[0] === ' ' ? 'ctx' : t[0] === '-' ? 'del' : 'add';
          cur.body.push({ type, text: t === '' ? '' : t.slice(1) });
        } else {
          return { parseError: r.num };
        }
      }
      if (cur) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) return { parseError: i + 1 };
      edits.push({ kind: 'v4a-update', path: p, moveTo, chunks });
    }
    i = j;
  }
  if (edits.length === 0) return { parseError: 1 };
  return { edits };
}

function applyV4a(tree, edit, strict, moves) {
  if (edit.kind === 'v4a-add') {
    if (!isSafe(edit.path)) return { code: 'unsafe', path: edit.path };
    if (tree.existsNow(edit.path)) return { code: 'exists', path: edit.path };
    const text =
      edit.fileLines.length === 0 ? '' : edit.fileLines.join('\n') + '\n';
    tree.set(edit.path, text);
    return null;
  }

  if (edit.kind === 'v4a-delete') {
    if (!isSafe(edit.path)) return { code: 'unsafe', path: edit.path };
    if (tree.get(edit.path) === null) return { code: 'missing', path: edit.path };
    tree.set(edit.path, null);
    return null;
  }

  // Update File, with or without a move.
  const p = edit.path;
  if (!isSafe(p)) return { code: 'unsafe', path: p };
  if (edit.moveTo !== null && !isSafe(edit.moveTo)) return { code: 'unsafe', path: edit.moveTo };
  const content = tree.get(p);
  if (content === null) return { code: 'missing', path: p };
  if (edit.moveTo !== null && tree.existsNow(edit.moveTo)) {
    return { code: 'exists', path: edit.moveTo };
  }

  const f = splitFile(content);
  let cursor = 0;
  for (const ch of edit.chunks) {
    if (ch.hasAnchor && ch.anchor !== '') {
      const aFound = findTier([ch.anchor], f.lines, strict, cursor);
      if (!aFound) return { code: 'no-match', path: p };
      cursor = aFound.occ[0] + 1;
    }
    const { O, entries } = splitBody(ch.body);
    if (O.length === 0) {
      const at = ch.eof ? f.lines.length : cursor;
      const rep = entries.map((e) => e.text);
      f.lines = f.lines.slice(0, at).concat(rep, f.lines.slice(at));
      cursor = at + rep.length;
      continue;
    }
    const found = findTier(O, f.lines, strict, cursor);
    if (!found) return { code: 'no-match', path: p };
    let pos;
    if (ch.eof) {
      const endPos = f.lines.length - O.length;
      if (endPos < cursor || !found.occ.includes(endPos)) {
        return { code: 'no-match', path: p };
      }
      pos = endPos;
    } else {
      pos = found.occ[0];
    }
    const rep = buildReplacement(entries, O, f.lines, pos, found.tier);
    f.lines = f.lines.slice(0, pos).concat(rep, f.lines.slice(pos + O.length));
    cursor = pos + rep.length;
  }

  const text = joinFile(f);
  if (edit.moveTo !== null) {
    tree.set(edit.moveTo, text);
    tree.set(p, null);
    moves.push({ old: p, new: edit.moveTo });
  } else {
    tree.set(p, text);
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------

function validateJsonEdit(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.path !== 'string') return null;
  if (obj.command === 'create') {
    if (typeof obj.file_text !== 'string') return null;
    return { kind: 'json-create', path: obj.path, file_text: obj.file_text };
  }
  if (obj.command === 'str_replace') {
    if (typeof obj.old_str !== 'string' || obj.old_str === '') return null;
    const newStr = obj.new_str === undefined ? '' : obj.new_str;
    if (typeof newStr !== 'string') return null;
    return { kind: 'json-str', path: obj.path, old_str: obj.old_str, new_str: newStr };
  }
  if (obj.command === 'insert') {
    if (!Number.isInteger(obj.insert_line)) return null;
    if (typeof obj.new_str !== 'string') return null;
    return { kind: 'json-insert', path: obj.path, insert_line: obj.insert_line, new_str: obj.new_str };
  }
  return null;
}

function parseJson(lines, patchText) {
  let idx = 0;
  while (idx < patchText.length && /\s/.test(patchText[idx])) idx++;
  if (idx >= patchText.length) return { parseError: 1 };
  const firstLine = patchText.slice(0, idx).split('\n').length;
  if (patchText[idx] === '[') {
    let arr;
    try {
      arr = JSON.parse(patchText);
    } catch {
      return { parseError: firstLine };
    }
    if (!Array.isArray(arr)) return { parseError: firstLine };
    const edits = [];
    for (const el of arr) {
      const e = validateJsonEdit(el);
      if (!e) return { parseError: firstLine };
      edits.push(e);
    }
    if (edits.length === 0) return { parseError: 1 };
    return { edits };
  }
  const edits = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      return { parseError: i + 1 };
    }
    const e = validateJsonEdit(obj);
    if (!e) return { parseError: i + 1 };
    edits.push(e);
  }
  if (edits.length === 0) return { parseError: 1 };
  return { edits };
}

// Count overlapping occurrences of needle in haystack (stops after two).
function countOccurrences(haystack, needle) {
  let count = 0;
  let first = -1;
  let from = 0;
  while (true) {
    const k = haystack.indexOf(needle, from);
    if (k === -1) break;
    if (first === -1) first = k;
    count++;
    if (count > 1) break;
    from = k + 1;
  }
  return { count, first };
}

function applyJson(tree, edit) {
  if (edit.kind === 'json-create') {
    if (!isSafe(edit.path)) return { code: 'unsafe', path: edit.path };
    if (tree.existsNow(edit.path)) return { code: 'exists', path: edit.path };
    tree.set(edit.path, edit.file_text);
    return null;
  }

  if (edit.kind === 'json-str') {
    if (!isSafe(edit.path)) return { code: 'unsafe', path: edit.path };
    const content = tree.get(edit.path);
    if (content === null) return { code: 'missing', path: edit.path };
    const crlf = splitFile(content).br === '\r\n';
    const normText = crlf ? content.split('\r\n').join('\n') : content;
    const normOld = crlf ? edit.old_str.split('\r\n').join('\n') : edit.old_str;
    const normNew = crlf ? edit.new_str.split('\r\n').join('\n') : edit.new_str;
    const { count, first } = countOccurrences(normText, normOld);
    if (count === 0) return { code: 'no-match', path: edit.path };
    if (count > 1) return { code: 'ambiguous', path: edit.path };
    let result = normText.slice(0, first) + normNew + normText.slice(first + normOld.length);
    if (crlf) result = result.split('\n').join('\r\n');
    tree.set(edit.path, result);
    return null;
  }

  // json-insert
  if (!isSafe(edit.path)) return { code: 'unsafe', path: edit.path };
  const content = tree.get(edit.path);
  if (content === null) return { code: 'missing', path: edit.path };
  const f = splitFile(content);
  if (edit.insert_line < 0 || edit.insert_line > f.lines.length) {
    return { code: 'no-match', path: edit.path };
  }
  const newLines = splitPatchLines(edit.new_str);
  f.lines = f.lines
    .slice(0, edit.insert_line)
    .concat(newLines, f.lines.slice(edit.insert_line));
  tree.set(edit.path, joinFile(f));
  return null;
}

// ---------------------------------------------------------------------------
// Applying edits, and reporting what changed (SPEC sections 2 and 10)
// ---------------------------------------------------------------------------

function applyEdit(tree, edit, strict, moves) {
  if (edit.kind === 'unified') return applyUnified(tree, edit, strict, moves);
  if (edit.kind === 'sr') return applySearchReplace(tree, edit, strict);
  if (edit.kind === 'v4a-add' || edit.kind === 'v4a-delete' || edit.kind === 'v4a-update') {
    return applyV4a(tree, edit, strict, moves);
  }
  return applyJson(tree, edit);
}

function byteCompare(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// One line per path whose state changed, in byte order of the paths. A
// successful move is one R line (sorted by its new path) instead of the
// pair's D and A lines.
function changeLines(tree, moves) {
  const lines = [];
  const coveredOld = new Set();
  const coveredNew = new Set();
  for (const m of moves) {
    const beforeOld = tree.before.has(m.old) ? tree.before.get(m.old) : null;
    const afterOld = tree.map.has(m.old) ? tree.map.get(m.old) : null;
    const beforeNew = tree.before.has(m.new) ? tree.before.get(m.new) : null;
    const afterNew = tree.map.has(m.new) ? tree.map.get(m.new) : null;
    if (beforeOld !== null && afterOld === null && beforeNew === null && afterNew !== null) {
      lines.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
      coveredOld.add(m.old);
      coveredNew.add(m.new);
    }
  }
  const paths = new Set([...tree.before.keys(), ...tree.map.keys()]);
  for (const p of paths) {
    if (coveredOld.has(p) || coveredNew.has(p)) continue;
    const b = tree.before.has(p) ? tree.before.get(p) : null;
    const a = tree.map.has(p) ? tree.map.get(p) : null;
    if (b === null && a !== null) lines.push({ key: p, text: `A ${p}` });
    else if (b !== null && a === null) lines.push({ key: p, text: `D ${p}` });
    else if (b !== null && a !== null && b !== a) lines.push({ key: p, text: `M ${p}` });
  }
  lines.sort((x, y) => byteCompare(x.key, y.key));
  return lines.map((l) => l.text);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

if (process.env.MAKEFUN_ENV_URL) {
  await runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  main();
}
