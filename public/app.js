const defaults = {
  roleText: document.querySelector('#roleText').value,
  profile: {
    name: document.querySelector('#name').value,
    targetRoles: document.querySelector('#targetRoles').value,
    location: document.querySelector('#location').value,
    yearsExperience: document.querySelector('#yearsExperience').value,
    skills: document.querySelector('#skills').value,
    industries: document.querySelector('#industries').value,
    dealbreakers: document.querySelector('#dealbreakers').value,
    cvText: document.querySelector('#cvText').value
  }
};
let accountId = localStorage.getItem('jobpilot.accountId') || '';
let accessToken = localStorage.getItem('jobpilot.accessToken') || '';
let accountEmail = localStorage.getItem('jobpilot.accountEmail') || '';
let profileId = localStorage.getItem('jobpilot.profileId') || '';
let lastApplicationId = '';

const $ = (id) => document.querySelector(id);
function setStatus(id, text, good = true) { const el = $(id); el.textContent = text; el.className = `status ${good ? 'good' : 'bad'}`; }
function authHeaders() { return accessToken ? { Authorization: `Bearer ${accessToken}` } : {}; }
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...authHeaders(), ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const ct = res.headers.get('content-type') || '';
  const payload = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(typeof payload === 'string' ? payload : payload.error || 'request_failed');
  return payload;
}
function list(items) { return items && items.length ? items.map(x => `<li>${escapeHtml(typeof x === 'string' ? x : x.label || JSON.stringify(x))}</li>`).join('') : '<li>None detected</li>'; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function profilePayload() {
  return {
    name: $('#name').value, targetRoles: $('#targetRoles').value, location: $('#location').value, yearsExperience: Number($('#yearsExperience').value || 0),
    skills: $('#skills').value, industries: $('#industries').value, dealbreakers: $('#dealbreakers').value, cvText: $('#cvText').value
  };
}
function storeAccount(payload) {
  accountId = payload.accountId;
  accessToken = payload.accessToken;
  accountEmail = payload.account?.email || $('#accountEmail').value;
  localStorage.setItem('jobpilot.accountId', accountId);
  localStorage.setItem('jobpilot.accessToken', accessToken);
  localStorage.setItem('jobpilot.accountEmail', accountEmail);
  $('#waitlistEmail').value = accountEmail;
  setStatus('#accountStatus', `Account ready: ${accountEmail}. Token stored in this browser.`);
}
async function createAccount() {
  setStatus('#accountStatus', 'Creating account...');
  const res = await api('/api/accounts', { method: 'POST', body: { email: $('#accountEmail').value } });
  storeAccount(res);
}
async function ensureAccount() {
  if (!accessToken) await createAccount();
}
async function saveProfile() {
  await ensureAccount();
  setStatus('#profileStatus', 'Saving profile...');
  const res = await api('/api/profiles', { method: 'POST', body: profilePayload() });
  profileId = res.profileId;
  localStorage.setItem('jobpilot.profileId', profileId);
  setStatus('#profileStatus', `Profile saved. Completeness ${res.profileCompleteness}%. ID ${profileId.slice(0, 12)}…`);
  await loadTracker();
}
async function analyse() {
  if (!profileId || !accessToken) await saveProfile();
  $('#scoreBtn').disabled = true;
  $('#scoreBtn').textContent = 'Analyzing...';
  try {
    const res = await api('/api/analyze', { method: 'POST', body: {
      profileId, company: $('#company').value, roleTitle: $('#roleTitle').value, jobUrl: $('#jobUrl').value, jobText: $('#roleText').value
    }});
    lastApplicationId = res.applicationId;
    $('#score').textContent = res.fitScore;
    $('#bar').style.width = `${res.fitScore}%`;
    $('#recommendation').textContent = res.recommendation;
    $('#positioning').textContent = res.positioning;
    $('#matchedSkills').innerHTML = list(res.matchedSkills);
    $('#gaps').innerHTML = list(res.missingRequirements.length ? res.missingRequirements : res.risks);
    $('#outputs').innerHTML = list([...(res.cvPlan || []), res.coverLetterAngle, ...(res.interviewPrep || [])]);
    $('#exportLink').href = `/api/applications/${res.applicationId}/export.md?token=${encodeURIComponent(accessToken)}`;
    $('#exportLink').classList.remove('disabled');
    await loadTracker();
  } finally {
    $('#scoreBtn').disabled = false;
    $('#scoreBtn').textContent = 'Generate preview';
  }
}
async function loadTracker() {
  if (!profileId || !accessToken) return;
  const res = await api(`/api/applications?profileId=${encodeURIComponent(profileId)}`);
  $('#tracker').innerHTML = res.applications.length ? res.applications.map(a => `<div class="track-row"><div><strong>${escapeHtml(a.company)}</strong><span>${escapeHtml(a.roleTitle)} • ${a.recommendation}</span></div><b>${a.fitScore}/100</b><a href="/api/applications/${a.id}/export.md?token=${encodeURIComponent(accessToken)}">export</a></div>`).join('') : '<p>No applications yet. Run an analysis above.</p>';
}
async function joinWaitlist() {
  setStatus('#waitlistStatus', 'Joining waitlist...');
  const res = await api('/api/waitlist', { method: 'POST', body: { email: $('#waitlistEmail').value, userType: $('#userType').value, desiredPlan: 'beta_or_paid_pilot', monthlyApplications: 10, message: `Latest profile ${profileId || 'none'}` }});
  setStatus('#waitlistStatus', `Joined. Waitlist ID ${res.waitlistId.slice(0, 12)}…`);
}
async function exportAccountData() {
  await ensureAccount();
  const res = await api('/api/account/export');
  const blob = new Blob([JSON.stringify(res, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `jobpilot-account-${accountId}.json`; a.click();
  URL.revokeObjectURL(url);
  setStatus('#accountStatus', 'Account data export downloaded.');
}
async function deleteWorkspace() {
  if (!accessToken) return setStatus('#accountStatus', 'No workspace to delete.', false);
  if (!confirm('Delete this JobPilot beta workspace and all saved profiles/applications?')) return;
  const res = await api('/api/account', { method: 'DELETE' });
  accountId = ''; accessToken = ''; accountEmail = ''; profileId = ''; lastApplicationId = '';
  for (const key of ['jobpilot.accountId','jobpilot.accessToken','jobpilot.accountEmail','jobpilot.profileId']) localStorage.removeItem(key);
  setStatus('#accountStatus', `Workspace deleted. Removed ${res.deleted.profiles} profile(s) and ${res.deleted.applications} application(s).`);
  setStatus('#profileStatus', 'No profile saved yet.');
  $('#tracker').innerHTML = '<p>No applications yet. Run an analysis above.</p>';
}

$('#accountForm').addEventListener('submit', (e) => { e.preventDefault(); createAccount().catch(err => setStatus('#accountStatus', err.message, false)); });
$('#profileForm').addEventListener('submit', (e) => { e.preventDefault(); saveProfile().catch(err => setStatus('#profileStatus', err.message, false)); });
$('#analysisForm').addEventListener('submit', (e) => { e.preventDefault(); analyse().catch(err => alert(`Analysis failed: ${err.message}`)); });
$('#resetBtn').addEventListener('click', () => {
  $('#roleText').value = defaults.roleText;
  for (const [k,v] of Object.entries(defaults.profile)) document.querySelector(`#${k}`).value = v;
});
$('#waitlistForm').addEventListener('submit', (e) => { e.preventDefault(); joinWaitlist().catch(err => setStatus('#waitlistStatus', err.message, false)); });
$('#exportAccountBtn').addEventListener('click', () => exportAccountData().catch(err => setStatus('#accountStatus', err.message, false)));
$('#deleteAccountBtn').addEventListener('click', () => deleteWorkspace().catch(err => setStatus('#accountStatus', err.message, false)));
if (accountEmail) { $('#accountEmail').value = accountEmail; $('#waitlistEmail').value = accountEmail; }
if (accessToken) {
  setStatus('#accountStatus', `Existing account loaded: ${accountEmail || accountId}.`);
  if (profileId) { setStatus('#profileStatus', `Existing profile loaded. ID ${profileId.slice(0, 12)}…`); loadTracker().catch(() => {}); }
} else if (profileId) {
  profileId = '';
  localStorage.removeItem('jobpilot.profileId');
}
