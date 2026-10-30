import { contextBridge, ipcRenderer } from 'electron';
import type { AgentEvent, DesktopBridge } from '../shared/types.js';

const bridge: DesktopBridge = {
  bootstrap: () => ipcRenderer.invoke('codedesk:bootstrap'),
  saveSettings: settings => ipcRenderer.invoke('codedesk:save-settings', settings),
  testConnection: settings => ipcRenderer.invoke('codedesk:test-connection', settings),
  chooseWorkspace: () => ipcRenderer.invoke('codedesk:choose-workspace'),
  listFiles: relative => ipcRenderer.invoke('codedesk:list-files', relative),
  readFile: relative => ipcRenderer.invoke('codedesk:read-file', relative),
  writeFile: file => ipcRenderer.invoke('codedesk:write-file', file),
  sendMessage: content => ipcRenderer.invoke('codedesk:send-message', content),
  stop: () => ipcRenderer.invoke('codedesk:stop'),
  newChat: () => ipcRenderer.invoke('codedesk:new-chat'),
  respondApproval: (id, approved) => ipcRenderer.invoke('codedesk:approval', id, approved),
  runCommand: command => ipcRenderer.invoke('codedesk:run-command', command),
  onEvent: callback => {
    const listener = (_event: Electron.IpcRendererEvent, event: AgentEvent): void => callback(event);
    ipcRenderer.on('codedesk:event', listener);
    return () => { ipcRenderer.removeListener('codedesk:event', listener); };
  },
  windowControls: action => ipcRenderer.send('codedesk:window-controls', action),
  openExternal: url => ipcRenderer.invoke('codedesk:open-external', url),
};
contextBridge.exposeInMainWorld('codeDesk', Object.freeze(bridge));
