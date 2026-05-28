import type { MiddlewareHandler } from 'hono';
import type { MetricsRegistry } from './registry.js';

/** Options accepted by {@link createMetricsMiddleware}. */
export interface MetricsMiddlewareOptions {
  /** Registry whose counters/histograms the middleware updates. Required. */
  readonly registry: MetricsRegistry;
  /**
   * When supplied, requests whose path is in this set are excluded from the
   * metrics. Useful for keeping the scraper's own path out of the histogram
   * (otherwise every scrape inflates `a2a_request_count_total`). Compared on
   * the exact `c.req.path`.
   */
  readonly excludePaths?: Iterable<string>;
}

/**
 * Build a Hono middleware that records request count and duration into the
 * supplied {@link MetricsRegistry}. Labels:
 *
 *  - `method`: the request HTTP method (`GET`, `POST`, ...).
 *  - `path`: the request path (`c.req.path` - no query string).
 *  - `status`: the response status code as a string.
 *
 * Mounted at the app root, the middleware sees every request - including
 * health checks and the agent card endpoint. Pass {@link MetricsMiddlewareOptions.excludePaths}
 * to suppress noisy paths.
 */
export function createMetricsMiddleware(
  options: MetricsMiddlewareOptions
): MiddlewareHandler {
  const registry = options.registry;
  const excluded = options.excludePaths ? new Set(options.excludePaths) : null;

  return async (c, next) => {
    if (excluded !== null && excluded.has(c.req.path)) {
      await next();
      return;
    }

    const method = c.req.method;
    const path = c.req.path;
    const startNs = process.hrtime.bigint();

    await next();

    const status = c.res.status;
    const durationSeconds =
      Number(process.hrtime.bigint() - startNs) / 1_000_000_000;

    registry.recordRequest({ method, path, status, durationSeconds });
  };
}
