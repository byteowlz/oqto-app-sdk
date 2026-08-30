import type { JsonValue } from "../types.js";

const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 10_000;

/** Finite, acyclic, plain JSON with explicit complexity bounds. */
export function isJsonValue(value: unknown): value is JsonValue {
  const seen = new WeakSet<object>();
  let nodes = 0;

  const visit = (current: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return false;
    if (current === null || typeof current === "string" || typeof current === "boolean") return true;
    if (typeof current === "number") return Number.isFinite(current);
    if (typeof current !== "object") return false;
    if (seen.has(current)) return false;
    seen.add(current);

    let valid: boolean;
    if (Array.isArray(current)) {
      valid = current.every((item) => visit(item, depth + 1));
    } else {
      const prototype = Object.getPrototypeOf(current);
      valid =
        (prototype === Object.prototype || prototype === null) &&
        Object.values(current as Record<string, unknown>).every((item) => visit(item, depth + 1));
    }
    seen.delete(current);
    return valid;
  };

  return visit(value, 0);
}
