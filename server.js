const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3117);
const PUBLIC = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'store.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MAX_BODY = 64 * 1024;
const TYPES = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.zip':'application/zip','.md':'text/markdown; charset=utf-8'};
const buckets = new Map();

function emptyStore() { return { accounts: [], profiles: [], applications: [], waitlist: [], events: [] }; }
function normalizeStore(store) {
  const base = emptyStore();
  const out = { ...base, ...(store && typeof store === 'object' ? store : {}) };
  for (const k of Object.keys(base)) if (!Array.isArray(out[k])) out[k] = [];
  return out;
}
function ensureStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(DATA_DIR, 0o700); } catch {}
  if (!fs.existsSync(DB_FILE)) writeStore(emptyStore(), false);
}
function readStore() {
  ensureStore();
  const store = normalizeStore(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  return store;
}
function writeStore(store, backup = true) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  if (backup && fs.existsSync(DB_FILE)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(BACKUP_DIR, 0o700); } catch {}
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(DB_FILE, path.join(BACKUP_DIR, `store-${stamp}.json`));
    const backups = fs.readdirSync(BACKUP_DIR).filter(f => /^store-.*\.json$/.test(f)).sort();
    for (const old of backups.slice(0, Math.max(0, backups.length - 20))) fs.unlinkSync(path.join(BACKUP_DIR, old));
  }
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(normalizeStore(store), null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DB_FILE);
  try { fs.chmodSync(DB_FILE, 0o600); } catch {}
}
function id(prefix) { return `${prefix}_${crypto.randomBytes(9).toString('hex')}`; }
function token() { return crypto.randomBytes(24).toString('base64url'); }
function tokenHash(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }
function now() { return new Date().toISOString(); }
function text(v, max = 4000) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }
function list(v, max = 20) {
  if (Array.isArray(v)) return v.map(x => text(String(x), 80)).filter(Boolean).slice(0, max);
  return text(v, 1200).split(/[,\n]/).map(x => x.trim()).filter(Boolean).slice(0, max);
}
function send(res, code, body, type='text/plain; charset=utf-8', extra={}) {
  const cache = type.includes('json') || type.includes('markdown') || type.startsWith('text/plain') ? 'no-store' : 'public, max-age=60';
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    ...extra
  });
  res.end(body);
}
function json(res, code, obj) { send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8'); }
function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim(); }
function rateLimit(req, res, limit = 80) {
  const key = clientIp(req) + ':' + (req.url || '').split('?')[0];
  const t = Date.now();
  const b = buckets.get(key) || { t, n: 0 };
  if (t - b.t > 60_000) { b.t = t; b.n = 0; }
  b.n += 1; buckets.set(key, b);
  if (b.n > limit) { json(res, 429, { error: 'rate_limited' }); return true; }
  return false;
}
function readJson(req, res) {
  return new Promise((resolve) => {
    if (!['POST','PATCH','DELETE'].includes(req.method)) return resolve(null);
    if (['POST','PATCH'].includes(req.method) && !String(req.headers['content-type'] || '').includes('application/json')) { json(res, 415, { error: 'json_required' }); return resolve(undefined); }
    let size = 0, raw = '', oversized = false;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      if (oversized) return;
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY) { oversized = true; json(res, 413, { error: 'payload_too_large' }); return; }
      raw += chunk;
    });
    req.on('end', () => {
      if (oversized) return resolve(undefined);
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { json(res, 400, { error: 'invalid_json' }); resolve(undefined); }
    });
    req.on('error', () => resolve(undefined));
  });
}
function authAccount(req, url, store) {
  const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
  const queryToken = text(url.searchParams.get('token') || '', 200);
  const raw = bearer || queryToken;
  if (!raw) return null;
  const hash = tokenHash(raw);
  return store.accounts.find(a => a.tokenHash === hash) || null;
}
function requireAccount(req, res, url, store) {
  const account = authAccount(req, url, store);
  if (!account) { json(res, 401, { error: 'auth_required' }); return null; }
  return account;
}
function ownsProfile(profile, account) { return profile && profile.accountId === account.id; }
function ownsApp(app, account) { return app && app.accountId === account.id; }
function publicAccount(a) { return { id: a.id, email: a.email, createdAt: a.createdAt, lastSeenAt: a.lastSeenAt }; }
function tokenize(s) { return new Set(text(s, 20000).toLowerCase().match(/[a-z][a-z0-9+#.-]{1,}/g) || []); }
function profileCompleteness(p) {
  const fields = ['name','targetRoles','location','skills','industries','goals','dealbreakers','cvText'];
  return Math.round(fields.reduce((n,k) => n + (Array.isArray(p[k]) ? p[k].length > 0 : Boolean(p[k])), 0) / fields.length * 100);
}
function recommendation(score) { return score >= 82 ? 'Strong apply' : score >= 68 ? 'Apply with positioning' : score >= 52 ? 'Maybe - fix gaps first' : 'Skip or deprioritize'; }
function analyse(profile, body) {
  const jobText = text(body.jobText, 20000);
  const roleTitle = text(body.roleTitle, 160) || 'Target role';
  const company = text(body.company, 160) || 'Target company';
  const skillList = profile.skills || [];
  const industryList = profile.industries || [];
  const jobTokens = tokenize(`${roleTitle} ${jobText}`);
  const cvTokens = tokenize(`${profile.cvText || ''} ${(profile.skills || []).join(' ')} ${(profile.goals || '')}`);
  const matchedSkills = skillList.filter(s => tokenize(s).size && [...tokenize(s)].some(t => jobTokens.has(t)));
  const roleHits = (profile.targetRoles || []).filter(r => [...tokenize(r)].some(t => jobTokens.has(t))).length;
  const industryHits = industryList.filter(i => [...tokenize(i)].some(t => jobTokens.has(t))).length;
  const dealbreakers = (profile.dealbreakers || []).filter(d => [...tokenize(d)].some(t => jobTokens.has(t)));
  const commonReqs = ['ai','saas','analytics','customer','stakeholder','leadership','python','data','sales','marketing','enterprise','automation','product','design','growth','remote','management','scrum','sql','api'];
  const missingRequirements = commonReqs.filter(k => jobTokens.has(k) && !cvTokens.has(k) && !skillList.join(' ').toLowerCase().includes(k)).slice(0, 8);
  const seniority = /senior|lead|principal|head|director/i.test(jobText + roleTitle) ? 1 : 0;
  const years = Number(profile.yearsExperience || 0);
  const seniorityScore = seniority ? Math.min(15, years * 2) : 12;
  const skillScore = Math.min(35, matchedSkills.length * 7 + Math.min(10, skillList.length));
  const roleScore = Math.min(20, roleHits * 10 + (jobTokens.has('manager') && /manager/i.test((profile.targetRoles||[]).join(' ')) ? 5 : 0));
  const industryScore = Math.min(10, industryHits * 5);
  const locationScore = dealbreakers.length ? 0 : 10;
  const completenessScore = Math.min(10, Math.floor(jobText.length / 200) + Math.floor(profileCompleteness(profile) / 20));
  const fitScore = Math.max(22, Math.min(96, skillScore + roleScore + seniorityScore + industryScore + locationScore + completenessScore));
  const top = matchedSkills.slice(0, 4).join(', ') || (profile.targetRoles || ['the target role'])[0];
  const risks = [];
  if (dealbreakers.length) risks.push({ label: `Possible deal-breaker found: ${dealbreakers.join(', ')}`, severity: 'high' });
  if (missingRequirements.length) risks.push({ label: `Missing explicit proof: ${missingRequirements.slice(0, 4).join(', ')}`, severity: missingRequirements.length > 4 ? 'high' : 'medium' });
  if (fitScore < 68) risks.push({ label: 'Score is below the normal apply threshold; tailor before spending time applying.', severity: 'medium' });
  return {
    company, roleTitle, jobUrl: text(body.jobUrl, 500), jobText,
    fitScore, recommendation: recommendation(fitScore), matchedSkills, missingRequirements, risks,
    positioning: `Lead with ${top}. Frame your experience around the employer's highest-signal needs, then proactively address ${missingRequirements[0] || 'the biggest gap'} without sounding defensive.`,
    cvPlan: [
      `Open the CV with a headline tied to ${roleTitle}.`,
      matchedSkills.length ? `Move proof for ${matchedSkills.slice(0,3).join(', ')} into the first third of the CV.` : 'Add concrete proof bullets for the role’s top requirements.',
      missingRequirements.length ? `Add or reframe evidence for: ${missingRequirements.slice(0,3).join(', ')}.` : 'Keep the CV tight; avoid adding low-relevance bullets.',
      'Quantify outcomes where possible: revenue, time saved, users, shipped features, cycle time, or adoption.'
    ],
    coverLetterAngle: `Position yourself as someone who can turn ${roleTitle.toLowerCase()} requirements into shipped outcomes for ${company}, with a short paragraph on fit and one paragraph addressing the main risk/gap.`,
    interviewPrep: [
      `Prepare a STAR story proving ${matchedSkills[0] || 'the strongest matched skill'}.`,
      missingRequirements[0] ? `Prepare a clean answer for the ${missingRequirements[0]} gap.` : 'Prepare a concise why-this-company answer.',
      'Ask how success is measured in the first 90 days.',
      'Ask what failed in previous attempts to fill or execute this role.'
    ],
    followUpEmail: `Hi ${company} team,\n\nI applied for the ${roleTitle} role and wanted to highlight the fit: ${top}. I am especially interested in helping the team turn the role requirements into measurable outcomes.\n\nBest,\n${profile.name || 'Candidate'}`
  };
}
function markdown(app) {
  return `# JobPilot AI Application Pack\n\n## Role\nCompany: ${app.company}\nTitle: ${app.roleTitle}\nURL: ${app.jobUrl || 'n/a'}\n\n## Fit Score\n${app.fitScore}/100 — ${app.recommendation}\n\n## Matched Skills\n${(app.matchedSkills || []).map(x => `- ${x}`).join('\n') || '- none detected'}\n\n## Missing Requirements / Risks\n${(app.missingRequirements || []).map(x => `- ${x}`).join('\n') || '- no major gaps detected'}\n\n## Recommended Positioning\n${app.positioning}\n\n## CV Tailoring Plan\n${(app.cvPlan || []).map(x => `- ${x}`).join('\n')}\n\n## Cover Letter Angle\n${app.coverLetterAngle}\n\n## Interview Prep\n${(app.interviewPrep || []).map(x => `- ${x}`).join('\n')}\n\n## Follow-up Email\n\n${app.followUpEmail}\n`;
}
function safeFile(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath.split('?')[0]); } catch { return null; }
  if (decoded === '/' || decoded === '') decoded = '/index.html';
  const file = path.normalize(path.join(PUBLIC, decoded));
  return file.startsWith(PUBLIC) ? file : null;
}
async function api(req, res, url) {
  if (rateLimit(req, res, url.pathname === '/api/analyze' ? 12 : 80)) return;
  const store = readStore();

  if (req.method === 'POST' && url.pathname === '/api/accounts') {
    const body = await readJson(req, res); if (body === undefined) return;
    const email = text(body.email, 200).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: 'valid_email_required' });
    const accessToken = token();
    const account = { id: id('acct'), email, tokenHash: tokenHash(accessToken), createdAt: now(), lastSeenAt: now() };
    store.accounts.push(account);
    store.events.push({ id: id('evt'), accountId: account.id, eventName: 'account_created', createdAt: now() });
    writeStore(store);
    return json(res, 201, { accountId: account.id, accessToken, account: publicAccount(account) });
  }

  if (req.method === 'GET' && url.pathname === '/api/account') {
    const account = requireAccount(req, res, url, store); if (!account) return;
    account.lastSeenAt = now(); writeStore(store);
    return json(res, 200, { account: publicAccount(account) });
  }

  if (req.method === 'GET' && url.pathname === '/api/account/export') {
    const account = requireAccount(req, res, url, store); if (!account) return;
    const profiles = store.profiles.filter(p => p.accountId === account.id);
    const applications = store.applications.filter(a => a.accountId === account.id);
    const waitlist = store.waitlist.filter(w => w.accountId === account.id || w.email === account.email);
    return json(res, 200, { accountId: account.id, account: publicAccount(account), profiles, applications, waitlist, exportedAt: now() });
  }

  if (req.method === 'DELETE' && url.pathname === '/api/account') {
    const account = requireAccount(req, res, url, store); if (!account) return;
    const before = { profiles: store.profiles.length, applications: store.applications.length, waitlist: store.waitlist.length, accounts: store.accounts.length };
    store.profiles = store.profiles.filter(p => p.accountId !== account.id);
    store.applications = store.applications.filter(a => a.accountId !== account.id);
    store.waitlist = store.waitlist.filter(w => w.accountId !== account.id && w.email !== account.email);
    store.accounts = store.accounts.filter(a => a.id !== account.id);
    store.events.push({ id: id('evt'), accountId: account.id, eventName: 'account_deleted', createdAt: now() });
    writeStore(store);
    return json(res, 200, { ok: true, deleted: { profiles: before.profiles - store.profiles.length, applications: before.applications - store.applications.length, waitlist: before.waitlist - store.waitlist.length, accounts: before.accounts - store.accounts.length } });
  }

  if (req.method === 'POST' && url.pathname === '/api/profiles') {
    const account = requireAccount(req, res, url, store); if (!account) return;
    const body = await readJson(req, res); if (body === undefined) return;
    const profile = {
      id: id('prof'), accountId: account.id, name: text(body.name, 160), targetRoles: list(body.targetRoles), location: text(body.location, 160), yearsExperience: Number(body.yearsExperience || 0),
      skills: list(body.skills, 40), industries: list(body.industries, 20), education: text(body.education, 1000), goals: text(body.goals, 1200), dealbreakers: list(body.dealbreakers, 20), cvText: text(body.cvText, 16000), createdAt: now(), updatedAt: now()
    };
    store.profiles.push(profile); store.events.push({ id: id('evt'), accountId: account.id, eventName: 'profile_created', createdAt: now() }); writeStore(store);
    return json(res, 201, { profileId: profile.id, createdAt: profile.createdAt, profileCompleteness: profileCompleteness(profile) });
  }

  const profileMatch = url.pathname.match(/^\/api\/profiles\/([^/]+)$/);
  if (req.method === 'GET' && profileMatch) {
    const account = requireAccount(req, res, url, store); if (!account) return;
    const p = store.profiles.find(x => x.id === profileMatch[1]);
    if (!ownsProfile(p, account)) return json(res, 404, { error: 'not_found' });
    return json(res, 200, { profile: { ...p, cvText: p.cvText ? '[stored]' : '' } });
  }

  if (req.method === 'POST' && url.pathname === '/api/analyze') {
    const account = requireAccount(req, res, url, store); if (!account) return;
    const body = await readJson(req, res); if (body === undefined) return;
    const profile = store.profiles.find(p => p.id === text(body.profileId, 80));
    if (!ownsProfile(profile, account)) return json(res, 400, { error: 'profile_required' });
    if (text(body.jobText, 20000).length < 40) return json(res, 400, { error: 'job_text_too_short' });
    const result = analyse(profile, body);
    const app = { id: id('app'), accountId: account.id, profileId: profile.id, status: 'Analyzed', notes: '', createdAt: now(), updatedAt: now(), ...result };
    store.applications.push(app); store.events.push({ id: id('evt'), accountId: account.id, eventName: 'analysis_created', payload: JSON.stringify({ score: app.fitScore }), createdAt: now() }); writeStore(store);
    return json(res, 201, { applicationId: app.id, createdAt: app.createdAt, ...result });
  }

  if (req.method === 'GET' && url.pathname === '/api/applications') {
    const account = requireAccount(req, res, url, store); if (!account) return;
    const profileId = text(url.searchParams.get('profileId') || '', 80);
    if (!profileId) return json(res, 400, { error: 'profile_id_required' });
    const profile = store.profiles.find(p => p.id === profileId);
    if (!ownsProfile(profile, account)) return json(res, 404, { error: 'not_found' });
    const apps = store.applications.filter(a => a.profileId === profileId && a.accountId === account.id).map(a => ({ id: a.id, company: a.company, roleTitle: a.roleTitle, fitScore: a.fitScore, recommendation: a.recommendation, status: a.status, createdAt: a.createdAt }));
    return json(res, 200, { applications: apps });
  }

  const appExport = url.pathname.match(/^\/api\/applications\/([^/]+)\/export\.md$/);
  if (req.method === 'GET' && appExport) {
    const account = requireAccount(req, res, url, store); if (!account) return;
    const app = store.applications.find(a => a.id === appExport[1]);
    if (!ownsApp(app, account)) return json(res, 404, { error: 'not_found' });
    return send(res, 200, markdown(app), 'text/markdown; charset=utf-8', { 'Content-Disposition': `attachment; filename="jobpilot-${app.id}.md"` });
  }

  const appMatch = url.pathname.match(/^\/api\/applications\/([^/]+)$/);
  if (req.method === 'GET' && appMatch) {
    const account = requireAccount(req, res, url, store); if (!account) return;
    const app = store.applications.find(a => a.id === appMatch[1]);
    return ownsApp(app, account) ? json(res, 200, { application: app }) : json(res, 404, { error: 'not_found' });
  }
  if (req.method === 'PATCH' && appMatch) {
    const account = requireAccount(req, res, url, store); if (!account) return;
    const body = await readJson(req, res); if (body === undefined) return;
    const app = store.applications.find(a => a.id === appMatch[1]);
    if (!ownsApp(app, account)) return json(res, 404, { error: 'not_found' });
    if (body.status) app.status = text(body.status, 80);
    if (body.notes !== undefined) app.notes = text(body.notes, 2000);
    app.updatedAt = now(); writeStore(store); return json(res, 200, { application: app });
  }
  if (req.method === 'DELETE' && appMatch) {
    const account = requireAccount(req, res, url, store); if (!account) return;
    const before = store.applications.length;
    store.applications = store.applications.filter(a => !(a.id === appMatch[1] && a.accountId === account.id));
    writeStore(store);
    return json(res, before === store.applications.length ? 404 : 200, before === store.applications.length ? { error: 'not_found' } : { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/waitlist') {
    const body = await readJson(req, res); if (body === undefined) return;
    const account = authAccount(req, url, store);
    const email = text(body.email || account?.email, 200).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: 'valid_email_required' });
    let lead = store.waitlist.find(w => w.email === email);
    if (!lead) { lead = { id: id('wait'), accountId: account?.id || '', email, userType: text(body.userType, 80), desiredPlan: text(body.desiredPlan, 80), monthlyApplications: Number(body.monthlyApplications || 0), message: text(body.message, 2000), createdAt: now() }; store.waitlist.push(lead); }
    else if (account && !lead.accountId) lead.accountId = account.id;
    store.events.push({ id: id('evt'), accountId: account?.id || '', eventName: 'waitlist_joined', createdAt: now() }); writeStore(store);
    return json(res, 201, { ok: true, waitlistId: lead.id });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/summary') {
    if (!process.env.ADMIN_TOKEN) return json(res, 404, { error: 'not_found' });
    if (req.headers.authorization !== `Bearer ${process.env.ADMIN_TOKEN}`) return json(res, 403, { error: 'forbidden' });
    return json(res, 200, { accounts: store.accounts.length, profiles: store.profiles.length, applications: store.applications.length, waitlist: store.waitlist.length, events: store.events.length, lastSignupAt: store.waitlist.at(-1)?.createdAt || null });
  }
  return json(res, 404, { error: 'not_found' });
}

ensureStore();
http.createServer(async (req, res) => {
  const started = Date.now();
  try {
    if ((req.url || '').split('?')[0] === '/health') return send(res, 200, 'ok');
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return api(req, res, url);
    if (!['GET','HEAD'].includes(req.method)) return json(res, 405, { error: 'method_not_allowed' });
    let file = safeFile(req.url || '/');
    if (!file) return send(res, 400, 'bad path');
    fs.stat(file, (err, st)=>{
      if (err || !st.isFile()) {
        if (path.extname(file)) return send(res, 404, 'not found');
        file = path.join(PUBLIC, 'index.html');
      }
      fs.readFile(file, (e, data)=> e ? send(res, 404, 'not found') : send(res, 200, req.method === 'HEAD' ? '' : data, TYPES[path.extname(file)] || 'application/octet-stream'));
    });
  } catch (e) {
    console.error('request_error', { path: req.url, ms: Date.now() - started, error: e.message });
    json(res, 500, { error: 'server_error' });
  }
}).listen(PORT, HOST, ()=> console.log(`jobpilot-ai listening on ${HOST}:${PORT}`));
