// mend: one patch tool for every AI edit format.
//
// Node 22, standard library only. Implements SPEC.md (version 1).
// Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// When MAKEFUN_ENV_URL is set, the run is handed to runner.ts (trial mode).

import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runTrial } from './runner.ts';

// ---------------------------------------------------------------- utilities

class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';
const trimEndSpaces = (s: string): string => s.replace(/[ \t]+$/, '');

// A patch's lines: its text split at \n, each with one trailing \r removed,
// without the empty piece after a final \n.
function splitPatchLines(text: string): string[] {
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}
const stripTrailingWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

interface ParsedFile { lines: string[]; brk: string; ends: boolean; }

// A file's line break is CRLF when its first line feed follows a carriage
// return, and LF otherwise. Its lines are its text split at that break. It
// ends with a line break when its text ends with that break; that last,
// empty piece is not a line. An empty file has no lines.
function parseFile(text: string): ParsedFile {
  if (text === '') return { lines: [], brk: '\n', ends: false };
  let brk = '\n';
  const firstLf = text.indexOf('\n');
  if (firstLf > 0 && text[firstLf - 1] === '\r') brk = '\r\n';
  const parts = text.split(brk);
  const ends = text.endsWith(brk);
  if (ends) parts.pop();
  return { lines: parts, brk, ends };
}

function serializeFile(f: ParsedFile): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.brk) + (f.ends ? f.brk : '');
}

function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

// ---------------------------------------------------------------- matching

function lineEqAtTier(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailingWs(a) === stripTrailingWs(b);
  return stripBothWs(a) === stripBothWs(b);
}

function occurrencesAtTier(o: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (!lineEqAtTier(o[k], lines[i + k], tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

// The first tier (0, then 1, then 2) at which O occurs at least once at or
// after `from`, with every occurrence at that tier. With --strict only tier 0.
function findTier(o: string[], lines: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const occ = occurrencesAtTier(o, lines, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

// One line of a replacement: `text`, and for a context line the index of the
// line of O it is (so it is written as the file's own matched line).
interface NLine { text: string; ctx: number | null; }

// Build the lines that replace a match at position `pos`, found at `tier`.
// A context line is written as the file's own matched line. At tier 2 every
// other line is re-indented: the leading spaces/tabs of O's first line (P)
// are replaced by those of the file's first matched line (F).
function buildReplacement(n: NLine[], o: string[], fileLines: string[], pos: number, tier: number): string[] {
  const f = leadingWs(fileLines[pos]);
  const p = leadingWs(o[0]);
  return n.map((e) => {
    if (e.ctx !== null) return fileLines[pos + e.ctx];
    if (tier === 2) {
      const t = e.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) return f + t.slice(p.length);
    }
    return e.text;
  });
}

// ---------------------------------------------------------------- edits

interface Fail { code: string; path: string; }
type Move = [string, string];
interface Edit {
  paths: string[];
  apply(tree: Map<string, string>, strict: boolean, moves: Move[]): Fail | null;
}

interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  lastCtxOrPlusBs: boolean;
  lastPlusBs: boolean;
}

// Apply a section's hunks in order to a file. Returns the new file, or the
// failure code of the first hunk that fails.
function applyHunks(file: ParsedFile, hunks: Hunk[], strict: boolean): { ok: true; file: ParsedFile } | { ok: false; code: string } {
  let lines = file.lines;
  const brk = file.brk;
  let ends = file.ends;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length > 0) {
      const found = findTier(h.o, lines, 0, strict);
      if (!found) return { ok: false, code: 'no-match' };
      const target = h.a - 1 + d;
      let best = found.occ[0];
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) { best = p; bestDist = dist; }
      }
      const pos = best;
      const repl = buildReplacement(h.n, h.o, lines, pos, found.tier);
      const matchedToEnd = pos + h.o.length === lines.length;
      if (matchedToEnd) ends = !h.lastCtxOrPlusBs;
      lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + h.o.length)];
      d += h.n.length - h.o.length;
    } else {
      // Empty O: N is inserted after the first A + d lines (all of them
      // when the file has fewer).
      let ins = h.a + d;
      if (ins < 0) ins = 0;
      if (ins > lines.length) ins = lines.length;
      if (ins === lines.length) ends = !h.lastCtxOrPlusBs;
      const repl = h.n.map((e) => e.text);
      lines = [...lines.slice(0, ins), ...repl, ...lines.slice(ins)];
      d += h.n.length;
    }
  }
  return { ok: true, file: { lines, brk, ends } };
}

