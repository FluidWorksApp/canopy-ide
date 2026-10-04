/** Commit attribution is independent of the credential used to access Git. */
export function validateGitIdentity(value){
 if(!value||typeof value.name!=='string'||!value.name.trim()||value.name.length>200||/[\x00-\x1f\x7f<>]/.test(value.name)||typeof value.email!=='string'||value.email.length>254||/[\x00-\x1f\x7f]/.test(value.email)||! /^[^\s<>@]+@[^\s<>@]+$/.test(value.email))throw Error('Invalid Git identity');
 return {name:value.name.trim(),email:value.email};
}
export function gitIdentityEnvironment(value){
 const identity=validateGitIdentity(value);
 return {GIT_AUTHOR_NAME:identity.name,GIT_AUTHOR_EMAIL:identity.email,GIT_COMMITTER_NAME:identity.name,GIT_COMMITTER_EMAIL:identity.email};
}
