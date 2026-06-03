import keycloak from './keycloak';

export async function ensureFreshKeycloakToken(minValidity = 30): Promise<void> {
  if (!keycloak.authenticated) {
    return;
  }

  try {
    await keycloak.updateToken(minValidity);
  } catch {
    try {
      await keycloak.login();
    } catch {
      // Ignore login errors here and surface a stable session-expired message below.
    }
    throw new Error('Session Keycloak expiree. Reconnexion en cours.');
  }
}

export async function buildAuthenticatedHeaders(options?: {
  contentType?: 'application/json';
}): Promise<HeadersInit> {
  await ensureFreshKeycloakToken();

  const headers: HeadersInit = {};

  if (options?.contentType) {
    headers['Content-Type'] = options.contentType;
  }

  if (keycloak.authenticated && keycloak.token) {
    headers.Authorization = `Bearer ${keycloak.token}`;
  }

  return headers;
}
