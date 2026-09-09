/**
 * The test the whole submission rests on.
 *
 * packages/anchor/src/hash.ts and packages/verifier/src/hash.ts are two
 * independent implementations of the rule in the README. This compares them
 * across a corpus. If they ever disagree, that is a finding about the rule —
 * one of the two read the specification differently, and the specification is
 * what a third party would implement from.
 *
 * This lives at the repository root, not inside either package. Importing both
 * from here compares them without either package's manifest gaining a
 * dependency on the other, which is what keeps the verifier's independence
 * claim true. The CI guard checks that manifest, not this file.
 */
import { describe, expect, it } from "vitest";
import * as anchor from "../packages/anchor/src/hash.ts";
import * as verifier from "../packages/verifier/src/hash.ts";

/** Receipts, and shapes that stress the parts of the rule most likely to be
 *  read two different ways. */
const corpus: Array<[name: string, receipt: unknown]> = [
  ["empty", {}],
  ["flat", { rail: "hedera", amount: "15000000" }],
  ["README example", { rail: "hedera", amount: "15000000", item: { slug: "espresso" } }],
  ["keys out of order", { z: "1", a: "2", m: "3" }],
  ["nested objects", { b: { d: "1", c: { f: "2", e: "3" } }, a: "4" }],
  ["arrays keep order", { lines: ["b", "a", "c"] }],
  ["objects inside arrays", { lines: [{ b: "1", a: "2" }, { d: "3", c: "4" }] }],
  ["empty containers", { o: {}, a: [] }],
  ["null is a value", { a: null, b: "1" }],
  ["undefined is omitted", { a: undefined, b: "1" }],
  ["booleans", { yes: true, no: false }],
  ["non-ascii values", { name: "café", city: "東京" }],
  ["non-ascii keys", { café: "1", 東京: "2" }],
  ["astral-plane keys", { "\u{1D400}": "1", "！": "2", a: "3" }],
  ["emoji", { note: "☕️ paid" }],
  ["control characters", { a: "line\nbreak\ttab" }],
  ["quotes and backslashes", { a: 'he said "hi"\\' }],
  ["empty string key", { "": "1", a: "2" }],
  ["keys differing only by case", { A: "1", a: "2" }],
  ["key that is a prefix of another", { ab: "1", a: "2", abc: "3" }],
  [
    "a __proto__ key from JSON.parse, not an object literal",
    JSON.parse('{"a":"1","__proto__":"x"}'),
  ],
  [
    "a lone surrogate key sorts by raw code point, not UTF-8 substitution",
    JSON.parse('{"\\ud800":"1","\ue000":"2"}'),
  ],
  ["deep nesting", { a: { b: { c: { d: { e: "deep" } } } } }],
  [
    "a realistic receipt",
    {
      rail: "hedera",
      merchant: "Proof of Spend demo store",
      item: { slug: "espresso", name: "Espresso" },
      amount: { tinybar: "15000000", hbar: "0.15", asset: "0.0.0" },
      settlement: { transactionId: "0.0.4821@1757068800.123456789", network: "hedera:testnet" },
      filedAt: "2026-09-06T22:57:43.000Z",
      note: null,
    },
  ],
];

describe("the two implementations agree", () => {
  it.each(corpus)("canonicalizes %s identically", (_name, receipt) => {
    expect(verifier.canonicalize(receipt)).toBe(anchor.canonicalize(receipt));
  });

  it.each(corpus)("hashes %s identically", (_name, receipt) => {
    expect(verifier.hashReceipt(receipt)).toBe(anchor.hashReceipt(receipt));
  });

  it("agrees on the hash version", () => {
    expect(verifier.HASH_VERSION).toBe(anchor.HASH_VERSION);
  });
});

/** Rejection has to agree too. An implementation that accepts what the other
 *  refuses would anchor receipts the verifier can never check. */
const rejected: Array<[name: string, value: unknown]> = [
  ["a number", { n: 1 }],
  ["a float", { n: 0.1 }],
  ["a bigint", { n: 1n }],
  ["a Date", { at: new Date(0) }],
  ["a Map", { m: new Map() }],
  ["a Set", { s: new Set() }],
  ["a number nested in an array", { a: [1] }],
  ["a number deep in an object", { a: { b: { c: 1 } } }],
  ["a top-level string", "receipt"],
  ["a top-level array", []],
  ["top-level null", null],
];

describe("the two implementations reject the same things", () => {
  it.each(rejected)("both reject %s", (_name, value) => {
    expect(() => anchor.canonicalize(value)).toThrow();
    expect(() => verifier.canonicalize(value)).toThrow();
  });
});

describe("both are sensitive to changes a tamper would make", () => {
  const base = { rail: "hedera", amount: "15000000" };
  const tampered: Array<[name: string, receipt: unknown]> = [
    ["a changed amount", { rail: "hedera", amount: "15000001" }],
    ["an added field", { rail: "hedera", amount: "15000000", extra: "x" }],
    ["a removed field", { rail: "hedera" }],
    ["a field set to null instead of absent", { rail: "hedera", amount: null }],
    ["a changed rail", { rail: "base", amount: "15000000" }],
  ];

  it.each(tampered)("both produce a different hash for %s", (_name, receipt) => {
    expect(anchor.hashReceipt(receipt)).not.toBe(anchor.hashReceipt(base));
    expect(verifier.hashReceipt(receipt)).not.toBe(verifier.hashReceipt(base));
  });
});
