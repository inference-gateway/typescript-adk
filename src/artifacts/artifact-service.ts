import type {
  Artifact,
  Part,
  Struct,
  Task,
  TaskArtifactUpdateEvent,
} from '../types/generated/a2a.js';

/**
 * Thrown when {@link ArtifactService.validateArtifact} or any of the
 * `create*` operations is given a malformed input. Carries an optional
 * `field` hint so callers can produce structured error responses.
 *
 * Mirrors `AgentCardValidationError` in shape.
 */
export class ArtifactValidationError extends Error {
  override readonly name = 'ArtifactValidationError';
  readonly field?: string;

  constructor(message: string, options: { field?: string } = {}) {
    super(message);
    if (options.field !== undefined) {
      this.field = options.field;
    }
  }
}

/**
 * Thrown when an artifact storage operation fails — e.g., the underlying
 * provider returns an I/O error during {@link ArtifactService.retrieve},
 * `store`, or cleanup. Wraps the original error via `Error.cause`.
 */
export class ArtifactStorageError extends Error {
  override readonly name = 'ArtifactStorageError';

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : {});
  }
}

/**
 * Options for {@link ArtifactService.createFileArtifact}.
 *
 * Either supplied `mimeType` is used verbatim, or the service infers one from
 * the filename extension via the mime-type map (see `getMimeTypeFromExtension`).
 * If neither yields a value, the service falls back to `application/octet-stream`.
 */
export interface CreateFileArtifactOptions {
  /**
   * Optional MIME type to associate with the file. Takes precedence over any
   * extension-based inference.
   */
  readonly mimeType?: string;
  /**
   * Optional abort signal forwarded to the underlying storage provider.
   */
  readonly signal?: AbortSignal;
}

/**
 * Options for {@link ArtifactService.createFileArtifactFromURI}.
 */
export interface CreateFileArtifactFromURIOptions {
  /**
   * Optional MIME type to associate with the URI. Defaults to
   * `application/octet-stream` when neither this nor the filename extension
   * yields a value.
   */
  readonly mimeType?: string;
}

/**
 * Options for {@link ArtifactService.createTaskArtifactUpdateEvent}.
 *
 * Both flags are optional per A2A; pass them when emitting chunked or
 * appended updates.
 */
export interface TaskArtifactUpdateEventOptions {
  /**
   * If `true`, the receiver should append this artifact's parts to an
   * already-known artifact with the same id (chunked transfer).
   */
  readonly append?: boolean;
  /**
   * If `true`, this is the last chunk for the artifact.
   */
  readonly lastChunk?: boolean;
  /**
   * Optional metadata to attach to the event.
   */
  readonly metadata?: Struct;
}

/**
 * Service contract for artifact lifecycle operations.
 *
 * Mirrors the Go ADK's `ArtifactService` (`adk/server/artifacts_service.go`)
 * with the following naming adjustments to fit the TypeScript surface:
 *
 * - `CreateTextArtifact`         → `createTextArtifact`
 * - `CreateFileArtifact`         → `createFileArtifact`
 * - `CreateFileArtifactFromURI`  → `createFileArtifactFromURI`
 * - `CreateDataArtifact`         → `createDataArtifact`
 * - `CreateMultiPartArtifact`    → `createMultiPartArtifact`
 * - `GetArtifactByID`            → `getArtifactByID`
 * - `GetArtifactsByType`         → `getArtifactsByType`
 * - `ValidateArtifact`           → `validateArtifact`
 * - `Exists`                     → `exists`
 * - `Retrieve`                   → `retrieve`
 * - `CleanupExpiredArtifacts`    → `cleanupExpired`
 * - `CleanupOldestArtifacts`     → `cleanupOldest`
 *
 * **Server-minted IDs.** Every artifact returned by a `create*` method has an
 * `artifactId` minted by the service via `crypto.randomUUID()`. Client-supplied
 * IDs are never trusted — pass content, not identifiers.
 *
 * **MIME-type handling.** Mirrors the Go ADK's extension map exactly
 * (`.txt`, `.json`, `.xml`, `.pdf`, `.png`, `.jpg/.jpeg`, `.gif`, `.svg`,
 * `.html`, `.css`, `.js`, `.csv`, `.zip`). Unknown extensions resolve to
 * `application/octet-stream`.
 *
 * **Storage decoupling.** Byte-level operations (`exists`, `retrieve`,
 * `cleanup*`) delegate to an {@link ArtifactStorageProvider}. The in-memory
 * implementation in this package is suitable for tests and small deployments;
 * production setups should ship a filesystem or object-store backend.
 *
 * **No client-id trust.** The service ignores any `artifactId` field in
 * caller-supplied {@link Part} arrays (for `createMultiPartArtifact`) — the
 * top-level artifact id is always server-minted.
 */
export interface ArtifactService {
  /**
   * Build a text artifact wrapping `text` as a single `TextPart`.
   *
   * The returned {@link Artifact} has a server-minted `artifactId` and is
   * **not** persisted to storage — text artifacts live inline on the task.
   */
  createTextArtifact(name: string, description: string, text: string): Artifact;

