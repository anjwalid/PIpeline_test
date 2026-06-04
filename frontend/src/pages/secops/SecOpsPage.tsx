import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { History, Layers3, LayoutDashboard } from 'lucide-react';
import { Navbar, type NavbarBackAction, type NavbarNotificationCenter } from '../../components/Navbar';
import { FormView } from '../../components/FormView';
import { ErrorView } from '../../components/ErrorView';
import { LoadingOverlay } from '../../components/LoadingOverlay';
import { ReportView } from '../../components/ReportView';
import { ReportResultsEditor } from '../../components/ReportResultsEditor';
import { ValidationView } from '../../components/ValidationView';
import { HistoryView } from '../../components/HistoryView';
import { DashboardView } from '../../components/DashboardView';
import { SecOpsChatbot } from '../../components/SecOpsChatbot';
import { SpotlightOverlay } from '../../components/SpotlightOverlay';
import type { SpotlightStep } from '../../components/SpotlightOverlay';
import { WelcomeGuideCard } from '../../components/WelcomeGuideCard';
import { API_BASE_URL } from '../../config';
import { fetchGuideSteps } from '../../api/knowledge';
import {
  deleteReport,
  fetchMyReports,
  fetchReportBlobUrl,
  toAbsoluteReportUrl,
} from '../../api/reports';
import { showConfirmAlert, showErrorAlert, showSuccessAlert } from '../../utils/alerts';
import type {
  AnalysisSubmitPayload,
  ReportRecord,
  SecOpsChatDraftContext,
} from '../../types';
import { buildAuthenticatedHeaders } from '../../auth/apiAuth';
import { pushBrowserPath } from '../../utils/navigation';

type ViewState = 'form' | 'loading' | 'error' | 'report' | 'report_editor';
type LoadingStep = 'starting' | 'sent' | 'processing' | 'waiting';
type SecOpsSection = 'analysis' | 'history' | 'dashboard';
interface ApiErrorDetail {
  error_type?: string;
  message?: string;
  blocked_entity?: string;
  guardrail_name?: string;
}

interface TourStep extends SpotlightStep {
  navigateTo?: { section: SecOpsSection; viewState?: ViewState };
  needsMenuOpen?: boolean;
}

const TOURS_FALLBACK: Record<string, TourStep[]> = {
  TOUR_ANALYSE: [
    { target: 'nav-menu', title: 'Menu de navigation', description: 'Cliquez pour ouvrir le menu.' },
    { target: 'analysis', title: 'Nouvelle analyse', description: "Lancez le questionnaire d'analyse.", navigateTo: { section: 'analysis', viewState: 'form' }, needsMenuOpen: true },
    { target: 'form-app-name', title: "Nom de l'application", description: "Commencez par renseigner le nom de l'application." },
    { target: 'form-nav-buttons', title: 'Navigation du questionnaire', description: "Utilisez Suivant pour avancer jusqu'au lancement de l'analyse." },
  ],
  TOUR_HISTORY: [
    { target: 'nav-menu', title: 'Menu de navigation', description: 'Cliquez pour ouvrir le menu.' },
    { target: 'history', title: 'Historique', description: 'Retrouvez ici tous vos rapports.', navigateTo: { section: 'history' }, needsMenuOpen: true },
    { target: 'history-list', title: 'Liste des rapports', description: 'Ouvrez, modifiez ou supprimez vos brouillons depuis cette vue.' },
  ],
  TOUR_DASHBOARD: [
    { target: 'nav-menu', title: 'Menu de navigation', description: 'Cliquez pour ouvrir le menu.' },
    { target: 'dashboard', title: 'Dashboard', description: "Vue d'ensemble de votre activite.", navigateTo: { section: 'dashboard' }, needsMenuOpen: true },
    { target: 'dashboard-stats', title: 'Indicateurs', description: 'Ces cartes resument les analyses et validations.' },
  ],
};

