// Layer ownership, shared with the team: "Sam now owns Data in acme/shop" and
// "Sam let go of Data", so every teammate's Canopy enforces the claim
// (src/lensClaimSync.ts writes it to that machine's ledger and republishes its
// policy), not only the computer the claim was made on.
//
// It rides on the team chat's message path as a chat event (chatEvents.ts
// `event`), like live session events: end-to-end encrypted, queued for
// devices that are offline, replay-checked, and never shown as a message,
// counted as unread or notified. It goes to the whole team (the channel), to
// devices that speak chat v4 (LAYER_VERSION); its `text` is the readable
// fallback.
//
// The owner is never in the event: it is the message's sender, which the
// transport authenticated. The repository is named only by its host and
// `owner/name`, and the receiver checks the sender is in the team. Everything
// else is untrusted, bounded and exact-keyed; a malformed event is dropped.
import {UUID,hasControl} from './messageSchema';
import {LAYER_WORDS,validRepo,type LayerName,type RepoRef} from './cardSchema';

/** Lowest chat version that understands layer ownership events. */
export const LAYER_VERSION=4;

export type LayerEvent={
 type:'layer';
 /** The claim's id: the same for a claim and its release, and for every
  *  re-announcement of the claim, so applying one twice changes nothing. */
 target:string;
 op:'claim'|'release';
 layer:LayerName;
 repo:RepoRef;
 /** The owner's display name, as they claimed. */
 owner:string;
 /** When the claim or release was made (ms). */
 at:number;
};

const LAYERS:readonly LayerName[]=['data','auth','deploy','integration'];
const BIDI=/[\u0080-\u009f‪-‮⁦-⁩؜‎‏]/;
const plain=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:object,keys:string[])=>Object.keys(v).every(k=>keys.includes(k));
const name=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0&&[...v].length<=80&&!hasControl(v)&&!BIDI.test(v);

/** A well formed layer event — a fresh object with only the known fields — or undefined. */
export function parseLayerEvent(v:unknown):LayerEvent|undefined{
 if(!plain(v)||v.type!=='layer'||!exact(v,['type','target','op','layer','repo','owner','at']))return undefined;
 if(typeof v.target!=='string'||!UUID.test(v.target))return undefined;
 if(v.op!=='claim'&&v.op!=='release')return undefined;
 if(!LAYERS.includes(v.layer as LayerName)||!validRepo(v.repo)||!name(v.owner))return undefined;
 if(!Number.isSafeInteger(v.at)||(v.at as number)<0)return undefined;
 const repo=v.repo as RepoRef;
 return {type:'layer',target:v.target,op:v.op,layer:v.layer as LayerName,repo:{host:repo.host,slug:repo.slug},owner:(v.owner as string).trim(),at:v.at as number};
}

/** What a client that doesn't know the event shows. */
export function layerText(e:LayerEvent):string{
 return e.op==='claim'
  ?`${e.owner} now owns ${LAYER_WORDS[e.layer]} in ${e.repo.slug}: agents' changes to it need their approval.`
  :`${e.owner} no longer owns ${LAYER_WORDS[e.layer]} in ${e.repo.slug}.`;
}
