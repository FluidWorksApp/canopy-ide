import { open, stat, rename, unlink, access } from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// A failed save must leave the previous file intact. The temporary file lives
// beside the destination so rename is atomic on its persistent volume.
export async function writeWorkspaceFile(destination, text) {
  let mode = 0o600;
  try { mode = (await stat(destination)).mode & 0o777; await access(destination,constants.W_OK); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(path.dirname(destination), '.canopy-save-' + randomUUID());
  let handle;
  try {
    handle = await open(temporary, 'wx', mode);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close(); handle = undefined;
    await rename(temporary, destination);
  } finally {
    await handle?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
