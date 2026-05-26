import { readFileSync } from 'node:fs';
import type { AgentCard } from '../types/generated/a2a.js';

/**
 * Thrown when an agent card fails the runtime schema check.
 */
export class AgentCardValidationError extends Error {
  override readonly name = 'AgentCardValidationError';
  readonly field: string | undefined;

  constructor(message: string, field?: string) {
    super(message);
    this.field = field;
  }
}

/**
 * Thrown when an agent card cannot be loaded - file I/O, malformed JSON, or
 * an unresolved `${VAR}` placeholder.
 *
 * The triggering error (if any) is exposed via the standard `Error.cause`
 * property.
 */
export class AgentCardLoadError extends Error {
  override readonly name = 'AgentCardLoadError';

  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
  }
}

export interface LoadAgentCardOptions {
  /**
   * Top-level field overrides applied after `${VAR}` placeholder resolution.
   * Overrides win over values in the source JSON.
   */
  readonly overrides?: Partial<AgentCard>;
  /**
   * Environment used to resolve `${VAR}` placeholders. Defaults to
   * `process.env`. Useful in tests.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const REQUIRED_STRING_FIELDS = [
  'description',
  'name',
  'protocolVersion',
  'version',
] as const;

const REQUIRED_STRING_ARRAY_FIELDS = [
  'defaultInputModes',
  'defaultOutputModes',
] as const;

// ${VAR} - matches a leading $ followed by { NAME } where NAME starts with a
// letter or underscore and contains letters, digits, or underscores.
const PLACEHOLDER_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Runtime schema check that the given value conforms to the required shape
 * of `AgentCard`. Throws `AgentCardValidationError` on the first failure.
 *
 * Only required fields are checked; optional fields keep the contract loose
 * so callers can supply partial cards during composition.
 */
export function validateAgentCard(value: unknown): asserts value is AgentCard {
  if (!isPlainObject(value)) {
    throw new AgentCardValidationError('AgentCard must be a JSON object');
  }

  for (const field of REQUIRED_STRING_FIELDS) {
    const v = value[field];
    if (typeof v !== 'string' || v.length === 0) {
      throw new AgentCardValidationError(
        `Field "${field}" must be a non-empty string`,
        field
      );
    }
  }

  for (const field of REQUIRED_STRING_ARRAY_FIELDS) {
    const v = value[field];
    if (!Array.isArray(v)) {
      throw new AgentCardValidationError(
        `Field "${field}" must be an array of strings`,
        field
      );
    }
    for (let i = 0; i < v.length; i++) {
      if (typeof v[i] !== 'string') {
        throw new AgentCardValidationError(
          `Field "${field}[${i}]" must be a string`,
          `${field}[${i}]`
        );
      }
    }
  }

  if (!isPlainObject(value['capabilities'])) {
    throw new AgentCardValidationError(
      'Field "capabilities" must be a JSON object',
      'capabilities'
    );
  }

  const skills = value['skills'];
  if (!Array.isArray(skills)) {
    throw new AgentCardValidationError(
      'Field "skills" must be an array',
      'skills'
    );
  }
  for (let i = 0; i < skills.length; i++) {
    if (!isPlainObject(skills[i])) {
      throw new AgentCardValidationError(
        `Field "skills[${i}]" must be a JSON object`,
        `skills[${i}]`
      );
    }
  }
}

function resolvePlaceholdersInString(
  input: string,
  env: Readonly<Record<string, string | undefined>>
): string {
  return input.replace(PLACEHOLDER_PATTERN, (match, name: string) => {
    const replacement = env[name];
    if (replacement === undefined) {
      throw new AgentCardLoadError(
        `Environment variable "${name}" is not set (referenced by placeholder ${match})`
      );
    }
    return replacement;
  });
}

function resolvePlaceholders(
  value: unknown,
  env: Readonly<Record<string, string | undefined>>
): unknown {
  if (typeof value === 'string') {
    return resolvePlaceholdersInString(value, env);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolvePlaceholders(item, env));
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      result[key] = resolvePlaceholders(v, env);
    }
    return result;
  }
  return value;
}

/**
 * Load and validate an `AgentCard` from a JSON string.
 *
 * Steps:
 *   1. Parse JSON.
 *   2. Resolve `${VAR}` placeholders against `options.env` (or `process.env`).
 *      A missing env var fails loudly instead of substituting an empty string.
 *   3. Merge `options.overrides` over the parsed object (shallow).
 *   4. Runtime-validate the merged object as `AgentCard`.
 */
export function loadAgentCardFromJSON(
  source: string,
  options: LoadAgentCardOptions = {}
): AgentCard {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    throw new AgentCardLoadError('Failed to parse agent card JSON', err);
  }

  if (!isPlainObject(parsed)) {
    throw new AgentCardValidationError(
      'AgentCard JSON must decode to an object'
    );
  }

  const env = options.env ?? process.env;
  const resolved = resolvePlaceholders(parsed, env) as Record<string, unknown>;

  const merged: Record<string, unknown> = options.overrides
    ? { ...resolved, ...options.overrides }
    : resolved;

  validateAgentCard(merged);
  return merged;
}

/**
 * Synchronously load and validate an `AgentCard` from a JSON file.
 *
 * Sync by design - this is intended for boot-time configuration. Do not call
 * on the request path.
 *
 * @see {@link loadAgentCardFromJSON} for the underlying steps.
 */
export function loadAgentCardFromFile(
  filePath: string,
  options: LoadAgentCardOptions = {}
): AgentCard {
  let source: string;
  try {
    source = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new AgentCardLoadError(
      `Failed to read agent card file: ${filePath}`,
      err
    );
  }
  return loadAgentCardFromJSON(source, options);
}
