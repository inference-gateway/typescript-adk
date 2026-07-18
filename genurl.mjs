const title = 'feat: support llamacpp provider (bump sdk to 0.12)';
const lines = [
  '## Summary',
  '',
  '- Bump `@inference-gateway/sdk` from `^0.11.0` to `^0.12.0` (resolves `0.12.1`), which exposes `Provider.llamacpp` so consumers can pass the typed enum instead of the raw string.',
  '- SDK 0.12 renamed the `MessageRole` and `FinishReason` enum keys to PascalCase (these enums are re-exported by the ADK). Updated the LLM client tests and the `ai-powered`, `ai-powered-streaming`, and `artifacts-autonomous-tool` examples to match.',
  '- Added a client test asserting `Provider.llamacpp` is accepted as a typed provider.',
  '',
  '`llamacpp/<model>` already worked via the raw string path (`normalizeProvider` accepts `Provider | string`); this exposes the typed member.',
  '',
  '### Verification',
  'Local `pnpm lint && pnpm typecheck && pnpm build && pnpm test` all pass (1153 tests). The three edited examples also typecheck against the new SDK.',
  '',
  '### Note (breaking, pre-1.0)',
  'The `MessageRole` / `FinishReason` PascalCase rename is re-exported by the ADK, so downstream consumers using e.g. `MessageRole.assistant` must switch to `MessageRole.Assistant`. Kept as a `feat` (minor) since the public API is still in bootstrap. A `[DOCS]` note may be warranted.',
  '',
  'Closes #177',
];
const body = lines.join('\n');
const url =
  'https://github.com/inference-gateway/typescript-adk/compare/main...feat/issue-177-20260718-2150?quick_pull=1' +
  '&title=' + encodeURIComponent(title) +
  '&body=' + encodeURIComponent(body);
console.log(url);
