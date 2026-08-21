# AMIRI Finance — Architecture & Data Model

A production-grade financial management / accounting ERP on MERN + TypeScript.

Status: living document. Updated as phases land.

---

## 0. Inspection baseline

The repository was empty at the start of this build (single commit, `README.md` only).
There is no pre-existing frontend, backend, auth layer, database setup or API convention
to preserve, so everything below is designed from scratch rather than retrofitted.

Two artefacts referenced by the product brief were **not present on disk**:

- the AMIRI ERP Excel workbook (sheets: Settings, Daily Profit & Cash, Party Ledger,
  Expenses, Party Summary, Dashboard)
- the 19/08/2026 DayBook export

Their *concepts* are modelled from the written brief (see §11 Migration). The Excel
importer is built against that shape and must be re-pinned to the real column headers
once the workbook is available. Place it at `docs/reference/` when you have it.

---

## 1. Guiding principles

These are non-negotiable and every module is measured against them.

1. **Money is never a float.** All amounts are integer **paise** (minor units).
   `₹1 = 100 paise`. Formatting to `₹1,25,101.00` happens only at the presentation edge.
2. **Balances are derived, not stored.** The ledger is the source of truth. Cached
   balances exist only as a performance denormalisation and must be reproducible by
   replaying ledger entries.
3. **The ledger is append-only.** No `UPDATE`, no `DELETE` on `LedgerEntry`. Mistakes are
   corrected by posting a *reversal*, never by mutating history.
4. **Every rupee has two sides.** Every posting is balanced double-entry:
   `Σ debit === Σ credit`. A transaction that does not balance is rejected before it is
   written.
5. **Branch isolation is a database concern.** Scoping happens in the query builder, not
   in the controller and never in the browser.
6. **Cash flow ≠ profit.** These are computed by separate engines over separate account
   classes and are never conflated.
7. **Nothing happens without an audit trail.** Every state change writes an immutable
   `AuditLog` row inside the same transaction that made the change.
8. **Discrepancies are surfaced, never smoothed.** If expected ≠ actual, the system says
   `SHORT ₹20,000` and stops. It does not silently adjust the expectation.

---

## 2. Repository shape

npm workspaces monorepo. One install, one typecheck, shared types across the wire.

```
FinaceSystem/
├── docker-compose.yml          # MongoDB 7 single-node replica set (txn support)
├── package.json                # workspace root + orchestration scripts
├── tsconfig.base.json
├── docs/
│   ├── ARCHITECTURE.md         # this file
│   └── reference/              # AMIRI workbook / DayBook exports (drop-in)
├── packages/
│   └── shared/                 # @amiri/shared — isomorphic contracts
│       └── src/
│           ├── money.ts        # paise arithmetic + Indian formatting
│           ├── permissions.ts  # the permission catalogue (single source of truth)
│           ├── enums.ts        # TransactionType, Status, PaymentMode, AccountKind…
│           ├── schemas/        # Zod contracts reused by API validation + RHF forms
│           └── api.ts          # ApiResponse<T>, Paginated<T>, ApiError shapes
└── apps/
    ├── api/                    # Express 5 + Mongoose 8 + TypeScript
    │   └── src/
    │       ├── config/         # env (Zod-validated), db, logger
    │       ├── models/         # Mongoose schemas
    │       ├── modules/        # feature slices: routes + controller + service
    │       ├── services/       # cross-cutting financial engine
    │       ├── middleware/     # auth, rbac, branch scope, validate, error
    │       ├── lib/            # errors, async handler, pagination, numbering
    │       └── scripts/        # seed, migrate, backfill
    └── web/                    # Vite + React 19 + TypeScript
        └── src/
            ├── app/            # router, providers, layout shell
            ├── components/ui/  # shadcn primitives
            ├── components/     # shared composites (DataTable, MoneyText, …)
            ├── features/       # one folder per domain, mirrors the sidebar
            ├── hooks/ lib/ services/ types/ utils/
```

**Why a shared package.** `permissions.ts` is imported by the API's `requirePermission`
guard *and* by the web app's sidebar filter. They cannot drift. Same for money maths —
the client must format the same integer the server computed, never re-derive it.

---

## 3. Money

`packages/shared/src/money.ts` is the only place arithmetic on money is allowed.

- Representation: **integer paise**, stored in Mongo as a 64-bit-safe `Number` with an
  `isInteger` validator on every money path.
- Range: `Number.MAX_SAFE_INTEGER` paise ≈ **₹90,071,992,547,409.91**. Comfortably beyond
  any realistic book, and exact — no `Decimal128` marshalling cost on every read, and
  `$sum` in the aggregation pipeline stays exact.
- Parsing: `parseRupees("1,25,101.00") -> 12510100`. Rejects anything with more than two
  decimal places rather than rounding silently.
- Splitting: `allocate(total, weights)` distributes remainder paise deterministically so a
  split never loses or invents a paisa.
- Formatting: `formatINR(12510100) -> "₹1,25,101.00"` using the Indian 2-2-3 grouping.

> Decimal128 was considered and rejected: it forces `.toString()` → `Big` conversions on
> every arithmetic op in Node, and Mongoose returns it as an opaque BSON type that
> serialises awkwardly to JSON. Integer paise is exact, fast, and trivially auditable.

---

## 4. The ledger engine

This is the heart of the system. Everything else is a view over it.

### 4.1 Chart of accounts

Every balance-bearing thing in the system — a bank account, the branch cash drawer, a
party, an expense head, an income head, a savings account — is a row in **one**
collection, `LedgerAccount`. This is what makes the trial balance and balance sheet fall
out for free.

