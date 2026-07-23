/**
 * Pure translation between the SqliteStatement param contract (better-sqlite3
 * conventions, pinned by @northkeep/core sqlite-driver.ts) and expo-sqlite's
 * binding conventions. Kept free of any RN import so the Node byte-exactness
 * suite can pin the behavior.
 *
 * Contract (matching better-sqlite3, which the vault code was written against):
 *   - positional params: `stmt.run(a, b, c)` binds `?` placeholders in order;
 *   - named params: exactly ONE plain-object argument whose keys have NO
 *     prefix, bound to `@name` placeholders (the only prefix vault SQL uses).
 * expo-sqlite instead wants the prefix ON the object keys ({ '@name': v }),
 * so the named form is re-keyed here.
 */

/** True when `params` is better-sqlite3's single named-params object form. */
export function isNamedParamsObject(params: unknown[]): params is [Record<string, unknown>] {
  if (params.length !== 1) return false;
  const only = params[0];
  return (
    typeof only === 'object' &&
    only !== null &&
    !Array.isArray(only) &&
    !(only instanceof Uint8Array) // a single Buffer/blob param is positional
  );
}

/** Translate a SqliteStatement param list into expo-sqlite bind arguments. */
export function toExpoBindParams(params: unknown[]): unknown[] {
  if (!isNamedParamsObject(params)) return params;
  const named: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params[0])) {
    named[`@${key}`] = value;
  }
  return [named];
}
