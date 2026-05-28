import { describe, expect, it } from 'vitest';
import {
  ArtifactStorageError,
  InMemoryArtifactStorage,
} from '../../src/artifacts/index.js';

async function streamToBytes(
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: number[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) {
      chunks.push(...value);
    }
  }
  reader.releaseLock();
  return new Uint8Array(chunks);
}

describe('InMemoryArtifactStorage', () => {
  it('store -> retrieve round-trip preserves bytes', async () => {
    const storage = new InMemoryArtifactStorage();
    const original = new TextEncoder().encode('hello world');
    const url = await storage.store(
      'a',
      'file.bin',
      original,
      'application/octet-stream'
    );
    expect(url).toContain('a/file.bin');

    const stream = await storage.retrieve('a', 'file.bin');
    const bytes = await streamToBytes(stream);
    expect(new TextDecoder().decode(bytes)).toBe('hello world');
  });

  it('copies input bytes so caller mutation does not leak in', async () => {
    const storage = new InMemoryArtifactStorage();
    const original = new Uint8Array([1, 2, 3]);
    await storage.store('a', 'f', original, 'application/octet-stream');
    original[0] = 99;

    const bytes = await streamToBytes(await storage.retrieve('a', 'f'));
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it('reads streamed input fully into memory', async () => {
    const storage = new InMemoryArtifactStorage();
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    });
    await storage.store('a', 'f', stream, 'application/octet-stream');
    const bytes = await streamToBytes(await storage.retrieve('a', 'f'));
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
  });

  it('exists returns true for stored and false for unknown', async () => {
    const storage = new InMemoryArtifactStorage();
    await storage.store('a', 'f', new Uint8Array(), 'application/octet-stream');
    expect(await storage.exists('a', 'f')).toBe(true);
    expect(await storage.exists('a', 'missing')).toBe(false);
    expect(await storage.exists('missing', 'f')).toBe(false);
  });

  it('delete removes the file', async () => {
    const storage = new InMemoryArtifactStorage();
    await storage.store('a', 'f', new Uint8Array(), 'application/octet-stream');
    await storage.delete('a', 'f');
    expect(await storage.exists('a', 'f')).toBe(false);
  });

  it('delete is idempotent for unknown keys', async () => {
    const storage = new InMemoryArtifactStorage();
    await expect(storage.delete('nope', 'nope')).resolves.toBeUndefined();
  });

  it('retrieve throws ArtifactStorageError when not found', async () => {
    const storage = new InMemoryArtifactStorage();
    await expect(storage.retrieve('a', 'missing')).rejects.toBeInstanceOf(
      ArtifactStorageError
    );
  });

  it('getUrl URL-encodes special characters in artifactId and filename', () => {
    const storage = new InMemoryArtifactStorage({
      baseUrl: 'https://example.test/files',
    });
    const url = storage.getUrl('id with space', 'name with space.txt');
    expect(url).toBe(
      'https://example.test/files/id%20with%20space/name%20with%20space.txt'
    );
  });

  it('strips trailing slashes from baseUrl', () => {
    const storage = new InMemoryArtifactStorage({
      baseUrl: 'https://example/files///',
    });
    expect(storage.getUrl('a', 'b')).toBe('https://example/files/a/b');
  });

  it('honours an aborted AbortSignal', async () => {
    const storage = new InMemoryArtifactStorage();
    const controller = new AbortController();
    controller.abort(new Error('boom'));
    await expect(
      storage.store(
        'a',
        'f',
        new Uint8Array(),
        'application/octet-stream',
        controller.signal
      )
    ).rejects.toBeInstanceOf(ArtifactStorageError);
  });

  it('cleanupExpired removes files older than the cutoff', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const storage = new InMemoryArtifactStorage({ now: () => now });

    await storage.store(
      'a',
      'old.txt',
      new TextEncoder().encode('old'),
      'text/plain'
    );
    now = new Date(now.getTime() + 10 * 60 * 1000);
    await storage.store(
      'a',
      'new.txt',
      new TextEncoder().encode('new'),
      'text/plain'
    );

    const removed = await storage.cleanupExpired(5 * 60 * 1000);
    expect(removed).toBe(1);
    expect(storage.list().map((m) => m.filename)).toEqual(['new.txt']);
  });

  it('cleanupOldest with maxCount <= 0 wipes the store', async () => {
    const storage = new InMemoryArtifactStorage();
    await storage.store(
      'a',
      'f1',
      new Uint8Array(),
      'application/octet-stream'
    );
    await storage.store(
      'a',
      'f2',
      new Uint8Array(),
      'application/octet-stream'
    );

    const removed = await storage.cleanupOldest(0);
    expect(removed).toBe(2);
    expect(storage.list()).toHaveLength(0);
  });

  it('cleanupOldest keeps maxCount most recent files per artifactId', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const storage = new InMemoryArtifactStorage({ now: () => now });
    for (const i of [1, 2, 3]) {
      now = new Date(now.getTime() + 1000);
      await storage.store(
        'shared',
        `f-${i}.txt`,
        new Uint8Array(),
        'text/plain'
      );
    }

    now = new Date(now.getTime() + 1000);
    await storage.store('other', 'o.txt', new Uint8Array(), 'text/plain');

    const removed = await storage.cleanupOldest(1);
    expect(removed).toBe(2);
    const keys = storage
      .list()
      .map((m) => `${m.artifactId}/${m.filename}`)
      .sort();
    expect(keys).toEqual(['other/o.txt', 'shared/f-3.txt']);
  });

  it('close clears the store and blocks subsequent operations', async () => {
    const storage = new InMemoryArtifactStorage();
    await storage.store('a', 'f', new Uint8Array(), 'application/octet-stream');
    await storage.close();
    expect(storage.list()).toHaveLength(0);
    await expect(storage.exists('a', 'f')).rejects.toBeInstanceOf(
      ArtifactStorageError
    );
  });
});
