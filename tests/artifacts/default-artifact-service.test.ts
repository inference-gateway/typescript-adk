import { describe, expect, it } from 'vitest';
import {
  ArtifactStorageError,
  ArtifactValidationError,
  DefaultArtifactService,
  InMemoryArtifactStorage,
} from '../../src/artifacts/index.js';
import type { Artifact, Task } from '../../src/types/generated/a2a.js';

let counter = 0;
function nextId(): string {
  counter += 1;
  return `artifact-${counter}`;
}

function makeService(opts: { idGenerator?: () => string } = {}): {
  service: DefaultArtifactService;
  storage: InMemoryArtifactStorage;
} {
  const storage = new InMemoryArtifactStorage({
    baseUrl: 'https://example.test/artifacts',
  });
  const service = new DefaultArtifactService({
    storage,
    idGenerator: opts.idGenerator ?? nextId,
  });
  return { service, storage };
}

describe('DefaultArtifactService.createTextArtifact', () => {
  it('mints a server-side id and wraps text as a single text part', () => {
    const { service } = makeService({ idGenerator: () => 'a-1' });
    const artifact = service.createTextArtifact(
      'summary',
      'final answer',
      'hello world'
    );

    expect(artifact.artifactId).toBe('a-1');
    expect(artifact.name).toBe('summary');
    expect(artifact.description).toBe('final answer');
    expect(artifact.parts).toEqual([{ text: 'hello world' }]);
  });

  it('omits name/description when empty (treats empty string as absent)', () => {
    const { service } = makeService({ idGenerator: () => 'a-2' });
    const artifact = service.createTextArtifact('', '', 'just text');

    expect(artifact.name).toBeUndefined();
    expect(artifact.description).toBeUndefined();
    expect(artifact.artifactId).toBe('a-2');
  });

  it('ignores any client-supplied artifactId (server mints its own)', () => {
    // The API does not even accept an id - this test documents the contract.
    const { service } = makeService({ idGenerator: () => 'server-minted' });
    const a = service.createTextArtifact('n', 'd', 'x');
    expect(a.artifactId).toBe('server-minted');
  });
});

describe('DefaultArtifactService.createFileArtifact', () => {
  it('stores bytes through the provider and references the returned URI', async () => {
    const { service, storage } = makeService({ idGenerator: () => 'file-1' });
    const data = new TextEncoder().encode('hello bytes');

    const artifact = await service.createFileArtifact(
      'screenshot',
      'a screenshot',
      'image.png',
      data
    );

    expect(artifact.artifactId).toBe('file-1');
    expect(artifact.parts).toHaveLength(1);
    const file = artifact.parts[0]?.file;
    expect(file).toBeDefined();
    expect(file?.name).toBe('image.png');
    expect(file?.mediaType).toBe('image/png');
    expect(file?.fileWithUri).toBe(
      'https://example.test/artifacts/file-1/image.png'
    );

    // Storage actually received the bytes
    expect(await storage.exists('file-1', 'image.png')).toBe(true);
    const list = storage.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.size).toBe(data.byteLength);
    expect(list[0]?.contentType).toBe('image/png');
  });

  it('falls back to application/octet-stream when extension is unknown', async () => {
    const { service } = makeService({ idGenerator: () => 'file-2' });
    const artifact = await service.createFileArtifact(
      'blob',
      '',
      'mystery.xyz',
      new Uint8Array([1, 2, 3])
    );
    expect(artifact.parts[0]?.file?.mediaType).toBe('application/octet-stream');
  });

  it('honours an explicit mimeType over extension inference', async () => {
    const { service } = makeService({ idGenerator: () => 'file-3' });
    const artifact = await service.createFileArtifact(
      'doc',
      '',
      'index.html',
      new Uint8Array(),
      { mimeType: 'application/xhtml+xml' }
    );
    expect(artifact.parts[0]?.file?.mediaType).toBe('application/xhtml+xml');
  });

  it('wraps storage failures in ArtifactStorageError with the cause set', async () => {
    class FailingStorage extends InMemoryArtifactStorage {
      override async store(): Promise<string> {
        throw new Error('disk full');
      }
    }
    const storage = new FailingStorage();
    const service = new DefaultArtifactService({
      storage,
      idGenerator: () => 'file-4',
    });

    await expect(
      service.createFileArtifact('x', '', 'a.txt', new Uint8Array())
    ).rejects.toBeInstanceOf(ArtifactStorageError);
  });
});

