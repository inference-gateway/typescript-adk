import type {
  Artifact,
  DataPart,
  FilePart,
  Part,
  Struct,
  Task,
  TaskArtifactUpdateEvent,
} from '../types/generated/a2a.js';
import {
  type ArtifactService,
  ArtifactStorageError,
  ArtifactValidationError,
  type CreateFileArtifactFromURIOptions,
  type CreateFileArtifactOptions,
  type TaskArtifactUpdateEventOptions,
} from './artifact-service.js';
import type { ArtifactStorageProvider } from './artifact-storage.js';

/**
 * Construction options for {@link DefaultArtifactService}.
 */
export interface DefaultArtifactServiceOptions {
  /**
   * Storage backend that owns artifact byte persistence. Required.
   */
  readonly storage: ArtifactStorageProvider;
  /**
   * Override the artifact-id generator (e.g., for deterministic tests).
   * Defaults to {@link crypto.randomUUID}. Callers should not use this to
   * accept client-supplied IDs — that defeats the server-mints-IDs guarantee.
   */
  readonly idGenerator?: () => string;
}

/**
 * MIME-type map for file-extension inference. Kept verbatim from the Go ADK
 * (`adk/server/artifacts_service.go:GetMimeTypeFromExtension`) so artifacts
 * round-trip with consistent media types across languages.
 */
const MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
});

const DEFAULT_MIME_TYPE = 'application/octet-stream';

/**
 * Default {@link ArtifactService} implementation.
 *
 * Stateless apart from the injected storage provider — every `create*` call
 * is independent. Construct one per process; share it across handlers.
 *
 * @example
 * ```ts
 * const service = new DefaultArtifactService({
 *   storage: new InMemoryArtifactStorage(),
 * });
 * const artifact = service.createTextArtifact('summary', 'final answer', 'hello');
 * ```
 */
export class DefaultArtifactService implements ArtifactService {
  private readonly storage: ArtifactStorageProvider;
  private readonly newId: () => string;

  constructor(options: DefaultArtifactServiceOptions) {
    this.storage = options.storage;
    this.newId = options.idGenerator ?? ((): string => crypto.randomUUID());
  }

  createTextArtifact(
    name: string,
    description: string,
    text: string
  ): Artifact {
    return this.buildArtifact(name, description, [{ text }]);
  }

  async createFileArtifact(
    name: string,
    description: string,
    filename: string,
    data: Uint8Array,
    options: CreateFileArtifactOptions = {}
  ): Promise<Artifact> {
    const artifactId = this.newId();
    const mediaType = this.resolveMimeType(filename, options.mimeType);

    let uri: string;
    try {
      uri = await this.storage.store(
        artifactId,
        filename,
        data,
        mediaType,
        options.signal
      );
    } catch (cause) {
      throw new ArtifactStorageError(
        `failed to store artifact ${artifactId}/${filename}`,
        { cause }
      );
    }

    const filePart: FilePart = {
      name: filename,
      mediaType,
      fileWithUri: uri,
    };
    return this.buildArtifactWithId(artifactId, name, description, [
      { file: filePart },
    ]);
  }

  createFileArtifactFromURI(
    name: string,
    description: string,
    filename: string,
    uri: string,
    options: CreateFileArtifactFromURIOptions = {}
  ): Artifact {
    const mediaType = this.resolveMimeType(filename, options.mimeType);
    const filePart: FilePart = {
      name: filename,
      mediaType,
      fileWithUri: uri,
    };
    return this.buildArtifact(name, description, [{ file: filePart }]);
  }

  createDataArtifact(
    name: string,
    description: string,
    data: Struct
  ): Artifact {
    if (data === null || typeof data !== 'object') {
      throw new ArtifactValidationError(
        'data artifact requires a non-null object payload',
        { field: 'data' }
      );
    }
    const dataPart: DataPart = { data: { ...data } };
    return this.buildArtifact(name, description, [{ data: dataPart }]);
  }

  createMultiPartArtifact(
    name: string,
    description: string,
    parts: readonly Part[]
  ): Artifact {
    if (parts.length === 0) {
      throw new ArtifactValidationError(
        'multi-part artifact requires at least one part',
        { field: 'parts' }
      );
    }
    parts.forEach((part, index) => {
      this.validatePart(part, index);
    });
    return this.buildArtifact(name, description, parts.map(clonePart));
  }

  getArtifactByID(task: Task, artifactId: string): Artifact | undefined {
    if (artifactId === '') return undefined;
    for (const artifact of task.artifacts ?? []) {
      if (artifact.artifactId === artifactId) {
        return artifact;
      }
    }
    return undefined;
  }

  getArtifactsByType(
    task: Task,
    partKind: 'text' | 'file' | 'data'
  ): Artifact[] {
    const matches: Artifact[] = [];
    for (const artifact of task.artifacts ?? []) {
      if (artifactHasPartKind(artifact, partKind)) {
        matches.push(artifact);
      }
    }
    return matches;
  }

  validateArtifact(artifact: Artifact): void {
    if (typeof artifact.artifactId !== 'string' || artifact.artifactId === '') {
      throw new ArtifactValidationError(
        'artifact must have a non-empty artifactId',
        { field: 'artifactId' }
      );
    }
    if (!Array.isArray(artifact.parts) || artifact.parts.length === 0) {
      throw new ArtifactValidationError(
        'artifact must contain at least one part',
        { field: 'parts' }
      );
    }
    artifact.parts.forEach((part, index) => {
      this.validatePart(part, index);
    });
  }

