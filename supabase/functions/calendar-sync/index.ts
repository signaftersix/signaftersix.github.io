import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
Deno.serve(async(req)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:corsHeaders});
  try{
    const {requestId,event}=await req.json();
    const sb=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const {data:r,error}=await sb.from('appointment_requests').select('*').eq('id',requestId).single();if(error)throw error;
    const token=await googleAccessToken();
    if(event==='pending_release'){
      if(r.pending_calendar_event_id){await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(Deno.env.get('GOOGLE_PENDING_CALENDAR_ID')!)}/events/${encodeURIComponent(r.pending_calendar_event_id)}`,{method:'DELETE',headers:{Authorization:`Bearer ${token}`}})}
      await sb.from('appointment_requests').update({pending_calendar_event_id:null}).eq('id',requestId);return json({released:true});
    }
    if(event==='confirmed'&&r.pending_calendar_event_id){await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(Deno.env.get('GOOGLE_PENDING_CALENDAR_ID')!)}/events/${encodeURIComponent(r.pending_calendar_event_id)}`,{method:'DELETE',headers:{Authorization:`Bearer ${token}`}})}
    const calendarId=event==='pending_hold'?Deno.env.get('GOOGLE_PENDING_CALENDAR_ID'):Deno.env.get('GOOGLE_CONFIRMED_CALENDAR_ID');
    if(!calendarId)throw new Error('Calendar ID missing');
    const apptStart=new Date(r.appointment_at);const travelMs=(r.one_way_travel_seconds||0)*1000;
    const blockStart=new Date(apptStart.getTime()-travelMs);const blockEnd=new Date(apptStart.getTime()+r.duration_minutes*60_000+travelMs);
    const body={summary:event==='pending_hold'?'Pending Notary Request':`Notary • ${r.customer_name}`,location:r.service_address,description:`Request ${r.id}\n${r.document_type}\nQuoted $${Number(r.quote_total).toFixed(2)}`,start:{dateTime:blockStart.toISOString(),timeZone:'America/New_York'},end:{dateTime:blockEnd.toISOString(),timeZone:'America/New_York'},transparency:'opaque'};
    const res=await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId!)}/events`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});const out=await res.json();if(!res.ok)throw new Error(JSON.stringify(out));
    const field=event==='pending_hold'?'pending_calendar_event_id':'confirmed_calendar_event_id';await sb.from('appointment_requests').update({[field]:out.id}).eq('id',requestId);
    return json({eventId:out.id});
  }catch(e){return json({error:e?.message||'Calendar sync failed'},400)}
});
async function googleAccessToken(){const body=new URLSearchParams({client_id:Deno.env.get('GOOGLE_CLIENT_ID')!,client_secret:Deno.env.get('GOOGLE_CLIENT_SECRET')!,refresh_token:Deno.env.get('GOOGLE_REFRESH_TOKEN')!,grant_type:'refresh_token'});const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});const j=await r.json();if(!r.ok)throw new Error('Google token failed');return j.access_token}
function json(x:any,s=200){return new Response(JSON.stringify(x),{status:s,headers:{...corsHeaders,'Content-Type':'application/json'}})}