const STATUS_LABELS = {
  DRAFT: 'Brouillon',
  PENDING: 'En attente manager',
  APPROVED: 'Approuve',
  REJECTED: 'Rejete',
} as const;

function buildStableNotificationId(reportId: string, status: string, changedAt: string) {
  return `${reportId}:${status}:${changedAt}`;
}

function extractApiErrorMessage(
  detail: string | ApiErrorDetail | null | undefined,
  fallback: string
): string {
  if (typeof detail === 'string' && detail.trim()) {
    return detail;
  }

  if (detail && typeof detail === 'object') {
    const message = String(detail.message || '').trim();
    if (message) {
      return message;
    }
  }

  return fallback;
}

function readStoredStringArray(storageKey: string): string[] {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const rawValue = window.localStorage.getItem(storageKey);
    if (!rawValue) {
      return [];
    }

    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function writeStoredStringArray(storageKey: string, values: string[]) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(storageKey, JSON.stringify(values));
}

interface SecOpsPageProps {
  currentUserName: string;
  onLogout: () => void;
}

function parseSecOpsPath(pathname: string): {
  activeSection: SecOpsSection;
  viewState: ViewState;
  reportId: string;
} {
  const segments = pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (segments[0] !== 'secops') {
    return { activeSection: 'dashboard', viewState: 'form', reportId: '' };
  }

  if (segments[1] === 'history') {
    return { activeSection: 'history', viewState: 'form', reportId: '' };
  }

  if (segments[1] === 'analysis') {
    if (segments[2] === 'report') {
      const reportId = segments[3] ?? '';
      const viewState = segments[4] === 'edit' ? 'report_editor' : 'report';
      return { activeSection: 'analysis', viewState, reportId };
    }

    return { activeSection: 'analysis', viewState: 'form', reportId: '' };
  }

  return { activeSection: 'dashboard', viewState: 'form', reportId: '' };
}

