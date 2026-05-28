import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ArtifactStorageError,
  MinioArtifactStorage,
} from '../../src/artifacts/index.js';

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(
    async (
      _client: unknown,
      command: GetObjectCommand,
      options?: { expiresIn?: number }
    ) => {
      const input = command.input as { Bucket?: string; Key?: string };
      const expiresIn = options?.expiresIn ?? 0;
      return `https://signed.test/${input.Bucket}/${input.Key}?expires=${expiresIn}`;
    }
  ),
}));

interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
  uploadedAt: Date;
  metadata: Record<string, string>;
}

class FakeS3Client {
  readonly objects = new Map<string, StoredObject>();
  destroyed = false;
  failGet = false;

  constructor(private readonly now: () => Date = () => new Date()) {}

  async send(
    command: object,
    _options?: { abortSignal?: AbortSignal }
  ): Promise<unknown> {
    if (command instanceof PutObjectCommand) {
      const { Bucket, Key, Body, ContentType, Metadata } = command.input;
      if (typeof Bucket !== 'string' || typeof Key !== 'string') {
        throw new Error('Bucket/Key required');
      }
      const bytes = await readBody(Body);
      this.objects.set(fullKey(Bucket, Key), {
        bytes,
        contentType: ContentType ?? 'application/octet-stream',
        uploadedAt: this.now(),
        metadata: { ...(Metadata ?? {}) },
      });
      return { $metadata: { httpStatusCode: 200 } };
    }
    if (command instanceof GetObjectCommand) {
      if (this.failGet) {
        const err = new Error('not found');
        (err as { name?: string }).name = 'NoSuchKey';
        throw err;
      }
      const { Bucket, Key } = command.input;
      const stored = this.objects.get(fullKey(Bucket as string, Key as string));
      if (stored === undefined) {
        const err = new Error('NoSuchKey');
        (err as { name?: string }).name = 'NoSuchKey';
        throw err;
      }
      return { Body: streamingBody(stored.bytes) };
    }
    if (command instanceof HeadObjectCommand) {
      const { Bucket, Key } = command.input;
      const stored = this.objects.get(fullKey(Bucket as string, Key as string));
      if (stored === undefined) {
        const err = new Error('NotFound') as Error & {
          name: string;
          $metadata: { httpStatusCode: number };
        };
        err.name = 'NotFound';
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      return {
        ContentLength: stored.bytes.byteLength,
        ContentType: stored.contentType,
        LastModified: stored.uploadedAt,
        Metadata: { ...stored.metadata },
      };
    }
    if (command instanceof DeleteObjectCommand) {
      const { Bucket, Key } = command.input;
      this.objects.delete(fullKey(Bucket as string, Key as string));
      return { $metadata: { httpStatusCode: 204 } };
    }
    if (command instanceof ListObjectsV2Command) {
      const { Bucket, Prefix } = command.input;
      const bucketPrefix = `${Bucket}::`;
      const entries: Array<{ Key: string; LastModified: Date }> = [];
      for (const [key, stored] of this.objects) {
        if (!key.startsWith(bucketPrefix)) continue;
        const objKey = key.slice(bucketPrefix.length);
        if (
          typeof Prefix === 'string' &&
          Prefix !== '' &&
          !objKey.startsWith(Prefix)
        ) {
          continue;
        }
        entries.push({ Key: objKey, LastModified: stored.uploadedAt });
      }
      return { Contents: entries, IsTruncated: false };
    }
    throw new Error(`unhandled command ${command.constructor.name}`);
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function fullKey(bucket: string, key: string): string {
  return `${bucket}::${key}`;
}

function streamingBody(bytes: Uint8Array): {
  transformToWebStream: () => ReadableStream<Uint8Array>;
} {
  return {
    transformToWebStream: (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(new Uint8Array(bytes));
          controller.close();
        },
      }),
  };
}

async function readBody(body: unknown): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return new Uint8Array(body);
  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return new Uint8Array(Buffer.concat(chunks));
  }
  throw new Error('unsupported body type');
}

async function streamToBytes(
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: number[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) chunks.push(...value);
  }
  reader.releaseLock();
  return new Uint8Array(chunks);
}

