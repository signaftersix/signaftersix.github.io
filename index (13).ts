import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
Deno.serve(async(req)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:corsHeaders});
  try{
    const auth=req.headers.get('authorization')||'';
    const sb=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:auth}}});
    const {data:{user}}=await sb.auth.getUser(); if(!user)throw new Error('Unauthorized');
    const admin=await sb.rpc('is_admin'); if(!admin.data)throw new Error('Admin access required');
    const {requestId}=await req.json();
    const service=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const {data:r,error}=await service.from('appointment_requests').select('*').eq('id',requestId).single();if(error)throw error;
    const cents=Math.round(Number(r.quote_total)*100);
    const sq=await fetch('https://connect.squareup.com/v2/online-checkout/payment-links',{method:'POST',headers:{Authorization:`Bearer ${Deno.env.get('SQUARE_ACCESS_TOKEN')}`,'Square-Version':'2026-08-19','Content-Type':'application/json'},body:JSON.stringify({idempotency_key:crypto.randomUUID(),quick_pay:{name:`Sign After Six appointment ${r.id.slice(0,8)}`,price_money:{amount:cents,currency:'USD'},location_id:Deno.env.get('SQUARE_LOCATION_ID')}})});
    const out=await sq.json();if(!sq.ok)throw new Error(JSON.stringify(out.errors||out));
    const link=out.payment_link;
    const hoursToAppt=(new Date(r.appointment_at).getTime()-Date.now())/36e5;
    const paymentDueAt=hoursToAppt>24?new Date(Date.now()+4*36e5).toISOString():null;
    await service.from('appointment_requests').update({square_payment_link_id:link.id,square_payment_link_url:link.url,square_order_id:link.order_id,status:'awaiting_payment',payment_due_at:paymentDueAt}).eq('id',requestId);
    await service.from('audit_log').insert({actor_user_id:user.id,request_id:requestId,action:'payment_link_created',details:{payment_link_id:link.id}});
    return json({url:link.url});
  }catch(e){return json({error:e?.message||'Failed'},400)}
});
function json(x:any,s=200){return new Response(JSON.stringify(x),{status:s,headers:{...corsHeaders,'Content-Type':'application/json'}})}
