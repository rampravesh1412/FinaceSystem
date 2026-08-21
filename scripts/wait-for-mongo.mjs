/**
 * Blocks until the local MongoDB replica set has elected a PRIMARY.
 *
 * `docker compose up -d` returns as soon as the container starts, but the replica set
 * needs a few seconds to initiate and elect. Seeding or booting the API before that
 * point fails with "not primary" or "Transaction numbers are only allowed on a replica
 * set member", which looks like an application bug and is not one.
 */
import { execFileSync } from "node:child_process";

const CONTAINER = "amiri-mongo";
const TIMEOUT_MS = 90_000;
const POLL_MS = 1_000;

const EVAL = `
  try {
    const s = rs.status();
    print(s.members.some(m => m.stateStr === "PRIMARY") ? "PRIMARY" : "WAITING");
  } catch (e) {
    if (e.codeName === "NotYetInitialized") {
      rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "localhost:27017" }] });
      print("INITIATED");
    } else {
      print("ERROR:" + (e.codeName || e.message));
    }
  }
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const started = Date.now();
process.stdout.write("waiting for mongo replica set ");

while (Date.now() - started < TIMEOUT_MS) {
  let out = "";
  try {
    out = execFileSync(
      "docker",
      ["exec", CONTAINER, "mongosh", "--quiet", "--eval", EVAL],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch {
    out = "CONTAINER_NOT_READY";
  }

  if (out.includes("PRIMARY")) {
    console.log("\n✓ mongodb://localhost:27017 — replica set rs0 has a PRIMARY");
    process.exit(0);
  }

  process.stdout.write(".");
  await sleep(POLL_MS);
}

console.error(
  `\n✗ replica set did not reach PRIMARY within ${TIMEOUT_MS / 1000}s.\n` +
    `  Inspect with:  docker logs ${CONTAINER}`,
);
process.exit(1);
