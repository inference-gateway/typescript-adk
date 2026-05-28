import { createReadStream, createWriteStream } from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ArtifactStorageError } from './artifact-service.js';
import type {
  ArtifactMetadata,
  ArtifactStorageProvider,
} from './artifact-storage.js';

/**
 * Default pattern enforced on `artifactId` before any disk operation. Accepts
 * UUIDs, hex digests, and similarly opaque tokens (alphanumerics, `_`, `-`,
 * 1–255 chars). Rejects anything that could escape the artifact directory:
 * path separators, `..`, leading dots, whitespace.
 *
 * Override via {@link FilesystemArtifactStorageOptions.artifactIdPattern} for
 * stricter schemes (e.g., `/^[0-9a-f]{32}$/` for fixed-length hex).
 */
export const DEFAULT_ARTIFACT_ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;

/**
 * Suffix used for sidecar metadata files. Reserved — filenames ending in this
 * suffix are rejected at {@link FilesystemArtifactStorage.store} time so user
 * uploads cannot shadow a sidecar.
 */
export const METADATA_SUFFIX = '.adk-meta.json';

/**
 * Default permissions applied to artifact directories. Owner-only (rwx------)
 * keeps stored content out of reach of other users on shared hosts.
 */
export const DEFAULT_DIRECTORY_MODE = 0o700;

/**
 * Default permissions applied to artifact files and their sidecars. Owner
 * read/write only (rw-------).
 */
export const DEFAULT_FILE_MODE = 0o600;

/**
 * Construction options for {@link FilesystemArtifactStorage}.
 */
export interface FilesystemArtifactStorageOptions {
  /**
   * Absolute or relative directory under which artifacts are persisted.
   * Resolved against `process.cwd()` at construction time; created lazily on
   * the first storage operation with `directoryMode`.
   *
   * Refused: empty string and the filesystem root (`/`) — passing either
   * throws {@link ArtifactStorageError} at construction.
   */
  readonly root: string;
  /**
   * Base URL the storage will use to compose public download URLs.
   * Trailing slashes are stripped. Defaults to `'file://artifacts'`, which
   * is intentionally not a usable HTTP URL — production deployments should
   * pass the gateway's public origin (e.g., `https://agent.example.com/artifacts`).
   */
  readonly baseUrl?: string;
  /**
   * Pattern every `artifactId` must match. Defaults to
   * {@link DEFAULT_ARTIFACT_ID_PATTERN}. Tighten to `/^[0-9a-f]{32}$/` (hex
   * digest), `/^[0-9a-f-]{36}$/` (UUID with dashes), etc. as appropriate.
   */
  readonly artifactIdPattern?: RegExp;
  /**
   * Mode for directories created by the storage. Defaults to
   * {@link DEFAULT_DIRECTORY_MODE} (`0o700`). Subject to the process umask.
   */
  readonly directoryMode?: number;
  /**
   * Mode for data files and metadata sidecars. Defaults to
   * {@link DEFAULT_FILE_MODE} (`0o600`). Subject to the process umask.
   */
  readonly fileMode?: number;
  /**
   * Clock injection for sidecar `uploadedAt` stamps. Defaults to
   * `() => new Date()`. Used by tests to make `cleanupExpired` deterministic.
   */
  readonly now?: () => Date;
}

interface SidecarShape {
  readonly contentType: string;
  readonly uploadedAt: string;
}

/**
 * Filesystem-backed {@link ArtifactStorageProvider}.
 *
 * Layout on disk:
 *
 * ```
 * <root>/<artifactId>/<filename>                 // payload, mode 0o600
 * <root>/<artifactId>/<filename>.adk-meta.json   // sidecar, mode 0o600
 * ```
 *
 * Artifact directories are owner-only (`0o700`); the root is created lazily
 * on the first write. All `artifactId` values are gated by
 * {@link FilesystemArtifactStorageOptions.artifactIdPattern}, and every
 * resolved path is verified to live under `root` before any disk I/O —
 * defence in depth against path traversal even if the pattern is loosened.
 *
 * Bytes flow as streams: `store` accepts either a `Uint8Array` (single
 * `writeFile`) or a `ReadableStream<Uint8Array>` (piped via `node:stream`),
 * and `retrieve` returns a Web `ReadableStream<Uint8Array>` wrapped around
 * `createReadStream`. Nothing is buffered to memory beyond what Node's
 * default highWaterMark holds.
 *
 * Sidecar files capture the original `contentType` and `uploadedAt` so HTTP
 * download endpoints can set `Content-Type` accurately. When a sidecar is
 * missing (e.g., the data file was placed on disk by a non-ADK process),
 * `getMetadata` falls back to mtime + `application/octet-stream`.
 */
