# Store Frontend Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign `public/index.html` — the store's only human-facing page — into a distinctive, Polaris-token-based, receipt-styled page, without changing any store behavior.

**Architecture:** One static HTML file, no framework, no build step. A new vitest test pins the page's menu content to `packages/store/src/menu.ts` so the two can never silently drift.

**Tech Stack:** Plain HTML/CSS (no new npm dependencies), vitest (already in the project).

## Global Constraints

- No new runtime or dev dependencies. `public/index.html` stays a single, dependency-free static file — no React, no bundler, no `@shopify/polaris` package.
- No changes to `packages/store/src/*` or any API behavior.
- Menu prices shown on the page must equal `packages/store/src/menu.ts` exactly: Espresso 15000000 tinybar / 0.15 HBAR, Flat White 25000000 tinybar / 0.25 HBAR, Cold Brew 35000000 tinybar / 0.35 HBAR.
- Color/surface tokens come from Shopify Polaris's real published values, hand-copied as CSS custom properties (no package import) — spec: `docs/superpowers/specs/2026-09-07-store-frontend-redesign-design.md`.
- Typography must not use Inter, DM Sans, or other faces `impeccable` flags as overused, and must not reproduce the "warm cream + serif + terracotta" or "near-black + single neon accent" AI-generated-page clichés.

---

### Task 1: Content-parity test and full page redesign

**Files:**
- Create: `__tests__/store-frontend.test.ts`
- Modify: `public/index.html`

**Interfaces:**
- Consumes: `MENU` and `formatHbar` exported from `packages/store/src/menu.ts` (existing — see `packages/store/src/menu.ts:24` and `:56`).
- Produces: nothing new consumed by later tasks other than the file `public/index.html` itself, which Task 2 edits in place.

- [ ] **Step 1: Write the failing test**

Create `__tests__/store-frontend.test.ts`:

```ts
/**
 * The store's landing page is the only place a person reads the catalogue
 * and the API surface in prose, not code — so it is the one place that can
 * drift silently from packages/store/src/menu.ts without any type checker
 * catching it. This reads the actual rendered page and checks it names each
 * menu item and its price exactly as menu.ts produces them, plus the three
 * documented endpoint paths.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MENU, formatHbar } from "../packages/store/src/menu.ts";

const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

describe("store landing page matches the store it documents", () => {
  for (const item of MENU) {
    it(`shows ${item.name} at its real price`, () => {
      expect(page).toContain(item.name);
      expect(page).toContain(item.priceTinybar.toString());
      expect(page).toContain(formatHbar(item.priceTinybar));
    });
  }

  it("documents the three real endpoints", () => {
    expect(page).toContain("/menu");
    expect(page).toContain("/health");
    expect(page).toContain("/buy/");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run __tests__/store-frontend.test.ts`
Expected: FAIL — the three "shows `<item>` at its real price" cases fail because the current page has no menu content at all (only the endpoint list passes).

- [ ] **Step 3: Replace `public/index.html` with the redesigned page**

Replace the full file contents with:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Proof of Spend — demo store</title>
<style>
  :root {
    color-scheme: light dark;

    /* Polaris tokens (@shopify/polaris-tokens), light mode, hand-copied —
       no package dependency added. */
    --surface: #ffffff;
    --surface-subdued: #f1f1f1;
    --text: #202223;
    --text-subdued: #6d7175;
    --border: #c9cccf;
    --link: #005bd3;

    --font-display: ui-serif, "Iowan Old Style", "Palatino Linotype", Georgia, serif;
    --font-body: ui-sans-serif, system-ui, -apple-system, sans-serif;
    --font-mono: ui-monospace, "SF Mono", "Cascadia Code", "Roboto Mono", monospace;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      /* Derived from the light tokens above to keep the same relationships;
         Polaris ships no official dark palette. */
      --surface: #1a1c1d;
      --surface-subdued: #202223;
      --text: #f6f6f7;
      --text-subdued: #9fa3a7;
      --border: #494c4e;
      --link: #6ab0ff;
    }
  }

  * { box-sizing: border-box; }

  body {
    background: var(--surface-subdued);
    color: var(--text);
    font: 16px/1.6 var(--font-body);
    margin: 0;
    padding: 3rem 1.5rem 4rem;
  }

  main { max-width: 40rem; margin: 0 auto; }

  header p { color: var(--text-subdued); margin: .25rem 0 0; }

  h1 { font: 600 1.75rem/1.2 var(--font-display); margin: 0; }
  h2 { font: 600 1.1rem/1.3 var(--font-display); margin: 0 0 1rem; }

  code { font-family: var(--font-mono); font-size: .9em; }
  a { color: var(--link); }

  /* Menu board: a receipt sitting on a Polaris card surface — the store's
     product is a purchase that is provable on a public ledger. */
  .receipt {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    margin: 2.5rem 0;
    padding: 1.5rem 1.5rem 1.75rem;
  }

  .receipt-item {
    align-items: baseline;
    border-top: 1px dashed var(--border);
    display: flex;
    gap: 1rem;
    justify-content: space-between;
    padding: .85rem 0;
  }

  .receipt-item:first-of-type { border-top: none; padding-top: 0; }
  .receipt-item-name { font-weight: 600; }

  .receipt-item-description {
    color: var(--text-subdued);
    display: block;
    font-size: .85em;
    margin-top: .15rem;
  }

  .receipt-item-price {
    flex-shrink: 0;
    font-family: var(--font-mono);
    text-align: right;
    white-space: nowrap;
  }

  .receipt-item-price small { color: var(--text-subdued); display: block; font-size: .75em; }

  /* API reference */
  .endpoints { display: grid; gap: .75rem; margin: 0 0 2rem; }

  .endpoint {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: .9rem 1rem;
  }

  .endpoint code { color: var(--link); font-weight: 600; }
  .endpoint p { color: var(--text-subdued); margin: .35rem 0 0; }

  footer {
    border-top: 1px solid var(--border);
    color: var(--text-subdued);
    font-size: .9em;
    margin-top: 3rem;
    padding-top: 1.25rem;
  }
