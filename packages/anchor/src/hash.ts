/**
 * Canonicalisation and hashing of a filed receipt.
 *
 * Implemented from the specification in the README ("How the receipt hash is
 * computed"), which is also the source for the second, independent
 * implementation in packages/verifier/src/hash.ts. Those two agreeing is the
 * whole proof. Do NOT make them import each other to "avoid duplication": the
 * duplication IS the control.
 *
 * This implementation builds a canonical value tree and hands it to
 * JSON.stringify. The verifier's walks the value and emits text directly. They
 * reach the same bytes by different routes, which is the only reason their
 * agreement means anything.
 */
import { createHash } from "node:crypto";

/** Version tag written alongside the hash, so the rule can change later
 *  without silently invalidating every anchor made under the old one. */
export const HASH_VERSION = 1;

/** The value types the rule permits. Numbers are deliberately absent. */
type Canonical = string | boolean | null | Canonical[] | { [key: string]: Canonical };

/**
 * Sort by Unicode code point, per rule 3.
 *
 * Array.prototype.sort() compares UTF-16 code units, which orders astral-plane
 * characters differently from code point order. Array.from() splits a string
 * into code points, so this comparator sorts the way the rule specifies.
 */
function byCodePoint(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const shared = Math.min(a.length, b.length);

  for (let index = 0; index < shared; index += 1) {
    const x = a[index]!.codePointAt(0)!;
    const y = b[index]!.codePointAt(0)!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "number") return `the number ${value}`;
  if (typeof value === "bigint") return `the bigint ${value}`;
  if (value instanceof Date) return "a Date";
  if (value instanceof Map) return "a Map";
  if (value instanceof Set) return "a Set";
  if (typeof value === "object" && value !== null) {
    const name = value.constructor?.name;
    return name && name !== "Object" ? `an instance of ${name}` : "a non-plain object";
  }
  return `a value of type ${typeof value}`;
}

/**
 * Recursively rebuild the value with keys ordered, rejecting anything the rule
 * does not permit. `path` is carried only so an error can name the offender.
 */
function canonicalValue(value: unknown, path: string): Canonical {
  if (value === null) return null;

  const type = typeof value;
  if (type === "string" || type === "boolean") {
    return value as string | boolean;
  }

  if (type === "number" || type === "bigint") {
    // Rule 2. A number has no single spelling, and the field most likely to be
    // one is an amount — exactly where two implementations must not diverge.
    throw new Error(
      `Receipt is not canonicalizable: ${path} is ${describe(value)}. ` +
        `Numbers are rejected; amounts travel as decimal strings.`,
    );
  }

  if (Array.isArray(value)) {
    // Rule 4: order in an array is data, so it is preserved.
    return value.map((entry, index) => canonicalValue(entry, `${path}[${index}]`));
  }

  if (type === "object") {
    // Only plain objects. A Date, Map, Set or class instance is typeof "object"
    // with no own enumerable keys, so without this check it would canonicalize
    // to "{}" — two receipts differing only in a timestamp would hash the same.
    // Silent loss of a field is the worst outcome available here.
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(
        `Receipt is not canonicalizable: ${path} is ${describe(value)}, ` +
          `which the rule does not permit. Convert it to a string first.`,
      );
    }

    const source = value as Record<string, unknown>;
    // Object.create(null), not {} -- a plain {} has Object.prototype's
    // __proto__ accessor, so result["__proto__"] = ... silently sets the
    // prototype instead of creating an own property, and a receipt that
    // genuinely has a "__proto__" key (real, reachable via JSON.parse) loses
    // it without error. A null-prototype object has no such accessor, so
    // bracket-notation assignment to any string key always creates a real
    // own property.
    const result: { [key: string]: Canonical } = Object.create(null);

    // Rule 3, plus rule 5: a key whose value is undefined is omitted entirely.
    // JSON.stringify emits keys in insertion order, so inserting them sorted
    // is what makes the output canonical.
    for (const key of Object.keys(source).sort(byCodePoint)) {
      const entry = source[key];
      if (entry === undefined) continue;
      result[key] = canonicalValue(entry, path === "" ? key : `${path}.${key}`);
    }
    return result;
  }

  throw new Error(
    `Receipt is not canonicalizable: ${path} is ${describe(value)}, which the rule does not permit.`,
  );
}

/**
 * Canonical JSON text for a receipt, per the README's rule.
 *
 * JSON.stringify with no space argument satisfies rule 6: no insignificant
 * whitespace, minimal RFC 8259 string escaping, and non-ASCII emitted literally
 * rather than as \\u escapes.
 */
export function canonicalize(receipt: unknown): string {
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
    // Rule 1.
    throw new Error("Receipt is not canonicalizable: the receipt must be a JSON object.");
  }
  return JSON.stringify(canonicalValue(receipt, ""));
}

/** SHA-256 of the canonical bytes, lowercase hex. Rule 7. */
export function hashReceipt(receipt: unknown): string {
  return createHash("sha256").update(canonicalize(receipt), "utf8").digest("hex");
}
