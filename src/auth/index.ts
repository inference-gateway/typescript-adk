export { isAuthConfigComplete, loadAuthConfigFromEnv } from './config.js';
export type { AuthConfig } from './config.js';

export {
  OIDCDiscoveryError,
  TokenVerificationError,
  createOIDCVerifier,
  fetchOIDCProviderMetadata,
} from './oidc.js';
export type {
  CreateOIDCVerifierOptions,
  OIDCProviderMetadata,
  OIDCVerifier,
} from './oidc.js';

export {
  AUTH_CONTEXT_KEY,
  AUTHENTICATION_REQUIRED_ERROR_CODE,
  NoopAuthenticator,
  OIDCAuthenticator,
  createAuthenticator,
} from './authenticator.js';
export type {
  AuthContext,
  Authenticator,
  CreateAuthenticatorOptions,
  Logger as AuthLogger,
} from './authenticator.js';

export {
  DEFAULT_OIDC_SECURITY_SCHEME_NAME,
  decorateAgentCardWithAuth,
} from './card-decoration.js';
export type { DecorateAgentCardWithAuthOptions } from './card-decoration.js';
