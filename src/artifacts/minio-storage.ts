import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ArtifactStorageError } from './artifact-service.js';
import type {
  ArtifactMetadata,
  ArtifactStorageProvider,
} from './artifact-storage.js';
import { DEFAULT_ARTIFACT_ID_PATTERN } from './filesystem-storage.js';

/**
 * Default expiry for presigned URLs emitted in `direct` mode (5 minutes).
 * Mirrors the recommendation in the Go ADK's MinIO provider — short enough
 * that an intercepted URL has limited value, long enough for a normal client
 * download to start. Override via
 * {@link MinioArtifactStorageOptions.presignExpirySeconds}.
 */
export const DEFAULT_PRESIGN_EXPIRY_SECONDS = 300;

/**
 * Default region used when constructing the underlying `S3Client`. MinIO
 * ignores the region, but AWS S3 and the SDK validate it; `us-east-1` is the
 * conventional default.
 */
export const DEFAULT_S3_REGION = 'us-east-1';

/**
 * URL-emission mode for {@link MinioArtifactStorage}.
 *
 * - `'direct'`: {@link MinioArtifactStorage.store} returns a freshly-signed
 *   presigned GET URL pointing at the object in the backing bucket. Clients
 *   talk to S3/MinIO directly with no further server involvement.
 * - `'proxy'`: {@link MinioArtifactStorage.store} returns the public URL
 *   pattern produced by {@link MinioArtifactStorage.getUrl} (typically the
 *   gateway's `/artifacts/:id/:filename` endpoint). The server streams the
 *   object on request.
 */
export type MinioArtifactStorageMode = 'direct' | 'proxy';

/**
 * Construction options for {@link MinioArtifactStorage}.
 */
export interface MinioArtifactStorageOptions {
  /**
   * Target bucket. Must already exist — the storage does not auto-create.
   */
  readonly bucket: string;
  /**
   * Custom endpoint URL. Required for MinIO (e.g., `http://localhost:9000`).
   * Omit for native AWS S3; the SDK resolves the regional endpoint instead.
   */
  readonly endpoint?: string;
  /**
   * AWS region passed to the underlying client. Defaults to
   * {@link DEFAULT_S3_REGION}.
   */
  readonly region?: string;
  /**
   * Static credentials. Omit to defer to the SDK's default chain (env vars,
   * shared config, container IAM, etc).
   */
  readonly credentials?: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken?: string;
  };
  /**
   * If `true`, the client uses path-style addressing
   * (`http://endpoint/bucket/key`) instead of virtual-host style
   * (`http://bucket.endpoint/key`). Required for MinIO. Defaults to `true`
   * when `endpoint` is set, `false` otherwise.
   */
  readonly forcePathStyle?: boolean;
  /**
   * Key prefix prepended to every object. Useful when multiple services share
   * a bucket. Leading and trailing slashes are stripped.
   */
  readonly prefix?: string;
  /**
   * URL emission mode. Defaults to `'direct'`.
   */
  readonly mode?: MinioArtifactStorageMode;
  /**
   * Public base URL used by {@link MinioArtifactStorage.getUrl} (and by
   * `store()` in `'proxy'` mode). Trailing slashes are stripped.
   *
   * Defaults to `'minio://<bucket>'` when omitted, which is intentionally
   * not a usable HTTP URL — production deployments should pass the gateway's
   * public origin (e.g., `https://agent.example.com/artifacts`).
   */
  readonly baseUrl?: string;
  /**
   * Lifetime in seconds for presigned URLs emitted in `'direct'` mode.
   * Defaults to {@link DEFAULT_PRESIGN_EXPIRY_SECONDS}.
   */
  readonly presignExpirySeconds?: number;
  /**
   * Pattern every `artifactId` must match. Defaults to the same pattern used
   * by the filesystem provider — UUIDs, hex digests, and similar opaque
   * tokens.
   */
  readonly artifactIdPattern?: RegExp;
  /**
   * Clock injection for `uploadedAt` stamps recorded in object metadata.
   * Defaults to `() => new Date()`. Used by tests to make `cleanupExpired`
   * deterministic.
   */
  readonly now?: () => Date;
  /**
   * Pre-built `S3Client` instance. When supplied, all other connection
   * options (`endpoint`, `region`, `credentials`, `forcePathStyle`) are
   * ignored. Primarily useful for tests with a mocked client.
   */
  readonly client?: S3Client;
}

