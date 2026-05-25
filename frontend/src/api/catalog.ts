import keycloak from '../auth/keycloak';
import { API_BASE_URL } from '../config';
import type {
  CatalogReference,
  CatalogReferenceGroup,
  CatalogThreat,
  CatalogThreatListItem,
  InternalSecuritySolution,
} from '../types';

function buildHeaders(): HeadersInit {
  const headers: HeadersInit = {};

  if (keycloak.authenticated && keycloak.token) {
    headers.Authorization = `Bearer ${keycloak.token}`;
  }

  return headers;
}

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

export async function fetchCatalogThreats(): Promise<CatalogThreatListItem[]> {
  const response = await fetch(`${API_BASE_URL}/admin/catalog/threats`, {
    method: 'GET',
    headers: buildHeaders(),
  });

  return parseResponse<CatalogThreatListItem[]>(response);
}

export async function fetchCatalogThreat(threatId: number): Promise<CatalogThreat> {
  const response = await fetch(`${API_BASE_URL}/admin/catalog/threats/${threatId}`, {
    method: 'GET',
    headers: buildHeaders(),
  });

  return parseResponse<CatalogThreat>(response);
}

export async function fetchCatalogReferences(): Promise<CatalogReference[]> {
  const response = await fetch(`${API_BASE_URL}/admin/catalog/threats/references`, {
    method: 'GET',
    headers: buildHeaders(),
  });

  return parseResponse<CatalogReference[]>(response);
}

export async function fetchCatalogReferenceGroups(): Promise<CatalogReferenceGroup[]> {
  const response = await fetch(`${API_BASE_URL}/admin/catalog/threats/references/groups`, {
    method: 'GET',
    headers: buildHeaders(),
  });

  return parseResponse<CatalogReferenceGroup[]>(response);
}

export async function fetchInternalSecuritySolutions(): Promise<InternalSecuritySolution[]> {
  const response = await fetch(`${API_BASE_URL}/admin/catalog/threats/internal-solutions`, {
    method: 'GET',
    headers: buildHeaders(),
  });

  return parseResponse<InternalSecuritySolution[]>(response);
}

export async function createInternalSecuritySolution(
  payload: Omit<InternalSecuritySolution, 'id_solution'>
): Promise<InternalSecuritySolution> {
  const response = await fetch(`${API_BASE_URL}/admin/catalog/threats/internal-solutions`, {
    method: 'POST',
    headers: {
      ...buildHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return parseResponse<InternalSecuritySolution>(response);
}

export async function updateInternalSecuritySolution(
  solutionId: number,
  payload: Omit<InternalSecuritySolution, 'id_solution'>
): Promise<InternalSecuritySolution> {
  const response = await fetch(`${API_BASE_URL}/admin/catalog/threats/internal-solutions/${solutionId}`, {
    method: 'PUT',
    headers: {
      ...buildHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return parseResponse<InternalSecuritySolution>(response);
}

export async function deleteInternalSecuritySolution(solutionId: number): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/admin/catalog/threats/internal-solutions/${solutionId}`, {
    method: 'DELETE',
    headers: buildHeaders(),
  });

  await parseResponse<{ deleted: boolean }>(response);
}

export async function createCatalogReference(
  payload: Omit<CatalogReference, 'id_reference'>
): Promise<CatalogReference> {
  const response = await fetch(`${API_BASE_URL}/admin/catalog/threats/references`, {
    method: 'POST',
    headers: {
      ...buildHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return parseResponse<CatalogReference>(response);
}

export async function updateCatalogReferenceRecord(
  referenceId: number,
  payload: Omit<CatalogReference, 'id_reference'>
): Promise<CatalogReference> {
  const response = await fetch(`${API_BASE_URL}/admin/catalog/threats/references/${referenceId}`, {
    method: 'PUT',
    headers: {
      ...buildHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return parseResponse<CatalogReference>(response);
}

export async function deleteCatalogReferenceRecord(referenceId: number): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/admin/catalog/threats/references/${referenceId}`, {
    method: 'DELETE',
    headers: buildHeaders(),
  });

  await parseResponse<{ deleted: boolean }>(response);
}

export async function exportCatalogThreatWorkbook(): Promise<Blob> {
  const response = await fetch(`${API_BASE_URL}/admin/catalog/threats/export`, {
    method: 'GET',
    headers: buildHeaders(),
  });

  if (!response.ok) {
    let detail = '';

    try {
      const errorBody = (await response.json()) as { detail?: string | { message?: string } };
      detail =
        typeof errorBody.detail === 'string'
          ? errorBody.detail
          : errorBody.detail?.message ?? '';
    } catch {
      detail = '';
    }

    throw new Error(detail || `Erreur API: ${response.status} ${response.statusText}`);
  }

  return response.blob();
}
