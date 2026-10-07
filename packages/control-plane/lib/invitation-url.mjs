import {isIP} from 'node:net';
/** Invitation delivery is independent of development/preview authentication
 * origins. Only an explicitly configured public HTTPS hostname can override it. */
export function invitationPublicOrigin(configured=process.env.CANOPY_PUBLIC_URL){
 const value=configured??'https://canopyide.dev';let url;
 try{url=new URL(value);}catch{throw Error('Public invitation origin is invalid');}
 const host=url.hostname.toLowerCase().replace(/\.$/,'');
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.port||!host.includes('.')||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||isIP(host.replace(/^\[|\]$/g,''))||!/^[a-z0-9.-]+$/.test(host))throw Error('Public invitation origin must be a public HTTPS hostname');
 return url.origin;
}
export function invitationAcceptanceUrl(kind='organization',configured){
 if(!['organization','team','workspace'].includes(kind))throw Error('Invalid invitation type');
 return new URL(kind==='workspace'?'/workspaces':'/teams',invitationPublicOrigin(configured)).href;
}
