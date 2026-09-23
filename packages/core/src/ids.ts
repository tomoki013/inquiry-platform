/**
 * Ids and timestamps are made here, not by the database.
 *
 * D1 has no UUID function and an autoincrementing integer would leak how many
 * reports exist and let one id be guessed from another. Every table in this
 * schema therefore takes a `TEXT PRIMARY KEY` the application generated.
 */
export function newId(): string {
  return crypto.randomUUID();
}

/** UTC, ISO 8601, second-free-form — the only time format stored anywhere. */
export function nowIso(): string {
  return new Date().toISOString();
}

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
