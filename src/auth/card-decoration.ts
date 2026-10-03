import type {
  AgentCard,
  SecurityRequirement,
  SecurityScheme,
} from '../types/generated/a2a.js';
import type { AuthConfig } from './config.js';
import { oidcDiscoveryUrl } from './oidc.js';

/**
 * Default key under which {@link decorateAgentCardWithAuth} registers the
 * OIDC security scheme in `card.securitySchemes`. Callers can override via
 * the `schemeName` option.
 */
export const DEFAULT_OIDC_SECURITY_SCHEME_NAME = 'oidc';

export interface DecorateAgentCardWithAuthOptions {
  /**
   * Key under which the security scheme is registered. Defaults to
   * {@link DEFAULT_OIDC_SECURITY_SCHEME_NAME}.
   */
  readonly schemeName?: string;
}

/**
 * Return a shallow copy of `card` with OIDC security metadata applied:
 *
 *  - `securitySchemes[<schemeName>]` is set to the OpenID Connect security
 *    scheme pointing at the well-known discovery URL for `config.issuerUrl`.
 *  - `securityRequirements` is extended with a requirement that names `<schemeName>`.
 *
 * Has no effect when `config.enable` is false - returns the input card
 * verbatim so callers can invoke unconditionally.
 *
 * Existing entries with the same scheme name are preserved.
 */
export function decorateAgentCardWithAuth(
  card: AgentCard,
  config: AuthConfig,
  options: DecorateAgentCardWithAuthOptions = {}
): AgentCard {
  if (!config.enable || config.issuerUrl.length === 0) {
    return card;
  }
  const schemeName = options.schemeName ?? DEFAULT_OIDC_SECURITY_SCHEME_NAME;
  const discoveryUrl = oidcDiscoveryUrl(config.issuerUrl);

  const existingSchemes = card.securitySchemes ?? {};
  if (existingSchemes[schemeName] !== undefined) {
    return card;
  }
  const oidcScheme: SecurityScheme = {
    openIdConnectSecurityScheme: {
      openIdConnectUrl: discoveryUrl,
      description: 'OpenID Connect authentication via JWT Bearer tokens.',
    },
  };
  const updatedSchemes: { [k: string]: SecurityScheme | undefined } = {
    ...existingSchemes,
    [schemeName]: oidcScheme,
  };

  const existingSecurity = card.securityRequirements ?? [];
  const alreadyRequired = existingSecurity.some(
    (entry) => entry.schemes?.[schemeName] !== undefined
  );
  const securityRequirement: SecurityRequirement = {
    schemes: { [schemeName]: { list: [] } },
  };
  const updatedSecurity: SecurityRequirement[] = alreadyRequired
    ? existingSecurity
    : [...existingSecurity, securityRequirement];

  return {
    ...card,
    securitySchemes: updatedSchemes,
    securityRequirements: updatedSecurity,
  };
}