| `kind`      | `class`   | Normal side | Backed by        |
|-------------|-----------|-------------|------------------|
| `BANK`      | ASSET     | Debit       | `BankAccount`    |
| `CASH`      | ASSET     | Debit       | `CashAccount`    |
| `PARTY`     | ASSET/LIAB| either      | `Party`          |
| `EXPENSE`   | EXPENSE   | Debit       | `ExpenseCategory`|
| `INCOME`    | INCOME    | Credit      | `IncomeHead`     |
| `SAVINGS`   | LIABILITY | Credit      | `SavingsAccount` |
| `CHARGE`    | EXPENSE   | Debit       | system head      |
| `EQUITY`    | EQUITY    | Credit      | opening balances |
| `SUSPENSE`  | ASSET     | Debit       | reconciliation   |

`refKind` + `refId` link the ledger account back to its master record. A `Party` row and
its `LedgerAccount` are created together, atomically.

### 4.2 Postings

```
Transaction  (the journal header — 1 per business event)
   └── LedgerEntry[]  (the journal lines — ≥2, always balanced)
```

`LedgerEntry` fields: `transactionId`, `ledgerAccountId`, `branchId`, `date`,
`direction` (`DEBIT` | `CREDIT`), `amount` (paise, always positive), `runningBalance`,
`narration`, `createdBy`, `createdAt`. Append-only — enforced by a pre-hook that throws on
`updateOne`/`deleteOne`/`findOneAndUpdate` for this model.

Worked examples the engine must produce:

**Bank A → Bank B, ₹1,00,000 with ₹50 charge**
```
DR  Bank B                    100,000.00
DR  Bank Charges                   50.00
    CR  Bank A                         100,050.00
```

**Payment In ₹1,00,000 from a party**
```
DR  Bank/Cash                 100,000.00
    CR  Party                           100,000.00     (receivable reduced)
```

**Payment Out ₹1,00,000 to a party**
```
DR  Party                     100,000.00
    CR  Bank/Cash                       100,000.00
```

**Expense ₹5,000 (panel expense, paid from HDFC)**
```
DR  Expense: Panel              5,000.00
    CR  Bank: HDFC                        5,000.00
```

### 4.3 Balance calculation

Two paths, and they must always agree:

1. **Authoritative** — `$match` on account + date, `$group` summing
   `debit - credit` (sign-adjusted by account class). Slower, always correct.
2. **Fast** — `LedgerAccount.cachedBalance`, updated inside the same Mongo transaction as
   the posting, plus `BalanceSnapshot` documents written per account per day so a ledger
   query never scans from inception.

A nightly (and on-demand) **integrity job** recomputes path 1 and compares to path 2. A
mismatch raises a reconciliation alert — it does **not** overwrite. Per §62, the system
reports the discrepancy and the human investigates.

### 4.4 Collection materialisation

Every collection is created and every index built at boot, before the process serves
traffic. This is a correctness requirement, not an optimisation: postings run under
`readConcern: "snapshot"`, and creating a collection mid-transaction is a catalog change
that a snapshot read cannot cross. MongoDB raises `SnapshotUnavailable`, classifies it as
*transient*, and the driver retries — hitting the same wall on the next uncreated
collection until the retry budget is gone. A perfectly valid transfer then fails on a
fresh database with an error that looks like contention. See `materialiseCollections` in
`config/db.ts`.

### 4.5 Sessions are single-threaded

A MongoDB `ClientSession` carries exactly **one** in-flight operation. Issuing two at once
against the same session — `Promise.all([a(session), b(session)])` — makes the driver
advance the transaction number under itself, and the second operation fails with
`NoSuchTransaction: Given transaction number N does not match any in-progress
transactions`. The transaction aborts.

This surfaces *intermittently*, only under concurrency, and looks like flakiness rather
than a bug. Every operation inside `withTransaction` is therefore awaited sequentially.
Parallelism there buys nothing anyway: the operations are on one connection.

### 4.6 Opening balances are signed in the account's own terms

`postOpeningBalance(amount)` means "this account opens holding `amount`", whichever side
it normally sits on. For an asset that is a debit; for a **liability** — a Bachat Khata
member's savings, where the money is theirs and we merely hold it — the identical
"opening balance of ₹10,000" is a **credit**.

An earlier version debited unconditionally, which opened every savings account at minus
its deposit. The trial balance still tied, which is exactly why it was easy to miss: a
consistently wrong sign balances perfectly against equity.

### 4.7 Every transaction type needs a discriminator

`TRANSACTION_TYPE` and the registered Mongoose discriminators must stay in step. A type
declared in the enum but never registered throws `Discriminator "X" not found` at the
moment somebody first posts one — at runtime, inside a transaction, as a 500.
`models/discriminators.ts` ends with a completeness check that runs on import, so the gap
fails at boot instead.

### 4.8 A held transaction has no ledger entries

When an amount crosses an approval threshold (§27) the transaction is stored as a PENDING
header carrying the exact posting lines it *will* write — and **nothing touches a
balance** until somebody approves.

The alternative, posting immediately and reversing on rejection, was rejected outright: it
would mean an unapproved ₹10,00,000 payment briefly moving a real balance and appearing in
the DayBook. Storing the lines rather than recomputing them also means the approver signs
off exactly what the submitter saw, even if a charge rule is edited in between.

The provisional voucher number (`PENDING-…`) is replaced by a real one only on approval,
so a rejected request never consumes a number from the PAY-OUT sequence.

### 4.9 Atomicity

Every money movement runs inside a Mongo session/transaction:

```
withTransaction(async (session) => {
  assertPeriodOpen(date)                  // §35
  assertSufficientBalance(source, amount) // configurable per-account overdraft
  const txn    = await createTransaction(...)   // numbering from Counter, in-session
  const lines  = await postLedgerEntries(...)   // asserts Σdr === Σcr
  await bumpCachedBalances(lines)
  await writeAuditLog(...)
  return txn
})
```

Any throw rolls the whole thing back. This is why the dev database is a **replica set**
even though it is single-node — standalone `mongod` cannot do multi-document transactions.

---

## 5. Transaction model — Mongoose discriminators

One `transactions` collection, one numbering sequence, one DayBook query, but a distinct
strongly-typed schema per business event:

