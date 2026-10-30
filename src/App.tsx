import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { diffLines } from 'diff';
import { ArrowDown, ArrowUp, ArrowUpRight, Bot, Braces, Check, CheckCheck, ChevronDown, ChevronRight, Circle, CircleAlert, Code2, Command, Copy, FileCode2, FileDiff, FileText, Folder, FolderOpen, FolderPlus, GitBranch, Layers, Loader2, Maximize2, MessageSquare, Minus, PanelLeftClose, PanelLeftOpen, Play, Plus, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, Square, TerminalSquare, Trash2, Unplug, WandSparkles, X } from 'lucide-react';
import type { AgentEvent, AgentStatus, ApprovalRequest, ChatMessage, DesktopBridge, FileContent, FileEntry, PublicSettings, SettingsInput, Workspace } from '../shared/types';

const initialSettings: PublicSettings = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', hasApiKey: false, maxSteps: 20, autoApproveEdits: false, autoApproveCommands: false };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const filename = (path: string) => path.split(/[\\/]/).pop() || path;
const relativePath = (path: string, root?: string) => root && path.toLowerCase().startsWith(root.toLowerCase()) ? path.slice(root.length).replace(/^[\\/]/, '').replace(/\\/g, '/') : path;
const statusLabels: Record<AgentStatus, string> = { idle: 'Sẵn sàng', thinking: 'Đang suy nghĩ', working: 'Đang làm việc', waiting: 'Chờ bạn duyệt' };
interface ToolActivity { id: string; name: string; arguments: string; output?: string; success?: boolean; createdAt: number }

function IconButton({ label, children, onClick, disabled, className = '', active = false }: { label: string; children: ReactNode; onClick?: () => void; disabled?: boolean; className?: string; active?: boolean }) {
  return <button type="button" title={label} aria-label={label} className={`icon-button ${active ? 'active' : ''} ${className}`} onClick={onClick} disabled={disabled}>{children}</button>;
}

function Markdown({ content, bridge, onError }: { content: string; bridge?: DesktopBridge; onError: (error: unknown) => void }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ href, children }) => <a href={href} onClick={event => { event.preventDefault(); if (href && /^https:\/\//.test(href)) void bridge?.openExternal(href).catch(onError); else onError('Chỉ có thể mở liên kết HTTPS từ cuộc trò chuyện.'); }}>{children}</a>,
    pre: ({ children }) => <pre className="markdown-code">{children}</pre>,
  }}>{content}</ReactMarkdown>;
}

