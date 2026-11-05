import {expect,it} from 'vitest';
import {copiedText,fitsVncClipboard} from './desktopClipboard';
it('knows what VNC can carry',()=>{expect(fitsVncClipboard('café')).toBe(true);expect(fitsVncClipboard('it’s')).toBe(false);expect(fitsVncClipboard('😀')).toBe(false);});
it('prefers a fresh clipboard, then the highlighted text',()=>{
 expect(copiedText('old','new','highlight')).toBe('new');
 expect(copiedText('old','old','highlight')).toBe('highlight');
 expect(copiedText('old','old','')).toBe('old');
 expect(copiedText('','','')).toBe('');
});
