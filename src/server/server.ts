import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentCard } from '../types/generated/a2a.js';

/**
 * Path of the unauthenticated agent card discovery endpoint, per the A2A
 * discovery convention.
 */
export const AGENT_CARD_PATH = '/.well-known/agent-card.json';

/**
 * Default `Cache-Control` header applied to the agent card response. A short
 * positive TTL keeps clients from re-fetching on every interaction while still
 * letting card updates propagate within a minute.
 */
export const DEFAULT_AGENT_CARD_CACHE_CONTROL = 'public, max-age=60';

export interface A2AServerConfig {
  /**
   * The public agent card. Served verbatim from the discovery endpoint, so it
   * must not contain auth metadata intended only for the authenticated
   * extended card.
   */
  readonly card: AgentCard;
  /**
   * Value for the `Cache-Control` header on the agent card response. Defaults
   * to {@link DEFAULT_AGENT_CARD_CACHE_CONTROL}.
   */
  readonly cacheControl?: string;
}

/**
 * Minimal HTTP server core for an A2A agent. Currently exposes only the
 * unauthenticated agent card discovery endpoint; further A2A protocol routes
 * will be layered on in follow-up issues.
 *
 * Deliberately decoupled from the LLM agent - a server with no LLM agent
 * configured still serves discovery.
 */
export class A2AServer {
  private readonly card: AgentCard;
  private readonly cacheControl: string;
  private readonly httpServer: Server;

  constructor(config: A2AServerConfig) {
    this.card = config.card;
    this.cacheControl = config.cacheControl ?? DEFAULT_AGENT_CARD_CACHE_CONTROL;
    this.httpServer = createHttpServer((req, res) => {
      this.handleRequest(req, res);
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '';
    const pathname = url.split('?', 1)[0] ?? '';

    if (req.method === 'GET' && pathname === AGENT_CARD_PATH) {
      this.serveAgentCard(res);
      return;
    }

    this.serveNotFound(res);
  }

  private serveAgentCard(res: ServerResponse): void {
    const body = JSON.stringify(this.card);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': this.cacheControl,
      'Content-Length': Buffer.byteLength(body).toString(),
    });
    res.end(body);
  }

  private serveNotFound(res: ServerResponse): void {
    const body = JSON.stringify({ error: 'Not Found' });
    res.writeHead(404, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body).toString(),
    });
    res.end(body);
  }

  /**
   * Begin listening on the given port and (optional) host. Resolves once the
   * underlying HTTP server emits `listening`, or rejects on a startup error.
   *
   * Pass port `0` to let the OS pick an ephemeral port - useful in tests.
   */
  listen(port: number, host?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => {
        this.httpServer.off('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        this.httpServer.off('error', onError);
        resolve();
      };
      this.httpServer.once('error', onError);
      this.httpServer.once('listening', onListening);
      if (host !== undefined) {
        this.httpServer.listen(port, host);
      } else {
        this.httpServer.listen(port);
      }
    });
  }

  /**
   * Stop accepting new connections and wait for in-flight requests to drain.
   */
  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer.close((err) => {
        if (err !== undefined && err !== null) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  /**
   * Address of the listening socket, or `null` if the server is not listening
   * on a TCP socket.
   */
  address(): AddressInfo | null {
    const addr = this.httpServer.address();
    if (addr === null || typeof addr === 'string') {
      return null;
    }
    return addr;
  }
}

/**
 * Convenience factory equivalent to `new A2AServer(config)`.
 */
export function createA2AServer(config: A2AServerConfig): A2AServer {
  return new A2AServer(config);
}
