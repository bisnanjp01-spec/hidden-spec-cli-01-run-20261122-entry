// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Node 22 standard library only. Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// When MAKEFUN_ENV_URL is set, main.ts hands the trial over to runner.ts (see the dispatch at the end).

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { runTrial } from './runner.ts';

type Br = '\n' | '\r\n';

interface FileState {
  lines: string[];
  br: Br;
  eol: boolean;
}

interface Tree {
  cur: Map<string, FileState | null>;
  orig: Map<string, FileState | null>;
  dirs: Set<string>;
}

function newTree(): Tree {
  return { cur: new Map(), orig: new Map(), dirs: new Set() };
}

// ---- file text model (SPEC section 3) ----

function parseText(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', eol: false };
  const firstNl = text.indexOf('\n');
  let br: Br = '\n';
  if (firstNl > 0 && text[firstNl - 1] === '\r') br = '\r\n';
  const parts = text.split(br);
  let eol = false;
  if (text.endsWith(br)) {
    eol = true;
    parts.pop();
  }
  return { lines: parts, br, eol };
}

function serialize(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.eol ? f.br : '');
}

// Patch lines (SPEC section 3): split at \n, one trailing \r removed, no empty piece after a final \n.
function splitPatchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

// ---- paths (SPEC section 3) ----

function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

function cmpBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ---- line matching (SPEC section 5) ----

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function trimEndWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimBothWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function lineEqAtTier(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

function findOccurrences(fileLines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEqAtTier(o[j], fileLines[i + j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

// First tier (0, 1, 2; only 0 when strict) with at least one occurrence at or after `from`; -1 when none.
function findTier(fileLines: string[], o: string[], from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    if (findOccurrences(fileLines, o, t, from).length > 0) return t;
  }
  return -1;
}

interface NLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

// Build the replacement lines for N: context lines come from the file's own matched lines;
// at tier 2 every other line is re-indented (P -> F); at tiers 0 and 1 lines are written as they are.
function buildReplacement(n: NLine[], oTexts: string[], fileLines: string[], pos: number, tier: number): string[] {
  if (tier !== 2) {
    return n.map((x) => (x.ctx ? fileLines[pos + x.oIdx] : x.text));
  }
  const f = leadingWs(fileLines[pos]);
  const p = leadingWs(oTexts[0]);
  return n.map((x) => {
    if (x.ctx) return fileLines[pos + x.oIdx];
    const t = x.text;
    if (t === '' || /^[ \t]+$/.test(t)) return t;
    if (t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
}

// ---- the working tree ----

function loadDisk(path: string): FileState | 'dir' | null {
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  if (!st.isFile()) return 'dir';
  try {
    return parseText(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// Record a path's pre-patch state on first touch.
function touch(tree: Tree, path: string): void {
  if (tree.cur.has(path)) return;
  const loaded = loadDisk(path);
  if (loaded === 'dir') {
    tree.cur.set(path, null);
    tree.dirs.add(path);
    if (!tree.orig.has(path)) tree.orig.set(path, null);
  } else {
    tree.cur.set(path, loaded);
    if (!tree.orig.has(path)) tree.orig.set(path, loaded);
  }
}

function fileExists(tree: Tree, path: string): boolean {
  if (tree.cur.has(path)) {
    if (tree.cur.get(path) !== null) return true;
    return tree.dirs.has(path);
  }
  return existsSync(path);
}

function getFile(tree: Tree, path: string): FileState | null {
  touch(tree, path);
  const v = tree.cur.get(path);
  return v === undefined ? null : v;
}

function setFile(tree: Tree, path: string, state: FileState | null): void {
  touch(tree, path);
  tree.cur.set(path, state);
  if (state !== null) tree.dirs.delete(path);
}

function writeStdout(lines: string[]): void {
  const out = lines.length === 0 ? '' : lines.join('\n') + '\n';
  if (out !== '') writeSync(1, out);
}

function exit2(line: string): number {
  writeStdout([line]);
  return 2;
}

// ---- edits ----

interface HunkBodyItem {
  t: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

interface Hunk {
  a: number;
  body: HunkBodyItem[];
}

interface VChunkBodyItem {
  t: 'ctx' | 'old' | 'new';
  text: string;
}

interface VChunk {
  anchor: string | null;
  body: VChunkBodyItem[];
  eof: boolean;
}

type Edit =
  | { kind: 'unified'; oldPath: string | null; newPath: string | null; mode: 'create' | 'delete' | 'move' | 'change'; hunks: Hunk[] }
  | { kind: 'sr'; path: string; oldLines: string[]; newLines: string[] }
  | { kind: 'v4a-add'; path: string; lines: string[] }
  | { kind: 'v4a-del'; path: string }
  | { kind: 'v4a-update'; path: string; newPath: string | null; chunks: VChunk[] }
  | { kind: 'json-create'; path: string; text: string }
  | { kind: 'json-str'; path: string; oldStr: string; newStr: string }
  | { kind: 'json-insert'; path: string; line: number; newStr: string };

interface EditFailure {
  code: string;
  path: string;
}

interface MoveRec {
  old: string;
  new: string;
}

// ---- format detection (SPEC section 4) ----

function detectFormat(lines: string[]): 'v4a' | 'json' | 'search-replace' | 'unified' | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first].trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].replace(/[ \t]+$/, '') === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---- change list and disk write (SPEC sections 2 and 10) ----

function computeChanges(tree: Tree, moves: MoveRec[]): string[] {
  const deleted = new Set<string>();
  const added = new Set<string>();
  const modified = new Set<string>();
  for (const [path, orig] of tree.orig) {
    const cur = tree.cur.get(path);
    const origExists = orig !== null && orig !== undefined;
    const curExists = cur !== null && cur !== undefined;
    if (origExists && !curExists) deleted.add(path);
    else if (!origExists && curExists) added.add(path);
    else if (origExists && curExists && serialize(orig) !== serialize(cur)) modified.add(path);
  }
  for (const [path, cur] of tree.cur) {
    if (!tree.orig.has(path) && cur !== null && cur !== undefined) added.add(path);
  }
  const out: { key: string; line: string }[] = [];
  for (const m of moves) {
    if (deleted.has(m.old) && added.has(m.new)) {
      out.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
      deleted.delete(m.old);
      added.delete(m.new);
    }
  }
  for (const p of deleted) out.push({ key: p, line: `D ${p}` });
  for (const p of added) out.push({ key: p, line: `A ${p}` });
  for (const p of modified) out.push({ key: p, line: `M ${p}` });
  out.sort((a, b) => cmpBytes(a.key, b.key));
  return out.map((x) => x.line);
}

function writeChanges(tree: Tree): void {
  for (const [path, cur] of tree.cur) {
    const orig = tree.orig.get(path);
    if (cur === null || cur === undefined) {
      if (orig !== null && orig !== undefined) {
        try {
          rmSync(path, { force: true });
        } catch {
          // a path that cannot be removed stays; the check compares files, not errors
        }
      }
    } else {
      const text = serialize(cur);
      let disk: string | null = null;
      try {
        disk = readFileSync(path, 'utf8');
      } catch {
        disk = null;
      }
      if (disk !== text) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text, 'utf8');
      }
    }
  }
}

// ---- main flow (SPEC sections 1, 2 and 10) ----

function runCli(): number {
  const args = process.argv.slice(2);
  let format: string | null = null;
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let endOpts = false;
  const positional: string[] = [];
  for (const a of args) {
    if (endOpts) {
      positional.push(a);
      continue;
    }
    if (a === '--') {
      endOpts = true;
      continue;
    }
    if (a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (seenFormat) return exit2('error: usage');
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') return exit2('error: usage');
        format = v;
        continue;
      }
      if (a === '--check') {
        if (seenCheck) return exit2('error: usage');
        seenCheck = true;
        check = true;
        continue;
      }
      if (a === '--strict') {
        if (seenStrict) return exit2('error: usage');
        seenStrict = true;
        strict = true;
        continue;
      }
      return exit2('error: usage');
    }
    positional.push(a);
  }
  if (positional.length > 1) return exit2('error: usage');
  const patchArg = positional.length === 1 ? positional[0] : null;
  let patchText: string;
  if (patchArg === null || patchArg === '-') {
    try {
      patchText = readFileSync(0, 'utf8');
    } catch {
      patchText = '';
    }
  } else {
    try {
      patchText = readFileSync(patchArg, 'utf8');
    } catch {
      return exit2('error: no-patch');
    }
  }
  const patchLines = splitPatchLines(patchText);
  let fmt = format;
  if (fmt === null || fmt === 'auto') {
    const d = detectFormat(patchLines);
    if (d === null) return exit2('error: format');
    fmt = d;
  }
  let parsed: { edits: Edit[] } | { parseErr: number };
  if (fmt === 'unified') parsed = parseUnified(patchLines);
  else if (fmt === 'search-replace') parsed = parseSR(patchLines);
  else if (fmt === 'v4a') parsed = parseV4A(patchLines);
  else parsed = parseJson(patchLines, patchText);
  if ('parseErr' in parsed) return exit2(`error: parse ${parsed.parseErr}`);
  const tree = newTree();
  const failures: EditFailure[] = [];
  const moves: MoveRec[] = [];
  for (const e of parsed.edits) {
    const f = applyEdit(tree, e, strict, moves);
    if (f !== null) failures.push(f);
  }
  if (failures.length > 0) {
    const out: string[] = [];
    for (const f of failures) out.push(`error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${parsed.edits.length} edits`);
    writeStdout(out);
    return 1;
  }
  const changeLines = computeChanges(tree, moves);
  if (!check) writeChanges(tree);
  const n = changeLines.length;
  const out = [...changeLines, n === 1 ? 'ok: 1 file' : `ok: ${n} files`];
  writeStdout(out);
  return 0;
}

// ---- unified diffs (SPEC section 6) ----

function parseDiffPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab !== -1) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

interface UnifiedSection {
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
  inHeader: boolean;
}

function parseUnified(lines: string[]): { edits: Edit[] } | { parseErr: number } {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  const n = lines.length;
  const startSection = (): UnifiedSection => {
    const s: UnifiedSection = {
      pairOld: null, pairNew: null, renameOld: null, renameNew: null,
      diffOld: null, diffNew: null, newFile: false, delFile: false, hunks: [], inHeader: true,
    };
    sections.push(s);
    cur = s;
    return s;
  };
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const m = /^diff --git a\/([^ ]+) b\/([^ ]+)$/.exec(line);
      if (!m) return { parseErr: i + 1 };
      const s = startSection();
      s.diffOld = m[1];
      s.diffNew = m[2];
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
      let s = cur;
      if (s === null) s = startSection();
      if (s.inHeader) {
        s.pairOld = parseDiffPath(line);
        s.pairNew = parseDiffPath(lines[i + 1]);
      } else {
        s = startSection();
        s.pairOld = parseDiffPath(line);
        s.pairNew = parseDiffPath(lines[i + 1]);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && cur.inHeader) return { parseErr: i + 2 };
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) return { parseErr: i + 1 };
      const s = cur;
      if (s === null) return { parseErr: i + 1 };
      const hunk: Hunk = { a: parseInt(m[1], 10), body: [] };
      s.hunks.push(hunk);
      s.inHeader = false;
      i++;
      while (i < n) {
        const bl = lines[i];
        if (bl.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) break;
        if (bl === '') {
          hunk.body.push({ t: 'ctx', text: '' });
          i++;
          continue;
        }
        if (bl.startsWith(' ')) {
          hunk.body.push({ t: 'ctx', text: bl.slice(1) });
          i++;
          continue;
        }
        if (bl.startsWith('-')) {
          hunk.body.push({ t: 'old', text: bl.slice(1) });
          i++;
          continue;
        }
        if (bl.startsWith('+')) {
          hunk.body.push({ t: 'new', text: bl.slice(1) });
          i++;
          continue;
        }
        if (bl.startsWith('\\')) {
          hunk.body.push({ t: 'bs', text: '' });
          i++;
          continue;
        }
        break;
      }
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1];
        if (last.t === 'ctx' && last.text === '') hunk.body.pop();
        else break;
      }
      continue;
    }
    const s = cur;
    if (s !== null && s.inHeader) {
      if (line.startsWith('rename from ')) {
        s.renameOld = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        s.renameNew = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        s.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        s.delFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  const edits: Edit[] = [];
  for (const s of sections) {
    const oldP = s.pairOld ?? s.renameOld ?? s.diffOld;
    const newP = s.pairNew ?? s.renameNew ?? s.diffNew;
    const oldPath = oldP === '/dev/null' ? null : oldP;
    const newPath = newP === '/dev/null' ? null : newP;
    let mode: 'create' | 'delete' | 'move' | 'change';
    if (oldPath === null || s.newFile) mode = 'create';
    else if (newPath === null || s.delFile) mode = 'delete';
    else if (oldPath !== newPath) mode = 'move';
    else mode = 'change';
    edits.push({ kind: 'unified', oldPath, newPath, mode, hunks: s.hunks });
  }
  if (edits.length === 0) return { parseErr: 1 };
  return { edits };
}

function hunkON(h: Hunk): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const it of h.body) {
    if (it.t === 'ctx') {
      o.push(it.text);
      n.push({ text: it.text, ctx: true, oIdx: o.length - 1 });
    } else if (it.t === 'old') {
      o.push(it.text);
    } else if (it.t === 'new') {
      n.push({ text: it.text, ctx: false, oIdx: -1 });
    }
  }
  return { o, n };
}

