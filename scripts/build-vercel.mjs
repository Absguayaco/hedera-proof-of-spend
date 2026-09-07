/**
 * Bundle the serverless entry point for Vercel.
 *
 * The repo has no build step: Node 24 runs the TypeScript sources directly.
 * Vercel does not. It transpiles the function's own file but leaves its
 * relative imports pointing at .ts paths that are never uploaded, so the
 * deployed function dies with ERR_MODULE_NOT_FOUND on first invocation.
 *
 * So exactly one artifact is built, for exactly one deploy target. Local
 * development, tests and CI are untouched and still run the sources.
 *
 * Dependencies stay external: Vercel traces imports from the built output and
 * installs them, and bundling the Hedera SDK's native pieces would break them.
 */
import { build } from "esbuild";

await build({
  entryPoints: ["packages/store/src/vercel.ts"],
  outfile: "api/index.js",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "external",
  logLevel: "info",
});

console.log("built api/index.js");
