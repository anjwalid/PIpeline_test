import { buildAuthenticatedHeaders } from '../auth/apiAuth';
import { API_BASE_URL } from '../config';
import type { RegulatoryDocument } from '../types';

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

export async function fetchRegulatoryDocuments(): Promise<RegulatoryDocument[]> {
  const response = await fetch(`${API_BASE_URL}/admin/regulatory/documents`, {
    headers: await buildAuthenticatedHeaders(),
  });
  return parseResponse<RegulatoryDocument[]>(response);
}

export async function uploadRegulatoryDocument(
  file: File,
  displayName: string,
  category: string
): Promise<RegulatoryDocument> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('display_name', displayName);
  formData.append('category', category);

  const response = await fetch(`${API_BASE_URL}/admin/regulatory/documents`, {
    method: 'POST',
    headers: await buildAuthenticatedHeaders(),
    body: formData,
  });
  return parseResponse<RegulatoryDocument>(response);
}

export async function deleteRegulatoryDocument(docId: number): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/admin/regulatory/documents/${docId}`, {
    method: 'DELETE',
    headers: await buildAuthenticatedHeaders(),
  });
  await parseResponse<{ deleted: boolean }>(response);
}
