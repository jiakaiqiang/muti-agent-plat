import type { DesktopBridge } from '../../../desktop/src/contracts';
declare global {
  interface Window { agentClusterDesktop?: DesktopBridge }
}
export {};
