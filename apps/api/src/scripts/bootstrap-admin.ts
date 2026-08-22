import { createInterface } from "node:readline";
import { DEFAULT_ROLE_PERMISSIONS, SYSTEM_ROLES, password as passwordPolicy } from "@amiri/shared";
import { logger } from "../config/logger.js";
import { connectDatabase, disconnectDatabase } from "../config/db.js";
import { Branch, Role, User } from "../models/index.js";
import { ensureSystemAccounts } from "../services/ledger.service.js";

/**
 * Production bootstrap — the first sign-in on a fresh install.
 *
 * `seed.ts` deliberately refuses to run under NODE_ENV=production because it creates four
 * accounts with a password that is written down in this repository. That is the right
 * call, and it leaves a real gap: a freshly deployed instance has no user at all and no
 * way in. This script is that missing step, and nothing more.
 *
 * What it creates:
 *   • the four system roles, with their default permissions
 *   • ONE branch (default 101 / Head Office), if none exists
 *   • the system ledger accounts (EQUITY-OPENING and friends)
 *   • ONE super admin, with a password YOU supply and this process never stores
 *
 * What it deliberately does not create: sample banks, parties, transactions or any second
 * user. Those belong to the real books, entered through the app.
 *
 *   docker compose -f docker-compose.prod.yml run --rm --no-deps api \
 *       node dist/scripts/bootstrap-admin.js --email you@example.com --name "Your Name"
 *
 * The password is read from the terminal, or from ADMIN_PASSWORD when there is no TTY.
 * It is never passed as an argument: argv is visible in `ps` to every user on the host.
 */

const ROLE_META: Record<string, { label: string; description: string }> = {
  SUPER_ADMIN: { label: "Super Admin", description: "Full access across every branch." },
  BRANCH_ADMIN: { label: "Branch Admin", description: "Full control of their assigned branches." },
  ACCOUNTANT: { label: "Accountant", description: "Day-to-day finance operations, without approval rights." },
  VIEWER: { label: "Viewer", description: "Read-only access for auditors and owners." },
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * Read a password without echoing it.
 *
 * Node has no built-in hidden prompt. Muting the output stream is the standard approach:
 * readline still receives the keystrokes, the terminal simply never renders them.
 */
async function promptHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const fromEnv = process.env.ADMIN_PASSWORD;
    if (!fromEnv) {
      throw new Error(
        "No terminal available. Either run with `-it`, or pass the password as the " +
          "ADMIN_PASSWORD environment variable.",
      );
    }
    return fromEnv;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const output = rl as unknown as { output: NodeJS.WriteStream; _writeToOutput: (s: string) => void };
  const write = output._writeToOutput.bind(rl);

  process.stdout.write(prompt);
  output._writeToOutput = (s: string) => {
    // The final newline still has to reach the terminal, or the cursor never leaves the
    // prompt line and the next prompt overwrites this one.
    if (s.includes("\n")) write("\n");
  };

  try {
    return await new Promise<string>((resolve) => rl.question("", resolve));
  } finally {
    rl.close();
  }
}

async function ensureRoles(): Promise<Map<string, string>> {
  const roles = new Map<string, string>();

  for (const [name, permissions] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    const meta = ROLE_META[name] ?? { label: name, description: "" };
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

  return roles;
}

/**
 * One branch, and only if the install has none.
 *
 * A super admin's access is unscoped, so strictly they need no branch — but every posting
 * is branch-scoped, and an install with zero branches gives the UI nothing to select.
 * An existing branch is always preferred: re-running this must never quietly add a
 * duplicate Head Office alongside the real one.
 */
async function ensureBranch(code: string, name: string): Promise<{ id: string; created: boolean }> {
  const existing = await Branch.findOne({ status: "ACTIVE" }).sort({ createdAt: 1 }).lean();
  if (existing) return { id: String(existing._id), created: false };

  const branch = await Branch.create({
    code,
    name,
    status: "ACTIVE",
    // April, because the fiscal year in this system runs April–March.
    booksFromDate: new Date(Date.UTC(new Date().getUTCFullYear(), 3, 1)),
  });
  return { id: String(branch._id), created: true };
}

async function main(): Promise<void> {
  const email = (arg("email") ?? process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
  const name = arg("name") ?? process.env.ADMIN_NAME ?? "Super Admin";
  const branchCode = arg("branch-code") ?? "101";
  const branchName = arg("branch-name") ?? "Head Office";

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    logger.fatal("Pass a valid address: --email you@example.com");
    process.exit(1);
  }

  await connectDatabase();

  // Refuse rather than overwrite. If a super admin already exists, this is a second run
  // against a live install, and creating another one — or worse, resetting the first
  // one's password — is not something a bootstrap script should decide to do. User
  // management lives in the app.
  const roles = await ensureRoles();
  const superAdminRoleId = roles.get(SYSTEM_ROLES.SUPER_ADMIN)!;
  const existingAdmin = await User.findOne({ roleId: superAdminRoleId, status: "ACTIVE" }).lean();
  if (existingAdmin) {
    logger.fatal(
      { existing: existingAdmin.email },
      "A super admin already exists. Add further users from inside the app, or reset the " +
        "password there — this script only creates the FIRST account.",
    );
    await disconnectDatabase();
    process.exit(1);
  }

  const plain = await promptHidden(`Password for ${email}: `);
  const confirm = process.stdin.isTTY ? await promptHidden("Confirm password: ") : plain;

  if (plain !== confirm) {
    logger.fatal("The passwords do not match.");
    await disconnectDatabase();
    process.exit(1);
  }

  // The same policy the app enforces on every password change, imported rather than
  // restated — a bootstrap account that could not be set through the UI would be a
  // strange thing to allow through the back door.
  const checked = passwordPolicy.safeParse(plain);
  if (!checked.success) {
    logger.fatal({ issues: checked.error.issues.map((i) => i.message) }, "Password rejected");
    await disconnectDatabase();
    process.exit(1);
  }

  const branch = await ensureBranch(branchCode, branchName);
  await ensureSystemAccounts();

  const user = new User({
    name,
    email,
    roleId: superAdminRoleId,
    branchIds: [branch.id],
    defaultBranchId: branch.id,
    designation: "Proprietor",
    status: "ACTIVE",
    // False on purpose: they chose this password a moment ago at this prompt. Forcing an
    // immediate change would only train the habit of picking a throwaway first.
    mustChangePassword: false,
    passwordHash: "placeholder",
  });
  await user.setPassword(plain);
  user.mustChangePassword = false;
  await user.save();

  logger.info(
    {
      roles: roles.size,
      branch: branch.created ? `${branchCode} ${branchName} (created)` : "existing branch reused",
      admin: email,
    },
    "bootstrap complete",
  );

  await disconnectDatabase();
  process.stdout.write(`\n  Sign in as ${email}\n\n`);
}

main().catch(async (err: unknown) => {
  logger.fatal({ err }, "bootstrap-admin failed");
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