/**
 * Object-storage-backed {@link ArtifactStorageProvider} for MinIO and S3.
 *
 * Layout in the bucket:
 *
 * ```
 * <prefix>/<artifactId>/<filename>
 * ```
 *
 * Object content type comes from the `contentType` passed to
 * {@link MinioArtifactStorage.store}. The original `uploadedAt` is stored as
 * the S3 user-metadata header `x-amz-meta-uploaded-at`; on read it is
 * preferred over the object's `LastModified` so injected clocks remain
 * authoritative.
 *
 * **Modes.**
 * - `'direct'` (default): `store()` returns a short-lived presigned GET URL
 *   so clients fetch from S3 directly. `getUrl()` returns the public URL
 *   pattern (typically the gateway's proxy endpoint) — use that as a stable
 *   identifier when the presigned URL is no longer needed for streaming.
 *   Call {@link MinioArtifactStorage.getPresignedUrl} for a fresh URL later.
 * - `'proxy'`: `store()` returns the public URL pattern; the server is
 *   expected to mount {@link registerArtifactsRoute} on it and stream the
 *   bytes through {@link MinioArtifactStorage.retrieve}. Useful when the
 *   bucket is private and clients cannot speak S3.
 *
 * Mirrors the Go ADK's MinIO storage provider at
 * `adk/server/artifacts_storage_minio.go`.
 */
export class MinioArtifactStorage implements ArtifactStorageProvider {
  private readonly client: S3Client;
  private readonly ownsClient: boolean;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly baseUrl: string;
  private readonly mode: MinioArtifactStorageMode;
  private readonly presignExpirySeconds: number;
  private readonly artifactIdPattern: RegExp;
  private readonly now: () => Date;
  private closed = false;

  constructor(options: MinioArtifactStorageOptions) {
    if (typeof options.bucket !== 'string' || options.bucket === '') {
      throw new ArtifactStorageError('bucket must be a non-empty string');
    }
    this.bucket = options.bucket;
    this.prefix = (options.prefix ?? '').replace(/^\/+|\/+$/g, '');
    const rawBase = options.baseUrl ?? `minio://${options.bucket}`;
    this.baseUrl = rawBase.replace(/\/+$/, '');
    this.mode = options.mode ?? 'direct';
    this.presignExpirySeconds =
      options.presignExpirySeconds ?? DEFAULT_PRESIGN_EXPIRY_SECONDS;
    if (
      !Number.isFinite(this.presignExpirySeconds) ||
      this.presignExpirySeconds <= 0
    ) {
      throw new ArtifactStorageError(
        'presignExpirySeconds must be a positive finite number'
      );
    }
    this.artifactIdPattern =
      options.artifactIdPattern ?? DEFAULT_ARTIFACT_ID_PATTERN;
    this.now = options.now ?? ((): Date => new Date());

    if (options.client !== undefined) {
      this.client = options.client;
      this.ownsClient = false;
    } else {
      const config: S3ClientConfig = {
        region: options.region ?? DEFAULT_S3_REGION,
        forcePathStyle:
          options.forcePathStyle ?? options.endpoint !== undefined,
      };
      if (options.endpoint !== undefined) {
        config.endpoint = options.endpoint;
      }
      if (options.credentials !== undefined) {
        config.credentials = options.credentials;
      }
      this.client = new S3Client(config);
      this.ownsClient = true;
    }
  }

