// formats.ts — mend's unified diff, SEARCH/REPLACE and V4A readers, plus the
// three-tier line matcher (SPEC.md sections 5 to 8). Written fresh for this
// entry from SPEC.md. The CLI, output, safe paths, format detection, JSON
// edits and the all-or-nothing write already live in main.ts; this file only
// adds the three formats main.ts hands over to it.

export class FailInfo extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(code + ' ' + path);
    this.code = code;
    this.path = path;
  }
}

export class ParseProblem extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

export interface Store {
  get(p: string): string | null;
  set(p: string, v: string | null): void;
}

export type Op = (s: Store) => void;

// (old path, new path) of every move edit that applied, for main.ts to turn
// a delete+create pair into one `R old -> new` output line.
export const recordedMoves: Array<[string, string]> = [];

function isBlank(s: string): boolean {
  return s.trim().length === 0;
}

function splitPatch(text: string): string[] {
  if (text.length === 0) return [];
  const parts = text.split('\n');
  if (text.charAt(text.length - 1) === '\n') parts.pop();
  for (let i = 0; i < parts.length; i++) {
    const l = parts[i]!;
    if (l.charAt(l.length - 1) === '\r') parts[i] = l.slice(0, -1);
  }
  return parts;
}

function pathIsSafe(p: string): boolean {
  if (p.length === 0) return false;
  if (p.charAt(0) === '/') return false;
  if (p.indexOf('\\') >= 0) return false;
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

// --- file model (SPEC.md section 3) ---

interface FileModel {
  br: string;
  lines: string[];
  finalBreak: boolean;
}

function readModel(text: string): FileModel {
  if (text.length === 0) return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text.charAt(nl - 1) === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { br, lines: parts, finalBreak };
}

function writeModel(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBreak ? m.br : '');
}

// --- three-tier matching (SPEC.md section 5) ---

