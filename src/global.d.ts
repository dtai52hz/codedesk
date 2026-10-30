import type { DesktopBridge } from '../shared/types';
declare global {
  interface Window { codeDesk?: DesktopBridge }
}
export {};
