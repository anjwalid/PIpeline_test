import { KEYCLOAK_CLIENT_ID, KEYCLOAK_REALM, KEYCLOAK_URL } from '../config';

const STORAGE_PATTERNS = [/^astoria-/i, /^kc-/i, /keycloak/i];

function shouldClearStorageKey(key: string) {
  return STORAGE_PATTERNS.some((pattern) => pattern.test(key));
}

export function clearApplicationSession() {
  const clearStorage = (storage: Storage) => {
    const keysToRemove: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && shouldClearStorageKey(key)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((key) => storage.removeItem(key));
  };

  clearStorage(window.localStorage);
  clearStorage(window.sessionStorage);
}

export function buildKeycloakLogoutUrl(idTokenHint?: string | null) {
  const baseUrl = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/logout`;
  const redirectUri = encodeURIComponent(window.location.origin);
  const params = new URLSearchParams({
    client_id: KEYCLOAK_CLIENT_ID,
    post_logout_redirect_uri: window.location.origin,
  });

  if (idTokenHint) {
    params.set('id_token_hint', idTokenHint);
  }

  return `${baseUrl}?${params.toString().replace(
    'post_logout_redirect_uri=' + encodeURIComponent(window.location.origin),
    'post_logout_redirect_uri=' + redirectUri
  )}`;
}

export async function performStrongLogout(keycloak: any) {
  const idTokenHint = keycloak.idToken ?? null;

  try {
    keycloak.onTokenExpired = undefined;
    keycloak.onAuthLogout = undefined;
    keycloak.onAuthRefreshError = undefined;
    keycloak.onAuthError = undefined;
    if (typeof keycloak.clearToken === 'function') {
      keycloak.clearToken();
    }
  } catch (error) {
    console.warn('Nettoyage Keycloak partiel pendant la deconnexion :', error);
  }

  clearApplicationSession();

  try {
    await keycloak.logout({
      redirectUri: window.location.origin,
    });
  } catch (error) {
    console.error('Erreur logout Keycloak, bascule vers le logout de secours :', error);
    window.location.replace(buildKeycloakLogoutUrl(idTokenHint));
  }
}