// ---------------------------------------------------------------- unified diffs

interface USection {
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

type BodyLine = { kind: 'ctx' | 'old' | 'new' | 'bs'; text: string };

function parseDiffGit(line: string, lineno: number): [string, string] {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new ParseError(lineno);
  const sep = rest.indexOf(' b/');
  if (sep === -1) throw new ParseError(lineno);
  return [rest.slice(2, sep), rest.slice(sep + 3)];
}

// The path of a --- / +++ header line: the text after the four characters,
// up to the first tab, with surrounding spaces removed. /dev/null means no
// file. A leading a/ or b/ is removed.
function parseHeaderPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab !== -1) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

function buildHunk(a: number, body: BodyLine[]): Hunk {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') { o.push(b.text); n.push({ text: b.text, ctx: o.length - 1 }); }
    else if (b.kind === 'old') o.push(b.text);
    else if (b.kind === 'new') n.push({ text: b.text, ctx: null });
  }
  let lastCtxOrPlus = -1;
  let lastPlus = -1;
  for (let k = body.length - 1; k >= 0; k--) {
    if (lastCtxOrPlus === -1 && (body[k].kind === 'ctx' || body[k].kind === 'new')) lastCtxOrPlus = k;
    if (lastPlus === -1 && body[k].kind === 'new') lastPlus = k;
    if (lastCtxOrPlus !== -1 && lastPlus !== -1) break;
  }
  const lastCtxOrPlusBs = lastCtxOrPlus >= 0 && body[lastCtxOrPlus + 1] !== undefined && body[lastCtxOrPlus + 1].kind === 'bs';
  const lastPlusBs = lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1].kind === 'bs';
  return { a, o, n, lastCtxOrPlusBs, lastPlusBs };
}

function buildUnifiedEdit(s: USection): Edit {
  const oldPath = s.oldPath !== undefined ? s.oldPath : (s.renameFrom ?? s.diffOld ?? null);
  const newPath = s.newPath !== undefined ? s.newPath : (s.renameTo ?? s.diffNew ?? null);
  if (oldPath === null || s.newFile) {
    // Creation: the file is the + lines of all its hunks, in order. It ends
    // with a line break unless a \ line follows its last + line.
    const path = newPath ?? '';
    return {
      paths: [path],
      apply(tree) {
        if (tree.has(path)) return { code: 'exists', path };
        const plusLines: string[] = [];
        for (const h of s.hunks) for (const e of h.n) if (e.ctx === null) plusLines.push(e.text);
        let lastPlusBs = false;
        for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
          if (s.hunks[hi].n.some((e) => e.ctx === null)) { lastPlusBs = s.hunks[hi].lastPlusBs; break; }
        }
        const text = plusLines.length === 0 ? '' : plusLines.join('\n') + (lastPlusBs ? '' : '\n');
        tree.set(path, text);
        return null;
      },
    };
  }
  if (newPath === null || s.deletedFile) {
    // Deletion: the old path exists; it is deleted, and its hunks are not read.
    const path = oldPath ?? '';
    return {
      paths: [path],
      apply(tree) {
        if (!tree.has(path)) return { code: 'missing', path };
        tree.delete(path);
        return null;
      },
    };
  }
  if (oldPath !== newPath) {
    // Move: the old path exists, the new path does not; the hunks apply to
    // the old file's lines and the result is written at the new path.
    return {
      paths: [oldPath, newPath],
      apply(tree, strict, moves) {
        const text = tree.get(oldPath);
        if (text === undefined) return { code: 'missing', path: oldPath };
        if (tree.has(newPath)) return { code: 'exists', path: newPath };
        const res = applyHunks(parseFile(text), s.hunks, strict);
        if (!res.ok) return { code: res.code, path: oldPath };
        tree.delete(oldPath);
        tree.set(newPath, serializeFile(res.file));
        moves.push([oldPath, newPath]);
        return null;
      },
    };
  }
  // Change of the one path, which exists.
  return {
    paths: [oldPath],
    apply(tree, strict) {
      const text = tree.get(oldPath);
      if (text === undefined) return { code: 'missing', path: oldPath };
      const res = applyHunks(parseFile(text), s.hunks, strict);
      if (!res.ok) return { code: res.code, path: oldPath };
      tree.set(oldPath, serializeFile(res.file));
      return null;
    },
  };
}