```
Transaction (base)
├── PaymentIn        PAY-IN-2026-000001
├── PaymentOut       PAY-OUT-2026-000001
├── BankTransfer     BANK-TRF-2026-000001
├── Expense          EXP-2026-000001       (+ itemised lines)
├── Income           INC-2026-000001
├── Adjustment       ADJ-2026-000001
├── Settlement       SET-2026-000001
└── SavingsTxn       SAV-2026-000001
```

Base fields: `txnNo`, `type`, `date`, `branchId`, `status`, `grossAmount`, `chargeAmount`,
`netAmount`, `narration`, `referenceNo`, `paymentMode`, `attachments[]`, `notes[]`,
`createdBy`, `approvals[]`, `approvedBy`, `postedAt`, `reversalOf`, `reversedBy`,
`periodId`, timestamps.

Status machine:
```
DRAFT ──▶ PENDING ──▶ APPROVED ──▶ COMPLETED ──▶ REVERSED
  │           │                        ▲
  └──▶ CANCELLED  └──▶ REJECTED        └── FAILED
```
Ledger entries are written on the `APPROVED → COMPLETED` (post) edge, never before.

**Numbering** uses an atomic `Counter` collection keyed `{scope, fiscalYear}` with
`findOneAndUpdate($inc, upsert)` inside the transaction session — gap-free and race-free.

---

## 6. Collections

```
Identity        User, Role, Permission(catalogue in code), Session/RefreshToken, LoginAttempt
Org             Branch, FinancialPeriod, SystemSetting
Masters         Party, Bank, BankAccount, CashAccount, ExpenseCategory, IncomeHead,
                ChargeRule, SavingsAccount
Ledger          LedgerAccount, LedgerEntry, BalanceSnapshot
Journal         Transaction (+8 discriminators)
Ops             Approval, Reconciliation, ReconciliationLine, DailyCashTally, Settlement
Trace           AuditLog, Attachment, Notification
```

**Index strategy** — compound and branch-first, because every operational query is
branch-scoped:

```
LedgerEntry     { branchId, ledgerAccountId, date, _id }   ← ledger paging
                { transactionId }                          ← drawer detail
Transaction     { branchId, date: -1, _id: -1 }            ← DayBook
                { txnNo } unique
                { branchId, status, date: -1 }             ← approval queue
                { partyId, date: -1 }  { referenceNo }
AuditLog        { entity, entityId, createdAt: -1 }  { userId, createdAt: -1 }
Party           { branchId, name } text  { branchId, code } unique
```

---

## 7. Authorization

Three layers, all server-side, composable as middleware:

```ts
requireAuth                       // valid access token → req.user
requireRole('SUPER_ADMIN')        // coarse
requirePermission('finance.payment.create')   // fine — the real gate
requireBranchAccess()             // injects req.scope
```

`req.scope` is the query fragment every repository call must spread:

```ts
// SUPER_ADMIN
{}
// everyone else
{ branchId: { $in: user.branchIds } }
```

This is enforced by making the base repository *require* a scope argument — a query
without one does not typecheck. Frontend filtering is presentation only and is never
trusted.

Permissions live in `@amiri/shared/permissions` as a flat catalogue
(`finance.payment.create`, `finance.bank.reconcile`, `audit.view`, …). Roles are
**database rows holding permission arrays**, editable by SuperAdmin — role names are not
hard-coded gates anywhere except the three seeded system roles.

---

## 8. API conventions

REST, `/api/v1`. Uniform envelope:

```jsonc
// success
{ "success": true, "data": {...}, "meta": { "page": 1, "limit": 50, "total": 1284 } }
// failure
{ "success": false, "error": { "code": "INSUFFICIENT_BALANCE",
    "message": "HDFC ****1234 has ₹12,000.00 available",
    "field": "sourceAccountId", "details": {...} } }
```

Errors are thrown as typed `AppError` subclasses and rendered by one terminal error
middleware. Stack traces never cross the wire in production. Zod validation failures map
to `422` with per-field `details`.

Security: JWT access (15 min, `Authorization` header) + rotating refresh token
(7 days, httpOnly SameSite=Strict cookie, reuse detection), argon2id password hashing,
helmet, CORS allowlist, per-route rate limits (aggressive on `/auth/login`), account
lockout after N failures, `express-mongo-sanitize`, and field-level masking so account
numbers leave the server as `XXXX XXXX 1234` unless the caller holds
`finance.bank.viewFull`.

---

## 9. Frontend

- **Server state**: TanStack Query only. No Redux. Query keys mirror the REST paths.
- **Forms**: React Hook Form + the *same* Zod schema the API validates with.
- **Tables**: one `DataTable` built on TanStack Table — server-side pagination, column
  visibility, sticky header, row drawer, bulk select, keyboard nav, CSV/XLSX/PDF export.
- **Money in the UI**: a single `<Money>` component. Positive/negative styling is paired
  with an explicit `In`/`Out` label and an arrow glyph, never colour alone (§43).
- **Filters** live in the URL via `nuqs`-style search params so any view is shareable.
- **Design tokens**: deep charcoal/navy surfaces, indigo accent, semantic
  success/warning/danger. Dark mode is a **separate token set**, not an inversion.

---

## 10. Implementation phases

Each phase leaves the application runnable and the tests green.

