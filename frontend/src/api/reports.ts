import keycloak from '../auth/keycloak';
import { API_BASE_URL } from '../config';
import type {
  ManagerReviewFeedbackItem,
  ManagerDashboardMetrics,
  ReportRecord,
  ReportResultsPayload,
  ReportResultsRecord,
  ReportStatus,
} from '../types';

type RawReportStatus = ReportStatus | 'PENDING_MANAGER_VALIDATION' | 'IN_PROGRESS' | 'NEEDS_CHANGES' | 'GENERATED';

function buildHeaders(contentType = false): HeadersInit {
  const headers: HeadersInit = {};

  if (contentType) {
    headers['Content-Type'] = 'application/json';
  }

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

function normalizeReportStatus(
  status: string,
  options?: {
    legacyPendingAsDraft?: boolean;
  }
): ReportStatus {
  const normalized = String(status || '').trim().toUpperCase() as RawReportStatus;

  if (normalized === 'PENDING_MANAGER_VALIDATION') {
    return options?.legacyPendingAsDraft ? 'DRAFT' : 'PENDING';
  }

  if (normalized === 'GENERATED') {
    return 'DRAFT';
  }

  if (normalized === 'IN_PROGRESS' || normalized === 'NEEDS_CHANGES') {
    return 'REJECTED';
  }

  if (normalized === 'DRAFT' || normalized === 'PENDING' || normalized === 'APPROVED' || normalized === 'REJECTED') {
    return normalized;
  }

  return 'DRAFT';
}

function normalizeReportRecord(
  report: ReportRecord,
  options?: {
    legacyPendingAsDraft?: boolean;
  }
): ReportRecord {
  return {
    ...report,
    status: normalizeReportStatus(report.status, options),
    status_history: (report.status_history || []).map((entry) => ({
      ...entry,
      old_status: entry.old_status
        ? normalizeReportStatus(entry.old_status, options)
        : entry.old_status,
      new_status: normalizeReportStatus(entry.new_status, options),
    })),
  };
}

function normalizeManagerDashboardMetrics(
  metrics: ManagerDashboardMetrics
): ManagerDashboardMetrics {
  return {
    ...metrics,
    riskiest_applications: metrics.riskiest_applications.map((item) => ({
      ...item,
      status: normalizeReportStatus(item.status),
    })),
  };
}

export function toAbsoluteReportUrl(reportUrl: string): string {
  if (reportUrl.startsWith('http://') || reportUrl.startsWith('https://')) {
    return reportUrl;
  }

  const normalizedPath = reportUrl.startsWith('/') ? reportUrl : `/${reportUrl}`;
  return `${API_BASE_URL}${normalizedPath}`;
}

export async function fetchMyReports(): Promise<ReportRecord[]> {
  const response = await fetch(`${API_BASE_URL}/reports/me`, {
    method: 'GET',
    headers: buildHeaders(),
  });

  const reports = await parseResponse<ReportRecord[]>(response);
  return reports.map((report) =>
    normalizeReportRecord(report, { legacyPendingAsDraft: true })
  );
}

export async function fetchAllReports(): Promise<ReportRecord[]> {
  const response = await fetch(`${API_BASE_URL}/reports`, {
    method: 'GET',
    headers: buildHeaders(),
  });

  const reports = await parseResponse<ReportRecord[]>(response);
  return reports.map((report) => normalizeReportRecord(report));
}

export async function fetchManagerDashboardMetrics(): Promise<ManagerDashboardMetrics> {
  const response = await fetch(`${API_BASE_URL}/reports/dashboard/manager`, {
    method: 'GET',
    headers: buildHeaders(),
  });

  const metrics = await parseResponse<ManagerDashboardMetrics>(response);
  return normalizeManagerDashboardMetrics(metrics);
}

export async function updateReportStatus(
  reportId: string,
  status: Extract<ReportStatus, 'PENDING' | 'APPROVED' | 'REJECTED'>,
  comment?: string,
  feedbackItems: ManagerReviewFeedbackItem[] = []
): Promise<ReportRecord> {
  const response = await fetch(`${API_BASE_URL}/reports/${reportId}/status`, {
    method: 'PATCH',
    headers: buildHeaders(true),
    body: JSON.stringify({
      status,
      comment: comment?.trim() || null,
      feedback_items: feedbackItems,
    }),
  });

  const report = await parseResponse<ReportRecord>(response);
  return normalizeReportRecord(report);
}

export async function fetchReportResults(reportId: string): Promise<ReportResultsRecord> {
  const response = await fetch(`${API_BASE_URL}/reports/${reportId}/results`, {
    method: 'GET',
    headers: buildHeaders(),
  });

  return parseResponse<ReportResultsRecord>(response);
}

export async function updateReportResults(
  reportId: string,
  payload: ReportResultsPayload
): Promise<ReportResultsRecord> {
  const response = await fetch(`${API_BASE_URL}/reports/${reportId}/results`, {
    method: 'PUT',
    headers: buildHeaders(true),
    body: JSON.stringify(payload),
  });

  return parseResponse<ReportResultsRecord>(response);
}

export async function uploadReportDfd(
  reportId: string,
  file: File
): Promise<{ dfd_image_path: string; original_file_name: string }> {
  const formData = new FormData();
  formData.append('dfd_file', file);

  const response = await fetch(`${API_BASE_URL}/reports/${reportId}/dfd-upload`, {
    method: 'POST',
    headers: buildHeaders(),
    body: formData,
  });

  return parseResponse<{ dfd_image_path: string; original_file_name: string }>(response);
}

export async function regenerateReport(reportId: string): Promise<ReportRecord> {
  const response = await fetch(`${API_BASE_URL}/reports/${reportId}/regenerate`, {
    method: 'POST',
    headers: buildHeaders(),
  });

  const report = await parseResponse<ReportRecord>(response);
  return normalizeReportRecord(report);
}

export async function deleteReport(reportId: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/reports/${reportId}`, {
    method: 'DELETE',
    headers: buildHeaders(),
  });

  if (!response.ok) {
    await parseResponse(response);
  }
}

export async function fetchReportBlobUrl(reportUrl: string): Promise<string> {
  const response = await fetch(reportUrl, {
    method: 'GET',
    headers: buildHeaders(),
  });

  if (!response.ok) {
    let detail = `Erreur API: ${response.status} ${response.statusText}`;

    try {
      const data = await response.json();
      if (data && typeof data === 'object' && 'detail' in data && data.detail) {
        detail = String(data.detail);
      }
    } catch {
      // Ignore JSON parsing for binary/pdf responses.
    }

    throw new Error(detail);
  }

  const blob = await response.blob();
  return URL.createObjectURL(blob);
}
