(() => {
  const CONFIG = window.SAS_CONFIG || {};
  const PRICE = {
    act: 10,
    marriage: 25,
    baseMobile: 25,
    perMileAfter5: 0.25,
    perMileAfter50: 2,
    minWithin10: 25,
    minBeyond10: 30,
    urgency12to24: 5,
    urgency6to12: 10,
    urgencyUnder6: 25,
    sameDayAfter8: 40,
    weekendBase: 5,
    weekendEarly: 15,
    weekendLate: 20,
    standardHoliday: 20,
    majorHoliday: 40,
    printingBase: 5,
    printingIncludedPages: 10,
    printingExtraPage: 0.25,
    firstClassStampedLetter: 0.82,
    envelopeMarkup: 0.25,
    mailboxDrop: 5,
    counterDrop: 10,
    certifiedMailFee: 5.55,
    certifiedHandling: 1
  };
  const BASE = { lat: 27.7767, lng: -82.1616, zip: '33547' };

  const $ = (id) => document.getElementById(id);
  const money = (n) => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(n || 0));
  const form = $('quoteForm');
  let step = 1;
  let liveMiles = null;
  let liveTravelSeconds = null;
  let lastRoutedAddress = '';
  let routeError = '';
  let availabilityRun = 0;

  document.querySelector('.menu-btn')?.addEventListener('click', (e) => {
    const nav = $('site-nav');
    const open = nav.classList.toggle('open');
    e.currentTarget.setAttribute('aria-expanded', String(open));
  });
  document.querySelectorAll('#site-nav a').forEach(a => a.addEventListener('click', () => $('site-nav').classList.remove('open')));
  $('year').textContent = new Date().getFullYear();

  function majorHoliday(date, hour=12) {
    const m=date.getMonth()+1,d=date.getDate();
    if ((m===12&&d===25)||(m===1&&d===1)||(m===7&&d===4)||(m===11&&nthWeekday(date,4,4))) return true;
    if ((m===12&&d===24)||(m===12&&d===31)) return hour>=18;
    // Easter Sunday supplied by a compact year table for nearby years; update annually if desired.
    const easter = {2026:'2026-04-05',2027:'2027-03-28',2028:'2028-04-16',2029:'2029-04-01',2030:'2030-04-21'};
    return easter[date.getFullYear()] === isoDate(date);
  }
  function standardFederalHoliday(date) {
    const m=date.getMonth()+1,d=date.getDate(),day=date.getDay();
    if ((m===1&&d===1)||(m===6&&d===19)||(m===7&&d===4)||(m===11&&d===11)||(m===12&&d===25)) return true;
    // MLK: 3rd Mon Jan; Presidents: 3rd Mon Feb; Memorial: last Mon May; Labor: 1st Mon Sep; Columbus: 2nd Mon Oct; Thanksgiving: 4th Thu Nov
    if (m===1&&day===1&&Math.ceil(d/7)===3) return true;
    if (m===2&&day===1&&Math.ceil(d/7)===3) return true;
    if (m===5&&day===1&&d+7>daysInMonth(date)) return true;
    if (m===9&&day===1&&d<=7) return true;
    if (m===10&&day===1&&d>=8&&d<=14) return true;
    if (m===11&&day===4&&Math.ceil(d/7)===4) return true;
    return false;
  }
  function nthWeekday(date,nth,weekday){return date.getDay()===weekday && Math.ceil(date.getDate()/7)===nth}
  function daysInMonth(date){return new Date(date.getFullYear(),date.getMonth()+1,0).getDate()}
  function isoDate(date){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`}
  function parseLocalDate(str){if(!str)return null;const [y,m,d]=str.split('-').map(Number);return new Date(y,m-1,d)}
  function appointmentDateTime(){
    const d=$('appointmentDate').value,t=$('appointmentTime').value;
    if(!d||!t)return null; const [y,m,day]=d.split('-').map(Number),[hh,mm]=t.split(':').map(Number); return new Date(y,m-1,day,hh,mm,0,0);
  }
  function isWeekend(date){return date && (date.getDay()===0||date.getDay()===6)}

  async function populateTimes(){
    const date=parseLocalDate($('appointmentDate').value), select=$('appointmentTime');
    select.innerHTML='';
    if(!date){select.innerHTML='<option value="">Choose a date first</option>';return}
    if(!Number.isFinite(liveTravelSeconds)){
      select.innerHTML='<option value="">Verify the service address first</option>';
      return;
    }
    const allDayMajor=majorHoliday(date,12) && !((date.getMonth()+1===12)&&(date.getDate()===24||date.getDate()===31));
    const weekend=isWeekend(date), start=(allDayMajor||weekend)?6:18, end=24;
    const candidates=[];
    for(let h=start;h<end;h++){
      for(const min of [0,30]){
        const value=`${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
        const hr12=h%12||12,ampm=h>=12?'PM':'AM';
        candidates.push({value,label:`${hr12}:${String(min).padStart(2,'0')} ${ampm}`});
      }
    }
    const run=++availabilityRun;
    select.innerHTML='<option value="">Checking available times…</option>';select.disabled=true;
    $('availabilityMessage').textContent='Checking appointments, travel time, and blocked availability…';
    const checks=[];
    for(let offset=0;offset<candidates.length;offset+=10){
      const chunk=await Promise.all(candidates.slice(offset,offset+10).map(async slot=>{
        const [y,m,d]=$('appointmentDate').value.split('-').map(Number),[hh,mm]=slot.value.split(':').map(Number);
        const appointmentAt=new Date(y,m-1,d,hh,mm,0,0).toISOString();
        try{const response=await fetch(`${CONFIG.API_BASE_URL}/check-availability`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({appointmentAt,durationMinutes:calcDuration(),travelSeconds:liveTravelSeconds})});const result=await response.json();return response.ok&&result.available?slot:null}catch{return null}
      }));
      checks.push(...chunk);
      if(run!==availabilityRun)return;
    }
    if(run!==availabilityRun)return;
    const available=checks.filter(Boolean),frag=document.createDocumentFragment();
    const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent=available.length?'Choose an available time':'No standard times are available';frag.appendChild(placeholder);
    available.forEach(slot=>{const option=document.createElement('option');option.value=slot.value;option.textContent=slot.label;frag.appendChild(option)});
    select.replaceChildren(frag);select.disabled=false;
    $('availabilityMessage').textContent=available.length?`${available.length} available time${available.length===1?'':'s'} for this address and date.`:'No standard appointment times remain. Choose another date or request an emergency opening for manual review.';
  }

  function calcDuration(){
    const signers=Number($('signers').value||1), actsVal=$('acts').value, acts=actsVal==='unknown'?1:Number(actsVal||1);
    let mins=30;
    if(signers>=5||acts>=7) mins=60; else if(signers>=3||acts>=4) mins=45;
    $('durationDisplay').value=`${mins} minutes${(signers>=5||acts>=7)?' • manual review':''}`;
    return mins;
  }

  function mobileFee(miles){
    miles=Math.max(0,Number(miles||0));
    let fee=PRICE.baseMobile;
    if(miles>5) fee += Math.max(0,Math.min(miles,50)-5)*PRICE.perMileAfter5;
    if(miles>50) fee += (miles-50)*PRICE.perMileAfter50;
    fee=Math.max(fee,miles<=10?PRICE.minWithin10:PRICE.minBeyond10);
    return fee;
  }

  function hoursUntilAppointment(dt){return dt ? (dt.getTime()-Date.now())/36e5 : null}
  function isSameLocalDay(a,b){return a&&b&&a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate()}

  function calculateQuote(){
    const lines=[];
    const docType=$('documentType').value, actType=$('notarialAct').value;
    const actsVal=$('acts').value, unknownActs=actsVal==='unknown', acts=unknownActs?1:Number(actsVal||1);
    let notaryFee=0;
    if(docType==='Simple Marriage Solemnization'||actType==='Simple Marriage Solemnization') {notaryFee=PRICE.marriage;lines.push(['Simple marriage solemnization',notaryFee]);}
    else {notaryFee=acts*PRICE.act;lines.push([`${acts} notarial act${acts===1?'':'s'} × $10`,notaryFee]);}

    const miles=liveMiles ?? Number($('manualMiles').value||0);
    const travel=mobileFee(miles);
    lines.push([`Mobile/travel${miles?` (${miles.toFixed(1)} one-way mi)`:''}`,travel]);

    const dt=appointmentDateTime(), date=dt||parseLocalDate($('appointmentDate').value);
    let urgency=0;
    if(dt){
      const hrs=hoursUntilAppointment(dt), same=isSameLocalDay(dt,new Date()), after8=dt.getHours()>=20;
      if(same&&after8) urgency=PRICE.sameDayAfter8;
      else if(hrs!==null&&hrs>=0&&hrs<=6) urgency=PRICE.urgencyUnder6;
      else if(hrs>6&&hrs<=12) urgency=PRICE.urgency6to12;
      else if(hrs>12&&hrs<=24) urgency=PRICE.urgency12to24;
      if(urgency) lines.push([same&&after8?'Same-day after-8 PM premium':'Short-notice premium',urgency]);
    }

    let weekend=0,holiday=0;
    if(date){
      const hh=dt?dt.getHours():12;
      if(isWeekend(date)){weekend+=PRICE.weekendBase;if(hh<8)weekend+=PRICE.weekendEarly;if(hh>=20)weekend+=PRICE.weekendLate;}
      if(majorHoliday(date,hh)) holiday=PRICE.majorHoliday;
      else if(standardFederalHoliday(date)) holiday=PRICE.standardHoliday;
      if(weekend)lines.push(['Weekend / early-late premium',weekend]);
      if(holiday)lines.push([majorHoliday(date,hh)?'Major holiday premium':'Holiday premium',holiday]);
    }

    let extras=0;
    if($('printing').checked){const pages=Math.max(1,Number($('pages').value||1));let x=PRICE.printingBase+Math.max(0,pages-PRICE.printingIncludedPages)*PRICE.printingExtraPage;extras+=x;lines.push([`Printing (${pages} page${pages===1?'':'s'})`,x]);}
    if($('envelope').checked){const x=PRICE.firstClassStampedLetter+PRICE.envelopeMarkup;extras+=x;lines.push(['Standard envelope + stamp',x]);}
    if($('mailing').value==='mailbox'){extras+=PRICE.mailboxDrop;lines.push(['Mailbox drop-off',PRICE.mailboxDrop]);}
    if($('mailing').value==='counter'){extras+=PRICE.counterDrop;lines.push(['Staffed post-office drop-off',PRICE.counterDrop]);}
    if($('certified').checked){const x=PRICE.certifiedMailFee+PRICE.certifiedHandling;extras+=x;lines.push(['Certified Mail + handling',x]);}

    const accommodations=[...document.querySelectorAll('input[name="accommodation"]:checked')].map(x=>x.value);
    const manualReview=unknownActs||accommodations.includes('secure')||Number($('signers').value)>=5||Number(actsVal)>=7||$('noDocumentYet').checked;
    const total=lines.reduce((s,[,v])=>s+v,0);
    return { total,lines,miles,travel,urgency,weekend,holiday,manualReview,unknownActs,duration:calcDuration(),travelSeconds:liveTravelSeconds };
  }

  function renderQuote(){
    const q=calculateQuote();
    $('quoteTotal').textContent=money(q.total);$('stickyTotal').textContent=money(q.total);
    $('breakdownRows').innerHTML=q.lines.map(([label,val])=>`<div class="breakdown-row"><span>${escapeHtml(label)}</span><strong>${money(val)}</strong></div>`).join('');
    $('quoteStatus').textContent=q.manualReview?'Estimated • manual review required':'Estimated • pending document review';
    const doc=$('documentType').value||'document';
    const travelSummary=routeError?'address not serviceable':Number.isFinite(q.miles)?`${q.miles.toFixed(1)} mi`:'travel pending';
    $('stickySummary').textContent=`${doc} • ${travelSummary}`;
  }

  function escapeHtml(str){return String(str).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}

  async function routeAddress(){
    liveMiles=null;liveTravelSeconds=null;
    lastRoutedAddress='';routeError='';
    const address=$('address').value.trim();
    $('routeMessage').textContent=address?'Checking address and driving distance…':'';
    if(!CONFIG.ENABLE_SECURE_ROUTING||!CONFIG.API_BASE_URL||!address){renderQuote();return !address?false:true}
    try{
      const response=await fetch(`${CONFIG.API_BASE_URL}/route-service-address`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({address})});
      const result=await response.json();if(!response.ok)throw new Error(result.error||'Route unavailable');
      liveMiles=Number(result.miles);liveTravelSeconds=Number(result.travelSeconds);
      if(!Number.isFinite(liveMiles)||!Number.isFinite(liveTravelSeconds))throw new Error('Driving distance could not be verified.');
      lastRoutedAddress=address;
      $('manualMilesWrap').classList.add('hidden');
      $('routeMessage').textContent=`Verified: ${liveMiles.toFixed(1)} one-way driving miles.`;
      $('appointmentDate').disabled=false;
      if($('appointmentDate').value)await populateTimes();
      renderQuote();
      return true;
    }catch(e){
      console.warn(e);routeError=e instanceof Error?e.message:'Travel routing failed.';
      $('manualMilesWrap').classList.add('hidden');renderQuote();
      $('routeMessage').textContent=routeError;$('quoteStatus').textContent=routeError;
      return false;
    }
  }

  function updateStep(){
    document.querySelectorAll('.form-step').forEach(s=>s.classList.toggle('active',Number(s.dataset.step)===step));
    const active=document.querySelector(`.form-step[data-step="${step}"]`);
    $('stepLabel').textContent=`Step ${step} of 6`;$('stepTitle').textContent=active.dataset.title;$('progressBar').style.width=`${step/6*100}%`;
    $('backBtn').disabled=step===1;$('nextBtn').classList.toggle('hidden',step===6);$('submitBtn').classList.toggle('hidden',step!==6);
    if(step===6)renderQuote();
    active.querySelector('input,select,textarea')?.focus({preventScroll:true});
  }
  function validateCurrentStep(){
    const active=document.querySelector(`.form-step[data-step="${step}"]`);
    const required=[...active.querySelectorAll('[required]')];
    if(step===4){
      const files=$('documents').files.length;
      if(!files&&!$('noDocumentYet').checked){alert('Please upload the document, clear page photos, or choose “I don’t have the document yet.”');return false;}
      if(files>10){alert('Please upload no more than 10 files.');return false;}
    }
    for(const el of required){if(!el.checkValidity()){el.reportValidity();return false}}
    return true;
  }

  $('nextBtn').addEventListener('click',async()=>{
    if(!validateCurrentStep())return;
    if(step===1){
      const address=$('address').value.trim();
      if(address!==lastRoutedAddress||!Number.isFinite(liveMiles)||!Number.isFinite(liveTravelSeconds)){
        $('nextBtn').disabled=true;
        const validRoute=await routeAddress();
        $('nextBtn').disabled=false;
        if(!validRoute)return;
      }
    }
    if(step<6){step++;updateStep();window.scrollTo({top:document.querySelector('.wizard-shell').offsetTop-90,behavior:'smooth'})}
  });
  $('backBtn').addEventListener('click',()=>{if(step>1){step--;updateStep();}});
  $('appointmentDate').min=isoDate(new Date());$('appointmentDate').disabled=true;
  $('appointmentDate').addEventListener('change',async()=>{await populateTimes();renderQuote()});
  $('appointmentTime').addEventListener('change',renderQuote);
  $('address').addEventListener('blur',routeAddress);
  $('address').addEventListener('input',()=>{liveMiles=null;liveTravelSeconds=null;lastRoutedAddress='';routeError='';$('routeMessage').textContent='';$('appointmentDate').disabled=true;$('appointmentTime').innerHTML='<option value="">Verify the service address first</option>';renderQuote()});
  $('manualMiles').addEventListener('input',renderQuote);
  $('signers').addEventListener('change',renderQuote);$('acts').addEventListener('change',renderQuote);
  $('documentType').addEventListener('change',()=>{$('loanWarning').classList.toggle('hidden',$('documentType').value!=='Mortgage / Closing-Related Document');renderQuote()});
  $('notarialAct').addEventListener('change',renderQuote);
  $('printing').addEventListener('change',()=>{$('pagesWrap').classList.toggle('hidden',!$('printing').checked);renderQuote()});
  $('pages').addEventListener('input',renderQuote);$('envelope').addEventListener('change',renderQuote);$('mailing').addEventListener('change',renderQuote);$('certified').addEventListener('change',renderQuote);
  document.querySelectorAll('input[name="accommodation"]').forEach(x=>x.addEventListener('change',()=>{$('secureFacilityWarning').classList.toggle('hidden',!document.querySelector('input[name="accommodation"][value="secure"]').checked);renderQuote()}));
  $('noDocumentYet').addEventListener('change',renderQuote);
  $('documents').addEventListener('change',()=>{
    const files=[...$('documents').files];
    $('fileList').innerHTML=files.slice(0,10).map(f=>`<div class="file-chip"><span>${escapeHtml(f.name)}</span><span>${(f.size/1024/1024).toFixed(1)} MB</span></div>`).join('');
    if(files.length>10)alert('Only the first 10 files can be accepted. Please reduce the upload.');
  });

  async function submitRequest(e){
    e.preventDefault(); if(!validateCurrentStep()||!$('consent').checked){$('consent').reportValidity();return}
    const q=calculateQuote();
    if(CONFIG.ENABLE_SECURE_ROUTING&&(!Number.isFinite(liveMiles)||!Number.isFinite(liveTravelSeconds))){$('submitMessage').classList.remove('hidden');$('submitMessage').textContent='Please wait for the service address and travel time to be verified before submitting.';await routeAddress();return}
    if(q.miles>75){alert('Online requests are limited to 75 driving miles from the service base.');return}
    const payload={
      customer:{name:$('customerName').value,email:$('email').value,phone:$('phone').value,preferredContact:$('preferredContact').value,referral:$('referral').value},
      appointment:{date:$('appointmentDate').value,time:$('appointmentTime').value,address:$('address').value,unit:$('unit').value,zip:$('zip').value,locationNotes:$('locationNotes').value,backupTime:$('backupTime').value,emergencyOpening:$('emergencyOpening').checked,durationMinutes:q.duration,oneWayMiles:q.miles,oneWayTravelSeconds:q.travelSeconds},
      document:{type:$('documentType').value,notarialAct:$('notarialAct').value,signers:$('signers').value,acts:$('acts').value,needsWitnesses:$('needsWitnesses').checked,notes:$('documentNotes').value,noDocumentYet:$('noDocumentYet').checked},
      extras:{printing:$('printing').checked,pages:$('pages').value,envelope:$('envelope').checked,mailing:$('mailing').value,certified:$('certified').checked,accommodations:[...document.querySelectorAll('input[name="accommodation"]:checked')].map(x=>x.value)},
      customerComments:$('customerComments').value,
      quote:q
    };
    const message=$('submitMessage'); message.classList.remove('hidden');
    if(!CONFIG.ENABLE_LIVE_SUBMISSION||!CONFIG.API_BASE_URL){
      message.innerHTML='<strong>Demo mode:</strong> Your form is working and the quote was calculated, but live submission is intentionally disabled until Supabase, Gmail, Square, and calendar credentials are connected. The repository includes the backend setup files.';
      return;
    }
    try{
      $('submitBtn').disabled=true;$('submitBtn').textContent='Submitting…';
      const fd=new FormData();fd.append('payload',JSON.stringify(payload));[...$('documents').files].slice(0,10).forEach(f=>fd.append('documents',f));
      const res=await fetch(`${CONFIG.API_BASE_URL}/create-request`,{method:'POST',body:fd});if(!res.ok)throw new Error(await res.text());
      const data=await res.json();message.innerHTML=`<strong>Request received.</strong> Your appointment is Pending. Request ID: ${escapeHtml(data.requestId||'created')}. Watch for email/text updates.`;
      form.reset();populateTimes();renderQuote();
    }catch(err){message.innerHTML=`<strong>Couldn’t submit:</strong> ${escapeHtml(err.message)}. Please try again.`}
    finally{$('submitBtn').disabled=false;$('submitBtn').textContent='Submit Pending Request'}
  }
  form.addEventListener('submit',submitRequest);

  function initMap(){
    if(!window.L)return;
    const map=L.map('serviceMap',{scrollWheelZoom:false}).setView([BASE.lat,BASE.lng],8);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(map);
    L.circle([BASE.lat,BASE.lng],{radius:75*1609.344,color:'#d4ad58',weight:2,fillColor:'#d4ad58',fillOpacity:.08}).addTo(map);
    L.circle([BASE.lat,BASE.lng],{radius:50*1609.344,color:'#4b214f',weight:2,fillColor:'#4b214f',fillOpacity:.10}).addTo(map);
    L.circleMarker([BASE.lat,BASE.lng],{radius:7,color:'#fff',weight:3,fillColor:'#4b214f',fillOpacity:1}).bindTooltip('Based near 33547').addTo(map);
    map.fitBounds(L.circle([BASE.lat,BASE.lng],{radius:75*1609.344}).getBounds(),{padding:[18,18]});
  }

  populateTimes();renderQuote();updateStep();initMap();
})();