| Phase | Scope | State |
|-------|-------|-------|
| 0 | Monorepo, Docker Mongo RS, shared package, tooling | ✅ done |
| 1 | Auth, RBAC, permission engine, Users, Roles, Branches | ✅ done, 27 tests green |
| 2 | Banks, BankAccounts, CashAccounts, Parties, chart of accounts, **ledger posting engine** | ✅ done, 69 tests green |
| 3 | Payment In/Out, Bank Transfer, Expense, Income, Charges, Reversal | ✅ done, 99 tests green |
| 4 | Digital Khata, Credit & aging, Bachat Khata, Settlement, Reconciliation | ✅ done, 123 tests green |
| 5 | Dashboards (3 roles), Daily Cash Tally, P&L, Balance Sheet, Cash Flow | ✅ done, 144 tests green |
| 6 | Approvals, Financial periods, Audit log API + UI | ✅ done, 172 tests green |
| 7 | Excel/PDF export, import, notifications, Cash/Bank Book, Party Ledger, Charges UI, Settlements & Reconciliation UI | ✅ done, 196 tests green |
| 8 | Settings, code-splitting, virtualisation, motion, print, responsive & dark-mode pass | ✅ done, 208 tests green |
| 9 | Master-data creation: party, bank, bank account, cash drawer, user | ✅ done, 211 tests green |
| 10 | Master-data maintenance: edit everything, user lifecycle, expense & income heads | ✅ done, 220 tests green |
| 11 | Operable workflows: income, adjustments, savings, settlements, charge rules | ✅ done, 220 tests green |
| 12 | Roles management, frontend test suite, create-shape contract test | ✅ done, 223 API + 16 web tests green |
| 13 | Test sweep over the money-critical forms | ✅ done, 223 API + 48 web tests green |

Testing runs alongside, not after — Vitest + `mongodb-memory-server` (replica set mode).
The mandatory suite before Phase 3 is considered done:

- Bank A ₹1,00,000 → Bank B: A is `-100,000`, B is `+100,000`, `Σ` system delta = `0`
- Payment In/Out produce correctly-signed party balances
- Reversal restores the pre-transaction balance and leaves the original visible
- Branch admin queries cannot return another branch's rows
- A permission-less user is refused at the route guard
- Approval thresholds route to the correct approver tier
- A failed step mid-transfer leaves **zero** ledger entries behind

---

## 11. Migration from the AMIRI workbook

The spreadsheet's concepts map onto the model as follows. The importer validates,
previews, and reports duplicates — it never inserts invalid rows.

| Sheet | Becomes |
|-------|---------|
| Settings | `Branch`, `SystemSetting`, `ChargeRule` |
| Daily Profit & Cash | `DailyCashTally` + the P&L engine (kept strictly separate) |
| Party Ledger | `LedgerEntry` where `ledgerAccount.kind = PARTY` |
| Expenses | `Expense` discriminator + `ExpenseCategory` (incl. Panel, Domain, Ram Ji) |
| Party Summary | derived aggregation — not a stored table |
| Dashboard | derived aggregation — not a stored table |

Opening balances import as a dated `Adjustment` transaction posting against `EQUITY`, so
even day-zero figures are double-entry and auditable rather than magic numbers.

---

## 12. Phase 7 notes

### 12.1 Export is one spec, three renderers

`ExportSpec<T>` describes columns, rows, provenance and a summary block once; CSV, XLSX
and PDF are renderings of it. Three separate exporters would have drifted — a column added
to the Excel version and forgotten in the PDF is the normal outcome, and the two files then
disagree about what the report contains while both claim the same name.

Money crosses the boundary as **rupees**, not paise. Inside the system an amount is an
integer number of paise and nothing divides by 100; an exported file is read by a
spreadsheet, and `12510100` in a currency column is a wrong number rather than a precise
one. The conversion happens once, in the exporter, at the edge.

CSV fields beginning `= + - @` tab or CR are prefixed with a quote. A party named
`=cmd|'/c calc'!A1` is a formula the moment Excel opens the file, and the export is the
one place where the system hands its data to an interpreter it does not control.

### 12.2 The audit export carries the screen's filters

`/export/audit` accepts `action`, `entity`, `failuresOnly` and `q`, and prints them in the
provenance block. An export button that dropped the active filter would hand the operator a
different report under the same name: they narrow to failed sign-ins, download it, and get
the whole trail back.

The search clause needs care. It rewrites `filter.$or`, which is also where branch scoping
lives, so the scope clause is nested under `$and` rather than replaced — overwriting it
would export every branch's trail to a branch-scoped user. The list route had the same
shape already; the export now matches it.

### 12.3 Import is two calls, and the first one writes nothing

`preview` validates every row and reports what would happen. `commit` re-validates and
writes only what passes. There is deliberately no single-shot import: an operator who has
not seen the validation output has no way to know what a 500-row file is about to do to
their party master.

Rows commit **individually**, not in one Mongo transaction. 500 parties in a single
transaction would exceed the 16MB oplog limit and time out. That means a partial import is
possible, which is exactly why the preview exists and why the result screen reports
`imported` against `valid` rather than declaring success.

Each party is created through the real `parties.createParty`, so it gets a ledger account
and a posted opening balance. Bulk-inserting party documents would be far faster and would
leave every one of them without a ledger account — unusable, and the books would not tie.

Duplicates are **detected, never overwritten**. A repeated party code might be a genuine
re-import or a data-entry slip, and only the operator knows which.

### 12.4 Notifications are pointers, not records

A notification says "the Kankarbagh drawer came up ₹20,000 short"; the tally, the ledger and
the audit row are the record. That is what makes the 90-day TTL index safe — expiry loses a
pointer, never evidence.

They are sent **after** commit and swallow their own errors. A payment must never fail
because a courtesy message could not be delivered, and a notification sent inside the
transaction would announce something that then rolled back.

### 12.5 Reconciliation reads were not branch-scoped

Found while building the UI. `getSummary`, `getLines`, `importStatement`, `setLineStatus`
and `complete` each took a reconciliation id and no scope filter, so any holder of
`finance.bank.reconcile` — which every BRANCH_ADMIN and ACCOUNTANT has — could read, match
and close another branch's reconciliation given an id. Ids travel: they appear in URLs,
exports and audit rows.

All six now load through `loadScoped(id, scopeFilter)`, which puts the filter in the
**query** rather than trusting the caller to check afterwards (§3). A statement line carries
no branch of its own, so it is scoped through its parent reconciliation. The failure is
`NotFound`, not `Forbidden` — confirming that an id exists but belongs to someone else is
itself a disclosure.

`GET /reconciliation` was also missing entirely, which is why the gap survived: with no list
endpoint nothing had ever fetched a reconciliation except by an id it had just created.

