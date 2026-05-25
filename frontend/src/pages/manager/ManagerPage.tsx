import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Check,
  CheckCircle,
  Clock,
  Eye,
  FileText,
  Filter,
  History,
  LayoutDashboard,
  ShieldAlert,
  ShieldCheck,
  TimerReset,
  TrendingUp,
  X,
  XCircle,
} from 'lucide-react';
import { Navbar } from '../../components/Navbar';
import {
  fetchAllReports,
  fetchManagerDashboardMetrics,
  fetchReportBlobUrl,
  toAbsoluteReportUrl,
  updateReportStatus,
} from '../../api/reports';
import { HistoryView } from '../../components/HistoryView';
import { showErrorAlert, showSuccessAlert } from '../../utils/alerts';
import type {
  ManagerDashboardMetrics,
  ReportRecord,
  ReportStatus,
} from '../../types';

type ManagerSection = 'dashboard' | 'validation' | 'history';
type FilterStatus = 'all' | ReportStatus;
type DecisionAction = 'approve' | 'reject';

interface ManagerPageProps {
  currentUserName: string;
  onLogout: () => void;
}

interface ValidationModal {
  open: boolean;
  reportId: string;
  action: DecisionAction;
}

const STATUS_CONFIG = {
  DRAFT: {
    label: 'Brouillon',
    icon: FileText,
    badgeClass: 'bg-slate-100 text-slate-700 border border-slate-200',
  },
  PENDING: {
    label: 'En attente',
    icon: Clock,
    badgeClass: 'bg-amber-100 text-amber-700 border border-amber-200',
  },
  APPROVED: {
    label: 'Approuve',
    icon: CheckCircle,
    badgeClass: 'bg-emerald-100 text-emerald-700 border border-emerald-200',
  },
  REJECTED: {
    label: 'Rejete',
    icon: XCircle,
    badgeClass: 'bg-red-100 text-red-700 border border-red-200',
  },
} as const;

const REJECTION_REASON_OPTIONS = [
  { value: 'INCOHERENCE_CONTEXTE_LLM', label: 'Incoherence contexte LLM' },
  { value: 'MANQUE_MENACE', label: 'Menace manquante' },
  { value: 'MENACE_HORS_CONTEXTE', label: 'Menace hors contexte' },
  { value: 'SCENARIO_ATTAQUE_INCOHERENT', label: "Scenario d'attaque incoherent" },
  { value: 'MITIGATION_INCOHERENTE', label: 'Mitigation incoherente' },
  { value: 'DFD_INCOMPLET', label: 'DFD incomplet' },
  { value: 'DESCRIPTION_APPLICATIVE_INCOHERENTE', label: 'Description applicative incoherente' },
  { value: 'AUTRE', label: 'Autre' },
] as const;

function toDecisionStatus(
  action: DecisionAction
): Extract<ReportStatus, 'APPROVED' | 'REJECTED'> {
  if (action === 'approve') return 'APPROVED';
  if (action === 'reject') return 'REJECTED';
  return 'REJECTED';
}

function decisionTitle(action: DecisionAction): string {
  if (action === 'approve') return 'Confirmer la validation';
  if (action === 'reject') return 'Confirmer le rejet';
  return 'Confirmer la decision';
}