function parseUnified(lines: string[]): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let state: 'out' | 'header' | 'body' | 'after' = 'out';
  let body: BodyLine[] = [];
  let hunkA = 0;

  const freshSection = (): USection => ({
    oldPath: undefined, newPath: undefined, renameFrom: null, renameTo: null,
    diffOld: null, diffNew: null, newFile: false, deletedFile: false, hunks: [],
  });
  const endBody = (): void => {
    // Empty lines at the end of a body are not part of it.
    while (body.length > 0 && body[body.length - 1].kind === 'ctx' && body[body.length - 1].text === '') body.pop();
    if (cur !== null) cur.hunks.push(buildHunk(hunkA, body));
    body = [];
    state = 'after';
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (state === 'body') {
      // The body ends at a diff --git line, or at a --- line followed by a
      // +++ line (both would otherwise look like body lines: --- starts
      // with -). Any other line that is not a body line ends it too.
      if (line.startsWith('diff --git ') || (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ '))) {
        endBody();
        continue;
      }
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        if (line === '') body.push({ kind: 'ctx', text: '' });
        else if (line[0] === ' ') body.push({ kind: 'ctx', text: line.slice(1) });
        else if (line[0] === '-') body.push({ kind: 'old', text: line.slice(1) });
        else if (line[0] === '+') body.push({ kind: 'new', text: line.slice(1) });
        else body.push({ kind: 'bs', text: line.slice(1) });
        i += 1;
        continue;
      }
      endBody();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const [x, y] = parseDiffGit(line, i + 1);
      const s = freshSection();
      s.diffOld = x; s.diffNew = y;
      sections.push(s); cur = s; state = 'header';
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (state === 'header' && cur !== null) {
        if (i + 1 >= lines.length || !lines[i + 1].startsWith('+++ ')) throw new ParseError(i + 2);
        cur.oldPath = parseHeaderPath(line);
        cur.newPath = parseHeaderPath(lines[i + 1]);
        i += 2;
        continue;
      }
      if (i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
        const s = freshSection();
        s.oldPath = parseHeaderPath(line);
        s.newPath = parseHeaderPath(lines[i + 1]);
        sections.push(s); cur = s; state = 'header';
        i += 2;
        continue;
      }
      // A --- line not followed by +++ outside a header is ignored prose.
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new ParseError(i + 1);
      if (cur === null) throw new ParseError(i + 1);
      hunkA = parseInt(m[1], 10);
      body = [];
      state = 'body';
      i += 1;
      continue;
    }
    if (state === 'header' && cur !== null) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length);
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      // index, old mode, new mode, similarity index, dissimilarity index,
      // Index: lines, and any other line, are ignored.
      i += 1;
      continue;
    }
    i += 1;
  }
  if (state === 'body') endBody();
  return sections.map(buildUnifiedEdit);
}

// ---------------------------------------------------------------- SEARCH/REPLACE blocks

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return {
    paths: [path],
    apply(tree, strict) {
      if (oldLines.length === 0) {
        // Empty old lines: the file is created with the new lines.
        if (tree.has(path)) return { code: 'exists', path };
        const text = newLines.length === 0 ? '' : newLines.join('\n') + '\n';
        tree.set(path, text);
        return null;
      }
      const text = tree.get(path);
      if (text === undefined) return { code: 'missing', path };
      const file = parseFile(text);
      const found = findTier(oldLines, file.lines, 0, strict);
      if (!found) return { code: 'no-match', path };
      if (found.occ.length > 1) return { code: 'ambiguous', path };
      const pos = found.occ[0];
      const nEntries: NLine[] = newLines.map((t) => ({ text: t, ctx: null }));
      const repl = buildReplacement(nEntries, oldLines, file.lines, pos, found.tier);
      const outLines = [...file.lines.slice(0, pos), ...repl, ...file.lines.slice(pos + oldLines.length)];
      tree.set(path, serializeFile({ lines: outLines, brk: file.brk, ends: file.ends }));
      return null;
    },
  };
}

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (trimEndSpaces(lines[i]) !== '<<<<<<< SEARCH') { i += 1; continue; }
    const searchLine = i + 1;
    // The path is the nearest line before the SEARCH line, and after the
    // previous block's REPLACE line (or the start of the patch), that is not
    // blank and does not start with three backticks.
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseError(searchLine);
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = trimEndSpaces(lines[j]);
      if (t === '=======') { eq = j; break; }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq === -1) throw new ParseError(searchLine);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = trimEndSpaces(lines[j]);
      if (t === '>>>>>>> REPLACE') { rep = j; break; }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep === -1) throw new ParseError(searchLine);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------- V4A patches

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: { kind: 'ctx' | 'old' | 'new'; text: string }[];
}

