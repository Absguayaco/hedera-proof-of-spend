/**
 * The central claim of this project is that the verifier is independent: it can
 * be run by someone who does not trust us, and it shares no code with the thing
 * it checks. That is only true while its manifest stays clean, so the build
 * enforces it instead of relying on anyone remembering.
 *
 * Checks the dependency blocks specifically. A naive grep of the whole file
 * matches the package's own name field and fails every time.
 */
import { readFileSync } from "node:fs";

const manifest = JSON.parse(
  readFileSync(new URL("../packages/verifier/package.json", import.meta.url), "utf8"),
);

const BLOCKS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const ALLOWED = new Set(["@hiero-ledger/sdk"]);

const offenders = [];
for (const block of BLOCKS) {
  for (const name of Object.keys(manifest[block] ?? {})) {
    if (!ALLOWED.has(name)) offenders.push(`${block}: ${name}`);
  }
}

if (offenders.length > 0) {
  console.error(
    "packages/verifier must depend on nothing of ours.\n" +
      "Unexpected dependencies:\n  " + offenders.join("\n  ") + "\n\n" +
      "If this addition is intentional, the independence claim in the README " +
      "and in application field 06 is no longer true and must change too.",
  );
  process.exit(1);
}

console.log("ok: verifier depends only on", [...ALLOWED].join(", "));