function xform(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrences(o: string[], f: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const pat = o.map((l) => xform(l, tier));
  const start = from < 0 ? 0 : from;
  for (let i = start; i + o.length <= f.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (xform(f[i + k]!, tier) !== pat[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function tierOf(o: string[], f: string[], from: number, strict: boolean): number {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    if (occurrences(o, f, t, from).length > 0) return t;
  }
  return -1;
}

function tierOfEof(o: string[], f: string[], from: number, strict: boolean): number {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const hits = occurrences(o, f, t, from);
    for (const p of hits) {
      if (p + o.length === f.length) return t;
    }
  }
  return -1;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function reindentLine(text: string, p: string, f: string): string {
  if (text.length === 0 || text.trim().length === 0) return text;
  if (!text.startsWith(p)) return text;
  return f + text.slice(p.length);
}

interface NewLine {
  text: string;
  // index into O when this is a context line, else null
  ctx: number | null;
}

function spliceLines(model: FileModel, o: string[], n: NewLine[], pos: number, tier: number): void {
  const f = pos < model.lines.length ? model.lines[pos]! : '';
  const p = o.length > 0 ? o[0]! : '';
  const fw = leadingWs(f);
  const pw = leadingWs(p);
  const rep: string[] = [];
  for (const nl of n) {
    if (nl.ctx !== null) {
      rep.push(model.lines[pos + nl.ctx]!);
    } else if (tier === 2) {
      rep.push(reindentLine(nl.text, pw, fw));
    } else {
      rep.push(nl.text);
    }
  }
  model.lines.splice(pos, o.length, ...rep);
}

// --- shared body-line shape for hunks and V4A chunks ---

interface BodyLine {
  kind: string; // ' ' context, '-' old, '+' new, '\\' no-newline marker
  text: string;
}

function splitON(body: BodyLine[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      const idx = o.length;
      o.push(b.text);
      n.push({ text: b.text, ctx: idx });
    } else if (b.kind === '-') {
      o.push(b.text);
    } else if (b.kind === '+') {
      n.push({ text: b.text, ctx: null });
    }
  }
  return { o, n };
}

// Whether a `\` line immediately follows the body's last context or `+` line.
function backslashAfterLast(body: BodyLine[]): boolean {
  for (let j = body.length - 1; j >= 0; j--) {
    const b = body[j]!;
    if (b.kind === ' ' || b.kind === '+') {
      return j + 1 < body.length && body[j + 1]!.kind === '\\';
    }
  }
  return false;
}

// --- unified diffs (SPEC.md section 6) ---

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  diffOld: string | undefined;
  diffNew: string | undefined;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function newSection(): Section {
  return {
    diffOld: undefined,
    diffNew: undefined,
    pairOld: undefined,
    pairNew: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    newFile: false,
    deletedFile: false,
    hunks: [],
  };
}

function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function isBodyLine(l: string): boolean {
  return l === '' || l.charAt(0) === ' ' || l.charAt(0) === '-' || l.charAt(0) === '+' || l.charAt(0) === '\\';
}

function applyHunks(model: FileModel, hunks: Hunk[], path: string, strict: boolean): void {
  let d = 0;
  for (const h of hunks) {
    const { o, n } = splitON(h.body);
    const noEol = backslashAfterLast(h.body);
    if (o.length === 0) {
      const at = Math.min(h.a + d, model.lines.length);
      const atEnd = at === model.lines.length;
      spliceLines(model, o, n, at, 0);
      if (atEnd) model.finalBreak = !noEol;
      d += n.length;
      continue;
    }
    const tier = tierOf(o, model.lines, 0, strict);
    if (tier < 0) throw new FailInfo('no-match', path);
    const hits = occurrences(o, model.lines, tier, 0);
    const target = h.a - 1 + d;
    let best = hits[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of hits) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const toEnd = best + o.length === model.lines.length;
    spliceLines(model, o, n, best, tier);
    if (toEnd) model.finalBreak = !noEol;
    d += n.length - o.length;
  }
}

function unifiedSectionEdit(sec: Section, strict: boolean): Op {
  const oldRaw = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
  const newRaw = sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
  const oldP: string | null = oldRaw === undefined ? null : oldRaw;
  const newP: string | null = newRaw === undefined ? null : newRaw;
  const isCreate = (oldP === null || sec.newFile) && newP !== null;
  const isDelete = !isCreate && (newP === null || sec.deletedFile) && oldP !== null;
  const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
  if (isCreate) {
    const np = newP as string;
    return (store) => {
      if (!pathIsSafe(np)) throw new FailInfo('unsafe', np);
      if (store.get(np) !== null) throw new FailInfo('exists', np);
      const plus: string[] = [];
      let lastPlusNoEol = false;
      for (const h of sec.hunks) {
        for (let j = 0; j < h.body.length; j++) {
          const b = h.body[j]!;
          if (b.kind === '+') {
            plus.push(b.text);
            lastPlusNoEol = j + 1 < h.body.length && h.body[j + 1]!.kind === '\\';
          }
        }
      }
      store.set(np, plus.length === 0 ? '' : plus.join('\n') + (lastPlusNoEol ? '' : '\n'));
    };
  }
  if (isDelete) {
    const p = oldP as string;
    return (store) => {
      if (!pathIsSafe(p)) throw new FailInfo('unsafe', p);
      if (store.get(p) === null) throw new FailInfo('missing', p);
      store.set(p, null);
    };
  }
  if (isMove) {
    const op = oldP as string;
    const np = newP as string;
    return (store) => {
      if (!pathIsSafe(op)) throw new FailInfo('unsafe', op);
      if (!pathIsSafe(np)) throw new FailInfo('unsafe', np);
      const cur = store.get(op);
      if (cur === null) throw new FailInfo('missing', op);
      if (store.get(np) !== null) throw new FailInfo('exists', np);
      const model = readModel(cur);
      applyHunks(model, sec.hunks, op, strict);
      store.set(np, writeModel(model));
      store.set(op, null);
      recordedMoves.push([op, np]);
    };
  }
  const p = (oldP as string | null) ?? (newP as string | null) ?? '';
  return (store) => {
    if (!pathIsSafe(p)) throw new FailInfo('unsafe', p);
    const cur = store.get(p);
    if (cur === null) throw new FailInfo('missing', p);
    const model = readModel(cur);
    applyHunks(model, sec.hunks, p, strict);
    store.set(p, writeModel(model));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Op[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let curHunk: Hunk | null = null;
  let inBody = false;
  const endBody = (): void => {
    if (curHunk !== null) {
      while (curHunk.body.length > 0) {
        const b = curHunk.body[curHunk.body.length - 1]!;
        if (b.kind === ' ' && b.text === '') curHunk.body.pop();
        else break;
      }
    }
    inBody = false;
    curHunk = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = i + 1 < lines.length ? lines[i + 1]! : undefined;
    if (inBody && !isBodyLine(line)) endBody();
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new ParseProblem('error: parse ' + (i + 1));
      cur = newSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!.trim();
      sections.push(cur);
      continue;
    }
    if (line.startsWith('--- ') && next !== undefined && next.startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0 || cur.pairOld !== undefined) {
        cur = newSection();
        sections.push(cur);
      }
      cur.pairOld = headerPath(line);
      cur.pairNew = headerPath(next);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null || cur === null) throw new ParseProblem('error: parse ' + (i + 1));
      curHunk = { a: parseInt(m[1]!, 10), body: [] };
      cur.hunks.push(curHunk);
      inBody = true;
      continue;
    }
    if (inBody && curHunk !== null) {
      if (line === '') curHunk.body.push({ kind: ' ', text: '' });
      else if (line.charAt(0) === ' ') curHunk.body.push({ kind: ' ', text: line.slice(1) });
      else if (line.charAt(0) === '-') curHunk.body.push({ kind: '-', text: line.slice(1) });
      else if (line.charAt(0) === '+') curHunk.body.push({ kind: '+', text: line.slice(1) });
      else curHunk.body.push({ kind: '\\', text: line.slice(1) });
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new ParseProblem('error: parse ' + (i + 2));
      if (line.startsWith('rename from ')) {
        if (cur.renameFrom === undefined) cur.renameFrom = line.slice('rename from '.length).trim();
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (cur.renameTo === undefined) cur.renameTo = line.slice('rename to '.length).trim();
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        continue;
      }
      continue;
    }
  }
  endBody();
  return sections.map((sec) => unifiedSectionEdit(sec, strict));
}

// --- SEARCH/REPLACE blocks (SPEC.md section 7) ---

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Op {
  return (store) => {
    if (!pathIsSafe(path)) throw new FailInfo('unsafe', path);
    if (oldLines.length === 0) {
      if (store.get(path) !== null) throw new FailInfo('exists', path);
      store.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = store.get(path);
    if (cur === null) throw new FailInfo('missing', path);
    const model = readModel(cur);
    const tier = tierOf(oldLines, model.lines, 0, strict);
    if (tier < 0) throw new FailInfo('no-match', path);
    const hits = occurrences(oldLines, model.lines, tier, 0);
    if (hits.length > 1) throw new FailInfo('ambiguous', path);
    const n: NewLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    spliceLines(model, oldLines, n, hits[0]!, tier);
    store.set(path, writeModel(model));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Op[] {
  const ops: Op[] = [];
  let i = 0;
  let prevPath: string | null = null;
  let prevEnd = -1;
  while (i < lines.length) {
    let sIdx = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        sIdx = j;
        break;
      }
    }
    if (sIdx < 0) break;
    let path: string | null = null;
    for (let j = sIdx - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new ParseProblem('error: parse ' + (sIdx + 1));
    }
    let eqIdx = -1;
    for (let j = sIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eqIdx = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eqIdx < 0) throw new ParseProblem('error: parse ' + (sIdx + 1));
    let repIdx = -1;
    for (let j = eqIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        repIdx = j;
        break;
      }
    }
    if (repIdx < 0) throw new ParseProblem('error: parse ' + (sIdx + 1));
    const oldLines = lines.slice(sIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, repIdx);
    ops.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = repIdx;
    i = repIdx + 1;
  }
  return ops;
}

// --- V4A patches (SPEC.md section 8) ---

interface Chunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function findAnchorLine(f: string[], anchor: string, from: number, strict: boolean): number {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    for (let i = from; i < f.length; i++) {
      if (xform(f[i]!, t) === xform(anchor, t)) return i;
    }
  }
  return -1;
}

function v4aAddEdit(path: string, content: string[]): Op {
  return (store) => {
    if (!pathIsSafe(path)) throw new FailInfo('unsafe', path);
    if (store.get(path) !== null) throw new FailInfo('exists', path);
    store.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Op {
  return (store) => {
    if (!pathIsSafe(path)) throw new FailInfo('unsafe', path);
    if (store.get(path) === null) throw new FailInfo('missing', path);
    store.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: Chunk[], strict: boolean): Op {
  return (store) => {
    if (!pathIsSafe(path)) throw new FailInfo('unsafe', path);
    if (moveTo !== null && !pathIsSafe(moveTo)) throw new FailInfo('unsafe', moveTo);
    const cur = store.get(path);
    if (cur === null) throw new FailInfo('missing', path);
    if (moveTo !== null && store.get(moveTo) !== null) throw new FailInfo('exists', moveTo);
    const model = readModel(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const at = findAnchorLine(model.lines, ch.anchor, cursor, strict);
        if (at < 0) throw new FailInfo('no-match', path);
        cursor = at + 1;
      }
      const { o, n } = splitON(ch.body);
      if (o.length === 0) {
        const at = ch.eof ? model.lines.length : cursor;
        spliceLines(model, o, n, at, 0);
        cursor = at + n.length;
        continue;
      }
      const tier = ch.eof ? tierOfEof(o, model.lines, cursor, strict) : tierOf(o, model.lines, cursor, strict);
      if (tier < 0) throw new FailInfo('no-match', path);
      const hits = occurrences(o, model.lines, tier, cursor);
      let pos = -1;
      for (const p of hits) {
        if (ch.eof && p + o.length !== model.lines.length) continue;
        pos = p;
        break;
      }
      if (pos < 0) throw new FailInfo('no-match', path);
      spliceLines(model, o, n, pos, tier);
      cursor = pos + n.length;
    }
    if (moveTo !== null) {
      store.set(moveTo, writeModel(model));
      store.set(path, null);
      recordedMoves.push([path, moveTo]);
    } else {
      store.set(path, writeModel(model));
    }
  };
}

function isSectionStart(l: string): boolean {
  return l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:') || l.trim() === '*** End Patch';
}

function v4aEdits(lines: string[], strict: boolean): Op[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseProblem('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseProblem('error: parse ' + (first + 1));
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    if (!isBlank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseProblem('error: parse ' + (lines.length + 1));
  const ops: Op[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File:')) {
      const p = line.slice('*** Add File:'.length).trim();
      i++;
      const content: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (isBlank(l)) {
          content.push('');
          i++;
          continue;
        }
        if (l.charAt(0) === '+') {
          content.push(l.slice(1));
          i++;
          continue;
        }
        throw new ParseProblem('error: parse ' + (i + 1));
      }
      while (content.length > 0 && content[content.length - 1] === '') content.pop();
      ops.push(v4aAddEdit(p, content));
      continue;
    }
    if (line.startsWith('*** Delete File:')) {
      const p = line.slice('*** Delete File:'.length).trim();
      i++;
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (isBlank(l)) {
          i++;
          continue;
        }
        throw new ParseProblem('error: parse ' + (i + 1));
      }
      ops.push(v4aDeleteEdit(p));
      continue;
    }
    if (line.startsWith('*** Update File:')) {
      const p = line.slice('*** Update File:'.length).trim();
      const updateLine = i;
      i++;
      while (i < last && isBlank(lines[i]!)) i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to:')) {
        moveTo = lines[i]!.slice('*** Move to:'.length).trim();
        i++;
      }
      const chunks: Chunk[] = [];
      let curChunk: Chunk | null = null;
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('*** Move to:')) throw new ParseProblem('error: parse ' + (i + 1));
        if (l.trim() === '*** End of File') {
          if (curChunk === null) throw new ParseProblem('error: parse ' + (i + 1));
          curChunk.eof = true;
          chunks.push(curChunk);
          curChunk = null;
          i++;
          continue;
        }
        if (l.startsWith('@@')) {
          if (curChunk !== null) chunks.push(curChunk);
          curChunk = { anchor: l.slice(2).trim(), body: [], eof: false };
          i++;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || isBlank(l)) {
          if (curChunk === null) curChunk = { anchor: null, body: [], eof: false };
          if (isBlank(l)) curChunk.body.push({ kind: ' ', text: '' });
          else if (l.charAt(0) === ' ') curChunk.body.push({ kind: ' ', text: l.slice(1) });
          else if (l.charAt(0) === '-') curChunk.body.push({ kind: '-', text: l.slice(1) });
          else curChunk.body.push({ kind: '+', text: l.slice(1) });
          i++;
          continue;
        }
        throw new ParseProblem('error: parse ' + (i + 1));
      }
      if (curChunk !== null) chunks.push(curChunk);
      if (chunks.length > 0) {
        const lastCh = chunks[chunks.length - 1]!;
        while (lastCh.body.length > 0) {
          const b = lastCh.body[lastCh.body.length - 1]!;
          if (b.kind === ' ' && b.text === '') lastCh.body.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseProblem('error: parse ' + (updateLine + 1));
      ops.push(v4aUpdateEdit(p, moveTo, chunks, strict));
      continue;
    }
    throw new ParseProblem('error: parse ' + (i + 1));
  }
  return ops;
}

// --- entry point for main.ts ---

export function parseFormats(kind: string, lines: string[], strict: boolean): Op[] {
  if (kind === 'unified') return unifiedEdits(lines, strict);
  if (kind === 'search-replace') return searchReplaceEdits(lines, strict);
  if (kind === 'v4a') return v4aEdits(lines, strict);
  throw new ParseProblem('error: format');
}
