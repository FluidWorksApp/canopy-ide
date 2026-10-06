import {it,expect} from 'vitest';
import {renderHook,act} from '@testing-library/react';
import {connectionLabel,reportConnection,reportWorkspaceLifecycle,useConnectionState} from './connectionState';
it('keeps intentional shutdown status despite transport disconnects, then clears it on wake',()=>{
 const key='lifecycle-test';const {result}=renderHook(()=>useConnectionState(key));
 act(()=>reportWorkspaceLifecycle(key,'stopping'));
 act(()=>reportConnection(key,'reconnecting'));
 expect(connectionLabel(result.current)).toBe('Stopping workspace…');
 act(()=>reportWorkspaceLifecycle(key,'hibernated'));
 act(()=>reportConnection(key,'connected'));
 expect(connectionLabel(result.current)).toBe('Hibernated');
 act(()=>reportWorkspaceLifecycle(key,null));
 act(()=>reportConnection(key,'connected'));
 expect(connectionLabel(result.current)).toBe('Connected');
});