function bsAfterLastCtxNew(h: Hunk): boolean {
  let last = -1;
  for (let i = 0; i < h.body.length; i++) {
    if (h.body[i].t === 'ctx' || h.body[i].t === 'new') last = i;
  }
  if (last === -1) return false;
  const nx = h.body[last + 1];
  return nx !== undefined && nx.t === 'bs';
}

function bsAfterLastNew(hunks: Hunk[]): boolean {
  for (let hi = hunks.length - 1; hi >= 0; hi--) {
    const h = hunks[hi];
    let last = -1;
    for (let i = 0; i < h.body.length; i++) {
      if (h.body[i].t === 'new') last = i;
    }
    if (last !== -1) {
      const nx = h.body[last + 1];
      return nx !== undefined && nx.t === 'bs';
    }
  }
  return false;
}

function applyHunk(
  lines: string[],
  eol: boolean,
  h: Hunk,
  on: { o: string[]; n: NLine[] },
  d: number,
  strict: boolean,
): { lines: string[]; eol: boolean } | { code: string } {
  const o = on.o;
  const n = on.n;
  if (o.length === 0) {
    let idx = h.a + d;
    if (idx < 0) idx = 0;
    if (idx > lines.length) idx = lines.length;
    const inserted = n.map((x) => x.text);
    const out = [...lines.slice(0, idx), ...inserted, ...lines.slice(idx)];
    let newEol = eol;
    if (idx === lines.length) newEol = !bsAfterLastCtxNew(h);
    return { lines: out, eol: newEol };
  }
  const tier = findTier(lines, o, 0, strict);
  if (tier === -1) return { code: 'no-match' };
  const occs = findOccurrences(lines, o, tier, 0);
  const target = h.a - 1 + d;
  let best = occs[0];
  let bestDist = Math.abs(occs[0] - target);
  for (const p of occs) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const rep = buildReplacement(n, o, lines, best, tier);
  const out = [...lines.slice(0, best), ...rep, ...lines.slice(best + o.length)];
  let newEol = eol;
  if (best + o.length === lines.length) newEol = !bsAfterLastCtxNew(h);
  return { lines: out, eol: newEol };
}

