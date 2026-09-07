import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HASH_VERSION, canonicalize, hashReceipt } from "./hash.ts";

describe("rule 1 — the receipt must be a JSON object", () => {
  it("rejects a string", () => {
    expect(() => canonicalize("receipt")).toThrow(/must be a JSON object/);
  });

  it("rejects null", () => {
    expect(() => canonicalize(null)).toThrow(/must be a JSON object/);
  });

  it("rejects a top-level array", () => {
    expect(() => canonicalize([])).toThrow(/must be a JSON object/);
  });

  it("accepts an empty object", () => {
    expect(canonicalize({})).toBe("{}");
  });
});

describe("rule 2 — numbers are rejected", () => {
  it("rejects an integer", () => {
    expect(() => canonicalize({ amount: 15000000 })).toThrow(/Numbers are rejected/);
  });

  it("rejects a float", () => {
    expect(() => canonicalize({ amount: 0.15 })).toThrow(/Numbers are rejected/);
  });

  it("rejects a bigint rather than silently stringifying it", () => {
    expect(() => canonicalize({ amount: 15000000n })).toThrow(/bigint/);
  });

  it("names the offending path", () => {
    expect(() => canonicalize({ item: { price: 1 } })).toThrow(/item\.price/);
  });

  it("names the offending array index", () => {
    expect(() => canonicalize({ lines: ["a", 2] })).toThrow(/lines\[1\]/);
  });

  it("rejects a Date instead of silently canonicalizing it to {}", () => {
    // A Date is typeof "object" with no own enumerable keys, so a naive
    // implementation drops it entirely and two receipts that differ only in
    // their timestamp hash identically.
    expect(() => canonicalize({ at: new Date(0) })).toThrow(/not canonicalizable/);
  });

  it("rejects a Map, for the same reason", () => {
    expect(() => canonicalize({ m: new Map([["a", "1"]]) })).toThrow(/not canonicalizable/);
  });

  it("rejects a class instance", () => {
    class Receipt {
      readonly rail = "hedera";
    }
    expect(() => canonicalize({ r: new Receipt() })).toThrow(/not canonicalizable/);
  });

  it("accepts a null-prototype object, which is still a plain bag of keys", () => {
    const bare = Object.create(null) as Record<string, string>;
    bare.a = "1";
    expect(canonicalize({ bare })).toBe('{"bare":{"a":"1"}}');
  });

  it("accepts the same amount as a string", () => {
    expect(canonicalize({ amount: "15000000" })).toBe('{"amount":"15000000"}');
  });
});

describe("rule 3 — keys sorted by code point", () => {
  it("sorts keys at the top level", () => {
    expect(canonicalize({ rail: "hedera", amount: "1" })).toBe('{"amount":"1","rail":"hedera"}');
  });

  it("sorts keys at every level of nesting", () => {
    const out = canonicalize({ b: { z: "1", a: "2" }, a: "3" });
    expect(out).toBe('{"a":"3","b":{"a":"2","z":"1"}}');
  });

  it("produces identical output regardless of insertion order", () => {
    const one = canonicalize({ a: "1", b: "2", c: "3" });
    const two = canonicalize({ c: "3", a: "1", b: "2" });
    expect(one).toBe(two);
  });

  it("orders by code point, not UTF-16 code unit", () => {
    // U+1D400 is above the BMP. In UTF-16 code unit order its leading surrogate
    // (0xD835) sorts below U+FF01 (0xFF01); in code point order it sorts above.
    const out = canonicalize({ "\u{1D400}": "astral", "！": "bmp" });
    expect(out.indexOf('"！"')).toBeLessThan(out.indexOf('"\u{1D400}"'));
  });
});

describe("rule 4 — array order is preserved", () => {
  it("keeps order", () => {
    expect(canonicalize({ lines: ["b", "a"] })).toBe('{"lines":["b","a"]}');
  });

  it("treats a reordered array as a different receipt", () => {
    expect(hashReceipt({ lines: ["a", "b"] })).not.toBe(hashReceipt({ lines: ["b", "a"] }));
  });

  it("sorts keys inside array members", () => {
    expect(canonicalize({ lines: [{ b: "2", a: "1" }] })).toBe('{"lines":[{"a":"1","b":"2"}]}');
  });
});

describe("rule 5 — absent and null are different", () => {
  it("omits an undefined value", () => {
    expect(canonicalize({ a: "1", b: undefined })).toBe('{"a":"1"}');
  });

  it("keeps an explicit null", () => {
    expect(canonicalize({ a: "1", b: null })).toBe('{"a":"1","b":null}');
  });

  it("hashes absent and null differently", () => {
    expect(hashReceipt({ a: "1" })).not.toBe(hashReceipt({ a: "1", b: null }));
  });

  it("hashes absent and undefined identically, since neither survives JSON", () => {
    expect(hashReceipt({ a: "1" })).toBe(hashReceipt({ a: "1", b: undefined }));
  });
});

describe("rule 6 — no insignificant whitespace", () => {
  it("emits no spaces or newlines between tokens", () => {
    const out = canonicalize({ a: "1", b: { c: "2" } });
    expect(out).toBe('{"a":"1","b":{"c":"2"}}');
  });

  it("emits non-ASCII literally rather than as an escape", () => {
    expect(canonicalize({ name: "café" })).toBe('{"name":"café"}');
  });

  it("still escapes control characters", () => {
    expect(canonicalize({ a: "x\ny" })).toBe('{"a":"x\\ny"}');
  });
});

describe("rule 7 — sha-256, lowercase hex", () => {
  it("matches the README's worked example", () => {
    const receipt = { rail: "hedera", amount: "15000000", item: { slug: "espresso" } };
    const expected = '{"amount":"15000000","item":{"slug":"espresso"},"rail":"hedera"}';

    expect(canonicalize(receipt)).toBe(expected);
    expect(hashReceipt(receipt)).toBe(
      createHash("sha256").update(expected, "utf8").digest("hex"),
    );
  });

  it("is 64 lowercase hex characters", () => {
    expect(hashReceipt({ a: "1" })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across calls", () => {
    expect(hashReceipt({ a: "1" })).toBe(hashReceipt({ a: "1" }));
  });

  it("changes when any value changes", () => {
    expect(hashReceipt({ a: "1" })).not.toBe(hashReceipt({ a: "2" }));
  });
});

describe("HASH_VERSION", () => {
  it("is 1, matching the rule the README documents", () => {
    expect(HASH_VERSION).toBe(1);
  });
});
