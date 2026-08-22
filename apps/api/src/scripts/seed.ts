import {
  DEFAULT_ROLE_PERMISSIONS,
  SYSTEM_ROLES,
  formatINR,
  parseAmount,
} from "@amiri/shared";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { connectDatabase, disconnectDatabase } from "../config/db.js";
import { Bank, BankAccount, Branch, CashAccount, Party, Role, User } from "../models/index.js";
import { ensureSystemAccounts, trialBalance } from "../services/ledger.service.js";
import * as banking from "../modules/banking/banking.service.js";
import * as parties from "../modules/parties/party.service.js";
import type { AuditContext } from "../services/audit.service.js";
import { seedTransactions } from "./seed-transactions.js";

/**
 * Development seed (§60).
 *
 * Idempotent: every write is keyed on a natural identifier, so running it twice does not
 * duplicate data and does not reset a password you have since changed.
 *
 * Sample financial data is created THROUGH THE REAL SERVICES, never by inserting
 * documents directly. That matters: opening balances go through the posting engine, so
 * the seeded books are genuine double-entry and the trial balance ties. Seed data written
 * straight into collections would not balance, and would hide exactly the class of bug a
 * seed exists to surface.
 */

const BRANCHES = [
  { code: "101", name: "Head Office", city: "Patna", state: "Bihar" },
  { code: "102", name: "Kankarbagh Branch", city: "Patna", state: "Bihar" },
  { code: "105", name: "Boring Road Branch", city: "Patna", state: "Bihar" },
  { code: "107", name: "Gaya Branch", city: "Gaya", state: "Bihar" },
  { code: "108", name: "Muzaffarpur Branch", city: "Muzaffarpur", state: "Bihar" },
  { code: "111", name: "Ranchi Branch", city: "Ranchi", state: "Jharkhand" },
];

const ROLE_META = {
  SUPER_ADMIN: { label: "Super Admin", description: "Full access across every branch." },
  BRANCH_ADMIN: { label: "Branch Admin", description: "Full control of their assigned branches." },
  ACCOUNTANT: { label: "Accountant", description: "Day-to-day finance operations, without approval rights." },
  VIEWER: { label: "Viewer", description: "Read-only access for auditors and owners." },
} as const;

const BANKS = [
  { name: "HDFC Bank", shortName: "HDFC", ifscPrefix: "HDFC" },
  { name: "ICICI Bank", shortName: "ICICI", ifscPrefix: "ICIC" },
  { name: "State Bank of India", shortName: "SBI", ifscPrefix: "SBIN" },
  { name: "Axis Bank", shortName: "AXIS", ifscPrefix: "UTIB" },
  { name: "Punjab National Bank", shortName: "PNB", ifscPrefix: "PUNB" },
];

/** Bank accounts, spread across branches so branch isolation is visible in the UI. */
const BANK_ACCOUNTS = [
  { bank: "HDFC Bank", branch: "105", name: "AMIRI Enterprises — Current", number: "50100234567890", ifsc: "HDFC0001234", opening: "12,50,000.00", type: "CURRENT" },
  { bank: "ICICI Bank", branch: "105", name: "AMIRI Enterprises — Settlement", number: "002105001234", ifsc: "ICIC0000021", opening: "4,75,000.00", type: "CURRENT" },
  { bank: "State Bank of India", branch: "107", name: "AMIRI Gaya — Current", number: "38291746501", ifsc: "SBIN0007890", opening: "6,20,000.00", type: "CURRENT" },
  { bank: "Axis Bank", branch: "101", name: "AMIRI Head Office — Current", number: "918020045612345", ifsc: "UTIB0000456", opening: "22,00,000.00", type: "CURRENT" },
  // An overdraft account, so the balance check has something interesting to enforce.
  { bank: "Punjab National Bank", branch: "102", name: "AMIRI Kankarbagh — OD", number: "0123456789012", ifsc: "PUNB0012300", opening: "-1,80,000.00", type: "OD", overdraft: "5,00,000.00" },
];

/** Parties, including the two named in the 19/08/2026 DayBook. */
const PARTIES = [
  { name: "RAMANUJ PUNB", branch: "105", type: "DISTRIBUTOR", mobile: "9876543210", opening: "9,50,000.00", creditLimit: "12,00,000.00", creditDays: 30 },
  { name: "EDDIGO DISTRIBUTOR", branch: "105", type: "DISTRIBUTOR", mobile: "9876501234", opening: "-2,40,000.00", creditLimit: "5,00,000.00", creditDays: 15 },
  { name: "Sharma Traders", branch: "105", type: "CUSTOMER", mobile: "9812345670", opening: "1,25,101.00", creditLimit: "2,00,000.00", creditDays: 30 },
  { name: "Verma Electronics", branch: "105", type: "CUSTOMER", mobile: "9823456701", opening: "48,500.00", creditLimit: "1,00,000.00", creditDays: 15 },
  { name: "Bihar Panel Services", branch: "105", type: "VENDOR", mobile: "9834567012", opening: "-72,000.00", creditLimit: "0", creditDays: 0 },
  { name: "Gaya Wholesale", branch: "107", type: "CUSTOMER", mobile: "9845670123", opening: "3,10,000.00", creditLimit: "4,00,000.00", creditDays: 45 },
  { name: "Ranchi Agency", branch: "111", type: "AGENT", mobile: "9856701234", opening: "0", creditLimit: "1,50,000.00", creditDays: 30 },
];

