export interface PublicSettings {
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  maxSteps: number;
  autoApproveEdits: boolean;
  autoApproveCommands: boolean;
}

export interface SettingsInput {
  baseUrl: string;
  model: string;
  /** Omit or leave empty to keep the existing key. */
  apiKey?: string;
  clearApiKey?: boolean;
  maxSteps: number;
  autoApproveEdits: boolean;
  autoApproveCommands: boolean;
}

export interface Workspace { root: string; name: string }
export interface FileEntry { path: string; name: string; kind: 'file' | 'directory' }
export interface FileContent { path: string; content: string }
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  createdAt: number;
  toolName?: string;
  success?: boolean;
}
export interface ApprovalRequest {
  id: string;
  kind: 'write' | 'command';
  title: string;
  path?: string;
  before?: string;
  after?: string;
  command?: string;
}
export type AgentStatus = 'idle' | 'thinking' | 'working' | 'waiting';
export type AgentEvent =
  | { type: 'message'; message: ChatMessage }
  | { type: 'delta'; id: string; text: string }
  | { type: 'tool-start'; id: string; name: string; arguments: string }
  | { type: 'tool-end'; id: string; name: string; output: string; success: boolean }
  | { type: 'approval'; approval: ApprovalRequest }
  | { type: 'approval-resolved'; id: string }
  | { type: 'status'; status: AgentStatus; detail?: string }
  | { type: 'error'; message: string }
  | { type: 'usage'; promptTokens: number; completionTokens: number }
  | { type: 'workspace'; workspace: Workspace | null }
  | { type: 'files-changed'; paths: string[] };
export interface Bootstrap {
  settings: PublicSettings;
  workspace: Workspace | null;
  messages: ChatMessage[];
  version: string;
}
export interface DesktopBridge {
  bootstrap(): Promise<Bootstrap>;
  saveSettings(settings: SettingsInput): Promise<PublicSettings>;
  testConnection(settings: SettingsInput): Promise<{ ok: boolean; message: string }>;
  chooseWorkspace(): Promise<Workspace | null>;
  listFiles(path?: string): Promise<FileEntry[]>;
  readFile(path: string): Promise<FileContent>;
  writeFile(file: FileContent): Promise<void>;
  sendMessage(content: string): Promise<void>;
  stop(): Promise<void>;
  newChat(): Promise<void>;
  respondApproval(id: string, approved: boolean): Promise<void>;
  runCommand(command: string): Promise<{ code: number | null; output: string }>;
  onEvent(callback: (event: AgentEvent) => void): () => void;
  windowControls(action: 'minimize' | 'maximize' | 'close'): void;
  openExternal(url: string): Promise<void>;
}
