/**
 * Node 20 cannot execute TypeScript (type stripping arrived in 22.6), so every
 * runnable entry point is bundled to plain ESM in dist/ before it is run.
 *
 * Each bundle is built separately and on purpose. The verifier in particular
 * must not acquire a path into our own code by way of a shared bundle — see
 * packages/verifier/package.json.
 */
import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

const ENTRIES = [
  { in: "packages/store/src/index.ts", out: "dist/store.mjs" },
  { in: "packages/verifier/src/cli.ts", out: "dist/verify.mjs" },
  { in: "scripts/e2e.ts", out: "dist/e2e.mjs" },
];

await mkdir("dist", { recursive: true });

for (const entry of ENTRIES) {
  await build({
    entryPoints: [entry.in],
    outfile: entry.out,
    bundle: true,
    platform: "node",
    target: "node20.19",
    format: "esm",
    // Dependencies stay external and resolve from node_modules at runtime.
    // Bundling them would flatten the package boundaries this repo relies on.
    packages: "external",
    logLevel: "warning",
  });
  console.log(`built ${entry.out}`);
}
