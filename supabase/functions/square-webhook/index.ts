import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
async function invoke(name:string,body:any){try{await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/${name}`,{method:'POST',headers:{Authorization:`Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,'Content-Type':'application/json'},body:JSON.stringify(body)})}catch(_){}}
Deno.serve(async(req)=>{
  // IMPORTANT: before production, verify the Square webhook signature using Square's current documented algorithm and your webhook signature key.
  // Never trust an unsigned webhook merely because it came to this URL.
  try{
    const event=await req.json();
    if(event.type!=='payment.updated'&&event.type!=='payment.created')return new Response('ok');
    const payment=event.data?.object?.payment;if(!payment)return new Response('ok');
    if(payment.status!=='COMPLETED')return new Response('ok');
    const sb=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const {data:r}=await sb.from('appointment_requests').select('id').eq('square_order_id',payment.order_id).maybeSingle();
    if(r){await sb.from('appointment_requests').update({status:'confirmed',payment_status:'paid',square_payment_id:payment.id}).eq('id',r.id);await sb.from('audit_log').insert({request_id:r.id,action:'payment_completed',details:{square_payment_id:payment.id}});await invoke('calendar-sync',{requestId:r.id,event:'confirmed'});await invoke('notify-status',{requestId:r.id,event:'confirmed'});}
    return new Response('ok');
  }catch(e){return new Response('bad request',{status:400})}
});
