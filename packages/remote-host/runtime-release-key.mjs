/** Managed compute IAM permits GetObject only beneath the private releases prefix. */
export function runtimeReleaseKey(revision,explicitKey){
 if(typeof revision!=='string'||!/^[a-f0-9]{40}$/.test(revision))throw Error('A full Git revision is required for the runtime release');
 const prefix=`releases/${revision}/`;
 if(explicitKey!==undefined){
  const filename=typeof explicitKey==='string'&&explicitKey.startsWith(prefix)?explicitKey.slice(prefix.length):'';
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.tar\.gz$/.test(filename)||filename.includes('..'))throw Error('Runtime archive key must stay within the exact private release revision');
  return explicitKey;
 }
 return prefix+'workspace-host.tar.gz';
}