function SettingsModal({ settings, bridge, onClose, onSaved }: { settings: PublicSettings; bridge?: DesktopBridge; onClose: () => void; onSaved: (settings: PublicSettings) => void }) {
  const [form, setForm] = useState<SettingsInput>({ ...settings, apiKey: '' });
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    modalRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
      if (event.key === 'Tab' && modalRef.current) {
        const elements = Array.from(modalRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]'));
        const first = elements[0]; const last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [onClose, busy]);
  const change = <K extends keyof SettingsInput>(key: K, value: SettingsInput[K]) => { setForm(current => ({ ...current, [key]: value })); setFeedback(null); };
  async function submit(action: 'save' | 'test') {
    if (!bridge) { setFeedback({ ok: false, message: 'Hãy mở CodeDesk bằng ứng dụng desktop để kết nối API.' }); return; }
    if (!form.baseUrl.trim() || !form.model.trim()) { setFeedback({ ok: false, message: 'Nhập địa chỉ API và tên model.' }); return; }
    setBusy(action); setFeedback(null);
    try {
      if (action === 'test') setFeedback(await bridge.testConnection(form));
      else { const saved = await bridge.saveSettings(form); onSaved(saved); setForm(current => ({ ...current, apiKey: '', clearApiKey: false })); setFeedback({ ok: true, message: 'Đã lưu cài đặt. Bạn có thể bắt đầu giao việc.' }); }
    } catch (error) { setFeedback({ ok: false, message: errorText(error) }); }
    finally { setBusy(null); }
  }
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-heading" ref={modalRef}>
      <div className="modal-heading"><div><span className="eyebrow">KHÔNG GIAN CỦA BẠN</span><h2 id="settings-heading">Kết nối API</h2><p>Dùng DeepSeek hoặc nhà cung cấp tương thích OpenAI API.</p></div><IconButton label="Đóng cài đặt" onClick={onClose} disabled={!!busy}><X size={18} /></IconButton></div>
      <form onSubmit={event => { event.preventDefault(); void submit('save'); }}>
        <div className="provider-card"><div className="provider-logo"><Braces size={23} /></div><div><strong>API tùy chỉnh</strong><span>Model của bạn. Dự án trên máy bạn.</span></div><span className={`badge ${settings.hasApiKey ? 'green' : ''}`}>{settings.hasApiKey ? 'Đã có khóa' : 'Chưa có khóa'}</span></div>
        <label className="field">Địa chỉ API <input type="url" value={form.baseUrl} onChange={event => change('baseUrl', event.target.value)} placeholder="https://api.deepseek.com" required autoComplete="off" spellCheck={false} /></label>
        <div className="field-grid"><label className="field">Tên model <input value={form.model} onChange={event => change('model', event.target.value)} placeholder="deepseek-flash" required autoComplete="off" spellCheck={false} /></label><label className="field">Số bước tối đa <input type="number" value={form.maxSteps} min={1} max={50} onChange={event => change('maxSteps', Number(event.target.value))} required /></label></div>
        <label className="field">API key <span className="field-optional">{settings.hasApiKey ? 'Để trống để giữ khóa hiện tại' : 'Nhập khóa từ nhà cung cấp'}</span><input type="password" value={form.apiKey} maxLength={4096} onChange={event => { change('apiKey', event.target.value); if (event.target.value) change('clearApiKey', false); }} placeholder={settings.hasApiKey ? '••••••••••••••••••••••••' : 'sk-…'} autoComplete="new-password" spellCheck={false} /></label>
        <div className="key-note"><ShieldCheck size={14} /><span>Khóa API chỉ được sử dụng ở tiến trình desktop, không lưu trong trình duyệt.</span>{settings.hasApiKey && <button type="button" className="text-button" onClick={() => change('clearApiKey', !form.clearApiKey)}>{form.clearApiKey ? 'Hoàn tác xóa' : 'Xóa khóa'}</button>}</div>
        {form.clearApiKey && <p className="inline-warning">Khóa hiện tại sẽ được xóa khi bạn lưu cài đặt.</p>}
        <div className="section-divider"><span>QUYỀN THỰC THI</span><ShieldCheck size={13} /></div>
        <label className="toggle-row"><span><strong>Tự động sửa file</strong><small>Cho phép agent ghi thay đổi trong thư mục dự án.</small></span><input type="checkbox" checked={form.autoApproveEdits} onChange={event => change('autoApproveEdits', event.target.checked)} /><span className="switch" /></label>
        <label className="toggle-row"><span><strong>Tự động chạy lệnh</strong><small>Lệnh chạy bằng shell trên máy, có toàn quyền người dùng và không có sandbox. Mặc định yêu cầu duyệt.</small></span><input type="checkbox" checked={form.autoApproveCommands} onChange={event => change('autoApproveCommands', event.target.checked)} /><span className="switch" /></label>
        {feedback && <div className={`feedback ${feedback.ok ? 'success' : 'failure'}`} role="status">{feedback.ok ? <CheckCheck size={17} /> : <CircleAlert size={17} />}<span>{feedback.message}</span></div>}
        <div className="modal-footer"><button type="button" className="button secondary" disabled={!!busy || !bridge} onClick={() => void submit('test')}>{busy === 'test' ? <Loader2 className="spin" size={15} /> : <Unplug size={15} />}Kiểm tra kết nối</button><button type="submit" className="button primary" disabled={!!busy || !bridge}>{busy === 'save' ? <Loader2 className="spin" size={15} /> : <Check size={15} />}Lưu cài đặt</button></div>
      </form>
    </div>
  </div>;
}

