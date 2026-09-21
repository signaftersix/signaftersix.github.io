(() => {
  const cfg = window.SAS_CONFIG || {};
  const params = new URLSearchParams(location.search);
  const requestId = params.get('request') || '';
  const token = params.get('token') || '';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>'"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

  async function call(action, extra = {}) {
    const response = await fetch(`${cfg.API_BASE_URL}/manage-request`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ requestId, token, action, ...extra })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Unable to manage this request.');
    return data;
  }
  async function load() {
    if (!cfg.API_BASE_URL || !requestId || !token) throw new Error('This management link is incomplete.');
    const data = await call('preview');
    const r = data.request;
    $('manageMessage').textContent = '';
    $('managePanel').classList.remove('hidden');
    $('requestSummary').innerHTML = `<span class="status-pill">${esc(r.status.replaceAll('_',' '))}</span><h2>${esc(r.customerName)}</h2><p><strong>Current appointment:</strong><br>${esc(new Date(r.appointmentAt).toLocaleString())}</p><p><strong>Estimated total:</strong> ${Number(r.quoteTotal).toLocaleString('en-US',{style:'currency',currency:'USD'})}</p>${r.requestedAppointmentAt?`<p><strong>Requested new time:</strong><br>${esc(new Date(r.requestedAppointmentAt).toLocaleString())}</p>`:''}`;
  }
  $('rescheduleBtn').addEventListener('click', async () => {
    const date = $('newDate').value, time = $('newTime').value;
    if (!date || !time) { $('actionResult').textContent = 'Choose a requested date and time.'; return; }
    if (!confirm('Send this reschedule request? Your current appointment remains in place until approval.')) return;
    await perform('request_reschedule', { date, time, reason: $('rescheduleReason').value });
  });
  $('cancelBtn').addEventListener('click', async () => {
    if (!confirm('Send a cancellation request? The appointment remains scheduled until cancellation is confirmed.')) return;
    await perform('request_cancel', { reason: $('cancelReason').value });
  });
  async function perform(action, body) {
    $('actionResult').textContent = 'Sending...';
    try { const result = await call(action, body); $('actionResult').textContent = result.message; await load(); }
    catch (error) { $('actionResult').textContent = error.message; }
  }
  load().catch((error) => { $('manageMessage').textContent = error.message; });
})();
