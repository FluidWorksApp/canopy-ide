import {CUTOFF_USD,amountToRestoreUsd,formatUsd} from './credit-policy.mjs';
const escapeHtml=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const cutoff=formatUsd(CUTOFF_USD);
const COPY={
 low:balance=>({subject:'Your Canopy balance is running low',heading:'Your balance is running low',
  lead:`Your Canopy balance is ${formatUsd(balance)}. Workspace running time is charged per minute from this balance.`,
  next:`Your workspaces keep running. If the balance reaches ${cutoff}, running workspaces are stopped and can’t be started again until credit is added. Your files are always kept.`}),
 zero:balance=>({subject:'You’re out of Canopy credit',heading:'You’re out of credit',
  lead:`Your Canopy balance is ${formatUsd(balance)}. Usage now runs on a short allowance that stops at ${cutoff}.`,
  next:`You have ${formatUsd(Number(balance)-CUTOFF_USD)} of running time left before your workspaces pause. When they pause, running work stops but your files, snapshots and settings are kept.`}),
 final:balance=>({subject:`Final notice: your Canopy workspaces pause at ${cutoff}`,heading:'Final notice',
  lead:`Your Canopy balance is ${formatUsd(balance)}. Your workspaces pause when it reaches ${cutoff}, in about ${formatUsd(Number(balance)-CUTOFF_USD)} of running time.`,
  next:'When they pause, running agents and jobs stop and new starts are blocked until credit is added. Nothing is deleted.'}),
 paused:balance=>({subject:'Your Canopy workspaces are paused',heading:'Your workspaces are paused',
  lead:`Your Canopy balance reached ${formatUsd(balance)}, past the ${cutoff} limit, so we stopped your running workspaces and saved them.`,
  next:`Your files, snapshots, settings and account are kept; nothing was deleted. Workspaces can start again once at least ${formatUsd(amountToRestoreUsd(balance))} of credit is added.`}),
};
function moreCredit(supportEmail){
 return `Adding funds isn’t available during the preview. To get more credit, open Canopy, go to Settings → Account and choose Request more credit${supportEmail?`, or email ${supportEmail}`:''}.`;
}
function page({subject,heading,paragraphs,button,footer}){
 const body=paragraphs.map(([text,muted])=>`<p style="font-size:${muted?14:16}px;line-height:1.7;margin:0 0 16px;${muted?'color:#555f4e;':''}">${text}</p>`).join('');
 const cta=button?`<a href="${escapeHtml(button.href)}" style="display:inline-block;background:#d4f750;border:1px solid #a5c333;border-radius:6px;padding:15px 24px;color:#172006;text-decoration:none;font-size:16px;font-weight:bold;margin:12px 0 8px">${escapeHtml(button.label)} &rarr;</a>`:'';
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head><body style="margin:0;background:#f4f5f0;color:#1c211a;font-family:Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:40px 16px"><table role="presentation" width="560" cellspacing="0" cellpadding="0" style="width:100%;max-width:560px;background:white;border:1px solid #dce0d5;border-radius:12px"><tr><td style="padding:28px 32px;border-bottom:1px solid #e6e8e1;font-size:24px;font-weight:bold">canopy<span style="color:#648000">.</span></td></tr><tr><td style="padding:32px"><h1 style="margin:0 0 20px;font-size:28px">${escapeHtml(heading)}</h1>${body}${cta}<p style="margin:24px 0 0;font-size:15px">The Canopy team</p></td></tr>${footer?`<tr><td style="padding:24px 32px;border-top:1px solid #e6e8e1;font-size:12px;line-height:1.7;color:#68715f">${footer}</td></tr>`:''}</table><p style="font-size:12px;color:#68715f;margin:24px 0">Canopy · Your workspace for building with your own agents</p></td></tr></table></body></html>`;
}
const safeUrl=url=>{const link=new URL(url);if(!['http:','https:'].includes(link.protocol)||link.username||link.password)throw Error('Invalid account URL');return link.href;};

/** Reminder for one notice level: low | zero | final | paused. */
export function creditNoticeEmail({level,balanceUsd,accountUrl='https://canopyide.dev/workspaces#history',supportEmail}){
 const copy=COPY[level];if(!copy)throw Error('Invalid credit notice level');
 const {subject,heading,lead,next}=copy(balanceUsd);const href=safeUrl(accountUrl);const how=moreCredit(supportEmail);
 const footer='You’re receiving this because your Canopy account balance crossed a reminder threshold. Each reminder is sent once per crossing.';
 const text=`CANOPY\n\n${heading}\n\n${lead}\n\nBalance: ${formatUsd(balanceUsd)}\nWorkspaces pause at: ${cutoff}\n\nWhat happens next\n${next}\n\nHow to get more credit\n${how}\n\nSee your usage:\n${href}\n\nThe Canopy team\nhttps://canopyide.dev\n\n${footer}\n`;
 const html=page({subject,heading,paragraphs:[[escapeHtml(lead)],[`Balance: <strong>${escapeHtml(formatUsd(balanceUsd))}</strong><br>Workspaces pause at: <strong>${escapeHtml(cutoff)}</strong>`],[`<strong>What happens next.</strong> ${escapeHtml(next)}`],[`<strong>How to get more credit.</strong> ${escapeHtml(how)}`,true]],button:{href,label:'See your usage'},footer:escapeHtml(footer)});
 return {subject,text,html};
}

/** Sent to the support address when a user asks for more credit. */
export function creditRequestEmail({name,email,balanceUsd,note,requestId}){
 const who=name&&name!==email?`${name} <${email}>`:email;
 const subject=`Credit request from ${email} (balance ${formatUsd(balanceUsd)})`;
 const cleanNote=typeof note==='string'&&note.trim()?note.trim().slice(0,1000):null;
 const command=`node scripts/grant-credit.mjs --email ${email} --amount <usd> --reason "Credit request ${requestId}"`;
 const text=`CANOPY\n\nCredit request\n\n${who} asked for more credit.\n\nBalance: ${formatUsd(balanceUsd)}\nWorkspaces pause at: ${cutoff}\nRequest: ${requestId}\n${cleanNote?`\nNote from the user:\n${cleanNote}\n`:''}\nTo grant credit:\n${command}\n`;
 const html=page({subject,heading:'Credit request',paragraphs:[[`${escapeHtml(who)} asked for more credit.`],[`Balance: <strong>${escapeHtml(formatUsd(balanceUsd))}</strong><br>Workspaces pause at: <strong>${escapeHtml(cutoff)}</strong><br>Request: ${escapeHtml(requestId)}`],...(cleanNote?[[`<strong>Note from the user.</strong> ${escapeHtml(cleanNote)}`]]:[]),[`To grant credit: <code>${escapeHtml(command)}</code>`,true]]});
 return {subject,text,html};
}
