/**
 * Thrown when TLS configuration is invalid or required cert/key material
 * cannot be loaded from disk.
 *
 * Carries the triggering error (e.g. an `fs` `ENOENT`) via {@link Error.cause}
 * so callers can distinguish a missing-path failure from a malformed-pem
 * failure without string-matching the message.
 */
export class TLSConfigError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'TLSConfigError';
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}