function applyUnified(
  tree: Tree,
  e: Extract<Edit, { kind: 'unified' }>,
  strict: boolean,
  moves: MoveRec[],
): EditFailure | null {
  if (e.mode === 'create') {
    const p = e.newPath === null ? '/dev/null' : e.newPath;
    touch(tree, p);
    if (!isSafePath(p)) return { code: 'unsafe', path: p };
    if (fileExists(tree, p)) return { code: 'exists', path: p };
    const plus: string[] = [];
    for (const h of e.hunks) {
      for (const it of h.body) {
        if (it.t === 'new') plus.push(it.text);
      }
    }
    const eol = plus.length === 0 ? false : !bsAfterLastNew(e.hunks);
    setFile(tree, p, { lines: plus, br: '\n', eol });
    return null;
  }
  if (e.mode === 'delete') {
    const p = e.oldPath === null ? '/dev/null' : e.oldPath;
    touch(tree, p);
    if (!isSafePath(p)) return { code: 'unsafe', path: p };
    if (!fileExists(tree, p)) return { code: 'missing', path: p };
    setFile(tree, p, null);
    return null;
  }
  const op = e.oldPath === null ? '/dev/null' : e.oldPath;
  const np = e.newPath === null ? '/dev/null' : e.newPath;
  touch(tree, op);
  touch(tree, np);
  if (!isSafePath(op)) return { code: 'unsafe', path: op };
  if (e.mode === 'move' && !isSafePath(np)) return { code: 'unsafe', path: np };
  const f = getFile(tree, op);
  if (f === null) return { code: 'missing', path: op };
  if (e.mode === 'move' && fileExists(tree, np)) return { code: 'exists', path: np };
  let lines = f.lines;
  let eol = f.eol;
  let d = 0;
  for (const h of e.hunks) {
    const on = hunkON(h);
    const r = applyHunk(lines, eol, h, on, d, strict);
    if ('code' in r) return { code: r.code, path: op };
    d += on.n.length - on.o.length;
    lines = r.lines;
    eol = r.eol;
  }
  const ns: FileState = { lines, br: f.br, eol };
  if (e.mode === 'move') {
    setFile(tree, op, null);
    setFile(tree, np, ns);
    moves.push({ old: op, new: np });
  } else {
    setFile(tree, op, ns);
  }
  return null;
}