interface VRawLine { text: string; no: number; }
interface VSectionRaw {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  raw: VRawLine[];
}

function v4aAddEdit(path: string, bodyLines: string[]): Edit {
  return {
    paths: [path],
    apply(tree) {
      if (tree.has(path)) return { code: 'exists', path };
      const text = bodyLines.length === 0 ? '' : bodyLines.join('\n') + '\n';
      tree.set(path, text);
      return null;
    },
  };
}

function v4aDeleteEdit(path: string): Edit {
  return {
    paths: [path],
    apply(tree) {
      if (!tree.has(path)) return { code: 'missing', path };
      tree.delete(path);
      return null;
    },
  };
}

function v4aUpdateEdit(s: VSectionRaw): Edit {
  let idx = 0;
  let moveTo: string | null = null;
  if (idx < s.raw.length && s.raw[idx].text.startsWith('*** Move to: ')) {
    moveTo = s.raw[idx].text.slice('*** Move to: '.length).trim();
    idx += 1;
  }
  const chunks: VChunk[] = [];
  let curChunk: VChunk | null = null;
  const pushChunk = (): void => { if (curChunk !== null) { chunks.push(curChunk); curChunk = null; } };
  for (; idx < s.raw.length; idx++) {
    const line = s.raw[idx].text;
    const no = s.raw[idx].no;
    if (line.startsWith('@@')) {
      pushChunk();
      const a = line.slice(2).trim();
      curChunk = { anchor: a === '' ? null : a, eof: false, body: [] };
      continue;
    }
    if (line === '*** End of File') {
      if (curChunk === null) throw new ParseError(no);
      curChunk.eof = true;
      pushChunk();
      continue;
    }
    if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (curChunk === null) {
        // Only the first chunk may start at a body line.
        if (chunks.length > 0) throw new ParseError(no);
        curChunk = { anchor: null, eof: false, body: [] };
      }
      if (line === '') curChunk.body.push({ kind: 'ctx', text: '' });
      else if (line[0] === ' ') curChunk.body.push({ kind: 'ctx', text: line.slice(1) });
      else if (line[0] === '-') curChunk.body.push({ kind: 'old', text: line.slice(1) });
      else curChunk.body.push({ kind: 'new', text: line.slice(1) });
      continue;
    }
    throw new ParseError(no);
  }
  pushChunk();
  if (chunks.length === 0 && moveTo === null) throw new ParseError(s.lineNo);

  const paths = moveTo === null ? [s.path] : [s.path, moveTo];
  const path = s.path;
  return {
    paths,
    apply(tree, strict, moves) {
      const text = tree.get(path);
      if (text === undefined) return { code: 'missing', path };
      if (moveTo !== null && tree.has(moveTo)) return { code: 'exists', path: moveTo };
      const file = parseFile(text);
      let lines = file.lines;
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          // Find the first line at or after the cursor equal to the anchor
          // at the first tier where one is; the cursor moves past it.
          const found = findTier([ch.anchor], lines, cursor, strict);
          if (!found) return { code: 'no-match', path };
          cursor = found.occ[0] + 1;
        }
        const o: string[] = [];
        const n: NLine[] = [];
        for (const b of ch.body) {
          if (b.kind === 'ctx') { o.push(b.text); n.push({ text: b.text, ctx: o.length - 1 }); }
          else if (b.kind === 'old') o.push(b.text);
          else n.push({ text: b.text, ctx: null });
        }
        if (o.length > 0) {
          // The chunk takes the first occurrence of O at or after the
          // cursor, at the first tier with one; an end-of-file chunk takes
          // only an occurrence that ends at the file's last line.
          let found: { tier: number; occ: number[] } | null = null;
          const maxTier = strict ? 0 : 2;
          for (let t = 0; t <= maxTier; t++) {
            let occ = occurrencesAtTier(o, lines, t, cursor);
            if (ch.eof) occ = occ.filter((p) => p + o.length === lines.length);
            if (occ.length > 0) { found = { tier: t, occ }; break; }
          }
          if (!found) return { code: 'no-match', path };
          const pos = found.occ[0];
          const repl = buildReplacement(n, o, lines, pos, found.tier);
          lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + o.length)];
          cursor = pos + repl.length;
        } else {
          // Empty O: N is inserted at the cursor, or at the end of the file
          // for an end-of-file chunk.
          const ins = ch.eof ? lines.length : cursor;
          const repl = n.map((e) => e.text);
          lines = [...lines.slice(0, ins), ...repl, ...lines.slice(ins)];
          cursor = ins + repl.length;
        }
      }
      const newText = serializeFile({ lines, brk: file.brk, ends: file.ends });
      if (moveTo !== null) {
        tree.delete(path);
        tree.set(moveTo, newText);
        moves.push([path, moveTo]);
      } else {
        tree.set(path, newText);
      }
      return null;
    },
  };
}