  getMimeTypeFromExtension(filename: string): string | undefined {
    const ext = extensionOf(filename);
    return ext === '' ? undefined : MIME_TYPE_BY_EXTENSION[ext];
  }

  createTaskArtifactUpdateEvent(
    taskId: string,
    contextId: string,
    artifact: Artifact,
    options: TaskArtifactUpdateEventOptions = {}
  ): TaskArtifactUpdateEvent {
    const event: TaskArtifactUpdateEvent = {
      taskId,
      contextId,
      artifact,
    };
    if (options.append !== undefined) {
      event.append = options.append;
    }
    if (options.lastChunk !== undefined) {
      event.lastChunk = options.lastChunk;
    }
    if (options.metadata !== undefined) {
      event.metadata = options.metadata;
    }
    return event;
  }

  async exists(
    artifactId: string,
    filename: string,
    signal?: AbortSignal
  ): Promise<boolean> {
    return this.storage.exists(artifactId, filename, signal);
  }

  async retrieve(
    artifactId: string,
    filename: string,
    signal?: AbortSignal
  ): Promise<ReadableStream<Uint8Array>> {
    try {
      return await this.storage.retrieve(artifactId, filename, signal);
    } catch (cause) {
      if (cause instanceof ArtifactStorageError) {
        throw cause;
      }
      throw new ArtifactStorageError(
        `failed to retrieve artifact ${artifactId}/${filename}`,
        { cause }
      );
    }
  }

  async cleanupExpired(
    maxAgeMs: number,
    signal?: AbortSignal
  ): Promise<number> {
    return this.storage.cleanupExpired(maxAgeMs, signal);
  }

  async cleanupOldest(maxCount: number, signal?: AbortSignal): Promise<number> {
    return this.storage.cleanupOldest(maxCount, signal);
  }

  async close(): Promise<void> {
    await this.storage.close();
  }

  private resolveMimeType(
    filename: string,
    explicit: string | undefined
  ): string {
    if (typeof explicit === 'string' && explicit !== '') {
      return explicit;
    }
    const inferred = this.getMimeTypeFromExtension(filename);
    return inferred ?? DEFAULT_MIME_TYPE;
  }

  private buildArtifact(
    name: string,
    description: string,
    parts: Part[]
  ): Artifact {
    return this.buildArtifactWithId(this.newId(), name, description, parts);
  }

  private buildArtifactWithId(
    artifactId: string,
    name: string,
    description: string,
    parts: Part[]
  ): Artifact {
    const artifact: Artifact = {
      artifactId,
      parts,
    };
    if (name !== '') {
      artifact.name = name;
    }
    if (description !== '') {
      artifact.description = description;
    }
    return artifact;
  }

  private validatePart(part: Part, index: number): void {
    const populated = [part.text, part.file, part.data].filter(
      (value) => value !== undefined
    );
    if (populated.length === 0) {
      throw new ArtifactValidationError(
        `invalid part at index ${index}: must have one of text, file, or data`,
        { field: `parts[${index}]` }
      );
    }
    if (populated.length > 1) {
      throw new ArtifactValidationError(
        `invalid part at index ${index}: only one of text, file, or data may be set`,
        { field: `parts[${index}]` }
      );
    }
    if (part.text !== undefined && part.text === '') {
      throw new ArtifactValidationError(
        `invalid part at index ${index}: text content must be non-empty`,
        { field: `parts[${index}].text` }
      );
    }
    if (
      part.data !== undefined &&
      (part.data.data === null || typeof part.data.data !== 'object')
    ) {
      throw new ArtifactValidationError(
        `invalid part at index ${index}: data content must be a non-null object`,
        { field: `parts[${index}].data` }
      );
    }
    if (part.file !== undefined) {
      const file = part.file;
      if (
        (file.fileWithBytes === undefined || file.fileWithBytes === '') &&
        (file.fileWithUri === undefined || file.fileWithUri === '')
      ) {
        throw new ArtifactValidationError(
          `invalid part at index ${index}: file part must set fileWithBytes or fileWithUri`,
          { field: `parts[${index}].file` }
        );
      }
    }
  }
}

function artifactHasPartKind(
  artifact: Artifact,
  partKind: 'text' | 'file' | 'data'
): boolean {
  for (const part of artifact.parts ?? []) {
    if (partKind === 'text' && part.text !== undefined) return true;
    if (partKind === 'file' && part.file !== undefined) return true;
    if (partKind === 'data' && part.data !== undefined) return true;
  }
  return false;
}

function clonePart(part: Part): Part {
  const next: Part = {};
  if (part.text !== undefined) next.text = part.text;
  if (part.file !== undefined) next.file = { ...part.file };
  if (part.data !== undefined) next.data = { data: { ...part.data.data } };
  if (part.metadata !== undefined) next.metadata = { ...part.metadata };
  return next;
}

function extensionOf(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot < 0) return '';
  const lastSlash = Math.max(
    filename.lastIndexOf('/'),
    filename.lastIndexOf('\\')
  );
  if (lastDot < lastSlash) return '';
  return filename.slice(lastDot).toLowerCase();
}
