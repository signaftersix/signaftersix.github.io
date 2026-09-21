import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
Deno.serve(async()=>{
  const sb=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);const now=new Date().toISOString();
  const {data:pending}=await sb.from('appointment_requests').select('id').in('status',['pending']).lte('expires_at',now).limit(200);
  const {data:revised}=await sb.from('appointment_requests').select('id').eq('status','revised_quote').lte('revised_quote_expires_at',now).limit(200);
  const {data:unpaid}=await sb.from('appointment_requests').select('id').eq('status','awaiting_payment').not('payment_due_at','is',null).lte('payment_due_at',now).limit(200);
  const all=[...(pending||[]),...(revised||[]),...(unpaid||[])];
  for(const r of all){await sb.from('appointment_requests').update({status:'expired'}).eq('id',r.id);await sb.from('audit_log').insert({request_id:r.id,action:'request_auto_expired'});await invoke('calendar-sync',{requestId:r.id,event:'pending_release'});await invoke('notify-status',{requestId:r.id,event:'expired'});}
  return new Response(JSON.stringify({expired:all.length}),{headers:{'Content-Type':'application/json'}})
});
async function invoke(name:string,body:any){try{await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/${name}`,{method:'POST',headers:{Authorization:`Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,'Content-Type':'application/json'},body:JSON.stringify(body)})}catch(_){}}
