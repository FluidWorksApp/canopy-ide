import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe,expect,it} from 'vitest';
import {SETTINGS_INDEX,searchSettings,settingAnchor} from './settingsIndex';

const source=readFileSync(join(process.cwd(),'src/components/SettingsDialog.tsx'),'utf8');
/** Where in SettingsDialog.tsx a function's body starts: every <Item> belongs to the function it sits in. */
const functions=[...source.matchAll(/\n(?:export )?function ([A-Z][A-Za-z]+)\(/g)].map(m=>[m.index!,m[1]] as const);
const tabMarks=[...source.matchAll(/\{tab === "([a-z]+)"/g)].map(m=>[m.index!,m[1]] as const);
const enclosingFunction=(pos:number)=>functions.filter(f=>f[0]<=pos).at(-1)![1];
const tabAt=(pos:number)=>tabMarks.filter(t=>t[0]<=pos).at(-1)?.[1];

/** The tab a component is shown on, followed from where it is rendered: directly in a tab block, or inside another component that is. */
function tabOfComponent(name:string,seen=new Set<string>()):string|undefined{
  if(seen.has(name))return undefined;seen.add(name);
  for(const use of source.matchAll(new RegExp(`<${name}\\b`,'g'))){
    const inside=enclosingFunction(use.index!);
    const tab=inside==='SettingsDialog'?tabAt(use.index!):tabOfComponent(inside,seen);
    if(tab)return tab;
  }
  return undefined;
}

/** Every <Item name="..."> in SettingsDialog.tsx with the tab it is shown on. */
function itemsInSource(){
  const rows:{tab:string;name:string;desc?:string}[]=[];
  for(const m of source.matchAll(/<Item\b([^>]*?)>/gs)){
    const name=/\bname="([^"]*)"/.exec(m[1])?.[1];
    if(!name)continue;
    const inside=enclosingFunction(m.index!);
    const tab=inside==='SettingsDialog'?tabAt(m.index!):tabOfComponent(inside);
    if(!tab)throw Error(`Item "${name}" is in ${inside}, which is not rendered on any tab`);
    const unescape=(v:string)=>v.replace(/&apos;/g,"'").replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
    const desc=/\bdesc="([^"]*)"/.exec(m[1])?.[1];
    rows.push({tab,name:unescape(name),...(desc===undefined?{}:{desc:unescape(desc)})});
  }
  return rows;
}

/** Where every setting is meant to live. Moving one is a deliberate act: change it here too. */
const EXPECTED:Record<string,string[]>={
  "account":["Accounts"],
  "agents":["Accounts", "Agent delegation", "CLI commands", "CLI updates", "Claude Code editor link", "Default agent", "Fleet readiness", "Intent & evidence review", "Other CLIs", "Plan before an agent starts", "Proof receipts", "Session documents", "Skip permission prompts", "Tools available", "Turn rollback", "Use ACP"],
  "appearance":["Accent color", "Side panel", "Skin"],
  "browser":["Preview browser"],
  "brain":["Agent awareness", "Automatic brain work", "Brain", "Brain spending", "Builder lens summaries", "Features not using your brain", "Memory allowance maximums", "Memory monitoring prompts"],
  "clipboard":["Clipboard history", "How much to keep", "Keep what I copy", "Passwords and keys", "The history", "Where it's kept"],
  "dictation":["Indicator", "Key", "Language", "Live preview", "Model", "Mute while recording", "Recent dictation", "Shortcut", "Trigger"],
  "editor":["File associations", "Font and cursor", "Keyboard shortcuts"],
  "mascot":["Mascot"],
  "notifications":["Ask for attention", "Notification pop-ups", "Team messages"],
  "privacy":["Crash reporting","Files outside projects"],
  "remote":["On this network", "Public link", "Reach", "Remote access", "Remote access", "Scan to connect", "Tailscale", "Your link"],
  "rules":["Rules"],
  "sessions":["At the budget", "Ctrl+Tab switching", "Hibernate idle agents", "Live agents per project", "New agents get a workspace", "Prototype session cap", "Restore sessions I close", "Session budget", "Set up new workspaces", "Settle into Idle after", "Spend & outcomes", "Stack tabs by status", "Workspace ports"],
  "spotsearch":["Conversations to index", "Keep history for", "Scope", "Terminal scrollback", "The index"],
  "terminal":["Automatic session names", "Engine", "Font and cursor", "Keep terminals running after quit", "Scrollback", "Show engine stats"],
};

