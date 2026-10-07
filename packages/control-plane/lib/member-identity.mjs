// Called only after current workspace membership and credential checks.
export async function memberGitIdentity(db,memberId){
 const user=(await db.query('SELECT name,email FROM "user" WHERE id=$1',[memberId])).rows[0];
 if(!user||typeof user.email!=='string'||user.email.length>254||/[\x00-\x1f\x7f]/.test(user.email)||!/^[^\s<>@]+@[^\s<>@]+$/.test(user.email))throw Error('Member Git identity is unavailable');
 const name=typeof user.name==='string'&&user.name.trim()?user.name.trim():user.email;
 if(name.length>200||/[\x00-\x1f\x7f<>]/.test(name))throw Error('Member Git identity is unavailable');
 return {name,email:user.email};
}
