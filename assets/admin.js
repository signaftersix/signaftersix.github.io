(() => {
  const cfg=window.SAS_CONFIG||{};
  const $=id=>document.getElementById(id);
  const login=$('loginPanel'),mfa=$('mfaPanel'),dash=$('dashboard'),btn=$('googleLogin'),out=$('signOut');
  let sb=null, factorId=null, challengeId=null, selectedId=null, allRequests=[];

  if(!cfg.SUPABASE_URL||!cfg.SUPABASE_ANON_KEY){
    btn.addEventListener('click',()=>alert('Add your Supabase URL and anon key to config.js first. Production admin uses Google OAuth + TOTP MFA.'));
    return;
  }
  sb=window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_ANON_KEY);

  btn.addEventListener('click',async()=>{
    await sb.auth.signInWithOAuth({provider:'google',options:{redirectTo:location.href.split('?')[0]+location.search}});
  });
  out.addEventListener('click',async()=>{await sb.auth.signOut();location.href='admin.html'});
  $('enrollMfa').addEventListener('click',enrollMfa);
  $('verifyMfa').addEventListener('click',verifyMfa);
  $('statusFilter').addEventListener('change',renderRequestList);
  $('blockAvailabilityBtn').addEventListener('click',blockAvailability);

  async function sync(){
    const {data:{session}}=await sb.auth.getSession();
    if(!session){login.classList.remove('hidden');mfa.classList.add('hidden');dash.classList.add('hidden');out.classList.add('hidden');return}
    const {data:memberships,error:membershipError}=await sb.from('admin_users').select('user_id').eq('user_id',session.user.id).limit(1);
    if(membershipError||!memberships?.length){
      await sb.auth.signOut();
      login.classList.remove('hidden');mfa.classList.add('hidden');dash.classList.add('hidden');out.classList.add('hidden');
      $('loginMessage').textContent='Access denied. This Google account is not authorized for the Sign After Six admin dashboard.';
      return;
    }
    login.classList.add('hidden');out.classList.remove('hidden');
    const {data:aal}=await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if(aal?.currentLevel!=='aal2'){
      mfa.classList.remove('hidden');dash.classList.add('hidden');
      const {data:factors}=await sb.auth.mfa.listFactors();
      const verified=factors?.totp?.find(f=>f.status==='verified');
      if(verified){factorId=verified.id;$('enrollMfa').classList.add('hidden');$('mfaCodeWrap').classList.remove('hidden');$('verifyMfa').classList.remove('hidden');await makeChallenge();}
      return;
    }
    mfa.classList.add('hidden');dash.classList.remove('hidden');
    await loadRequests();
    await loadAudit();
    const params=new URLSearchParams(location.search);const requestId=params.get('request');if(requestId)await openRequest(requestId);
  }

  async function enrollMfa(){
    $('mfaMessage').textContent='Creating authenticator setup…';
    const {data,error}=await sb.auth.mfa.enroll({factorType:'totp',friendlyName:'Sign After Six Admin'});
    if(error){$('mfaMessage').textContent=error.message;return}
    factorId=data.id;
    const setup=$('mfaSetup');
    setup.replaceChildren();
    const instructions=document.createElement('p');
    instructions.textContent='Scan this QR code with your authenticator app, then enter the six-digit code below.';
    const qr=document.createElement('img');
    qr.src=data.totp.qr_code;
    qr.alt='Authenticator QR code';
    qr.style.maxWidth='220px';
    qr.style.borderRadius='12px';
    setup.append(instructions,qr);
    $('enrollMfa').classList.add('hidden');$('mfaCodeWrap').classList.remove('hidden');$('verifyMfa').classList.remove('hidden');await makeChallenge();$('mfaMessage').textContent='';
  }
  async function makeChallenge(){if(!factorId)return;const {data,error}=await sb.auth.mfa.challenge({factorId});if(error){$('mfaMessage').textContent=error.message;return}challengeId=data.id}
  async function verifyMfa(){
    const code=$('mfaCode').value.trim();if(!/^\d{6}$/.test(code)){$('mfaMessage').textContent='Enter the six-digit code.';return}
    if(!challengeId)await makeChallenge();const {error}=await sb.auth.mfa.verify({factorId,challengeId,code});
    if(error){$('mfaMessage').textContent=error.message;await makeChallenge();return}await sync();
  }

  async function loadRequests(){
    const {data,error}=await sb.from('appointment_requests').select('id,status,customer_name,appointment_at,quote_total,payment_status').order('created_at',{ascending:false}).limit(50);
    if(error){$('requestList').innerHTML=`<p class="empty-state">${esc(error.message)}</p>`;return}
    allRequests=data||[];
    const counts=s=>allRequests.filter(x=>x.status===s).length;
    $('pendingCount').textContent=counts('pending')+counts('revised_quote');$('confirmedCount').textContent=counts('confirmed');$('paymentCount').textContent=counts('awaiting_payment');
    const today=new Date().toLocaleDateString();$('todayCount').textContent=data.filter(x=>new Date(x.appointment_at).toLocaleDateString()===today).length;
    renderRequestList();
  }

  function renderRequestList(){
    const status=$('statusFilter').value;
    const rows=status==='all'?allRequests:allRequests.filter(r=>r.status===status);
    $('requestList').innerHTML=rows.map(r=>`<button class="request-row" data-id="${r.id}"><span><strong>${esc(r.customer_name)}</strong><br><small>${new Date(r.appointment_at).toLocaleString()}</small></span><span><span class="status-pill">${esc(r.status.replaceAll('_',' '))}</span><br><strong>$${Number(r.quote_total).toFixed(2)}</strong></span></button>`).join('')||'<p class="empty-state">No requests match this status.</p>';
    document.querySelectorAll('.request-row').forEach(b=>b.addEventListener('click',()=>openRequest(b.dataset.id)));
  }

  async function loadAudit(){
    const {data,error}=await sb.from('audit_log').select('id,request_id,action,details,created_at').order('created_at',{ascending:false}).limit(100);
    if(error){$('auditLog').textContent=error.message;return}
    $('auditLog').innerHTML=(data||[]).map(x=>`<div class="audit-row"><strong>${esc(x.action.replaceAll('_',' '))}</strong><span>${esc(new Date(x.created_at).toLocaleString())}${x.request_id?` · ${esc(x.request_id.slice(0,8))}`:''}</span></div>`).join('')||'<p class="empty-state">No audit events yet.</p>';
  }

  async function openRequest(id){
    selectedId=id;
    history.replaceState({},'',`admin.html?request=${encodeURIComponent(id)}`);

    const {data:r,error}=await sb.from('appointment_requests').select('*').eq('id',id).maybeSingle();
    if(error){$('requestDetail').textContent=error.message;return}
    if(!r){$('requestDetail').textContent='Appointment request not found.';return}

    const {data:docs}=await sb.from('request_documents').select('*').eq('request_id',id);

    let docHtml='';
    for(const d of docs||[]){
      const {data:signed}=await sb.storage.from('notary-documents').createSignedUrl(d.storage_path,600);
      docHtml+=`<a class="admin-doc" href="${signed?.signedUrl||'#'}" target="_blank" rel="noopener">${esc(d.original_name)}${d.locked?' 🔒':''}</a>`;
    }

    const params=new URLSearchParams(location.search);
    const suggested=params.get('action');

    const appointmentStarted=new Date(r.appointment_at).getTime()<=Date.now();
    const isConfirmed=r.status==='confirmed';
    const isCompleted=r.status==='completed';
    const lifecycleButtons=r.status==='cancel_requested'
      ? '<button id="approveCancelBtn" class="btn btn-primary">Approve Cancellation</button><button id="denyCancelBtn" class="btn btn-secondary">Keep Appointment</button>'
      : r.status==='reschedule_requested'
        ? '<button id="approveRescheduleBtn" class="btn btn-primary">Approve New Time</button><button id="denyRescheduleBtn" class="btn btn-secondary">Keep Original Time</button>'
        : '';

    const completeButtonHtml=isConfirmed
      ? `<button id="completeBtn" class="btn btn-secondary"${appointmentStarted?'':' disabled'}>Mark Completed</button>`
      : '';
    const reviewButtonsHtml=r.status==='pending'
      ? '<button id="approveBtn" class="btn btn-primary">Approve</button><button id="declineBtn" class="btn btn-secondary">Decline</button>'
      : '';

    const scheduledDeleteDates=(docs||[])
      .map(d=>d.delete_after)
      .filter(Boolean)
      .map(v=>new Date(v))
      .filter(d=>!Number.isNaN(d.getTime()))
      .sort((a,b)=>a-b);

    const completionNoteHtml=isCompleted
      ? `<p class="tiny-note"><strong>Completed:</strong> ${r.completed_at?esc(new Date(r.completed_at).toLocaleString()):'Recorded'}${scheduledDeleteDates.length?`<br><strong>Document deletion scheduled:</strong> ${esc(scheduledDeleteDates[0].toLocaleString())}`:'<br>No retained document is currently attached to this request.'}</p>`
      : isConfirmed&&!appointmentStarted
        ? `<p class="tiny-note">Mark Completed becomes available once the scheduled appointment start time arrives.</p>`
        : '';
    const refundNoteHtml=r.refund_status&&r.refund_status!=='not_applicable'
      ? `<div class="refund-notice"><strong>Refund status: ${esc(String(r.refund_status).replaceAll('_',' '))}</strong>${r.refund_amount!=null?`<br>Amount for review: $${Number(r.refund_amount).toFixed(2)}`:''}${r.refund_note?`<br>${esc(r.refund_note)}`:''}</div>`
      : '';

    $('requestDetail').innerHTML=`
      <div class="detail-status"><span class="status-pill">${esc(r.status)}</span><strong>$${Number(r.quote_total).toFixed(2)}</strong></div>
      <h3>${esc(r.customer_name)}</h3><p>${esc(r.customer_email)}<br>${esc(r.customer_phone)}</p>
      <h3>Appointment</h3><p>${new Date(r.appointment_at).toLocaleString()}<br>${esc(r.service_address)}${r.service_unit?'<br>'+esc(r.service_unit):''}</p>
      <p><b>Travel:</b> ${r.one_way_miles??'—'} one-way miles • ${r.duration_minutes} minute appointment</p>
      <h3>Document</h3><p>${esc(r.document_type)}<br>${esc(r.notarial_act)} • ${r.signer_count||'—'} signer(s) • ${r.acts_unknown?'acts unknown':(r.act_count??'—')+' act(s)'}</p>
      <div class="admin-doc-list">${docHtml||'<span class="tiny-note">No document uploaded yet.</span>'}</div>
      <h3>Customer comments</h3><p>${esc(r.customer_comments||'None')}</p>
      ${r.cancellation_reason?`<h3>Cancellation reason</h3><p>${esc(r.cancellation_reason)}</p>`:''}
      ${r.requested_appointment_at?`<h3>Requested new time</h3><p>${esc(new Date(r.requested_appointment_at).toLocaleString())}</p>${r.reschedule_reason?`<p>${esc(r.reschedule_reason)}</p>`:''}`:''}
      <label>Reviewed quote<input id="reviewedQuote" type="number" min="0" step="0.01" value="${Number(r.quote_total).toFixed(2)}"${isConfirmed||isCompleted?' disabled':''}></label>
      <label>Optional response/comment<textarea id="adminComment" rows="3"></textarea></label>
      ${isCompleted||r.status==='cancelled' ? '' : `
      <div class="admin-actions">
        ${lifecycleButtons||reviewButtonsHtml}
        ${completeButtonHtml}
      </div>`}
      ${completionNoteHtml}
      ${refundNoteHtml}
      <p id="actionMessage" class="tiny-note">${suggested==='approve'?'Approval link opened. Review everything before confirming.':suggested==='decline'?'Decline link opened. Review before confirming.':''}</p>`;

    $('approveBtn')?.addEventListener('click',()=>adminAction('approve',r));
    $('declineBtn')?.addEventListener('click',()=>adminAction('decline',r));
    $('completeBtn')?.addEventListener('click',()=>adminAction('complete',r));
    $('approveCancelBtn')?.addEventListener('click',()=>lifecycleAction('approve_cancellation'));
    $('denyCancelBtn')?.addEventListener('click',()=>lifecycleAction('deny_cancellation'));
    $('approveRescheduleBtn')?.addEventListener('click',()=>lifecycleAction('approve_reschedule'));
    $('denyRescheduleBtn')?.addEventListener('click',()=>lifecycleAction('deny_reschedule'));
  }

  async function adminAction(action,current){
    const revised=Number($('reviewedQuote')?.value||current.quote_total);
    const comment=$('adminComment')?.value||'';

    let promptText='';

    if(action==='approve'){
      promptText='Confirm that you want to approve this request?';
    }else if(action==='decline'){
      promptText='Confirm that you want to decline this request?';
    }else if(action==='complete'){
      if(current.status!=='confirmed'){
        $('actionMessage').textContent='Only confirmed appointments can be marked completed.';
        return;
      }

      if(new Date(current.appointment_at).getTime()>Date.now()){
        $('actionMessage').textContent='This appointment cannot be marked completed before its scheduled start time.';
        return;
      }

      promptText='Mark this appointment completed? Uploaded documents will be scheduled for deletion 7 days after completion.';
    }else{
      $('actionMessage').textContent='Unsupported action.';
      return;
    }

    if(!confirm(promptText))return;

    $('actionMessage').textContent=action==='complete'?'Marking completed…':'Saving…';

    const {data:{session}}=await sb.auth.getSession();

    if(!session){
      $('actionMessage').textContent='Your admin session expired. Sign in again.';
      return;
    }

    const payload={
      requestId:selectedId,
      action,
      comment
    };

    if(action==='approve'){
      payload.revisedTotal=revised;
    }

    const res=await fetch(`${cfg.API_BASE_URL}/admin-action`,{
      method:'POST',
      headers:{
        Authorization:`Bearer ${session.access_token}`,
        'Content-Type':'application/json'
      },
      body:JSON.stringify(payload)
    });

    const data=await res.json();

    if(!res.ok){
      $('actionMessage').textContent=data.error||'Could not save.';
      return;
    }

    $('actionMessage').textContent=data.message||'Saved.';
    await loadRequests();
    await loadAudit();
    await openRequest(selectedId);
  }

  async function lifecycleAction(action){
    if(!confirm('Confirm this lifecycle decision?'))return;
    $('actionMessage').textContent='Saving...';
    const {data:{session}}=await sb.auth.getSession();
    const response=await fetch(`${cfg.API_BASE_URL}/admin-lifecycle`,{method:'POST',headers:{Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({requestId:selectedId,action,comment:$('adminComment')?.value||''})});
    const data=await response.json();
    const resultMessage=data.message||data.error||'Saved.';
    $('actionMessage').textContent=resultMessage;
    if(response.ok){await loadRequests();await loadAudit();await openRequest(selectedId);if($('actionMessage'))$('actionMessage').textContent=resultMessage}
  }

  async function blockAvailability(){
    const startsAt=prompt('Unavailable start (example: 2026-09-20 18:00)');if(!startsAt)return;
    const endsAt=prompt('Unavailable end (example: 2026-09-20 21:00)');if(!endsAt)return;
    const reason=prompt('Reason shown only to you','Unavailable')||'Unavailable';
    const {data:{session}}=await sb.auth.getSession();
    const response=await fetch(`${cfg.API_BASE_URL}/admin-lifecycle`,{method:'POST',headers:{Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({action:'block_availability',startsAt:new Date(startsAt).toISOString(),endsAt:new Date(endsAt).toISOString(),reason})});
    const data=await response.json();alert(data.message||data.error||'Finished.');if(response.ok)await loadAudit();
  }

  function esc(s){return String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
  sync();
})();
