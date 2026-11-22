// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE
// blocks, V4A patches, JSON text-editor tool calls) and applies it to the
// tree of text files in the working directory, changing every file or none,
// exactly as SPEC.md says. Node 22, standard library alone.
//
// A check runs `node main.ts [options] [PATCH]` once in a fresh directory;
// the exit code, stdout and every file afterwards must match SPEC.md.
// Standard error is never compared.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Thrown to end the run with exit 2 and one error line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** Thrown by one edit to report its failure (exit 1, one line per edit). */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC.md section 3: a path is safe when it is not empty, not absolute, holds no backslash, and none of its segments is empty, `.` or `..`. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: paths changed so far in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; nw: string }[] = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** A file's lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** One line as a tier sees it (SPEC.md section 5): 0 exact, 1 no trailing space/tab, 2 no leading/trailing space/tab. */
function tierLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in the file's lines at the given tier (occurrences may overlap). */
function occurrencesAt(fileLines: string[], O: string[], tier: number): number[] {
  const oT = O.map((l) => tierLine(l, tier));
  const out: number[] = [];
  for (let i = 0; i + O.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (tierLine(fileLines[i + j]!, tier) !== oT[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its positions (SPEC.md section 5). */
function findTier(fileLines: string[], O: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(fileLines, O, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** Tier-2 re-indentation of one new line (SPEC.md section 5). */
function reindent(line: string, P: string, F: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  // A line that starts with P has that P replaced by F; with P empty every
  // line starts with it, so F is prepended.
  if (line.startsWith(P)) return F + line.slice(P.length);
  return line;
}

/** One body line of a hunk or chunk. `marker` is set when a `\` line follows it. */
interface Op {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  marker: boolean;
}

/**
 * O (context + old lines) and N (context + new lines) of a body. A context
 * line of N carries the index of its line in O, so it is written as the
 * file's own matched line, never the patch's.
 */
function splitOps(ops: Op[]): { O: string[]; N: { text: string; ctx: number | null }[] } {
  const O: string[] = [];
  const N: { text: string; ctx: number | null }[] = [];
  for (const op of ops) {
    if (op.kind === 'ctx') {
      const idx = O.length;
      O.push(op.text);
      N.push({ text: op.text, ctx: idx });
    } else if (op.kind === 'del') {
      O.push(op.text);
    } else {
      N.push({ text: op.text, ctx: null });
    }
  }
  return { O, N };
}

/** N mapped onto the file's lines at the matched position and tier (SPEC.md section 5). */
function mapNew(N: { text: string; ctx: number | null }[], fileLines: string[], pos: number, O: string[], tier: number): string[] {
  const P = O.length > 0 ? leadingWs(O[0]!) : '';
  const F = O.length > 0 ? leadingWs(fileLines[pos]!) : '';
  return N.map((e) => (e.ctx !== null ? fileLines[pos + e.ctx]! : tier === 2 ? reindent(e.text, P, F) : e.text));
}

/** Format detection (SPEC.md section 4): the first of these that holds, else null. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when the value is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  /** The file's current text, or a Fail when the path is unsafe or the file is missing. */
  const existing = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };

  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }

  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existing(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      // In a CRLF file the file's text and both strings are read with every \r\n as \n,
      // and the result is written back with \r\n.
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = existing(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      const lines = [...f.lines];
      lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile({ lines, br: f.br, final: f.final }));
    };
  }

  return null;
}

/** The edits of a JSON patch: one array, or JSON Lines with one edit object a line. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    // Array form: any fault is a parse fault at the line where the array starts.
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  // JSON Lines form: a line that does not hold one valid edit object is a parse fault at that line.
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  /** The A of `@@ -A[,B] +C[,D] @@`: the 1-based line the hunk starts at in the old file. */
  A: number;
  ops: Op[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  dashOld: string | null;
  dashNew: string | null;
  hasDashPair: boolean;
  renameOld: string | null;
  renameNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** A `---`/`+++` path: the text after the four characters, up to the first tab, spaces removed, leading a/ or b/ removed. */
function dashPath(l: string): string {
  const p = l.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The A of a hunk header line, or null when the line is not a well-formed header. */
function hunkHeaderA(l: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(l);
  return m ? parseInt(m[1]!, 10) : null;
}

/**
 * One hunk body, starting after the header at index `h`. Returns the index
 * of the first line after the body; empty lines at the end of a body are not part of it.
 */
function parseHunkBody(lines: string[], h: number, hunks: Hunk[]): number {
  const A = hunkHeaderA(lines[h]!)!;
  const ops: Op[] = [];
  let j = h + 1;
  while (j < lines.length) {
    const b = lines[j]!;
    if (b.startsWith('diff --git ')) break;
    if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (b === '') {
      ops.push({ kind: 'ctx', text: '', marker: false });
      j++;
      continue;
    }
    const c = b[0]!;
    if (c === ' ') {
      ops.push({ kind: 'ctx', text: b.slice(1), marker: false });
      j++;
      continue;
    }
    if (c === '-') {
      ops.push({ kind: 'del', text: b.slice(1), marker: false });
      j++;
      continue;
    }
    if (c === '+') {
      ops.push({ kind: 'add', text: b.slice(1), marker: false });
      j++;
      continue;
    }
    if (c === '\\') {
      // A `\` line refers to the body line before it.
      if (ops.length > 0) ops[ops.length - 1]!.marker = true;
      j++;
      continue;
    }
    break;
  }
  while (ops.length > 0) {
    const last = ops[ops.length - 1]!;
    if (last.kind === 'ctx' && last.text === '' && !last.marker) ops.pop();
    else break;
  }
  let noEol = false;
  for (let k = ops.length - 1; k >= 0; k--) {
    const op = ops[k]!;
    if (op.kind === 'ctx' || op.kind === 'add') {
      noEol = op.marker;
      break;
    }
  }
  hunks.push({ A, ops, noEol });
  return j;
}

/**
 * Apply one hunk of a change/move section to a file state. `d` is the sum
 * over this section's hunks applied so far of (N's length minus O's length).
 */
function applyHunk(f: FileState, hunk: Hunk, d: number, strict: boolean, path: string): FileState {
  const { O, N } = splitOps(hunk.ops);
  if (O.length === 0) {
    // Empty O: N is inserted after the first A + d lines (all of them when the file has fewer).
    const ins = Math.max(0, Math.min(hunk.A + d, f.lines.length));
    const lines = [...f.lines.slice(0, ins), ...N.map((e) => e.text), ...f.lines.slice(ins)];
    const final = ins === f.lines.length ? !hunk.noEol : f.final;
    return { lines, br: f.br, final };
  }
  const found = findTier(f.lines, O, strict);
  if (found === null) throw new Fail('no-match', path);
  // Of the occurrences at the tier where O is found, take the one nearest to A - 1 + d; of two equally near, the earlier.
  const target = hunk.A - 1 + d;
  let best = found.pos[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.pos) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const mapped = mapNew(N, f.lines, best, O, found.tier);
  const lines = [...f.lines.slice(0, best), ...mapped, ...f.lines.slice(best + O.length)];
  // When the matched lines run to the end of the file, the result ends with a line break
  // unless a `\` line follows the hunk's last context or `+` line; otherwise the file's final break stays.
  const final = best + O.length === f.lines.length ? !hunk.noEol : f.final;
  return { lines, br: f.br, final };
}

/** One section is one edit. */
function sectionEdit(sec: Section, strict: boolean): Edit {
  const oldP = sec.dashOld ?? sec.renameOld ?? sec.diffOld ?? '';
  const newP = sec.dashNew ?? sec.renameNew ?? sec.diffNew ?? '';
  const isCreate = oldP === '/dev/null' || sec.isCreate;
  const isDelete = !isCreate && (newP === '/dev/null' || sec.isDelete);
  const isMove = !isCreate && !isDelete && oldP !== newP;

  if (isCreate) {
    return (tree) => {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      // The created file ends with a line break unless a `\` line follows its last `+` line.
      let noEol = false;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const ops = sec.hunks[hi]!.ops;
        for (let k = ops.length - 1; k >= 0; k--) {
          if (ops[k]!.kind === 'add') {
            noEol = ops[k]!.marker;
            break outer;
          }
        }
      }
      for (const h of sec.hunks) for (const op of h.ops) if (op.kind === 'add') plus.push(op.text);
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
    };
  }

  if (isDelete) {
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
    };
  }

  if (isMove) {
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      let f = splitFile(cur);
      let d = 0;
      for (const h of sec.hunks) {
        const { O, N } = splitOps(h.ops);
        f = applyHunk(f, h, d, strict, oldP);
        d += N.length - O.length;
      }
      tree.now.set(oldP, null);
      tree.now.set(newP, joinFile(f));
      tree.moves.push({ old: oldP, nw: newP });
    };
  }

  return (tree) => {
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    let f = splitFile(cur);
    let d = 0;
    for (const h of sec.hunks) {
      const { O, N } = splitOps(h.ops);
      f = applyHunk(f, h, d, strict, oldP);
      d += N.length - O.length;
    }
    tree.now.set(oldP, joinFile(f));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const fresh = (diffOld: string | null, diffNew: string | null): Section => ({
    diffOld,
    diffNew,
    dashOld: null,
    dashNew: null,
    hasDashPair: false,
    renameOld: null,
    renameNew: null,
    isCreate: false,
    isDelete: false,
    hunks: [],
  });
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh(m[1]!, m[2]!);
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !cur.hasDashPair) {
        cur.dashOld = dashPath(l);
        cur.dashNew = dashPath(lines[i + 1]!);
        cur.hasDashPair = true;
      } else {
        cur = fresh(null, null);
        sections.push(cur);
        inHeader = true;
        cur.dashOld = dashPath(l);
        cur.dashNew = dashPath(lines[i + 1]!);
        cur.hasDashPair = true;
      }
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      if (hunkHeaderA(l) === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      i = parseHunkBody(lines, i, cur.hunks);
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) {
        cur.renameOld = l.slice(12).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameNew = l.slice(10).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) cur.isCreate = true;
      else if (l.startsWith('deleted file mode')) cur.isDelete = true;
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => sectionEdit(s, strict));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevEnd = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const sIdx = i;
    // The path is the nearest line before the SEARCH line, and after the
    // previous block's REPLACE line (or the start of the patch), that is not
    // blank and does not start with three backticks (surrounding whitespace removed).
    let path: string | null = null;
    for (let j = sIdx - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      // With no such line the block takes the previous block's path;
      // the first block with none is a parse fault at its SEARCH line.
      if (prevPath === null) throw new Exit2(`error: parse ${sIdx + 1}`);
      path = prevPath;
    }
    // A SEARCH line with no `=======` and then `>>>>>>> REPLACE` after it is a parse fault at the SEARCH line.
    let eq = -1;
    let rep = -1;
    for (let j = sIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${sIdx + 1}`);
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${sIdx + 1}`);
    const old = lines.slice(sIdx + 1, eq);
    const nw = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (old.length === 0) {
        // Empty old lines: the file is created with the new lines.
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, nw.length === 0 ? '' : nw.join('\n') + '\n');
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const f = splitFile(cur);
      const found = findTier(f.lines, old, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const pos = found.pos[0]!;
      const P = leadingWs(old[0]!);
      const F = leadingWs(f.lines[pos]!);
      const mapped = nw.map((t) => (found.tier === 2 ? reindent(t, P, F) : t));
      const newLines = [...f.lines.slice(0, pos), ...mapped, ...f.lines.slice(pos + old.length)];
      tree.now.set(p, joinFile({ lines: newLines, br: f.br, final: f.final }));
    });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface Chunk {
  /** null: first chunk with no @@ line; '': @@ line with no anchor text; else the anchor. */
  anchor: string | null;
  ops: Op[];
  /** A `*** End of File` line ended this chunk: it is anchored to the end of the file. */
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const end = last;
  const tiers = strict ? [0] : [0, 1, 2];
  let i = first + 1;
  while (i < end) {
    const l = lines[i]!;
    if (blank(l)) {
      // Blank lines between sections are ignored.
      i++;
      continue;
    }
    if (l.startsWith('*** Add File:')) {
      const path = l.slice('*** Add File:'.length).trim();
      i++;
      const flines: string[] = [];
      while (i < end) {
        const b = lines[i]!;
        if (
          b.startsWith('*** Add File:') ||
          b.startsWith('*** Delete File:') ||
          b.startsWith('*** Update File:') ||
          b.trimEnd() === '*** End Patch'
        )
          break;
        if (b === '') {
          flines.push('');
          i++;
          continue;
        }
        if (b.startsWith('+')) {
          flines.push(b.slice(1));
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      // Blank lines at the end of a section are not part of it.
      while (flines.length > 0 && flines[flines.length - 1] === '') flines.pop();
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, flines.length === 0 ? '' : flines.join('\n') + '\n');
      });
      continue;
    }
    if (l.startsWith('*** Delete File:')) {
      const path = l.slice('*** Delete File:'.length).trim();
      i++;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    if (l.startsWith('*** Update File:')) {
      const path = l.slice('*** Update File:'.length).trim();
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < end && lines[i]!.startsWith('*** Move to:')) {
        moveTo = lines[i]!.slice('*** Move to:'.length).trim();
        i++;
      }
      const chunks: Chunk[] = [];
      let curChunk: Chunk | null = null;
      let sawChunk = false;
      while (i < end) {
        const b = lines[i]!;
        if (
          b.startsWith('*** Add File:') ||
          b.startsWith('*** Delete File:') ||
          b.startsWith('*** Update File:') ||
          b.trimEnd() === '*** End Patch'
        )
          break;
        if (b.startsWith('@@')) {
          if (curChunk !== null) chunks.push(curChunk);
          curChunk = { anchor: b.slice(2).trim(), ops: [], eof: false };
          sawChunk = true;
          i++;
          continue;
        }
        if (b.trimEnd() === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${i + 1}`);
          curChunk.eof = true;
          chunks.push(curChunk);
          curChunk = null;
          i++;
          continue;
        }
        if (b === '' && curChunk === null && sawChunk) {
          // A blank line after a chunk that `*** End of File` ended: blank
          // lines at the end of a section are not part of it.
          i++;
          continue;
        }
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
          if (curChunk === null) {
            if (sawChunk) throw new Exit2(`error: parse ${i + 1}`);
            curChunk = { anchor: null, ops: [], eof: false };
            sawChunk = true;
          }
          if (b === '') curChunk.ops.push({ kind: 'ctx', text: '', marker: false });
          else if (b[0] === ' ') curChunk.ops.push({ kind: 'ctx', text: b.slice(1), marker: false });
          else if (b[0] === '-') curChunk.ops.push({ kind: 'del', text: b.slice(1), marker: false });
          else curChunk.ops.push({ kind: 'add', text: b.slice(1), marker: false });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (curChunk !== null) chunks.push(curChunk);
      if (chunks.length > 0) {
        // Blank lines at the end of a section are not part of it.
        const lastOps = chunks[chunks.length - 1]!.ops;
        while (lastOps.length > 0) {
          const op = lastOps[lastOps.length - 1]!;
          if (op.kind === 'ctx' && op.text === '') lastOps.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const cur = tree.get(path);
        if (cur === null) throw new Fail('missing', path);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        let f = splitFile(cur);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null && ch.anchor !== '') {
            // Find the first line at or after the cursor equal to the anchor
            // at the first tier where one is (both sides a single line).
            let foundAt: number | null = null;
            for (const t of tiers) {
              for (let k = cursor; k < f.lines.length; k++) {
                if (tierLine(f.lines[k]!, t) === tierLine(ch.anchor, t)) {
                  foundAt = k;
                  break;
                }
              }
              if (foundAt !== null) break;
            }
            if (foundAt === null) throw new Fail('no-match', path);
            cursor = foundAt + 1;
          }
          const { O, N } = splitOps(ch.ops);
          if (O.length === 0) {
            const ins = ch.eof ? f.lines.length : cursor;
            const lines = [...f.lines.slice(0, ins), ...N.map((e) => e.text), ...f.lines.slice(ins)];
            f = { lines, br: f.br, final: f.final };
            cursor = ins + N.length;
            continue;
          }
          let hit: { tier: number; pos: number } | null = null;
          for (const t of tiers) {
            const poss = occurrencesAt(f.lines, O, t).filter((p) => p >= cursor);
            if (ch.eof) {
              const eofPoss = poss.filter((p) => p + O.length === f.lines.length);
              if (eofPoss.length > 0) {
                hit = { tier: t, pos: eofPoss[0]! };
                break;
              }
            } else if (poss.length > 0) {
              hit = { tier: t, pos: poss[0]! };
              break;
            }
          }
          if (hit === null) throw new Fail('no-match', path);
          const mapped = mapNew(N, f.lines, hit.pos, O, hit.tier);
          const lines = [...f.lines.slice(0, hit.pos), ...mapped, ...f.lines.slice(hit.pos + O.length)];
          f = { lines, br: f.br, final: f.final };
          cursor = hit.pos + mapped.length;
        }
        const out = joinFile(f);
        if (moveTo !== null) {
          tree.now.set(path, null);
          tree.now.set(moveTo, out);
          tree.moves.push({ old: path, nw: moveTo });
        } else {
          tree.now.set(path, out);
        }
      });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// Invocation (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  // Edits apply in the patch's order to the tree as earlier edits left it.
  // A failed edit changes nothing, and the edits after it still run.
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  // One line for each path whose state changed, in byte order of the paths (UTF-8).
  // A move that succeeded replaces its pair's D and A lines and sorts by its new path.
  const entries: { key: string; row: string }[] = [];
  const suppressed = new Set<string>();
  for (const mv of tree.moves) {
    const wasOld = tree.original(mv.old);
    const nowOld = tree.get(mv.old);
    const wasNew = tree.original(mv.nw);
    const nowNew = tree.get(mv.nw);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      entries.push({ key: mv.nw, row: `R ${mv.old} -> ${mv.nw}` });
      suppressed.add(`D ${mv.old}`);
      suppressed.add(`A ${mv.nw}`);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const k = was === null ? 'A' : now === null ? 'D' : 'M';
    if (suppressed.has(`${k} ${p}`)) continue;
    entries.push({ key: p, row: `${k} ${p}` });
  }
  entries.sort(
    (a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)) || Buffer.compare(Buffer.from(a.row), Buffer.from(b.row)),
  );
  const rows = entries.map((e) => e.row);
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