export function ManagerPage({ currentUserName, onLogout }: Readonly<ManagerPageProps>) {
  const [activeSection, setActiveSection] = useState<ManagerSection>('dashboard');
  const [reports, setReports] = useState<ReportRecord[]>([]);
  const [filter, setFilter] = useState<FilterStatus>('all');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewBlobUrl, setPreviewBlobUrl] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [reasonCode, setReasonCode] = useState<string>('MANQUE_MENACE');
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');
  const [dashboardMetrics, setDashboardMetrics] = useState<ManagerDashboardMetrics | null>(null);
  const [validationModal, setValidationModal] = useState<ValidationModal>({
    open: false,
    reportId: '',
    action: 'approve',
  });

  useEffect(() => {
    void loadReports();
  }, []);

  useEffect(() => {
    let currentBlobUrl = '';
    let cancelled = false;

    const loadPreview = async () => {
      if (!previewUrl) {
        setPreviewBlobUrl(null);
        return;
      }

      try {
        const blobUrl = await fetchReportBlobUrl(previewUrl);
        currentBlobUrl = blobUrl;

        if (!cancelled) {
          setPreviewBlobUrl(blobUrl);
        }
      } catch (error) {
        if (!cancelled) {
          setPreviewBlobUrl(null);
          setErrorMessage(
            error instanceof Error ? error.message : 'Impossible de charger le rapport.'
          );
        }
      }
    };

    void loadPreview();

    return () => {
      cancelled = true;
      if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl);
      }
    };
  }, [previewUrl]);

  const loadReports = async () => {
    try {
      setIsLoading(true);
      setErrorMessage('');
      const nextReports = await fetchAllReports();
      const nextMetrics = await fetchManagerDashboardMetrics();
      setReports(
        nextReports.map((report) => ({
          ...report,
          report_url: toAbsoluteReportUrl(report.report_url),
        }))
      );
      setDashboardMetrics(nextMetrics);
    } catch (error) {
      console.error('Erreur chargement rapports manager :', error);
      setErrorMessage(
        error instanceof Error ? error.message : 'Impossible de charger les rapports.'
      );
    } finally {
      setIsLoading(false);
    }
  };

  const filteredReports = useMemo(() => {
    if (filter === 'all') return reports;
    return reports.filter((report) => report.status === filter);
  }, [filter, reports]);

  const counts = useMemo(
    () => ({
      all: reports.length,
      DRAFT: 0,
      PENDING: reports.filter((report) => report.status === 'PENDING').length,
      APPROVED: reports.filter((report) => report.status === 'APPROVED').length,
      REJECTED: reports.filter((report) => report.status === 'REJECTED').length,
    }),
    [reports]
  );

  const pendingReports = useMemo(
    () => reports.filter((report) => report.status === 'PENDING').slice(0, 3),
    [reports]
  );

  const historyItems = useMemo(() => reports.slice(), [reports]);

  const openValidation = (reportId: string, action: DecisionAction) => {
    setComment('');
    setReasonCode('MANQUE_MENACE');
    setValidationModal({ open: true, reportId, action });
  };

  const submitValidation = async () => {
    const isCommentRequired = validationModal.action === 'reject';

    if (isCommentRequired && comment.trim() === '') return;

    try {
      const updatedReport = await updateReportStatus(
        validationModal.reportId,
        toDecisionStatus(validationModal.action),
        comment,
        validationModal.action === 'reject'
          ? [
              {
                decision_type: 'REJECTED',
                reason_code: reasonCode,
                section_type: 'GLOBAL',
                comment: comment.trim(),
              },
            ]
          : []
      );

      setReports((currentReports) =>
        currentReports.map((report) =>
          report.id === updatedReport.id
            ? {
                ...updatedReport,
                report_url: toAbsoluteReportUrl(updatedReport.report_url),
              }
            : report
        )
      );
      setValidationModal({ open: false, reportId: '', action: 'approve' });
      setComment('');
      await showSuccessAlert(
        validationModal.action === 'approve' ? 'Rapport validé' : 'Rapport rejeté',
        'L’opération a été effectuée avec succès.'
      );
    } catch (error) {
      console.error('Erreur validation manager :', error);
      const message =
        error instanceof Error ? error.message : 'Impossible de mettre a jour le statut.';
      setErrorMessage(message);
      await showErrorAlert('Opération impossible', message);
    }
  };

  let sectionContent: ReactNode;

  if (activeSection === 'dashboard') {
    sectionContent = (
      <div className="space-y-6">
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
          <InsightCard
            label="Taux d'approbation"
            value={`${dashboardMetrics?.approval_rate ?? 0}%`}
            icon={TrendingUp}
            tone="emerald"
            helper={`${dashboardMetrics?.approved_reports ?? 0} rapport(s) approuve(s)`}
          />
          <InsightCard
            label="Temps moyen avant validation"
            value={
              dashboardMetrics?.average_validation_time_hours != null
                ? `${dashboardMetrics.average_validation_time_hours}h`
                : 'N/A'
            }
            icon={TimerReset}
            tone="blue"
            helper="Calcul base sur les rapports decides"
          />
          <InsightCard
            label="Menaces les plus frequentes"
            value={`${dashboardMetrics?.most_frequent_threats[0]?.count ?? 0}`}
            icon={ShieldAlert}
            tone="amber"
            helper={dashboardMetrics?.most_frequent_threats[0]?.threat_name || 'Aucune menace'}
          />
          <InsightCard
            label="Application la plus risquee"
            value={`${dashboardMetrics?.riskiest_applications[0]?.risk_score ?? 0}`}
            icon={ShieldAlert}
            tone="red"
            helper={dashboardMetrics?.riskiest_applications[0]?.app_name || 'Aucune application'}
          />
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-5 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold text-slate-900">Rapports par mois</h2>
                <p className="mt-1 text-sm text-slate-500">Vision de l'activite manager dans le temps.</p>
              </div>
            </div>

            {isLoading ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-500">
                Chargement des indicateurs...
              </div>
            ) : !dashboardMetrics || dashboardMetrics.reports_by_month.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-500">
                Aucune donnee mensuelle disponible.
              </div>
            ) : (
              <div className="space-y-4">
                {dashboardMetrics.reports_by_month.map((entry) => {
                  const maxCount = Math.max(...dashboardMetrics.reports_by_month.map((item) => item.count), 1);
                  const width = `${Math.max((entry.count / maxCount) * 100, 8)}%`;
                  return (
                    <div key={entry.month}>
                      <div className="mb-1 flex items-center justify-between text-sm">
                        <span className="font-medium text-slate-700">{entry.month}</span>
                        <span className="text-slate-500">{entry.count} rapport(s)</span>
                      </div>
                      <div className="h-3 rounded-full bg-slate-100">
                        <div
                          className="h-3 rounded-full bg-gradient-to-r from-amber-500 to-orange-500"
                          style={{ width }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-xl font-bold text-slate-900">Menaces les plus frequentes</h2>
            <p className="mt-1 text-sm text-slate-500">Menaces revenant le plus souvent dans les rapports.</p>

            {isLoading ? (
              <div className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-500">
                Chargement des menaces...
              </div>
            ) : !dashboardMetrics || dashboardMetrics.most_frequent_threats.length === 0 ? (
              <div className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-500">
                Aucune menace disponible.
              </div>
            ) : (
              <div className="mt-5 space-y-3">
                {dashboardMetrics.most_frequent_threats.map((threat, index) => (
                  <div
                    key={`${threat.threat_name}-${index}`}
                    className="flex items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3"
                  >
                    <div>
                      <p className="font-semibold text-slate-900">{threat.threat_name}</p>
                      <p className="text-xs text-slate-500">Occurrence dans les rapports</p>
                    </div>
                    <span className="rounded-full bg-white px-3 py-1 text-sm font-bold text-slate-900">
                      {threat.count}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.05fr_0.95fr]">
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="mb-5 text-xl font-bold text-slate-900">Applications les plus risquees</h2>

            {isLoading ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-500">
                Chargement des applications...
              </div>
            ) : !dashboardMetrics || dashboardMetrics.riskiest_applications.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-500">
                Aucune application disponible.
              </div>
            ) : (
              <div className="space-y-4">
                {dashboardMetrics.riskiest_applications.map((app) => (
                  <article
                    key={app.report_id}
                    className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                  >
                    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                      <div>
                        <p className="font-semibold text-slate-900">{app.app_name}</p>
                        <p className="mt-1 text-xs text-slate-500">
                          {app.threat_count} menace(s) · {app.scenario_count} scenario(s) · {app.mitigation_count} mitigation(s)
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="rounded-full bg-red-100 px-3 py-1 text-sm font-bold text-red-700">
                          Score {app.risk_score}
                        </span>
                        <button
                          onClick={() => {
                            const report = reports.find((item) => item.id === app.report_id);
                            if (report) setPreviewUrl(report.report_url);
                          }}
                          className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:border-accent-primary hover:text-accent-primary"
                        >
                          <Eye className="h-4 w-4" />
                          Voir
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="mb-5 text-xl font-bold text-slate-900">Rapports a traiter</h2>

            {isLoading ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-500">
                Chargement des rapports...
              </div>
            ) : pendingReports.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-500">
                Aucun rapport en attente pour le moment.
              </div>
            ) : (
              <div className="space-y-4">
                {pendingReports.map((report) => (
                  <article
                    key={report.id}
                    className="rounded-2xl border border-slate-200 bg-slate-50 p-5 transition hover:bg-white hover:shadow-sm"
                  >
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                      <div>
                        <p className="font-semibold text-slate-900">{report.app_name}</p>
                        <p className="text-sm text-slate-500 mt-1">{report.summary}</p>
                        <p className="text-xs text-slate-500 mt-2">
                          Analyste: {report.generated_by_username || 'N/A'} · Soumis le{' '}
                          {new Date(report.generated_at).toLocaleDateString('fr-FR')}
                        </p>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setPreviewUrl(report.report_url)}
                          className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-accent-primary hover:text-accent-primary"
                        >
                          <Eye className="h-4 w-4" />
                          Voir
                        </button>
                        <button
                          onClick={() => openValidation(report.id, 'approve')}
                          className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700"
                        >
                          <Check className="h-4 w-4" />
                          Valider
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  } else if (activeSection === 'validation') {
    sectionContent = (
      <>
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <Filter className="h-4 w-4 text-slate-500" />
          {([
            ['all', 'Tous'],
            ['PENDING', 'En attente'],
            ['APPROVED', 'Approuves'],
            ['REJECTED', 'Rejetes'],
          ] as Array<[FilterStatus, string]>).map(([statusKey, label]) => {
            const isActive = filter === statusKey;
            return (
              <button
                key={statusKey}
                onClick={() => setFilter(statusKey)}
                className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
                  isActive
                    ? 'bg-accent-primary text-white'
                    : 'border border-slate-200 bg-white text-slate-600 hover:border-accent-primary hover:text-accent-primary'
                }`}
              >
                {label} ({statusKey === 'all' ? counts.all : counts[statusKey]})
              </button>
            );
          })}
        </div>

        {isLoading ? (
          <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500 shadow-sm">
            Chargement des rapports...
          </div>
        ) : filteredReports.length === 0 ? (
          <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500 shadow-sm">
            Aucun rapport pour ce filtre.
          </div>
        ) : (
          <div className="space-y-4">
            {filteredReports.map((report) => {
              const status = STATUS_CONFIG[report.status];
              const StatusIcon = status.icon;
              const latestComment = report.status_history.find((entry) => Boolean(entry.comment))?.comment;

              return (
                <article
                  key={report.id}
                  className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm"
                >
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <h3 className="text-lg font-bold text-slate-900">{report.app_name}</h3>
                        <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${status.badgeClass}`}>
                          <StatusIcon className="h-3.5 w-3.5" />
                          {status.label}
                        </span>
                      </div>

                      <p className="text-sm text-slate-600">{report.summary}</p>
                      <p className="mt-2 text-xs text-slate-500">
                        Analyste: {report.generated_by_username || 'N/A'} · Genere le{' '}
                        {new Date(report.generated_at).toLocaleDateString('fr-FR')}
                      </p>

                      {report.validated_at && (
                        <p className="mt-1 text-xs text-slate-500">
                          Decision manager: {new Date(report.validated_at).toLocaleDateString('fr-FR')} par{' '}
                          {report.validated_by_username || currentUserName}
                        </p>
                      )}

                      {latestComment && (
                        <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                          <span className="font-semibold">Dernier commentaire:</span> {latestComment}
                        </div>
                      )}

                      {report.annotations.length > 0 && (
                        <div className="mt-3 rounded-xl border border-slate-200 bg-white px-3 py-2">
                          <p className="mb-2 text-xs font-semibold text-slate-700">Annotations</p>
                          <ul className="space-y-1">
                            {report.annotations.map((annotation) => (
                              <li key={annotation.id} className="text-xs text-slate-600">
                                - {annotation.annotation}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>

                    <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto lg:flex-col lg:items-stretch">
                      <button
                        onClick={() => setPreviewUrl(report.report_url)}
                        className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-accent-primary hover:text-accent-primary"
                      >
                        <Eye className="h-4 w-4" />
                        Voir rapport
                      </button>

                      {report.status === 'PENDING' && (
                        <>
                          <button
                            onClick={() => openValidation(report.id, 'approve')}
                            className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700"
                          >
                            <Check className="h-4 w-4" />
                            Valider
                          </button>
                          <button
                            onClick={() => openValidation(report.id, 'reject')}
                            className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-100"
                          >
                            <X className="h-4 w-4" />
                            Rejeter
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </>
    );
  } else {
    sectionContent = (
      <HistoryView
        history={historyItems}
        onOpenReport={(_, url) => setPreviewUrl(toAbsoluteReportUrl(url))}
        showNewAnalysisButton={false}
        title="Historique des rapports"
        subtitle="Consultez tous les rapports soumis par les secops engineers, y compris les anciennes versions et validations précédentes."
      />
    );
  }

  return (
    <div className="min-h-screen bg-bg-page font-sans">
      <Navbar
        activeSection={activeSection}
        onNavigate={setActiveSection}
        onLogout={onLogout}
        isApiConnected
        isDemoMode={false}
        currentUserName={currentUserName}
        navItems={[
          { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
          { key: 'validation', label: 'Validation', icon: History },
          { key: 'history', label: 'Historique', icon: FileText },
        ]}
      />

      <div className="mx-auto max-w-[1400px] px-4 sm:px-6 lg:px-8 pt-40 pb-12">
        <div className="mb-10">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 shadow-sm">
            <ShieldCheck className="h-4 w-4 text-accent-primary" />
            <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Manager Workspace
            </span>
          </div>

          <h1 className="mb-3 text-4xl font-bold tracking-tight text-slate-900 md:text-5xl">
            Validation des rapports
          </h1>

          <p className="max-w-3xl text-base leading-relaxed text-slate-500 md:text-lg">
            Consultez les rapports generes par les secops engineers, ajoutez des annotations et decidez leur statut final.
          </p>
        </div>

        <div className="mb-8 grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-6">
          <StatCard label="Total" value={counts.all} icon={FileText} colorClass="bg-slate-900 text-white" />
          <StatCard label="En attente" value={counts.PENDING} icon={Clock} colorClass="bg-amber-100 text-amber-700" />
          <StatCard label="Approuves" value={counts.APPROVED} icon={CheckCircle} colorClass="bg-emerald-100 text-emerald-700" />
          <StatCard label="Rejetes" value={counts.REJECTED} icon={XCircle} colorClass="bg-red-100 text-red-700" />
        </div>

        {errorMessage && (
          <div className="mb-6 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {errorMessage}
          </div>
        )}

        {sectionContent}
      </div>

      {validationModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            className="absolute inset-0 bg-black/50"
            onClick={() => setValidationModal({ open: false, reportId: '', action: 'approve' })}
            aria-label="Fermer"
          />
          <div className="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
            <h2 className="text-lg font-bold text-slate-900">
              {decisionTitle(validationModal.action)}
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Ajoutez une annotation pour tracer la decision manager.
            </p>

            {validationModal.action === 'reject' && (
              <>
                <label htmlFor="manager-reason-code" className="mt-4 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Motif structure
                </label>
                <select
                  id="manager-reason-code"
                  value={reasonCode}
                  onChange={(event) => setReasonCode(event.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-accent-primary focus:outline-none"
                >
                  {REJECTION_REASON_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </>
            )}

            <label htmlFor="manager-comment" className="mt-4 block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Annotation
            </label>
            <textarea
              id="manager-comment"
              rows={4}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-accent-primary focus:outline-none"
              placeholder="Saisir une note pour le secops engineer..."
            />

            <div className="mt-5 flex gap-3">
              <button
                onClick={() => setValidationModal({ open: false, reportId: '', action: 'approve' })}
                className="flex-1 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-600 transition hover:bg-slate-50"
              >
                Annuler
              </button>
              <button
                onClick={() => void submitValidation()}
                disabled={
                  validationModal.action === 'reject' && comment.trim() === ''
                }
                className="flex-1 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Confirmer
              </button>
            </div>
          </div>
        </div>
      )}

      {previewUrl && (
        <div className="fixed inset-0 z-50 flex flex-col bg-white">
          <div className="flex items-center justify-between border-b border-slate-200 px-6 py-3">
            <h2 className="text-base font-bold text-slate-900">Apercu du rapport</h2>
            <button
              onClick={() => {
                setPreviewUrl(null);
                setPreviewBlobUrl(null);
              }}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-1.5 text-sm font-semibold text-slate-700 transition hover:border-accent-primary hover:text-accent-primary"
            >
              <X className="h-4 w-4" />
              Fermer
            </button>
          </div>
          {previewBlobUrl ? (
            <iframe
              src={previewBlobUrl}
              className="h-full w-full border-none"
              title="Apercu du rapport"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-sm text-slate-500">
              Chargement du rapport...
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  icon: Icon,
  colorClass,
}: Readonly<{
  label: string;
  value: number;
  icon: typeof FileText;
  colorClass: string;
}>) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition-all duration-200 hover:-translate-y-1 hover:shadow-xl">
      <div className="mb-4 flex items-center justify-between">
        <div className={`flex h-11 w-11 items-center justify-center rounded-xl ${colorClass}`}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
      <p className="mb-1 text-sm font-medium text-slate-500">{label}</p>
      <p className="text-4xl font-bold text-slate-900">{value}</p>
    </div>
  );
}

function InsightCard({
  label,
  value,
  helper,
  icon: Icon,
  tone,
}: Readonly<{
  label: string;
  value: string;
  helper: string;
  icon: typeof FileText;
  tone: 'emerald' | 'blue' | 'amber' | 'red';
}>) {
  const toneClasses = {
    emerald: 'bg-emerald-100 text-emerald-700',
    blue: 'bg-sky-100 text-sky-700',
    amber: 'bg-amber-100 text-amber-700',
    red: 'bg-red-100 text-red-700',
  } as const;

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <div className={`flex h-11 w-11 items-center justify-center rounded-xl ${toneClasses[tone]}`}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
      <p className="text-sm font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-3xl font-bold text-slate-900">{value}</p>
      <p className="mt-2 text-xs text-slate-500">{helper}</p>
    </div>
  );
}
