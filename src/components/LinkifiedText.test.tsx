import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
const opened=vi.hoisted(()=>[] as [string,boolean][]);
vi.mock('../links',()=>({openLink:(href:string,external:boolean)=>opened.push([href,external])}));
import {LinkifiedText,linkParts} from './LinkifiedText';
afterEach(()=>{cleanup();opened.length=0;});
it('finds http(s) links and leaves trailing punctuation as text',()=>{
 expect(linkParts('see https://claude.com/resources/webinars/x. and (http://a.b/c)')).toEqual([{text:'see '},{text:'https://claude.com/resources/webinars/x',href:'https://claude.com/resources/webinars/x'},{text:'. and ('},{text:'http://a.b/c',href:'http://a.b/c'},{text:')'}]);
 expect(linkParts('no links, javascript:alert(1) or file:///etc/passwd')).toEqual([{text:'no links, javascript:alert(1) or file:///etc/passwd'}]);
 expect(linkParts('https://')).toEqual([{text:'https://'}]);
});
it('renders clickable links that open through openLink, Cmd-click externally, and never renders HTML',()=>{
 render(<div><LinkifiedText text={'go https://example.com/a <b>bold</b>'}/></div>);
 const link=screen.getByRole('link',{name:'https://example.com/a'});
 fireEvent.click(link);fireEvent.click(link,{metaKey:true});
 expect(opened).toEqual([['https://example.com/a',false],['https://example.com/a',true]]);
 expect(screen.getByText(/<b>bold<\/b>/)).toBeInTheDocument();
});
