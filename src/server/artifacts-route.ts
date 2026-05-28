import type { Context, Hono } from 'hono';
import type { ArtifactStorageProvider } from '../artifacts/artifact-storage.js';

/**
 * Default mount point for the artifact download endpoint. Override via
 * {@link A2AServerConfig.artifactsPath} when fronting the agent behind a
 * gateway that needs a more specific prefix (e.g., `/v1/artifacts`).
 */
export const DEFAULT_ARTIFACTS_PATH = '/artifacts';

/**
 * Options accepted by {@link registerArtifactsRoute}.
 */
export interface ArtifactsRouteOptions {
  /**
   * Storage backend that owns the bytes to be served. The route never trusts
   * `:artifactId` and `:filename` directly — it passes them through the
   * provider's own validation (e.g., the filesystem provider's strict
   * `artifactId` pattern + path-resolution check).
   */
  readonly storage: ArtifactStorageProvider;
  /**
   * Path prefix the endpoint is mounted at. Defaults to
   * {@link DEFAULT_ARTIFACTS_PATH}. Trailing slashes are stripped.
   */
  readonly path?: string;
}

/**
 * Mount `GET <path>/:artifactId/:filename` on `app` so clients can fetch a
 * stored artifact's bytes. Responds with:
 *
 * - **200** + the file bytes, `Content-Type` from `getMetadata`, plus
 *   `Content-Length` and a download-friendly `Content-Disposition`.
 * - **404** when no metadata is found, when `retrieve` fails (missing /
 *   invalid id), or when the provider's strict validation rejects the
 *   `:artifactId` / `:filename` pair.
 *
 * The endpoint is intentionally unauthenticated by default — public download
 * URLs are the common case for artifact retrieval. Wrap in your own
 * middleware on the same path if you need access control.
 */
export function registerArtifactsRoute(
  app: Hono,
  options: ArtifactsRouteOptions
): void {
  const trimmed = (options.path ?? DEFAULT_ARTIFACTS_PATH).replace(/\/+$/, '');
  const base = trimmed === '' ? DEFAULT_ARTIFACTS_PATH : trimmed;
  app.get(`${base}/:artifactId/:filename`, (c) => handle(c, options.storage));
}

async function handle(
  c: Context,
  storage: ArtifactStorageProvider
): Promise<Response> {
  const artifactId = decodeParam(c.req.param('artifactId'));
  const filename = decodeParam(c.req.param('filename'));
  if (artifactId === null || filename === null) {
    return c.json({ error: 'Not Found' }, 404);
  }
  const signal = c.req.raw.signal;

  let metadata;
  try {
    metadata = await storage.getMetadata(artifactId, filename, signal);
  } catch {
    return c.json({ error: 'Not Found' }, 404);
  }
  if (metadata === undefined) {
    return c.json({ error: 'Not Found' }, 404);
  }

  let stream;
  try {
    stream = await storage.retrieve(artifactId, filename, signal);
  } catch {
    return c.json({ error: 'Not Found' }, 404);
  }

  const headers = new Headers({
    'Content-Type': metadata.contentType,
    'Content-Length': String(metadata.size),
    'Content-Disposition': `attachment; filename="${sanitiseHeaderValue(metadata.filename)}"`,
  });
  return new Response(stream, { status: 200, headers });
}

function decodeParam(raw: string | undefined): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function sanitiseHeaderValue(value: string): string {
  // Strip characters that would break the header (CR/LF, double quotes,
  // backslash). Keeps the filename usable in a quoted `Content-Disposition`
  // value without trying to do full RFC 5987 encoding.
  return value.replace(/[\r\n"\\]/g, '_');
}