function parseV4a(lines: string[]): Edit[] {
  let firstIdx = -1;
  for (let k = 0; k < lines.length; k++) if (!isBlank(lines[k])) { firstIdx = k; break; }
  if (firstIdx === -1) throw new ParseError(1);
  if (lines[firstIdx].trim() !== '*** Begin Patch') throw new ParseError(firstIdx + 1);
  let lastIdx = -1;
  for (let k = lines.length - 1; k >= 0; k--) if (!isBlank(lines[k])) { lastIdx = k; break; }
  if (lines[lastIdx].trim() !== '*** End Patch') throw new ParseError(lines.length + 1);

  const raws: VSectionRaw[] = [];
  let cur: VSectionRaw | null = null;
  for (let k = firstIdx + 1; k < lastIdx; k++) {
    const line = lines[k];
    let kind: 'add' | 'delete' | 'update' | null = null;
    let prefix = '';
    if (line.startsWith('*** Add File: ')) { kind = 'add'; prefix = '*** Add File: '; }
    else if (line.startsWith('*** Delete File: ')) { kind = 'delete'; prefix = '*** Delete File: '; }
    else if (line.startsWith('*** Update File: ')) { kind = 'update'; prefix = '*** Update File: '; }
    if (kind !== null) {
      cur = { kind, path: line.slice(prefix.length).trim(), lineNo: k + 1, raw: [] };
      raws.push(cur);
      continue;
    }
    if (cur === null) {
      if (isBlank(line)) continue;
      throw new ParseError(k + 1);
    }
    cur.raw.push({ text: line, no: k + 1 });
  }

  const edits: Edit[] = [];
  for (const s of raws) {
    // Blank lines at the end of a section are not part of it.
    while (s.raw.length > 0 && isBlank(s.raw[s.raw.length - 1].text)) s.raw.pop();
    if (s.kind === 'add') {
      const body: string[] = [];
      for (const r of s.raw) {
        if (r.text.startsWith('+')) body.push(r.text.slice(1));
        else if (r.text === '') body.push('');
        else throw new ParseError(r.no);
      }
      edits.push(v4aAddEdit(s.path, body));
    } else if (s.kind === 'delete') {
      for (const r of s.raw) {
        if (isBlank(r.text)) continue;
        throw new ParseError(r.no);
      }
      edits.push(v4aDeleteEdit(s.path));
    } else {
      edits.push(v4aUpdateEdit(s));
    }
  }
  return edits;
}

// ---------------------------------------------------------------- JSON edits

