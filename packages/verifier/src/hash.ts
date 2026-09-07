/**
 * A DELIBERATE REIMPLEMENTATION of the receipt hash.
 *
 * This file duplicates packages/anchor/src/hash.ts on purpose. It must never
 * import it. If the verifier reused the anchoring code, then "the verifier
 * agrees" would only mean "the same function returned the same answer twice",
 * which proves nothing at all.
 *
 * Written from the rule as stated in the README, not from the other file.
 * If these two ever disagree, that is a finding, not a bug to paper over by
 * making one import the other.
 *
 * The two take different routes on purpose. The anchor rebuilds a value tree
 * with ordered keys and hands it to JSON.stringify; this one walks the value
 * and emits the text itself, and derives key order from UTF-8 bytes rather
 * than from an array of code points. Agreement between two spellings of the
 * same rule is worth something; agreement between two copies of one function
 * is worth nothing.
 *
 * One component is honestly shared: both call JSON.stringify on individual
 * *strings* for RFC 8259 escaping (rule 6). Hand-rolling escaping twice would
 * risk two subtly different treatments of control characters and lone
 * surrogates, which is a worse trade than depending on the platform for a
 * well-specified transformation.
 *
 * Imports allowed here: node: builtins only.
 */
import { createHash } from "node:crypto";

export const HASH_VERSION = 1;

const utf8 = new TextEncoder();

/**
 * Order two keys per rule 3, by comparing their UTF-8 encodings.
 *
 * UTF-8 byte order and Unicode code point order are the same order, so this
 * satisfies the rule without ever materialising code points — a different
 * derivation from the anchor's, which is the point of writing it twice.
 */
function byUtf8Bytes(left: string, right: string): number {
  const a = utf8.encode(left);
  const b = utf8.encode(right);
  const shared = Math.min(a.length, b.length);

  for (let index = 0; index < shared; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

/** True for a bare `{}`-style object; false for Date, Map, class instances. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function reject(path: string, why: string): never {
  const where = path === "" ? "the receipt" : path;
  throw new Error(`Receipt is not canonicalizable: ${where} ${why}`);
}

/**
 * Append the canonical text of `value` to `out`.
 *
 * Emitting fragments rather than building an intermediate structure means the
 * key ordering and the serialization happen in one pass, and nothing relies on
 * JSON.stringify preserving insertion order.
 */
function emit(value: unknown, path: string, out: string[]): void {
  if (value === null) {
    out.push("null");
    return;
  }

  switch (typeof value) {
    case "string":
      // Rule 6: minimal RFC 8259 escaping, non-ASCII left literal.
      out.push(JSON.stringify(value));
      return;

    case "boolean":
      out.push(value ? "true" : "false");
      return;

    case "number":
      // Rule 2.
      reject(path, `is the number ${value}. Numbers are rejected; amounts travel as strings.`);
    // falls through to reject, which never returns
    case "bigint":
      reject(path, `is a bigint. Numbers are rejected; amounts travel as strings.`);
    case "undefined":
      // Only reachable inside an array; object keys are filtered before this.
      reject(path, "is undefined, which has no canonical form inside an array.");
    case "function":
    case "symbol":
      reject(path, `is a ${typeof value}, which the rule does not permit.`);
  }

  if (Array.isArray(value)) {
    // Rule 4: order is data.
    out.push("[");
    value.forEach((entry, index) => {
      if (index > 0) out.push(",");
      emit(entry, `${path}[${index}]`, out);
    });
    out.push("]");
    return;
  }

  if (!isPlainObject(value)) {
    // Rule 2's plain-object clause. A Date has no own enumerable keys, so
    // accepting it here would emit "{}" and lose the timestamp silently.
    const name = (value as object).constructor?.name ?? "object";
    reject(path, `is ${name === "Object" ? "a non-plain object" : `an instance of ${name}`}.`);
  }

  // Rule 5: a key whose value is undefined is omitted entirely, which is not
  // the same as a key set to null.
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort(byUtf8Bytes);

  out.push("{");
  keys.forEach((key, index) => {
    if (index > 0) out.push(",");
    out.push(JSON.stringify(key), ":");
    emit(value[key], path === "" ? key : `${path}.${key}`, out);
  });
  out.push("}");
}

/** Canonical JSON text for a receipt, per the README's rule. */
export function canonicalize(receipt: unknown): string {
  if (!isPlainObject(receipt)) {
    // Rule 1.
    throw new Error("Receipt is not canonicalizable: the receipt must be a JSON object.");
  }
  const out: string[] = [];
  emit(receipt, "", out);
  return out.join("");
}

/** SHA-256 of the canonical bytes, lowercase hex. Rule 7. */
export function hashReceipt(receipt: unknown): string {
  return createHash("sha256").update(canonicalize(receipt), "utf8").digest("hex");
}
