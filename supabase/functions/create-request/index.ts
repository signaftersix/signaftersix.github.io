import { fromZonedTime } from 'https://esm.sh/date-fns-tz@3.2.0';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

const allowedTypes = new Set(['application/pdf','image/jpeg','image/png']);
const maxFiles = 10;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok',{headers:corsHeaders});
  if (req.method !== 'POST') return json({error:'Method not allowed'},405);
  try {
    const supabase=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const form=await req.formData();
    const payload=JSON.parse(String(form.get('payload')||'{}'));
    validatePayload(payload);
    const files=form.getAll('documents').filter((x): x is File => x instanceof File);
    if(files.length>maxFiles) throw new Error('Maximum 10 files');
    for(const f of files){if(!allowedTypes.has(f.type))throw new Error(`Unsupported file type: ${f.type}`)}

    const a=payload.appointment,d=payload.document,c=payload.customer,q=payload.quote;
    const appointmentAt=fromZonedTime(`${a.date} ${a.time}:00`,'America/New_York');
    const hours=(appointmentAt.getTime()-Date.now())/36e5;
    const expiresAt=new Date(Math.min(appointmentAt.getTime()-30*60_000, Date.now()+(hours<=24?Math.max(1,hours/2)*36e5:24*36e5)));
    const {data:record,error}=await supabase.from('appointment_requests').insert({
      customer_name:c.name,customer_email:c.email,customer_phone:c.phone,preferred_contact:c.preferredContact,referral:c.referral,
      appointment_at:appointmentAt.toISOString(),backup_time:a.backupTime||null,service_address:a.address,service_unit:a.unit||null,service_zip:a.zip,
      location_notes:a.locationNotes||null,emergency_opening:!!a.emergencyOpening,one_way_miles:q.miles||null,one_way_travel_seconds:q.travelSeconds||null,duration_minutes:q.duration,
      document_type:d.type,notarial_act:d.notarialAct,signer_count:Number(d.signers)||1,act_count:d.acts==='unknown'?null:Number(d.acts),acts_unknown:d.acts==='unknown',needs_witnesses:!!d.needsWitnesses,
      document_notes:d.notes||null,customer_comments:payload.customerComments||null,accommodations:payload.extras.accommodations||[],extras:payload.extras,
      quote_breakdown:q.lines,quote_total:q.total,expires_at:expiresAt.toISOString()
    }).select('id').single();
    if(error)throw error;

    for(const file of files){
      const safe=file.name.replace(/[^a-zA-Z0-9._-]/g,'_');
      const path=`${record.id}/${crypto.randomUUID()}-${safe}`;
      const {error:uploadError}=await supabase.storage.from('notary-documents').upload(path,file,{contentType:file.type,upsert:false});
      if(uploadError)throw uploadError;
      await supabase.from('request_documents').insert({request_id:record.id,storage_path:path,original_name:file.name,mime_type:file.type,byte_size:file.size});
    }
    await supabase.from('audit_log').insert({request_id:record.id,action:'request_created',details:{source:'public_site',file_count:files.length}});

    // Keep side effects separate so a notification outage does not lose the request.
    await invokeBestEffort('notify-status',{requestId:record.id,event:'new_request'});
    await invokeBestEffort('calendar-sync',{requestId:record.id,event:'pending_hold'});
    return json({requestId:record.id,status:'pending'},201);
  } catch (e) { return json({error:e?.message||'Unable to create request'},400); }
});

function validatePayload(p:any){
  if(!p?.customer?.name||!p?.customer?.email||!p?.customer?.phone)throw new Error('Missing customer details');
  if(!p?.appointment?.date||!p?.appointment?.time||!p?.appointment?.address)throw new Error('Missing appointment details');
  if(Number(p?.quote?.miles)>75)throw new Error('Online requests are limited to 75 miles');
  if(!p?.document?.type||!p?.document?.notarialAct)throw new Error('Missing document details');
}
async function invokeBestEffort(name:string,body:any){
  try{await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/${name}`,{method:'POST',headers:{Authorization:`Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,'Content-Type':'application/json'},body:JSON.stringify(body)})}catch(_){/* audit/retry in production */}
}
function json(body:any,status=200){return new Response(JSON.stringify(body),{status,headers:{...corsHeaders,'Content-Type':'application/json'}})}
