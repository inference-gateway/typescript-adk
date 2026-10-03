# A2A TCK System Under Test

An `@inference-gateway/adk` server that implements the [A2A TCK](https://github.com/a2aproject/a2a-tck) scenarios
(`scenarios/core_operations.feature` and `scenarios/streaming.feature`). The TCK selects each scenario through the
`messageId` prefix it sends (`tck-complete-task`, `tck-artifact-text`, ...). CI runs the full TCK JSON-RPC suite (MUST,
SHOULD and MAY) against it on every pull request.

Mirrors the Go ADK's [`examples/tck-sut/`](https://github.com/inference-gateway/adk/tree/main/examples/tck-sut).

## Running the TCK locally

```bash
pnpm install && pnpm build
cd examples/tck-sut && pnpm start
```

In another terminal:

```bash
git clone https://github.com/a2aproject/a2a-tck && cd a2a-tck
uv run ./run_tck.py --sut-host http://127.0.0.1:9999 --transport jsonrpc
```

## Not covered

- gRPC and HTTP+JSON transports: the ADK serves JSON-RPC only.
- Required extensions (`CORE-CAP-004`): the ADK does not enforce `required: true` extensions yet.
- Tests for a capability this agent declares (streaming, push notifications, extended card) when it is absent; unit
  tests cover those error paths.
