/**
 * Conformance of the verifier's implementation to the README's rule.
 *
 * Written against the specification, not against the anchor's behaviour. The
 * cross-implementation comparison lives in __tests__/hash-agreement.test.ts.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HASH_VERSION, canonicalize, hashReceipt } from "./hash.ts";

describe("the README's worked example", () => {
  it("produces the documented canonical form", () => {
    expect(canonicalize({ rail: "hedera", amount: "15000000", item: { slug: "espresso" } })).toBe(
      '{"amount":"15000000","item":{"slug":"espresso"},"rail":"hedera"}',
    );
  });

  it("hashes those bytes with sha-256", () => {
    const canonical = '{"amount":"15000000","item":{"slug":"espresso"},"rail":"hedera"}';
    expect(hashReceipt({ rail: "hedera", amount: "15000000", item: { slug: "espresso" } })).toBe(
      createHash("sha256").update(canonical, "utf8").digest("hex"),
    );
  });
});

describe("rule 1 — the receipt must be a JSON object", () => {
  it("rejects a string", () => {
    expect(() => canonicalize("x")).toThrow(/must be a JSON object/);
  });

  it("rejects an array", () => {
    expect(() => canonicalize([])).toThrow(/must be a JSON object/);
  });

  it("rejects a Date at the top level", () => {
    expect(() => canonicalize(new Date(0))).toThrow(/must be a JSON object/);
  });
});

describe("rule 2 — only strings, booleans, null, arrays and plain objects", () => {
  it("rejects a number", () => {
    expect(() => canonicalize({ n: 1 })).toThrow(/Numbers are rejected/);
  });

  it("rejects a bigint", () => {
    expect(() => canonicalize({ n: 1n })).toThrow(/Numbers are rejected/);
  });

  it("rejects a nested Date rather than emitting {}", () => {
    expect(() => canonicalize({ at: new Date(0) })).toThrow(/instance of Date/);
  });

  it("rejects a Set", () => {
    expect(() => canonicalize({ s: new Set(["a"]) })).toThrow(/instance of Set/);
  });

  it("rejects undefined inside an array, where it cannot be omitted", () => {
    expect(() => canonicalize({ a: [undefined] })).toThrow(/undefined/);
  });

  it("accepts booleans and null", () => {
    expect(canonicalize({ ok: true, no: false, none: null })).toBe(
      '{"no":false,"none":null,"ok":true}',
    );
  });

  it("names the path of the offender", () => {
    expect(() => canonicalize({ item: { price: 1 } })).toThrow(/item\.price/);
  });
});

describe("rule 3 — key order", () => {
  it("is independent of insertion order", () => {
    expect(canonicalize({ b: "2", a: "1" })).toBe(canonicalize({ a: "1", b: "2" }));
  });

  it("sorts at every depth", () => {
    expect(canonicalize({ z: { b: "1", a: "2" } })).toBe('{"z":{"a":"2","b":"1"}}');
  });

  it("orders astral-plane keys above BMP keys, as code point order requires", () => {
    const out = canonicalize({ "\u{1D400}": "a", "！": "b" });
    expect(out.indexOf('"！"')).toBeLessThan(out.indexOf('"\u{1D400}"'));
  });
});

describe("rules 4 to 6", () => {
  it("preserves array order", () => {
    expect(canonicalize({ l: ["b", "a"] })).toBe('{"l":["b","a"]}');
  });

  it("omits undefined values but keeps null", () => {
    expect(canonicalize({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it("emits no insignificant whitespace", () => {
    expect(canonicalize({ a: { b: ["c"] } })).toBe('{"a":{"b":["c"]}}');
  });

  it("leaves non-ASCII literal", () => {
    expect(canonicalize({ n: "café" })).toBe('{"n":"café"}');
  });

  it("handles an empty object and an empty array", () => {
    expect(canonicalize({ o: {}, a: [] })).toBe('{"a":[],"o":{}}');
  });
});

describe("HASH_VERSION", () => {
  it("matches the version the anchor writes into the topic message", () => {
    expect(HASH_VERSION).toBe(1);
  });
});
