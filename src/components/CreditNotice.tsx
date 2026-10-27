import {useState} from 'react';
import {Button} from './ui';
import {creditBanner,openAccountSettings,requestMoreCredit,usd,type CreditExhausted,type Credits} from '../credits';

/** "Request more credit": emails Canopy support from the account. Adding funds
 * is not available during the preview, so this is how credit is restored. */
export function RequestCreditButton({variant='default',lastRequestedAt}:{variant?:'default'|'accent';lastRequestedAt?:string|null}){
 const recent=lastRequestedAt&&Date.now()-new Date(lastRequestedAt).getTime()<86_400_000;
 const [state,setState]=useState<'idle'|'busy'|'sent'|'duplicate'|'error'>(recent?'duplicate':'idle'),[error,setError]=useState('');
 async function send(){
  setState('busy');setError('');
  try{const result=await requestMoreCredit();setState(result.duplicate?'duplicate':'sent');}
  catch(reason){setError(String(reason instanceof Error?reason.message:reason));setState('error');}
 }
 return <div className="credit-request">
  <Button size="sm" variant={variant} disabled={state==='busy'||state==='sent'||state==='duplicate'} onClick={()=>void send()}>{state==='busy'?'Sending…':state==='sent'||state==='duplicate'?'Credit requested':'Request more credit'}</Button>
  {state==='sent'&&<small role="status">Request sent. Canopy support will reply by email.</small>}
  {state==='duplicate'&&<small role="status">You asked in the last day. Canopy support will reply by email.</small>}
  {state==='error'&&<small role="alert">Couldn’t send the request: {error}</small>}
 </div>;
}

export function CreditBanner({credits}:{credits:Credits|null}){
 const banner=creditBanner(credits);if(!banner)return null;
 return <div className={`credit-banner credit-banner-${banner.tone}`} role={banner.tone==='error'?'alert':'status'}><strong>{banner.title}</strong><p>{banner.body}</p></div>;
}

/** Shown in place of a generic startup error when the control plane refuses
 * to start compute for an exhausted balance. */
export function CreditExhaustedNotice({detail}:{detail:CreditExhausted}){
 return <div className="credit-banner credit-banner-error" role="alert">
  <strong>{detail.shared?'Workspace paused by its owner’s balance':'Workspace paused: out of credit'}</strong>
  <p>{detail.shared?detail.message:`Your balance is ${detail.balanceUsd==null?'past the limit':usd(detail.balanceUsd)}. Workspaces can’t start at or below ${usd(detail.cutoffUsd)}. Your files and settings are kept.`}</p>
  {!detail.shared&&<div className="credit-banner-actions"><RequestCreditButton variant="accent"/><Button size="sm" variant="ghost" onClick={openAccountSettings}>View balance</Button></div>}
 </div>;
}
