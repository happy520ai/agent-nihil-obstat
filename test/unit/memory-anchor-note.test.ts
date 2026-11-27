import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  anchorSourceFromFileSystem,
  anchorSourceFromGraph,
  resolveAnchor,
  sha256,
  type AnchorSymbol,
  type MemoryAnchor,
} from '../../src/memory/anchor.ts';
import {
  MemoryNoteBook,
  MemoryNoteError,
  toLedgerNotePayload,
  validateMemoryNote,
} from '../../src/memory/note.ts';

async function temp(prefix: string): Promise<string> { return mkdtemp(join(tmpdir(), prefix)); }

function symbols(): AnchorSymbol[] {
  return [
    { id: 'id-alpha', file: 'src/a.ts', name: 'alpha', qualifiedName: 'alpha' },
    { id: 'id-beta', file: 'src/b.ts', name: 'beta', qualifiedName: 'scope::beta' },
  ];
}

test('resolveAnchor walks the three decreasing-confidence levels and reports stale evidence', () => {
  const files = new Map<string, string>([
    ['src/a.ts', 'export const alpha = 1;\nconst fragment = "stable";\n'],
    ['src/b.ts', 'export function beta() { return 2; }\n'],
  ]);
  const source = {
    findSymbolById: (id: string) => symbols().find((symbol) => symbol.id === id),
    findSymbolByQualifiedName: (qualifiedName: string, file: string) => symbols().find((symbol) => symbol.qualifiedName === qualifiedName && symbol.file === file),
    readFile: (file: string) => files.get(file),
  };

  const exact = resolveAnchor({ file: 'src/a.ts', symbolId: 'id-alpha' }, source);
  assert.equal(exact.status, 'exact');
  assert.equal(exact.level, 1);

  const renamedId = resolveAnchor({ file: 'src/b.ts', symbolId: 'gone', qualifiedName: 'scope::beta' }, source);
  assert.equal(renamedId.status, 'relocated');
  assert.equal(renamedId.level, 2);
  assert.equal(renamedId.reason, 'renamed-symbol-id');
  assert.equal(renamedId.file, 'src/b.ts');

  const fragment = 'const fragment = "stable";';
  const fragmentAnchor: MemoryAnchor = { file: 'src/a.ts', contentFragment: fragment, contentFragmentHash: sha256(fragment) };
  const byFragment = resolveAnchor(fragmentAnchor, source);
  assert.equal(byFragment.status, 'relocated');
  assert.equal(byFragment.level, 3);
  assert.equal(byFragment.reason, 'fragment-match');

  const fileHash = sha256(files.get('src/b.ts')!);
  const byFileHash = resolveAnchor({ file: 'src/b.ts', contentFragmentHash: fileHash }, source);
  assert.equal(byFileHash.status, 'relocated');
  assert.equal(byFileHash.reason, 'file-hash-match');

  const missingFile = resolveAnchor({ file: 'src/gone.ts', symbolId: 'nothing' }, source);
  assert.equal(missingFile.status, 'stale');
  assert.equal(missingFile.reason, 'file-missing');
  assert.equal(missingFile.file, null);

  const insufficient = resolveAnchor({ file: 'src/a.ts' }, source);
  assert.equal(insufficient.status, 'stale');
  assert.equal(insufficient.reason, 'insufficient-anchor-evidence');

  const failed = resolveAnchor({ file: 'src/a.ts', symbolId: 'unknown-id' }, source);
  assert.equal(failed.status, 'stale');
  assert.equal(failed.reason, 'relocation-failed');

  const wrongFragment = resolveAnchor({ file: 'src/a.ts', contentFragment: 'not in file', contentFragmentHash: sha256('not in file') }, source);
  assert.equal(wrongFragment.status, 'stale');
  assert.equal(wrongFragment.reason, 'relocation-failed');
});

test('anchorSourceFromGraph resolves ids and qualified names from a snapshot', () => {
  const snapshot = { symbols: symbols() } as unknown as Parameters<typeof anchorSourceFromGraph>[0];
  const source = anchorSourceFromGraph(snapshot, (file) => (file === 'src/a.ts' ? 'alpha' : undefined));
  assert.equal(source.findSymbolById('id-alpha')?.qualifiedName, 'alpha');
  assert.equal(source.findSymbolById('missing'), undefined);
  assert.equal(source.findSymbolByQualifiedName('scope::beta', 'src/b.ts')?.id, 'id-beta');
  assert.equal(source.findSymbolByQualifiedName('scope::beta', 'src/a.ts'), undefined);
  assert.equal(source.readFile('src/a.ts'), 'alpha');
  assert.equal(source.readFile('src/b.ts'), undefined);
});

