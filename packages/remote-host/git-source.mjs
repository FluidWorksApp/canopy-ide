export function repositorySource(raw){
 let url=String(raw??'');
 if(/^git@github\.com:/.test(url))url=url.replace(/^git@github\.com:/,'https://github.com/');
 if(url.length>2048||!(/^(https:\/\/[^\s]+|git@[^\s:]+:[^\s]+)$/.test(url)))throw Error('Use an HTTPS or SSH repository URL');
 if(url.startsWith('https:')){const parsed=new URL(url);if(parsed.username||parsed.password||parsed.search||parsed.hash)throw Error('Use the workspace Git account instead of credentials in the URL');}
 const name=url.replace(/\/$/,'').split(/[/:]/).pop().replace(/\.git$/,'');
 if(!/^[a-zA-Z0-9_.-]+$/.test(name)||name==='.'||name==='..')throw Error('Invalid repository name');
 return {url,name};
}
