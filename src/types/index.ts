export * from './generated/a2a.js';

/**
 * A2A protocol version this ADK speaks. The client sends it in the
 * `A2A-Version` header and the server rejects other versions (spec 3.6).
 */
export const A2A_PROTOCOL_VERSION = '1.0';
