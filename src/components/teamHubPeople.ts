// Display helpers for the Teams panel: who a row is, how it is labelled and
// which avatar tint it wears. Pure, so the panel and its tests agree on them.
export type Person={id:string;name?:string|null;email?:string|null};

// Theme tokens only. Each skin redefines these, so avatars follow the theme.
export const AVATAR_TONES=['--accent','--ok','--warn','--cyan','--magenta','--danger'] as const;

const clean=(value?:string|null)=>(value??'').trim();

/** The name to lead with. A server name that is just the email again (or
 *  missing) falls back to the email, so a row is never blank. */
export function displayName(person:Person){
 const name=clean(person.name),email=clean(person.email);
 return name&&name.toLowerCase()!==email.toLowerCase()?name:email||name||'Unknown';
}

/** The secondary line: the email, only when it is not already the name. */
export function secondaryEmail(person:Person){
 const email=clean(person.email);
 return email&&displayName(person)!==email?email:'';
}

/** Up to two initials from the name, else from the email's local part
 *  ("ada.lovelace@x" -> "AL"). */
export function initials(person:Person){
 const name=clean(person.name),email=clean(person.email);
 const source=name&&name.toLowerCase()!==email.toLowerCase()?name:email.split('@')[0]??'';
 const words=source.split(/[\s._+-]+/).filter(w=>/[\p{L}\p{N}]/u.test(w));
 const letters=(words.length>1?[words[0],words[words.length-1]]:[words[0]??'']).map(w=>Array.from(w.replace(/[^\p{L}\p{N}]/gu,''))[0]??'').join('');
 return letters.toUpperCase()||'?';
}

/** Deterministic tint, so a teammate keeps the same colour everywhere. */
export function avatarTone(person:Person){
 const key=clean(person.id)||clean(person.email)||displayName(person);
 let hash=0;for(const ch of key)hash=(hash*31+(ch.codePointAt(0)??0))>>>0;
 return AVATAR_TONES[hash%AVATAR_TONES.length];
}
