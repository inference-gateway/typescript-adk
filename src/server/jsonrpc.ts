import type { MethodRegistry } from './method-registry.js';

export const JSONRPC_VERSION = '2.0';

export const JSONRPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  UNSUPPORTED_OPERATION_ERROR: -32004,
  AUTHENTICATED_EXTENDED_CARD_NOT_CONFIGURED_ERROR: -32007,
} as const;

export type JSONRPCErrorCode =
  (typeof JSONRPC_ERROR_CODES)[keyof typeof JSONRPC_ERROR_CODES];

export type JSONRPCId = string | number | null;

export interface JSONRPCRequest {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id?: JSONRPCId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JSONRPCErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JSONRPCSuccessResponse {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: JSONRPCId;
  readonly result: unknown;
}

export interface JSONRPCErrorResponse {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: JSONRPCId;
  readonly error: JSONRPCErrorObject;
}

export type JSONRPCResponse = JSONRPCSuccessResponse | JSONRPCErrorResponse;

/**
 * Thrown by a method handler to surface a structured JSON-RPC error to the
 * caller. The `code` is propagated verbatim; reserve the `-32000` to `-32099`
 * range for application-defined server errors.
 */
export class JSONRPCError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'JSONRPCError';
    this.code = code;
    this.data = data;
  }
}

export function createSuccessResponse(
  id: JSONRPCId,
  result: unknown
): JSONRPCSuccessResponse {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    result,
  };
}

export function createErrorResponse(
  id: JSONRPCId,
  code: number,
  message: string,
  data?: unknown
): JSONRPCErrorResponse {
  const error: JSONRPCErrorObject =
    data === undefined ? { code, message } : { code, message, data };
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractId(reqObj: Record<string, unknown>): {
  hasId: boolean;
  id: JSONRPCId;
  idValid: boolean;
} {
  if (!('id' in reqObj)) {
    return { hasId: false, id: null, idValid: true };
  }
  const raw = reqObj['id'];
  if (raw === null || typeof raw === 'string' || typeof raw === 'number') {
    return { hasId: true, id: raw, idValid: true };
  }
  return { hasId: true, id: null, idValid: false };
}

/**
 * Dispatch a single parsed JSON-RPC request. Returns `null` if the request
 * was a Notification (no `id`) and therefore must produce no response, per
 * JSON-RPC 2.0 §4.1.
 */
async function dispatchSingle(
  req: unknown,
  registry: MethodRegistry,
  signal: AbortSignal
): Promise<JSONRPCResponse | null> {
  if (!isPlainObject(req)) {
    return createErrorResponse(
      null,
      JSONRPC_ERROR_CODES.INVALID_REQUEST,
      'invalid request'
    );
  }

  const reqObj = req;
  const { hasId, id, idValid } = extractId(reqObj);
  const responseId: JSONRPCId = idValid ? id : null;
  const isNotification = !hasId;

  const jsonrpcValid = reqObj['jsonrpc'] === JSONRPC_VERSION;
  const rawMethod = reqObj['method'];
  const methodValid = typeof rawMethod === 'string' && rawMethod.length > 0;
  const paramsPresent = 'params' in reqObj;
  const paramsRaw = paramsPresent ? reqObj['params'] : undefined;
  const paramsValid =
    !paramsPresent || paramsRaw === null || typeof paramsRaw === 'object';

  if (!jsonrpcValid || !methodValid || !idValid || !paramsValid) {
    // Per JSON-RPC 2.0 examples (§7), invalid requests always get an error
    // response - we can't trust the absence of `id` to mean "notification"
    // when the rest of the envelope is malformed.
    return createErrorResponse(
      responseId,
      JSONRPC_ERROR_CODES.INVALID_REQUEST,
      'invalid request'
    );
  }

  const method = rawMethod as string;
  const handler = registry.get(method);

  if (handler === undefined) {
    if (isNotification) {
      return null;
    }
    return createErrorResponse(
      responseId,
      JSONRPC_ERROR_CODES.METHOD_NOT_FOUND,
      'method not found'
    );
  }

  try {
    const result = await handler(paramsRaw, { signal });
    if (isNotification) {
      return null;
    }
    return createSuccessResponse(responseId, result);
  } catch (err) {
    if (isNotification) {
      return null;
    }
    if (err instanceof JSONRPCError) {
      return createErrorResponse(responseId, err.code, err.message, err.data);
    }
    return createErrorResponse(
      responseId,
      JSONRPC_ERROR_CODES.INTERNAL_ERROR,
      'internal error'
    );
  }
}

/**
 * Parse a raw JSON-RPC envelope (single or batch) and dispatch it against the
 * given registry. Returns:
 * - a single response object for single requests,
 * - an array of responses for batch requests with at least one non-notification,
 * - `null` when the entire request produces no response (e.g. a notification
 *   or a batch of notifications), per JSON-RPC 2.0 §6.
 */
export async function dispatch(
  rawBody: string,
  registry: MethodRegistry,
  signal: AbortSignal
): Promise<JSONRPCResponse | JSONRPCResponse[] | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return createErrorResponse(
      null,
      JSONRPC_ERROR_CODES.PARSE_ERROR,
      'parse error'
    );
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return createErrorResponse(
        null,
        JSONRPC_ERROR_CODES.INVALID_REQUEST,
        'invalid request'
      );
    }
    const responses = await Promise.all(
      parsed.map((item) => dispatchSingle(item, registry, signal))
    );
    const filtered = responses.filter((r): r is JSONRPCResponse => r !== null);
    if (filtered.length === 0) {
      return null;
    }
    return filtered;
  }

  return dispatchSingle(parsed, registry, signal);
}