test('anchorSourceFromFileSystem reads real files and treats unreadable paths as absent', async () => {
  const root = await temp('ano anchor fs ');
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    const source = anchorSourceFromFileSystem(root, symbols());
    assert.equal(source.readFile('src/a.ts'), 'export const a = 1;\n');
    assert.equal(source.readFile('src/missing.ts'), undefined);
    assert.equal(source.findSymbolById('id-beta')?.file, 'src/b.ts');
    assert.equal(source.findSymbolByQualifiedName('alpha', 'src/a.ts')?.id, 'id-alpha');
    assert.equal(source.symbolFreshness, undefined, 'an omitted freshness keeps the historical trusted default');

    const stale = anchorSourceFromFileSystem(root, symbols(), 'stale');
    assert.equal(stale.symbolFreshness, 'stale');
    assert.equal(stale.findSymbolById('id-alpha')?.id, 'id-alpha', 'the table is still readable; trust is what changes');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('resolveAnchor demotes a stale symbol table but keeps content evidence from the current file', () => {
  const files = new Map<string, string>([
    ['src/a.ts', 'export const alpha = 1;\nconst fragment = "stable";\n'],
    ['src/b.ts', 'export function beta() { return 2; }\n'],
  ]);
  const staleSource = {
    findSymbolById: (id: string) => symbols().find((symbol) => symbol.id === id),
    findSymbolByQualifiedName: (qualifiedName: string, file: string) => symbols().find((symbol) => symbol.qualifiedName === qualifiedName && symbol.file === file),
    readFile: (file: string) => files.get(file),
    symbolFreshness: 'stale' as const,
  };

  const byId = resolveAnchor({ file: 'src/a.ts', symbolId: 'id-alpha' }, staleSource);
  assert.equal(byId.status, 'stale');
  assert.equal(byId.reason, 'stale-symbol-table');

  const byName = resolveAnchor({ file: 'src/b.ts', symbolId: 'gone', qualifiedName: 'scope::beta' }, staleSource);
  assert.equal(byName.status, 'stale');
  assert.equal(byName.reason, 'stale-symbol-table');

  const missing = resolveAnchor({ file: 'src/gone.ts', symbolId: 'id-alpha' }, staleSource);
  assert.equal(missing.status, 'stale');
  assert.equal(missing.reason, 'file-missing', 'a lost file is still reported as file-missing');

  const fragment = 'const fragment = "stable";';
  const byFragment = resolveAnchor({ file: 'src/a.ts', symbolId: 'id-alpha', contentFragment: fragment, contentFragmentHash: sha256(fragment) }, staleSource);
  assert.equal(byFragment.status, 'relocated', 'content read from the current file stays trustworthy');
  assert.equal(byFragment.level, 3);
  assert.equal(byFragment.reason, 'fragment-match');
});

test('anchorSourceFromGraph carries symbol-table freshness into resolutions', () => {
  const snapshot = { symbols: symbols() } as unknown as Parameters<typeof anchorSourceFromGraph>[0];
  const readFile = (file: string) => (file === 'src/a.ts' ? 'export const alpha = 1;\n' : undefined);
  assert.equal(anchorSourceFromGraph(snapshot, readFile, 'fresh').symbolFreshness, 'fresh');
  assert.equal(resolveAnchor({ file: 'src/a.ts', symbolId: 'id-alpha' }, anchorSourceFromGraph(snapshot, readFile, 'fresh')).status, 'exact');
  assert.equal(resolveAnchor({ file: 'src/a.ts', symbolId: 'id-alpha' }, anchorSourceFromGraph(snapshot, readFile, 'degraded')).status, 'stale');
});

function noteError(run: () => unknown, pattern: RegExp): void {
  assert.throws(run, (error: unknown) => error instanceof MemoryNoteError && pattern.test((error as Error).message));
}

test('validateMemoryNote rejects malformed kinds, text and timestamps', () => {
  noteError(() => validateMemoryNote(null as unknown as Parameters<typeof validateMemoryNote>[0]), /must be an object/);
  noteError(() => validateMemoryNote({ kind: 'rumour' as never, text: 'x' }), /Unknown note kind/);
  noteError(() => validateMemoryNote({ kind: 'memory', text: 7 as unknown as string, anchor: { file: 'src/a.ts' } }), /text must be a string/);
  noteError(() => validateMemoryNote({ kind: 'memory', text: '   ', anchor: { file: 'src/a.ts' } }), /non-empty/);
  noteError(() => validateMemoryNote({ kind: 'memory', text: 'x'.repeat(100_001), anchor: { file: 'src/a.ts' } }), /exceeds/);
  noteError(() => validateMemoryNote({ kind: 'memory', text: 'x', anchor: { file: 'src/a.ts' }, createdAt: 'not-a-date' }), /ISO timestamp/);

  const summary = validateMemoryNote({ kind: 'session_summary', text: 'did things' }, '2026-02-02T00:00:00.000Z');
  assert.equal(summary.createdAt, '2026-02-02T00:00:00.000Z');
  assert.equal(summary.anchor, undefined);
  noteError(() => validateMemoryNote({ kind: 'session_summary', text: 'x', anchor: { file: 'src/a.ts' } }), /must not carry an anchor/);
  noteError(() => validateMemoryNote({ kind: 'memory', text: 'x' }), /requires an anchor/);
});

test('validateMemoryNote enforces anchor field rules and derives fragment hashes', () => {
  noteError(() => validateMemoryNote({ kind: 'memory', text: 'x', anchor: null as unknown as MemoryAnchor }), /Anchor must be an object/);
  noteError(() => validateMemoryNote({ kind: 'memory', text: 'x', anchor: { file: 'src/a.ts', line: 3 } as unknown as MemoryAnchor }), /does not accept field/);
  noteError(() => validateMemoryNote({ kind: 'memory', text: 'x', anchor: { file: '' } }), /non-empty project-relative path/);
  noteError(() => validateMemoryNote({ kind: 'memory', text: 'x', anchor: { file: 5 as unknown as string } }), /non-empty project-relative path/);
  noteError(() => validateMemoryNote({ kind: 'memory', text: 'x', anchor: { file: '../a.ts' } }), /not a normalized project-relative path/);
  noteError(() => validateMemoryNote({ kind: 'memory', text: 'x', anchor: { file: 'C:/a.ts' } }), /not a normalized/);
  noteError(() => validateMemoryNote({ kind: 'memory', text: 'x', anchor: { file: 'src/a.ts', symbolId: 'src/a.ts::alpha:12' } }), /must not contain a line number/);
  noteError(() => validateMemoryNote({ kind: 'memory', text: 'x', anchor: { file: 'src/a.ts', symbolId: '' } }), /non-empty string/);
  noteError(() => validateMemoryNote({ kind: 'memory', text: 'x', anchor: { file: 'src/a.ts', symbolId: 3 as unknown as string } }), /non-empty string/);
  noteError(() => validateMemoryNote({ kind: 'memory', text: 'x', anchor: { file: 'src/a.ts', qualifiedName: 'q'.repeat(513) } }), /exceeds 512/);
  noteError(() => validateMemoryNote({ kind: 'memory', text: 'x', anchor: { file: 'src/a.ts', contentFragment: 'f'.repeat(10_001) } }), /exceeds 10000/);
  noteError(() => validateMemoryNote({ kind: 'memory', text: 'x', anchor: { file: 'src/a.ts', contentFragmentHash: 'not-hex' } }), /lowercase SHA-256/);
  noteError(() => validateMemoryNote({
    kind: 'memory', text: 'x',
    anchor: { file: 'src/a.ts', contentFragment: 'frag', contentFragmentHash: 'a'.repeat(64) },
  }), /does not match contentFragment/);

  const derived = validateMemoryNote({ kind: 'decision', text: 'keep it', anchor: { file: 'src/a.ts', contentFragment: 'frag' } });
  assert.equal(derived.anchor?.contentFragmentHash, createHash('sha256').update('frag').digest('hex'));
  assert.equal(derived.anchor?.symbolId, undefined);
  assert.equal(derived.anchor?.qualifiedName, undefined);
  assert.equal(derived.anchor?.contentFragment, 'frag');

  const payload = toLedgerNotePayload(derived);
  assert.equal(payload.note_id, derived.id);
  assert.equal(payload.kind, 'decision');
  assert.deepEqual(payload.anchor, derived.anchor);

  const summaryPayload = toLedgerNotePayload(summaryPlaceholder());
  assert.equal('anchor' in summaryPayload, false);
});

function summaryPlaceholder() {
  return validateMemoryNote({ kind: 'session_summary', text: 'summary only' });
}

test('MemoryNoteBook is idempotent, honours createdAt ordering and calls the sink once', async () => {
  const persisted: string[] = [];
  const book = new MemoryNoteBook({ persist: (note) => { persisted.push(note.id); } });
  const first = await book.record({ kind: 'session_summary', text: 'one', createdAt: '2026-01-01T00:00:00.000Z' });
  const second = await book.record({ kind: 'session_summary', text: 'two', createdAt: '2026-01-02T00:00:00.000Z' });
  const duplicate = await book.record({ kind: 'session_summary', text: 'one', createdAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(persisted, [first.note.id, second.note.id]);
  assert.deepEqual(book.list().map((note) => note.text), ['one', 'two']);
  assert.equal(book.get(first.note.id)?.text, 'one');
  assert.equal(book.get('missing'), undefined);

  const silent = new MemoryNoteBook();
  const recorded = await silent.record({ kind: 'decision', text: 'no sink', anchor: { file: 'src/a.ts', symbolId: 'id-alpha' } });
  assert.equal(recorded.duplicate, false);
  assert.equal(recorded.note.anchor?.symbolId, 'id-alpha');
});