/**
 * Seed passwords.
 *
 * Weak-but-policy-compliant and identical across installs on purpose: this script refuses
 * to run in production, and every seeded account has `mustChangePassword: true`, so the
 * first real sign-in forces a replacement.
 */
const SEED_PASSWORD = "Amiri@2026";

async function seedRoles() {
  const roles = new Map<string, string>();

  for (const [name, permissions] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    const meta = ROLE_META[name as keyof typeof ROLE_META];
    const role = await Role.findOneAndUpdate(
      { name },
      {
        $set: {
          label: meta.label,
          description: meta.description,
          permissions,
          isUnscoped: name === SYSTEM_ROLES.SUPER_ADMIN,
          isSystem: true,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    roles.set(name, String(role._id));
  }

  logger.info({ count: roles.size }, "roles ready");
  return roles;
}

async function seedBranches() {
  const branches = new Map<string, string>();

  for (const b of BRANCHES) {
    const branch = await Branch.findOneAndUpdate(
      { code: b.code },
      {
        $set: { name: b.name, city: b.city, state: b.state, status: "ACTIVE" },
        $setOnInsert: { code: b.code, booksFromDate: new Date(Date.UTC(2026, 3, 1)) },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    branches.set(b.code, String(branch._id));
  }

  logger.info({ count: branches.size }, "branches ready");
  return branches;
}

async function seedUser(input: {
  name: string;
  email: string;
  roleId: string;
  branchIds: string[];
  designation: string;
}) {
  const existing = await User.findOne({ email: input.email });
  if (existing) {
    // Refresh assignment, but never touch the password — a developer may have changed it
    // and silently resetting it on every seed run is hostile.
    existing.roleId = input.roleId as never;
    existing.branchIds = input.branchIds as never;
    existing.defaultBranchId = (input.branchIds[0] ?? null) as never;
    existing.designation = input.designation;
    existing.status = "ACTIVE";
    await existing.save();
    return existing;
  }

  const user = new User({
    name: input.name,
    email: input.email,
    roleId: input.roleId,
    branchIds: input.branchIds,
    defaultBranchId: input.branchIds[0] ?? null,
    designation: input.designation,
    status: "ACTIVE",
    mustChangePassword: true,
    passwordHash: "placeholder",
  });
  await user.setPassword(SEED_PASSWORD);
  user.mustChangePassword = true;
  await user.save();
  return user;
}

async function seedFinancials(branches: Map<string, string>, ctx: AuditContext) {
  // Equity, suspense, bank charges. `EQUITY-OPENING` must exist before any opening
  // balance can be posted, or the entry would have nothing to balance against.
  await ensureSystemAccounts();

  const bankIds = new Map<string, string>();
  for (const b of BANKS) {
    const existing = await Bank.findOne({ name: b.name }).lean();
    if (existing) {
      bankIds.set(b.name, String(existing._id));
      continue;
    }
    const bank = await banking.createBank({ ...b, status: "ACTIVE" } as never, ctx);
    bankIds.set(b.name, String(bank._id));
  }
  logger.info({ count: bankIds.size }, "banks ready");

  let accountsCreated = 0;
  for (const spec of BANK_ACCOUNTS) {
    const bankId = bankIds.get(spec.bank);
    const branchId = branches.get(spec.branch);
    if (!bankId || !branchId) continue;

    if (await BankAccount.exists({ bankId, accountNumber: spec.number })) continue;

    await banking.createBankAccount(
      {
        bankId,
        branchId,
        accountName: spec.name,
        accountNumber: spec.number,
        ifsc: spec.ifsc,
        accountType: spec.type as never,
        // Parsed to integer paise by the same helper the API uses.
        openingBalance: parseAmount(spec.opening),
        openingDate: new Date(Date.UTC(2026, 3, 1)),
        overdraftLimit: spec.overdraft ? parseAmount(spec.overdraft) : 0,
        lowBalanceThreshold: parseAmount("50,000"),
        status: "ACTIVE",
      } as never,
      ctx,
    );
    accountsCreated += 1;
  }
  logger.info({ created: accountsCreated }, "bank accounts ready");

  let drawersCreated = 0;
  for (const [code, branchId] of branches) {
    if (await CashAccount.exists({ branchId })) continue;
    await banking.createCashAccount(
      {
        branchId,
        name: "Main Counter",
        code: `CASH-${code}`,
        openingBalance: parseAmount("45,000.00"),
        openingDate: new Date(Date.UTC(2026, 3, 1)),
        status: "ACTIVE",
      } as never,
      ctx,
    );
    drawersCreated += 1;
  }
  logger.info({ created: drawersCreated }, "cash drawers ready");

  let partiesCreated = 0;
  for (const spec of PARTIES) {
    const branchId = branches.get(spec.branch);
    if (!branchId) continue;
    if (await Party.exists({ branchId, name: spec.name })) continue;

    await parties.createParty(
      {
        name: spec.name,
        branchId,
        type: spec.type as never,
        mobile: spec.mobile,
        openingBalance: parseAmount(spec.opening),
        openingDate: new Date(Date.UTC(2026, 3, 1)),
        creditLimit: parseAmount(spec.creditLimit),
        creditDays: spec.creditDays,
        status: "ACTIVE",
      } as never,
      ctx,
    );
    partiesCreated += 1;
  }
  logger.info({ created: partiesCreated }, "parties ready");
}

async function main(): Promise<void> {
  if (env.isProd) {
    logger.fatal(
      "The seed script will not run with NODE_ENV=production — it creates accounts with known passwords.",
    );
    process.exit(1);
  }

  await connectDatabase();

  const roles = await seedRoles();
  const branches = await seedBranches();

  const superAdmin = await seedUser({
    name: "Super Admin",
    email: "superadmin@amiri.com",
    roleId: roles.get("SUPER_ADMIN")!,
    // Cosmetic for a SuperAdmin: it only pre-selects a branch in the picker. Their
    // access does not come from this list.
    branchIds: [branches.get("101")!],
    designation: "Proprietor",
  });

  await seedUser({
    name: "Suresh Kumar",
    email: "branchadmin@amiri.co",
    roleId: roles.get("BRANCH_ADMIN")!,
    branchIds: [branches.get("105")!, branches.get("107")!],
    designation: "Branch Manager",
  });

  await seedUser({
    name: "Anita Sharma",
    email: "accountant@amiri.co",
    roleId: roles.get("ACCOUNTANT")!,
    branchIds: [branches.get("105")!],
    designation: "Senior Accountant",
  });

  await seedUser({
    name: "Auditor",
    email: "viewer@amiri.co",
    roleId: roles.get("VIEWER")!,
    branchIds: [...branches.values()],
    designation: "External Auditor",
  });
  logger.info("users ready");

  const ctx: AuditContext = {
    userId: String(superAdmin._id),
    userName: superAdmin.name,
    userEmail: superAdmin.email,
    roleName: "SUPER_ADMIN",
  };

  await seedFinancials(branches, ctx);
  await seedTransactions(branches, ctx);

  const branchAdmin = await User.findOne({ email: "branchadmin@amiri.co" }).select("_id").lean();
  if (branchAdmin) {
    await Branch.updateMany({ code: { $in: ["105", "107"] } }, { $set: { managerId: branchAdmin._id } });
  }

  // Proof, not assertion: the seeded books are read back and shown to tie.
  const tb = await trialBalance();

  /* eslint-disable no-console */
  console.log(`
┌────────────────────────────────────────────────────────────────────────┐
│  AMIRI Finance — seed complete                                         │
├────────────────────────────────────────────────────────────────────────┤
│  Sign in at http://localhost:5173                                      │
│                                                                        │
│  superadmin@amiri.co    ${SEED_PASSWORD}     every branch            │
│  branchadmin@amiri.co   ${SEED_PASSWORD}     branches 105, 107       │
│  accountant@amiri.co    ${SEED_PASSWORD}     branch 105              │
│  viewer@amiri.co        ${SEED_PASSWORD}     read-only               │
│                                                                        │
│  Each account must set a new password on first sign-in.                │
├────────────────────────────────────────────────────────────────────────┤
│  TRIAL BALANCE                                                         │
│    Accounts   ${String(tb.rows.length).padEnd(56)}│
│    Debit      ${formatINR(tb.totalDebit).padEnd(56)}│
│    Credit     ${formatINR(tb.totalCredit).padEnd(56)}│
│    Difference ${(formatINR(tb.difference) + (tb.difference === 0 ? "  ✓ the books tie" : "  ✗ OUT OF BALANCE")).padEnd(56)}│
│                                                                        │
│  Every opening balance above is a real double-entry posting against    │
│  equity — not a number written into a field.                           │
├────────────────────────────────────────────────────────────────────────┤
│  Try this: sign in as the accountant and look for branch 107 or the    │
│  Gaya bank account. They are invisible in every list, filter and       │
│  ledger — the server refuses them, not the UI.                         │
└────────────────────────────────────────────────────────────────────────┘
`);
  /* eslint-enable no-console */

  if (tb.difference !== 0) {
    logger.fatal({ difference: tb.difference }, "seeded ledger does not balance — this is a bug");
    await disconnectDatabase();
    process.exit(1);
  }

  await disconnectDatabase();
  process.exit(0);
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "seed failed");
  process.exit(1);
});
