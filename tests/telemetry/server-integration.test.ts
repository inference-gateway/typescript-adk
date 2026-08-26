import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { A2AServer, createA2AServer } from '../../src/server/index.js';
import {
  ATTR_JSONRPC_METHOD,
  ATTR_JSONRPC_REQUEST_ID,
  SPAN_NAME_JSONRPC_REQUEST,
  TELEMETRY_ENABLED_ENV,
  TelemetryProvider,
} from '../../src/telemetry/index.js';
import type { AgentCard } from '../../src/types/generated/a2a.js';

function makeCard(): AgentCard {
  return {
    name: 'telemetry-agent',
    description: 'Agent under test',
    version: '1.0.0',
    protocolVersion: '1.0',
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    capabilities: { streaming: false },
    skills: [
      {
        id: 'echo',
        name: 'Echo',
        description: 'Echoes input back.',
        tags: [],
      },
    ],
  };
}

async function startServer(server: A2AServer): Promise<string> {
  await server.listen(0, '127.0.0.1');
  const addr = server.address();
  if (addr === null) {
    throw new Error('server did not report a listening address');
  }
  return `http://127.0.0.1:${addr.port}`;
}

// One TelemetryProvider per file because the global OTel TracerProvider can
// only be registered once per process and vitest gives each test file its own
// worker. Each test resets the in-memory exporter before running.
describe('A2AServer emits JSON-RPC spans when a TelemetryProvider is supplied', () => {
  let exporter: InMemorySpanExporter;
  let provider: TelemetryProvider;
  let server: A2AServer | undefined;

  beforeAll(() => {
    exporter = new InMemorySpanExporter();
    provider = new TelemetryProvider({
      env: { [TELEMETRY_ENABLED_ENV]: 'true' },
      serviceName: 'telemetry-agent',
      serviceVersion: '1.0.0',
      spanProcessors: [new SimpleSpanProcessor(exporter)],
      instrumentations: [],
    });
    provider.start();
  });

  afterAll(async () => {
    await provider.shutdown();
  });

  beforeEach(() => {
    exporter.reset();
  });

  afterEach(async () => {
    if (server !== undefined) {
      try {
        await server.close();
      } catch {
        // already closed
      }
      server = undefined;
    }
  });

  async function setupServer(): Promise<string> {
    const srv = createA2AServer({
      card: makeCard(),
      telemetry: provider,
    });
    srv.registerMethod('echo', (params) => ({ echoed: params }));
    server = srv;
    return startServer(srv);
  }

  it('emits a span tagged with the JSON-RPC method and id', async () => {
    const baseUrl = await setupServer();

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-1',
        method: 'echo',
        params: { hello: 'world' },
      }),
    });
    expect(res.status).toBe(200);
    await res.text();

    await provider.forceFlush();
    const finished = exporter.getFinishedSpans();
    const jsonRpcSpan = finished.find(
      (s) => s.name === SPAN_NAME_JSONRPC_REQUEST
    );
    expect(jsonRpcSpan).toBeDefined();
    expect(jsonRpcSpan?.attributes[ATTR_JSONRPC_METHOD]).toBe('echo');
    expect(jsonRpcSpan?.attributes[ATTR_JSONRPC_REQUEST_ID]).toBe('req-1');
  });

  it('does not include the request id attribute for notifications', async () => {
    const baseUrl = await setupServer();

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'echo',
        params: { fire: 'and-forget' },
      }),
    });
    expect(res.status).toBe(204);

    await provider.forceFlush();
    const finished = exporter.getFinishedSpans();
    const jsonRpcSpan = finished.find(
      (s) => s.name === SPAN_NAME_JSONRPC_REQUEST
    );
    expect(jsonRpcSpan).toBeDefined();
    expect(jsonRpcSpan?.attributes[ATTR_JSONRPC_METHOD]).toBe('echo');
    expect(jsonRpcSpan?.attributes[ATTR_JSONRPC_REQUEST_ID]).toBeUndefined();
  });

  it('coerces numeric JSON-RPC ids to strings', async () => {
    const baseUrl = await setupServer();

    await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'echo',
        params: {},
      }),
    });

    await provider.forceFlush();
    const finished = exporter.getFinishedSpans();
    const jsonRpcSpan = finished.find(
      (s) => s.name === SPAN_NAME_JSONRPC_REQUEST
    );
    expect(jsonRpcSpan?.attributes[ATTR_JSONRPC_REQUEST_ID]).toBe('7');
  });

  it('omits method and id attributes when the body is unparseable', async () => {
    const baseUrl = await setupServer();

    await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });

    await provider.forceFlush();
    const finished = exporter.getFinishedSpans();
    const jsonRpcSpan = finished.find(
      (s) => s.name === SPAN_NAME_JSONRPC_REQUEST
    );
    expect(jsonRpcSpan).toBeDefined();
    expect(jsonRpcSpan?.attributes[ATTR_JSONRPC_METHOD]).toBeUndefined();
    expect(jsonRpcSpan?.attributes[ATTR_JSONRPC_REQUEST_ID]).toBeUndefined();
  });

  it('does not record a span when no telemetry provider is configured on the server', async () => {
    const srv = createA2AServer({ card: makeCard() });
    srv.registerMethod('echo', (params) => ({ echoed: params }));
    server = srv;
    const baseUrl = await startServer(srv);

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'echo',
        params: {},
      }),
    });
    expect(res.status).toBe(200);

    await provider.forceFlush();
    const finished = exporter.getFinishedSpans();
    expect(finished.some((s) => s.name === SPAN_NAME_JSONRPC_REQUEST)).toBe(
      false
    );
  });
});
