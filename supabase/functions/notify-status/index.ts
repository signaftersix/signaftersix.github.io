import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
Deno.serve(async(req)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:corsHeaders});
  try{
    const {requestId,event,comment,acceptanceToken}=await req.json();
    const sb=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const {data:r,error}=await sb.from('appointment_requests').select('*').eq('id',requestId).single();if(error)throw error;
    if(event==='new_request'){
      await sendGmail(Deno.env.get('BUSINESS_EMAIL')!,`New pending notary request • ${r.customer_name}`,adminEmail(r));
    } else {
      await sendGmail(r.customer_email,customerSubject(event),customerEmail(r,event,comment,acceptanceToken));
      if(['approved','declined','payment_due','reminder_24h','reminder_2h','expired','confirmed','revised_quote'].includes(event)) await sendSms(r.customer_phone,smsText(r,event));
    }
    return json({ok:true});
  }catch(e){return json({error:e?.message||'Notification failed'},400)}
});

async function sendGmail(to:string,subject:string,html:string){
  // Gmail API OAuth refresh token must be stored as Supabase secrets, never in GitHub.
  const token=await googleAccessToken();
  const fromName='Sign After Six Mobile Notary';
  const raw=[`From: ${fromName} <${Deno.env.get('BUSINESS_EMAIL')}>`,`To: ${to}`,`Subject: ${subject}`,'MIME-Version: 1.0','Content-Type: text/html; charset=UTF-8','',html].join('\r\n');
  const encoded=btoa(unescape(encodeURIComponent(raw))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const res=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({raw:encoded})});
  if(!res.ok)throw new Error(`Gmail send failed: ${await res.text()}`);
}
async function googleAccessToken(){
  const body=new URLSearchParams({client_id:Deno.env.get('GOOGLE_CLIENT_ID')!,client_secret:Deno.env.get('GOOGLE_CLIENT_SECRET')!,refresh_token:Deno.env.get('GOOGLE_REFRESH_TOKEN')!,grant_type:'refresh_token'});
  const res=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});const j=await res.json();if(!res.ok)throw new Error('Google OAuth refresh failed');return j.access_token;
}
async function sendSms(to:string,text:string){
  const key=Deno.env.get('TELNYX_API_KEY'),from=Deno.env.get('TELNYX_FROM_NUMBER');if(!key||!from)return;
  await fetch('https://api.telnyx.com/v2/messages',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({from,to,text})});
}
function adminEmail(r:any){
  const url=`${Deno.env.get('PUBLIC_SITE_ORIGIN')}/admin.html?request=${r.id}`;
  return `<h2>New pending request</h2><p><b>${esc(r.customer_name)}</b> • ${esc(r.customer_phone)} • ${esc(r.customer_email)}</p><p>${new Date(r.appointment_at).toLocaleString('en-US',{timeZone:'America/New_York'})}<br>${esc(r.service_address)}</p><p>${esc(r.document_type)} • Estimated total: $${Number(r.quote_total).toFixed(2)}</p><p>Use the secure dashboard to review uploads and decide:</p><p><a href="${url}&action=approve">Review / Approve</a> &nbsp; <a href="${url}&action=decline">Review / Decline</a></p><p>Both links require authorized Google sign-in and MFA before any action can be completed.</p>`;
}
function customerSubject(e:string){return ({approved:'Appointment approved',declined:'Appointment request declined',payment_due:'Payment needed to confirm your appointment',expired:'Appointment request expired',reminder_24h:'Notary appointment tomorrow',reminder_2h:'Notary appointment in 2 hours',confirmed:'Appointment confirmed',revised_quote:'Your quote was revised'} as any)[e]||'Sign After Six update'}
function customerEmail(r:any,e:string,c?:string,token?:string){const revise=(e==='revised_quote'&&token)?`<p>The reviewed quote is <b>$${Number(r.quote_total).toFixed(2)}</b>. You have 2 hours to accept it.</p><p><a href="${Deno.env.get('PUBLIC_SITE_ORIGIN')}/quote-review.html?request=${encodeURIComponent(r.id)}&token=${encodeURIComponent(token)}">Review revised quote</a></p>`:'';return `<h2>${customerSubject(e)}</h2><p>Hi ${esc(r.customer_name)},</p><p>Your Sign After Six request status is <b>${esc(e.replace('_',' '))}</b>.</p>${c?`<p>Note: ${esc(c)}</p>`:''}${revise}${r.square_payment_link_url&&e==='payment_due'?`<p><a href="${r.square_payment_link_url}">Pay securely with Square</a></p>`:''}<p>Appointment: ${new Date(r.appointment_at).toLocaleString('en-US',{timeZone:'America/New_York'})}</p>`}
function smsText(r:any,e:string){return `Sign After Six: ${customerSubject(e)}. Check your email for details.`}
function esc(s:any){return String(s??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'} as any)[c])}
function json(x:any,s=200){return new Response(JSON.stringify(x),{status:s,headers:{...corsHeaders,'Content-Type':'application/json'}})}
