/**
 * Refuse to install on a runtime this repo does not support, loudly.
 *
 * Two separate checks, for the same reason: a requirement that fails silently
 * is worse than one that fails at all.
 *
 * NODE. This repo runs its TypeScript sources directly via type stripping,
 * which needs Node >= 24. On Node 20 or 22, `npm ci` succeeds and the failure
 * arrives later as ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts" --
 * which says nothing about Node versions and sends the reader to the wrong
 * place entirely. engine-strict=true in .npmrc catches this too; this check
 * exists because it can explain itself, and EBADENGINE cannot.
 *
 * NPM. The .npmrc in this repo sets min-release-age=7, which is this project's main
 * supply-chain defence. npm below 11.10.0 IGNORES that setting silently — the
 * install appears to succeed and the cooldown simply never applied. A silent
 * loss of a security control is worse than a loud failure, so fail loudly.
 *
 * Node 24 ships npm 11.19.0, so this should not fire on a supported setup.
 * It exists for the case where someone has pinned an older npm by hand —
 * upgrading Node can *downgrade* npm. Check both.
 */
const REQUIRED_NODE_MAJOR = 24;
const nodeMajor = Number(process.versions.node.split(".")[0]);

if (nodeMajor < REQUIRED_NODE_MAJOR) {
  console.error(
    `\nRefusing to install on Node ${process.version}.\n\n` +
    `This repo runs its TypeScript sources directly, with no build step, which\n` +
    `requires Node >= ${REQUIRED_NODE_MAJOR}. On an older Node the install SUCCEEDS and the failure\n` +
    `arrives later as:\n\n` +
    `  ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts"\n\n` +
    `which names neither Node nor this requirement.\n\n` +
    `  nvm install 24   # also ships npm 11.19.0, which the check below needs\n\n` +
    `Then check both:  node --version && npm --version\n`,
  );
  process.exit(1);
}

const REQUIRED = [11, 10, 0];
const actual = process.env.npm_config_user_agent?.match(/npm\/(\d+)\.(\d+)\.(\d+)/);

if (!actual) {
  // Not running under npm at all (e.g. `node scripts/check-npm-version.mjs`).
  // Nothing to check; don't block.
  process.exit(0);
}

const got = actual.slice(1, 4).map(Number);
const ok = got[0] > REQUIRED[0]
  || (got[0] === REQUIRED[0] && (got[1] > REQUIRED[1]
  || (got[1] === REQUIRED[1] && got[2] >= REQUIRED[2])));

if (!ok) {
  console.error(
    `\nRefusing to install on npm ${got.join(".")}.\n\n` +
    `This repo requires npm >= ${REQUIRED.join(".")}. Below that version, the\n` +
    `min-release-age=7 cooldown in .npmrc is ignored WITHOUT WARNING, so a\n` +
    `package published minutes ago could enter the lockfile.\n\n` +
    `  nvm install 24   # ships npm 11.19.0, which is new enough\n\n` +
    `Then check both:  node --version && npm --version\n`,
  );
  process.exit(1);
}
