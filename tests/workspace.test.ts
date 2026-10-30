import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkspaceFiles } from '../electron/workspace.js';

async function workspace(t: TestContext) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codedesk-files-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'project');
  await fs.mkdir(root);
  const files = await new WorkspaceFiles(root).initialize();
  return { temp, root, files };
}

test('nested edits are reviewable before commit and searchable afterward', async t => {
  const { root, files } = await workspace(t);
  await fs.writeFile(path.join(root, 'README.md'), 'Project notes');
  const edit = await files.prepareWrite('src/nested/example.ts', 'const label = "Hello";\n// HELLO again\n');
  assert.equal(edit.relative, 'src/nested/example.ts');
  assert.equal(edit.before, '');
  assert.match(edit.after, /Hello/);
  await assert.rejects(fs.access(path.join(root, 'src/nested/example.ts')), { code: 'ENOENT' });
  await edit.commit();
  assert.equal((await files.readFile('src/nested/example.ts')).content, edit.after);
  assert.deepEqual((await files.listFiles()).map(entry => [entry.name, entry.kind]), [['src', 'directory'], ['README.md', 'file']]);
  assert.equal(await files.search('hello'), 'src/nested/example.ts:1: const label = "Hello";\nsrc/nested/example.ts:2: // HELLO again');
  const replacement = await files.prepareWrite('src/nested/example.ts', 'export const ready = true;\n');
  assert.equal(replacement.before, edit.after);
  await replacement.commit();
  assert.equal(await files.search('Hello', 'src'), 'No matches found.');
});

test('absolute paths, parent traversal and Windows alternate streams are refused', async t => {
  const { files, temp } = await workspace(t);
  for (const unsafe of ['../outside.txt', 'src/../../outside.txt', '..\\outside.txt', path.join(temp, 'outside.txt'), 'C:outside.txt', '\\\\server\\share\\file.txt', 'safe.txt:hidden', 'bad\0name']) {
    await assert.rejects(files.readFile(unsafe), undefined, unsafe);
    await assert.rejects(files.prepareWrite(unsafe, 'unsafe'), undefined, unsafe);
  }
});

test('secret and Git files are excluded from reads, listing and search', async t => {
  const { root, files } = await workspace(t);
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, '.ssh'));
  await fs.mkdir(path.join(root, 'node_modules'));
  const protectedPaths = ['.env', '.env.local', '.git/config', '.ssh/config', 'server.key', 'service-credentials.json', '.npmrc'];
  for (const name of [...protectedPaths, 'node_modules/dependency.js']) await fs.writeFile(path.join(root, name), 'private-marker');
  await fs.writeFile(path.join(root, 'public.ts'), 'public text');
  for (const name of protectedPaths) {
    await assert.rejects(files.readFile(name), /protected|secret|Git/i, name);
    await assert.rejects(files.prepareWrite(name, 'replace'), /protected|secret|Git/i, name);
  }
  assert.deepEqual((await files.listFiles()).map(entry => entry.name), ['public.ts']);
  assert.equal(await files.search('private-marker'), 'No matches found.');
});

test('junctions cannot expose files outside the workspace or hide protected directories', async t => {
  const { temp, root, files } = await workspace(t);
  const outside = path.join(temp, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'notes.txt'), 'outside-marker');
  await fs.mkdir(path.join(root, '.ssh'));
  await fs.writeFile(path.join(root, '.ssh', 'config'), 'secret-marker');
  await fs.symlink(outside, path.join(root, 'external'), 'junction');
  await fs.symlink(path.join(root, '.ssh'), path.join(root, 'innocent'), 'junction');
  for (const alias of ['external/notes.txt', 'innocent/config']) {
    await assert.rejects(files.readFile(alias), /escape|Protected/i);
    await assert.rejects(files.prepareWrite(alias, 'replacement'), /escape|Protected/i);
  }
  await assert.rejects(files.prepareWrite('external/new/sub/file.txt', 'unsafe'), /escape/i);
  assert.deepEqual(await files.listFiles(), []);
  assert.equal(await files.search('marker'), 'No matches found.');
  assert.equal(await fs.readFile(path.join(outside, 'notes.txt'), 'utf8'), 'outside-marker');
});

test('approval cannot overwrite files changed or created after the preview', async t => {
  const { root, files } = await workspace(t);
  await fs.writeFile(path.join(root, 'existing.ts'), 'original');
  const changed = await files.prepareWrite('existing.ts', 'agent edit');
  await fs.writeFile(path.join(root, 'existing.ts'), 'user edit');
  await assert.rejects(changed.commit(), /changed while awaiting approval/i);
  assert.equal((await files.readFile('existing.ts')).content, 'user edit');
  const created = await files.prepareWrite('new.ts', 'agent creation');
  await fs.writeFile(path.join(root, 'new.ts'), 'user creation');
  await assert.rejects(created.commit(), /changed while awaiting approval/i);
  assert.equal((await files.readFile('new.ts')).content, 'user creation');
  const movedParent = await files.prepareWrite('nested/new.ts', 'agent creation');
  const outside = path.join(path.dirname(root), 'replacement-target');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(root, 'nested'), 'junction');
  await assert.rejects(movedParent.commit(), /escape/i);
  await assert.rejects(fs.access(path.join(outside, 'new.ts')), { code: 'ENOENT' });
});

test('binary and oversized files cannot become model context or text edits', async t => {
  const { root, files } = await workspace(t);
  await fs.writeFile(path.join(root, 'binary.dat'), Buffer.from([65, 0, 66]));
  await fs.writeFile(path.join(root, 'large.txt'), Buffer.alloc(512 * 1024 + 1, 65));
  await assert.rejects(files.readFile('binary.dat'), /Binary/i);
  await assert.rejects(files.readFile('large.txt'), /too large/i);
  await assert.rejects(files.prepareWrite('new.txt', 'a'.repeat(512 * 1024 + 1)), /512 KiB/i);
  await assert.rejects(files.prepareWrite('new.txt', 'a\0b'), /512 KiB/i);
  assert.equal(await files.search('AAA'), 'No matches found.');
});