describe('the settings index',()=>{
  it('has an entry for every setting row, under the tab it is shown on',()=>{
    const rows=itemsInSource();
    expect(rows.length).toBeGreaterThan(70);
    const indexed=new Set(SETTINGS_INDEX.filter(e=>!e.panel).map(e=>`${e.tab}:${e.name}`));
    const missing=rows.filter(r=>!indexed.has(`${r.tab}:${r.name}`)).map(r=>`${r.tab}: ${r.name}`);
    expect(missing,'settings not in settingsIndex.ts (so search cannot find them)').toEqual([]);
  });
  it('puts every setting exactly once on the tab it is meant to be on',()=>{
    const found:Record<string,string[]>={};
    for(const r of itemsInSource())(found[r.tab]??=[]).push(r.name);
    for(const tab of Object.keys(found))found[tab].sort();
    expect(found).toEqual(EXPECTED);
    expect(Object.values(found).flat().length).toBe(86);// none lost, none doubled
  });
  it('shows each setting\'s current description, so a reworded one cannot leave search showing the old text',()=>{
    const stale:string[]=[];
    for(const row of itemsInSource()){
      if(row.desc===undefined)continue;
      // A setting that exists in two modes has two rows (and two entries) with the same name.
      const ok=SETTINGS_INDEX.some(e=>e.tab===row.tab&&e.name===row.name&&e.desc===row.desc);
      if(!ok)stale.push(`${row.tab}: ${row.name}`);
    }
    expect(stale,'description differs from settingsIndex.ts').toEqual([]);
  });
  it('lists nothing that is not a real setting row',()=>{
    const real=new Set(itemsInSource().map(r=>`${r.tab}:${r.name}`));
    const stale=SETTINGS_INDEX.filter(e=>!e.panel&&!real.has(`${e.tab}:${e.name}`)).map(e=>`${e.tab}: ${e.name}`);
    expect(stale,'index entries with no matching row in SettingsDialog.tsx').toEqual([]);
  });
  it('gives every row its own anchor',()=>{
    const anchors=SETTINGS_INDEX.filter(e=>!e.panel).map(e=>settingAnchor(e.tab,e.name));
    const repeated=anchors.filter((a,i)=>anchors.indexOf(a)!==i);
    // "Remote access" appears twice on one tab (the two remote modes); both are the same destination.
    expect([...new Set(repeated)].filter(a=>a!==settingAnchor('remote','Remote access'))).toEqual([]);
  });
});

describe('searchSettings',()=>{
  const names=(q:string,options={})=>searchSettings(q,options).map(h=>h.entry.name);
  it('finds a setting by name, in any case',()=>{
    expect(names('SCROLLBACK')).toContain('Scrollback');
    expect(names('scrollback')[0]).toBe('Scrollback');
  });
  it('ranks a name match above a description match',()=>{
    const hits=searchSettings('clipboard');
    expect(hits[0].entry.name.toLowerCase()).toContain('clipboard');
  });
  it('understands what people actually type',()=>{
    expect(names('dark mode')).toContain('Skin');
    expect(names('theme')).toContain('Skin');
    expect(names('cost')).toEqual(expect.arrayContaining(['Session budget','Brain spending']));
    expect(names('github')).toContain('GitHub, Slack and other connections');
    expect(names('password')).toEqual(expect.arrayContaining(['Browser and password vault']));
  });
  it('needs every word to match',()=>{
    expect(names('font cursor')).toContain('Font and cursor');
    expect(names('font zebra')).toEqual([]);
  });
  it('finds the same words on both tabs that have them, and says which tab',()=>{
    const fonts=searchSettings('font and cursor').filter(h=>h.entry.name==='Font and cursor').map(h=>h.entry.tab).sort();
    expect(fonts).toEqual(['editor','terminal']);
  });
  it('can match the tab itself, so a tab name lists its settings',()=>{
    expect(names('dictation',{tabLabels:{dictation:'Dictation'}})).toEqual(expect.arrayContaining(['Trigger','Model']));
  });
  it('shows one result for a setting that is indexed twice',()=>{
    const remote=searchSettings('remote access').filter(h=>h.entry.tab==='remote'&&h.entry.name==='Remote access');
    expect(remote).toHaveLength(1);
  });
  it('offers billing under Accounts only, not under the agent CLI accounts',()=>{
    const hits=searchSettings('billing').map(h=>`${h.entry.tab}:${h.entry.name}`);
    expect(hits).toContain('account:Accounts');
    expect(hits).not.toContain('agents:Accounts');
  });
  it('returns nothing for an empty query, and gives a panel no row to scroll to',()=>{
    expect(searchSettings('   ')).toEqual([]);
    expect(searchSettings('vault')[0].anchor).toBeNull();
    expect(searchSettings('scrollback')[0].anchor).toBe(settingAnchor('terminal','Scrollback'));
  });
});
