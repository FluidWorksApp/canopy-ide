import { invoke, isTauri } from '@tauri-apps/api/core';
import { installHost } from '../host';
import { savedExecutionMode } from '../executionMode';
import { NativeWorkspaceHost, type WorkspaceConnection } from './NativeWorkspaceHost';
import {renderStartupShell,startupDiagnostic} from './StartupShell';
import {beginStartupWork,currentStartupWork,boundedStartup} from './startupWork';

let active: NativeWorkspaceHost | undefined;
export const activeWorkspace = () => active;
export async function initializeWorkspace(epoch=beginStartupWork()) {
  if (await boundedStartup(savedExecutionMode()) !== 'remote') return currentStartupWork(epoch);
  if(!currentStartupWork(epoch))return false;
  const connection = isTauri() ? await boundedStartup(invoke<WorkspaceConnection | null>('execution_remote_get')) : null;
  if(!currentStartupWork(epoch))return false;
  if (connection) {
    active = new NativeWorkspaceHost(connection);
    try { await boundedStartup(active.client.workspace(connection.workspaceId, '/open', {resume:false})); }
    catch { active.dispose(); active = undefined; }
  }
  if(!currentStartupWork(epoch)){active?.dispose();active=undefined;return false;}
  if (!active) {
    startupDiagnostic('unavailable');
    renderStartupShell('This remote workspace is unavailable or stopped. Choose a workspace to resume it, or keep working on this Mac.',true,connection?.workspaceName);
    return false;
  }
  installHost(active);
  startupDiagnostic('connected');
  return true;
}
