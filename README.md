# AMIRI Finance

A financial management / accounting ERP on MongoDB · Express · React · Node · TypeScript.

Double-entry ledger, branch-isolated books, a configurable permission engine, approval
workflows and an immutable audit trail.

---

## Running it

Node 20.11+ required.

```bash
npm install
```

**1. Start MongoDB.** It must be a replica set — every money movement is written inside a
multi-document transaction, which a standalone `mongod` cannot do. The API refuses to
start against one rather than risk half-written financial data.

```bash
npm run db:up      # Docker (preferred)
npm run db:local   # no Docker — downloads mongod once, persists to .mongo-data/
```

**2. Configure the API.**

```bash
cp apps/api/.env.example apps/api/.env
# then set two DIFFERENT secrets, each 32+ characters:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

**3. Seed and run.**

```bash
npm run seed
npm run dev        # API on :4000, web on :5173
```

Open <http://localhost:5173>.

### Seeded accounts

All use `Amiri@2026` and must set a new password on first sign-in.

| Email | Role | Sees |
|-------|------|------|
| `superadmin@amiri.co` | Super Admin | every branch |
| `branchadmin@amiri.co` | Branch Admin | branches 105, 107 |
| `accountant@amiri.co` | Accountant | branch 105 |
| `viewer@amiri.co` | Viewer | branch 105, read-only |

**Worth trying:** sign in as the accountant and attempt to reach branch 107 — by the
branch list, by URL, by `?branchId=`, or by the branch switcher. Every route refuses it
at the database query, not in the browser.

---

## Scripts

```bash
npm run dev          # API + web together
npm run dev:api      # API only
npm run dev:web      # web only
npm run typecheck    # every workspace
npm test             # API test suite
npm run seed         # idempotent; never resets an existing password
npm run build        # production build of all workspaces
npm run db:local     # MongoDB replica set without Docker
npm run db:reset     # drop the Docker volume and start clean
```

---

## Layout

```
packages/shared   contracts used by BOTH sides — money maths, the permission
                  catalogue, enums, Zod schemas. Shared so the client cannot
                  validate more loosely than the server, or format an amount
                  differently from how it was computed.
