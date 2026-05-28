import { createAdaptorServer } from '@hono/node-server';
import { Hono } from 'hono';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NOOP_LOGGER, type Logger } from '../logging/index.js';
import {
  DEFAULT_METRICS_HOST,
  DEFAULT_METRICS_IDLE_TIMEOUT_MS,
  DEFAULT_METRICS_PATH,
  DEFAULT_METRICS_PORT,
  DEFAULT_METRICS_READ_TIMEOUT_MS,
  DEFAULT_METRICS_WRITE_TIMEOUT_MS,
  loadMetricsConfigFromEnv,
  type MetricsConfig,
} from './config.js';
import { MetricsRegistry } from './registry.js';

/** Health-check path served on the metrics endpoint. */
export const METRICS_HEALTH_PATH = '/health';

/** Options accepted by {@link MetricsServer}. */
export interface MetricsServerOptions {
  /**
   * Explicit configuration. When omitted, loaded from
   * {@link loadMetricsConfigFromEnv} on construction.
   */
  readonly config?: MetricsConfig;
  /**
   * Inject a pre-built {@link MetricsRegistry}. When omitted, a fresh registry
   * is created and exposed via {@link MetricsServer.getRegistry}, with
   * {@link MetricsConfig.collectDefaultMetrics} honoured.
   */
  readonly registry?: MetricsRegistry;
  /**
   * Structural logger. Defaults to a no-op so the server can be wired
   * unconditionally. Pass an actual logger to see start/stop diagnostics.
   */
  readonly logger?: Logger;
  /**
   * Read environment variables from this object instead of `process.env`.
   * Test seam mirroring {@link loadMetricsConfigFromEnv}.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

type NodeServer = Server;

/**
 * Standalone HTTP server exposing the Prometheus `/metrics` endpoint on its
 * own port. Runs alongside the main {@link import('../server/server.js').A2AServer}
 * so the scraper hits a dedicated socket - the convention every Prometheus
 * sidecar in the ecosystem already assumes.
 *
 * Two operating modes:
 *
 * - **Disabled** (`config.enable === false`): {@link start} is a no-op, no
 *   socket is opened, no exporter timer is created. Zero runtime cost beyond
 *   the server object itself, so it is safe to construct unconditionally.
 *
 * - **Enabled**: {@link start} binds to `host:port`, serves the configured
 *   `path` (default `/metrics`) with the registry's text exposition output,
 *   and serves `GET /health` returning `{ status: "healthy" }`. The
 *   underlying Node HTTP server is configured with the read/write/idle
 *   timeouts from {@link MetricsConfig} so a misbehaving scraper cannot tie
 *   up sockets indefinitely.
 *
 * Mirrors the Go ADK's separate Prometheus HTTP server in
 * `adk/server/otel/otel.go`.
 */
export class MetricsServer {
  private readonly config: MetricsConfig;
  private readonly registry: MetricsRegistry;
  private readonly logger: Logger;
  private readonly app: Hono;
  private readonly httpServer: NodeServer;
  private started = false;

  constructor(options: MetricsServerOptions = {}) {
    const fromEnv = loadMetricsConfigFromEnv(options.env);
    this.config = options.config ?? fromEnv;
    this.registry =
      options.registry ??
      new MetricsRegistry({
        collectDefaultMetrics: this.config.collectDefaultMetrics,
      });
    this.logger = options.logger ?? NOOP_LOGGER;

    this.app = this.buildApp();
    this.httpServer = createAdaptorServer({
      fetch: this.app.fetch,
    }) as NodeServer;

    this.httpServer.headersTimeout =
      this.config.readTimeoutMs > 0
        ? this.config.readTimeoutMs
        : DEFAULT_METRICS_READ_TIMEOUT_MS;
    this.httpServer.requestTimeout =
      this.config.writeTimeoutMs > 0
        ? this.config.writeTimeoutMs
        : DEFAULT_METRICS_WRITE_TIMEOUT_MS;
    this.httpServer.keepAliveTimeout =
      this.config.idleTimeoutMs > 0
        ? this.config.idleTimeoutMs
        : DEFAULT_METRICS_IDLE_TIMEOUT_MS;
  }

  /** Resolved metrics configuration. */
  getConfig(): MetricsConfig {
    return this.config;
  }

  /** Whether the server has been started. */
  isStarted(): boolean {
    return this.started;
  }

  /** Whether metrics are enabled by the resolved configuration. */
  isEnabled(): boolean {
    return this.config.enable;
  }

  /** The metrics registry backing the `/metrics` endpoint. */
  getRegistry(): MetricsRegistry {
    return this.registry;
  }

  private buildApp(): Hono {
    const app = new Hono();
    const metricsPath = this.config.path || DEFAULT_METRICS_PATH;

    app.get(METRICS_HEALTH_PATH, (c) => c.json({ status: 'healthy' }));

    app.get(metricsPath, async () => {
      const body = await this.registry.metrics();
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': this.registry.getContentType(),
          'Cache-Control': 'no-store',
        },
      });
    });

    app.notFound((c) => c.json({ error: 'Not Found' }, 404));

    return app;
  }

  /**
   * Start the metrics HTTP server. No-ops when {@link isEnabled} is `false` or
   * the server has already been started, so it is safe to call unconditionally
   * during agent boot.
   *
   * Resolves once the underlying socket emits `listening`, or rejects with the
   * startup error. Pass port `0` via {@link MetricsConfig.port} to let the OS
   * pick an ephemeral port (useful in tests).
   */
  start(): Promise<void> {
    if (!this.config.enable || this.started) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => {
        this.httpServer.off('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        this.httpServer.off('error', onError);
        this.started = true;
        const addr = this.httpServer.address();
        const port =
          addr !== null && typeof addr !== 'string'
            ? addr.port
            : this.config.port;
        this.logger.info('metrics server listening', {
          host: this.config.host,
          port,
          path: this.config.path,
        });
        resolve();
      };
      this.httpServer.once('error', onError);
      this.httpServer.once('listening', onListening);
      this.httpServer.listen(
        this.config.port > 0 ? this.config.port : DEFAULT_METRICS_PORT,
        this.config.host || DEFAULT_METRICS_HOST
      );
    });
  }

  /**
   * Stop accepting new connections and wait for in-flight scrapes to drain.
   * No-ops when the server is not running, so it is safe to call in
   * shutdown handlers regardless of state.
   */
  close(): Promise<void> {
    if (!this.started) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.httpServer.close((err?: Error | undefined) => {
        if (err !== undefined && err !== null) {
          reject(err);
          return;
        }
        this.started = false;
        this.logger.info('metrics server stopped');
        resolve();
      });
    });
  }

  /**
   * Address of the listening socket, or `null` when the server is not
   * listening on a TCP socket.
   */
  address(): AddressInfo | null {
    const addr = this.httpServer.address();
    if (addr === null || typeof addr === 'string') {
      return null;
    }
    return addr;
  }
}

/** Convenience factory equivalent to `new MetricsServer(options)`. */
export function createMetricsServer(
  options: MetricsServerOptions = {}
): MetricsServer {
  return new MetricsServer(options);
}
