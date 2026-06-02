const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');

const PORT = 3129;
const BASE = `http://127.0.0.1:${PORT}`;

function request(path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(`${BASE}${path}`, {
      method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers
      }
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => raw += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw, json: raw && res.headers['content-type']?.includes('json') ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitForHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await request('/health');
      if (res.status === 200 && res.raw === 'ok') return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not become healthy');
}

(async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname + '/..',
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT), DATA_DIR: '/tmp/jobpilot-ai-test-data-' + Date.now() },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  try {
    await waitForHealth();

    let res = await request('/api/accounts', { method: 'POST', body: { email: 'jane@example.com' }});
    assert.equal(res.status, 201, res.raw);
    assert.ok(res.json.accountId);
    assert.ok(res.json.accessToken);
    const auth = { Authorization: `Bearer ${res.json.accessToken}` };

    res = await request('/api/profiles', { method: 'POST', headers: auth, body: {
      name: 'Jane Candidate', targetRoles: 'AI Product Manager', location: 'Remote', yearsExperience: 6,
      skills: 'AI, B2B SaaS, analytics, customer discovery, stakeholder management', industries: 'SaaS, AI',
      goals: 'Move into AI workflow automation', dealbreakers: 'onsite only', cvText: 'Shipped AI workflow prototypes and analytics dashboards.'
    }});
    assert.equal(res.status, 201, res.raw);
    assert.ok(res.json.profileId);
    assert.ok(res.json.profileCompleteness > 50);
    const profileId = res.json.profileId;

    res = await request('/api/analyze', { method: 'POST', body: {
      profileId, company: 'NoAuth Corp', roleTitle: 'Senior Product Manager', jobText: 'Senior Product Manager role requiring AI product work and B2B SaaS analytics.'
    }});
    assert.equal(res.status, 401, res.raw);

    res = await request('/api/analyze', { method: 'POST', headers: auth, body: {
      profileId, company: 'Acme AI', roleTitle: 'Senior Product Manager', jobUrl: 'https://example.com/job',
      jobText: 'Senior Product Manager for AI workflow automation. Requires B2B SaaS, analytics, customer discovery, stakeholder management, shipping AI products, remote team leadership.'
    }});
    assert.equal(res.status, 201, res.raw);
    assert.ok(res.json.applicationId);
    assert.ok(res.json.fitScore >= 0 && res.json.fitScore <= 100);
    assert.ok(Array.isArray(res.json.matchedSkills));
    assert.ok(res.json.cvPlan.length >= 3);
    const appId = res.json.applicationId;

    res = await request(`/api/applications?profileId=${encodeURIComponent(profileId)}`);
    assert.equal(res.status, 401, res.raw);

    res = await request(`/api/applications?profileId=${encodeURIComponent(profileId)}`, { headers: auth });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.json.applications.length, 1);

    res = await request(`/api/applications/${appId}/export.md`);
    assert.equal(res.status, 401, res.raw);

    res = await request(`/api/applications/${appId}/export.md`, { headers: auth });
    assert.equal(res.status, 200, res.raw);
    assert.ok(res.raw.includes('JobPilot AI Application Pack'));
    assert.ok(res.raw.includes('Acme AI'));

    res = await request('/api/account/export', { headers: auth });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.json.account.id, res.json.accountId || res.json.account.id);
    assert.equal(res.json.profiles.length, 1);
    assert.equal(res.json.applications.length, 1);

    res = await request('/api/waitlist', { method: 'POST', headers: auth, body: { email: 'jane@example.com', userType: 'job_seeker', desiredPlan: 'active_search', monthlyApplications: 20, message: 'Interested' }});
    assert.equal(res.status, 201, res.raw);
    assert.ok(res.json.waitlistId);

    res = await request('/api/waitlist', { method: 'POST', body: { email: 'bad-email' }});
    assert.equal(res.status, 400, res.raw);

    res = await request('/jobpilot-ai-source.zip');
    assert.equal(res.status, 404);

    res = await request('/api/nope');
    assert.equal(res.status, 404);
    assert.equal(res.json.error, 'not_found');

    res = await request('/api/applications');
    assert.equal(res.status, 401);
    assert.equal(res.json.error, 'auth_required');

    res = await request('/api/admin/summary');
    assert.equal(res.status, 404);
    assert.equal(res.json.error, 'not_found');

    res = await request('/privacy.html');
    assert.equal(res.status, 200);
    assert.ok(res.raw.includes('Privacy'));

    res = await request('/terms.html');
    assert.equal(res.status, 200);
    assert.ok(res.raw.includes('Terms'));

    res = await request('/api/profiles', { method: 'POST', headers: auth, body: { name: 'x'.repeat(70000) }});
    assert.equal(res.status, 413);

    res = await request('/api/account', { method: 'DELETE', headers: auth });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.json.deleted.profiles, 1);
    assert.equal(res.json.deleted.applications, 1);

    res = await request('/api/account/export', { headers: auth });
    assert.equal(res.status, 401, res.raw);

    console.log('api smoke ok');
  } finally {
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 1000).unref();
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
