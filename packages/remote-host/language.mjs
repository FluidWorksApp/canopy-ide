import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
let active = 0;
const MAX_MESSAGE = 1024 * 1024;

/** One bounded analysis demand; all server processes and pipes close at deadline.
 * Language servers run in the workspace container, never in the IDE client. */
export async function analyze(args, scopedPath) {
  if (active >= 2) throw new Error('Language analysis capacity reached');
  const file = await scopedPath(args.path);
  if (!/\.(?:[cm]?[jt]sx?)$/.test(file)) throw new Error('This host image supports JavaScript and TypeScript analysis');
  if ((await stat(file)).size > MAX_MESSAGE) throw new Error('File too large');
  const text = args.text ?? await readFile(file, 'utf8');
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_MESSAGE) throw new Error('File too large');
  if (active >= 2) throw new Error('Language analysis capacity reached');
  active++;
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn('typescript-language-server', ['--stdio'], { cwd: '/workspace', stdio: ['pipe', 'pipe', 'ignore'],
        env: { PATH: process.env.PATH, HOME: '/home/agent', LANG: 'C.UTF-8' } });
      let buffer = Buffer.alloc(0), done = false, id = 0, opened = false;
      const uri = pathToFileURL(file).href;
      const pending = new Map();
      let result = { diagnostics: [], symbols: [], complete: false };
      const finish = (error) => {
        if (done) return; done = true; clearTimeout(deadline); clearTimeout(settle);
        child.stdin.destroy(); child.stdout.destroy(); child.kill();
        const kill = setTimeout(() => child.kill('SIGKILL'), 1000); kill.unref();
        child.once('exit', () => clearTimeout(kill));
        if (error) reject(error); else resolve(result);
      };
      const send = message => {
        if (child.stdin.writableLength > MAX_MESSAGE) return finish(new Error('Language server input saturated'));
        const payload = JSON.stringify({ jsonrpc: '2.0', ...message });
        child.stdin.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
      };
      const request = (method, params, callback) => { const key = ++id; pending.set(key, callback); send({ id: key, method, params }); };
      let settle;
      const deadline = setTimeout(() => finish(opened ? undefined : new Error('Language server initialization timed out')), 12_000);
      child.on('error', () => finish(new Error('Language server unavailable in host image')));
      child.stdin.on('error', () => finish(new Error('Language server input closed')));
      child.on('exit', () => { if (!done) finish(new Error('Language server exited during analysis')); });
      child.stdout.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > MAX_MESSAGE * 2) return finish(new Error('Language server response too large'));
        try {
          while (!done) {
            const end = buffer.indexOf('\r\n\r\n'); if (end < 0) break;
            const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())?.[1]);
            if (!Number.isInteger(length) || length < 1 || length > MAX_MESSAGE) throw new Error('Invalid language server frame');
            if (buffer.length < end + 4 + length) break;
            const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
            buffer = buffer.subarray(end + 4 + length);
            if (message.method === 'textDocument/publishDiagnostics' && message.params?.uri === uri) {
              result.diagnostics = (message.params.diagnostics ?? []).slice(0, 256);
              result.complete = true;
              clearTimeout(settle); settle = setTimeout(() => finish(), 500);
            } else if (message.method && message.id != null) {
              send({ id: message.id, result: message.method === 'workspace/configuration' ? (message.params?.items ?? []).map(() => ({})) : null });
            } else if (message.id != null) {
              const callback = pending.get(message.id); pending.delete(message.id);
              if (message.error) return finish(new Error('Language server request failed'));
              callback?.(message.result);
            }
          }
        } catch (error) { finish(error); }
      });
      request('initialize', { processId: null, rootUri: 'file:///workspace', capabilities: { textDocument: { publishDiagnostics: {} } } }, () => {
        opened = true;
        send({ method: 'initialized', params: {} });
        send({ method: 'textDocument/didOpen', params: { textDocument: { uri, version: 1, text,
          languageId: /\.[cm]?tsx?$/.test(file) ? (/tsx$/.test(file) ? 'typescriptreact' : 'typescript') : (/jsx$/.test(file) ? 'javascriptreact' : 'javascript') } } });
        request('textDocument/documentSymbol', { textDocument: { uri } }, symbols => { result.symbols = (symbols ?? []).slice(0, 256); });
      });
    });
  } finally { active--; }
}
