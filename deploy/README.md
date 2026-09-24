# Deployment — account.amiri247.in

`main` → GitHub Actions → GHCR → `13.204.36.228`.

```
 push to main
      │
      ├── test      .github/workflows/ci.yml   typecheck · vitest (api + web) · build
      │
      ├── build     two images, tagged sha-<commit>, pushed to GHCR
      │               ghcr.io/rampravesh1412/finacesystem-api
      │               ghcr.io/rampravesh1412/finacesystem-web
      │
      └── deploy    rsync deploy/ → ssh → deploy.sh
                        docker compose pull · mongo-init · up --wait
                        verify https://account.amiri247.in/api/v1/
                        roll back to the previous tags on any failure
```

The server never builds. It pulls the exact images CI tested, which is what makes a
rollback a one-line change of tag rather than a rebuild on a box with two shared vCPUs.

## What runs on the server

| Container | Image | Ports | Notes |
|---|---|---|---|
| `amiri-mongo` | `mongo:7` | none published | single-node replica set `rs0`, keyfile auth |
| `amiri-api` | `…-api:sha-…` | `4000` internal | Express, runs as `node`, healthchecked on `/health` |
| `amiri-web` | `…-web:sha-…` | `80`, `443` | nginx: TLS, the Vite build, and `/api` → api |

MongoDB is a **replica set even though there is one node**, for the same reason it is in
development: every money movement posts inside a multi-document transaction and a
standalone `mongod` refuses to open the session.

`/api` is proxied on the same origin rather than given its own subdomain, because
`apps/web/src/lib/api.ts` hardcodes `/api/v1` and the refresh cookie is `SameSite=Strict`
— a second origin would drop it on every refresh.

### Files on the box

```
/srv/amiri/
├── deploy/                  rsynced from this directory on every deploy
│   ├── docker-compose.prod.yml
│   ├── scripts/
│   ├── .env                 generated once by bootstrap · NOT in git · Mongo password
│   └── api.env              generated once by bootstrap · NOT in git · JWT secrets
├── secrets/mongo-keyfile    replica-set internal auth, 0400 uid 999
├── secrets/ci_deploy_key    the key GitHub Actions authenticates with
├── uploads/                 bind-mounted into the api container
├── certbot-www/             ACME challenge webroot
└── backups/                 nightly mongodump, 14 kept
```

`.env` and `api.env` are excluded from the rsync in both directions. They hold generated
secrets that exist only on the server; overwriting them would rotate the database password
out from under a running Mongo and log every user out.

## The server

EC2 `i-0fe4eb206bd226cc5` (`Accounts`), t2.medium, **Amazon Linux 2023**, ap-south-1
(Mumbai), Elastic IP `13.204.36.228` (private `172.31.0.40`). Login user is `ec2-user`
with `sumit.pem`; root SSH is disabled.

Moved here on 2026-09-24 from `i-06ea805fe87ab2d93` (`amiri-finace`, t3.small, eu-north-1,
`16.16.129.104`), which is gone. Nothing was migrated off it — this box was bootstrapped
and deployed from scratch, so its Mongo password, JWT secrets and CI deploy key are all
new. Anyone who had a session on the old box is logged out, and the ledger starts empty.

The **security group must allow 80 and 443** from `0.0.0.0/0`, and 22 from wherever you
administer from. Without 80 the ACME challenge cannot be answered and there is no
certificate. There is no host firewall on Amazon Linux and the bootstrap does not install
one — the security group is the firewall, and it is the only one that would apply anyway,
since Docker's published ports bypass a host firewall's INPUT chain.

## First-time setup

**1. DNS — exactly one A record.** `account.amiri247.in` must resolve to this box and to
nothing else. Two records means round-robin: half of all traffic, and half of every ACME
validation, lands on a machine that is not running this app.

```bash
dig +short account.amiri247.in     # exactly one line: 13.204.36.228
```

