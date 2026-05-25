import { useEffect, useState, type ReactNode } from 'react';
import { History, Layers3, LayoutDashboard } from 'lucide-react';
import { Navbar } from '../../components/Navbar';
import { FormView } from '../../components/FormView';
import { ErrorView } from '../../components/ErrorView';
import { LoadingOverlay } from '../../components/LoadingOverlay';
import { ReportView } from '../../components/ReportView';
import { ReportResultsEditor } from '../../components/ReportResultsEditor';
import { ValidationView } from '../../components/ValidationView';
import { HistoryView } from '../../components/HistoryView';
import { DashboardView } from '../../components/DashboardView';
import { SecOpsChatbot } from '../../components/SecOpsChatbot';
import { API_BASE_URL } from '../../config';
import {
  fetchMyReports,
  fetchReportBlobUrl,
  toAbsoluteReportUrl,
} from '../../api/reports';
import type {
  AnalysisSubmitPayload,
  ReportRecord,
  SecOpsChatDraftContext,
} from '../../types';
import keycloak from '../../auth/keycloak';

type ViewState = 'form' | 'loading' | 'error' | 'report' | 'report_editor';
type LoadingStep = 'starting' | 'sent' | 'processing' | 'waiting';
type SecOpsSection = 'analysis' | 'history' | 'dashboard';
const STATUS_LABELS = {
  DRAFT: 'Brouillon',
  PENDING: 'En attente manager',
  APPROVED: 'Approuve',
  REJECTED: 'Rejete',
} as const;

interface SecOpsPageProps {
  currentUserName: string;
  onLogout: () => void;
}