</style>
</head>
<body>
<main>
  <header>
    <h1>Proof of Spend</h1>
    <p>
      An x402-gated store on <code>hedera:testnet</code>, quoting in native
      HBAR (asset <code>0.0.0</code>). Built to be called by an agent, not
      read by a person — but here is what it sells and exposes.
    </p>
  </header>

  <section class="receipt" aria-label="Menu">
    <h2>Menu</h2>

    <div class="receipt-item">
      <span>
        <span class="receipt-item-name">Espresso</span>
        <span class="receipt-item-description">A single shot. The cheapest thing an agent can buy here.</span>
      </span>
      <span class="receipt-item-price">15000000 tinybar<small>0.15 HBAR</small></span>
    </div>

    <div class="receipt-item">
      <span>
        <span class="receipt-item-name">Flat white</span>
        <span class="receipt-item-description">Double ristretto, steamed milk.</span>
      </span>
      <span class="receipt-item-price">25000000 tinybar<small>0.25 HBAR</small></span>
    </div>

    <div class="receipt-item">
      <span>
        <span class="receipt-item-name">Cold brew</span>
        <span class="receipt-item-description">Steeped eighteen hours. Served over ice.</span>
      </span>
      <span class="receipt-item-price">35000000 tinybar<small>0.35 HBAR</small></span>
    </div>
  </section>

  <section aria-label="API reference">
    <h2>API</h2>
    <div class="endpoints">
      <div class="endpoint">
        <code><a href="/menu">GET /menu</a></code>
        <p>The catalogue, with prices in tinybar. Free — discovery must not cost money.</p>
      </div>
      <div class="endpoint">
        <code><a href="/health">GET /health</a></code>
        <p>Network and asset this store is configured for. Free.</p>
      </div>
      <div class="endpoint">
        <code>GET /buy/&lt;slug&gt;</code>
        <p>Paid. Answers <code>402</code> with an x402 payment challenge; returns the resource once the facilitator confirms settlement.</p>
      </div>
    </div>
  </section>

  <footer>
    Testnet only. Source:
    <a href="https://github.com/Absguayaco/hedera-proof-of-spend">github.com/Absguayaco/hedera-proof-of-spend</a>
  </footer>
</main>
</body>
</html>
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run __tests__/store-frontend.test.ts`
Expected: PASS — all cases green.

- [ ] **Step 5: Manual visual check**

Open `public/index.html` directly in a browser (`open public/index.html` on macOS) and confirm:
- The menu board reads as a receipt (dashed rules between items, right-aligned prices) sitting on a card, not a bare list.
- Light mode uses the Polaris light tokens (white/light-gray surfaces, `#005bd3` links).
- Switching the OS/browser to dark mode (or Chrome DevTools → Rendering → "prefers-color-scheme: dark") swaps to the dark tokens with readable contrast.
- The three endpoint links/text (`/menu`, `/health`, `/buy/<slug>`) are unchanged in meaning from the original copy.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS — no other test is affected, since no `packages/store/src` file changed.

- [ ] **Step 7: Commit**

```bash
git add __tests__/store-frontend.test.ts public/index.html
git commit -m "$(cat <<'EOF'
feat: redesign store landing page with receipt-styled menu

Adds a content-parity test pinning the page's menu items and prices
to packages/store/src/menu.ts, then redesigns public/index.html:
Polaris-sourced color/surface tokens (hand-copied, no package
dependency), a receipt-styled menu board showing the real catalogue,
and a cleaner API reference section. No store behavior changes.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YaSFEJnBYMq4UzgD3eccsi
EOF
)"
```

---

### Task 2: Impeccable critique and polish pass

**Files:**
- Modify: `public/index.html` (only if the critique/polish passes identify concrete issues)

**Interfaces:**
- Consumes: `public/index.html` from Task 1, and the vitest test from Task 1 (`__tests__/store-frontend.test.ts`) as the regression check after any edits.
- Produces: nothing consumed by a later task — this is the last task in the plan.

- [ ] **Step 1: Run the impeccable critique pass**

Invoke the `impeccable` skill with `critique` targeting the page (e.g. via the Skill tool: `skill: "impeccable"`, `args: "critique --target public/index.html"`). Read its findings.

- [ ] **Step 2: Apply any real fixes the critique identifies**

For each concrete issue the critique reports (e.g. contrast, hierarchy, spacing, an anti-pattern it flags), edit `public/index.html` to address it. If the critique reports nothing actionable, note that and skip to Step 3 — do not invent changes.

- [ ] **Step 3: Run the impeccable polish pass**

Invoke the `impeccable` skill with `polish` targeting the page (`args: "polish --target public/index.html"`). Apply any concrete fixes it identifies, the same way as Step 2.

- [ ] **Step 4: Re-run the content-parity test**

Run: `npx vitest run __tests__/store-frontend.test.ts`
Expected: PASS — critique/polish edits must not have touched the menu names, prices, or endpoint paths. If it fails, fix the regression (restore the exact text/values) before continuing.

- [ ] **Step 5: Re-run the manual visual check**

Repeat Task 1 Step 5 (light mode, dark mode, receipt styling, endpoint content) against the post-polish page.

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "$(cat <<'EOF'
polish: apply impeccable critique/polish findings to store page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YaSFEJnBYMq4UzgD3eccsi
EOF
)"
```

If Steps 1–3 found nothing actionable, skip this commit — there is nothing to commit beyond Task 1's.
