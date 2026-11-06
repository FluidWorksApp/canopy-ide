import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {completion,componentAt,lastFolder,orderComponents,rankComponents,recentComponentIds,recordRecentComponent,type PickerComponent} from './componentPicker';

const C=(id:string,label:string,path:string):PickerComponent=>({id,label,path});
const api=C('a','api','/w/shop/services/api');
const web=C('w','web','/w/shop/apps/web');
const worker=C('k','worker','/w/shop/services/worker');
const docs=C('d','Docs site','/w/shop/docs');
const ALL=[api,web,worker,docs];
const ids=(list:PickerComponent[])=>list.map(c=>c.id).join('');

describe('orderComponents',()=>{
  it('puts the component used last first, then the one before it, then the rest in project order',()=>{
    expect(ids(orderComponents(ALL,['k','w']))).toBe('kwad');
  });
  it('with nothing recorded, puts the tab you are in first, then project order',()=>{
    expect(ids(orderComponents(ALL,[],'/w/shop/apps/web/src/app.ts'))).toBe('wakd');
  });
  it('keeps project order when there is neither history nor an active tab',()=>{
    expect(ids(orderComponents(ALL,[]))).toBe('awkd');
  });
  it('ignores ids that no longer exist and lists nothing twice',()=>{
    expect(ids(orderComponents(ALL,['gone','k','k','w','also-gone']))).toBe('kwad');
  });
  it('puts history ahead of the active tab',()=>{
    expect(ids(orderComponents(ALL,['d'],'/w/shop/apps/web'))).toBe('dwak');
  });
});

describe('componentAt',()=>{
  it('finds the most specific component a path is inside',()=>{
    const nested=[C('r','root','/w/shop'),C('s','services','/w/shop/services')];
    expect(componentAt(nested,'/w/shop/services/api/x.ts')?.id).toBe('s');
    expect(componentAt(nested,'/w/shopping')?.id).toBeUndefined();// a sibling that merely shares a prefix is not inside
  });
});

describe('rankComponents',()=>{
  it('returns the given order when nothing is typed',()=>{
    expect(ids(rankComponents('',ALL))).toBe('awkd');
    expect(ids(rankComponents('   ',ALL))).toBe('awkd');
  });
  it('matches the start of the name above anything else, in any case',()=>{
    expect(ids(rankComponents('WO',ALL))).toBe('k');
    expect(ids(rankComponents('doc',ALL))).toBe('d');
  });
  it('matches the folder name when the label differs from it',()=>{
    expect(ids(rankComponents('services',ALL))).toBe('ak');
  });
  it('needs every word to match',()=>{
    expect(ids(rankComponents('services api',ALL))).toBe('a');
    expect(ids(rankComponents('services zebra',ALL))).toBe('');
  });
  it('keeps recency order among equal matches, so the one used last stays on top',()=>{
    expect(ids(rankComponents('services',orderComponents(ALL,['k'])))).toBe('ka');
  });
  it('ranks a name match above a path-only match',()=>{
    const list=[C('x','alpha','/w/web-stuff/alpha'),C('y','web','/w/y')];
    expect(ids(rankComponents('web',list))).toBe('yx');
  });
});

describe('completion',()=>{
  it('offers the rest of the name, to be shown grey after what is typed',()=>{
    expect(completion('wo',worker)).toEqual({rest:'rker',full:'worker'});
    expect(completion('WO',worker)).toEqual({rest:'rker',full:'worker'});
  });
  it('completes a folder name when that is what was typed',()=>{
    expect(completion('serv',C('s','API','/w/services'))).toEqual({rest:'ices',full:'services'});
  });
  it('offers nothing when it would not be what Tab fills in',()=>{
    expect(completion('',worker)).toBeNull();
    expect(completion('worker',worker)).toBeNull();// already complete
    expect(completion('ker',worker)).toBeNull();// not a prefix
    expect(completion('two words',worker)).toBeNull();
    expect(completion('wo',undefined)).toBeNull();
  });
});

describe('lastFolder',()=>{
  it('names the folder people mean',()=>{
    expect(lastFolder('/w/shop/apps/web')).toBe('web');
    expect(lastFolder('/w/shop/apps/web/')).toBe('web');
    expect(lastFolder('C:\\work\\shop')).toBe('shop');
  });
});

describe('recent components',()=>{
  beforeEach(()=>localStorage.clear());
  afterEach(()=>localStorage.clear());
  it('remembers the most recent first, per project',()=>{
    recordRecentComponent('p1','a');recordRecentComponent('p1','b');recordRecentComponent('p2','z');
    expect(recentComponentIds('p1')).toEqual(['b','a']);
    expect(recentComponentIds('p2')).toEqual(['z']);
    expect(recentComponentIds('none')).toEqual([]);
  });
  it('moves a reused component to the front without listing it twice',()=>{
    for(const id of ['a','b','c','a'])recordRecentComponent('p','p'.length?id:id);
    expect(recentComponentIds('p')).toEqual(['a','c','b']);
  });
  it('keeps a bounded history',()=>{
    for(let i=0;i<40;i++)recordRecentComponent('p',`c${i}`);
    const kept=recentComponentIds('p');
    expect(kept.length).toBeLessThanOrEqual(12);expect(kept[0]).toBe('c39');
  });
  it('survives storage that is blocked or corrupt',()=>{
    localStorage.setItem('canopy.componentRecents.v1','{not json');
    expect(recentComponentIds('p')).toEqual([]);
    expect(()=>recordRecentComponent('p','a')).not.toThrow();
    localStorage.setItem('canopy.componentRecents.v1',JSON.stringify({p:'nonsense'}));
    expect(recentComponentIds('p')).toEqual([]);
  });
});
