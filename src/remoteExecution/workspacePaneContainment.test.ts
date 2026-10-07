// The Workspaces modal's Tools & Access panes once ran past the modal's right
// edge: flex and grid children default to min-width:auto, so one nowrap label
// or long path widened every ancestor. jsdom cannot see overflow, so the
// containment rules are guarded at the source, like textContainmentGuard.
/// <reference types="node" />
import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const read=(...path:string[])=>readFileSync(join(process.cwd(),'src',...path),'utf8');
const workspace=read('remoteExecution','workspace.css'),accounts=read('components','sharedAccounts.css'),sharing=read('components','workspaceSharing.css');
const body=(css:string,selector:string)=>{const at=css.lastIndexOf(selector+' {')>-1?css.lastIndexOf(selector+' {'):css.lastIndexOf(selector+'{');expect(at,`no rule for ${selector}`).toBeGreaterThan(-1);return css.slice(css.indexOf('{',at)+1,css.indexOf('}',at));};
it('every pane child can shrink to the pane and long text wraps',()=>{
 expect(body(workspace,'.workspace-main > *')).toMatch(/min-width:0;max-width:100%/);
 expect(body(workspace,'.workspace-main :is(section,div,header,form,fieldset,details,label,p,ul,li)')).toContain('min-width:0');
 expect(body(workspace,'.workspace-main :is(p,small,strong,h3,h4,label,summary,span)')).toContain('overflow-wrap:anywhere');
 expect(body(workspace,'.workspace-main .shared-session-disclosure')).toContain('white-space:normal');
});
it('shared account actions wrap instead of reserving a fixed width',()=>{
 expect(accounts).not.toMatch(/\.shared-account-actions\{[^}]*flex:0 0 \d+px/);
 expect(body(accounts,'.shared-account-actions')).toContain('flex-wrap:wrap');
});
it('the sharing status line wraps inside the pane',()=>{
 const line=body(sharing,'.workspace-sharing-status');expect(line).toContain('flex-wrap:wrap');expect(line).toContain('min-width:0');
 expect(body(sharing,'.workspace-sharing-status>span')).toContain('overflow-wrap:anywhere');
 expect(body(sharing,'.workspace-sharing-access-heading')).toContain('flex-wrap:wrap');
});