### 12.6 One ledger book, three sidebar entries

Cash Book, Bank Book and Party Ledger are the same statement over a different account kind.
The ledger does not distinguish between them, so neither does the implementation — three
copies would drift, and the difference between them would eventually be a bug rather than a
design.

### 12.7 The charges screen computes nothing

`/charges/preview` runs the same code that posts the charge. Re-implementing tiered lookup,
floors and ceilings in the browser would give an operator a figure that could differ from
the one that actually posts — the specific failure the screen exists to prevent.

---

## 13. Phase 8 notes

### 13.1 The fiscal year is not a preference

`fiscalStartMonth` decides which fiscal year every transaction belongs to, and therefore
its voucher number, which period locks it, and which year-to-date column it lands in.
Changing it once entries exist would silently reassign posted history: vouchers collide, a
closed period stops covering the transactions it closed over, and last year's P&L quietly
changes.

So it is editable exactly until the first ledger entry and refused with a reason after
that. The refusal is a `BadRequestError` on the field, and `fiscalStartMonthEditable` plus
`fiscalLockReason` come back on the GET so the screen states *why* rather than rendering a
disabled control that looks like a bug.

Every other field stays editable while the year is locked — the guard compares the
submitted month against the stored one and only fires on an actual change.

### 13.2 The organisation name had two sources of truth

`exportMeta` printed `env.ORG_NAME` on every export. Once the name became editable in
Settings, an export would have carried a different name from the one on screen — a
discrepancy in the single field whose entire job is provenance (§54).

`exportMeta` is now async and reads the stored profile, cached for a minute and
invalidated on save so the next export is correct immediately. `ORG_NAME` remains the
fallback: the default profile *is* `env.ORG_NAME`, so an installation that never opens
Settings behaves exactly as it did before the screen existed. Defaulting to a new literal
would have silently renamed every report the day this shipped.

The cache is module state shared by every test in the process, so the test setup clears it
per file — otherwise a suite that renames the organisation leaves the next suite's exports
printing a name its own fresh database has never heard of.

### 13.3 A stale `vite.config.js` was overriding the real config

The web build ran `tsc -b --noEmit false`, which emitted compiled output *next to every
source file* — 74 `.js` files inside `src/`, plus a `vite.config.js` at the app root.

Vite resolves `vite.config.js` before `vite.config.ts`. So the build had been running
against a months-old compiled snapshot of the config, and every edit to `vite.config.ts`
did nothing. This was invisible because the stale config was a *valid older version* of
the real one: builds succeeded, chunks were produced, nothing errored.

The build is now `tsc --noEmit && vite build` — type-check without emitting, and let vite
do the compiling. `.gitignore` covers both `apps/web/src/**/*.js` and the config, so a
stray artefact cannot come back and shadow the source silently.

The general lesson: a compiled artefact beside its source is not merely untidy. When the
resolution order favours it, it wins.

### 13.4 `manualChunks` made the bundle worse

The login page was downloading 384 kB of Recharts. The cause was `manualChunks: { charts:
["recharts"] }`: naming the package created the chunk, and `clsx` — used by Recharts and by
every `cn()` call in the shell — was placed *inside* it. The entry then statically imported
one 500-byte helper from a 384 kB chunk, and `index.html` preloaded the lot.

Two fixes, both needed. Routes are `React.lazy`, including the Dashboard: it is the first
screen after sign-in, but it renders charts, and importing it statically kept Recharts in
the initial graph regardless. And `clsx`, `tailwind-merge` and `class-variance-authority`
are pinned to a chunk the shell owns, so nothing can place them somewhere heavy.

    first load   1064 kB → 660 kB      (Recharts entirely on demand)
    chunks       1       → 52          (one per route)

`zod`, `react-hook-form` and `@tanstack/react-query` were tried as separate chunks and
rollup merged each one straight back into the entry: `@amiri/shared` re-exports the Zod
schemas and the auth provider needs the query client, so they are in the shell's critical
path. Splitting them means splitting the shared barrel so type-only consumers stop pulling
the runtime schemas in. The config says so rather than keeping an entry that silently does
nothing.

### 13.5 Virtualisation, in exactly two places

Every table that talks to a list endpoint asks for 25–50 rows and pages on the server.
Virtualising those is complexity with no payoff. Two lists are genuinely unbounded, and
both are reports whose purpose is completeness: the **trial balance** (every account in the
chart of accounts) and **reconciliation lines** (up to 2,000 statement lines plus every
unmatched ledger entry in the window).

The markup stays a real `<table>` — the rendered window sits between two spacer rows whose
heights stand in for what is scrolled past, so column alignment, header association and
text selection survive. The `position: absolute` approach loses all three, and a ledger
whose columns do not line up is worse than a slow one.

Two traps found while building it. `Table` wraps its child in `overflow-x-auto`, and CSS
promotes that to `overflow: auto` on both axes — nested inside the scroller that made *two*
scroll containers, with the virtualiser measuring the outer one while the inner one moved,
so the window never updated. Those tables now pass `wrapperClassName="overflow-visible"`.
And a windowed table prints only the drawn rows, so the screens carry `.print-only` text
saying so and pointing at the export, rather than handing over a subset that looks
complete.

### 13.6 Motion that survives `prefers-reduced-motion`

`index.css` clamps CSS transitions under `prefers-reduced-motion`, but framer-motion
animates through the Web Animations API and inline styles, which that rule never touches. A
user who asked for stillness was getting half of it. `MotionConfig reducedMotion="user"`
covers the other half.

The library is used through `LazyMotion` with the `m` component, in `strict` mode. A plain
`motion.div` pulls the entire feature set into whichever chunk touches it — 381 kB, which is
how it reached the login page — and `strict` turns leaving one behind into an error rather
than a silent regression.

`ValueChange` deliberately does **not** count up. A balance rolling from ₹0 to ₹9,50,000 is
unreadable in flight and displays amounts that were never true; on a financial screen that
is a lie with an easing curve. It flashes the container instead, and the figure shown is
only ever the correct one.

