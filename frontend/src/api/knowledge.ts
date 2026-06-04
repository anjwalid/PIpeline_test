import { buildAuthenticatedHeaders } from '../auth/apiAuth';
import { API_BASE_URL } from '../config';

export interface FaqItem {
  id: number;
  category: string;
  question: string;
  answer: string;
  action_id: string | null;
  action_label: string | null;
  is_active: boolean;
}

export interface GuideStep {
  id: number;
  tour_id: string;
  step_order: number;
  title: string;
  description: string;
  nav_section: string | null;
  target: string | null;
}

async function apiFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      ...(await buildAuthenticatedHeaders({ contentType: 'application/json' })),
      ...((init?.headers as Record<string, string> | undefined) || {}),
    },
  });
  if (!res.ok) throw new Error(await res.text());
  if (res.status === 204) return null;
  return res.json();
}

// FAQ
export const fetchFaq = (): Promise<FaqItem[]> => apiFetch('/admin/knowledge/faq');
export const createFaq = (body: Omit<FaqItem, 'id'>): Promise<FaqItem> =>
  apiFetch('/admin/knowledge/faq', { method: 'POST', body: JSON.stringify(body) });
export const updateFaq = (id: number, body: Partial<Omit<FaqItem, 'id'>>): Promise<FaqItem> =>
  apiFetch(`/admin/knowledge/faq/${id}`, { method: 'PUT', body: JSON.stringify(body) });
export const deleteFaq = (id: number): Promise<void> =>
  apiFetch(`/admin/knowledge/faq/${id}`, { method: 'DELETE' });

// Guide steps
export const fetchGuideSteps = (): Promise<GuideStep[]> => apiFetch('/admin/knowledge/guide-steps');
export const createGuideStep = (body: Omit<GuideStep, 'id'>): Promise<GuideStep> =>
  apiFetch('/admin/knowledge/guide-steps', { method: 'POST', body: JSON.stringify(body) });
export const updateGuideStep = (id: number, body: Partial<Omit<GuideStep, 'id' | 'tour_id'>>): Promise<GuideStep> =>
  apiFetch(`/admin/knowledge/guide-steps/${id}`, { method: 'PUT', body: JSON.stringify(body) });
export const deleteGuideStep = (id: number): Promise<void> =>
  apiFetch(`/admin/knowledge/guide-steps/${id}`, { method: 'DELETE' });

// Regulatory shortcuts
export const updateDocShortcuts = (docId: number, shortcuts: string[]): Promise<void> =>
  apiFetch(`/admin/knowledge/regulatory/${docId}/shortcuts`, {
    method: 'PUT',
    body: JSON.stringify({ shortcuts }),
  });
