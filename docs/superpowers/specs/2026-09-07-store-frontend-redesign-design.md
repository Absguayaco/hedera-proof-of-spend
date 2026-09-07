# Store frontend redesign

## Purpose

`public/index.html` is the only human-facing page in the project. It documents
an x402-gated demo store (`packages/store`) that sells three drinks for
tinybar on `hedera:testnet`, meant to be called by an agent — but a person
landing on the URL currently sees a bare, unstyled `<dl>` of three endpoints.
This redesign gives the page real visual design without changing what it says
or how the store behaves.

## Scope

- Visual and content redesign of `public/index.html` only.
- No changes to `packages/store/src/*` or any API behavior.
- No new runtime dependencies, no build step: the page stays one
  dependency-free static HTML file, exactly as it ships today.

## Content structure

1. **Header** — "Proof of Spend" identity plus a one-line description: an
   x402-gated store on `hedera:testnet`, built for agents.
2. **Menu board** — the three real items from `packages/store/src/menu.ts`
   (Espresso, Flat White, Cold Brew), each with its description and price
   shown in both HBAR and tinybar. Presented as a receipt/ledger-styled board,
   not a generic card grid — the content is the personality anchor for the
   page, since the product's whole point is a purchase that is provable on a
   public ledger.
3. **API reference** — the existing three endpoints (`GET /menu`,
   `GET /health`, `GET /buy/<slug>`), redesigned as a clean reference
   list/table rather than the current `<dl>`, keeping the same descriptions.
4. **Footer** — testnet notice and the GitHub source link, as today.

## Visual system

- **Palette and surface tokens**: sourced from Shopify Polaris's real
  published values (`@shopify/polaris-tokens`), hard-coded as CSS custom
  properties (no npm dependency added) — `surface #ffffff`,
  `background #f1f1f1`, `text #202223`, `interactive/link #005bd3`,
  `success #29845a`, `critical #d72c0d`. A short code comment notes the
  source for traceability. Dark-mode values are derived sensibly from the
  same palette (Polaris itself is light-mode-first, so this page does not
  claim an "official" Polaris dark mode) and applied via
  `prefers-color-scheme`, matching the current page's approach.
- **Personality device — receipt/ledger aesthetic**: the menu board is
  styled like a printed receipt/ticket sitting on a neutral Polaris surface
  (thin rules, right-aligned tabular prices, a subtle stamped/perforated
  edge) rather than a generic SaaS-dashboard card grid or a generic
  e-commerce product grid. This is the concrete device for staying
  distinctive: grounded in "a purchase recorded on a public ledger," not a
  templated default.
- **Typography**: a distinctive pairing, picked during implementation and
  run through impeccable's anti-pattern checks (excludes Inter, DM Sans, and
  other flagged overused faces — a deliberate departure from Polaris's own
  real typeface, Inter, per the user's explicit choice). A ledger/receipt-
  flavored monospace carries prices and endpoint paths, extending the
  monospace already used for `<code>`/`<dt>` on the current page; one clean
  sans or serif carries body prose.
- Explicitly avoided: the warm-cream-background + high-contrast-serif +
  terracotta-accent combination, and the near-black + single-neon-accent
  combination — both flagged as common AI-generated-page tells.
- Built and reviewed using impeccable's actual workflow
  (`/impeccable craft` → `/impeccable critique` → `/impeccable polish`)
  rather than asserting "distinctive" without a check.

## Technical approach

- Still a single `public/index.html`, no framework, no bundler.
- Polaris token values are inlined as CSS variables with a comment noting
  their source, rather than pulled in as a package.
- No changes anywhere in `packages/store/src`.

## Testing / verification

- No unit tests apply — this is static markup/CSS with no `.ts` changes, so
  the existing `vitest` suite is unaffected and is not expected to change.
- Manual verification before considering this done:
  - Page renders correctly in both light and dark color schemes.
  - All three endpoint links/paths match what `packages/store` actually
    serves today (no drift from the current copy).
  - Menu prices on the page match `packages/store/src/menu.ts` exactly:
    Espresso 15,000,000 tinybar / 0.15 HBAR, Flat White 25,000,000 tinybar /
    0.25 HBAR, Cold Brew 35,000,000 tinybar / 0.35 HBAR.

## Out of scope

- Any live/interactive behavior (fetching `/menu` at runtime, walking
  through the `/buy/<slug>` → 402 → payment flow visually). Rejected during
  brainstorming in favor of a static page, matching the store's existing
  "deliberately small" philosophy.
- Marketing/landing-page framing of Proof of Spend as a concept. This page
  stays scoped to documenting the store itself.
- Real `@shopify/polaris` or `@atlaskit/*` component libraries. Rejected to
  avoid adding React and a build step to an otherwise dependency-light
  static page.
