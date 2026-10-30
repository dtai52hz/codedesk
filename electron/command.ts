import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface CommandResult { code: number | null; output: string }
export async function runShellCommand(command: string, cwd: string, signal?: AbortSignal, timeoutMs = 120_000): Promise<CommandResult> {
  if (typeof command !== 'string' || !command.trim() || command.length > 12_000 || command.includes('\0')) throw new Error('Enter a command of up to 12,000 characters.');
  if (signal?.aborted) throw new Error('Cancelled.');
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    const utf8Command = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; $OutputEncoding = [Console]::OutputEncoding; ${command}`;
    const child = spawn(windows ? 'powershell.exe' : '/bin/sh', windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', utf8Command] : ['-c', command], {
      cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: !windows,
    });
    let output = '', bytes = 0, finished = false, reason = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const stop = (why: string): void => {
      if (finished || reason) return;
      reason = why;
      if (windows && child.pid) {
        // taskkill /T covers grandchildren created by PowerShell.
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      } else child.kill();
    };
    const appendText = (text: string): void => {
      if (output.length < 64_000) output += text.slice(0, 64_000 - output.length);
    };
    const append = (chunk: Buffer, decoder: StringDecoder): void => {
      bytes += chunk.length;
      appendText(decoder.write(chunk));
      if (bytes > 256_000) stop('Command stopped: output exceeded 256 KiB.');
    };
    child.stdout.on('data', (chunk: Buffer) => append(chunk, stdoutDecoder));
    child.stderr.on('data', (chunk: Buffer) => append(chunk, stderrDecoder));
    const abort = (): void => stop('Command cancelled.');
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => stop(`Command stopped after ${Math.round(timeoutMs / 1000)} seconds.`), timeoutMs);
    const cleanup = (): void => { finished = true; clearTimeout(timeout); signal?.removeEventListener('abort', abort); };
    child.on('error', error => { cleanup(); reject(new Error(`Could not start terminal: ${error.message}`)); });
    child.on('close', code => {
      cleanup();
      appendText(stdoutDecoder.end());
      appendText(stderrDecoder.end());
      if (bytes > 64_000) output += '\n[Output truncated.]';
      if (reason) output += `\n${reason}`;
      resolve({ code: reason ? null : code, output: output || '(No output.)' });
    });
    if (signal?.aborted) abort();
  });
}
