import type {
  AgentCard,
  AgentExtension,
  Struct,
} from '../types/generated/a2a.js';

/**
 * Identifies the A2A extension that reports a task's token usage and execution
 * stats in its metadata. It is inactive unless the client lists it in the
 * `A2A-Extensions` header.
 */
export const USAGE_EXTENSION_URI =
  'https://github.com/inference-gateway/schemas/tree/main/a2a/extensions/usage/v1';

/** Task metadata key of the usage extension's token counts. */
export const USAGE_METADATA_KEY = `${USAGE_EXTENSION_URI}/usage`;

/** Task metadata key of the usage extension's execution stats. */
export const EXECUTION_STATS_METADATA_KEY = `${USAGE_EXTENSION_URI}/execution_stats`;

/** The Agent Card declaration of the usage extension. It only adds data, so it is never required. */
export const USAGE_EXTENSION: AgentExtension = {
  uri: USAGE_EXTENSION_URI,
  description:
    "Reports the task's token usage and execution stats in its metadata.",
  required: false,
};

/** The card with the usage extension declared in its capabilities, unchanged when it already is. */
export function withUsageExtension(card: AgentCard): AgentCard {
  const extensions = card.capabilities.extensions ?? [];
  if (extensions.some((ext) => ext.uri === USAGE_EXTENSION_URI)) {
    return card;
  }
  return {
    ...card,
    capabilities: {
      ...card.capabilities,
      extensions: [...extensions, USAGE_EXTENSION],
    },
  };
}

/**
 * The task or status update without the metadata keys of the extension
 * identified by `uri`, and without metadata once none is left. A request that
 * did not activate an extension gets this.
 */
export function withoutExtension<T extends { readonly metadata?: Struct }>(
  value: T,
  uri: string
): T {
  if (value.metadata === undefined) {
    return value;
  }
  const prefix = `${uri}/`;
  const metadata = Object.fromEntries(
    Object.entries(value.metadata).filter(([key]) => !key.startsWith(prefix))
  );
  const { metadata: _dropped, ...rest } = value;
  return (Object.keys(metadata).length > 0 ? { ...rest, metadata } : rest) as T;
}

/**
 * The extensions a request activates: those its `A2A-Extensions` header lists
 * that the card declares. Extensions the agent does not support stay inactive.
 */
export function activatedExtensions(
  header: string | undefined,
  card: AgentCard
): ReadonlySet<string> {
  const declared = new Set(
    (card.capabilities.extensions ?? []).flatMap((ext) =>
      ext.uri !== undefined ? [ext.uri] : []
    )
  );
  const requested = (header ?? '').split(',').map((uri) => uri.trim());
  return new Set(requested.filter((uri) => declared.has(uri)));
}