apps/api          Express 5 + Mongoose 8
apps/web          Vite + React 18 + Tailwind + shadcn-style primitives
docs/ARCHITECTURE.md   the design, the data model, and the phase plan
```

---

## The parts worth knowing about

**Money is integer paise.** `₹1 = 100 paise`, stored as a whole number, validated at every
entry point. No float ever touches an amount. `packages/shared/src/money.ts` is the only
place arithmetic on money is allowed, and it is where Indian formatting
(`₹1,25,101.00`), basis-point charge rates, and remainder-safe splitting live.

**Balances are derived, never stored.** The ledger is the source of truth. Cached balances
exist as a denormalisation and are reconciled against a full replay; a mismatch raises an
alert and is never silently overwritten.

**Branch isolation is a query concern.** `requireBranchAccess` builds `req.scope.filter`
from the user's database record, and every branch-owned query spreads it. A branch named
in a request can only narrow that scope, never widen it — an out-of-scope branch is a 403,
not a silently empty result.

**Permissions are data, not code.** Roles are database rows holding permission strings from
one catalogue in `@amiri/shared`. A SuperAdmin can edit them at runtime and every guard
changes behaviour immediately. The only role name special-cased anywhere is the unscoped
flag that defines a SuperAdmin — and only an unscoped user can grant it.

**Nothing is hard-deleted.** Financial records are corrected by reversal, never removal.
There is no DELETE route for a transaction anywhere in the API. Ledger entries and audit
rows reject `update` and `delete` at the model layer.

**The Khata is a view, not a second ledger.** §11's arithmetic — opening + given + taken +
adjustments = current — is what the party's ledger account already computes. A parallel
khata store would give the same party two balances that drift apart, and then nobody could
say which one they actually owe.

**Money nobody authorised never moves.** A transaction held for approval has no ledger
entries at all — the postings are stored and written only on approval. Nobody can approve
their own submission, whatever their role.

**A closed period is closed to everything**, reversals included. Figures somebody has
already reported on must not change underneath them; a correction is posted in the current
period instead.

**Cash flow is not profit.** They are computed by separate functions over separate account
classes and never added together. The dashboard puts them in two labelled groups with two
charts; the P&L reports cash movement in its own panel below the profit calculation. A
branch can push ₹10,00,000 through its accounts in a day and still lose money.

**Discrepancies are acknowledged, never absorbed.** A reconciliation whose statement and
ledger disagree cannot be closed silently — it requires an explicit acknowledgement, and
the difference stays on the record afterwards.

**Charges never touch the gross.** Gross, charge and net are three stored fields with
three separate ledger effects, and rates are integer basis points (1.75% is `175`). A
commission that drifts by a paisa per transaction is a month-end reconciliation problem
nobody can explain.

---

## Status

**Phases 1 through 13 are complete and verified**, with **223 API tests** and **76 frontend tests**.

*Phase 1* — authentication, sessions, RBAC, the permission engine, branch isolation,
branches, users, roles and the audit trail. Tests cover account lockout, refresh-token
reuse detection, privilege-escalation attempts, cross-branch access and audit
immutability.

*Phase 2* — the chart of accounts and **the double-entry posting engine**, plus banks,
bank accounts, cash drawers and parties. Tests cover the §59 headline case (Bank A
₹1,00,000 → Bank B leaves A down exactly ₹1,00,000, B up exactly ₹1,00,000, and the system
total unchanged), unbalanced postings rolling back with zero entries written, gap-free
voucher numbering across a rollback, overdraft limits, cash drawers that cannot go
negative, ledger immutability, account-number masking and a trial balance that ties.

Every opening balance is a real posting against equity — the seed prints the resulting
trial balance and refuses to succeed if it does not balance.

*Phase 3* — Payment In / Payment Out, bank transfers, itemised expenses, income, the
charge engine and transaction reversal. Tests cover the 1.75%-of-₹1,00,000 worked example
from the brief (charge ₹1,750, net ₹98,250), tiered and capped rates, a party-borne
commission that credits the party only the net, cash that cannot be overdrawn, credit
limits, and reversal restoring every balance *exactly* while the original stays visible
and linked.

*Phase 4* — Digital Khata, balance adjustments, credit aging, Bachat Khata, bank
reconciliation and settlements. Tests cover the Lena/Dena reading of a party ledger,
FIFO aging into 0–30/31–60/61–90/90+ buckets that reconcile exactly to the outstanding
balance, savings as a liability that cannot be overdrawn, pro-rata interest, and a
reconciliation that refuses to close over an unexplained difference.

*Phase 5* — role dashboards, the Daily Cash Tally, Profit & Loss, Balance Sheet and Cash
Flow. Tests cover the balance-sheet identity holding, retained earnings reconciling to the
P&L, a cash tally recording SHORT without touching the ledger, and a scoped user's
dashboard containing no other branch's figures.

*Phase 6* — the approval workflow, financial periods and the audit log. Tests cover a held
transaction moving no money and writing no ledger entries, an approver being unable to
clear their own submission or one above their tier, a closed period blocking every posting
including reversals, and the audit log refusing any write.

*Phase 7* — CSV/Excel/PDF export, the party importer, notifications, and the screens that
were still API-only: Cash Book, Bank Book, Party Ledger, Charges, Settlements,
Reconciliation, Trial Balance and the reports hub. Tests cover an export whose CSV
neutralises a party name that would otherwise execute as a spreadsheet formula, an audit
export that carries the screen's filters without losing its branch scoping, a preview that
writes nothing, an importer that reports duplicates rather than overwriting them, a
notification failure that cannot break the transaction that triggered it, and a
reconciliation that stays invisible to another branch even when its id is known.

*Phase 8* — Settings (organisation profile and the approval-threshold editor), route-level
code splitting, virtualisation for the two unbounded reports, motion, and a print
stylesheet. Tests cover a fiscal year that is editable on an empty ledger and refused with
a reason once anything is posted, a renamed organisation reaching the export header, and
cleared optional fields being dropped rather than stored as empty strings.

Three defects were found and fixed in the process: a stale compiled `vite.config.js` that
had been silently overriding the real config, a `manualChunks` setting that put 384 kB of
Recharts on the login page, and an organisation name with two sources of truth. All three
are written up in `docs/ARCHITECTURE.md` §13.

*Phase 9* — master-data creation. Four screens had permanently disabled "New …" buttons, so
the application could not onboard a party, a bank, an account or a user through its own UI
despite every write endpoint existing and being tested. Wiring them up surfaced a second
defect: the create endpoints answered in a different shape from the list endpoints, omitting
the posted opening balance and returning **unmasked** account numbers regardless of
permission. Both are written up in `docs/ARCHITECTURE.md` §14.

*Phase 10* — master-data maintenance. `api.patch` appeared nowhere in the web application:
every update endpoint was unreachable, including revoking a departed employee's access and
resetting a locked-out user's password. Expense and income heads — which *are* ledger
accounts — had no screen at all, so a business whose expenses did not match the seeded heads
had nowhere to put them. Four further defects surfaced while building it, including a
regression phase 9 introduced in the user create response that no test had caught. All are
written up in `docs/ARCHITECTURE.md` §15.

*Phase 11* — making the remaining workflows operable rather than observable. **Income could
not be recorded at all**: the endpoint, the schema and the listing screen existed, but the
transaction form had no income mode. Adjustments (§25) had no screen either — despite the
party edit form telling operators to correct balances that way. Savings, settlements and
charge rules could be read but not created. Written up in `docs/ARCHITECTURE.md` §16,
including the sixth occurrence of a create endpoint answering in a different shape from its
list endpoint.

*Phase 12* — role management, and **the first frontend tests**. The application had none: twenty
forms built over three phases, verified only by hand. The first run found a shipped bug — the
adjustment form could not submit at all, because its reason field was held outside the form
that validates it, so the click did nothing and showed no error. Phase 11's live check had
used curl and never touched the screen. There is also now a contract test that walks every
create route and asserts it answers in its list's shape, so the seventh occurrence of that
recurring defect fails in CI rather than in a browser. Written up in
`docs/ARCHITECTURE.md` §17.

*Phase 13* — a test sweep over the forms where a defect costs money. It found three more
defects: the transaction form's labels were bound to no control at all (invisible to a
screen reader, on the one screen through which every rupee moves), the charge rule form
could not submit for the same reason the adjustment form could not — a value computed after
validation is a value never validated — and an adjustment's cross-tab error rendered on a
hidden tab. Written up in `docs/ARCHITECTURE.md` §18.

Unbuilt screens appear in the sidebar as disabled entries marked "Soon", and the dashboard
states plainly which figures are live. Nothing renders invented financial data — a
plausible-looking number that nobody computed is worse than an empty panel, because
someone will eventually act on it.

### Not yet supplied

The **AMIRI ERP workbook** and the **19/08/2026 DayBook** referenced in the requirements
were not in the repository. Their concepts are modelled from the written description; drop
the files into `docs/reference/` and the Excel importer can be pinned to the real column
headers.