describe('DefaultArtifactService.createFileArtifactFromURI', () => {
  it('builds a FilePart referencing the URI without storing anything', () => {
    const { service, storage } = makeService({ idGenerator: () => 'uri-1' });

    const artifact = service.createFileArtifactFromURI(
      'remote',
      'externally hosted',
      'report.pdf',
      'https://s3.example/bucket/report.pdf',
      { mimeType: 'application/pdf' }
    );

    expect(artifact.artifactId).toBe('uri-1');
    expect(artifact.parts[0]?.file).toEqual({
      name: 'report.pdf',
      mediaType: 'application/pdf',
      fileWithUri: 'https://s3.example/bucket/report.pdf',
    });
    expect(storage.list()).toHaveLength(0);
  });

  it('infers mediaType from filename extension when not given', () => {
    const { service } = makeService();
    const artifact = service.createFileArtifactFromURI(
      'n',
      '',
      'report.csv',
      'https://example/report.csv'
    );
    expect(artifact.parts[0]?.file?.mediaType).toBe('text/csv');
  });

  it('defaults to application/octet-stream for unknown extensions', () => {
    const { service } = makeService();
    const artifact = service.createFileArtifactFromURI(
      'n',
      '',
      'file.unknown',
      'https://example/file'
    );
    expect(artifact.parts[0]?.file?.mediaType).toBe('application/octet-stream');
  });
});

describe('DefaultArtifactService.createDataArtifact', () => {
  it('wraps a struct payload as a DataPart', () => {
    const { service } = makeService({ idGenerator: () => 'data-1' });
    const artifact = service.createDataArtifact('metrics', 'measurements', {
      count: 42,
    });
    expect(artifact.artifactId).toBe('data-1');
    expect(artifact.parts).toEqual([{ data: { data: { count: 42 } } }]);
  });

  it('shallow-copies the payload so caller mutations do not leak in', () => {
    const { service } = makeService();
    const payload = { count: 1 };
    const artifact = service.createDataArtifact('n', 'd', payload);
    payload.count = 999;
    expect(artifact.parts[0]?.data?.data).toEqual({ count: 1 });
  });

  it('throws ArtifactValidationError for non-object payloads', () => {
    const { service } = makeService();
    expect(() =>
      service.createDataArtifact('n', 'd', null as unknown as object)
    ).toThrow(ArtifactValidationError);
  });
});

describe('DefaultArtifactService.createMultiPartArtifact', () => {
  it('accepts a heterogeneous parts array verbatim', () => {
    const { service } = makeService({ idGenerator: () => 'multi-1' });
    const artifact = service.createMultiPartArtifact('n', 'd', [
      { text: 'hello' },
      {
        file: {
          name: 'a.txt',
          mediaType: 'text/plain',
          fileWithUri: 'https://example/a.txt',
        },
      },
    ]);
    expect(artifact.parts).toHaveLength(2);
    expect(artifact.parts[0]?.text).toBe('hello');
    expect(artifact.parts[1]?.file?.name).toBe('a.txt');
  });

  it('rejects an empty parts array', () => {
    const { service } = makeService();
    expect(() => service.createMultiPartArtifact('n', 'd', [])).toThrow(
      ArtifactValidationError
    );
  });

  it('rejects a part with no populated field', () => {
    const { service } = makeService();
    expect(() => service.createMultiPartArtifact('n', 'd', [{}])).toThrow(
      ArtifactValidationError
    );
  });

  it('rejects a part with more than one populated field', () => {
    const { service } = makeService();
    expect(() =>
      service.createMultiPartArtifact('n', 'd', [
        { text: 'x', data: { data: { y: 1 } } },
      ])
    ).toThrow(ArtifactValidationError);
  });

  it('rejects a file part missing both bytes and uri', () => {
    const { service } = makeService();
    expect(() =>
      service.createMultiPartArtifact('n', 'd', [
        { file: { name: 'a', mediaType: 'text/plain' } },
      ])
    ).toThrow(ArtifactValidationError);
  });
});

