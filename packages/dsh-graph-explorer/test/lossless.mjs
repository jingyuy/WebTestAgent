/**
 * Paths in a value that would not survive a JSON round-trip.
 *
 * This mirrors the harness's own rule for a tool's declared output, and it exists
 * because of how that rule fails. A tool that declares `{type: 'json'}` output gets its
 * return value put through the harness's lossless-JSON walk; when any part of it does
 * not qualify the harness rejects the *whole call* with `value is not lossless JSON` —
 * an error that names neither the field nor the reason. A model on the other end sees a
 * tool that simply stopped working, retries it, and gets the same nothing back.
 *
 * The rules are the harness's, narrowed to what a value built out of log records can
 * actually contain: `undefined`, a number that is not finite (including `-0`), a
 * function/symbol/bigint, a reference that closes a cycle, an object that is not a plain
 * object or a plain array, an array carrying an own key beyond its indices, and a key
 * that is not an enumerable string.
 *
 * Returns `[]` for a value that survives. In a test the useful assertion is on the
 * list, not on a boolean: the first path is the whole diagnosis.
 */
export function losslessPaths(value, path = '$', seen = new Set()) {
  if (value === undefined) return [`${path} is undefined`];
  if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) return [`${path} is ${value}`];
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return [`${path} is a ${typeof value}`];
  if (value === null || typeof value !== 'object') return [];
  if (seen.has(value)) return [`${path} is circular`];
  seen.add(value);

  const found = [];
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) found.push(`${path} is an array with a foreign prototype`);
    if (Reflect.ownKeys(value).length !== value.length + 1) found.push(`${path} is an array with an own key beyond its indices`);
    value.forEach((item, index) => found.push(...losslessPaths(item, `${path}[${index}]`, seen)));
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) found.push(`${path} is not a plain object`);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') { found.push(`${path} has a ${typeof key} key`); continue; }
      if (!Object.prototype.propertyIsEnumerable.call(value, key)) { found.push(`${path}.${key} is not enumerable`); continue; }
      found.push(...losslessPaths(value[key], `${path}.${key}`, seen));
    }
  }
  seen.delete(value);
  return found;
}