function jsonEdit(el: unknown, lineNo: number): Edit {
  if (typeof el !== 'object' || el === null || Array.isArray(el)) throw new ParseError(lineNo);
  const o = el as Record<string, unknown>;
  if (typeof o.path !== 'string') throw new ParseError(lineNo);
  if (typeof o.command !== 'string') throw new ParseError(lineNo);
  const path = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') throw new ParseError(lineNo);
    const fileText = o.file_text;
    return {
      paths: [path],
      apply(tree) {
        if (tree.has(path)) return { code: 'exists', path };
        tree.set(path, fileText);
        return null;
      },
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') throw new ParseError(lineNo);
    if (o.new_str !== undefined && typeof o.new_str !== 'string') throw new ParseError(lineNo);
    const oldStr = o.old_str;
    const newStr = o.new_str === undefined ? '' : (o.new_str as string);
    return {
      paths: [path],
      apply(tree) {
        const text = tree.get(path);
        if (text === undefined) return { code: 'missing', path };
        const file = parseFile(text);
        let hay = text;
        let oldS = oldStr;
        let newS = newStr;
        if (file.brk === '\r\n') {
          hay = text.replace(/\r\n/g, '\n');
          oldS = oldStr.replace(/\r\n/g, '\n');
          newS = newStr.replace(/\r\n/g, '\n');
        }
        let count = 0;
        let firstIdx = -1;
        let from = 0;
        for (;;) {
          const ix = hay.indexOf(oldS, from);
          if (ix === -1) break;
          count += 1;
          if (firstIdx === -1) firstIdx = ix;
          from = ix + 1;
        }
        if (count === 0) return { code: 'no-match', path };
        if (count > 1) return { code: 'ambiguous', path };
        const result = hay.slice(0, firstIdx) + newS + hay.slice(firstIdx + oldS.length);
        tree.set(path, file.brk === '\r\n' ? result.replace(/\n/g, '\r\n') : result);
        return null;
      },
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) throw new ParseError(lineNo);
    if (typeof o.new_str !== 'string') throw new ParseError(lineNo);
    const insertLine = o.insert_line;
    const newStr = o.new_str;
    return {
      paths: [path],
      apply(tree) {
        const text = tree.get(path);
        if (text === undefined) return { code: 'missing', path };
        const file = parseFile(text);
        if (insertLine < 0 || insertLine > file.lines.length) return { code: 'no-match', path };
        const insLines = newStr === '' ? [] : splitPatchLines(newStr);
        const outLines = [...file.lines.slice(0, insertLine), ...insLines, ...file.lines.slice(insertLine)];
        tree.set(path, serializeFile({ lines: outLines, brk: file.brk, ends: file.ends }));
        return null;
      },
    };
  }
  throw new ParseError(lineNo);
}

function parseJson(patchText: string, lines: string[]): Edit[] {
  let firstIdx = -1;
  for (let k = 0; k < lines.length; k++) if (!isBlank(lines[k])) { firstIdx = k; break; }
  if (firstIdx === -1) return [];
  const firstLine = lines[firstIdx];
  const firstChar = firstLine.trimStart()[0];
  if (firstChar === '[') {
    // One JSON array of edit objects. Any fault is the line where the
    // array starts.
    let arr: unknown;
    try {
      arr = JSON.parse(patchText);
    } catch {
      throw new ParseError(firstIdx + 1);
    }
    if (!Array.isArray(arr)) throw new ParseError(firstIdx + 1);
    return arr.map((el) => jsonEdit(el, firstIdx + 1));
  }
  // JSON Lines: one edit object a line, blank lines ignored.
  const edits: Edit[] = [];
  for (let k = 0; k < lines.length; k++) {
    if (isBlank(lines[k])) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(lines[k]);
    } catch {
      throw new ParseError(k + 1);
    }
    edits.push(jsonEdit(obj, k + 1));
  }
  return edits;
}

// ---------------------------------------------------------------- format detection

function detectFormat(lines: string[]): string | null {
  let firstNonBlank: string | undefined;
  for (const l of lines) {
    if (!isBlank(l)) { firstNonBlank = l; break; }
  }
  if (firstNonBlank !== undefined) {
    if (firstNonBlank.trim() === '*** Begin Patch') return 'v4a';
    const m = /^\s*(\S)/.exec(firstNonBlank);
    if (m && (m[1] === '[' || m[1] === '{')) return 'json';
  }
  for (const l of lines) {
    if (trimEndSpaces(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------- tree and main

function readTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string, prefix: string): void => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      const rel = prefix === '' ? ent.name : prefix + '/' + ent.name;
      if (ent.isDirectory()) walk(p, rel);
      else if (ent.isFile()) out.set(rel, readFileSync(p, 'utf8'));
    }
  };
  walk(dir, '');
  return out;
}