describe('DefaultArtifactService.getArtifactByID', () => {
  function taskWithArtifacts(artifacts: Artifact[]): Task {
    return {
      id: 't',
      contextId: 'c',
      status: { state: 'TASK_STATE_WORKING' },
      artifacts,
    };
  }

  it('returns the matching artifact', () => {
    const { service } = makeService();
    const task = taskWithArtifacts([
      { artifactId: 'a', parts: [{ text: 'x' }] },
      { artifactId: 'b', parts: [{ text: 'y' }] },
    ]);
    expect(service.getArtifactByID(task, 'b')?.artifactId).toBe('b');
  });

  it('returns undefined when not found', () => {
    const { service } = makeService();
    const task = taskWithArtifacts([
      { artifactId: 'a', parts: [{ text: 'x' }] },
    ]);
    expect(service.getArtifactByID(task, 'missing')).toBeUndefined();
  });

  it('returns undefined for empty artifactId (rejects untrusted input)', () => {
    const { service } = makeService();
    const task = taskWithArtifacts([
      { artifactId: '', parts: [{ text: 'x' }] },
    ]);
    expect(service.getArtifactByID(task, '')).toBeUndefined();
  });

  it('handles task with no artifacts gracefully', () => {
    const { service } = makeService();
    const task: Task = {
      id: 't',
      contextId: 'c',
      status: { state: 'TASK_STATE_WORKING' },
    };
    expect(service.getArtifactByID(task, 'a')).toBeUndefined();
  });
});

describe('DefaultArtifactService.getArtifactsByType', () => {
  function task(): Task {
    return {
      id: 't',
      contextId: 'c',
      status: { state: 'TASK_STATE_WORKING' },
      artifacts: [
        { artifactId: 'a-text', parts: [{ text: 'x' }] },
        {
          artifactId: 'a-file',
          parts: [
            {
              file: {
                name: 'a',
                mediaType: 'text/plain',
                fileWithUri: 'https://example',
              },
            },
          ],
        },
        { artifactId: 'a-data', parts: [{ data: { data: { x: 1 } } }] },
        {
          artifactId: 'a-mixed',
          parts: [{ text: 'y' }, { data: { data: { x: 2 } } }],
        },
      ],
    };
  }

  it('returns artifacts that contain a text part', () => {
    const { service } = makeService();
    expect(
      service.getArtifactsByType(task(), 'text').map((a) => a.artifactId)
    ).toEqual(['a-text', 'a-mixed']);
  });

  it('returns artifacts that contain a file part', () => {
    const { service } = makeService();
    expect(
      service.getArtifactsByType(task(), 'file').map((a) => a.artifactId)
    ).toEqual(['a-file']);
  });

  it('returns artifacts that contain a data part', () => {
    const { service } = makeService();
    expect(
      service.getArtifactsByType(task(), 'data').map((a) => a.artifactId)
    ).toEqual(['a-data', 'a-mixed']);
  });
});

describe('DefaultArtifactService.validateArtifact', () => {
  it('passes for a well-formed text artifact', () => {
    const { service } = makeService();
    expect(() =>
      service.validateArtifact({ artifactId: 'a', parts: [{ text: 'x' }] })
    ).not.toThrow();
  });

  it('rejects empty artifactId', () => {
    const { service } = makeService();
    expect(() =>
      service.validateArtifact({ artifactId: '', parts: [{ text: 'x' }] })
    ).toThrowError(/non-empty artifactId/);
  });

  it('rejects empty parts array', () => {
    const { service } = makeService();
    expect(() =>
      service.validateArtifact({ artifactId: 'a', parts: [] })
    ).toThrowError(/at least one part/);
  });

  it('reports the offending part index in the error field', () => {
    const { service } = makeService();
    try {
      service.validateArtifact({
        artifactId: 'a',
        parts: [{ text: 'ok' }, { text: '' }],
      });
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ArtifactValidationError);
      const validationError = error as ArtifactValidationError;
      expect(validationError.field).toBe('parts[1].text');
    }
  });
});

describe('DefaultArtifactService.getMimeTypeFromExtension', () => {
  it.each([
    ['report.pdf', 'application/pdf'],
    ['IMAGE.PNG', 'image/png'],
    ['nested/path/file.JPG', 'image/jpeg'],
    ['archive.zip', 'application/zip'],
  ])('infers %s as %s', (filename, expected) => {
    const { service } = makeService();
    expect(service.getMimeTypeFromExtension(filename)).toBe(expected);
  });

  it('returns undefined for unknown extensions', () => {
    const { service } = makeService();
    expect(service.getMimeTypeFromExtension('mystery.xyz')).toBeUndefined();
  });

  it('returns undefined when filename has no extension', () => {
    const { service } = makeService();
    expect(service.getMimeTypeFromExtension('README')).toBeUndefined();
  });

  it('does not treat dot in a directory as an extension', () => {
    const { service } = makeService();
    expect(service.getMimeTypeFromExtension('foo.bar/baz')).toBeUndefined();
  });
});