export function SecOpsPage({ currentUserName, onLogout }: Readonly<SecOpsPageProps>) {
  const [activeSection, setActiveSection] = useState<SecOpsSection>('dashboard');
  const [viewState, setViewState] = useState<ViewState>('form');
  const [isDemoMode] = useState(false);
  const [isApiConnected, setIsApiConnected] = useState(false);
  const [formData, setFormData] = useState<AnalysisSubmitPayload | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [loadingStep, setLoadingStep] = useState<LoadingStep>('starting');
  const [reportUrl, setReportUrl] = useState('');
  const [currentReportId, setCurrentReportId] = useState('');
  const [history, setHistory] = useState<ReportRecord[]>([]);
  const [isValidating, setIsValidating] = useState(false);
  const [chatDraftContext, setChatDraftContext] = useState<SecOpsChatDraftContext | null>(null);
  const currentReport = history.find((report) => report.id === currentReportId);

  const extractReportIdFromUrl = (url: string): string => {
    const match = /\/reports\/([^/]+)\/download/.exec(url || '');
    return match?.[1] || '';
  };

  useEffect(() => {
    checkApiConnection();
    void loadMyReports();
  }, []);

  const checkApiConnection = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/health`, {
        method: 'GET',
      });
      setIsApiConnected(response.ok);
    } catch {
      setIsApiConnected(false);
    }
  };

  const loadMyReports = async () => {
    try {
      const reports = await fetchMyReports();
      setHistory(
        reports.map((report) => ({
          ...report,
          report_url: toAbsoluteReportUrl(report.report_url),
        }))
      );
    } catch (error) {
      console.error('Erreur chargement rapports secops :', error);
      setHistory([]);
    }
  };

  const handleFormSubmit = async (data: AnalysisSubmitPayload) => {
    setFormData(data);
    setChatDraftContext(data);
    setErrorMessage('');
    setLoadingStep('starting');
    setReportUrl('');
    setCurrentReportId('');
    setViewState('loading');

    if (isDemoMode) {
      setTimeout(() => setLoadingStep('sent'), 700);
      setTimeout(() => setLoadingStep('processing'), 1500);
      setTimeout(() => setLoadingStep('waiting'), 2500);

      setTimeout(() => {
        const demoReportUrl = `${API_BASE_URL}/download-report`;
        setReportUrl(demoReportUrl);
        setIsValidating(true);
        setViewState('report');
      }, 3500);

      return;
    }

    let processingTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    let waitingTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

    try {
      setLoadingStep('sent');

      const headers: HeadersInit = {
        'Content-Type': 'application/json',
      };

      if (keycloak.authenticated && keycloak.token) {
        headers.Authorization = `Bearer ${keycloak.token}`;
      }

      const fetchPromise = fetch(`${API_BASE_URL}/analyze`, {
        method: 'POST',
        headers,
        body: JSON.stringify(data),
      });

      processingTimer = globalThis.setTimeout(() => {
        setLoadingStep('processing');
      }, 500);

      waitingTimer = globalThis.setTimeout(() => {
        setLoadingStep('waiting');
      }, 2000);

      const response = await fetchPromise;
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.detail || `Erreur API: ${response.status} ${response.statusText}`);
      }

      if (!result.report_url) {
        throw new Error("Le backend n'a pas renvoye report_url.");
      }

      const nextReportUrl = toAbsoluteReportUrl(result.report_url);
      setReportUrl(nextReportUrl);
      setCurrentReportId(result.report_id || extractReportIdFromUrl(nextReportUrl));
      await loadMyReports();
      setIsValidating(true);
      setViewState('report');
    } catch (error) {
      console.error('Erreur lors de l analyse :', error);
      setErrorMessage(
        error instanceof Error ? error.message : 'Impossible de se connecter au backend.'
      );
      setViewState('error');
    } finally {
      if (processingTimer) clearTimeout(processingTimer);
      if (waitingTimer) clearTimeout(waitingTimer);
    }
  };

  const handleNewAnalysis = () => {
    setViewState('form');
    setActiveSection('analysis');
    setFormData(null);
    setChatDraftContext(null);
    setErrorMessage('');
    setReportUrl('');
    setCurrentReportId('');
    setIsValidating(false);
  };

  const handleOpenHistoryReport = (reportId: string, url: string) => {
    setCurrentReportId(reportId);
    setChatDraftContext(null);
    setReportUrl(toAbsoluteReportUrl(url));
    setIsValidating(false);
    setViewState('report');
    setActiveSection('analysis');
  };

  const handleOpenReportEditor = (reportId?: string) => {
    const targetReportId = (reportId || currentReportId || '').trim();
    if (!targetReportId) {
      return;
    }

    setCurrentReportId(targetReportId);
    setChatDraftContext(null);
    setIsValidating(false);
    setViewState('report_editor');
    setActiveSection('analysis');
  };

  const handleReportRegenerated = (reportId: string, nextReportUrl: string) => {
    setCurrentReportId(reportId);
    setChatDraftContext(null);
    setReportUrl(nextReportUrl);
    setIsValidating(false);
    setViewState('report');
    void loadMyReports();
  };

  const handleRetry = () => {
    if (formData) {
      void handleFormSubmit(formData);
    } else {
      handleNewAnalysis();
    }
  };

  let content: ReactNode;

  if (activeSection === 'dashboard') {
    content = (
      <DashboardView
        history={history}
        isApiConnected={isDemoMode || isApiConnected}
        isDemoMode={isDemoMode}
        onStartAnalysis={() => setActiveSection('analysis')}
        onViewHistory={() => setActiveSection('history')}
        onOpenReport={handleOpenHistoryReport}
      />
    );
  } else if (activeSection === 'history') {
    content = (
      <HistoryView
        history={history}
        onOpenReport={handleOpenHistoryReport}
        onEditReport={(reportId: string) => handleOpenReportEditor(reportId)}
        onNewAnalysis={handleNewAnalysis}
      />
    );
  } else {
    content = (
      <>
        {viewState === 'form' && (
          <FormView onSubmit={handleFormSubmit} onDraftChange={setChatDraftContext} />
        )}

        {viewState === 'error' && <ErrorView message={errorMessage} onRetry={handleRetry} />}

        {viewState === 'report' && reportUrl !== '' &&
          (isValidating ? (
            <ValidationView
              appName={formData?.app_name || 'Application'}
              onDownload={() => {
                void (async () => {
                  try {
                    const blobUrl = await fetchReportBlobUrl(reportUrl);
                    const link = document.createElement('a');
                    link.href = blobUrl;
                    link.download = `rapport-${formData?.app_name || 'analyse'}.pdf`;
                    link.click();
                    globalThis.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
                  } catch (error) {
                    setErrorMessage(
                      error instanceof Error
                        ? error.message
                        : 'Impossible de telecharger le rapport.'
                    );
                  }
                })();
              }}
              onBack={handleNewAnalysis}
              onOpenReport={() => setIsValidating(false)}
              onEditResults={() => handleOpenReportEditor()}
              canEditResults={
                currentReport?.status === 'DRAFT' || currentReport?.status === 'REJECTED'
              }
              managerName={currentReport?.validated_by_username ?? null}
            />
          ) : (
            <ReportView
              reportId={currentReportId || undefined}
              reportUrl={reportUrl}
              onNewAnalysis={handleNewAnalysis}
              onEditResults={() => handleOpenReportEditor()}
              canEditResults={
                currentReport?.status === 'DRAFT' || currentReport?.status === 'REJECTED'
              }
              managerName={currentReport?.validated_by_username ?? null}
              statusLabel={currentReport ? STATUS_LABELS[currentReport.status] : null}
            />
          ))}

        {viewState === 'report_editor' && currentReportId !== '' && (
          <ReportResultsEditor
            reportId={currentReportId}
            currentStatus={currentReport?.status ?? 'DRAFT'}
            validatedAt={currentReport?.validated_at ?? null}
            onBack={() => {
              setViewState(reportUrl ? 'report' : 'form');
            }}
            onReportRegenerated={handleReportRegenerated}
          />
        )}
      </>
    );
  }

  return (
    <div className="min-h-screen bg-bg-page font-sans">
      <Navbar
        activeSection={activeSection}
        onNavigate={setActiveSection}
        onLogout={onLogout}
        isDemoMode={isDemoMode}
        isApiConnected={isDemoMode || isApiConnected}
        currentUserName={currentUserName}
        navItems={[
          { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
          { key: 'analysis', label: 'Nouvelle analyse', icon: Layers3 },
          { key: 'history', label: 'Historique', icon: History },
        ]}
      />

      {viewState === 'loading' && <LoadingOverlay step={loadingStep} />}

      {content}
      <SecOpsChatbot
        reportId={currentReportId || undefined}
        draftContext={chatDraftContext}
      />
    </div>
  );
}
