import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codedesk-smoke-'));
const workspace = path.join(temp, 'project');
const profile = path.join(temp, 'profile');
const artifacts = path.join(root, 'test-results');
await fs.mkdir(workspace);
await fs.mkdir(artifacts, { recursive: true });
await fs.writeFile(path.join(workspace, 'README.md'), '# Smoke project\nA harmless local fixture.\n');
let calls = 0;
const server = http.createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  assert.equal(request.url, '/v1/chat/completions');
  assert.equal(request.headers.authorization, 'Bearer smoke-key-never-real');
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = delta => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
  const tool = (id, name, args) => {
    send({ role: 'assistant', reasoning_content: 'Local mock response.' });
    send({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] });
    const json = JSON.stringify(args);
    const middle = Math.floor(json.length / 2);
    send({ tool_calls: [{ index: 0, function: { arguments: json.slice(0, middle) } }] });
    send({ tool_calls: [{ index: 0, function: { arguments: json.slice(middle) } }] });
  };
  if (body.tools?.length === 1) {
    tool('ping-1', body.tools[0].function.name, {});
  } else {
    calls++;
    const completed = new Set(body.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls ?? []).map(call => call.function.name));
    if (!completed.has('read_file')) tool('read-1', 'read_file', { path: 'README.md' });
    else if (!completed.has('write_file')) tool('write-1', 'write_file', { path: 'hello.txt', content: 'Xin chào từ CodeDesk!\n' });
    else if (!completed.has('run_command')) tool('command-1', 'run_command', { command: "Write-Output 'CodeDesk smoke OK'" });
    else {
      send({ content: 'Đã tạo **hello.txt** và chạy kiểm tra.\n\n' });
      send({ content: '`CodeDesk smoke OK` — hoàn thành.' });
    }
  }
  response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 123, completion_tokens: 45 } })}\n\n`);
  response.end('data: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const env = { ...process.env, CODEDESK_USER_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
const launch = () => electron.launch({
  ...(process.env.CODEDESK_EXECUTABLE ? { executablePath: process.env.CODEDESK_EXECUTABLE, args: [] } : { args: [root] }),
  env,
  timeout: 60_000,
});
let app;
try {
  app = await launch();
  if (process.env.CODEDESK_EXECUTABLE) assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !!window.codeDesk, { timeout: 20_000 });
  await page.waitForTimeout(400);
  const boot = await page.evaluate(() => window.codeDesk.bootstrap());
  assert.equal(boot.settings.hasApiKey, false, 'Isolated clean profile expected');
  await page.screenshot({ path: path.join(artifacts, 'desktop-welcome.png') });
  await page.getByRole('button', { name: 'Cài đặt & kết nối' }).click();
  await page.getByLabel('Địa chỉ API', { exact: false }).fill(baseUrl);
  await page.getByLabel('Tên model', { exact: false }).fill('mock-coder');
  await page.getByLabel('Số bước tối đa', { exact: false }).fill('8');
  await page.getByLabel('API key', { exact: false }).fill('smoke-key-never-real');
  await page.getByRole('button', { name: 'Kiểm tra kết nối', exact: true }).click();
  await page.getByText('Kết nối và tool calling hoạt động với mock-coder.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Lưu cài đặt', exact: true }).click();
  await page.getByText('Đã lưu cài đặt. Bạn có thể bắt đầu giao việc.', { exact: true }).waitFor();
  const saved = await page.evaluate(() => window.codeDesk.bootstrap());
  assert.equal(saved.settings.hasApiKey, true);
  assert.equal('apiKey' in saved.settings, false, 'API key must not be returned to renderer');
  const stored = await fs.readFile(path.join(profile, 'codedesk-state.json'), 'utf8');
  assert.equal(stored.includes('smoke-key-never-real'), false, 'API key must not be stored in plaintext');
  assert.ok(JSON.parse(stored).settings.encryptedApiKey);
  await page.screenshot({ path: path.join(artifacts, 'desktop-settings.png') });
  await page.getByRole('button', { name: 'Đóng cài đặt', exact: true }).click();
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, workspace);
  await page.getByRole('button', { name: 'Mở thư mục', exact: true }).click();
  await page.getByRole('button', { name: 'README.md', exact: true }).waitFor();
  const opened = await page.evaluate(() => window.codeDesk.bootstrap());
  assert.equal(opened.workspace.root, workspace);
  // Collect approvals in addition to rendering the actual approval controls.
  await page.evaluate(() => {
    window.__approvals = [];
    window.__statuses = [];
    window.codeDesk.onEvent(event => {
      if (event.type === 'approval') window.__approvals.push(event.approval);
      if (event.type === 'status') window.__statuses.push(event.status);
    });
  });
  await page.getByRole('textbox', { name: 'Nội dung giao việc cho agent', exact: true }).fill('Tạo hello.txt và chạy kiểm tra.');
  await page.getByRole('button', { name: 'Gửi yêu cầu', exact: true }).click();
  await page.waitForFunction(() => window.__approvals?.length === 1);
  assert.equal((await fs.readdir(workspace)).includes('hello.txt'), false, 'Edit cannot happen before approval');
  await page.screenshot({ path: path.join(artifacts, 'desktop-edit-approval.png') });
  // Use the rendered approval button; fallback test details remain available through bridge.
  await page.getByRole('button', { name: 'Cho phép', exact: true }).click();
  await page.waitForFunction(() => window.__approvals?.length === 2);
  assert.equal(await fs.readFile(path.join(workspace, 'hello.txt'), 'utf8'), 'Xin chào từ CodeDesk!\n');
  const commandApproval = await page.evaluate(() => window.__approvals[1]);
  assert.equal(commandApproval.kind, 'command');
  await page.screenshot({ path: path.join(artifacts, 'desktop-command-approval.png') });
  await page.getByRole('button', { name: 'Cho phép', exact: true }).click();
  await page.waitForFunction(() => window.__statuses?.includes('idle'));
  const done = await page.evaluate(() => window.codeDesk.bootstrap());
  assert.equal(calls, 4, 'Agent must read, edit, execute, then summarize');
  assert.ok(done.messages.some(message => message.toolName === 'run_command' && message.success && message.content.includes('CodeDesk smoke OK')));
  assert.ok(done.messages.some(message => message.role === 'assistant' && message.content.includes('hoàn thành')));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(artifacts, 'desktop-complete.png') });
  await page.getByRole('button', { name: 'hello.txt', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Mã nguồn hello.txt', exact: true });
  await editor.fill('Đã sửa bằng trình soạn thảo.\n');
  await page.getByRole('button', { name: 'Lưu file', exact: true }).click();
  await page.getByRole('button', { name: 'Đã lưu', exact: true }).waitFor();
  assert.equal(await fs.readFile(path.join(workspace, 'hello.txt'), 'utf8'), 'Đã sửa bằng trình soạn thảo.\n');
  await page.getByRole('button', { name: 'Mở terminal', exact: true }).click();
  await page.getByRole('textbox', { name: 'Lệnh terminal', exact: true }).fill("Write-Output 'Manual terminal verified'");
  await page.getByRole('textbox', { name: 'Lệnh terminal', exact: true }).press('Enter');
  await page.locator('.terminal-output pre').filter({ hasText: 'Manual terminal verified' }).waitFor();
  await page.screenshot({ path: path.join(artifacts, 'desktop-editor-terminal.png') });
  // Check the smallest supported window for horizontal overflow.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 650));
  await page.screenshot({ path: path.join(artifacts, 'desktop-small.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  assert.deepEqual(errors, [], 'Renderer errors');
  // UI page must have the bridge and actual app content after all events.
  assert.ok((await page.locator('body').innerText()).includes('CodeDesk'));
  await app.close(); app = undefined;
  // Reopen to prove local history, project and encrypted key survive restart.
  app = await launch();
  const restoredPage = await app.firstWindow();
  await restoredPage.waitForFunction(() => !!window.codeDesk);
  const restored = await restoredPage.evaluate(() => window.codeDesk.bootstrap());
  assert.equal(restored.settings.hasApiKey, true);
  assert.equal(restored.workspace.root, workspace);
  assert.equal(restored.messages.length, done.messages.length + 1, 'Manual command tool log also persists');
  console.log('PASS desktop: UI API form, tool-capable API, project picker, chat composer, read → approved write → approved PowerShell → result, editor save, manual terminal, small window, restart persistence.');
  console.log(`Screenshots: ${artifacts}`);
} finally {
  if (app) await app.close().catch(() => {});
  await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(temp);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('codedesk-smoke-')) {
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
  }
}
