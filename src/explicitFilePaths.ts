import {fsStat} from './ipc';

// An explicit filename/path is the escape hatch for ignored configuration
// files such as .env. It does not add ignored trees to the search corpus.
export async function explicitFilePaths(query: string, roots: string[], inspect = fsStat): Promise<string[]> {
  const value = query.trim();
  if (!value || value.length > 1024 || !/[./\\]/.test(value) || value.includes('\0') || value.split(/[\\/]/).includes('..')) return [];
  const candidates = [...new Set(roots.map(root => {
    const base = root.replace(/[/\\]+$/, '');
    return value.startsWith('/') ? value : base + '/' + value.replace(/^\.\//, '');
  }).filter(file => roots.some(root => file.startsWith(root.replace(/[/\\]+$/, '') + '/'))))];
  const results = await Promise.allSettled(candidates.map(async file => (await inspect(file)).is_dir ? null : file));
  return results.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
}