function FileTree({ bridge, root, version, onSelect, selected }: { bridge?: DesktopBridge; root: string; version: number; onSelect: (path: string) => void; selected?: string }) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [children, setChildren] = useState<Record<string, FileEntry[]>>({});
  const [loadingPaths, setLoadingPaths] = useState<Record<string, boolean>>({});
  const sort = (files: FileEntry[]) => [...files].sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1);
  useEffect(() => {
    let live = true; setLoading(true); setError(''); setChildren({}); setOpen({});
    void bridge?.listFiles().then(files => { if (live) setEntries(sort(files)); }).catch(error => { if (live) setError(errorText(error)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [bridge, root, version]);
  async function expand(entry: FileEntry) {
    if (entry.kind === 'file') { onSelect(entry.path); return; }
    if (open[entry.path] && children[entry.path]) { setOpen(current => ({ ...current, [entry.path]: false })); return; }
    setOpen(current => ({ ...current, [entry.path]: true }));
    if (children[entry.path]) return;
    setLoadingPaths(current => ({ ...current, [entry.path]: true }));
    try { const files = await bridge?.listFiles(entry.path); setChildren(current => ({ ...current, [entry.path]: sort(files || []) })); }
    catch (error) { setError(errorText(error)); }
    finally { setLoadingPaths(current => ({ ...current, [entry.path]: false })); }
  }
  const render = (files: FileEntry[], depth: number): ReactNode => files.map(entry => <div key={entry.path}><button type="button" className={`file-entry ${selected === entry.path ? 'selected' : ''}`} style={{ paddingLeft: `${12 + depth * 15}px` }} title={entry.path} onClick={() => void expand(entry)}><span className="file-arrow">{entry.kind === 'directory' ? open[entry.path] ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : null}</span>{loadingPaths[entry.path] ? <Loader2 size={14} className="spin" /> : entry.kind === 'directory' ? open[entry.path] ? <FolderOpen size={14} className="folder-icon" /> : <Folder size={14} className="folder-icon" /> : /\.(tsx?|jsx?|json|css|html|py|rs|go|java|cs)$/.test(entry.name) ? <FileCode2 size={14} /> : <FileText size={14} />}<span>{entry.name}</span></button>{entry.kind === 'directory' && open[entry.path] && children[entry.path] && render(children[entry.path], depth + 1)}</div>);
  if (loading) return <div className="tree-state"><Loader2 size={15} className="spin" />Đang đọc dự án…</div>;
  if (error) return <div className="tree-state error-text">{error}</div>;
  if (!entries.length) return <div className="tree-state">Thư mục chưa có file.<br />Hãy giao việc để bắt đầu.</div>;
  return <div className="file-tree">{render(entries, 0)}</div>;
}

function ToolCard({ tool }: { tool: ToolActivity }) {
  const [expanded, setExpanded] = useState(false);
  let detail = '';
  try { const args = JSON.parse(tool.arguments) as Record<string, unknown>; detail = String(args.path || args.command || args.query || args.pattern || ''); } catch { detail = tool.arguments; }
  const labels: Record<string, string> = { list_files: 'Khám phá thư mục', read_file: 'Đọc file', write_file: 'Ghi file', search_files: 'Tìm trong dự án', search: 'Tìm trong dự án', run_command: 'Chạy terminal', edit_file: 'Sửa file' };
  const running = tool.output === undefined;
  return <div className={`tool-card ${tool.success === false ? 'tool-failed' : ''}`}><button type="button" className="tool-summary" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>{running ? <Loader2 size={14} className="spin" /> : tool.success === false ? <CircleAlert size={14} /> : <Check size={14} />}<span className="tool-name">{labels[tool.name] || tool.name}</span><code>{detail}</code><ChevronRight size={13} className={expanded ? 'rotated' : ''} /></button>{expanded && <div className="tool-details">{tool.arguments && <pre>{tool.arguments}</pre>}{tool.output !== undefined && <pre>{tool.output || 'Hoàn tất.'}</pre>}</div>}</div>;
}

function DiffView({ before, after }: { before: string; after: string }) {
  const changes = diffLines(before, after);
  let oldLine = 0; let newLine = 0;
  return <div className="diff-view">{changes.flatMap((change, part) => change.value.replace(/\n$/, '').split('\n').map((line, index) => { if (!change.added) oldLine++; if (!change.removed) newLine++; return <div key={`${part}-${index}`} className={`diff-line ${change.added ? 'added' : change.removed ? 'removed' : ''}`}><span className="diff-num">{change.added ? '' : oldLine}</span><span className="diff-num">{change.removed ? '' : newLine}</span><span className="diff-symbol">{change.added ? '+' : change.removed ? '−' : ' '}</span><code>{line || ' '}</code></div>; }))}</div>;
}

function ApprovalCard({ approval, onRespond, busy, workspace }: { approval: ApprovalRequest; onRespond: (approved: boolean) => void; busy: boolean; workspace: Workspace | null }) {
  const [showDiff, setShowDiff] = useState(true);
  return <section className="approval-card" aria-label="Yêu cầu phê duyệt"><div className="approval-header"><div className="approval-icon"><ShieldCheck size={18} /></div><div><strong>{approval.kind === 'write' ? 'Duyệt thay đổi file' : 'Duyệt chạy lệnh'}</strong><span>{approval.title}</span></div><span className="approval-wait"><span />Chờ bạn</span></div>{approval.kind === 'command' ? <><pre className="approval-command"><span>$</span> {approval.command}</pre><p className="approval-note">Lệnh chạy trên máy bạn bằng shell, không có sandbox.</p></> : <><button className="approval-file" type="button" onClick={() => setShowDiff(value => !value)}><FileDiff size={14} /><span>{relativePath(approval.path || '', workspace?.root)}</span><ChevronDown size={14} className={!showDiff ? 'collapsed' : ''} /></button>{showDiff && <div className="approval-diff"><DiffView before={approval.before || ''} after={approval.after || ''} /></div>}</>}<div className="approval-actions"><span>Agent sẽ tiếp tục sau quyết định của bạn.</span><button type="button" className="button secondary small" disabled={busy} onClick={() => onRespond(false)}>Từ chối</button><button type="button" className="button primary small" disabled={busy} onClick={() => onRespond(true)}>{busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />}Cho phép</button></div></section>;
}

function TerminalPanel({ bridge, workspace, busy, onClose }: { bridge?: DesktopBridge; workspace: Workspace | null; busy: boolean; onClose: () => void }) {
  const [command, setCommand] = useState(''); const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<{ command: string; output: string; code: number | null }[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const outputRef = useRef<HTMLDivElement>(null);
  useEffect(() => { outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight }); }, [history, running]);
  async function run(event: FormEvent) {
    event.preventDefault(); if (!bridge || !workspace || busy || running || !command.trim()) return;
    const value = command.trim(); setCommand(''); setRunning(true); setHistoryIndex(-1);
    try { const result = await bridge.runCommand(value); setHistory(current => [...current, { command: value, ...result }]); }
    catch (error) { setHistory(current => [...current, { command: value, output: errorText(error), code: 1 }]); }
    finally { setRunning(false); }
  }
  return <section className="terminal-panel" aria-label="Terminal"><div className="panel-title"><span><TerminalSquare size={14} />TERMINAL <span className="terminal-shell">PowerShell</span></span><div><IconButton label="Xóa nội dung terminal" disabled={running} onClick={() => setHistory([])}><Trash2 size={13} /></IconButton><IconButton label="Đóng terminal" onClick={onClose} disabled={running}><X size={15} /></IconButton></div></div><div className="terminal-output" ref={outputRef}>{history.length === 0 && <div className="terminal-welcome">{workspace ? `${workspace.root}\nShell chạy trực tiếp trên máy với quyền của bạn.` : 'Mở thư mục dự án để sử dụng terminal.'}</div>}{history.map((entry, index) => <div key={index}><div className="terminal-command"><span>❯</span> {entry.command}</div><pre>{entry.output || '(không có output)'}</pre><div className={`exit-code ${entry.code === 0 ? '' : 'error-text'}`}>Kết thúc · mã {entry.code ?? 'không xác định'}</div></div>)}{running && <div className="terminal-running"><Loader2 size={12} className="spin" />Lệnh đang chạy…</div>}</div><form className="terminal-input" onSubmit={event => void run(event)}><span>❯</span><input value={command} onChange={event => setCommand(event.target.value)} onKeyDown={event => { if (event.key === 'ArrowUp' && history.length) { event.preventDefault(); const index = historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1); setHistoryIndex(index); setCommand(history[index].command); } }} aria-label="Lệnh terminal" placeholder={busy ? 'Đợi agent hoàn tất để chạy lệnh thủ công…' : 'Nhập lệnh…'} disabled={!workspace || busy || running || !bridge} spellCheck={false} autoComplete="off" /><button type="submit" className="icon-button" aria-label="Chạy lệnh terminal" disabled={!command.trim() || !workspace || busy || running || !bridge}><Play size={13} /></button></form></section>;
}

function App() {
  const bridge = window.codeDesk;
  const [settings, setSettings] = useState<PublicSettings>(initialSettings);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tools, setTools] = useState<ToolActivity[]>([]);
  const [status, setStatus] = useState<AgentStatus>('idle'); const [statusDetail, setStatusDetail] = useState('');
  const [approval, setApproval] = useState<ApprovalRequest | null>(null); const [approvalBusy, setApprovalBusy] = useState(false);
  const [draft, setDraft] = useState(''); const [showSettings, setShowSettings] = useState(false); const [showTerminal, setShowTerminal] = useState(false); const [showSidebar, setShowSidebar] = useState(true);
  const [error, setError] = useState(''); const [booting, setBooting] = useState(!!bridge); const [version, setVersion] = useState('0.1.0'); const [treeVersion, setTreeVersion] = useState(0);
  const [selectedFile, setSelectedFile] = useState<FileContent | null>(null); const [fileDraft, setFileDraft] = useState(''); const [fileLoading, setFileLoading] = useState(false); const [fileSaving, setFileSaving] = useState(false); const [fileSaved, setFileSaved] = useState(false); const [inspectorTab, setInspectorTab] = useState<'code' | 'diff'>('code');
  const [tokens, setTokens] = useState({ prompt: 0, completion: 0 }); const [scrollPaused, setScrollPaused] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null); const draftRef = useRef<HTMLTextAreaElement>(null); const selectedRef = useRef(selectedFile); const fileDraftRef = useRef(fileDraft); const bootGeneration = useRef(0);
  selectedRef.current = selectedFile; fileDraftRef.current = fileDraft;
  const busy = status !== 'idle'; const dirty = selectedFile !== null && fileDraft !== selectedFile.content;
  const closeSettings = useCallback(() => setShowSettings(false), []);
  const reportError = useCallback((value: unknown) => setError(errorText(value)), []);
  useEffect(() => {
    if (!bridge) return;
    const generation = ++bootGeneration.current; let live = true;
    const unsubscribe = bridge.onEvent((event: AgentEvent) => {
      if (!live) return;
      switch (event.type) {
        case 'message': setMessages(current => { const index = current.findIndex(message => message.id === event.message.id); return index < 0 ? [...current, event.message] : current.map(message => message.id === event.message.id ? event.message : message); }); if (event.message.role === 'tool') setTools(current => current.filter(tool => tool.id !== event.message.id)); break;
        case 'delta': setMessages(current => { const found = current.find(message => message.id === event.id); return found ? current.map(message => message.id === event.id ? { ...message, content: message.content + event.text } : message) : [...current, { id: event.id, role: 'assistant', content: event.text, createdAt: Date.now() }]; }); break;
        case 'tool-start': setTools(current => [...current.filter(tool => tool.id !== event.id), { id: event.id, name: event.name, arguments: event.arguments, createdAt: Date.now() }]); break;
        case 'tool-end': setTools(current => current.map(tool => tool.id === event.id ? { ...tool, output: event.output, success: event.success } : tool)); break;
        case 'approval': setApproval(event.approval); setApprovalBusy(false); break;
        case 'approval-resolved': setApproval(current => current?.id === event.id ? null : current); setApprovalBusy(false); break;
        case 'status': setStatus(event.status); setStatusDetail(event.detail || ''); if (event.status === 'idle') { setApproval(null); setApprovalBusy(false); } break;
        case 'error': setError(event.message); break;
        case 'usage': setTokens(current => ({ prompt: current.prompt + event.promptTokens, completion: current.completion + event.completionTokens })); break;
        case 'workspace': setWorkspace(event.workspace); setTreeVersion(value => value + 1); break;
        case 'files-changed': {
          setTreeVersion(value => value + 1);
          const selected = selectedRef.current;
          if (selected && fileDraftRef.current === selected.content && event.paths.includes(selected.path)) void bridge.readFile(selected.path).then(file => { if (selectedRef.current?.path === file.path && fileDraftRef.current === selected.content) { setSelectedFile(file); setFileDraft(file.content); } }).catch(reportError);
          break;
        }
      }
    });
    void bridge.bootstrap().then(data => { if (live && generation === bootGeneration.current) { setSettings(data.settings); setWorkspace(data.workspace); setMessages(data.messages); setVersion(data.version); } }).catch(reportError).finally(() => { if (live) setBooting(false); });
    return () => { live = false; unsubscribe(); };
  }, [bridge, reportError]);
  useEffect(() => { const feed = feedRef.current; if (feed && !scrollPaused) feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' }); }, [messages, tools, approval, status, scrollPaused]);
  useEffect(() => { const area = draftRef.current; if (area) { area.style.height = 'auto'; area.style.height = `${Math.min(area.scrollHeight, 180)}px`; } }, [draft]);
  async function chooseWorkspace() {
    if (!bridge || busy) return;
    if (dirty && !window.confirm('File đang có thay đổi chưa lưu. Bỏ thay đổi để mở dự án khác?')) return;
    try { const next = await bridge.chooseWorkspace(); if (next) { setWorkspace(next); setSelectedFile(null); setMessages([]); setTools([]); setTokens({ prompt: 0, completion: 0 }); setTreeVersion(value => value + 1); setError(''); } } catch (error) { reportError(error); }
  }
  async function openFile(path: string) {
    if (!bridge) return;
    if (dirty && !window.confirm('File đang có thay đổi chưa lưu. Bỏ thay đổi để mở file khác?')) return;
    setFileLoading(true); setFileSaved(false);
    try { const file = await bridge.readFile(path); setSelectedFile(file); setFileDraft(file.content); setInspectorTab('code'); } catch (error) { reportError(error); } finally { setFileLoading(false); }
  }
  async function saveFile() {
    if (!bridge || !selectedFile || !dirty || busy) return;
    setFileSaving(true);
    try { const file = { path: selectedFile.path, content: fileDraft }; await bridge.writeFile(file); setSelectedFile(file); setFileSaved(true); setTreeVersion(value => value + 1); } catch (error) { reportError(error); } finally { setFileSaving(false); }
  }
  async function send() {
    if (!bridge || busy || !draft.trim()) return;
    if (!settings.hasApiKey) { setShowSettings(true); return; }
    if (!workspace) { await chooseWorkspace(); return; }
    const content = draft.trim(); setDraft(''); setError(''); setScrollPaused(false); setStatus('thinking');
    try { await bridge.sendMessage(content); } catch (error) { reportError(error); setStatus('idle'); setDraft(content); }
  }
  async function newChat() {
    if (!bridge || busy) return;
    try { if (workspace) await bridge.newChat(); setMessages([]); setTools([]); setTokens({ prompt: 0, completion: 0 }); setError(''); setDraft(''); setApproval(null); setScrollPaused(false); draftRef.current?.focus(); } catch (error) { reportError(error); }
  }
  async function respond(approved: boolean) {
    if (!bridge || !approval || approvalBusy) return;
    const approvalId = approval.id;
    setApprovalBusy(true);
    try { await bridge.respondApproval(approvalId, approved); setApproval(current => current?.id === approvalId ? null : current); } catch (error) { reportError(error); } finally { setApprovalBusy(false); }
  }
  async function stop() { try { setStatusDetail('Đang dừng…'); await bridge?.stop(); setApproval(null); } catch (error) { reportError(error); } }
  const onDraftKey = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } };
  const allItems = [...messages.map(message => ({ kind: 'message' as const, id: message.id, createdAt: message.createdAt, message })), ...tools.filter(tool => !messages.some(message => message.id === tool.id)).map(tool => ({ kind: 'tool' as const, id: tool.id, createdAt: tool.createdAt, tool }))].sort((a, b) => a.createdAt - b.createdAt);
  const hasConversation = allItems.length > 0;
  const totalTokens = tokens.prompt + tokens.completion;
  return <div className="app-shell">
    <header className="titlebar"><div className="titlebar-brand"><span className="brand-mark"><Braces size={17} /></span><strong>CodeDesk</strong><span className="titlebar-divider" /><span className="titlebar-context">{workspace?.name || 'Không gian lập trình'}</span></div><div className="titlebar-middle"><span className="local-dot" />DESKTOP WORKSPACE</div><div className="window-controls"><button aria-label="Thu nhỏ cửa sổ" onClick={() => bridge?.windowControls('minimize')}><Minus size={15} /></button><button aria-label="Phóng to cửa sổ" onClick={() => bridge?.windowControls('maximize')}><Maximize2 size={12} /></button><button className="window-close" aria-label="Đóng cửa sổ" onClick={() => bridge?.windowControls('close')}><X size={16} /></button></div></header>
    <div className="app-body">
      {showSidebar && <aside className="sidebar"><div className="sidebar-top"><button type="button" className="new-chat-button" onClick={() => void newChat()} disabled={!bridge || busy}><Plus size={16} /><span>Cuộc trò chuyện mới</span><span className="shortcut">↗</span></button><div className="sidebar-section-heading"><span>KHÔNG GIAN LÀM VIỆC</span></div><button type="button" className="sidebar-nav active" onClick={() => draftRef.current?.focus()}><MessageSquare size={15} /><span>{hasConversation ? 'Đang xây dựng cùng bạn' : 'Bắt đầu cùng CodeDesk'}</span><span className="nav-dot" /></button></div><div className="project-heading"><span>DỰ ÁN</span><div><IconButton label="Làm mới danh sách file" onClick={() => setTreeVersion(value => value + 1)} disabled={!workspace}><RefreshCw size={12} /></IconButton><IconButton label="Mở thư mục dự án" onClick={() => void chooseWorkspace()} disabled={busy || !bridge}><FolderPlus size={14} /></IconButton></div></div>{workspace ? <><button className="project-root" onClick={() => void chooseWorkspace()} title={workspace.root} disabled={busy}><ChevronDown size={12} /><FolderOpen size={15} /><strong>{workspace.name}</strong></button><div className="file-tree-scroll"><FileTree bridge={bridge} root={workspace.root} version={treeVersion} onSelect={path => void openFile(path)} selected={selectedFile?.path} /></div></> : <div className="empty-project"><div className="empty-project-icon"><Folder size={24} strokeWidth={1.3} /></div><strong>Mọi ý tưởng bắt đầu<br />từ một thư mục.</strong><p>Mở dự án có sẵn hoặc chọn<br />một thư mục trống để tạo mới.</p><button type="button" className="button secondary small" onClick={() => void chooseWorkspace()} disabled={!bridge}><FolderOpen size={13} />Mở thư mục</button></div>}<div className="sidebar-bottom"><div className="local-info"><ShieldCheck size={15} /><span>Thao tác trên dự án cục bộ</span></div><button type="button" className="settings-nav" onClick={() => setShowSettings(true)}><Settings2 size={16} /><span>Cài đặt & kết nối</span><span className={`connection-dot ${settings.hasApiKey ? 'connected' : ''}`} /></button><div className="sidebar-version"><span>CODEDESK</span><span>v{version}</span></div></div></aside>}
      <main className="main-area"><div className="workspace-toolbar"><div className="workspace-breadcrumb"><IconButton label={showSidebar ? 'Ẩn thanh bên' : 'Hiện thanh bên'} onClick={() => setShowSidebar(value => !value)}>{showSidebar ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}</IconButton><span className="toolbar-separator" /><MessageSquare size={14} /><span>Trợ lý lập trình</span><ChevronRight size={12} /><span className="muted">{hasConversation ? 'Cuộc trò chuyện' : 'Bắt đầu mới'}</span></div><div className="toolbar-actions"><button type="button" className="model-pill" onClick={() => setShowSettings(true)}><span className={`model-dot ${settings.hasApiKey ? 'connected' : ''}`} /><span>{settings.model}</span><ChevronDown size={12} /></button><IconButton label="Mở terminal" active={showTerminal} onClick={() => setShowTerminal(value => !value)}><TerminalSquare size={16} /></IconButton></div></div>
        {!bridge && <div className="notice-banner browser-notice"><Unplug size={16} /><span><strong>Bản xem trước giao diện.</strong> Chạy ứng dụng desktop CodeDesk để mở dự án và sử dụng agent.</span></div>}
        {bridge && !settings.hasApiKey && !booting && <div className="notice-banner"><Sparkles size={15} /><span>Kết nối API để biến ý tưởng thành mã nguồn.</span><button type="button" onClick={() => setShowSettings(true)}>Thiết lập kết nối<ArrowUpRight size={13} /></button></div>}
        <div className="workspace-content"><div className="conversation-column"><div className={`conversation-feed ${!hasConversation ? 'empty-feed' : ''}`} ref={feedRef} onScroll={() => { const feed = feedRef.current; if (feed) setScrollPaused(feed.scrollHeight - feed.scrollTop - feed.clientHeight > 120); }}>
          {booting ? <div className="boot-state"><Loader2 size={25} className="spin" /><p>Đang mở không gian của bạn…</p></div> : !hasConversation ? <div className="welcome"><div className="welcome-kicker"><span /> Ý TƯỞNG CỦA BẠN. KHẢ NĂNG CỦA AI.</div><div className="hero-icon"><Braces size={38} strokeWidth={1.4} /><span className="hero-spark"><Plus size={12} /></span></div><h1>Cùng xây dựng<br /><span>điều gì đó tuyệt vời.</span></h1><p>Giao việc cho AI. Đọc mã, sửa file, chạy terminal.<br />Mọi thứ trong không gian làm việc của bạn.</p><div className="suggestion-grid">{[{ icon: <WandSparkles size={18} />, title: 'Tạo một ứng dụng', desc: 'Từ ý tưởng đến những dòng code đầu tiên', prompt: 'Hãy giúp tôi xây dựng một ứng dụng mới. Trước tiên, đọc thư mục dự án và đề xuất cấu trúc phù hợp.' }, { icon: <Search size={18} />, title: 'Khám phá dự án', desc: 'Hiểu cấu trúc và cách mọi thứ hoạt động', prompt: 'Đọc cấu trúc dự án và các file quan trọng, sau đó giải thích kiến trúc và cách chạy dự án này.' }, { icon: <Code2 size={18} />, title: 'Sửa lỗi & cải thiện', desc: 'Tìm nguyên nhân, sửa và kiểm tra lại', prompt: 'Kiểm tra dự án để tìm lỗi có thể tái hiện. Giải thích nguyên nhân, đề xuất bản sửa và chạy kiểm tra phù hợp.' }, { icon: <Layers size={18} />, title: 'Xây dựng tính năng', desc: 'Thêm ý tưởng mới vào dự án hiện tại', prompt: 'Tôi muốn thêm một tính năng mới vào dự án. Hãy đọc dự án trước, sau đó giúp tôi xác định những thay đổi cần thiết.' }].map(item => <button type="button" className="suggestion-card" key={item.title} onClick={() => { setDraft(item.prompt); draftRef.current?.focus(); }}><span className="suggestion-icon">{item.icon}</span><div><strong>{item.title}</strong><span>{item.desc}</span></div><ArrowUpRight size={14} className="suggestion-arrow" /></button>)}</div><div className="welcome-footnote"><GitBranch size={13} /><span>Tương thích DeepSeek và các API chuẩn OpenAI</span></div></div> : <div className="message-list">{allItems.map(item => item.kind === 'tool' ? <div className="tool-row" key={`tool-${item.id}`}><ToolCard tool={item.tool} /></div> : item.message.role === 'tool' ? <div className="tool-row" key={item.id}><ToolCard tool={{ id: item.id, name: item.message.toolName || 'Công cụ', arguments: '', output: item.message.content, success: item.message.success, createdAt: item.createdAt }} /></div> : <article key={item.id} className={`message ${item.message.role}`}><div className="message-avatar">{item.message.role === 'user' ? <span>B</span> : <Braces size={17} />}</div><div className="message-body"><div className="message-heading"><strong>{item.message.role === 'user' ? 'Bạn' : 'CodeDesk'}</strong>{item.message.role === 'assistant' && <span>{settings.model}</span>}<time>{new Date(item.createdAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</time></div><div className="markdown"><Markdown content={item.message.content} bridge={bridge} onError={reportError} /></div></div></article>)}{busy && status !== 'waiting' && <div className="thinking-indicator"><span /><span /><span /><small>{statusDetail || statusLabels[status]}</small></div>}</div>}
        </div>{scrollPaused && hasConversation && <button type="button" className="scroll-bottom" onClick={() => { setScrollPaused(false); feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' }); }} aria-label="Đi đến tin nhắn mới nhất"><ArrowDown size={15} /></button>}<div className="composer-region">{error && <div className="error-banner" role="alert"><CircleAlert size={16} /><span>{error}</span><IconButton label="Đóng thông báo lỗi" onClick={() => setError('')}><X size={14} /></IconButton></div>}{approval && <ApprovalCard approval={approval} onRespond={approved => void respond(approved)} busy={approvalBusy} workspace={workspace} />}<div className={`composer ${busy ? 'composer-busy' : ''}`}><textarea ref={draftRef} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={onDraftKey} placeholder="Mô tả điều bạn muốn xây dựng hoặc thay đổi…" aria-label="Nội dung giao việc cho agent" disabled={booting || !bridge} rows={2} /><div className="composer-bottom"><div className="composer-context"><button type="button" className="context-folder" onClick={() => void chooseWorkspace()} disabled={busy || !bridge} title={workspace?.root || 'Chọn thư mục dự án'}><FolderOpen size={14} /><span>{workspace?.name || 'Chọn dự án'}</span>{!workspace && <Plus size={12} />}</button><span className="composer-divider" /><button type="button" className="permissions-pill" onClick={() => setShowSettings(true)} title="Cài đặt quyền thực thi"><ShieldCheck size={13} /><span>{settings.autoApproveCommands && settings.autoApproveEdits ? 'Tự động thực thi' : 'Duyệt thay đổi'}</span><ChevronDown size={11} /></button></div>{busy ? <button type="button" className="send-button stop-button" onClick={() => void stop()} title="Dừng agent" aria-label="Dừng agent"><Square size={13} fill="currentColor" /></button> : <button type="button" className="send-button" onClick={() => void send()} disabled={!draft.trim() || !bridge || booting} title="Gửi yêu cầu (Enter)" aria-label="Gửi yêu cầu"><ArrowUp size={18} /></button>}</div></div><div className="composer-caption"><span><Command size={11} /> Enter để gửi <span className="caption-dot">·</span> Shift + Enter xuống dòng</span><span>Kiểm tra thay đổi trước khi áp dụng.</span></div></div></div>
        {(selectedFile || fileLoading) && <aside className="inspector"><div className="inspector-header"><span><FileCode2 size={14} /><strong>{selectedFile ? filename(selectedFile.path) : 'Đang mở…'}</strong>{dirty && <span className="unsaved-dot" title="Chưa lưu" />}</span><div><IconButton label="Đóng trình soạn thảo" onClick={() => { if (!dirty || window.confirm('Bỏ thay đổi chưa lưu và đóng file?')) setSelectedFile(null); }}><X size={15} /></IconButton></div></div>{selectedFile && <><div className="inspector-path" title={selectedFile.path}>{relativePath(selectedFile.path, workspace?.root)}</div><div className="editor-tabs"><button className={inspectorTab === 'code' ? 'active' : ''} onClick={() => setInspectorTab('code')}><Code2 size={13} />Mã nguồn</button><button className={inspectorTab === 'diff' ? 'active' : ''} onClick={() => setInspectorTab('diff')}><FileDiff size={13} />Thay đổi{dirty && <span className="tiny-dot" />}</button><button className="save-file" onClick={() => void saveFile()} disabled={!dirty || fileSaving || busy}>{fileSaving ? <Loader2 size={13} className="spin" /> : fileSaved && !dirty ? <Check size={13} /> : null}{fileSaved && !dirty ? 'Đã lưu' : 'Lưu file'}</button></div>{fileLoading ? <div className="editor-loading"><Loader2 size={20} className="spin" /></div> : inspectorTab === 'diff' ? <div className="editor-diff">{dirty ? <DiffView before={selectedFile.content} after={fileDraft} /> : <div className="editor-empty"><CheckCheck size={25} /><p>File chưa có thay đổi.</p></div>}</div> : <div className="code-editor"><div className="line-numbers" aria-hidden="true">{Array.from({ length: fileDraft.split('\n').length }, (_, index) => <div key={index}>{index + 1}</div>)}</div><textarea aria-label={`Mã nguồn ${filename(selectedFile.path)}`} value={fileDraft} onChange={event => { setFileDraft(event.target.value); setFileSaved(false); }} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); void saveFile(); } if (event.key === 'Tab') { event.preventDefault(); const target = event.currentTarget; const start = target.selectionStart; const end = target.selectionEnd; setFileDraft(value => value.slice(0, start) + '  ' + value.slice(end)); requestAnimationFrame(() => { target.selectionStart = target.selectionEnd = start + 2; }); } }} onScroll={event => { const numbers = event.currentTarget.previousElementSibling; if (numbers) numbers.scrollTop = event.currentTarget.scrollTop; }} spellCheck={false} wrap="off" disabled={fileSaving || busy} /></div>}<div className="editor-footer"><span>{fileDraft.split('\n').length} dòng</span><span>UTF-8 <span className="caption-dot">·</span> {dirty ? 'Chưa lưu' : 'Đã đồng bộ'}</span></div></>}</aside>}
        </div>{showTerminal && <TerminalPanel bridge={bridge} workspace={workspace} busy={busy} onClose={() => setShowTerminal(false)} />}
      </main>
    </div><footer className="statusbar"><div><span className={`status-indicator ${busy ? 'is-busy' : ''}`} /> <span>{booting ? 'Đang khởi động' : !bridge ? 'Xem trước giao diện' : statusLabels[status]}</span>{busy && <span className="status-detail">{statusDetail}</span>}</div><div><span><ShieldCheck size={11} />Local workspace</span>{totalTokens > 0 && <span>{totalTokens.toLocaleString('vi-VN')} tokens</span>}<button type="button" onClick={() => setShowSettings(true)}><Circle size={8} className={settings.hasApiKey ? 'green-text' : ''} />{settings.hasApiKey ? 'Đã cấu hình API' : 'Chưa kết nối API'}</button></div></footer>
    {showSettings && <SettingsModal settings={settings} bridge={bridge} onClose={closeSettings} onSaved={setSettings} />}
  </div>;
}

export default App;