function makeStorage(
  fake: FakeS3Client,
  overrides: Partial<{
    mode: 'direct' | 'proxy';
    baseUrl: string;
    prefix: string;
    presignExpirySeconds: number;
    now: () => Date;
  }> = {}
): MinioArtifactStorage {
  return new MinioArtifactStorage({
    bucket: 'bkt',
    client: fake as unknown as S3Client,
    ...overrides,
  });
}

describe('MinioArtifactStorage', () => {
  let fake: FakeS3Client;

  beforeEach(() => {
    fake = new FakeS3Client();
  });

  it('rejects construction with an empty bucket', () => {
    expect(
      () =>
        new MinioArtifactStorage({
          bucket: '',
          client: fake as unknown as S3Client,
        })
    ).toThrow(ArtifactStorageError);
  });

  it('rejects non-positive presignExpirySeconds', () => {
    expect(
      () =>
        new MinioArtifactStorage({
          bucket: 'b',
          client: fake as unknown as S3Client,
          presignExpirySeconds: 0,
        })
    ).toThrow(ArtifactStorageError);
  });

  it('store + retrieve preserves bytes and content-type', async () => {
    const storage = makeStorage(fake, {
      mode: 'proxy',
      baseUrl: 'https://x/y',
    });
    const original = new TextEncoder().encode('hello world');
    const url = await storage.store(
      'abc-123',
      'hello.txt',
      original,
      'text/plain'
    );
    expect(url).toBe('https://x/y/abc-123/hello.txt');

    const meta = await storage.getMetadata('abc-123', 'hello.txt');
    expect(meta?.contentType).toBe('text/plain');
    expect(meta?.size).toBe(original.byteLength);

    const stream = await storage.retrieve('abc-123', 'hello.txt');
    const bytes = await streamToBytes(stream);
    expect(new TextDecoder().decode(bytes)).toBe('hello world');
  });

  it('store in direct mode returns a presigned URL with configured TTL', async () => {
    const storage = makeStorage(fake, {
      mode: 'direct',
      presignExpirySeconds: 60,
    });
    const url = await storage.store(
      'abc',
      'f.bin',
      new Uint8Array([1, 2, 3]),
      'application/octet-stream'
    );
    expect(url).toMatch(
      /^https:\/\/signed\.test\/bkt\/abc\/f\.bin\?expires=60$/
    );
  });

  it('store in proxy mode returns the public URL pattern', async () => {
    const storage = makeStorage(fake, {
      mode: 'proxy',
      baseUrl: 'https://gateway.test/artifacts',
    });
    const url = await storage.store(
      'abc',
      'f.bin',
      new Uint8Array(),
      'application/octet-stream'
    );
    expect(url).toBe('https://gateway.test/artifacts/abc/f.bin');
  });

  it('applies the configured prefix to object keys', async () => {
    const storage = makeStorage(fake, { prefix: 'agents/dev/' });
    await storage.store(
      'abc',
      'f.bin',
      new Uint8Array([1]),
      'application/octet-stream'
    );
    expect([...fake.objects.keys()]).toEqual(['bkt::agents/dev/abc/f.bin']);
  });

  it('accepts a ReadableStream payload', async () => {
    const storage = makeStorage(fake);
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

  it('exists returns true for stored and false otherwise', async () => {
    const storage = makeStorage(fake);
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

  it('delete removes the object', async () => {
    const storage = makeStorage(fake);
    await storage.store(
      'abc',
      'f',
      new Uint8Array(),
      'application/octet-stream'
    );
    await storage.delete('abc', 'f');
    expect(await storage.exists('abc', 'f')).toBe(false);
  });

  it('retrieve throws ArtifactStorageError when not found', async () => {
    const storage = makeStorage(fake);
    await expect(storage.retrieve('abc', 'missing')).rejects.toBeInstanceOf(
      ArtifactStorageError
    );
  });

  it('getMetadata returns undefined for missing files', async () => {
    const storage = makeStorage(fake);
    expect(await storage.getMetadata('abc', 'missing')).toBeUndefined();
  });

  it('getMetadata prefers the x-amz-meta-uploaded-at stamp over LastModified', async () => {
    const wallClock = new Date('2026-03-01T12:00:00Z');
    fake = new FakeS3Client(() => wallClock);
    const injected = new Date('2026-03-01T10:00:00Z');
    const storage = makeStorage(fake, { now: () => injected });
    await storage.store(
      'abc',
      'f',
      new Uint8Array(),
      'application/octet-stream'
    );
    const meta = await storage.getMetadata('abc', 'f');
    expect(meta?.uploadedAt.getTime()).toBe(injected.getTime());
  });

  it('refuses artifactIds that do not match the configured pattern', async () => {
    const storage = makeStorage(fake);
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
  });

  it('rejects filenames containing path separators or traversal sequences', async () => {
    const storage = makeStorage(fake);
    for (const bad of ['..', '.', 'a/b', 'a\\b', 'with\0null', '']) {
      await expect(
        storage.store('abc', bad, new Uint8Array(), 'application/octet-stream')
      ).rejects.toBeInstanceOf(ArtifactStorageError);
    }
  });

  it('getUrl URL-encodes special characters', () => {
    const storage = makeStorage(fake, { baseUrl: 'https://x/files' });
    expect(storage.getUrl('id with space', 'name with space.txt')).toBe(
      'https://x/files/id%20with%20space/name%20with%20space.txt'
    );
  });

  it('strips trailing slashes from baseUrl', () => {
    const storage = makeStorage(fake, { baseUrl: 'https://x/files///' });
    expect(storage.getUrl('a', 'b')).toBe('https://x/files/a/b');
  });

  it('honours an aborted AbortSignal on store', async () => {
    const storage = makeStorage(fake);
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

  it('getPresignedUrl returns a fresh signed URL with override expiry', async () => {
    const storage = makeStorage(fake, { mode: 'direct' });
    await storage.store(
      'abc',
      'f',
      new Uint8Array(),
      'application/octet-stream'
    );
    const url = await storage.getPresignedUrl('abc', 'f', 120);
    expect(url).toMatch(/\?expires=120$/);
  });

  it('cleanupExpired removes objects older than the cutoff', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    fake = new FakeS3Client(() => now);
    const storage = makeStorage(fake, { now: () => now });

    await storage.store('abc', 'old.txt', new Uint8Array(), 'text/plain');
    now = new Date(now.getTime() + 10 * 60 * 1000);
    await storage.store('abc', 'new.txt', new Uint8Array(), 'text/plain');

    const removed = await storage.cleanupExpired(5 * 60 * 1000);
    expect(removed).toBe(1);
    expect(await storage.exists('abc', 'old.txt')).toBe(false);
    expect(await storage.exists('abc', 'new.txt')).toBe(true);
  });

  it('cleanupOldest with maxCount <= 0 wipes everything under prefix', async () => {
    const storage = makeStorage(fake);
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
    expect(fake.objects.size).toBe(0);
  });

  it('cleanupOldest keeps maxCount most recent files per artifactId', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    fake = new FakeS3Client(() => now);
    const storage = makeStorage(fake, { now: () => now });

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
    expect(await storage.exists('shared', 'f-3.txt')).toBe(true);
    expect(await storage.exists('shared', 'f-1.txt')).toBe(false);
    expect(await storage.exists('shared', 'f-2.txt')).toBe(false);
    expect(await storage.exists('other', 'o.txt')).toBe(true);
  });

  it('cleanup skips object keys whose artifactId segment does not match the pattern', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    fake = new FakeS3Client(() => now);
    const storage = makeStorage(fake, { now: () => now });
    await storage.store(
      'abc',
      'f',
      new Uint8Array(),
      'application/octet-stream'
    );
    // rogue object — direct put bypasses storage validation
    await fake.send(
      new PutObjectCommand({
        Bucket: 'bkt',
        Key: 'has space/rogue',
        Body: new Uint8Array(),
      })
    );

    now = new Date(now.getTime() + 10_000);
    const removed = await storage.cleanupOldest(0);
    expect(removed).toBe(1);
    expect(fake.objects.has('bkt::has space/rogue')).toBe(true);
  });

  it('close destroys the owned client and blocks subsequent operations', async () => {
    const storage = new MinioArtifactStorage({
      bucket: 'b',
      region: 'us-east-1',
    });
    await storage.close();
    await expect(storage.exists('abc', 'f')).rejects.toBeInstanceOf(
      ArtifactStorageError
    );
  });

  it('close does not destroy an injected client', async () => {
    const storage = makeStorage(fake);
    await storage.close();
    expect(fake.destroyed).toBe(false);
  });
});
