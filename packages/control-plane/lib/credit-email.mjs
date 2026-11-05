import {CUTOFF_USD,MIN_START_USD,amountToRestoreUsd,formatUsd} from './credit-policy.mjs';
const escapeHtml=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const cutoff=formatUsd(CUTOFF_USD);
const remaining=percent=>balance=>({subject:`You have ${percent}% of your Canopy credit left`,heading:`${percent}% of your credit left`,
 lead:`Your Canopy balance is ${formatUsd(balance)}. Workspace running time is charged per minute from this balance.`,
 next:`Your workspaces keep running for now. When your balance reaches ${cutoff}, your workspaces and their files are permanently deleted, and this can’t be undone. Add credit before then to keep them. You also need at least ${formatUsd(MIN_START_USD)} to create or start a workspace.`});
const COPY={
 pct30:remaining(30),
 pct15:remaining(15),
 pct5:balance=>({...remaining(5)(balance),subject:'Final notice: 5% of your Canopy credit left',heading:'Final notice: 5% of your credit left'}),
 paused:balance=>({subject:'Your Canopy workspaces are being deleted',heading:'Your workspaces are being deleted',
  lead:`Your Canopy balance reached ${formatUsd(balance)}, so your workspaces, their files and their snapshots are being permanently deleted.`,
  next:`This can’t be undone. Your account stays open. To create a new workspace, add at least ${formatUsd(amountToRestoreUsd(balance))} of credit.`}),
};
function moreCredit(supportEmail,addFunds){
 if(addFunds)return `Open Canopy, go to Settings → Account and choose Add funds. Stripe emails your receipt, and the balance updates within a minute.${supportEmail?` Questions: ${supportEmail}.`:''}`;
 return `To get more credit, open Canopy, go to Settings → Account and choose Request more credit${supportEmail?`, or email ${supportEmail}`:''}.`;
}
function page({subject,heading,paragraphs,button,footer}){
 const body=paragraphs.map(([text,muted])=>`<p style="font-size:${muted?14:16}px;line-height:1.7;margin:0 0 16px;${muted?'color:#555f4e;':''}">${text}</p>`).join('');
 const cta=button?`<a href="${escapeHtml(button.href)}" style="display:inline-block;background:#d4f750;border:1px solid #a5c333;border-radius:6px;padding:15px 24px;color:#172006;text-decoration:none;font-size:16px;font-weight:bold;margin:12px 0 8px">${escapeHtml(button.label)} &rarr;</a>`:'';
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head><body style="margin:0;background:#f4f5f0;color:#1c211a;font-family:Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:40px 16px"><table role="presentation" width="560" cellspacing="0" cellpadding="0" style="width:100%;max-width:560px;background:white;border:1px solid #dce0d5;border-radius:12px"><tr><td style="padding:28px 32px;border-bottom:1px solid #e6e8e1;font-size:24px;font-weight:bold">canopy<span style="color:#648000">.</span></td></tr><tr><td style="padding:32px"><h1 style="margin:0 0 20px;font-size:28px">${escapeHtml(heading)}</h1>${body}${cta}<p style="margin:24px 0 0;font-size:15px">The Canopy team</p></td></tr>${footer?`<tr><td style="padding:24px 32px;border-top:1px solid #e6e8e1;font-size:12px;line-height:1.7;color:#68715f">${footer}</td></tr>`:''}</table><p style="font-size:12px;color:#68715f;margin:24px 0">Canopy · Your workspace for building with your own agents</p></td></tr></table></body></html>`;
}
const safeUrl=url=>{const link=new URL(url);if(!['http:','https:'].includes(link.protocol)||link.username||link.password)throw Error('Invalid account URL');return link.href;};

/** Reminder for one notice level: pct30 | pct15 | pct5 | paused. */
export function creditNoticeEmail({level,balanceUsd,accountUrl='https://canopyide.dev/workspaces#history',supportEmail,addFunds=false}){
 const copy=COPY[level];if(!copy)throw Error('Invalid credit notice level');
 const {subject,heading,lead,next}=copy(balanceUsd);const href=safeUrl(accountUrl);const how=moreCredit(supportEmail,addFunds);
 const footer='You’re receiving this because your Canopy account balance crossed a reminder threshold. Each reminder is sent once per crossing.';
 const text=`CANOPY\n\n${heading}\n\n${lead}\n\nBalance: ${formatUsd(balanceUsd)}\nWorkspaces are deleted at: ${cutoff}\n\nWhat happens next\n${next}\n\nHow to get more credit\n${how}\n\nSee your usage:\n${href}\n\nThe Canopy team\nhttps://canopyide.dev\n\n${footer}\n`;
 const html=page({subject,heading,paragraphs:[[escapeHtml(lead)],[`Balance: <strong>${escapeHtml(formatUsd(balanceUsd))}</strong><br>Workspaces are deleted at: <strong>${escapeHtml(cutoff)}</strong>`],[`<strong>What happens next.</strong> ${escapeHtml(next)}`],[`<strong>How to get more credit.</strong> ${escapeHtml(how)}`,true]],button:{href,label:'See your usage'},footer:escapeHtml(footer)});
 return {subject,text,html};
}

/** Sent to the support address when a user asks for more credit. */
export function creditRequestEmail({name,email,balanceUsd,note,requestId}){
 const who=name&&name!==email?`${name} <${email}>`:email;
 const subject=`Credit request from ${email} (balance ${formatUsd(balanceUsd)})`;
 const cleanNote=typeof note==='string'&&note.trim()?note.trim().slice(0,1000):null;
 const command=`node scripts/grant-credit.mjs --email ${email} --amount <usd> --reason "Credit request ${requestId}"`;
 const text=`CANOPY\n\nCredit request\n\n${who} asked for more credit.\n\nBalance: ${formatUsd(balanceUsd)}\nWorkspaces are deleted at: ${cutoff}\nRequest: ${requestId}\n${cleanNote?`\nNote from the user:\n${cleanNote}\n`:''}\nTo grant credit:\n${command}\n`;
 const html=page({subject,heading:'Credit request',paragraphs:[[`${escapeHtml(who)} asked for more credit.`],[`Balance: <strong>${escapeHtml(formatUsd(balanceUsd))}</strong><br>Workspaces are deleted at: <strong>${escapeHtml(cutoff)}</strong><br>Request: ${escapeHtml(requestId)}`],...(cleanNote?[[`<strong>Note from the user.</strong> ${escapeHtml(cleanNote)}`]]:[]),[`To grant credit: <code>${escapeHtml(command)}</code>`,true]]});
 return {subject,text,html};
}