// ---- SEARCH/REPLACE (SPEC section 7) ----

function parseSR(lines: string[]): { edits: Edit[] } | { parseErr: number } {
  const edits: Edit[] = [];
  let i = 0;
  const n = lines.length;
  let prevPath: string | null = null;
  while (i < n) {
    if (lines[i].replace(/[ \t]+$/, '') !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const start = i;
    i++;
    const oldLines: string[] = [];
    while (i < n && lines[i].replace(/[ \t]+$/, '') !== '=======') {
      oldLines.push(lines[i]);
      i++;
    }
    if (i >= n) return { parseErr: start + 1 };
    i++;
    const newLines: string[] = [];
    while (i < n && lines[i].replace(/[ \t]+$/, '') !== '>>>>>>> REPLACE') {
      newLines.push(lines[i]);
      i++;
    }
    if (i >= n) return { parseErr: start + 1 };
    i++;
    let path: string | null = null;
    for (let k = start - 1; k >= 0; k--) {
      const t = lines[k].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) return { parseErr: start + 1 };
    prevPath = path;
    edits.push({ kind: 'sr', path, oldLines, newLines });
  }
  if (edits.length === 0) return { parseErr: 1 };
  return { edits };
}

function applySR(tree: Tree, e: Extract<Edit, { kind: 'sr' }>, strict: boolean): EditFailure | null {
  touch(tree, e.path);
  if (!isSafePath(e.path)) return { code: 'unsafe', path: e.path };
  const f = getFile(tree, e.path);
  if (e.oldLines.length === 0) {
    if (e.newLines.length === 0) return null;
    if (f === null) {
      setFile(tree, e.path, { lines: e.newLines, br: '\n', eol: e.newLines.length > 0 });
      return null;
    }
    return { code: 'exists', path: e.path };
  }
  if (f === null) return { code: 'missing', path: e.path };
  const tier = findTier(f.lines, e.oldLines, 0, strict);
  if (tier === -1) return { code: 'no-match', path: e.path };
  const occs = findOccurrences(f.lines, e.oldLines, tier, 0);
  if (occs.length > 1) return { code: 'ambiguous', path: e.path };
  const pos = occs[0];
  const n: NLine[] = e.newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
  const rep = buildReplacement(n, e.oldLines, f.lines, pos, tier);
  const out = [...f.lines.slice(0, pos), ...rep, ...f.lines.slice(pos + e.oldLines.length)];
  setFile(tree, e.path, { lines: out, br: f.br, eol: f.eol });
  return null;
}

// ---- V4A (SPEC section 8) ----

function parseVChunk(raw: string[]): VChunk {
  let idx = 0;
  let anchor: string | null = null;
  if (raw.length > 0 && raw[0].startsWith('@@')) {
    anchor = raw[0];
    idx = 1;
  }
  const body: VChunkBodyItem[] = [];
  for (let j = idx; j < raw.length; j++) {
    const l = raw[j];
    if (l.startsWith('+')) body.push({ t: 'new', text: l.slice(1) });
    else if (l.startsWith('-')) body.push({ t: 'old', text: l.slice(1) });
    else if (l.startsWith(' ')) body.push({ t: 'ctx', text: l.slice(1) });
    else body.push({ t: 'ctx', text: l });
  }
  while (body.length > 0) {
    const last = body[body.length - 1];
    if (last.t === 'ctx' && last.text === '') body.pop();
    else break;
  }
  return { anchor, body, eof: false };
}

function parseV4A(lines: string[]): { edits: Edit[] } | { parseErr: number } {
  let begin = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '*** Begin Patch') {
      begin = i;
      break;
    }
  }
  if (begin === -1) return { parseErr: 1 };
  for (let i = begin + 1; i < lines.length; i++) {
    if (lines[i].trim() === '*** End Patch') {
      end = i;
      break;
    }
  }
  if (end === -1) return { parseErr: lines.length + 1 };
  const edits: Edit[] = [];
  let i = begin + 1;
  while (i < end) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      i++;
      const body: string[] = [];
      while (i < end && !lines[i].startsWith('*** ')) {
        const bl = lines[i];
        body.push(bl.startsWith('+') ? bl.slice(1) : bl);
        i++;
      }
      while (body.length > 0 && isBlank(body[body.length - 1])) body.pop();
      edits.push({ kind: 'v4a-add', path: p, lines: body });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      i++;
      edits.push({ kind: 'v4a-del', path: p });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const p = line.slice('*** Update File: '.length).trim();
      i++;
      let newPath: string | null = null;
      if (i < end && lines[i].startsWith('*** Move to: ')) {
        newPath = lines[i].slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      while (i < end) {
        const l = lines[i];
        if (l.startsWith('*** ')) break;
        if (isBlank(l)) {
          i++;
          continue;
        }
        const raw: string[] = [];
        if (lines[i].startsWith('@@')) {
          raw.push(lines[i]);
          i++;
        }
        while (i < end && !lines[i].startsWith('*** ') && !lines[i].startsWith('@@')) {
          raw.push(lines[i]);
          i++;
        }
        let eof = false;
        if (i < end && lines[i].trim() === '*** EOF ***') {
          eof = true;
          i++;
        }
        const chunk = parseVChunk(raw);
        chunk.eof = eof;
        chunks.push(chunk);
      }
      edits.push({ kind: 'v4a-update', path: p, newPath, chunks });
      continue;
    }
    i++;
  }
  if (edits.length === 0) return { parseErr: begin + 1 };
  return { edits };
}