  /**
   * Persist `data` to the configured storage backend and return a file
   * artifact whose single `FilePart` references the stored URI.
   *
   * `filename` is preserved on the `FilePart.name`. The MIME type used on the
   * part comes from `options.mimeType` if supplied, otherwise extension
   * inference, otherwise `application/octet-stream`.
   *
   * Throws {@link ArtifactStorageError} when the underlying storage write
   * fails.
   */
  createFileArtifact(
    name: string,
    description: string,
    filename: string,
    data: Uint8Array,
    options?: CreateFileArtifactOptions
  ): Promise<Artifact>;

  /**
   * Build a file artifact that references an existing `uri` without storing
   * any bytes locally. Useful when content is already addressable (an S3
   * pre-signed URL, an external CDN, etc).
   *
   * Always synchronous — there is no storage round-trip.
   */
  createFileArtifactFromURI(
    name: string,
    description: string,
    filename: string,
    uri: string,
    options?: CreateFileArtifactFromURIOptions
  ): Artifact;

  /**
   * Build a structured-data artifact wrapping `data` as a single `DataPart`.
   *
   * `data` is shallow-copied onto the part so downstream mutations to the
   * input object do not retroactively change the artifact.
   */
  createDataArtifact(name: string, description: string, data: Struct): Artifact;

  /**
   * Build a multi-part artifact from a caller-supplied `parts` array.
   *
   * Throws {@link ArtifactValidationError} if `parts` is empty or contains
   * a part with no populated field.
   */
  createMultiPartArtifact(
    name: string,
    description: string,
    parts: readonly Part[]
  ): Artifact;

  /**
   * Linearly scan `task.artifacts` for one with the given `artifactId`.
   * Returns `undefined` if the task has no artifacts or no match — callers
   * should branch on the returned value rather than catching.
   */
  getArtifactByID(task: Task, artifactId: string): Artifact | undefined;

  /**
   * Return every artifact on `task` that contains at least one part of
   * kind `partKind`. Order matches the original `task.artifacts` order.
   *
   * Supported kinds match the A2A `Part` union: `'text'`, `'file'`, `'data'`.
   * Any other value yields an empty result.
   */
  getArtifactsByType(
    task: Task,
    partKind: 'text' | 'file' | 'data'
  ): Artifact[];

  /**
   * Validate that `artifact` conforms to the A2A protocol shape.
   *
   * Checks (in order): non-empty `artifactId`, at least one part, and that
   * every part has exactly one of `text`/`file`/`data` populated with a
   * non-empty value.
   *
   * Throws {@link ArtifactValidationError} on the first failure.
   */
  validateArtifact(artifact: Artifact): void;

  /**
   * Return the MIME type the service would associate with a file named
   * `filename`, based on its extension. Returns `undefined` when the
   * extension is unknown — callers can decide whether to fall back to
   * `application/octet-stream` or treat unknown as an error.
   */
  getMimeTypeFromExtension(filename: string): string | undefined;

  /**
   * Build a {@link TaskArtifactUpdateEvent} for streaming. Pure constructor
   * — does not emit anything by itself; pass the result into the streaming
   * task handler's event sink.
   */
  createTaskArtifactUpdateEvent(
    taskId: string,
    contextId: string,
    artifact: Artifact,
    options?: TaskArtifactUpdateEventOptions
  ): TaskArtifactUpdateEvent;

  /**
   * Check whether the storage backend currently holds a file under
   * `(artifactId, filename)`. Delegates to {@link ArtifactStorageProvider.exists}.
   */
  exists(
    artifactId: string,
    filename: string,
    signal?: AbortSignal
  ): Promise<boolean>;

  /**
   * Stream the bytes stored under `(artifactId, filename)`.
   *
   * Returns a `ReadableStream<Uint8Array>`; callers must consume or cancel.
   * Throws {@link ArtifactStorageError} when the underlying read fails or
   * the file does not exist.
   */
  retrieve(
    artifactId: string,
    filename: string,
    signal?: AbortSignal
  ): Promise<ReadableStream<Uint8Array>>;

  /**
   * Delete every stored file whose upload time is older than `maxAgeMs`
   * milliseconds before now. Returns the number of files removed.
   *
   * Pass `0` to remove everything that has not been uploaded in this exact
   * instant — useful for full sweeps in tests.
   */
  cleanupExpired(maxAgeMs: number, signal?: AbortSignal): Promise<number>;

  /**
   * For each artifact id in storage, keep only the `maxCount` most-recent
   * files and delete the rest. Returns the number of files removed.
   *
   * Pass `0` or a negative value to wipe the store entirely.
   */
  cleanupOldest(maxCount: number, signal?: AbortSignal): Promise<number>;

  /**
   * Close the underlying storage provider and release any held resources
   * (file handles, network clients, etc). Safe to call multiple times.
   */
  close(): Promise<void>;
}
