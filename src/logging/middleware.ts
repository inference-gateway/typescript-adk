import type { MiddlewareHandler } from 'hono';
import { childLogger, type Logger } from './logger.js';

/**
 * Hono context key under which the request-scoped {@link Logger} is stored by
 * {@link createRequestLoggerMiddleware}. Downstream handlers can retrieve it
 * via `c.get(REQUEST_LOGGER_CONTEXT_KEY)`.
 */
export const REQUEST_LOGGER_CONTEXT_KEY = 'logger';

/**
 * Hono context key under which the per-request request ID is stored.
 * Downstream handlers can retrieve it via `c.get(REQUEST_ID_CONTEXT_KEY)`.
 */
export const REQUEST_ID_CONTEXT_KEY = 'requestId';

/**
 * Request header used to propagate a correlation id across hops. Both inbound
 * (read) and outbound (echoed on the response) use the lowercase form; HTTP
 * headers are case-insensitive.
 */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Environment variable that toggles whether health-check requests are logged.
 * Defaults to `true` (health-check logs suppressed) to keep noise out of
 * production logs from container probes.
 *
 * Set to `false`, `0`, or `no` to re-enable health-check logging.
 */
export const SERVER_DISABLE_HEALTHCHECK_LOG_ENV =
  'SERVER_DISABLE_HEALTHCHECK_LOG';

/** Options accepted by {@link createRequestLoggerMiddleware}. */
export interface RequestLoggerMiddlewareOptions {
  /** Logger to bind per-request fields onto. Required. */
  readonly logger: Logger;
  /**
   * When `true`, requests to {@link healthPath} bypass logging entirely.
   * Defaults to {@link SERVER_DISABLE_HEALTHCHECK_LOG_ENV} parsed from
   * {@link env}, falling back to `true` when unset.
   */
  readonly disableHealthcheckLog?: boolean;
  /** Health endpoint path. Defaults to `/health`. */
  readonly healthPath?: string;
  /**
   * Read environment variables from this object instead of `process.env`.
   * Test seam.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Build a Hono middleware that:
 *
 *  - Reads or generates a request id (`x-request-id`).
 *  - Stores a child logger bound with `{ requestId }` under
 *    {@link REQUEST_LOGGER_CONTEXT_KEY}.
 *  - Stores the request id under {@link REQUEST_ID_CONTEXT_KEY}.
 *  - Echoes the request id back on the response via the `x-request-id`
 *    header.
 *  - Logs request start (at `debug`) and request completion (at `info`),
 *    with method, path, status, and duration.
 *  - Skips logging for {@link healthPath} when
 *    {@link RequestLoggerMiddlewareOptions.disableHealthcheckLog} is `true`.
 */
export function createRequestLoggerMiddleware(
  options: RequestLoggerMiddlewareOptions
): MiddlewareHandler {
  const logger = options.logger;
  const env = options.env ?? process.env;
  const disableHealthcheckLog =
    options.disableHealthcheckLog ?? readDisableHealthcheckLog(env);
  const healthPath = options.healthPath ?? '/health';

  return async (c, next) => {
    const incoming = c.req.header(REQUEST_ID_HEADER);
    const requestId =
      incoming !== undefined && incoming.length > 0
        ? incoming
        : globalThis.crypto.randomUUID();

    c.res.headers.set(REQUEST_ID_HEADER, requestId);

    const reqLogger = childLogger(logger, { requestId });
    c.set(REQUEST_LOGGER_CONTEXT_KEY, reqLogger);
    c.set(REQUEST_ID_CONTEXT_KEY, requestId);

    const skipLog = disableHealthcheckLog && c.req.path === healthPath;
    if (skipLog) {
      await next();
      return;
    }

    const method = c.req.method;
    const path = c.req.path;
    const start = Date.now();
    reqLogger.debug('request received', { method, path });

    await next();

    const status = c.res.status;
    const durationMs = Date.now() - start;
    const fields = { method, path, status, durationMs };
    // Hono catches handler exceptions internally and yields a 5xx response, so
    // `await next()` never throws here even when the route handler did. We
    // detect failures via the response status instead.
    if (status >= 500) {
      reqLogger.error('request failed', fields);
    } else if (status >= 400) {
      reqLogger.warn('request completed', fields);
    } else {
      reqLogger.info('request completed', fields);
    }
  };
}

/**
 * Parse {@link SERVER_DISABLE_HEALTHCHECK_LOG_ENV} from `env`. Returns `true`
 * when unset or when the value parses as truthy; `false` only when explicitly
 * disabled.
 */
function readDisableHealthcheckLog(
  env: Readonly<Record<string, string | undefined>>
): boolean {
  const raw = env[SERVER_DISABLE_HEALTHCHECK_LOG_ENV];
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  if (v === '' || v === 'false' || v === '0' || v === 'no' || v === 'off') {
    return false;
  }
  return true;
}