function vChunkON(c: VChunk): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const it of c.body) {
    if (it.t === 'ctx') {
      o.push(it.text);
      n.push({ text: it.text, ctx: true, oIdx: o.length - 1 });
    } else if (it.t === 'old') {
      o.push(it.text);
    } else if (it.t === 'new') {
      n.push({ text: it.text, ctx: false, oIdx: -1 });
    }
  }
  return { o, n };
}

function applyV4AAdd(tree: Tree, e: Extract<Edit, { kind: 'v4a-add' }>): EditFailure | null {
  touch(tree, e.path);
  if (!isSafePath(e.path)) return { code: 'unsafe', path: e.path };
  if (fileExists(tree, e.path)) return { code: 'exists', path: e.path };
  setFile(tree, e.path, { lines: e.lines, br: '\n', eol: e.lines.length > 0 });
  return null;
}

function applyV4ADel(tree: Tree, e: Extract<Edit, { kind: 'v4a-del' }>): EditFailure | null {
  touch(tree, e.path);
  if (!isSafePath(e.path)) return { code: 'unsafe', path: e.path };
  if (!fileExists(tree, e.path)) return { code: 'missing', path: e.path };
  setFile(tree, e.path, null);
  return null;
}

// The position a V4A anchor names: a numeric @@ -N,M +N,M @@ gives the
// 1-based line N; a function-name anchor @@ <text> gives the line equal to
// <text>. null when the anchor names no line in the file.
function vAnchorPos(lines: string[], anchor: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(anchor);
  if (m) return parseInt(m[1], 10) - 1;
  let text = anchor.slice(2).trim();
  if (text.endsWith('@@')) text = text.slice(0, -2).trim();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === text) return i;
  }
  return null;
}