**2. Bootstrap the server** — installs Docker and the compose plugin, adds a 2 GB
swapfile, creates the `deploy` user, generates secrets and installs the renewal and backup
timers. It detects Amazon Linux vs Ubuntu and adapts.

```bash
scp -i sumit.pem deploy/scripts/bootstrap-server.sh ec2-user@13.204.36.228:/tmp/
ssh -i sumit.pem ec2-user@13.204.36.228 \
  'sudo DOMAIN=account.amiri247.in bash /tmp/bootstrap-server.sh'
```

It prints the four repository secrets to set, including the private key it generated.
Copy them before closing the terminal.

**3. Repository secrets** — Settings ▸ Secrets and variables ▸ Actions:

| Secret | Value |
|---|---|
| `SSH_HOST` | `13.204.36.228` |
| `SSH_USER` | `deploy` |
| `SSH_PRIVATE_KEY` | the key printed by bootstrap, `BEGIN`/`END` lines included |
| `SSH_KNOWN_HOSTS` | the host-key line printed by bootstrap |

Pinned from a secret rather than `ssh-keyscan`ed at deploy time — keyscan trusts whatever
answers, which is no verification at all.

**4. Push to main.** The first deploy brings the stack up on a self-signed placeholder
certificate; the site works, the browser warns.

**5. Issue the real certificate.** certbot runs as a container — Amazon Linux does not
package it, and the official image behaves the same on every distribution.

```bash
ssh -i sumit.pem ec2-user@13.204.36.228 \
  'sudo LETSENCRYPT_EMAIL=you@example.com /srv/amiri/deploy/scripts/issue-cert.sh'
```

It refuses to proceed unless the domain resolves to exactly one address and that address
is this box — a failed challenge costs an hour of rate limit, a refusal costs nothing.

**6. Create the first super admin, once.** It prompts for a password, so run it from an
interactive shell rather than as a one-line `ssh` command:

```bash
ssh -i sumit.pem ec2-user@13.204.36.228
sudo -u deploy /srv/amiri/deploy/scripts/bootstrap-admin.sh \
  --email you@amiri247.in --name "Your Name"
```

Note this is **not** `npm run seed`. [seed.ts](../apps/api/src/scripts/seed.ts) exits under
`NODE_ENV=production` on purpose — it creates four accounts whose password is written down
in this repository. `bootstrap-admin.sh` creates the system roles, one branch, the system
ledger accounts and exactly one super admin with a password you type, and refuses to run
again once an admin exists.

## Day to day

```bash
# what is live
ssh deploy@13.204.36.228 'grep IMAGE /srv/amiri/deploy/.env'

# logs
ssh deploy@13.204.36.228 \
  'docker compose -f /srv/amiri/deploy/docker-compose.prod.yml logs -f --tail=100 api'

# manual rollback to any previously built commit
ssh deploy@13.204.36.228 '/srv/amiri/deploy/scripts/deploy.sh \
  ghcr.io/rampravesh1412/finacesystem-api:sha-<commit> \
  ghcr.io/rampravesh1412/finacesystem-web:sha-<commit>'

# backup now
ssh deploy@13.204.36.228 /srv/amiri/deploy/scripts/backup.sh
```

Re-running the Deploy workflow from the Actions tab with **skip_tests** checked is the
fast path for a hotfix; it still builds and still health-gates the rollout.

## Known gaps

- **Backups are on the same disk as the database.** They survive a bad migration, not a
  lost instance. Ship `/srv/amiri/backups` to S3 or another host before treating the
  ledger as backed up.
- **No staging environment.** `main` is production. A second box would mean a second
  `.env`, a second domain, and an `environment:` matrix in the deploy job.
- **One node, so downtime on deploy is real** — a few seconds while the API container is
  replaced. Zero-downtime needs two API replicas and nginx retrying the dead one, which
  needs the ledger's in-process state audited for it first.
- **`npm run lint` is not wired into CI** because the repo has neither an ESLint config nor
  the dependency; the `lint` script would fail on the first run. Add both and it belongs
  in `ci.yml` next to `typecheck`.
