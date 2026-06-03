import { buildAuthenticatedHeaders } from '../auth/apiAuth';
import { API_BASE_URL } from '../config';
import type { AuditTrailEntry } from '../types';

async function parseResponse<T>(response: Response): Promise<T> {
  const data = (await response.json()) as T | { detail?: string };

  if (!response.ok) {
    const detail =
      typeof data === 'object' && data !== null && 'detail' in data
        ? data.detail
        : null;

    throw new Error(detail || `Erreur API: ${response.status} ${response.statusText}`);
  }

  return data as T;
}

export async function fetchAuditTrail(limit = 200): Promise<AuditTrailEntry[]> {
  const response = await fetch(`${API_BASE_URL}/admin/audit-trail?limit=${limit}`, {
    method: 'GET',
    headers: await buildAuthenticatedHeaders(),
  });

  return parseResponse<AuditTrailEntry[]>(response);
}
