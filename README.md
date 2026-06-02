# JobPilot AI

A lightweight SaaS beta for job-application planning: create a private beta workspace, save a candidate profile, paste a job post, get a deterministic fit analysis, export an application pack, and manage application history.

## What it does

- Email-based beta workspace creation
- Token-gated account access stored in the browser
- Candidate profile capture
- Deterministic job-fit scoring and recommendations
- Saved application history scoped to the account
- Markdown export for each application pack
- Account data export
- Workspace deletion
- Privacy and terms pages
- Basic rate limiting, security headers, and hidden admin summary endpoint

## What it does not do yet

- No Stripe or subscription billing
- No LLM calls
- No resume file uploads
- No auto-apply
- No password reset or OAuth
- No production-grade legal review

## Run locally

Requires Node.js 20+.

```bash
npm test
HOST=127.0.0.1 PORT=3117 npm start
```

Open <http://127.0.0.1:3117>.

No production or test deployment URL is listed in this repository.

## API overview

- `POST /api/accounts`
- `GET /api/account`
- `GET /api/account/export`
- `DELETE /api/account`
- `POST /api/profiles`
- `POST /api/analyze`
- `GET /api/applications?profileId=...`
- `GET /api/applications/:id/export.md`
- `POST /api/waitlist`
- `GET /api/admin/summary` — hidden unless `ADMIN_TOKEN` is configured

Protected endpoints require an Authorization bearer header. Markdown exports also support a token query parameter for browser download links.

## Data storage

The beta uses a local JSON store under `data/store.json`, excluded from git. Runtime data and backups must not be committed.

## Tests

```bash
npm test
```

The smoke suite starts the server with a temporary data directory, checks auth/data isolation, verifies export/delete flows, and confirms removed public source zip URLs return 404.

## License and attribution

MIT. See `LICENSE` and `NOTICE.md`.

This project includes work adapted from the MIT-licensed `MadsLorentzen/ai-job-search` project. The public web UI intentionally does not display upstream branding, but the repository preserves the required copyright and license notice.
