import {it,expect,vi} from 'vitest';
import {render,screen,fireEvent,act,waitFor} from '@testing-library/react';
import {useRemoteUpload} from './useRemoteUpload';
import * as ipc from '../ipc';
vi.mock('../host',()=>({isRemoteHost:()=>true,invoke:vi.fn().mockResolvedValue([])}));
vi.mock('../ipc',()=>({onRemoteDownloadProgress:vi.fn(),remoteDownload:vi.fn(),onRemoteUploadProgress:vi.fn(),remoteUpload:vi.fn(),remoteUploadCancel:vi.fn().mockResolvedValue(undefined)}));
it('uses the existing dialog for transfer progress, cancellation and tree refresh',async()=>{
 let receive:(p:ipc.RemoteUploadProgress)=>void=()=>{};let finish:(p:ipc.RemoteUploadProgress)=>void=()=>{};
 const stop=vi.fn(),notice=vi.fn(),refresh=vi.fn();
 vi.mocked(ipc.onRemoteUploadProgress).mockImplementation(async cb=>{receive=cb;return stop;});
 vi.mocked(ipc.remoteUpload).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 function Harness(){const upload=useRemoteUpload(notice,refresh);return <><button onClick={()=>void upload.startUpload?.('/workspace/data','folder')}>Upload</button>{upload.uploadDialog}</>;}
 render(<Harness/>);fireEvent.click(screen.getByText('Upload'));
 await act(async()=>{});const id=vi.mocked(ipc.remoteUpload).mock.calls.at(-1)![2];
 const progress={id,destination:'/workspace/data',name:'photos/image.jpg',bytes:512,totalBytes:1024,files:1,totalFiles:2,skipped:0,cancelled:false};
 await act(async()=>receive(progress));expect(screen.getByText('50% · 1 / 2 files')).toBeTruthy();expect(screen.getByText('photos/image.jpg')).toBeTruthy();
 fireEvent.click(screen.getByText('Cancel upload'));expect(ipc.remoteUploadCancel).toHaveBeenCalledWith(id);
 await act(async()=>finish({...progress,cancelled:true}));expect(refresh).toHaveBeenCalledOnce();expect(stop).toHaveBeenCalledOnce();expect(notice).toHaveBeenCalledWith('Upload cancelled. 1 completed files were kept.','info');expect(screen.queryByText('Upload to remote workspace')).toBeNull();
});

it('chooses another remote destination before opening the local disk picker',async()=>{
 vi.mocked(ipc.remoteUpload).mockClear();
 vi.mocked(ipc.onRemoteUploadProgress).mockResolvedValue(()=>{});
 vi.mocked(ipc.remoteUpload).mockResolvedValue({id:'done',destination:'/workspace/other',name:'',bytes:0,totalBytes:0,files:1,totalFiles:1,skipped:0,cancelled:false});
 function Harness(){const upload=useRemoteUpload(vi.fn(),vi.fn());return <><button onClick={()=>upload.chooseUploadDestination?.('/workspace/repo','files')}>Upload</button>{upload.uploadDialog}</>;}
 render(<Harness/>);fireEvent.click(screen.getByText('Upload'));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Choose files…'})).toBeEnabled());expect(ipc.remoteUpload).not.toHaveBeenCalled();
 fireEvent.change(screen.getByLabelText('Destination'),{target:{value:'/workspace/other'}});fireEvent.click(screen.getByRole('button',{name:'Go'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Choose files…'})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'Choose files…'}));
 await waitFor(()=>expect(ipc.remoteUpload).toHaveBeenCalledWith('/workspace/other','files',expect.any(String)));
});

it('shows download progress in the same dialog, cancels through the shared channel and says where files went',async()=>{
 let receive:(p:ipc.RemoteUploadProgress)=>void=()=>{};let finish:(p:ipc.RemoteUploadProgress)=>void=()=>{};
 const stop=vi.fn(),notice=vi.fn(),refresh=vi.fn();
 vi.mocked(ipc.onRemoteDownloadProgress).mockImplementation(async cb=>{receive=cb;return stop;});
 vi.mocked(ipc.remoteDownload).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 function Harness(){const t=useRemoteUpload(notice,refresh);return <><button onClick={()=>void t.startDownload?.('/workspace/data',true)}>Get</button>{t.uploadDialog}</>;}
 render(<Harness/>);fireEvent.click(screen.getByText('Get'));
 await act(async()=>{});const call=vi.mocked(ipc.remoteDownload).mock.calls.at(-1)!;expect(call.slice(0,2)).toEqual(['/workspace/data','folder']);const id=call[2];
 const progress={id,destination:'/Users/me/Downloads',name:'data/a.csv',bytes:10,totalBytes:40,files:1,totalFiles:2,skipped:0,cancelled:false};
 await act(async()=>receive(progress));expect(screen.getByText('25% · 1 / 2 files')).toBeTruthy();
 fireEvent.click(screen.getByText('Cancel download'));expect(ipc.remoteUploadCancel).toHaveBeenCalledWith(id);
 await act(async()=>finish({...progress,files:2,bytes:40}));
 expect(notice).toHaveBeenCalledWith('Downloaded 2 files to /Users/me/Downloads.','success');expect(stop).toHaveBeenCalledOnce();
});