describe('DefaultArtifactService.createTaskArtifactUpdateEvent', () => {
  it('emits an event with mandatory fields populated', () => {
    const { service } = makeService();
    const artifact: Artifact = { artifactId: 'a', parts: [{ text: 'x' }] };
    const event = service.createTaskArtifactUpdateEvent('t', 'c', artifact);

    expect(event.taskId).toBe('t');
    expect(event.contextId).toBe('c');
    expect(event.artifact).toBe(artifact);
    expect(event.append).toBeUndefined();
    expect(event.lastChunk).toBeUndefined();
    expect(event.metadata).toBeUndefined();
  });

  it('forwards optional flags when provided', () => {
    const { service } = makeService();
    const artifact: Artifact = { artifactId: 'a', parts: [{ text: 'x' }] };
    const event = service.createTaskArtifactUpdateEvent('t', 'c', artifact, {
      append: true,
      lastChunk: false,
      metadata: { source: 'tool' },
    });
    expect(event.append).toBe(true);
    expect(event.lastChunk).toBe(false);
    expect(event.metadata).toEqual({ source: 'tool' });
  });
});

describe('DefaultArtifactService storage delegation', () => {
  it('exists/retrieve round-trip stored bytes', async () => {
    const { service } = makeService({ idGenerator: () => 'rt-1' });
    const original = new TextEncoder().encode('round trip');
    const artifact = await service.createFileArtifact(
      'n',
      'd',
      'data.bin',
      original
    );

    expect(await service.exists(artifact.artifactId, 'data.bin')).toBe(true);
    const stream = await service.retrieve(artifact.artifactId, 'data.bin');
    const reader = stream.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    expect(value !== undefined ? Array.from(value) : null).toEqual(
      Array.from(original)
    );
  });

  it('retrieve wraps unknown errors in ArtifactStorageError', async () => {
    class WeirdStorage extends InMemoryArtifactStorage {
      override async retrieve(): Promise<ReadableStream<Uint8Array>> {
        throw new TypeError('weird');
      }
    }
    const service = new DefaultArtifactService({ storage: new WeirdStorage() });
    await expect(service.retrieve('a', 'b')).rejects.toBeInstanceOf(
      ArtifactStorageError
    );
  });

  it('cleanupExpired removes files older than maxAgeMs', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const storage = new InMemoryArtifactStorage({ now: () => now });
    const service = new DefaultArtifactService({
      storage,
      idGenerator: nextId,
    });

    await service.createFileArtifact(
      'old',
      '',
      'old.txt',
      new TextEncoder().encode('old')
    );
    // Advance 10 minutes
    now = new Date(now.getTime() + 10 * 60 * 1000);
    await service.createFileArtifact(
      'new',
      '',
      'new.txt',
      new TextEncoder().encode('new')
    );

    // Cleanup anything older than 5 minutes
    const removed = await service.cleanupExpired(5 * 60 * 1000);
    expect(removed).toBe(1);
    expect(storage.list().map((m) => m.filename)).toEqual(['new.txt']);
  });

  it('cleanupOldest keeps the N most recent files per artifact id', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const storage = new InMemoryArtifactStorage({ now: () => now });
    let id = 'shared';
    const service = new DefaultArtifactService({
      storage,
      idGenerator: () => id,
    });

    for (const i of [1, 2, 3, 4]) {
      now = new Date(now.getTime() + 1000);
      await service.createFileArtifact(
        'n',
        '',
        `file-${i}.txt`,
        new TextEncoder().encode(`${i}`)
      );
    }
    // Different artifact id - should be untouched by per-id cap of 2
    id = 'other';
    await service.createFileArtifact(
      'n',
      '',
      'other.txt',
      new TextEncoder().encode('other')
    );

    const removed = await service.cleanupOldest(2);
    expect(removed).toBe(2);
    const filenames = storage
      .list()
      .map((m) => m.filename)
      .sort();
    expect(filenames).toEqual(['file-3.txt', 'file-4.txt', 'other.txt']);
  });

  it('close releases the storage', async () => {
    const { service, storage } = makeService();
    await service.close();
    await expect(storage.exists('a', 'b')).rejects.toBeInstanceOf(
      ArtifactStorageError
    );
  });
});