function buildSecOpsPath(
  activeSection: SecOpsSection,
  viewState: ViewState,
  reportId: string
): string {
  if (activeSection === 'dashboard') {
    return '/secops/dashboard';
  }

  if (activeSection === 'history') {
    return '/secops/history';
  }

  if (viewState === 'report_editor' && reportId) {
    return `/secops/analysis/report/${reportId}/edit`;
  }

  if (viewState === 'report' && reportId) {
    return `/secops/analysis/report/${reportId}`;
  }

  return '/secops/analysis';
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
  const [returnSection, setReturnSection] = useState<Extract<SecOpsSection, 'dashboard' | 'history'>>('dashboard');
  const [notificationsReadAt, setNotificationsReadAt] = useState<string | null>(null);
  const [dismissedNotificationIds, setDismissedNotificationIds] = useState<string[]>([]);
  const [activeTourSteps, setActiveTourSteps] = useState<TourStep[]>([]);
  const [tourStepIndex, setTourStepIndex] = useState(0);
  const [menuForceOpen, setMenuForceOpen] = useState(false);
  const [toursFromDb, setToursFromDb] = useState<Record<string, TourStep[]>>(TOURS_FALLBACK);
  const currentReport = history.find((report) => report.id === currentReportId);
  const notificationStorageKey = `awb.secops.notifications.readAt.${currentUserName}`;
  const dismissedNotificationStorageKey = `awb.secops.notifications.dismissed.${currentUserName}`;

  const extractReportIdFromUrl = (url: string): string => {
    const match = /\/reports\/([^/]+)\/download/.exec(url || '');
    return match?.[1] || '';
  };

  useEffect(() => {
    const syncFromLocation = () => {
      if (typeof window === 'undefined') {
        return;
      }

      const route = parseSecOpsPath(window.location.pathname);
      setActiveSection(route.activeSection);
      setViewState(route.viewState);
      setCurrentReportId(route.reportId);
    };

    syncFromLocation();
    window.addEventListener('popstate', syncFromLocation);
    return () => window.removeEventListener('popstate', syncFromLocation);
  }, []);

  useEffect(() => {
    pushBrowserPath(buildSecOpsPath(activeSection, viewState, currentReportId));
  }, [activeSection, viewState, currentReportId]);

  useEffect(() => {
    checkApiConnection();
    void loadMyReports();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const steps = await fetchGuideSteps();
        if (!steps.length) {
          return;
        }

        const grouped: Record<string, TourStep[]> = {};
        for (const step of steps) {
          if (!grouped[step.tour_id]) {
            grouped[step.tour_id] = [];
          }
          grouped[step.tour_id].push({
            target: step.target ?? step.nav_section ?? step.tour_id.toLowerCase(),
            title: step.title,
            description: step.description,
            navigateTo:
              step.nav_section === 'analysis' ||
              step.nav_section === 'history' ||
              step.nav_section === 'dashboard'
                ? { section: step.nav_section }
                : undefined,
            needsMenuOpen: Boolean(step.nav_section),
          });
        }

        setToursFromDb({ ...TOURS_FALLBACK, ...grouped });
      } catch {
        // Conserve le fallback local si l'API de connaissance n'est pas disponible.
      }
    })();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const storedValue = window.localStorage.getItem(notificationStorageKey);
    setNotificationsReadAt(storedValue);
    setDismissedNotificationIds(readStoredStringArray(dismissedNotificationStorageKey));
  }, [dismissedNotificationStorageKey, notificationStorageKey]);

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

      const fetchPromise = fetch(`${API_BASE_URL}/analyze`, {
        method: 'POST',
        headers: await buildAuthenticatedHeaders({ contentType: 'application/json' }),
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
        const detail = result?.detail as string | ApiErrorDetail | undefined;
        if (
          response.status === 403 &&
          detail &&
          typeof detail === 'object' &&
          detail.error_type === 'GUARDRAIL_BLOCKED'
        ) {
          await showErrorAlert(
            'Action non autorisee',
            extractApiErrorMessage(
              detail,
              "Cette demande contrevient a la strategie de protection AWB. Retirez les donnees sensibles ou les liens non autorises."
            )
          );
          setViewState('form');
          setActiveSection('analysis');
          return;
        }

        throw new Error(
          extractApiErrorMessage(
            detail,
            `Erreur API: ${response.status} ${response.statusText}`
          )
        );
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
    setReturnSection(activeSection === 'history' ? 'history' : 'dashboard');
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

  const handleDeleteReport = async (reportId: string) => {
    const targetReport = history.find((report) => report.id === reportId);
    const confirmed = await showConfirmAlert({
      title: 'Supprimer cette analyse ?',
      text: 'Cette action est disponible uniquement pour les brouillons et est irreversible.',
      confirmButtonText: 'Supprimer',
      cancelButtonText: 'Annuler',
      icon: 'warning',
    });

    if (!confirmed) {
      return;
    }

    try {
      await deleteReport(reportId);
      const nextHistory = history.filter((report) => report.id !== reportId);
      setHistory(nextHistory);

      if (currentReportId === reportId) {
        setCurrentReportId('');
        setReportUrl('');
        setIsValidating(false);
        setViewState('form');
      }

      await showSuccessAlert(
        'Analyse supprimee',
        `${targetReport?.app_name || 'Le brouillon'} a ete supprime.`
      );
    } catch (error) {
      await showErrorAlert(
        'Suppression impossible',
        error instanceof Error ? error.message : "Impossible de supprimer l'analyse."
      );
    }
  };

  const handleRetry = () => {
    if (formData) {
      void handleFormSubmit(formData);
    } else {
      handleNewAnalysis();
    }
  };

  const applyTourStep = (step: TourStep) => {
    if (step.navigateTo) {
      setActiveSection(step.navigateTo.section);
      if (step.navigateTo.viewState) {
        setViewState(step.navigateTo.viewState);
      }
    }
    setMenuForceOpen(step.needsMenuOpen ?? false);
  };

  const handleStartTour = (tourId: string) => {
    const steps = toursFromDb[tourId];
    if (!steps?.length) {
      return;
    }

    applyTourStep(steps[0]);
    setActiveTourSteps(steps);
    setTourStepIndex(0);
  };

  const handleTourNext = () => {
    const nextIndex = tourStepIndex + 1;
    if (nextIndex >= activeTourSteps.length) {
      setActiveTourSteps([]);
      setTourStepIndex(0);
      setMenuForceOpen(false);
      return;
    }

    applyTourStep(activeTourSteps[nextIndex]);
    setTourStepIndex(nextIndex);
  };

  const handleTourPrev = () => {
    if (tourStepIndex === 0) {
      return;
    }

    const previousIndex = tourStepIndex - 1;
    applyTourStep(activeTourSteps[previousIndex]);
    setTourStepIndex(previousIndex);
  };

  const endTour = () => {
    setActiveTourSteps([]);
    setTourStepIndex(0);
    setMenuForceOpen(false);
  };

  const handleGuideNavigate = (section: string) => {
    if (section === 'nav-menu') {
      setActiveTourSteps([
        {
          target: 'nav-menu',
          title: 'Menu de navigation',
          description: "Ce bouton ouvre l'ensemble des sections disponibles.",
        },
      ]);
      setTourStepIndex(0);
      return;
    }

    if (section === 'analysis' || section === 'history' || section === 'dashboard') {
      setActiveSection(section);
      if (section === 'analysis') {
        setViewState('form');
      }
    }
  };

  const notificationEvents = useMemo(() => {
    return history
      .flatMap((report) => {
        const latestDecision = [...(report.status_history || [])]
          .filter((entry) => entry.new_status === 'APPROVED' || entry.new_status === 'REJECTED')
          .sort(
            (left, right) =>
              new Date(right.changed_at).getTime() - new Date(left.changed_at).getTime()
          )[0];

        if (!latestDecision || !latestDecision.changed_at) {
          return [];
        }

        const isApproved = latestDecision.new_status === 'APPROVED';
        return [
          {
            id: buildStableNotificationId(
              report.id,
              latestDecision.new_status,
              latestDecision.changed_at
            ),
            changedAt: latestDecision.changed_at,
            title: isApproved
              ? `${report.app_name} a ete approuve`
              : `${report.app_name} demande une correction`,
            description: isApproved
              ? `Validation manager par ${latestDecision.changed_by_username || 'manager'} le ${new Date(latestDecision.changed_at).toLocaleString('fr-FR')}.`
              : `Le manager ${latestDecision.changed_by_username || ''} a rejete ce rapport. Consultez le retour pour corriger puis resoumettre.`,
          },
        ];
      })
      .sort(
        (left, right) =>
          new Date(right.changedAt).getTime() - new Date(left.changedAt).getTime()
      );
  }, [history]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const existingIds = new Set(notificationEvents.map((item) => item.id));
    const nextDismissedIds = dismissedNotificationIds.filter((id) => existingIds.has(id));

    if (nextDismissedIds.length !== dismissedNotificationIds.length) {
      writeStoredStringArray(dismissedNotificationStorageKey, nextDismissedIds);
      setDismissedNotificationIds(nextDismissedIds);
    }
  }, [dismissedNotificationIds, dismissedNotificationStorageKey, notificationEvents]);

  const visibleNotificationEvents = useMemo(
    () => notificationEvents.filter((item) => !dismissedNotificationIds.includes(item.id)),
    [dismissedNotificationIds, notificationEvents]
  );

  const notificationCenter = useMemo<NavbarNotificationCenter | null>(() => {
    if (visibleNotificationEvents.length === 0) {
      return {
        title: 'Notifications SecOps',
        unreadCount: 0,
        items: [],
      };
    }

    const readAtMs = notificationsReadAt ? new Date(notificationsReadAt).getTime() : 0;
    const unreadCount = visibleNotificationEvents.filter(
      (item) => new Date(item.changedAt).getTime() > readAtMs
    ).length;

    return {
      title: 'Notifications SecOps',
      unreadCount,
      items: visibleNotificationEvents.slice(0, 8).map((item) => ({
        id: item.id,
        title: item.title,
        description: item.description,
      })),
      onDeleteItem: (id: string) => {
        if (typeof window === 'undefined') {
          return;
        }

        setDismissedNotificationIds((current) => {
          const next = current.includes(id) ? current : [...current, id];
          writeStoredStringArray(dismissedNotificationStorageKey, next);
          return next;
        });
      },
      onClearAll: () => {
        if (typeof window === 'undefined') {
          return;
        }

        const next = visibleNotificationEvents.map((item) => item.id);
        writeStoredStringArray(dismissedNotificationStorageKey, next);
        setDismissedNotificationIds(next);
      },
    };
  }, [
    dismissedNotificationStorageKey,
    notificationsReadAt,
    visibleNotificationEvents,
  ]);

  const handleNotificationOpenChange = (isOpen: boolean) => {
    if (!isOpen || visibleNotificationEvents.length === 0 || typeof window === 'undefined') {
      return;
    }

    const latestTimestamp = visibleNotificationEvents[0].changedAt;
    window.localStorage.setItem(notificationStorageKey, latestTimestamp);
    setNotificationsReadAt(latestTimestamp);
  };

  const backAction = useMemo<NavbarBackAction | null>(() => {
    if (activeSection === 'history') {
      return {
        label: 'Retour dashboard',
        onClick: () => setActiveSection('dashboard'),
      };
    }

    if (activeSection !== 'analysis') {
      return null;
    }

    if (viewState === 'error' || viewState === 'loading') {
      return {
        label: 'Retour analyse',
        onClick: () => setViewState('form'),
      };
    }

    if (viewState === 'report_editor') {
      return {
        label: 'Retour rapport',
        onClick: () => setViewState(reportUrl ? 'report' : 'form'),
      };
    }

    if (viewState === 'report') {
      return {
        label: isValidating
          ? 'Retour analyse'
          : returnSection === 'history'
            ? 'Retour historique'
            : 'Retour dashboard',
        onClick: () => {
          if (isValidating) {
            setViewState('form');
            return;
          }
          setActiveSection(returnSection);
        },
      };
    }

    return {
      label: 'Retour dashboard',
      onClick: () => setActiveSection('dashboard'),
    };
  }, [activeSection, isValidating, reportUrl, returnSection, viewState]);

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
        onDeleteReport={(reportId: string) => void handleDeleteReport(reportId)}
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
              report={currentReport ?? null}
            />
          ))}

        {viewState === 'report_editor' && currentReportId !== '' && (
          <ReportResultsEditor
            reportId={currentReportId}
            currentStatus={currentReport?.status ?? 'DRAFT'}
            report={currentReport ?? null}
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
        forceOpen={menuForceOpen}
        navItems={[
          { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
          { key: 'analysis', label: 'Nouvelle analyse', icon: Layers3 },
          { key: 'history', label: 'Historique', icon: History },
        ]}
        notificationCenter={notificationCenter}
        onNotificationOpenChange={handleNotificationOpenChange}
        backAction={backAction}
      />

      {viewState === 'loading' && <LoadingOverlay step={loadingStep} />}

      {content}
      <SecOpsChatbot
        reportId={currentReportId || undefined}
        draftContext={chatDraftContext}
        currentSection={activeSection}
        viewState={activeSection === 'analysis' ? viewState : undefined}
        onGuideNavigate={handleGuideNavigate}
        onStartTour={handleStartTour}
      />

      {activeTourSteps.length > 0 && (
        <SpotlightOverlay
          steps={activeTourSteps}
          currentIndex={tourStepIndex}
          onPrev={handleTourPrev}
          onNext={handleTourNext}
          onDismiss={endTour}
        />
      )}

      <WelcomeGuideCard currentUserName={currentUserName} onStartTour={handleStartTour} />
    </div>
  );
}
