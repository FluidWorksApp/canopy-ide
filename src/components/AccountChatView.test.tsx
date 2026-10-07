import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
const mock=vi.hoisted(()=>({send:vi.fn(async()=>({partial:false})),snapshot:{members:{ada:'Ada Lovelace'},messages:[{id:'m',sender:'ada',recipient:null,text:'Hello team',created:1}],receipts:{},status:'Connected'}}));
vi.mock('../teamMessaging/session',()=>({teamSession:()=>({retain:()=>()=>{},markRead:vi.fn(),subscribe:()=>()=>{},getSnapshot:()=>mock.snapshot,send:mock.send})}));
import {AccountChatView} from './AccountChatView';
afterEach(cleanup);
it('identifies channel senders using the authenticated directory and sends in the selected team conversation',async()=>{
 render(<AccountChatView conversation={{teamId:'engineering',userId:'me',peer:null,name:'Engineering'}}/>);
 expect(screen.getByText('Ada Lovelace')).toBeTruthy();expect(screen.getByText('Hello team')).toBeTruthy();
 fireEvent.change(screen.getByRole('textbox',{name:'Message'}),{target:{value:'Hi Ada'}});fireEvent.click(screen.getByRole('button',{name:'Send'}));
 await waitFor(()=>expect(mock.send).toHaveBeenCalledWith('Hi Ada',null));
});
