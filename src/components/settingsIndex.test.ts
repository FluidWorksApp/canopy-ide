import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe,expect,it} from 'vitest';
import {SETTINGS_INDEX,searchSettings,settingAnchor} from './settingsIndex';

const source=readFileSync(join(process.cwd(),'src/components/SettingsDialog.tsx'),'utf8');
// Components that render rows for one tab but are defined outside SettingsDialog.
const COMPONENT_TAB:Record<string,string>={CanopyLinkSettings:'integrations',SelfHostedRemoteSettings:'integrations',SpotSearchSettings:'spotsearch',ClipboardSettings:'clipboard',DictationSettings:'dictation'};

/** Every <Item name="..."> in SettingsDialog.tsx with the tab it is shown on. */
function itemsInSource(){
  const tabMarks=[...source.matchAll(/\{tab === "([a-z]+)"/g)].map(m=>[m.index!,m[1]] as const);
  const functions=[...source.matchAll(/\n(?:export )?function ([A-Z][A-Za-z]+)\(/g)].map(m=>[m.index!,m[1]] as const);
  const rows:{tab:string;name:string}[]=[];
  for(const m of source.matchAll(/<Item\b([^>]*?)>/gs)){
    const name=/\bname="([^"]*)"/.exec(m[1])?.[1];
    if(!name)continue;
    const enclosing=[...functions].filter(f=>f[0]<=m.index!).at(-1)![1];
    let tab:string|undefined;
    if(enclosing==='SettingsDialog')tab=[...tabMarks].filter(t=>t[0]<=m.index!).at(-1)?.[1];
    else tab=COMPONENT_TAB[enclosing];
    if(!tab)throw Error(`Item "${name}" is in ${enclosing}, which this test does not know the tab of. Add it to COMPONENT_TAB.`);
    rows.push({tab,name:name.replace(/&apos;/g,"'").replace(/&amp;/g,'&')});
  }
  return rows;
}

describe('the settings index',()=>{
  it('has an entry for every setting row, under the tab it is shown on',()=>{
    const rows=itemsInSource();
    expect(rows.length).toBeGreaterThan(70);
    const indexed=new Set(SETTINGS_INDEX.filter(e=>!e.panel).map(e=>`${e.tab}:${e.name}`));
    const missing=rows.filter(r=>!indexed.has(`${r.tab}:${r.name}`)).map(r=>`${r.tab}: ${r.name}`);
    expect(missing,'settings not in settingsIndex.ts (so search cannot find them)').toEqual([]);
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
    expect([...new Set(repeated)].filter(a=>a!==settingAnchor('integrations','Remote access'))).toEqual([]);
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
  it('returns nothing for an empty query, and gives a panel no row to scroll to',()=>{
    expect(searchSettings('   ')).toEqual([]);
    expect(searchSettings('vault')[0].anchor).toBeNull();
    expect(searchSettings('scrollback')[0].anchor).toBe(settingAnchor('terminal','Scrollback'));
  });
});
