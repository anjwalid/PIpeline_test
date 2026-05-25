import keycloak from '../auth/keycloak';
import { API_BASE_URL } from '../config';
import type { SecOpsChatActionGroup, SecOpsChatDraftContext } from '../types';

export interface SecOpsChatReply {
  reply: string;
  option_groups: SecOpsChatActionGroup[];
}

export interface SecOpsChatRequestPayload {
  message: string;
  report_id?: string;
  draft_context?: SecOpsChatDraftContext;
  action_id?: string;
  action_payload?: Record<string, unknown>;
}

function buildHeaders(): HeadersInit {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };

  if (keycloak.authenticated && keycloak.token) {
    headers.Authorization = `Bearer ${keycloak.token}`;
  }

  return headers;
}

export async function sendSecOpsChatMessage(
  payload: SecOpsChatRequestPayload
): Promise<SecOpsChatReply> {
  const response = await fetch(`${API_BASE_URL}/secops-chat/message`, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(payload),
  });

  const data = (await response.json()) as SecOpsChatReply | { detail?: string };

  if (!response.ok) {
    const detail =
      typeof data === 'object' && data !== null && 'detail' in data
        ? data.detail
        : null;
    throw new Error(detail || `Erreur API: ${response.status} ${response.statusText}`);
  }

  return data as SecOpsChatReply;
}