function applyV4AUpdate(
  tree: Tree,
  e: Extract<Edit, { kind: 'v4a-update' }>,
  strict: boolean,
  moves: MoveRec[],
): EditFailure | null {
  const op = e.path;
  const np = e.newPath;
  touch(tree, op);
  if (np !== null) touch(tree, np);
  if (!isSafePath(op)) return { code: 'unsafe', path: op };
  if (np !== null && !isSafePath(np)) return { code: 'unsafe', path: np };
  const f = getFile(tree, op);
  if (f === null) return { code: 'missing', path: op };
  if (np !== null && fileExists(tree, np)) return { code: 'exists', path: np };
  let lines = f.lines;
  let cursor = 0;
  for (const c of e.chunks) {
    const on = vChunkON(c);
    const o = on.o;
    if (o.length === 0) {
      const idx = c.eof ? lines.length : cursor;
      const ins = on.n.map((x) => x.text);
      lines = [...lines.slice(0, idx), ...ins, ...lines.slice(idx)];
      cursor = idx + ins.length;
      continue;
    }
    let from = cursor;
    if (c.anchor !== null) {
      const ap = vAnchorPos(lines, c.anchor);
      if (ap !== null) from = Math.max(cursor, ap);
    }
    const tier = findTier(lines, o, from, strict);
    if (tier === -1) return { code: 'no-match', path: op };
    const occs = findOccurrences(lines, o, tier, from);
    const pos = occs[0];
    const rep = buildReplacement(on.n, o, lines, pos, tier);
    lines = [...lines.slice(0, pos), ...rep, ...lines.slice(pos + o.length)];
    cursor = pos + rep.length;
  }
  const ns: FileState = { lines, br: f.br, eol: f.eol };
  if (np !== null) {
    setFile(tree, op, null);
    setFile(tree, np, ns);
    moves.push({ old: op, new: np });
  } else {
    setFile(tree, op, ns);
  }
  return null;
}

// ---- JSON (SPEC section 9) ----

function jsonFaultToEdit(item: unknown): Edit | null {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
  const o = item as Record<string, unknown>;
  const op = o.command ?? o.op;
  if (op === 'create') {
    const text = o.file_text ?? o.text;
    if (typeof o.path !== 'string' || typeof text !== 'string') return null;
    return { kind: 'json-create', path: o.path, text };
  }
  if (op === 'str_replace') {
    const oldS = o.old_str ?? o.old;
    const newS = o.new_str ?? o.new;
    if (typeof o.path !== 'string' || typeof oldS !== 'string' || typeof newS !== 'string') return null;
    return { kind: 'json-str', path: o.path, oldStr: oldS, newStr: newS };
  }
  if (op === 'insert') {
    const line = o.insert_line ?? o.line;
    const newS = o.new_str ?? o.new;
    if (typeof o.path !== 'string' || typeof newS !== 'string' || typeof line !== 'number' || !Number.isInteger(line)) return null;
    return { kind: 'json-insert', path: o.path, line, newStr: newS };
  }
  return null;
}

