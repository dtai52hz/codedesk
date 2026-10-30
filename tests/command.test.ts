import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runShellCommand } from '../electron/command.js';

const windowsOnly = { skip: process.platform !== 'win32', timeout: 8_000 };

test('PowerShell preserves Vietnamese UTF-8 output', windowsOnly, async () => {
  const result = await runShellCommand("Write-Output 'Xin chào Việt Nam, đã hoàn thành 👋'", os.tmpdir(), undefined, 5_000);
  assert.equal(result.code, 0);
  assert.equal(result.output.trim(), 'Xin chào Việt Nam, đã hoàn thành 👋');
});

test('PowerShell returns nonzero exit status together with stdout and stderr', windowsOnly, async () => {
  const result = await runShellCommand("Write-Output 'before failure'; [Console]::Error.WriteLine('expected error'); exit 7", os.tmpdir(), undefined, 5_000);
  assert.equal(result.code, 7);
  assert.match(result.output, /before failure/);
  assert.match(result.output, /expected error/);
});

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

async function forceStop(pid: number): Promise<void> {
  if (!processExists(pid)) return;
  await new Promise<void>(resolve => {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.once('error', () => { try { process.kill(pid); } catch { /* Already stopped. */ } resolve(); });
    killer.once('close', () => resolve());
  });
}

test('cancelling PowerShell promptly terminates its sleeping child process', windowsOnly, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codedesk-command-'));
  const controller = new AbortController();
  t.signal.addEventListener('abort', () => controller.abort(), { once: true });
  let childPid: number | undefined;
  const pending = runShellCommand(
    "$sleeper = Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -PassThru -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 20'); [System.IO.File]::WriteAllText((Join-Path (Get-Location) 'child.pid'), [string]$sleeper.Id); Write-Output 'child started'; Start-Sleep -Seconds 20",
    root, controller.signal, 6_000,
  );
  try {
    const deadline = Date.now() + 3_000;
    while (!childPid && Date.now() < deadline) {
      try {
        const value = Number(await fs.readFile(path.join(root, 'child.pid'), 'utf8'));
        if (Number.isInteger(value) && value > 0) childPid = value;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (!childPid) await delay(25);
    }
    assert.ok(childPid, 'PowerShell must start its child before cancellation is tested');
    assert.equal(processExists(childPid), true);
    await delay(25);
    const cancelledAt = Date.now();
    controller.abort();
    const result = await pending;
    assert.ok(Date.now() - cancelledAt < 3_000, 'cancellation should finish promptly');
    assert.equal(result.code, null);
    assert.match(result.output, /Command cancelled\./);
    const stoppedDeadline = Date.now() + 1_000;
    while (processExists(childPid) && Date.now() < stoppedDeadline) await delay(25);
    assert.equal(processExists(childPid), false, 'the nested PowerShell process must also terminate');
  } finally {
    controller.abort();
    await pending.catch(() => {});
    if (!childPid) {
      try { const value = Number(await fs.readFile(path.join(root, 'child.pid'), 'utf8')); if (Number.isInteger(value) && value > 0) childPid = value; } catch { /* No child was started. */ }
    }
    if (childPid) await forceStop(childPid);
    await fs.rm(root, { recursive: true, force: true });
  }
});
