import { createInterface } from "node:readline";
import { SYSTEM_ROLES, password as passwordPolicy } from "@amiri/shared";
import { logger } from "../config/logger.js";
import { connectDatabase, disconnectDatabase } from "../config/db.js";
import { Role, User } from "../models/index.js";

/**
 * Create — or promote — a super admin, at any point in an install's life.
 *
 * This is the sibling of `bootstrap-admin.ts`, not a replacement for it. That script is
 * deliberately first-admin-only: it exists to open the door on a fresh deploy and refuses
 * to run once anyone can already sign in, so it can never be used to quietly mint a second
 * owner on a live system.
 *
 * The gap it leaves is the ordinary one. Seeded installs already have
 * `superadmin@amiri.com` occupying that slot, and an operator who has lost access to every
 * super admin account cannot reach the in-app Users page to make themselves another.
 * Adding a super admin is a thing the application itself permits — this only offers the
 * same operation from a shell.
 *
 *   npx tsx src/scripts/create-superadmin.ts --email you@example.com --name "Your Name"
 *
 * In production, against the deployed image:
 *
 *   docker compose -f docker-compose.prod.yml run --rm --no-deps api \
 *       node dist/scripts/create-superadmin.js --email you@example.com --name "Your Name"
 *
 * The password is read from the terminal, or from ADMIN_PASSWORD when there is no TTY.
 * It is never accepted as an argument: argv is visible in `ps` to every user on the host.
 *
 * Prefer the Users page whenever you can still sign in. Reach for this when you cannot.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
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

async function main(): Promise<void> {
  const email = (arg("email") ?? process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
  const name = arg("name") ?? process.env.ADMIN_NAME ?? "Super Admin";
  const designation = arg("designation") ?? "Proprietor";

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    logger.fatal("Pass a valid address: --email you@example.com");
    process.exit(1);
  }

  await connectDatabase();

  // The role has to already exist. Creating it here would mean guessing at its permission
  // set, and a super admin role assembled by a side script is exactly the kind of thing
  // that drifts from the real one. `bootstrap-admin` or `seed` establishes it.
  const role = await Role.findOne({ name: SYSTEM_ROLES.SUPER_ADMIN }).select("_id").lean();
  if (!role) {
    logger.fatal(
      "No SUPER_ADMIN role in this database. Run bootstrap-admin (production) or seed " +
        "(development) first — those own the system role definitions.",
    );
    await disconnectDatabase();
    process.exit(1);
  }
  const roleId = String(role._id);


  const existing = await User.findOne({ email });

  // Promoting an existing account is the common case for a locked-out operator, but it is
  // also the destructive one — it rewrites someone's role and password. Say so plainly and
  // require the caller to have meant it.
  if (existing && !hasFlag("promote")) {
    logger.fatal(
      { email, status: existing.status },
      "That address already has an account. Re-run with --promote to make it a super " +
        "admin and set a new password.",
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
  // restated — an account that could not be set through the UI would be a strange thing to
  // allow through the back door.
  const checked = passwordPolicy.safeParse(plain);
  if (!checked.success) {
    logger.fatal({ issues: checked.error.issues.map((i) => i.message) }, "Password rejected");
    await disconnectDatabase();
    process.exit(1);
  }

  const user = existing ?? new User({ email, passwordHash: "placeholder" });

  user.name = name;
  user.roleId = roleId as never;
  user.designation = designation;
  user.status = "ACTIVE";

  await user.setPassword(plain);
  // False on purpose: they chose this password a moment ago at this prompt. Forcing an
  // immediate change would only train the habit of picking a throwaway first. `setPassword`
  // also clears the failed-attempt counter and any active lockout, which is what a
  // locked-out operator running this script needs.
  user.mustChangePassword = false;
  await user.save();

  logger.info(
    {
      admin: email,
      action: existing ? "promoted existing account" : "created",
    },
    "super admin ready",
  );

  await disconnectDatabase();
  process.stdout.write(`\n  Sign in as ${email}\n\n`);
}

main().catch(async (err: unknown) => {
  logger.fatal({ err }, "create-superadmin failed");
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
