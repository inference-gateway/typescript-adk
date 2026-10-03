/**
 * Internal helpers for reading environment variables. Not part of the public
 * barrel (`src/index.ts`).
 */

const TRUTHY_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);

/**
 * Parse an environment variable as a boolean flag. Accepts `1`, `true`, `yes`
 * and `on` (trimmed, case-insensitive); everything else - including unset - is
 * `false`.
 */
export function parseEnvBool(raw: string | undefined): boolean {
  return raw !== undefined && TRUTHY_ENV_VALUES.has(raw.trim().toLowerCase());
}