---

## 14. Phase 9 notes

### 14.1 Four screens could not create anything

`Add bank`, `New account`, `New party` and `Invite user` were rendered permanently
disabled. Every corresponding write endpoint existed and was covered by tests — the seed
used all of them — so the system was fully functional through the API and could not
onboard a customer, a bank or a colleague through its own UI.

The gap survived eight phases because nothing pointed at it: the buttons were present, the
lists were populated by the seed, and no test exercises the browser. A disabled control
looks deliberate.

### 14.2 The create endpoints answered in a different shape from the list endpoints

Found immediately on wiring the forms up: `POST /parties` returned the raw Mongoose
document while `GET /parties` returned a `PartySummary`. So the success toast read
`party.balance` and got `undefined`, and the user handover screen read `user.role.label`
and crashed.

This is worse than a cosmetic inconsistency. The missing fields were exactly the ones a
caller wants back after a create — the *posted opening balance* for a party or an account —
and `POST /bank-accounts` returned the **unmasked account number** regardless of whether
the caller held `finance.bank.viewFull`, because masking happened in the list mapper only.

Every create route now re-reads through a `get…Summary` helper that shares the list's
mapper. Three tests lock the contract, including the masking one.

The general shape: when a POST and a GET describe the same resource differently, the
difference is not a detail the client can paper over — it is a second, undocumented
representation, and the field it omits is usually the one that matters.

### 14.3 The opening-balance sign is asked as a question

A party's opening balance is signed: positive means they owe us (LENA), negative means we
owe them (DENA). Asking an operator to type `-88500` for a supplier is how opening balances
end up inverted — and an inverted opening balance **still ties in the trial balance**, so
nothing downstream ever catches it.

The form takes an unsigned amount plus a two-button choice in words, and states the result
back — "This will post ₹88,500.00 as DENA HAI — we owe them, against equity, dated today" —
before submission. The sign is applied at submit.

### 14.4 The temporary password is generated in the browser and shown once

From `crypto.getRandomValues`, never `Math.random()` — a predictable credential for a
finance system is a real weakness. One character is drawn from each required class before
the remainder, then the whole string is shuffled, so it cannot fail the complexity rule by
chance and leave an administrator working around a validation error.

It is displayed once, after creation, for handover. The server stores only an argon2id hash
and has nothing to show later, so the dialog says so and points at reset rather than
implying the value can be recovered.

### 14.5 Branch assignment is stated as the security boundary it is

Every query a user makes is filtered by `{ branchId: { $in: branchIds } }`. An empty list
therefore means they can sign in and see nothing — correct fail-closed behaviour, and
baffling if the form does not say so. The invite form warns explicitly on an empty
selection, and for an unscoped role it replaces the checkboxes with an explanation rather
than showing controls that the server ignores.

---

## 15. Phase 10 notes

### 15.1 `api.patch` appeared nowhere in the web application

Not once. Every update endpoint — party, bank account, branch, role, user — was
unreachable, and three of them are not conveniences:

- **`POST /users/:id/status`.** An employee leaves and there is no way to revoke their
  access.
- **`POST /users/:id/reset-password`.** Somebody is locked out and there is no way to let
  them back in.
- **`PATCH /users/:id`.** A role granted in error cannot be corrected.

Same class of gap as phase 9 and equally invisible: nothing is disabled or greyed out, the
actions simply were never built, and the seed had already put plausible data on every
screen.

### 15.2 Two update schemas existed with nothing behind them

`updateBankSchema` and `updateCashAccountSchema` were exported from `@amiri/shared` with no
service and no route. A published contract that nothing implements is worse than an absent
one — it reads as done. Both now have a service, a route and tests.

### 15.3 A rename has to reach the ledger account

A bank's ledger accounts carry the institution's name in their own label
(`HDFC ••7890 — Current`). Rename the bank and, without propagation, the trial balance and
every export keep printing the old name indefinitely.

The first version of `updateBank` rebuilt that label as `shortName — accountName` and
silently **dropped the masked digits**, so an account whose bank had ever been renamed
printed differently from one that had not. The rename now rebuilds the label with exactly
the format `createBankAccount` uses. Two tests cover it, and the live check asserts the
`••` is still there afterwards.

### 15.4 The user create response regressed in phase 9 and no test caught it

Phase 9 changed `POST /users` to re-read through `service.getById` so the response would
carry the populated role and branches. `getById` returns a **lean Mongoose document** — so
the response had `_id` rather than `id`, and `roleId`/`branchIds` rather than
`role`/`branches`.

The effect: a client that created a user then had no id to address them with. Every
follow-up call went to `/users/undefined` and returned 422 on the id parameter. It only
surfaced during the live run, because the phase 9 contract tests covered parties and
banking accounts and the user path had none.

There is now `getSummary`, sharing the list's mapper, used by create, update and status —
and a test that asserts `id` is present and `_id` is not.

### 15.5 The client-side gate has to match the server's rule

Both status dialogs enabled their confirm button once the reason reached 3 characters. The
shared `reason` validator requires **10**. So the UI said the form was ready, the server
returned 422, and the operator had no way to know what was wrong.

Both now require 10, and count down the remaining characters. The general point: a
client-side validation threshold that is looser than the server's is not a lenient UI, it
is a UI that lies.

### 15.6 Expense and income heads had no screen at all

Per §4.1 an expense head **is a ledger account**. `POST /expenses/categories` and
`POST /income/heads` existed, but the web application only ever read those lists to fill a
dropdown — so a business whose expenses did not match the seeded heads had to file
everything under whichever seeded head was closest, quietly corrupting every P&L that
followed.

The new screen lists both kinds with **the balance posted under each**, which is the only
question anybody asks of this list. The list endpoints were extended to carry status,
description, parent and balance, and to accept `includeInactive` — defaulting to active
only, because their other consumer is the transaction form's dropdown and a retired head
must not be selectable for a new transaction.

