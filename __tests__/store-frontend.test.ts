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
