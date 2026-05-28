/**
 * Metadata about a stored artifact file. Mirrors the Go ADK's
 * `ArtifactMetadata` struct (`uploaded_at` becomes a JS `Date`).
 */
export interface ArtifactMetadata {
  /** The server-minted artifact id this file belongs to. */
  readonly artifactId: string;
  /** Original filename supplied at store time. */
  readonly filename: string;
  /** Size in bytes of the stored payload. */
  readonly size: number;
  /** MIME type / content type the payload was stored with. */
  readonly contentType: string;
  /** Wall-clock timestamp of when the file was stored. */
  readonly uploadedAt: Date;
}

/**
 * Backend-storage contract for artifact file contents.
 *
 * `ArtifactService` delegates byte-level storage to an implementation of this
 * interface; the service itself owns artifact-id minting, A2A-shape
 * construction, and validation, so storage providers can stay focused on
 * persistence concerns.
 *
 * Mirrors the Go ADK's `ArtifactStorageProvider` (see
 * `adk/server/artifacts_storage.go`). Differences from Go:
 * - `io.Reader` / `io.ReadCloser` become `Uint8Array` / `ReadableStream<Uint8Array>`.
 * - `context.Context` is replaced by an optional `AbortSignal`.
 * - `time.Duration` is expressed as milliseconds (number).
 */
export interface ArtifactStorageProvider {
  /**
   * Persist `data` under `(artifactId, filename)` and return a URL that can
   * be used to retrieve it (typically the artifact server's public URL).
   *
   * `contentType` may be used by the backend to set content-type metadata
   * (e.g., S3/MinIO object headers) but does not affect the URL shape.
   *
   * Should overwrite if `(artifactId, filename)` already exists, matching the
   * Go ADK behaviour.
   *
   * Implementations may honour `signal` to abort long-running uploads; if
   * unsupported they are free to ignore it.
   */
  store(
    artifactId: string,
    filename: string,
    data: Uint8Array | ReadableStream<Uint8Array>,
    contentType: string,
    signal?: AbortSignal
  ): Promise<string>;

  /**
   * Read back the bytes previously stored under `(artifactId, filename)`.
   *
   * Returns a streaming reader; callers are responsible for cancelling /
   * releasing the stream when done. Throws if the file does not exist —
   * callers that want a soft-existence check should use {@link exists}
   * first.
   */
  retrieve(
    artifactId: string,
    filename: string,
    signal?: AbortSignal
  ): Promise<ReadableStream<Uint8Array>>;

  /**
   * Remove the file under `(artifactId, filename)` from storage. Idempotent:
   * deleting a non-existent file is not an error.
   */
  delete(
    artifactId: string,
    filename: string,
    signal?: AbortSignal
  ): Promise<void>;

  /**
   * Cheap existence check. Returns `true` if a file is currently stored
   * under `(artifactId, filename)`, `false` otherwise.
   */
  exists(
    artifactId: string,
    filename: string,
    signal?: AbortSignal
  ): Promise<boolean>;

  /**
   * Return the metadata recorded for `(artifactId, filename)`, or `undefined`
   * when nothing is stored under that pair. Used by HTTP download endpoints
   * to set `Content-Type` and `Content-Length` headers without buffering the
   * payload.
   *
   * Implementations should be cheap — at most a single `stat`/sidecar read —
   * and must not throw on a missing file (return `undefined` instead).
   */
  getMetadata(
    artifactId: string,
    filename: string,
    signal?: AbortSignal
  ): Promise<ArtifactMetadata | undefined>;

  /**
   * Build the public URL that {@link store} would emit for
   * `(artifactId, filename)`, without storing anything. Used by the service
   * to wire up `FilePart.fileWithUri` when content is already addressable.
   */
  getUrl(artifactId: string, filename: string): string;

  /**
   * Remove every stored file whose `uploadedAt` is older than `maxAgeMs`
   * milliseconds before now. Returns the count of files removed.
   *
   * Implementations should report and skip files whose mtime cannot be
   * read rather than abort the whole sweep.
   */
  cleanupExpired(maxAgeMs: number, signal?: AbortSignal): Promise<number>;

  /**
   * Keep only the `maxCount` most-recent files per artifact id, removing
   * older ones. Returns the count of files removed.
   *
   * "Most-recent" is measured by `uploadedAt`. When `maxCount` is `0` or
   * negative the entire store is wiped.
   */
  cleanupOldest(maxCount: number, signal?: AbortSignal): Promise<number>;

  /**
   * Release any resources held by the provider (file handles, MinIO/S3
   * clients, etc). After `close()`, all other methods may throw.
   */
  close(): Promise<void>;
}
