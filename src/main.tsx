import {startStartupHeartbeat} from './startupHeartbeat';
import { initializeWorkspace } from "./remoteExecution/workspace";
import '@fontsource-variable/archivo';
import '@fontsource-variable/jetbrains-mono';
import './index.css';
import {applyTheme,getSettings} from './settings';
import {applyZoom,loadZoom} from './zoom';
import {renderStartupShell,startupDiagnostic} from './remoteExecution/StartupShell';
import {boundedStartup,beginStartupWork,currentStartupWork} from './remoteExecution/startupWork';
let startupEpoch=0;
async function start() {
  startStartupHeartbeat();
  const epoch=startupEpoch=beginStartupWork();
  startupDiagnostic('begin');
  renderStartupShell('Checking your saved workspace connection…');
  applyTheme(getSettings().theme,getSettings().customAccent);
  await boundedStartup(applyZoom(loadZoom())).catch(()=>{});
  if(!currentStartupWork(epoch)||!await initializeWorkspace(epoch))return;
  await import("./localMain");
}
void start().catch(() => {
  if(!currentStartupWork(startupEpoch))return;
  startupDiagnostic('unavailable');
  renderStartupShell('Canopy could not reconnect. Your workspace is kept. Retry, choose another workspace, or explicitly use this Mac.',true);
});
