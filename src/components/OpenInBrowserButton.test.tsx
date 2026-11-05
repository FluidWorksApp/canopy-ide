// @vitest-environment jsdom
import {cleanup,fireEvent,render} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const links=vi.hoisted(()=>({openLink:vi.fn()}));
vi.mock('../links',()=>links);
import {OpenInBrowserButton} from './OpenInBrowserButton';
afterEach(()=>{cleanup();vi.clearAllMocks();});

it('opens the page at its own address in the system browser',()=>{
 const view=render(<OpenInBrowserButton url="http://localhost:6001/auth/login?returnUrl=%2F"/>);
 fireEvent.click(view.getByRole('button',{name:'Open in your browser'}));
 expect(links.openLink).toHaveBeenCalledWith('http://localhost:6001/auth/login?returnUrl=%2F',true);
});
it('is disabled until there is an http page to open',()=>{
 for(const url of ['','about:blank','file:///etc/hosts','javascript:alert(1)']){
  const view=render(<OpenInBrowserButton url={url}/>);
  const button=view.getByRole('button',{name:'Open in your browser'}) as HTMLButtonElement;
  expect(button.disabled).toBe(true);fireEvent.click(button);
  view.unmount();
 }
 expect(links.openLink).not.toHaveBeenCalled();
});
