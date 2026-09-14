(() => {
  const cfg=window.SAS_CONFIG||{};
  const $=id=>document.getElementById(id);
  const login=$('loginPanel'),mfa=$('mfaPanel'),dash=$('dashboard'),btn=$('googleLogin'),out=$('signOut');
  let sb=null, factorId=null, challengeId=null, selectedId=null;

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

  async function sync(){
    const {data:{session}}=await sb.auth.getSession();
    if(!session){login.classList.remove('hidden');mfa.classList.add('hidden');dash.classList.add('hidden');out.classList.add('hidden');return}
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
    const params=new URLSearchParams(location.search);const requestId=params.get('request');if(requestId)await openRequest(requestId);
  }

  async function enrollMfa(){
    $('mfaMessage').textContent='Creating authenticator setup…';
    const {data,error}=await sb.auth.mfa.enroll({factorType:'totp',friendlyName:'Sign After Six Admin'});
    if(error){$('mfaMessage').textContent=error.message;return}
    factorId=data.id;
    $('mfaSetup').innerHTML=`<p>Scan this QR code with your authenticator app, then enter the six-digit code below.</p><img src="${data.totp.qr_code}" alt="Authenticator QR code" style="max-width:220px;border-radius:12px">`;
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
    const counts=s=>data.filter(x=>x.status===s).length;
    $('pendingCount').textContent=counts('pending')+counts('revised_quote');$('confirmedCount').textContent=counts('confirmed');$('paymentCount').textContent=counts('awaiting_payment');
    const today=new Date().toLocaleDateString();$('todayCount').textContent=data.filter(x=>new Date(x.appointment_at).toLocaleDateString()===today).length;
    $('requestList').innerHTML=data.map(r=>`<button class="request-row" data-id="${r.id}"><span><strong>${esc(r.customer_name)}</strong><br><small>${new Date(r.appointment_at).toLocaleString()}</small></span><span><span class="status-pill">${esc(r.status)}</span><br><strong>$${Number(r.quote_total).toFixed(2)}</strong></span></button>`).join('')||'<p class="empty-state">No requests yet.</p>';
    document.querySelectorAll('.request-row').forEach(b=>b.addEventListener('click',()=>openRequest(b.dataset.id)));
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

    const completeButtonHtml=isConfirmed
      ? `<button id="completeBtn" class="btn btn-secondary"${appointmentStarted?'':' disabled'}>Mark Completed</button>`
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

    $('requestDetail').innerHTML=`
      <div class="detail-status"><span class="status-pill">${esc(r.status)}</span><strong>$${Number(r.quote_total).toFixed(2)}</strong></div>
      <h3>${esc(r.customer_name)}</h3><p>${esc(r.customer_email)}<br>${esc(r.customer_phone)}</p>
      <h3>Appointment</h3><p>${new Date(r.appointment_at).toLocaleString()}<br>${esc(r.service_address)}${r.service_unit?'<br>'+esc(r.service_unit):''}</p>
      <p><b>Travel:</b> ${r.one_way_miles??'—'} one-way miles • ${r.duration_minutes} minute appointment</p>
      <h3>Document</h3><p>${esc(r.document_type)}<br>${esc(r.notarial_act)} • ${r.signer_count||'—'} signer(s) • ${r.acts_unknown?'acts unknown':(r.act_count??'—')+' act(s)'}</p>
      <div class="admin-doc-list">${docHtml||'<span class="tiny-note">No document uploaded yet.</span>'}</div>
      <h3>Customer comments</h3><p>${esc(r.customer_comments||'None')}</p>
      <label>Reviewed quote<input id="reviewedQuote" type="number" min="0" step="0.01" value="${Number(r.quote_total).toFixed(2)}"${isConfirmed||isCompleted?' disabled':''}></label>
      <label>Optional response/comment<textarea id="adminComment" rows="3"></textarea></label>
      <div class="admin-actions">
        <button id="approveBtn" class="btn btn-primary"${isConfirmed||isCompleted?' disabled':''}>Approve</button>
        <button id="declineBtn" class="btn btn-secondary"${isCompleted?' disabled':''}>Decline</button>
        ${completeButtonHtml}
      </div>
      ${completionNoteHtml}
      <p id="actionMessage" class="tiny-note">${suggested==='approve'?'Approval link opened. Review everything before confirming.':suggested==='decline'?'Decline link opened. Review before confirming.':''}</p>`;

    $('approveBtn')?.addEventListener('click',()=>adminAction('approve',r));
    $('declineBtn')?.addEventListener('click',()=>adminAction('decline',r));
    $('completeBtn')?.addEventListener('click',()=>adminAction('complete',r));
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
    await openRequest(selectedId);
  }

  function esc(s){return String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
  sync();
})();
