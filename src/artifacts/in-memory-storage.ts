import { ArtifactStorageError } from './artifact-service.js';
import type {
  ArtifactMetadata,
  ArtifactStorageProvider,
} from './artifact-storage.js';

/**
 * Construction options for {@link InMemoryArtifactStorage}.
 */
export interface InMemoryArtifactStorageOptions {
  /**
   * Base URL used to build the public download URL for stored artifacts.
   * Trailing slashes are stripped. Defaults to `'memory://artifacts'`, which
   * is intentionally not a usable HTTP URL — callers that need real URLs
   * should pass one explicitly.
   */
  readonly baseUrl?: string;
  /**
   * Clock injection for `uploadedAt` stamps. Defaults to `() => new Date()`.
   * Used by tests to make `cleanupExpired` deterministic.
   */
  readonly now?: () => Date;
}

interface StoredEntry {
  readonly bytes: Uint8Array;
  readonly metadata: ArtifactMetadata;
}

/**
 * In-memory {@link ArtifactStorageProvider}. Suitable for tests, single-process
 * deployments, and as a starting point for richer backends.
 *
 * **Concurrency:** all operations are synchronous internally; the `Promise`
 * wrapping is purely interface-compliance. Single-threaded JS guarantees
 * atomicity per call.
 *
 * **Storage keys:** `(artifactId, filename)` is normalised by joining with
 * `'/'`. Both fields are kept verbatim — sanitisation is the caller's
 * concern, matching the Go ADK's separation.
 *
 * **Bytes ownership:** input `Uint8Array`s are *copied* into the store;
 * input `ReadableStream`s are fully drained before `store` resolves. Callers
 * can reuse or mutate their inputs once the returned promise settles.
 */
export class InMemoryArtifactStorage implements ArtifactStorageProvider {
  private readonly entries = new Map<string, StoredEntry>();
  private readonly baseUrl: string;
  private readonly now: () => Date;
  private closed = false;

  constructor(options: InMemoryArtifactStorageOptions = {}) {
    const rawBase = options.baseUrl ?? 'memory://artifacts';
    this.baseUrl = rawBase.replace(/\/+$/, '');
    this.now = options.now ?? ((): Date => new Date());
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

    const bytes =
      data instanceof Uint8Array ? new Uint8Array(data) : await readAll(data);

    this.assertNotAborted(signal);

    const key = makeKey(artifactId, filename);
    this.entries.set(key, {
      bytes,
      metadata: {
        artifactId,
        filename,
        size: bytes.byteLength,
        contentType,
        uploadedAt: this.now(),
      },
    });
    return this.getUrl(artifactId, filename);
  }

  async retrieve(
    artifactId: string,
    filename: string,
    signal?: AbortSignal
  ): Promise<ReadableStream<Uint8Array>> {
    this.ensureOpen();
    this.assertNotAborted(signal);

    const entry = this.entries.get(makeKey(artifactId, filename));
    if (entry === undefined) {
      throw new ArtifactStorageError(
        `artifact ${artifactId}/${filename} not found`
      );
    }
    const bytes = entry.bytes;
    return new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    });
  }

  async delete(
    artifactId: string,
    filename: string,
    signal?: AbortSignal
  ): Promise<void> {
    this.ensureOpen();
    this.assertNotAborted(signal);
    this.entries.delete(makeKey(artifactId, filename));
  }

  async exists(
    artifactId: string,
    filename: string,
    signal?: AbortSignal
  ): Promise<boolean> {
    this.ensureOpen();
    this.assertNotAborted(signal);
    return this.entries.has(makeKey(artifactId, filename));
  }

  getUrl(artifactId: string, filename: string): string {
    return `${this.baseUrl}/${encodeURIComponent(artifactId)}/${encodeURIComponent(filename)}`;
  }

  async cleanupExpired(
    maxAgeMs: number,
    signal?: AbortSignal
  ): Promise<number> {
    this.ensureOpen();
    this.assertNotAborted(signal);

    const cutoff = this.now().getTime() - maxAgeMs;
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.metadata.uploadedAt.getTime() < cutoff) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async cleanupOldest(maxCount: number, signal?: AbortSignal): Promise<number> {
    this.ensureOpen();
    this.assertNotAborted(signal);

    if (maxCount <= 0) {
      const removed = this.entries.size;
      this.entries.clear();
      return removed;
    }

    // Group keys by artifactId, sorted by uploadedAt descending (newest first).
    const byArtifact = new Map<
      string,
      Array<{ key: string; uploadedAt: number }>
    >();
    for (const [key, entry] of this.entries) {
      const list = byArtifact.get(entry.metadata.artifactId) ?? [];
      list.push({ key, uploadedAt: entry.metadata.uploadedAt.getTime() });
      byArtifact.set(entry.metadata.artifactId, list);
    }

    let removed = 0;
    for (const list of byArtifact.values()) {
      list.sort((a, b) => b.uploadedAt - a.uploadedAt);
      for (const stale of list.slice(maxCount)) {
        this.entries.delete(stale.key);
        removed += 1;
      }
    }
    return removed;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.entries.clear();
  }

  /**
   * Test helper: return a snapshot of all stored metadata. Not part of
   * {@link ArtifactStorageProvider} — exposed for assertions in tests.
   */
  list(): ArtifactMetadata[] {
    return Array.from(this.entries.values(), (entry) => entry.metadata);
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

function makeKey(artifactId: string, filename: string): string {
  return `${artifactId}/${filename}`;
}

async function readAll(
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
