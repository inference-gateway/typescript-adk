import {
  pino,
  type DestinationStream,
  type Logger as PinoLogger,
  type LoggerOptions as PinoLoggerOptions,
} from 'pino';

/**
 * Structural logger interface. Compatible with `console`, `pino`, the standard
 * shape of `zap`-style wrappers, etc. The optional {@link Logger.child} method
 * returns a logger pre-bound with additional context fields (e.g.
 * `{ requestId }` or `{ taskId }`); implementations without structured-context
 * support may omit it or return the same instance.
 *
 * Log messages are expected to be lowercase, matching the org style. The first
 * trailing argument is treated as a structured-data bag when it is a plain
 * object - implementations backed by {@link createLogger} merge it into the
 * emitted JSON line.
 */
export interface Logger {
  debug(message: string, ...args: readonly unknown[]): void;
  info(message: string, ...args: readonly unknown[]): void;
  warn(message: string, ...args: readonly unknown[]): void;
  error(message: string, ...args: readonly unknown[]): void;
  /**
   * Optional. Returns a child logger with the supplied bindings merged into
   * every subsequent log line. Adapters that cannot do structured binding may
   * return the same instance; callers should prefer {@link childLogger} to
   * gracefully handle either case.
   */
  child?(bindings: Readonly<Record<string, unknown>>): Logger;
}

/**
 * No-op logger used when no logger is configured. Drops every call.
 * {@link NOOP_LOGGER.child} returns the same instance so request- and
 * task-scoped wrappers can call `.child(...)` unconditionally.
 */
export const NOOP_LOGGER: Logger = Object.freeze({
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  child(): Logger {
    return NOOP_LOGGER;
  },
});

function noop(): void {
  // intentionally empty
}

/**
 * Return a child logger with `bindings` merged in if the logger supports it,
 * otherwise return the original logger unchanged. Use this helper from
 * internal call sites that need to attach request/task scope to a user-supplied
 * logger without assuming structured-binding support.
 */
export function childLogger(
  logger: Logger,
  bindings: Readonly<Record<string, unknown>>
): Logger {
  return typeof logger.child === 'function' ? logger.child(bindings) : logger;
}

/**
 * Environment variable that, when set to a non-empty value, raises the default
 * logger level to `debug`. Mirrors the convention used by the Go ADK and the
 * wider `inference-gateway` org.
 */
export const DEBUG_ENV = 'DEBUG';

/**
 * Environment variable that selects the runtime environment. When set to
 * `production`, {@link createLogger} defaults to JSON output; any other value
 * (including unset) defaults to pretty-printed output via `pino-pretty`.
 */
export const NODE_ENV_ENV = 'NODE_ENV';

/** Options accepted by {@link createLogger}. */
export interface CreateLoggerOptions {
  /**
   * Log level. Defaults to `debug` when {@link DEBUG_ENV} is set to a
   * non-empty value, otherwise `info`.
   */
  readonly level?: string;
  /**
   * Force pretty-printed output (`true`) or JSON output (`false`). When
   * omitted, defaults to pretty in development (`NODE_ENV !== 'production'`)
   * and JSON in production.
   */
  readonly pretty?: boolean;
  /** Initial bindings merged into every emitted log line. */
  readonly bindings?: Readonly<Record<string, unknown>>;
  /**
   * Read environment variables from this object instead of `process.env`.
   * Test seam.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Additional pino options forwarded verbatim. */
  readonly pinoOptions?: PinoLoggerOptions;
  /**
   * Override the destination stream. Useful in tests; in production the
   * default stdout destination is almost always correct.
   */
  readonly destination?: DestinationStream;
}

/**
 * Create a pino-backed {@link Logger}.
 *
 * Defaults are chosen to match the conventions documented in
 * {@link DEBUG_ENV} and {@link NODE_ENV_ENV}: structured JSON output in
 * production, pretty output in development, level raised to `debug` when
 * `DEBUG` is set. All defaults can be overridden via {@link CreateLoggerOptions}.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const env = options.env ?? process.env;
  const level = options.level ?? defaultLevel(env);
  const pretty = options.pretty ?? defaultPretty(env);

  const baseOptions: PinoLoggerOptions = {
    level,
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:standard' },
          },
        }
      : {}),
    ...options.pinoOptions,
  };

  const pinoLogger: PinoLogger =
    options.destination !== undefined
      ? pino(baseOptions, options.destination)
      : pino(baseOptions);

  const bound =
    options.bindings !== undefined
      ? pinoLogger.child(options.bindings)
      : pinoLogger;

  return new PinoLoggerAdapter(bound);
}

/**
 * Read the default level from `env`. Returns `'debug'` when {@link DEBUG_ENV}
 * is set to a non-empty value, otherwise `'info'`.
 */
function defaultLevel(
  env: Readonly<Record<string, string | undefined>>
): string {
  const debug = env[DEBUG_ENV];
  return debug !== undefined &&
    debug !== '' &&
    debug !== 'false' &&
    debug !== '0'
    ? 'debug'
    : 'info';
}

/**
 * Return `true` when pretty output should be the default for `env`. Pretty is
 * the default in development; JSON is the default in production.
 */
function defaultPretty(
  env: Readonly<Record<string, string | undefined>>
): boolean {
  return env[NODE_ENV_ENV] !== 'production';
}

/**
 * Adapter that translates console-style calls (`logger.debug(msg, obj)`) into
 * pino's structured form (`pino.debug(obj, msg)`). Concretely:
 *
 *  - `logger.info('hello')` -> `pino.info('hello')`
 *  - `logger.info('hello', { requestId })` -> `pino.info({ requestId }, 'hello')`
 *  - `logger.error('boom', err)` (where err is an Error) ->
 *    `pino.error({ err }, 'boom')` so pino's std `err` serializer fires.
 *
 * Anything else falls through to pino's util.format-style interpolation path.
 */
class PinoLoggerAdapter implements Logger {
  private readonly inner: PinoLogger;

  constructor(inner: PinoLogger) {
    this.inner = inner;
  }

  debug(message: string, ...args: readonly unknown[]): void {
    this.emit('debug', message, args);
  }
  info(message: string, ...args: readonly unknown[]): void {
    this.emit('info', message, args);
  }
  warn(message: string, ...args: readonly unknown[]): void {
    this.emit('warn', message, args);
  }
  error(message: string, ...args: readonly unknown[]): void {
    this.emit('error', message, args);
  }

  child(bindings: Readonly<Record<string, unknown>>): Logger {
    return new PinoLoggerAdapter(this.inner.child(bindings));
  }

  private emit(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    args: readonly unknown[]
  ): void {
    const fn = this.inner[level].bind(this.inner) as (
      ...callArgs: unknown[]
    ) => void;
    if (args.length === 0) {
      fn(message);
      return;
    }
    const [first, ...rest] = args;
    if (first instanceof Error) {
      fn({ err: first }, message, ...rest);
      return;
    }
    if (isPlainObject(first)) {
      fn(first, message, ...rest);
      return;
    }
    fn(message, ...args);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  if (value instanceof Date) return false;
  if (value instanceof RegExp) return false;
  if (value instanceof Map || value instanceof Set) return false;
  return true;
}
