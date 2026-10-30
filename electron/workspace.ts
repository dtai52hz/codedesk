import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { FileEntry, FileContent } from '../shared/types.js';

const MAX_FILE_BYTES = 512 * 1024;
const IGNORED = new Set(['node_modules', 'vendor', 'dist', 'dist-electron', 'build', 'coverage', '.next', '.nuxt', '.cache', '.idea', '.vscode']);
function forbiddenPart(part: string): boolean {
  const lower = part.toLowerCase();
  return lower === '.git' || lower === '.ssh' || lower === '.aws' || lower === '.azure' || lower === '.gnupg' || /^\.env(?:\.|$)/i.test(part)
    || /(?:^|[._-])(?:credentials?|secrets?|private[-_]?key)(?:[._-]|$)/i.test(part)
    || /\.(?:pem|key|p12|pfx|keystore|jks)$/i.test(part) || ['id_rsa', 'id_ed25519', '.npmrc', '.pypirc', '.netrc'].includes(lower);
}
function digest(content: string | null): string { return createHash('sha256').update(content === null ? '\0missing' : `\0exists${content}`).digest('hex'); }
export interface PreparedWrite { relative: string; before: string; after: string; exists: boolean; commit(): Promise<void> }

/** Every operation rechecks real paths, including the nearest existing parent of new files. */
export class WorkspaceFiles {
  private canonicalRoot = '';
  constructor(readonly root: string) {}
  async initialize(): Promise<this> {
    this.canonicalRoot = await fs.realpath(this.root);
    if (!(await fs.stat(this.canonicalRoot)).isDirectory()) throw new Error('Workspace must be a directory.');
    return this;
  }
  private inside(target: string): boolean {
    const relative = path.relative(this.canonicalRoot, target);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  }
  async resolve(relative: string, allowMissing = false): Promise<string> {
    if (!this.canonicalRoot) await this.initialize();
    if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative) || /^[a-z]:/i.test(relative) || relative.includes(':')) throw new Error('Use a relative workspace path.');
    const parts = relative.split(/[\\/]+/).filter(Boolean);
    if (parts.some(part => part === '..' || forbiddenPart(part))) throw new Error('This path is outside the workspace or contains a protected secret or Git file.');
    const target = path.resolve(this.canonicalRoot, ...parts);
    if (!this.inside(target)) throw new Error('Path escapes the workspace.');
    let current = target;
    while (true) {
      try {
        const actual = await fs.realpath(current);
        if (!this.inside(actual)) throw new Error('Symbolic links and junctions may not escape the workspace.');
        // Secret names must also be checked on the resolved target of a link.
        if (path.relative(this.canonicalRoot, actual).split(path.sep).some(forbiddenPart)) throw new Error('Protected file cannot be accessed through a link.');
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !allowMissing || current === this.canonicalRoot) throw error;
        current = path.dirname(current);
      }
    }
    return target;
  }
  async listFiles(relative = ''): Promise<FileEntry[]> {
    const directory = await this.resolve(relative);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const result: FileEntry[] = [];
    for (const entry of entries) {
      if (forbiddenPart(entry.name) || IGNORED.has(entry.name.toLowerCase())) continue;
      const child = path.posix.join(relative.replaceAll('\\', '/'), entry.name);
      try {
        const target = await this.resolve(child);
        const stat = await fs.stat(target);
        if (stat.isFile() || stat.isDirectory()) result.push({ path: child, name: entry.name, kind: stat.isDirectory() ? 'directory' : 'file' });
      } catch { /* Unsafe and broken links are hidden. */ }
      if (result.length >= 1000) break;
    }
    return result.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1);
  }
  async readFile(relative: string): Promise<FileContent> {
    const target = await this.resolve(relative);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error('Path is not a regular file.');
    if (stat.size > MAX_FILE_BYTES) throw new Error('File is too large (maximum 512 KiB).');
    const buffer = await fs.readFile(target);
    if (buffer.includes(0)) throw new Error('Binary files cannot be read as text.');
    return { path: relative.replaceAll('\\', '/'), content: buffer.toString('utf8') };
  }
  async prepareWrite(relative: string, content: string): Promise<PreparedWrite> {
    if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_FILE_BYTES || content.includes('\0')) throw new Error('Text files must be no larger than 512 KiB.');
    await this.resolve(relative, true);
    let before: string | null = null;
    try { before = (await this.readFile(relative)).content; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const expected = digest(before);
    return {
      relative: relative.replaceAll('\\', '/'), before: before ?? '', after: content, exists: before !== null,
      commit: async () => {
        const target = await this.resolve(relative, true);
        let current: string | null = null;
        try { current = (await this.readFile(relative)).content; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (digest(current) !== expected) throw new Error('The file changed while awaiting approval. Read it again and retry the edit.');
        await fs.mkdir(path.dirname(target), { recursive: true });
        await this.resolve(relative, true);
        // Use exclusive creation for new files; existing files were rechecked above.
        await fs.writeFile(target, content, { encoding: 'utf8', flag: before === null ? 'wx' : 'w' });
      },
    };
  }
  async search(query: string, relative = ''): Promise<string> {
    if (!query || query.length > 500) throw new Error('Provide a search string of 1–500 characters.');
    const matches: string[] = [];
    const visited = new Set<string>();
    let files = 0;
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > 20 || files >= 1500 || matches.length >= 150) return;
      const real = await fs.realpath(await this.resolve(directory));
      if (visited.has(real)) return;
      visited.add(real);
      for (const entry of await this.listFiles(directory)) {
        if (matches.length >= 150 || files >= 1500) return;
        if (entry.kind === 'directory') { await walk(entry.path, depth + 1); continue; }
        files++;
        try {
          const { content } = await this.readFile(entry.path);
          for (const [index, line] of content.split(/\r?\n/).entries()) {
            if (line.toLowerCase().includes(query.toLowerCase())) matches.push(`${entry.path}:${index + 1}: ${line.slice(0, 500)}`);
            if (matches.length >= 150) break;
          }
        } catch { /* Skip binary, protected or large files. */ }
      }
    };
    const target = await this.resolve(relative);
    if ((await fs.stat(target)).isDirectory()) await walk(relative, 0);
    else {
      const { content } = await this.readFile(relative);
      content.split(/\r?\n/).forEach((line, i) => { if (matches.length < 150 && line.toLowerCase().includes(query.toLowerCase())) matches.push(`${relative}:${i + 1}: ${line.slice(0, 500)}`); });
    }
    return matches.length ? matches.join('\n') : 'No matches found.';
  }
}