export class FilesystemArtifactStorage implements ArtifactStorageProvider {
  private readonly root: string;
  private readonly baseUrl: string;
  private readonly artifactIdPattern: RegExp;
  private readonly directoryMode: number;
  private readonly fileMode: number;
  private readonly now: () => Date;
  private closed = false;
  private rootReady: Promise<void> | undefined;

  constructor(options: FilesystemArtifactStorageOptions) {
    if (typeof options.root !== 'string' || options.root === '') {
      throw new ArtifactStorageError(
        'root directory must be a non-empty string'
      );
    }
    const resolvedRoot = resolve(options.root);
    if (resolvedRoot === sep || resolvedRoot === '') {
      throw new ArtifactStorageError(
        'root directory must not resolve to the filesystem root'
      );
    }
    this.root = resolvedRoot;
    const rawBase = options.baseUrl ?? 'file://artifacts';
    this.baseUrl = rawBase.replace(/\/+$/, '');
    this.artifactIdPattern =
      options.artifactIdPattern ?? DEFAULT_ARTIFACT_ID_PATTERN;
    this.directoryMode = options.directoryMode ?? DEFAULT_DIRECTORY_MODE;
    this.fileMode = options.fileMode ?? DEFAULT_FILE_MODE;
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
    const dataPath = this.safePath(artifactId, filename);
    const metaPath = `${dataPath}${METADATA_SUFFIX}`;

    await this.ensureRoot();
    await mkdir(dirname(dataPath), {
      recursive: true,
      mode: this.directoryMode,
    });

    try {
      if (data instanceof Uint8Array) {
        await writeFile(dataPath, data, { mode: this.fileMode, signal });
      } else {
        const writable = createWriteStream(dataPath, { mode: this.fileMode });
        const readable = Readable.fromWeb(
          data as unknown as Parameters<typeof Readable.fromWeb>[0]
        );
        const opts: { signal?: AbortSignal } = {};
        if (signal !== undefined) opts.signal = signal;
        await pipeline(readable, writable, opts);
      }
    } catch (cause) {
      await rm(dataPath, { force: true }).catch(noop);
      throw new ArtifactStorageError(
        `failed to write artifact ${artifactId}/${filename}`,
        { cause }
      );
    }

    const sidecar: SidecarShape = {
      contentType,
      uploadedAt: this.now().toISOString(),
    };
    try {
      await writeFile(metaPath, JSON.stringify(sidecar), {
        mode: this.fileMode,
      });
    } catch (cause) {
      await rm(dataPath, { force: true }).catch(noop);
      throw new ArtifactStorageError(
        `failed to write artifact metadata ${artifactId}/${filename}`,
        { cause }
      );
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
    const dataPath = this.safePath(artifactId, filename);
    try {
      await stat(dataPath);
    } catch (cause) {
      throw new ArtifactStorageError(
        `artifact ${artifactId}/${filename} not found`,
        { cause }
      );
    }
    const node = createReadStream(dataPath);
    if (signal !== undefined) {
      const onAbort = (): void => {
        node.destroy(new Error('aborted'));
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
        node.once('close', () => signal.removeEventListener('abort', onAbort));
      }
    }
    return Readable.toWeb(node) as ReadableStream<Uint8Array>;
  }

  async delete(
    artifactId: string,
    filename: string,
    signal?: AbortSignal
  ): Promise<void> {
    this.ensureOpen();
    this.assertNotAborted(signal);
    const dataPath = this.safePath(artifactId, filename);
    const metaPath = `${dataPath}${METADATA_SUFFIX}`;
    await rm(dataPath, { force: true });
    await rm(metaPath, { force: true });
    await this.removeIfEmpty(dirname(dataPath));
  }

  async exists(
    artifactId: string,
    filename: string,
    signal?: AbortSignal
  ): Promise<boolean> {
    this.ensureOpen();
    this.assertNotAborted(signal);
    const dataPath = this.safePath(artifactId, filename);
    try {
      await stat(dataPath);
      return true;
    } catch {
      return false;
    }
  }

  async getMetadata(
    artifactId: string,
    filename: string,
    signal?: AbortSignal
  ): Promise<ArtifactMetadata | undefined> {
    this.ensureOpen();
    this.assertNotAborted(signal);
    const dataPath = this.safePath(artifactId, filename);
    let stats;
    try {
      stats = await stat(dataPath);
    } catch {
      return undefined;
    }
    const sidecar = await this.readSidecar(`${dataPath}${METADATA_SUFFIX}`);
    return {
      artifactId,
      filename,
      size: stats.size,
      contentType: sidecar?.contentType ?? 'application/octet-stream',
      uploadedAt: sidecar?.uploadedAt
        ? new Date(sidecar.uploadedAt)
        : stats.mtime,
    };
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
    for (const entry of await this.scan()) {
      this.assertNotAborted(signal);
      if (entry.uploadedAt < cutoff) {
        await this.removeEntry(entry);
        removed += 1;
      }
    }
    return removed;
  }

  async cleanupOldest(maxCount: number, signal?: AbortSignal): Promise<number> {
    this.ensureOpen();
    this.assertNotAborted(signal);
    const entries = await this.scan();
    if (maxCount <= 0) {
      for (const entry of entries) {
        this.assertNotAborted(signal);
        await this.removeEntry(entry);
      }
      return entries.length;
    }
    const byArtifact = new Map<string, ScannedEntry[]>();
    for (const entry of entries) {
      const list = byArtifact.get(entry.artifactId) ?? [];
      list.push(entry);
      byArtifact.set(entry.artifactId, list);
    }
    let removed = 0;
    for (const list of byArtifact.values()) {
      list.sort((a, b) => b.uploadedAt - a.uploadedAt);
      for (const stale of list.slice(maxCount)) {
        this.assertNotAborted(signal);
        await this.removeEntry(stale);
        removed += 1;
      }
    }
    return removed;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private async ensureRoot(): Promise<void> {
    if (this.rootReady === undefined) {
      this.rootReady = (async (): Promise<void> => {
        await mkdir(this.root, {
          recursive: true,
          mode: this.directoryMode,
        });
      })();
    }
    return this.rootReady;
  }

  private safePath(artifactId: string, filename: string): string {
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
      filename === '..' ||
      filename.endsWith(METADATA_SUFFIX)
    ) {
      throw new ArtifactStorageError(
        `invalid filename: must be a non-empty path-safe string`
      );
    }
    const target = resolve(join(this.root, artifactId, filename));
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new ArtifactStorageError(`resolved path escapes storage root`);
    }
    return target;
  }