  async store(
    artifactId: string,
    filename: string,
    data: Uint8Array | ReadableStream<Uint8Array>,
    contentType: string,
    signal?: AbortSignal
  ): Promise<string> {
    this.ensureOpen();
    this.assertNotAborted(signal);
    const key = this.safeKey(artifactId, filename);
    const uploadedAt = this.now().toISOString();
    const body =
      data instanceof Uint8Array ? data : Readable.fromWeb(data as never);

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          Metadata: { 'uploaded-at': uploadedAt },
        }),
        signal !== undefined ? { abortSignal: signal } : undefined
      );
    } catch (cause) {
      throw new ArtifactStorageError(
        `failed to store artifact ${artifactId}/${filename}`,
        { cause }
      );
    }

    if (this.mode === 'direct') {
      return this.signGet(key, signal);
    }
    return this.getUrl(artifactId, filename);
  }

  async retrieve(
    artifactId: string,
    filename: string,
    signal?: AbortSignal
  ): Promise<ReadableStream<Uint8Array>> {
    this.ensureOpen();
    this.assertNotAborted(signal);
    const key = this.safeKey(artifactId, filename);
    let response;
    try {
      response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        signal !== undefined ? { abortSignal: signal } : undefined
      );
    } catch (cause) {
      throw new ArtifactStorageError(
        `artifact ${artifactId}/${filename} not found`,
        { cause }
      );
    }
    if (response.Body === undefined) {
      throw new ArtifactStorageError(
        `artifact ${artifactId}/${filename} returned no body`
      );
    }
    return response.Body.transformToWebStream() as ReadableStream<Uint8Array>;
  }

  async delete(
    artifactId: string,
    filename: string,
    signal?: AbortSignal
  ): Promise<void> {
    this.ensureOpen();
    this.assertNotAborted(signal);
    const key = this.safeKey(artifactId, filename);
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
        signal !== undefined ? { abortSignal: signal } : undefined
      );
    } catch (cause) {
      throw new ArtifactStorageError(
        `failed to delete artifact ${artifactId}/${filename}`,
        { cause }
      );
    }
  }

  async exists(
    artifactId: string,
    filename: string,
    signal?: AbortSignal
  ): Promise<boolean> {
    this.ensureOpen();
    this.assertNotAborted(signal);
    return (await this.head(artifactId, filename, signal)) !== undefined;
  }

  async getMetadata(
    artifactId: string,
    filename: string,
    signal?: AbortSignal
  ): Promise<ArtifactMetadata | undefined> {
    this.ensureOpen();
    this.assertNotAborted(signal);
    const head = await this.head(artifactId, filename, signal);
    if (head === undefined) return undefined;
    const sidecarUploadedAt = head.Metadata?.['uploaded-at'];
    return {
      artifactId,
      filename,
      size: head.ContentLength ?? 0,
      contentType: head.ContentType ?? 'application/octet-stream',
      uploadedAt:
        typeof sidecarUploadedAt === 'string'
          ? new Date(sidecarUploadedAt)
          : (head.LastModified ?? new Date(0)),
    };
  }

  getUrl(artifactId: string, filename: string): string {
    return `${this.baseUrl}/${encodeURIComponent(artifactId)}/${encodeURIComponent(filename)}`;
  }

  /**
   * Issue a fresh presigned GET URL for `(artifactId, filename)`. Useful for
   * `'direct'`-mode callers that need to hand a new URL to a client after
   * the original returned by `store()` has expired. `expiresIn` overrides the
   * configured {@link MinioArtifactStorageOptions.presignExpirySeconds}.
   */
  async getPresignedUrl(
    artifactId: string,
    filename: string,
    expiresIn?: number
  ): Promise<string> {
    this.ensureOpen();
    const key = this.safeKey(artifactId, filename);
    return this.signGet(key, undefined, expiresIn);
  }

  async cleanupExpired(
    maxAgeMs: number,
    signal?: AbortSignal
  ): Promise<number> {
    this.ensureOpen();
    this.assertNotAborted(signal);
    const cutoff = this.now().getTime() - maxAgeMs;
    let removed = 0;
    for await (const entry of this.iterate(signal)) {
      this.assertNotAborted(signal);
      if (entry.uploadedAt < cutoff) {
        await this.deleteKey(entry.key, signal);
        removed += 1;
      }
    }
    return removed;
  }

  async cleanupOldest(maxCount: number, signal?: AbortSignal): Promise<number> {
    this.ensureOpen();
    this.assertNotAborted(signal);
    const entries: Array<{
      key: string;
      artifactId: string;
      uploadedAt: number;
    }> = [];
    for await (const entry of this.iterate(signal)) {
      entries.push(entry);
    }
    if (maxCount <= 0) {
      for (const entry of entries) {
        this.assertNotAborted(signal);
        await this.deleteKey(entry.key, signal);
      }
      return entries.length;
    }
    const byArtifact = new Map<
      string,
      Array<{ key: string; uploadedAt: number }>
    >();
    for (const entry of entries) {
      const list = byArtifact.get(entry.artifactId) ?? [];
      list.push({ key: entry.key, uploadedAt: entry.uploadedAt });
      byArtifact.set(entry.artifactId, list);
    }
    let removed = 0;
    for (const list of byArtifact.values()) {
      list.sort((a, b) => b.uploadedAt - a.uploadedAt);
      for (const stale of list.slice(maxCount)) {
        this.assertNotAborted(signal);
        await this.deleteKey(stale.key, signal);
        removed += 1;
      }
    }
    return removed;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.ownsClient) {
      this.client.destroy();
    }
  }

  private async head(
    artifactId: string,
    filename: string,
    signal?: AbortSignal
  ): Promise<HeadObjectCommandOutput | undefined> {
    const key = this.safeKey(artifactId, filename);
    try {
      return await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
        signal !== undefined ? { abortSignal: signal } : undefined
      );
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw new ArtifactStorageError(
        `failed to read metadata for ${artifactId}/${filename}`,
        { cause: err }
      );
    }
  }

  private async signGet(
    key: string,
    signal?: AbortSignal,
    expiresIn?: number
  ): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    try {
      return await getSignedUrl(this.client, command, {
        expiresIn: expiresIn ?? this.presignExpirySeconds,
      });
    } catch (cause) {
      if (signal?.aborted === true) {
        throw new ArtifactStorageError('operation aborted', {
          cause: signal.reason,
        });
      }
      throw new ArtifactStorageError(`failed to sign URL for ${key}`, {
        cause,
      });
    }
  }

  private async *iterate(signal?: AbortSignal): AsyncGenerator<{
    key: string;
    artifactId: string;
    uploadedAt: number;
  }> {
    let continuationToken: string | undefined;
    const stripPrefix = this.prefix === '' ? '' : `${this.prefix}/`;
    do {
      this.assertNotAborted(signal);
      const input: {
        Bucket: string;
        Prefix?: string;
        ContinuationToken?: string;
      } = { Bucket: this.bucket };
      if (this.prefix !== '') input.Prefix = `${this.prefix}/`;
      if (continuationToken !== undefined) {
        input.ContinuationToken = continuationToken;
      }
      let page;
      try {
        page = await this.client.send(
          new ListObjectsV2Command(input),
          signal !== undefined ? { abortSignal: signal } : undefined
        );
      } catch (cause) {
        throw new ArtifactStorageError('failed to list bucket objects', {
          cause,
        });
      }
      for (const obj of page.Contents ?? []) {
        if (typeof obj.Key !== 'string') continue;
        const relative =
          stripPrefix !== '' ? obj.Key.slice(stripPrefix.length) : obj.Key;
        const slash = relative.indexOf('/');
        if (slash <= 0 || slash === relative.length - 1) continue;
        const artifactId = relative.slice(0, slash);
        if (!this.artifactIdPattern.test(artifactId)) continue;
        const uploadedAt = obj.LastModified?.getTime() ?? 0;
        yield { key: obj.Key, artifactId, uploadedAt };
      }
      continuationToken =
        page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);
  }

  private async deleteKey(key: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
        signal !== undefined ? { abortSignal: signal } : undefined
      );
    } catch (cause) {
      throw new ArtifactStorageError(`failed to delete object ${key}`, {
        cause,
      });
    }
  }

  private safeKey(artifactId: string, filename: string): string {
    if (!this.artifactIdPattern.test(artifactId)) {
      throw new ArtifactStorageError(
        `invalid artifactId: must match ${this.artifactIdPattern}`
      );
    }
    if (
      typeof filename !== 'string' ||
      filename.length === 0 ||
      filename.length > 255 ||
      filename.includes('\0') ||
      filename.includes('/') ||
      filename.includes('\\') ||
      filename === '.' ||
      filename === '..'
    ) {
      throw new ArtifactStorageError(
        'invalid filename: must be a non-empty path-safe string'
      );
    }
    return this.prefix === ''
      ? `${artifactId}/${filename}`
      : `${this.prefix}/${artifactId}/${filename}`;
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new ArtifactStorageError('storage has been closed');
    }
  }

  private assertNotAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
      throw new ArtifactStorageError('operation aborted', {
        cause: signal.reason,
      });
    }
  }
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  if (name === 'NotFound' || name === 'NoSuchKey') return true;
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata
    ?.httpStatusCode;
  return status === 404;
}
