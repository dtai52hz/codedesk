import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, type IpcMainInvokeEvent } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { AgentEvent, Bootstrap, PublicSettings, SettingsInput, Workspace } from '../shared/types.js';
import { WorkspaceFiles } from './workspace.js';
import { CodingAgent, type AgentSnapshot } from './agent.js';
import { completion, validateProviderSettings } from './provider.js';

interface StoredSettings extends Omit<PublicSettings, 'hasApiKey'> { encryptedApiKey?: string }
interface DiskState { settings: StoredSettings; workspace: Workspace | null; chat: AgentSnapshot }
const DEFAULT_SETTINGS: StoredSettings = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', maxSteps: 20, autoApproveEdits: false, autoApproveCommands: false };
const here = path.dirname(fileURLToPath(import.meta.url));
// Test and managed launches can isolate local sessions without touching the user's data.
if (process.env.CODEDESK_USER_DATA_DIR && path.isAbsolute(process.env.CODEDESK_USER_DATA_DIR)) app.setPath('userData', process.env.CODEDESK_USER_DATA_DIR);
let window: BrowserWindow | null = null;
let files: WorkspaceFiles | null = null;
let agent: CodingAgent | null = null;
let apiKey = '';
let state: DiskState = { settings: { ...DEFAULT_SETTINGS }, workspace: null, chat: { messages: [], history: [] } };
let saveQueue: Promise<void> = Promise.resolve();
let loadWarning = '';
const statePath = (): string => path.join(app.getPath('userData'), 'codedesk-state.json');
const publicSettings = (): PublicSettings => {
  const { encryptedApiKey: _encrypted, ...settings } = state.settings;
  return { ...settings, hasApiKey: !!apiKey };
};
function persist(): Promise<void> {
  const serialized = JSON.stringify(state);
  const work = saveQueue.catch(() => {}).then(async () => {
    const target = statePath();
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temp, serialized, { encoding: 'utf8', mode: 0o600 }); await fs.rename(temp, target); }
    finally { await fs.rm(temp, { force: true }).catch(() => {}); }
  });
  saveQueue = work;
  return work;
}
function emit(event: AgentEvent): void {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('codedesk:event', event);
}
function createAgent(saved?: AgentSnapshot): void {
  if (!files) { agent = null; return; }
  agent = new CodingAgent({
    files, getSettings: () => ({ ...publicSettings(), apiKey }), onEvent: emit,
    persist: async chat => { state.chat = chat; await persist(); },
    ...(saved ? { saved } : {}),
  });
}
function validateSettings(input: unknown): SettingsInput {
  if (!input || typeof input !== 'object') throw new Error('Invalid settings.');
  const value = input as SettingsInput;
  if (typeof value.baseUrl !== 'string' || typeof value.model !== 'string') throw new Error('Base URL and model must be strings.');
  const provider = validateProviderSettings(value);
  if (!Number.isInteger(value.maxSteps) || value.maxSteps < 1 || value.maxSteps > 50) throw new Error('Maximum steps must be between 1 and 50.');
  if (typeof value.autoApproveCommands !== 'boolean' || typeof value.autoApproveEdits !== 'boolean') throw new Error('Invalid approval settings.');
  if (value.apiKey !== undefined && (typeof value.apiKey !== 'string' || value.apiKey.length > 4096 || /[\r\n]/.test(value.apiKey))) throw new Error('Invalid API key.');
  return { ...provider, maxSteps: value.maxSteps, autoApproveCommands: value.autoApproveCommands, autoApproveEdits: value.autoApproveEdits, ...(value.apiKey ? { apiKey: value.apiKey.trim() } : {}), clearApiKey: value.clearApiKey === true };
}
async function load(): Promise<void> {
  try {
    const stat = await fs.stat(statePath());
    if (stat.size > 12 * 1024 * 1024) throw new Error('Saved session is too large.');
    const parsed = JSON.parse(await fs.readFile(statePath(), 'utf8')) as Partial<DiskState>;
    const candidate = { ...DEFAULT_SETTINGS, ...parsed.settings };
    const checked = validateSettings(candidate);
    state.settings = { ...DEFAULT_SETTINGS, ...checked, ...(typeof candidate.encryptedApiKey === 'string' ? { encryptedApiKey: candidate.encryptedApiKey } : {}) };
    // Never retain any accidentally persisted plaintext API key.
    delete (state.settings as StoredSettings & { apiKey?: string }).apiKey;
    delete (state.settings as StoredSettings & { clearApiKey?: boolean }).clearApiKey;
    if (state.settings.encryptedApiKey) {
      if (safeStorage.isEncryptionAvailable()) {
        try { apiKey = safeStorage.decryptString(Buffer.from(state.settings.encryptedApiKey, 'base64')); }
        catch { loadWarning = 'Không thể giải mã API key đã lưu. Hãy nhập lại trong Cài đặt.'; }
      } else loadWarning = 'Windows encryption is unavailable. Re-enter the API key when encryption is available.';
    }
    if (parsed.workspace && typeof parsed.workspace.root === 'string' && path.isAbsolute(parsed.workspace.root)) {
      try {
        files = await new WorkspaceFiles(parsed.workspace.root).initialize();
        state.workspace = { root: parsed.workspace.root, name: path.basename(parsed.workspace.root) || parsed.workspace.root };
        const chat = parsed.chat;
        if (chat && Array.isArray(chat.messages) && Array.isArray(chat.history)
          && chat.messages.every(message => message && typeof message.id === 'string' && typeof message.createdAt === 'number' && typeof message.content === 'string' && ['user', 'assistant', 'tool'].includes(message.role))
          && chat.history.every(message => message && ['user', 'assistant', 'tool'].includes(message.role) && (message.content === null || typeof message.content === 'string')
            && (message.reasoning_content === undefined || typeof message.reasoning_content === 'string')
            && (message.tool_calls === undefined || (Array.isArray(message.tool_calls) && message.tool_calls.every(call => call && typeof call.id === 'string' && call.type === 'function' && call.function && typeof call.function.name === 'string' && typeof call.function.arguments === 'string'))))) state.chat = chat;
      } catch { loadWarning = 'Thư mục dự án trước đây không còn khả dụng. Hãy chọn lại thư mục.'; }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') loadWarning = 'Không thể khôi phục phiên trước. Bạn có thể chọn dự án và nhập lại cài đặt.';
  }
  createAgent(state.chat);
}
function requireAgent(): CodingAgent { if (!agent) throw new Error('Choose a project folder first.'); return agent; }
function requireFiles(): WorkspaceFiles { if (!files) throw new Error('Choose a project folder first.'); return files; }
function authorized(event: IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Unauthorized IPC sender.');
  const actual = new URL(event.senderFrame.url);
  const dev = process.env.VITE_DEV_SERVER_URL;
  if (dev) {
    if (actual.origin !== new URL(dev).origin) throw new Error('Unauthorized page.');
  } else if (actual.protocol !== 'file:' || fileURLToPath(actual) !== path.resolve(here, '../../dist/index.html')) throw new Error('Unauthorized page.');
}
function handle(channel: string, action: (...args: unknown[]) => unknown): void {
  ipcMain.handle(`codedesk:${channel}`, (event, ...args: unknown[]) => { authorized(event); return action(...args); });
}
function stringArg(value: unknown, max = 20_000): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error('Invalid text argument.');
  return value;
}
function registerIpc(): void {
  handle('bootstrap', (): Bootstrap => {
    if (loadWarning) { setTimeout(() => emit({ type: 'error', message: loadWarning }), 300); }
    return { settings: publicSettings(), workspace: state.workspace, messages: agent?.messages ?? [], version: app.getVersion() };
  });
  handle('save-settings', async input => {
    if (agent?.busy) throw new Error('Stop the active task before changing settings.');
    const checked = validateSettings(input);
    let encrypted = state.settings.encryptedApiKey;
    let nextKey = apiKey;
    if (checked.clearApiKey) { encrypted = undefined; nextKey = ''; }
    if (checked.apiKey) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows secure key storage is unavailable. Your key was not saved.');
      encrypted = safeStorage.encryptString(checked.apiKey).toString('base64');
      nextKey = checked.apiKey;
    }
    const { apiKey: _secret, clearApiKey: _clear, ...settings } = checked;
    state.settings = { ...settings, ...(encrypted ? { encryptedApiKey: encrypted } : {}) };
    apiKey = nextKey;
    await persist(); return publicSettings();
  });
  handle('test-connection', async input => {
    const checked = validateSettings(input);
    const key = checked.apiKey || (checked.clearApiKey ? '' : apiKey);
    if (!key) return { ok: false, message: 'Nhập API key trước khi kiểm tra.' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      const result = await completion({ ...checked, apiKey: key, messages: [{ role: 'user', content: 'Call the connection_ping function once with no arguments to verify tool calling. Do not answer in text.' }], tools: [{ type: 'function', function: { name: 'connection_ping', description: 'Harmless tool calling capability check; returns pong.', parameters: { type: 'object', properties: {}, additionalProperties: false } } }], signal: controller.signal });
      if (!result.message.tool_calls?.some(call => call.function.name === 'connection_ping')) return { ok: false, message: `API phản hồi, nhưng ${checked.model} chưa gọi được công cụ. Hãy chọn model hoặc nhà cung cấp hỗ trợ tool calling.` };
      return { ok: true, message: `Kết nối và tool calling hoạt động với ${checked.model}.` };
    } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
    finally { clearTimeout(timer); }
  });
  handle('choose-workspace', async () => {
    if (agent?.busy) throw new Error('Stop the active task before switching projects.');
    const result = await dialog.showOpenDialog(window!, { title: 'Chọn thư mục dự án', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const root = await fs.realpath(result.filePaths[0]);
    files = await new WorkspaceFiles(root).initialize();
    state.workspace = { root, name: path.basename(root) || root };
    state.chat = { messages: [], history: [] };
    createAgent(); await persist();
    emit({ type: 'workspace', workspace: state.workspace }); return state.workspace;
  });
  handle('list-files', relative => requireFiles().listFiles(relative === undefined ? '' : stringArg(relative, 4096)));
  handle('read-file', relative => requireFiles().readFile(stringArg(relative, 4096)));
  handle('write-file', async value => {
    if (!value || typeof value !== 'object') throw new Error('Invalid file.');
    const file = value as { path: unknown; content: unknown };
    await requireAgent().writeFile({ path: stringArg(file.path, 4096), content: stringArg(file.content, 512 * 1024) });
  });
  handle('send-message', content => requireAgent().send(stringArg(content, 32_000)));
  handle('stop', () => { agent?.stop(); });
  handle('new-chat', () => requireAgent().newChat());
  handle('approval', (id, approved) => { if (typeof approved !== 'boolean') throw new Error('Invalid approval.'); requireAgent().respondApproval(stringArg(id, 100), approved); });
  handle('run-command', command => requireAgent().runCommand(stringArg(command, 12_000)));
  handle('open-external', async value => {
    const url = new URL(stringArg(value, 4096));
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Only HTTPS links can be opened.');
    await shell.openExternal(url.href);
  });
  ipcMain.on('codedesk:window-controls', (event, action: unknown) => {
    try { authorized(event); } catch { return; }
    if (action === 'minimize') window?.minimize();
    else if (action === 'maximize') { if (window?.isMaximized()) window.unmaximize(); else window?.maximize(); }
    else if (action === 'close') window?.close();
  });
}
async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    width: 1440, height: 940, minWidth: 1000, minHeight: 650, frame: false, backgroundColor: '#111215', show: false,
    title: 'CodeDesk', autoHideMenuBar: true, icon: path.resolve(here, '../../resources/icon.png'),
    webPreferences: { preload: path.join(here, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  const dev = process.env.VITE_DEV_SERVER_URL;
  const connect = dev ? `'self' ${new URL(dev).origin} ${new URL(dev).origin.replace(/^http/, 'ws')}` : "'self'";
  window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [`default-src 'self'; script-src 'self'${dev ? " 'unsafe-inline'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src ${connect}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'`] } });
  });
  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => { agent?.stop(); window = null; });
  if (dev) await window.loadURL(dev);
  else await window.loadFile(path.resolve(here, '../../dist/index.html'));
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else {
  app.setName('CodeDesk');
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  app.whenReady().then(async () => { await load(); registerIpc(); await createWindow(); }).catch(error => { dialog.showErrorBox('CodeDesk startup error', error instanceof Error ? error.message : String(error)); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => agent?.stop());
}