---

## 16. Phase 11 notes

### 16.1 Income could not be recorded

`POST /income` existed, `createIncomeSchema` existed, the Income screen listed income
transactions — and there was no way to create one. The transaction form had four modes and
income was not among them.

A finance system in which income cannot be entered is not a small omission. It survived
because the screen looked complete: a title, a description explaining how income differs
from a Payment In, an empty-state promising that "commission, interest and service income
will appear here". Everything except the ability to put one there.

The mode carries the §17 distinction in its own description, because it is the reason the
two are separate: a Payment In settles what a party already owed and moves no needle on
profit; income is money **earned** and lands in the P&L. Recording commission as a Payment
In leaves the party with a phantom credit and understates profit by the same amount.

Verified live: recording ₹45,000 of commission moved `totalIncome` by exactly ₹45,000 and
the trial balance stayed at ₹0.00.

### 16.2 The adjustment screen the rest of the application already pointed at

Phase 10's party edit form tells the operator, in as many words, that an opening balance is
corrected with an Adjustment. `POST /adjustments` existed. The screen did not. The
application was directing users to a feature it did not have.

The form applies the §62 default without being asked: the counter side goes to **suspense**
unless a real account is named, so an unexplained difference stays visible on the balance
sheet rather than being tidied into an expense head. It also asks the sign as a question in
words rather than expecting a typed minus — the same reasoning as the party opening balance
in §14.3, and for the same reason: a sign error here doubles the mistake instead of fixing
it.

Two bugs found on the live run. The form defaulted `adjustmentType` to `CORRECTION`, which
is not a member of the enum — the value is `BALANCE_CORRECTION`. And the party dropdown
offered every party in the organisation while the server refuses a cross-branch reference,
so an operator could fill the entire form and be told at submit that the party "belongs to a
different branch", with no indication of which parties would have been acceptable. Both
forms now scope the list to the chosen branch.

### 16.3 Create endpoints returning raw documents — the fifth and sixth instance

Phase 9 found it on parties and bank accounts. Phase 10 found it on users. This phase found
it again on savings accounts (`balance` was `undefined`, rendering as `₹NaN`) and on charge
rules (`sampleOn100k` was `undefined`, likewise).

That is six occurrences of one mistake across four phases, and the shape is always the same:
a create route returns `Model.create(...)`, the list route returns a mapped summary, and the
field that only exists on the summary is invariably **the one the caller wanted back** — the
posted opening balance, the worked example, the populated role.

The rule, now applied everywhere: **a create or update route answers in the same shape its
list route does**, by calling a shared mapper. The remaining risk is that nothing enforces
it; a route can still be added tomorrow that returns a document. Tests cover the six known
cases, which is not the same as covering the pattern.

### 16.4 Savings is a liability, and the forms say so

A member's balance is money the business **owes them**. The deposit form says an increase in
what it owes; the withdrawal form says a decrease. Left as "balance ₹12,780" on a savings
screen, an operator reads it as an asset.

Withdrawal is checked client-side as well as on the server — not because the server needs
help, but because an operator should learn the account is short **before** counting out
cash, not after the request is refused.

### 16.5 A settlement's two actions are genuinely two actions

Creating a settlement records an agreed amount and posts nothing. Executing it posts a real
payment against that agreement. Keeping them separate is what makes partial settlement
legible — a ₹77,000 agreement paid ₹40,000 shows PARTIAL with ₹37,000 outstanding, rather
than a status flipping from pending to done with nothing in between.

Both server-side limits held on the live run: a settlement cannot be agreed for more than
the party has outstanding, and it cannot be overpaid. The execute dialog warns before
submitting in the second case, since the operator has the number in front of them.

---

## 17. Phase 12 notes

### 17.1 The application had no frontend tests at all

Two hundred and twenty tests, every one of them against the API. Roughly twenty forms built
across phases 9 to 11, verified by nothing but a human driving the application by hand.

That is where every defect of the last three phases lived. The API suite is thorough about
the ledger; it says nothing about whether a form sends what the ledger expects, and that
boundary is precisely where a form defaulting to `CORRECTION` instead of `BALANCE_CORRECTION`
lives, or a dropdown offering rows the server refuses, or a success toast rendering `₹NaN`.

`apps/web` now has vitest + Testing Library. The first tests cover the two places where a
bug is **silent** rather than loud:

- **`<Money>`** — every amount on every screen goes through it, so its failure modes are
  systemic. Notably that `null` must not render as `₹0.00`: a missing figure and a zero
  figure mean different things and an operator cannot tell them apart after the fact.
- **The signed forms** — a party opening balance and a balance adjustment. An inverted
  opening balance leaves the trial balance tying perfectly. The books balance; they are
  simply about a different reality. Nothing downstream catches it, which is exactly why it
  is worth a test that asserts on the payload rather than the pixels.

### 17.2 The first test run found a shipped bug

The adjustment form could not submit. At all.

`reason` was held in React state and merged into the payload inside the submit handler —
but the shared schema validates it, so zod ran against the empty default on every attempt.
Because nothing was registered under that name, React Hook Form had nowhere to render the
error. The button was enabled, the click did nothing, and the form failed in silence.

Phase 11's "live verification" posted to `/adjustments` with curl and never touched the
form, so it passed. Which is the honest lesson: **exercising an endpoint is not exercising
the screen that calls it**, and a verification pass that only does the former will keep
reporting success while the UI is unusable.

`reason` is now a registered field. The other three status dialogs use plain state with a
direct `api.post` and no resolver, so they were never affected — checked rather than
assumed.

### 17.3 Test fixtures have to satisfy the real contract

The first component test failed with a form that silently refused to submit. The cause was
a fixture using `"b1"` as a branch id: every id crossing the wire is validated against an
ObjectId pattern, so the payload was rejected before it was built.

Fixtures now use real 24-character hex ids. Not pedantry — the contract genuinely rejects
the alternative, and a fixture that cannot pass validation tests nothing.

