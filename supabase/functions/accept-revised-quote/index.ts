import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
Deno.serve(async(req)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:corsHeaders});
  try{
    const {requestId,acceptanceToken,action='preview'}=await req.json();
    if(!requestId||!acceptanceToken)throw new Error('Missing acceptance credentials');
    const sb=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const {data:r,error}=await sb.from('appointment_requests').select('*').eq('id',requestId).single();if(error)throw error;
    if(r.status!=='revised_quote')throw new Error('This revised quote is no longer pending');
    if(!r.revised_quote_expires_at||new Date(r.revised_quote_expires_at)<=new Date())throw new Error('This revised quote has expired');
    const hash=await sha256(acceptanceToken);if(hash!==r.acceptance_token_hash)throw new Error('Invalid or expired link');
    const {data:rev}=await sb.from('quote_revisions').select('*').eq('request_id',requestId).eq('version',r.quote_version).single();
    if(action==='preview')return json({requestId,appointmentAt:r.appointment_at,revisedTotal:Number(r.quote_total),previousTotal:Number(rev?.previous_total??r.quote_total),expiresAt:r.revised_quote_expires_at});
    if(action==='decline'){
      await sb.from('appointment_requests').update({status:'declined',acceptance_token_hash:null}).eq('id',requestId);
      await sb.from('audit_log').insert({request_id:requestId,action:'revised_quote_declined_by_customer'});
      await invoke('calendar-sync',{requestId,event:'pending_release'});await invoke('notify-status',{requestId,event:'declined'});
      return json({status:'declined'});
    }
    if(action!=='accept')throw new Error('Unknown action');
    await sb.from('quote_revisions').update({accepted_at:new Date().toISOString()}).eq('request_id',requestId).eq('version',r.quote_version);
    const payment=await createSquareLink(r);
    const hoursToAppt=(new Date(r.appointment_at).getTime()-Date.now())/36e5;const paymentDueAt=hoursToAppt>24?new Date(Date.now()+4*36e5).toISOString():null;
    await sb.from('appointment_requests').update({status:'awaiting_payment',acceptance_token_hash:null,square_payment_link_id:payment.id,square_payment_link_url:payment.url,square_order_id:payment.order_id,payment_due_at:paymentDueAt}).eq('id',requestId);
    await sb.from('audit_log').insert({request_id:requestId,action:'revised_quote_accepted_by_customer',details:{quote_total:r.quote_total}});
    await invoke('notify-status',{requestId,event:'payment_due'});
    return json({status:'accepted',paymentUrl:payment.url});
  }catch(e){return json({error:e?.message||'Unable to review quote'},400)}
});
async function createSquareLink(r:any){const res=await fetch('https://connect.squareup.com/v2/online-checkout/payment-links',{method:'POST',headers:{Authorization:`Bearer ${Deno.env.get('SQUARE_ACCESS_TOKEN')}`,'Square-Version':'2026-08-19','Content-Type':'application/json'},body:JSON.stringify({idempotency_key:crypto.randomUUID(),quick_pay:{name:`Sign After Six appointment ${r.id.slice(0,8)}`,price_money:{amount:Math.round(Number(r.quote_total)*100),currency:'USD'},location_id:Deno.env.get('SQUARE_LOCATION_ID')}})});const j=await res.json();if(!res.ok)throw new Error('Unable to create payment link');return j.payment_link}
async function invoke(name:string,body:any){try{await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/${name}`,{method:'POST',headers:{Authorization:`Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,'Content-Type':'application/json'},body:JSON.stringify(body)})}catch(_){}}
async function sha256(v:string){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')}
function json(x:any,s=200){return new Response(JSON.stringify(x),{status:s,headers:{...corsHeaders,'Content-Type':'application/json'}})}
