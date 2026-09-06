import { describe, expect, it } from "vitest";
import { MENU, TINYBAR_PER_HBAR, findItem, formatHbar, menuPayload } from "./menu.ts";

describe("MENU", () => {
  it("has unique slugs", () => {
    const slugs = MENU.map((item) => item.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("prices everything above zero", () => {
    for (const item of MENU) {
      expect(item.priceTinybar).toBeGreaterThan(0n);
    }
  });

  it("uses url-safe slugs, since each one becomes a route", () => {
    for (const item of MENU) {
      expect(item.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });
});

describe("findItem", () => {
  it("finds a known item", () => {
    expect(findItem("espresso")?.name).toBe("Espresso");
  });

  it("returns undefined rather than throwing for an unknown slug", () => {
    expect(findItem("tea")).toBeUndefined();
  });

  it("does not match on a prefix", () => {
    expect(findItem("espress")).toBeUndefined();
  });
});

describe("formatHbar", () => {
  it("renders a whole HBAR without a fractional part", () => {
    expect(formatHbar(TINYBAR_PER_HBAR)).toBe("1");
  });

  it("renders zero", () => {
    expect(formatHbar(0n)).toBe("0");
  });

  it("pads the fraction so small amounts are not shifted", () => {
    // 5_000_000 tinybar is 0.05 HBAR. Without padding this renders as "0.5",
    // which is ten times the price.
    expect(formatHbar(5_000_000n)).toBe("0.05");
  });

  it("renders one tinybar, the smallest unit", () => {
    expect(formatHbar(1n)).toBe("0.00000001");
  });

  it("trims trailing zeros", () => {
    expect(formatHbar(25_000_000n)).toBe("0.25");
  });

  it("keeps precision above 2^53, where a float would not", () => {
    const beyondFloat = 9_007_199_254_740_993n; // 2^53 + 1
    expect(formatHbar(beyondFloat)).toBe("90071992.54740993");
  });

  it("handles negatives, so a mis-signed amount is visible rather than absurd", () => {
    expect(formatHbar(-25_000_000n)).toBe("-0.25");
  });
});

describe("menuPayload", () => {
  it("carries amounts as strings, because JSON has no bigint", () => {
    for (const item of menuPayload().items) {
      expect(typeof item.priceTinybar).toBe("string");
    }
  });

  it("survives JSON serialization", () => {
    expect(() => JSON.stringify(menuPayload())).not.toThrow();
  });

  it("links each item to its own paid route", () => {
    const espresso = menuPayload().items.find((item) => item.slug === "espresso");
    expect(espresso?.href).toBe("/buy/espresso");
    expect(espresso?.priceHbar).toBe("0.15");
  });

  it("lists every catalogue item", () => {
    expect(menuPayload().items).toHaveLength(MENU.length);
  });
});
