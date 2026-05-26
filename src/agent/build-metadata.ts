import type { AgentCard } from '../types/generated/a2a.js';

/**
 * Build-time agent metadata. Mirrors `BuildAgentName`, `BuildAgentDescription`,
 * and `BuildAgentVersion` in the Go ADK (`server/metadata.go`), which are
 * populated via `go build -ldflags -X`.
 *
 * In TypeScript the equivalent is either:
 *   - Bundle-time substitution via tsup's `define` option, e.g.
 *     `define: { 'process.env.BUILD_AGENT_NAME': JSON.stringify('my-agent') }`
 *   - Runtime: set `BUILD_AGENT_NAME` (etc.) in the environment before this
 *     module is first imported.
 *
 * An empty string means "not injected" - {@link applyBuildMetadata} treats
 * empty values as no-ops.
 */
export interface BuildMetadata {
  readonly name: string;
  readonly description: string;
  readonly version: string;
}

export const BUILD_AGENT_NAME: string = process.env['BUILD_AGENT_NAME'] ?? '';
export const BUILD_AGENT_DESCRIPTION: string =
  process.env['BUILD_AGENT_DESCRIPTION'] ?? '';
export const BUILD_AGENT_VERSION: string =
  process.env['BUILD_AGENT_VERSION'] ?? '';

export const buildMetadata: BuildMetadata = Object.freeze({
  name: BUILD_AGENT_NAME,
  description: BUILD_AGENT_DESCRIPTION,
  version: BUILD_AGENT_VERSION,
});

/**
 * Return a copy of `card` with build-time `name`, `description`, and `version`
 * applied as overrides. Empty build values leave the corresponding card field
 * untouched, so this is safe to call unconditionally.
 *
 * @param card - The base agent card.
 * @param metadata - Optional metadata override (defaults to `buildMetadata`).
 *   Primarily an injection point for tests.
 */
export function applyBuildMetadata(
  card: AgentCard,
  metadata: BuildMetadata = buildMetadata
): AgentCard {
  const result: AgentCard = { ...card };
  if (metadata.name !== '') {
    result.name = metadata.name;
  }
  if (metadata.description !== '') {
    result.description = metadata.description;
  }
  if (metadata.version !== '') {
    result.version = metadata.version;
  }
  return result;
}