function exitWith(text: string, code: number): number {
  if (text !== '') writeSync(1, text);
  return code;
}

function main(argv: string[]): number {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let noMoreOpts = false;
  const positionals: string[] = [];
  for (const a of argv) {
    if (!noMoreOpts && a === '--') { noMoreOpts = true; continue; }
    if (!noMoreOpts && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (seenCheck) return exitWith('error: usage\n', 2);
        seenCheck = true; check = true;
      } else if (a === '--strict') {
        if (seenStrict) return exitWith('error: usage\n', 2);
        seenStrict = true; strict = true;
      } else if (a.startsWith('--format=')) {
        if (seenFormat) return exitWith('error: usage\n', 2);
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (v !== 'auto' && v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json') return exitWith('error: usage\n', 2);
        format = v;
      } else {
        return exitWith('error: usage\n', 2);
      }
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length > 1) return exitWith('error: usage\n', 2);
  const patchArg = positionals.length === 0 ? null : positionals[0];

  let patchText: string;
  if (patchArg === null || patchArg === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(patchArg, 'utf8');
    } catch {
      return exitWith('error: no-patch\n', 2);
    }
  }

  const lines = splitPatchLines(patchText);
  let fmt = format;
  if (fmt === null || fmt === 'auto') {
    fmt = detectFormat(lines);
    if (fmt === null) return exitWith('error: format\n', 2);
  }

  let edits: Edit[];
  try {
    if (fmt === 'unified') edits = parseUnified(lines);
    else if (fmt === 'search-replace') edits = parseSearchReplace(lines);
    else if (fmt === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(patchText, lines);
  } catch (e) {
    if (e instanceof ParseError) return exitWith(`error: parse ${e.line}\n`, 2);
    throw e;
  }
  if (edits.length === 0) return exitWith('error: parse 1\n', 2);

  const initial = readTree(process.cwd());
  const tree = new Map(initial);
  const moves: Move[] = [];
  const failures: Fail[] = [];
  for (const edit of edits) {
    let fail: Fail | null = null;
    for (const p of edit.paths) {
      if (!isSafePath(p)) { fail = { code: 'unsafe', path: p }; break; }
    }
    if (fail === null) fail = edit.apply(tree, strict, moves);
    if (fail !== null) failures.push(fail);
  }
  if (failures.length > 0) {
    let out = '';
    for (const f of failures) out += `error: ${f.code} ${f.path}\n`;
    out += `failed: ${failures.length} of ${edits.length} edits\n`;
    return exitWith(out, 1);
  }

  const rows: { key: string; line: string }[] = [];
  const allPaths = new Set<string>([...initial.keys(), ...tree.keys()]);
  for (const p of allPaths) {
    const before = initial.get(p);
    const after = tree.get(p);
    if (before === undefined && after === undefined) continue;
    if (before !== undefined && after === undefined) {
      const mn = moves.find(([mo]) => mo === p)?.[1];
      if (mn !== undefined && !initial.has(mn) && tree.has(mn)) rows.push({ key: mn, line: `R ${p} -> ${mn}` });
      else rows.push({ key: p, line: `D ${p}` });
    } else if (before === undefined && after !== undefined) {
      const mo = moves.find(([, mn]) => mn === p)?.[0];
      if (mo === undefined || !initial.has(mo) || tree.has(mo)) rows.push({ key: p, line: `A ${p}` });
    } else if (before !== after) {
      rows.push({ key: p, line: `M ${p}` });
    }
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));
  let out = '';
  for (const r of rows) out += r.line + '\n';
  out += rows.length === 1 ? 'ok: 1 file\n' : `ok: ${rows.length} files\n`;

  if (!check) {
    for (const p of allPaths) {
      const before = initial.get(p);
      const after = tree.get(p);
      if (before === after) continue;
      const full = join(process.cwd(), ...p.split('/'));
      if (after === undefined) rmSync(full, { force: true });
      else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, after, 'utf8');
      }
    }
  }
  return exitWith(out, 0);
}

// A trial hands over to runner.ts when MAKEFUN_ENV_URL is set; otherwise
// this is the CLI.
const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  runTrial(envUrl).then(
    () => process.exit(0),
    (err: unknown) => {
      process.stderr.write(`trial failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
} else {
  process.exit(main(process.argv.slice(2)));
}
