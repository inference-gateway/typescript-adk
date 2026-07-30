import type { AgentCard } from '../types/generated/a2a.js';
import { JSONRPC_ERROR_CODES, JSONRPCError } from './jsonrpc.js';
import type { MethodHandler } from './method-registry.js';

/**
 * Canonical JSON-RPC method name for the A2A
 * `agent/getAuthenticatedExtendedCard` operation.
 *
 * Use this rather than a string literal when registering the handler so the
 * spelling stays in lockstep with conformance tests and other consumers.
 */
export const GET_AUTHENTICATED_EXTENDED_CARD_METHOD =
  'agent/getAuthenticatedExtendedCard';

/**
 * JSON-RPC params accepted by `agent/getAuthenticatedExtendedCard`.
 *
 * Mirrors `types.GetAuthenticatedExtendedCardParams` in the Go ADK and the
 * generated `GetExtendedAgentCardRequest` shape, but every field is optional
 * because the spec allows callers to omit `params` entirely. `tenant`, when
 * provided, is opaque to the framework and forwarded to logs only - matching
 * the Go reference handler in `adk/server/task_handler.go`.
 */
export interface GetAuthenticatedExtendedCardParams {
  readonly tenant?: string;
}

export interface GetAuthenticatedExtendedCardHandlerOptions {
  /**
   * The extended card returned to authenticated callers. Typically the public
   * card decorated with auth metadata (see `decorateAgentCardWithAuth`) plus
   * any private capabilities the agent only exposes after authentication.
   *
   * The handler returns this object verbatim - callers are responsible for
   * ensuring it doesn't leak data the caller shouldn't see.
   *
   * When omitted and `supportsExtendedAgentCard` is true, the handler returns
   * `-32007` (AuthenticatedExtendedCardNotConfiguredError).
   */
  readonly card?: AgentCard;
  /**
   * Whether the public agent card advertises `supportsExtendedAgentCard`.
   * When absent or false, the handler returns `-32004`
   * (UnsupportedOperationError) per A2A spec 3.3.4.
   */
  readonly supportsExtendedAgentCard?: boolean;
}

/**
 * Build a handler for `agent/getAuthenticatedExtendedCard`.
 *
 * The handler trusts that authentication has already been enforced upstream
 * (by the JSON-RPC route's auth middleware) - it does not re-verify the
 * bearer token. When auth is disabled the method should not be registered;
 * see `A2AServer`/`A2AServerBuilder` for the convention.
 *
 * `params` is tolerated as either absent, `null`, or an object with an
 * optional string `tenant`. Anything else surfaces as JSON-RPC `-32602`.
 *
 * Register on an `A2AServer` via
 * `server.registerMethod(GET_AUTHENTICATED_EXTENDED_CARD_METHOD,
 *   createGetAuthenticatedExtendedCardHandler({ card }))`.
 */
export function createGetAuthenticatedExtendedCardHandler(
  options: GetAuthenticatedExtendedCardHandlerOptions
): MethodHandler<unknown, AgentCard> {
  const { card, supportsExtendedAgentCard } = options;

  return (params: unknown): AgentCard => {
    validateParams(params);
    if (!supportsExtendedAgentCard) {
      throw new JSONRPCError(
        JSONRPC_ERROR_CODES.UNSUPPORTED_OPERATION_ERROR,
        'agent does not support extended agent card'
      );
    }
    if (card === undefined) {
      throw new JSONRPCError(
        JSONRPC_ERROR_CODES.AUTHENTICATED_EXTENDED_CARD_NOT_CONFIGURED_ERROR,
        'authenticated extended card is not configured'
      );
    }
    return card;
  };
}

function validateParams(params: unknown): void {
  if (params === undefined || params === null) {
    return;
  }
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      'invalid params: expected GetAuthenticatedExtendedCardParams object'
    );
  }
  const obj = params as Record<string, unknown>;
  const tenant = obj['tenant'];
  if (tenant !== undefined && typeof tenant !== 'string') {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      'invalid params: tenant must be a string when provided'
    );
  }
}
