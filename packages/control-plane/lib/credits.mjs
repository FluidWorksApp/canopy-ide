export async function debitCredits(client,{userId,workspaceId,eventKey,planId,seconds}){
 if(!Number.isSafeInteger(seconds)||seconds<0||seconds>90)throw Error('Invalid usage interval');
 const plan=await client.query('SELECT * FROM compute_plan WHERE id=$1',[planId]);
 if(!plan.rows[0]?.credits_per_hour)return false; // Rates remain unconfigured until agreed.
 await client.query('SELECT user_id FROM credit_account WHERE user_id=$1 FOR UPDATE',[userId]);
 const entry=await client.query('INSERT INTO credit_ledger(user_id,workspace_id,event_key,kind,amount,plan_id,plan_version,quantity,description) VALUES($1,$2,$3,\'usage\',round(-$4::numeric*$5::numeric/3600,6),$6,$7,$5,\'Workspace running time\') ON CONFLICT(event_key) DO NOTHING RETURNING amount',[userId,workspaceId,eventKey,plan.rows[0].credits_per_hour,seconds,planId,plan.rows[0].version]);
 if(!entry.rows.length)return false;
 await client.query('UPDATE credit_account SET balance=balance+$2::numeric,updated_at=now() WHERE user_id=$1',[userId,entry.rows[0].amount]);return true;
}
