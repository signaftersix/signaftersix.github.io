import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
Deno.serve(async(req)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:corsHeaders});
  try{
    const auth=req.headers.get('authorization')||'';
    const client=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:auth}}});
    const {data:{user}}=await client.auth.getUser();if(!user)throw new Error('Unauthorized');
    const {data:aal}=await client.auth.mfa.getAuthenticatorAssuranceLevel();if(aal?.currentLevel!=='aal2')throw new Error('Second-factor verification required');
    const {data:isAdmin}=await client.rpc('is_admin');if(!isAdmin)throw new Error('Admin access required');
    const service=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const {requestId,action,revisedTotal,comment}=await req.json();
    const {data:r,error}=await service.from('appointment_requests').select('*').eq('id',requestId).single();if(error)throw error;
    if(action==='decline'){
      await service.from('appointment_requests').update({status:'declined',admin_comments:comment||null}).eq('id',requestId);
      await audit(service,user.id,requestId,'request_declined',{comment});
      await invoke('calendar-sync',{requestId,event:'pending_release'});await invoke('notify-status',{requestId,event:'declined',comment});
      return json({message:'Request declined and the pending hold is being released.'});
    }
    if(action!=='approve')throw new Error('Unknown action');
    const oldTotal=Number(r.quote_total),newTotal=Number(revisedTotal);
    if(!Number.isFinite(newTotal)||newTotal<0)throw new Error('Invalid revised total');
    if(newTotal>oldTotal+0.001){
      const version=(r.quote_version||1)+1,expires=new Date(Date.now()+2*60*60*1000);
      const acceptanceToken=crypto.randomUUID()+crypto.randomUUID();
      const acceptanceHash=await sha256(acceptanceToken);
      await service.from('quote_revisions').insert({request_id:requestId,version,previous_total:oldTotal,revised_total:newTotal,breakdown:r.quote_breakdown,customer_acceptance_required:true,expires_at:expires.toISOString()});
      await service.from('appointment_requests').update({status:'revised_quote',quote_total:newTotal,quote_version:version,revised_quote_expires_at:expires.toISOString(),acceptance_token_hash:acceptanceHash,admin_comments:comment||null}).eq('id',requestId);
      await audit(service,user.id,requestId,'quote_increased',{from:oldTotal,to:newTotal,expires_at:expires.toISOString()});
      await invoke('notify-status',{requestId,event:'revised_quote',comment,acceptanceToken});
      return json({message:'Higher revised quote sent. Customer has 2 hours to accept before the request expires.'});
    }
    await service.from('appointment_requests').update({status:'approved',quote_total:newTotal,admin_comments:comment||null}).eq('id',requestId);
    await audit(service,user.id,requestId,'request_approved',{from:oldTotal,to:newTotal,comment});
    // Forward the admin bearer token so create-payment-link can independently verify admin + MFA.
    await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/create-payment-link`,{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify({requestId})});
    await invoke('notify-status',{requestId,event:'payment_due',comment});
    return json({message:newTotal<oldTotal?'Approved at the lower reviewed price; payment link created.':'Approved; payment link created.'});
  }catch(e){return json({error:e?.message||'Admin action failed'},400)}
});
async function audit(sb:any,userId:string,requestId:string,action:string,details:any){await sb.from('audit_log').insert({actor_user_id:userId,request_id:requestId,action,details})}
async function invoke(name:string,body:any){try{await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/${name}`,{method:'POST',headers:{Authorization:`Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,'Content-Type':'application/json'},body:JSON.stringify(body)})}catch(_){}}
async function sha256(v:string){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')}
function json(x:any,s=200){return new Response(JSON.stringify(x),{status:s,headers:{...corsHeaders,'Content-Type':'application/json'}})}
