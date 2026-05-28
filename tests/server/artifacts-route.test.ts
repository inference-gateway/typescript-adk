import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FilesystemArtifactStorage,
  InMemoryArtifactStorage,
} from '../../src/artifacts/index.js';
import {
  A2AServer,
  createA2AServer,
  DEFAULT_ARTIFACTS_PATH,
} from '../../src/server/index.js';
import type { AgentCard } from '../../src/types/generated/a2a.js';

function makeCard(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    name: 'artifact-agent',
    description: 'Agent serving artifacts',
    version: '0.0.1',
    protocolVersion: '1.0',
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    capabilities: { streaming: false },
    skills: [{ id: 'noop', name: 'Noop', description: 'no-op', tags: [] }],
    ...overrides,
  };
}

async function startServer(
  server: A2AServer
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  await server.listen(0, '127.0.0.1');
  const addr = server.address();
  if (addr === null) {
    throw new Error('server did not report a listening address');
  }
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => server.close(),
  };
}

describe('A2AServer artifacts download endpoint', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close !== undefined) {
      await close();
      close = undefined;
    }
  });

  it('returns 404 when no artifact storage is configured', async () => {
    const server = createA2AServer({ card: makeCard() });
    const started = await startServer(server);
    close = started.close;

    const res = await fetch(
      `${started.baseUrl}${DEFAULT_ARTIFACTS_PATH}/abc/x.txt`
    );
    expect(res.status).toBe(404);
  });

  it('streams stored bytes with the recorded content-type (in-memory)', async () => {
    const storage = new InMemoryArtifactStorage();
    await storage.store(
      'abc',
      'hello.txt',
      new TextEncoder().encode('hi there'),
      'text/plain'
    );
    const server = createA2AServer({
      card: makeCard(),
      artifactStorage: storage,
    });
    const started = await startServer(server);
    close = started.close;

    const res = await fetch(
      `${started.baseUrl}${DEFAULT_ARTIFACTS_PATH}/abc/hello.txt`
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(res.headers.get('content-length')).toBe('8');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="hello.txt"'
    );
    expect(await res.text()).toBe('hi there');
  });

  it('serves URL-encoded artifact ids and filenames after decoding', async () => {
    const storage = new InMemoryArtifactStorage();
    await storage.store(
      'spaced id',
      'name with space.txt',
      new TextEncoder().encode('payload'),
      'text/plain'
    );
    const server = createA2AServer({
      card: makeCard(),
      artifactStorage: storage,
    });
    const started = await startServer(server);
    close = started.close;

    const res = await fetch(
      `${started.baseUrl}${DEFAULT_ARTIFACTS_PATH}/spaced%20id/name%20with%20space.txt`
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('payload');
  });

  it('returns 404 for unknown ids without leaking the storage error', async () => {
    const server = createA2AServer({
      card: makeCard(),
      artifactStorage: new InMemoryArtifactStorage(),
    });
    const started = await startServer(server);
    close = started.close;

    const res = await fetch(
      `${started.baseUrl}${DEFAULT_ARTIFACTS_PATH}/unknown/file.txt`
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'Not Found' });
  });

  it('honours a custom artifactsPath', async () => {
    const storage = new InMemoryArtifactStorage();
    await storage.store(
      'abc',
      'f.txt',
      new TextEncoder().encode('ok'),
      'text/plain'
    );
    const server = createA2AServer({
      card: makeCard(),
      artifactStorage: storage,
      artifactsPath: '/v1/files',
    });
    const started = await startServer(server);
    close = started.close;

    const defaultPath = await fetch(
      `${started.baseUrl}${DEFAULT_ARTIFACTS_PATH}/abc/f.txt`
    );
    expect(defaultPath.status).toBe(404);

    const custom = await fetch(`${started.baseUrl}/v1/files/abc/f.txt`);
    expect(custom.status).toBe(200);
    expect(await custom.text()).toBe('ok');
  });

  it('serves bytes from the filesystem provider end-to-end', async () => {
    const root = await mkdtemp(join(tmpdir(), 'adk-route-fs-'));
    try {
      const storage = new FilesystemArtifactStorage({
        root,
        baseUrl: 'http://example.test/artifacts',
      });
      await storage.store(
        'abc-123',
        'report.csv',
        new TextEncoder().encode('a,b\n1,2\n'),
        'text/csv'
      );
      const server = createA2AServer({
        card: makeCard(),
        artifactStorage: storage,
      });
      const started = await startServer(server);
      close = started.close;

      const res = await fetch(
        `${started.baseUrl}${DEFAULT_ARTIFACTS_PATH}/abc-123/report.csv`
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/csv');
      expect(await res.text()).toBe('a,b\n1,2\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 404 when filesystem provider rejects the artifactId pattern', async () => {
    const root = await mkdtemp(join(tmpdir(), 'adk-route-fs-bad-'));
    try {
      const storage = new FilesystemArtifactStorage({ root });
      const server = createA2AServer({
        card: makeCard(),
        artifactStorage: storage,
      });
      const started = await startServer(server);
      close = started.close;

      const res = await fetch(
        `${started.baseUrl}${DEFAULT_ARTIFACTS_PATH}/${encodeURIComponent('../etc')}/passwd`
      );
      expect(res.status).toBe(404);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
