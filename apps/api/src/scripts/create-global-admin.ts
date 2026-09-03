import { createInterface } from "node:readline";
import {
  ALL_PERMISSIONS,
  isPermission,
  password as passwordPolicy,
  type Permission,
} from "@amiri/shared";
import { logger } from "../config/logger.js";
import { connectDatabase, disconnectDatabase } from "../config/db.js";
import { Role, User } from "../models/index.js";

/**
 * An administrator whose reach is the whole business but whose capability is only what
 * you granted.
 *
 * Two things that are easy to conflate are kept apart here:
 *
 *   • `isSuperAdmin` marks the role as a super admin — it may act on any approval tier and
 *     administer roles and users.
 *   • the permission list decides WHAT THEY MAY DO day to day. Each one is still checked
 *     by `requirePermission` on the route.
 *
 * So "an auditor for the whole business" is the `.view` permissions and nothing more,
 * which is a very different account from a SuperAdmin.
 *
 *   npx tsx src/scripts/create-global-admin.ts --email them@example.com --name "Their Name"
 *
 * Presets for `--permissions`:
 *
 *   readonly    every `.view` permission, plus reports. Sees the whole business, changes
 *               nothing. This is the default, because it is the one that cannot do damage.
 *   operations  readonly plus day-to-day entry and approvals — but NOT user, role, period
 *               or settings administration.
 *   full        every permission. This is a SuperAdmin in all but name; prefer the
 *               SUPER_ADMIN role itself if that is what you actually want.
 *
 * Or pass an explicit list: --permissions "finance.payment.view,reports.view"
 *
 * The password is read from the terminal, or from ADMIN_PASSWORD when there is no TTY. It
 * is never an argument: argv is visible in `ps` to every user on the host.
 */

/** Administration of the system itself, withheld from the `operations` preset. */
const ADMIN_ONLY = /^(users|roles|period|settings)\.|^audit\.|^import\./;

function presetPermissions(preset: string): Permission[] {
  if (preset === "full") return [...ALL_PERMISSIONS];

  if (preset === "readonly") {
    return ALL_PERMISSIONS.filter(
      (p) => p.endsWith(".view") || p.startsWith("reports.") || p === "finance.bank.viewFull",
    );
  }

  if (preset === "operations") {
    return ALL_PERMISSIONS.filter((p) => !ADMIN_ONLY.test(p));
  }

  // Not a preset name — treat it as an explicit comma-separated list.
  const requested = preset.split(",").map((p) => p.trim()).filter(Boolean);
  const unknown = requested.filter((p) => !isPermission(p));
  if (unknown.length > 0) {
    throw new Error(
      `Not permission names: ${unknown.join(", ")}. Use a preset (readonly | operations | ` +
        `full) or a comma-separated list from the catalogue in packages/shared/src/permissions.ts.`,
    );
  }
  return requested as Permission[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Read a password without echoing it. Muting the output stream is the standard approach. */
async function promptHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const fromEnv = process.env.ADMIN_PASSWORD;
    if (!fromEnv) {
      throw new Error(
        "No terminal available. Either run interactively, or pass the password as the " +
          "ADMIN_PASSWORD environment variable.",
      );
    }
    return fromEnv;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const output = rl as unknown as { _writeToOutput: (s: string) => void };
  const write = output._writeToOutput.bind(rl);

  process.stdout.write(prompt);
  output._writeToOutput = (s: string) => {
    if (s.includes("\n")) write("\n");
  };

  try {
    return await new Promise<string>((resolve) => rl.question("", resolve));
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const email = (arg("email") ?? process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
  const name = arg("name") ?? process.env.ADMIN_NAME ?? "Global Admin";
  const roleName = (arg("role") ?? "GLOBAL_ADMIN").trim().toUpperCase().replace(/\s+/g, "_");
  const roleLabel = arg("label") ?? "Global Admin";
  const preset = arg("permissions") ?? "readonly";
  const roleOnly = hasFlag("role-only");

  if (!roleOnly && (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) {
    logger.fatal("Pass a valid address: --email them@example.com (or --role-only)");
    process.exit(1);
  }

  const permissions = presetPermissions(preset);

  await connectDatabase();

  /* ── Step 1: the role ──────────────────────────────────────────────────── */

  // `isSystem: false` — this role is yours to edit or delete from the Roles screen. The
  // seeded four are marked system precisely so they cannot be removed out from under the
  // code that references them by name; this one carries no such dependency.
  const role = await Role.findOneAndUpdate(
    { name: roleName },
    {
      $set: {
        label: roleLabel,
        description: `${permissions.length} of ${ALL_PERMISSIONS.length} permissions.`,
        permissions,
        isSuperAdmin: true,
        isSystem: false,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  logger.info(
    { role: roleName, permissions: permissions.length, preset, unscoped: true },
    "role ready",
  );

  if (roleOnly) {
    await disconnectDatabase();
    process.stdout.write(
      `\n  Role ${roleName} is ready — assign it from Users → New user.\n\n`,
    );
    return;
  }

  /* ── Step 2: the user ──────────────────────────────────────────────────── */

  const existing = await User.findOne({ email });
  if (existing && !hasFlag("promote")) {
    logger.fatal(
      { email },
      "That address already has an account. Re-run with --promote to move it onto this " +
        "role and set a new password.",
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

  const checked = passwordPolicy.safeParse(plain);
  if (!checked.success) {
    logger.fatal({ issues: checked.error.issues.map((i) => i.message) }, "Password rejected");
    await disconnectDatabase();
    process.exit(1);
  }

  const user = existing ?? new User({ email, passwordHash: "placeholder" });
  user.name = name;
  user.roleId = String(role._id) as never;
  // Deliberately empty. Reach is not granted per-record here, and leaving
  // stale assignments on the record would misrepresent where this user's access comes from.
  user.designation = arg("designation") ?? roleLabel;
  user.status = "ACTIVE";

  await user.setPassword(plain);
  user.mustChangePassword = false;
  await user.save();

  logger.info(
    { admin: email, role: roleName, action: existing ? "promoted" : "created" },
    "global admin ready",
  );

  await disconnectDatabase();
  process.stdout.write(`\n  Sign in as ${email} — ${permissions.length} permissions.\n\n`);
}

main().catch(async (err: unknown) => {
  logger.fatal({ err }, "create-global-admin failed");
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
