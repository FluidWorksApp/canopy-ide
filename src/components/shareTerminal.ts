// Sharing a terminal with teammates. A Canopy workspace's gateway publishes
// one of the owner's running terminals for watching, or starts a clean
// collaboration shell people can type in (packages/remote-host/gateway.mjs,
// `/shared-sessions`). The Share sheet (ShareTerminalSheet.tsx) is opened from
// a terminal's tab bar or menu, or from the Team panel, through one event.
import {activeWorkspace} from '../remoteExecution/workspace';
import {isAccountWorkspace,isMemberConnection} from '../remoteExecution/accountWorkspace';
import {peekWorkspaceList} from '../remoteExecution/workspaceListCache';
import {OPEN_TEAM_EVENT} from '../readableLinks';
/** `room`: the terminal belongs to a live agent session its owner opened to
 * teammates (src/liveSession), which a viewer can join. `sessionId` and
 * `collaborative` are only in the owner's own list. */
export type Publication={id:string;projectId:string;title:string;mode:'view'|'interact';expiresAt:number;sessionId?:number;collaborative?:boolean;room?:{id:string;owner:string;team:string}};
/** A running terminal in the connected workspace. `sessionId` is the
 * workspace's session id, which is the tab's pty id in a remote workspace.
 * `title` is the tab's name as the IDE shows it (tabName), `branch` the Git
 * branch of the worktree its cwd is in. */
export type ShareableTerminal={sessionId:number;title:string;projectId?:string;projectName?:string;branch?:string;cwd?:string;workspaceId?:string};
/** How a person knows a terminal: "claude · SuprFlow · main". Never the
 * command line or the session number. */
export function terminalLabel(t:ShareableTerminal){
 const title=t.title.trim(),project=t.projectName?.trim();
 return [title||(project?`${project} terminal`:'Terminal'),title?project:undefined,t.branch?.trim()].filter((part,i,all):part is string=>!!part&&all.indexOf(part)===i).join(' · ');
}
// The terminal tabs each open project shows, so the sheet opened from the
// Team panel lists them by name rather than by the workspace's session list.
const openTerminals=new Map<string,ShareableTerminal[]>();
/** A project view says which of its terminal tabs are running (or none). */
export function publishShareableTerminals(projectId:string,terminals:ShareableTerminal[]){if(terminals.length)openTerminals.set(projectId,terminals);else openTerminals.delete(projectId);}
export function shareableTerminals(workspaceId:string):ShareableTerminal[]{return [...openTerminals.values()].flat().filter(t=>t.workspaceId===workspaceId);}
export const SHARE_TERMINAL_EVENT='canopy:share-terminal';
/** Something was shared or stopped: the Live now list refreshes. */
export const SHARED_SESSIONS_CHANGED='canopy:shared-sessions-changed';
/** Open the Share sheet, on `terminal` or with a picker when there is none. */
export function shareTerminal(terminal?:ShareableTerminal){window.dispatchEvent(new CustomEvent<ShareableTerminal|null>(SHARE_TERMINAL_EVENT,{detail:terminal??null}));}
export function openTeamPanel(){window.dispatchEvent(new Event(OPEN_TEAM_EVENT));}
export type ShareAvailability={ok:true;workspaceId:string;workspaceName:string}|{ok:false;reason:string};
/** Only the owner connected to their own Canopy workspace can share: the
 * gateway refuses everyone else. */
export function shareAvailability():ShareAvailability{
 const host=activeWorkspace();
 if(!host||!isAccountWorkspace(host.connection))return {ok:false,reason:'Sharing works in a Canopy workspace. Terminals on this computer stay private.'};
 const id=host.connection.workspaceId,listed=peekWorkspaceList()?.workspaces.find(w=>w.id===id);
 if(isMemberConnection(host.connection)||listed?.access?.owner===false)return {ok:false,reason:'Only the workspace owner can share its terminals.'};
 return {ok:true,workspaceId:id,workspaceName:listed?.name??host.connection.workspaceName};
}