function parseJson(lines: string[], rawText: string): { edits: Edit[] } | { parseErr: number } {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) return { parseErr: 1 };
  const firstCh = lines[first].trimStart()[0];
  if (firstCh === '[') {
    let arr: unknown;
    try {
      arr = JSON.parse(rawText);
    } catch {
      return { parseErr: first + 1 };
    }
    if (!Array.isArray(arr)) return { parseErr: first + 1 };
    if (arr.length === 0) return { parseErr: first + 1 };
    const edits: Edit[] = [];
    for (const item of arr) {
      const f = jsonFaultToEdit(item);
      if (f === null) return { parseErr: first + 1 };
      edits.push(f);
    }
    return { edits };
  }
  if (firstCh === '{') {
    const edits: Edit[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (isBlank(lines[i])) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(lines[i]);
      } catch {
        return { parseErr: i + 1 };
      }
      const f = jsonFaultToEdit(obj);
      if (f === null) return { parseErr: i + 1 };
      edits.push(f);
    }
    if (edits.length === 0) return { parseErr: first + 1 };
    return { edits };
  }
  return { parseErr: first + 1 };
}

function applyJsonCreate(tree: Tree, e: Extract<Edit, { kind: 'json-create' }>): EditFailure | null {
  touch(tree, e.path);
  if (!isSafePath(e.path)) return { code: 'unsafe', path: e.path };
  if (fileExists(tree, e.path)) return { code: 'exists', path: e.path };
  const st = parseText(e.text);
  setFile(tree, e.path, st);
  return null;
}

function applyJsonStr(tree: Tree, e: Extract<Edit, { kind: 'json-str' }>): EditFailure | null {
  touch(tree, e.path);
  if (!isSafePath(e.path)) return { code: 'unsafe', path: e.path };
  const f = getFile(tree, e.path);
  if (f === null) return { code: 'missing', path: e.path };
  const text = serialize(f);
  const conv = (s: string): string =>
    s
      .split('\n')
      .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
      .join(f.br);
  const oldC = conv(e.oldStr);
  const newC = conv(e.newStr);
  if (oldC === '') {
    if (newC === '') return null;
    const ns = parseText(newC + text);
    setFile(tree, e.path, ns);
    return null;
  }
  const idxs: number[] = [];
  let from = 0;
  while (true) {
    const ix = text.indexOf(oldC, from);
    if (ix === -1) break;
    idxs.push(ix);
    from = ix + 1;
  }
  if (idxs.length === 0) return { code: 'no-match', path: e.path };
  if (idxs.length > 1) return { code: 'ambiguous', path: e.path };
  const nt = text.slice(0, idxs[0]) + newC + text.slice(idxs[0] + oldC.length);
  const ns = parseText(nt);
  setFile(tree, e.path, ns);
  return null;
}

function applyJsonInsert(tree: Tree, e: Extract<Edit, { kind: 'json-insert' }>): EditFailure | null {
  touch(tree, e.path);
  if (!isSafePath(e.path)) return { code: 'unsafe', path: e.path };
  const f = getFile(tree, e.path);
  if (f === null) return { code: 'missing', path: e.path };
  const line = e.line;
  if (line < 0 || line > f.lines.length) return { code: 'no-match', path: e.path };
  const newLines = splitPatchLines(e.newStr);
  const out = [...f.lines.slice(0, line), ...newLines, ...f.lines.slice(line)];
  setFile(tree, e.path, { lines: out, br: f.br, eol: f.eol });
  return null;
}

// ---- apply dispatcher ----

function applyEdit(tree: Tree, e: Edit, strict: boolean, moves: MoveRec[]): EditFailure | null {
  switch (e.kind) {
    case 'unified':
      return applyUnified(tree, e, strict, moves);
    case 'sr':
      return applySR(tree, e, strict);
    case 'v4a-add':
      return applyV4AAdd(tree, e);
    case 'v4a-del':
      return applyV4ADel(tree, e);
    case 'v4a-update':
      return applyV4AUpdate(tree, e, strict, moves);
    case 'json-create':
      return applyJsonCreate(tree, e);
    case 'json-str':
      return applyJsonStr(tree, e);
    case 'json-insert':
      return applyJsonInsert(tree, e);
  }
  return null;
}

// ---- handover to runner.ts (SPEC section 11) ----
// This dispatch is at the very end of the file on purpose: the whole program is
// defined before it runs, so a class or function declared above is never used
// before it is evaluated.

if (process.env.MAKEFUN_ENV_URL) {
  await runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  process.exitCode = runCli();
}
