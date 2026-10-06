import {describe,it,expect} from 'vitest';
import {workspaceTabs,workspaceTabId} from './workspaceTabs';
describe('workspace tab identity',()=>{
 it('merges legacy saved IDs, account entries and an active connection for the same workspace',()=>{
  const managed=[{id:'ws-one',name:'Machine Works'}];
  const saved=[{id:'legacy-record-a',workspaceId:'ws-one',endpoint:'https://old-host.example/',workspaceName:'Old name'},{id:'legacy-record-b',workspaceId:'ws-one',endpoint:'https://ws-one.workspaces.canopyide.dev',workspaceName:'Machine Works'}];
  const tabs=workspaceTabs(saved,managed,saved[0]);
  expect(tabs.map(t=>t.id)).toEqual(['local','managed:ws-one']);
  expect(tabs[1]).toMatchObject({workspaceName:'Machine Works',managedId:'ws-one'});
  expect(workspaceTabId(saved[0],managed)).toBe('managed:ws-one');
 });
 it('retains stable tab ordering when account polls reorder rows',()=>{
  const a={id:'ws-one',name:'Machine Works'},b={id:'ws-two',name:'Shoaib workspace'};
  const initial=workspaceTabs([],[a,b],null);
  expect(workspaceTabs([],[b,a],null,initial).map(t=>t.id)).toEqual(initial.map(t=>t.id));
 });
 it('does not merge distinct generic hosts or workspaces with equal names',()=>{
  const tabs=workspaceTabs([{id:'first/test',endpoint:'https://first.example',workspaceId:'test',workspaceName:'Project'},{id:'second/test',endpoint:'https://second.example',workspaceId:'test',workspaceName:'Project'}],[],null);
  expect(tabs).toHaveLength(3);
  expect(workspaceTabs([],[{id:'ws-one',name:'Same name'},{id:'ws-two',name:'Same name'}],null)).toHaveLength(3);
 });
});