  private async readSidecar(path: string): Promise<SidecarShape | undefined> {
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        typeof (parsed as Record<string, unknown>)['contentType'] === 'string'
      ) {
        const record = parsed as Record<string, unknown>;
        const uploadedAt =
          typeof record['uploadedAt'] === 'string'
            ? (record['uploadedAt'] as string)
            : new Date(0).toISOString();
        return {
          contentType: record['contentType'] as string,
          uploadedAt,
        };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private async scan(): Promise<ScannedEntry[]> {
    let artifactDirs: string[];
    try {
      const entries = await readdir(this.root, { withFileTypes: true });
      artifactDirs = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    const results: ScannedEntry[] = [];
    for (const artifactId of artifactDirs) {
      if (!this.artifactIdPattern.test(artifactId)) continue;
      const dir = join(this.root, artifactId);
      let files: string[];
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        files = entries
          .filter(
            (entry) => entry.isFile() && !entry.name.endsWith(METADATA_SUFFIX)
          )
          .map((entry) => entry.name);
      } catch {
        continue;
      }
      for (const filename of files) {
        const dataPath = join(dir, filename);
        try {
          const stats = await stat(dataPath);
          results.push({
            artifactId,
            filename,
            dataPath,
            metaPath: `${dataPath}${METADATA_SUFFIX}`,
            uploadedAt: stats.mtimeMs,
          });
        } catch {
          // ignore files that disappeared mid-scan
        }
      }
    }
    return results;
  }

  private async removeEntry(entry: ScannedEntry): Promise<void> {
    await rm(entry.dataPath, { force: true });
    await rm(entry.metaPath, { force: true });
    await this.removeIfEmpty(dirname(entry.dataPath));
  }

  private async removeIfEmpty(dir: string): Promise<void> {
    if (dir === this.root) return;
    try {
      const remaining = await readdir(dir);
      if (remaining.length === 0) {
        await rm(dir, { recursive: false, force: true });
      }
    } catch {
      // directory already gone; nothing to do
    }
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

interface ScannedEntry {
  readonly artifactId: string;
  readonly filename: string;
  readonly dataPath: string;
  readonly metaPath: string;
  readonly uploadedAt: number;
}

function noop(): void {
  // intentionally empty
}