### 17.4 `vi.mock` cannot close over a helper's arguments

A `mockAuth(overrides)` helper in the shared harness looked reasonable and threw
`overrides is not defined` at runtime, because `vi.mock` is hoisted above every other
statement in its module. Auth is now mocked per test file at module scope, which is also
more honest: the identity a test assumes is visible in the test rather than buried in a
helper.

### 17.5 The create-shape invariant is now enforced, not just fixed

Six occurrences across four phases of one mistake — a create route returning the raw
document while its list route returns a mapped summary. Each was fixed individually and
covered individually, which is not the same as covering the pattern.

`contract.test.ts` walks every create route that has a list counterpart and asserts three
things directly: that the response carries the fields its list exposes, that it never leaks
`_id`, `__v` or `passwordHash`, and that every money field is an **integer** — not a float,
not a string. Failures are collected and reported together, so one run names every route
that regressed rather than the alphabetically earliest.

### 17.6 Roles were the last unreachable write surface

`POST /roles`, `PATCH /roles/:id` and `DELETE /roles/:id` existed with no UI. The screen now
edits permissions grouped by area, and surfaces the two things the server enforces that an
administrator would otherwise discover the hard way: saving **signs out every holder** (the
dialog says how many, before the save), and the super-admin role's own permissions cannot be
edited — removing `roles.manage` from it would leave nobody able to grant it back.

---

## 18. Phase 13 notes

Twenty-one of twenty-three forms had no test. Testing the first two in phase 12 found a
shipped bug immediately, so this phase swept the ones where a defect costs money: the
transaction form, savings, settlements, accounts, charges, and password generation.

It found three more.

### 18.1 The transaction form's labels were bound to nothing

`<Label>` with no `htmlFor`, and Radix's select trigger with no accessible name. On screen
it looked correct. To a screen reader the amount field announced "edit text, blank" and the
label announced nothing at all — on the one form through which every rupee in the system
moves.

The test failed with Testing Library's own diagnosis: *"Found a label with the text of
/^amount/i, however no form control was found associated to that label."* That message is
worth more than the assertion; querying by label is querying the way a screen reader reads,
which is why the failure is detected at all.

`Field` now generates an id, binds the label to it, and passes it down through a render
prop rather than assuming a shape. Eighteen fields, including the five account pickers,
inherited the fix.

### 18.2 A value computed in the submit handler is a value zod never validated

The charge rule form could not submit. Same silent failure as the adjustment form in phase
12, same cause in a different shape:

    const submit = (values) => {
      const payload = { ...values };
      payload.rateBps = toBps(ratePercent);   // ← after handleSubmit already validated
      mutation.mutate(payload);
    };

`handleSubmit` validates form state, which held `rateBps: undefined`. The schema's
"a percentage rule needs a rate" refinement fails on a path with no registered field, so
there is nowhere to render the error. Button enabled, click does nothing, no message.

The rule, now applied in both forms: **the form's values must always equal what will be
sent.** Conversions happen on change, into form state, not in the submit handler. That is
the only arrangement in which validating the form means validating the payload.

Worth noting how similar these two are while looking completely different — one held a
field in `useState`, the other computed a field from `useState`. Both amount to validating
an object that is not the one submitted.

### 18.3 A cross-tab validation error rendered on a hidden tab

The adjustment form targets either a party or an account, and the schema requires exactly
one. Pick a party, switch to the account tab, pick an account: both are set, validation
fails on `partyId` — whose field is now on the tab you are not looking at. The form refuses
to submit and shows nothing.

Switching target now clears the other side. That costs a re-selection when someone
toggles back and forth, which is the right trade against a form that silently carries a
value the operator can no longer see.

### 18.4 What the tests pin down

Beyond the regressions, the assertions worth having are the ones about money crossing the
boundary:

- the amount leaves the browser as **integer paise** (12510100), not a string the server
  re-parses with its own implementation of Indian digit grouping, and not a float;
- `1.75%` becomes exactly **175** basis points — the IEEE-754 product is
  174.99999999999997, and it is rounded the instant it is produced;
- a bank account may open negative and a cash drawer may not;
- a savings withdrawal is refused **before** cash is counted, not after the server says no;
- a settlement shows what is outstanding rather than what was agreed, so it cannot be paid
  twice;
- the generated password satisfies the server's own schema on a hundred consecutive draws,
  and omits `O 0 l I 1` — these credentials get read aloud down a phone.

---

## 19. `<Button asChild>` crashed every route that used it

Reported from the browser, after signing in: the dashboard threw

    Slot failed to slot onto its children. Expected a single React element child or `Slottable`.

`Button` renders into Radix's `Slot` when `asChild` is set, and it rendered two children:

    {loading ? <Loader2 /> : null}
    {children}

`Slot` requires exactly one. It throws even when `loading` is false, because the `null`
still counts as a child. So every `<Button asChild>` in the application took down its route
— the dashboard's "Open credit report" link, two on the Khata screen, one on the 404 page.

The fix is `Slottable`, which tells `Slot` which of several children to merge into. The
spinner survives, and the slotted child works.

### Why it survived so long

Every phase's verification checked screens by requesting a route from the dev server and
asserting HTTP 200. **That only proves the HTML shell was served.** Vite returns the same
`<div id="root">` for every path whether the application works or not; no React executes.
A render-time crash is completely invisible to it, and the 200s kept coming for phases.

The lesson generalises past this bug: a check has to exercise the layer the defect lives
in. HTTP 200 tests the server. Rendering tests the component. They are not substitutes, and
one reported success for months while the other would have failed immediately.

`smoke.test.tsx` now mounts all twenty-three screens — with empty data and with populated
data — and asserts only that they render. It is a low bar, deliberately; it is the bar that
was not being cleared. `button.test.tsx` covers the `asChild` construction directly.

Both were checked against the unfixed code before being kept: reverting `Slottable` makes
them fail with the original error. A regression test that does not fail on the bug it names
is decoration.
