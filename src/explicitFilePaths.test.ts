import {expect,it,vi} from 'vitest';import {explicitFilePaths} from './explicitFilePaths';
it('opens an explicitly named ignored config within the selected component',async()=>{
 const inspect=vi.fn(async(path:string)=>{if(path==='/repo/api/.env')return {is_dir:false,size:4,modified_ms:null};throw Error('missing');});
 expect(await explicitFilePaths('.env',['/repo/web','/repo/api'],inspect)).toEqual(['/repo/api/.env']);
 expect(await explicitFilePaths('/outside/.env',['/repo/api'],inspect)).toEqual([]);
 expect(await explicitFilePaths('../.env',['/repo/api'],inspect)).toEqual([]);
});
