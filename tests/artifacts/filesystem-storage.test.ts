import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ArtifactStorageError,
  FilesystemArtifactStorage,
  METADATA_SUFFIX,
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

describe('FilesystemArtifactStorage', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'adk-fs-art-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('rejects construction with an empty root', () => {
    expect(() => new FilesystemArtifactStorage({ root: '' })).toThrow(
      ArtifactStorageError
    );
  });

  it('rejects construction when root resolves to the filesystem root', () => {
    expect(() => new FilesystemArtifactStorage({ root: '/' })).toThrow(
      ArtifactStorageError
    );
  });

  it('store + retrieve preserves bytes and content-type', async () => {
    const storage = new FilesystemArtifactStorage({ root });
    const original = new TextEncoder().encode('hello world');
    const url = await storage.store(
      'abc-123',
      'hello.txt',
      original,
      'text/plain'
    );
    expect(url).toContain('abc-123/hello.txt');

    const meta = await storage.getMetadata('abc-123', 'hello.txt');
    expect(meta?.contentType).toBe('text/plain');
    expect(meta?.size).toBe(original.byteLength);

    const stream = await storage.retrieve('abc-123', 'hello.txt');
    const bytes = await streamToBytes(stream);
    expect(new TextDecoder().decode(bytes)).toBe('hello world');
  });

  it('writes data and sidecar files with the configured mode (0o600 default)', async () => {
    const storage = new FilesystemArtifactStorage({ root });
    await storage.store(
      'abc',
      'x.bin',
      new Uint8Array([1, 2, 3]),
      'application/octet-stream'
    );

    const dataStat = await stat(join(root, 'abc', 'x.bin'));
    const metaStat = await stat(join(root, 'abc', `x.bin${METADATA_SUFFIX}`));
    expect(dataStat.mode & 0o777).toBe(0o600);
    expect(metaStat.mode & 0o777).toBe(0o600);
  });

  it('accepts a ReadableStream payload and concatenates chunks', async () => {
    const storage = new FilesystemArtifactStorage({ root });
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    });
    await storage.store(
      'abc',
      'streamed.bin',
      stream,
      'application/octet-stream'
    );
    const bytes = await streamToBytes(
      await storage.retrieve('abc', 'streamed.bin')
    );
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
  });

  it('exists returns true for stored files and false otherwise', async () => {
    const storage = new FilesystemArtifactStorage({ root });
    await storage.store(
      'abc',
      'f',
      new Uint8Array(),
      'application/octet-stream'
    );
    expect(await storage.exists('abc', 'f')).toBe(true);
    expect(await storage.exists('abc', 'missing')).toBe(false);
    expect(await storage.exists('def', 'f')).toBe(false);
  });

  it('delete removes both data and sidecar files', async () => {
    const storage = new FilesystemArtifactStorage({ root });
    await storage.store(
      'abc',
      'f',
      new Uint8Array(),
      'application/octet-stream'
    );
    await storage.delete('abc', 'f');
    expect(await storage.exists('abc', 'f')).toBe(false);
    await expect(
      stat(join(root, 'abc', `f${METADATA_SUFFIX}`))
    ).rejects.toThrow();
  });

  it('delete is idempotent for unknown keys', async () => {
    const storage = new FilesystemArtifactStorage({ root });
    await expect(storage.delete('nope', 'nope')).resolves.toBeUndefined();
  });

  it('retrieve throws ArtifactStorageError when not found', async () => {
    const storage = new FilesystemArtifactStorage({ root });
    await expect(storage.retrieve('abc', 'missing')).rejects.toBeInstanceOf(
      ArtifactStorageError
    );
  });

  it('getMetadata returns undefined for missing files', async () => {
    const storage = new FilesystemArtifactStorage({ root });
    expect(await storage.getMetadata('abc', 'missing')).toBeUndefined();
  });

  it('getMetadata falls back to mtime + octet-stream when sidecar is absent', async () => {
    const storage = new FilesystemArtifactStorage({ root });
    await storage.store('abc', 'f', new Uint8Array([1]), 'text/plain');
    await rm(join(root, 'abc', `f${METADATA_SUFFIX}`));

    const meta = await storage.getMetadata('abc', 'f');
    expect(meta?.contentType).toBe('application/octet-stream');
    expect(meta?.uploadedAt).toBeInstanceOf(Date);
  });

  it('refuses artifactIds that do not match the configured pattern', async () => {
    const storage = new FilesystemArtifactStorage({ root });
    await expect(
      storage.store(
        'has/slash',
        'f',
        new Uint8Array(),
        'application/octet-stream'
      )
    ).rejects.toBeInstanceOf(ArtifactStorageError);
    await expect(
      storage.store('..', 'f', new Uint8Array(), 'application/octet-stream')
    ).rejects.toBeInstanceOf(ArtifactStorageError);
    await expect(
      storage.store('', 'f', new Uint8Array(), 'application/octet-stream')
    ).rejects.toBeInstanceOf(ArtifactStorageError);
  });

  it('honours a stricter custom artifactId pattern', async () => {
    const storage = new FilesystemArtifactStorage({
      root,
      artifactIdPattern: /^[0-9a-f]{8}$/,
    });
    await storage.store(
      'deadbeef',
      'f',
      new Uint8Array(),
      'application/octet-stream'
    );
    await expect(
      storage.store(
        'NotHex!',
        'f',
        new Uint8Array(),
        'application/octet-stream'
      )
    ).rejects.toBeInstanceOf(ArtifactStorageError);
  });

  it('rejects filenames containing path separators or traversal sequences', async () => {
    const storage = new FilesystemArtifactStorage({ root });
    for (const bad of [
      '..',
      '.',
      'a/b',
      'a\\b',
      '../escape',
      'with\0null',
      '',
    ]) {
      await expect(
        storage.store('abc', bad, new Uint8Array(), 'application/octet-stream')
      ).rejects.toBeInstanceOf(ArtifactStorageError);
    }
  });

  it('rejects filenames that would shadow a sidecar', async () => {
    const storage = new FilesystemArtifactStorage({ root });
    await expect(
      storage.store(
        'abc',
        `file${METADATA_SUFFIX}`,
        new Uint8Array(),
        'application/octet-stream'
      )
    ).rejects.toBeInstanceOf(ArtifactStorageError);
  });

  it('getUrl URL-encodes special characters in artifactId and filename', () => {
    const storage = new FilesystemArtifactStorage({
      root,
      baseUrl: 'https://example.test/files',
    });
    const url = storage.getUrl('id with space', 'name with space.txt');
    expect(url).toBe(
      'https://example.test/files/id%20with%20space/name%20with%20space.txt'
    );
  });

  it('strips trailing slashes from baseUrl', () => {
    const storage = new FilesystemArtifactStorage({
      root,
      baseUrl: 'https://example/files///',
    });
    expect(storage.getUrl('a', 'b')).toBe('https://example/files/a/b');
  });

  it('creates the root directory lazily on first write', async () => {
    const missing = join(root, 'nested', 'created', 'on', 'demand');
    const storage = new FilesystemArtifactStorage({ root: missing });
    await storage.store(
      'abc',
      'f',
      new Uint8Array(),
      'application/octet-stream'
    );
    await expect(stat(missing)).resolves.toBeDefined();
  });

  it('honours an aborted AbortSignal on store', async () => {
    const storage = new FilesystemArtifactStorage({ root });
    const controller = new AbortController();
    controller.abort(new Error('boom'));
    await expect(
      storage.store(
        'abc',
        'f',
        new Uint8Array(),
        'application/octet-stream',
        controller.signal
      )
    ).rejects.toBeInstanceOf(ArtifactStorageError);
  });

  it('cleanupExpired removes files older than the cutoff', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const storage = new FilesystemArtifactStorage({ root, now: () => now });

    await storage.store(
      'abc',
      'old.txt',
      new TextEncoder().encode('old'),
      'text/plain'
    );
    // Backdate the data file's mtime so we don't have to wait real time.
    const oldPath = join(root, 'abc', 'old.txt');
    const old = new Date('2025-12-31T23:00:00Z');
    await import('node:fs/promises').then((fs) => fs.utimes(oldPath, old, old));

    now = new Date('2026-01-01T00:05:00Z');
    await storage.store(
      'abc',
      'new.txt',
      new TextEncoder().encode('new'),
      'text/plain'
    );

    const removed = await storage.cleanupExpired(5 * 60 * 1000);
    expect(removed).toBe(1);
    expect(await storage.exists('abc', 'old.txt')).toBe(false);
    expect(await storage.exists('abc', 'new.txt')).toBe(true);
  });

  it('cleanupOldest with maxCount <= 0 wipes the store', async () => {
    const storage = new FilesystemArtifactStorage({ root });
    await storage.store(
      'abc',
      'f1',
      new Uint8Array(),
      'application/octet-stream'
    );
    await storage.store(
      'abc',
      'f2',
      new Uint8Array(),
      'application/octet-stream'
    );

    const removed = await storage.cleanupOldest(0);
    expect(removed).toBe(2);
    expect(await storage.exists('abc', 'f1')).toBe(false);
    expect(await storage.exists('abc', 'f2')).toBe(false);
  });

  it('cleanupOldest keeps maxCount most recent files per artifactId', async () => {
    const storage = new FilesystemArtifactStorage({ root });
    const utimes = await import('node:fs/promises').then((m) => m.utimes);

    // Stage three files with explicit mtimes so ordering is deterministic.
    const stamps = [
      new Date('2026-01-01T00:00:01Z'),
      new Date('2026-01-01T00:00:02Z'),
      new Date('2026-01-01T00:00:03Z'),
    ];
    for (let i = 0; i < 3; i += 1) {
      await storage.store(
        'shared',
        `f-${i + 1}.txt`,
        new Uint8Array(),
        'text/plain'
      );
      await utimes(
        join(root, 'shared', `f-${i + 1}.txt`),

        stamps[i]!,

        stamps[i]!
      );
    }
    await storage.store('other', 'o.txt', new Uint8Array(), 'text/plain');

    const removed = await storage.cleanupOldest(1);
    expect(removed).toBe(2);
    expect(await storage.exists('shared', 'f-1.txt')).toBe(false);
    expect(await storage.exists('shared', 'f-2.txt')).toBe(false);
    expect(await storage.exists('shared', 'f-3.txt')).toBe(true);
    expect(await storage.exists('other', 'o.txt')).toBe(true);
  });

  it('cleanup skips directories whose name does not match the artifactId pattern', async () => {
    const storage = new FilesystemArtifactStorage({ root });
    await storage.store(
      'abc',
      'f',
      new Uint8Array(),
      'application/octet-stream'
    );
    // Create a stray directory directly on disk (bypassing the storage API).
    await import('node:fs/promises').then((fs) =>
      fs.mkdir(join(root, 'has space'), { recursive: true })
    );
    await writeFile(join(root, 'has space', 'rogue'), new Uint8Array());

    const removed = await storage.cleanupOldest(0);
    expect(removed).toBe(1); // only the 'abc' artifact is touched
    // Stray directory still exists (storage refuses to consider it).
    await expect(stat(join(root, 'has space'))).resolves.toBeDefined();
  });

  it('close blocks subsequent operations', async () => {
    const storage = new FilesystemArtifactStorage({ root });
    await storage.close();
    await expect(storage.exists('abc', 'f')).rejects.toBeInstanceOf(
      ArtifactStorageError
    );
  });

  it('records the sidecar with the configured clock for uploadedAt', async () => {
    const stamp = new Date('2026-03-01T12:00:00Z');
    const storage = new FilesystemArtifactStorage({
      root,
      now: () => stamp,
    });
    await storage.store(
      'abc',
      'f',
      new Uint8Array(),
      'application/octet-stream'
    );
    const sidecarRaw = await readFile(
      join(root, 'abc', `f${METADATA_SUFFIX}`),
      'utf8'
    );
    const sidecar = JSON.parse(sidecarRaw) as {
      contentType: string;
      uploadedAt: string;
    };
    expect(sidecar.contentType).toBe('application/octet-stream');
    expect(sidecar.uploadedAt).toBe(stamp.toISOString());
  });
});
