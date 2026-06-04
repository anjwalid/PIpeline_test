import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { ArrowLeft, FilePlus2, ImageUp, RefreshCcw, Save, Trash2 } from 'lucide-react';
import { DfdStudio } from './DfdStudio';
import {
  fetchReportResults,
  regenerateReport,
  toAbsoluteReportUrl,
  updateReportStatus,
  updateReportResults,
  uploadReportDfd,
} from '../api/reports';
import {
  showErrorAlert,
  showInfoAlert,
  showSuccessAlert,
} from '../utils/alerts';
import type {
  EditableThreat,
  ReportRecord,
  ReportResultsPayload,
  ReportStatus,
  SecOpsModificationReason,
} from '../types';

interface ReportResultsEditorProps {
  reportId: string;
  currentStatus: ReportStatus;
  report?: ReportRecord | null;
  validatedAt?: string | null;
  onBack: () => void;
  onReportRegenerated: (reportId: string, reportUrl: string) => void;
}

type PendingAction = 'save' | 'regenerate' | 'submit';

const SECOPS_REASON_OPTIONS = [
  { value: 'INCOHERENCE_CONTEXTE_LLM', label: 'Incoherence contexte LLM' },
  { value: 'MANQUE_MENACE', label: 'Menace manquante' },
  { value: 'MENACE_HORS_CONTEXTE', label: 'Menace hors contexte' },
  { value: 'SCENARIO_ATTAQUE_MANQUANT', label: "Scenario d'attaque manquant" },
  { value: 'MITIGATION_MANQUANTE', label: 'Mitigation manquante' },
  { value: 'DFD_INCOMPLET', label: 'DFD incomplet' },
  { value: 'DFD_INCOHERENT', label: 'DFD incoherent' },
  { value: 'DESCRIPTION_APPLICATIVE_INCOHERENTE', label: 'Description applicative incoherente' },
  { value: 'AUTRE', label: 'Autre' },
] as const;

function toMultiline(value: string[]): string {
  return value.join('\n');
}

function fromMultiline(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function ReportResultsEditor({
  reportId,
  currentStatus,
  report,
  validatedAt,
  onBack,
  onReportRegenerated,
}: Readonly<ReportResultsEditorProps>) {
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [isUploadingDfd, setIsUploadingDfd] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [payload, setPayload] = useState<ReportResultsPayload | null>(null);
  const [savedUpdatedAt, setSavedUpdatedAt] = useState<string | null>(null);
  const [initialSnapshot, setInitialSnapshot] = useState<string>('');
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [selectedReasonCodes, setSelectedReasonCodes] = useState<string[]>([]);
  const [freeComment, setFreeComment] = useState('');
  const [isStudioOpen, setIsStudioOpen] = useState(false);
  const latestManagerComment = report?.status_history.find((entry) => Boolean(entry.comment))?.comment?.trim() || '';
  const rejectionFeedback = report?.manager_feedback.filter((entry) => entry.decision_type === 'REJECTED') || [];

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      setErrorMessage('');
      setSuccessMessage('');

      try {
        const reportResults = await fetchReportResults(reportId);
        const nextPayload = {
          app_name: reportResults.app_name,
          developer_name: reportResults.developer_name,
          application_description: reportResults.application_description,
          selected_threats: reportResults.selected_threats,
          application_version: reportResults.application_version,
          dfd_json: reportResults.dfd_json,
          dfd_image_path: reportResults.dfd_image_path ?? null,
          dfd_reference: reportResults.dfd_reference ?? 'DFD-01',
        };
        setPayload(nextPayload);
        setSavedUpdatedAt(reportResults.updated_at ?? null);
        setInitialSnapshot(JSON.stringify(nextPayload));
      } catch (error) {
        setErrorMessage(
          error instanceof Error
            ? error.message
            : 'Erreur de chargement des resultats du rapport.'
        );
      } finally {
        setIsLoading(false);
      }
    };

    void load();
  }, [reportId]);

  const canSubmit = useMemo(() => {
    if (!payload) {
      return false;
    }

    return (
      payload.app_name.trim().length > 0 &&
      payload.developer_name.trim().length > 0 &&
      payload.application_description.trim().length > 0 &&
      payload.selected_threats.length > 0 &&
      payload.selected_threats.every((threat) => threat.name.trim().length > 0)
    );
  }, [payload]);

  const hasChanges = useMemo(() => {
    if (!payload) {
      return false;
    }
    return JSON.stringify(payload) !== initialSnapshot;
  }, [initialSnapshot, payload]);

  const canResubmitRejected = useMemo(() => {
    if (currentStatus !== 'REJECTED') {
      return false;
    }
    if (hasChanges) {
      return true;
    }
    if (!savedUpdatedAt || !validatedAt) {
      return false;
    }
    return new Date(savedUpdatedAt).getTime() > new Date(validatedAt).getTime();
  }, [currentStatus, hasChanges, savedUpdatedAt, validatedAt]);

  const buildModificationReasons = (): SecOpsModificationReason[] =>
    selectedReasonCodes.map((reasonCode) => ({
      reason_code: reasonCode,
      section_type: 'GLOBAL',
      comment: reasonCode === 'AUTRE' ? freeComment.trim() || undefined : undefined,
    }));

  const persistResults = async (reasons: SecOpsModificationReason[], comment: string) => {
    if (!payload) {
      return null;
    }

    const saved = await updateReportResults(reportId, {
      ...payload,
      modification_reasons: reasons,
      modification_comment: comment.trim() || null,
    });
    const nextPayload = {
      app_name: saved.app_name,
      developer_name: saved.developer_name,
      application_description: saved.application_description,
      selected_threats: saved.selected_threats,
      application_version: saved.application_version,
      dfd_json: saved.dfd_json,
      dfd_image_path: saved.dfd_image_path ?? null,
      dfd_reference: saved.dfd_reference ?? 'DFD-01',
    };
    setPayload(nextPayload);
    setSavedUpdatedAt(saved.updated_at ?? null);
    setInitialSnapshot(JSON.stringify(nextPayload));
    return saved;
  };

  const updateThreat = (index: number, nextThreat: EditableThreat) => {
    if (!payload) {
      return;
    }

    const nextThreats = payload.selected_threats.map((threat, currentIndex) =>
      currentIndex === index ? nextThreat : threat
    );

    setPayload({
      ...payload,
      selected_threats: nextThreats,
    });
  };

  const removeThreat = (index: number) => {
    if (!payload) {
      return;
    }

    setPayload({
      ...payload,
      selected_threats: payload.selected_threats.filter((_, currentIndex) => currentIndex !== index),
    });
  };

  const addThreat = () => {
    if (!payload) {
      return;
    }

    setPayload({
      ...payload,
      selected_threats: [
        ...payload.selected_threats,
        {
          name: '',
          description: '',
          attack_scenarios: [],
          mitigations: [],
        },
      ],
    });
  };

  const handleSave = async () => {
    if (!payload || !canSubmit) return;
    if (hasChanges) {
      setPendingAction('save');
      return;
    }
    setSuccessMessage('Aucune modification a enregistrer.');
    await showInfoAlert('Aucune modification', "Il n'y a rien à enregistrer.");
  };

  const handleDfdUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    if (!payload) {
      return;
    }

    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setIsUploadingDfd(true);
    setErrorMessage('');
    setSuccessMessage('');

    try {
      const uploaded = await uploadReportDfd(reportId, file);
      setPayload({
        ...payload,
        dfd_image_path: uploaded.dfd_image_path,
      });
      setSuccessMessage(`Diagramme DFD charge: ${uploaded.original_file_name}`);
      await showSuccessAlert('Diagramme chargé', uploaded.original_file_name);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erreur d'upload du diagramme.";
      setErrorMessage(message);
      await showErrorAlert('Upload impossible', message);
    } finally {
      setIsUploadingDfd(false);
      event.target.value = '';
    }
  };

  const handleRegenerate = async () => {
    if (!payload || !canSubmit) return;
    if (hasChanges) {
      setPendingAction('regenerate');
      return;
    }

    setIsRegenerating(true);
    setErrorMessage('');
    setSuccessMessage('');
    try {
      const report = await regenerateReport(reportId);
      onReportRegenerated(report.id, toAbsoluteReportUrl(report.report_url));
      await showSuccessAlert('Rapport régénéré', 'Le rapport a été régénéré avec succès.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erreur de regeneration.';
      setErrorMessage(message);
      await showErrorAlert('Régénération impossible', message);
    } finally {
      setIsRegenerating(false);
    }
  };

  const handleSubmitToManager = async () => {
    if (!payload || !canSubmit) return;
    if (currentStatus === 'REJECTED' && !canResubmitRejected) {
      setErrorMessage('Corrigez le rapport puis enregistrez-le avant de le resoumettre.');
      return;
    }
    if (hasChanges) {
      setPendingAction('submit');
      return;
    }

    setIsRegenerating(true);
    setErrorMessage('');
    setSuccessMessage('');
    try {
      const report = await regenerateReport(reportId);
      const submitted = await updateReportStatus(
        reportId,
        'PENDING',
        currentStatus === 'REJECTED'
          ? 'Rapport corrige et resoumis au manager.'
          : 'Rapport relu et soumis au manager.'
      );
      onReportRegenerated(submitted.id, toAbsoluteReportUrl(report.report_url));
      await showSuccessAlert(
        currentStatus === 'REJECTED' ? 'Rapport resoumis' : 'Rapport soumis',
        'L’opération a été effectuée avec succès.'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erreur de soumission manager.';
      setErrorMessage(message);
      await showErrorAlert('Soumission impossible', message);
    } finally {
      setIsRegenerating(false);
    }
  };

  const confirmPendingAction = async () => {
    if (!pendingAction || !payload) {
      return;
    }
    if (selectedReasonCodes.length === 0) {
      setErrorMessage('Selectionnez au moins un motif de modification.');
      return;
    }
    if (selectedReasonCodes.includes('AUTRE') && freeComment.trim() === '') {
      setErrorMessage("Precisez le motif libre pour l'option Autre.");
      return;
    }

    const reasons = buildModificationReasons();
    setErrorMessage('');
    setSuccessMessage('');

    try {
      if (pendingAction === 'save') {
        setIsSaving(true);
        await persistResults(reasons, freeComment);
        setSuccessMessage('Les resultats ont ete enregistres.');
        await showSuccessAlert('Résultats enregistrés', 'Les modifications ont été sauvegardées.');
      } else if (pendingAction === 'regenerate') {
        setIsRegenerating(true);
        await persistResults(reasons, freeComment);
        const report = await regenerateReport(reportId);
        onReportRegenerated(report.id, toAbsoluteReportUrl(report.report_url));
        await showSuccessAlert('Rapport régénéré', 'Le rapport a été régénéré avec succès.');
      } else {
        setIsRegenerating(true);
        await persistResults(reasons, freeComment);
        const report = await regenerateReport(reportId);
        const submitted = await updateReportStatus(
          reportId,
          'PENDING',
          currentStatus === 'REJECTED'
            ? 'Rapport corrige et resoumis au manager.'
            : 'Rapport relu et soumis au manager.'
        );
        onReportRegenerated(submitted.id, toAbsoluteReportUrl(report.report_url));
        await showSuccessAlert(
          currentStatus === 'REJECTED' ? 'Rapport resoumis' : 'Rapport soumis',
          'L’opération a été effectuée avec succès.'
        );
      }
      setPendingAction(null);
      setSelectedReasonCodes([]);
      setFreeComment('');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Erreur lors de l'enregistrement des motifs.";
      setErrorMessage(message);
      await showErrorAlert('Opération impossible', message);
    } finally {
      setIsSaving(false);
      setIsRegenerating(false);
    }
  };

  if (isLoading) {
    return (
      <div className="max-w-[1100px] mx-auto px-6 pt-36 pb-12">
        <div className="rounded-2xl border border-border-subtle bg-white p-8 text-text-secondary">
          Chargement des resultats du rapport...
        </div>
      </div>
    );
  }

  if (!payload) {
    return (
      <div className="max-w-[1100px] mx-auto px-6 pt-36 pb-12">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-2 text-accent-primary hover:text-accent-primary/80 font-medium mb-5 transition"
        >
          <ArrowLeft className="w-4 h-4" />
          Retour
        </button>
        <div className="rounded-2xl border border-accent-danger/30 bg-white p-8 text-accent-danger">
          {errorMessage || 'Resultats introuvables pour ce rapport.'}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-[1100px] mx-auto px-6 pt-36 pb-12">
      <button
        onClick={onBack}
        className="inline-flex items-center gap-2 text-accent-primary hover:text-accent-primary/80 font-medium mb-5 transition"
      >
        <ArrowLeft className="w-4 h-4" />
        Retour au rapport
      </button>

      <div className="rounded-2xl border border-border-subtle bg-white p-6 md:p-8 mb-6">
        <h1 className="font-sans text-2xl font-bold text-text-primary mb-2">
          Modifier les resultats du rapport
        </h1>
        <p className="text-sm text-text-secondary">
          Corrigez les menaces, scenarios et mitigations, puis soumettez explicitement le rapport au manager quand il est pret.
        </p>
        <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
          Version actuelle: {payload.application_version ?? 'v1'}
        </p>
      </div>

      {currentStatus === 'REJECTED' && report && (
        <div className="rounded-2xl border border-red-200 bg-[linear-gradient(135deg,#fff5f5,#fffdfd)] p-6 md:p-8 mb-6">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-red-600">
            Retour manager
          </p>
          {latestManagerComment && (
            <div className="mt-4 rounded-xl border border-red-100 bg-white px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Dernier commentaire
              </p>
              <p className="mt-1 text-sm leading-6 text-slate-700">
                {latestManagerComment}
              </p>
            </div>
          )}
          {rejectionFeedback.length > 0 && (
            <div className="mt-4 rounded-xl border border-red-100 bg-white px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Motifs de rejet
              </p>
              <ul className="mt-2 space-y-2">
                {rejectionFeedback.map((entry) => (
                  <li key={entry.id} className="text-sm text-slate-700">
                    <span className="font-semibold">{entry.reason_code}</span>
                    {entry.comment && entry.comment.trim() !== latestManagerComment
                      ? ` - ${entry.comment}`
                      : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="rounded-2xl border border-border-subtle bg-white p-6 md:p-8 space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="space-y-1">
            <span className="text-xs font-semibold text-text-secondary">Application</span>
            <input
              value={payload.app_name}
              onChange={(event) =>
                setPayload({
                  ...payload,
                  app_name: event.target.value,
                })
              }
              className="w-full rounded-lg border border-border-subtle px-3 py-2 text-sm"
            />
          </label>

          <label className="space-y-1">
            <span className="text-xs font-semibold text-text-secondary">Analyste</span>
            <input
              value={payload.developer_name}
              onChange={(event) =>
                setPayload({
                  ...payload,
                  developer_name: event.target.value,
                })
              }
              className="w-full rounded-lg border border-border-subtle px-3 py-2 text-sm"
            />
          </label>
        </div>

        <label className="space-y-1 block">
          <span className="text-xs font-semibold text-text-secondary">Description applicative</span>
          <textarea
            value={payload.application_description}
            onChange={(event) =>
              setPayload({
                ...payload,
                application_description: event.target.value,
              })
            }
            rows={5}
            className="w-full rounded-lg border border-border-subtle px-3 py-2 text-sm"
          />
        </label>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1 block">
            <span className="text-xs font-semibold text-text-secondary">Image DFD</span>
            <div className="flex flex-col gap-3 rounded-lg border border-border-subtle p-3">
              <div className="flex flex-wrap gap-3">
                <label className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-lg border border-border-subtle px-3 py-2 text-sm text-text-primary hover:border-accent-primary transition">
                  <ImageUp className="w-4 h-4" />
                  {isUploadingDfd ? 'Upload en cours...' : 'Uploader une image'}
                  <input
                    type="file"
                    accept=".png,.jpg,.jpeg,.webp"
                    onChange={(event) => void handleDfdUpload(event)}
                    disabled={isUploadingDfd}
                    className="hidden"
                  />
                </label>

                <button
                  type="button"
                  onClick={() => setIsStudioOpen(true)}
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
                >
                  Ouvrir Studio DFD
                </button>
              </div>

              <input
                value={payload.dfd_image_path ?? ''}
                readOnly
                placeholder="Aucune image chargee"
                className="w-full rounded-lg border border-border-subtle bg-slate-50 px-3 py-2 text-sm"
              />
            </div>
          </div>

          <label className="space-y-1 block">
            <span className="text-xs font-semibold text-text-secondary">Reference DFD</span>
            <input
              value={payload.dfd_reference ?? 'DFD-01'}
              onChange={(event) =>
                setPayload({
                  ...payload,
                  dfd_reference: event.target.value,
                })
              }
              placeholder="DFD-02"
              className="w-full rounded-lg border border-border-subtle px-3 py-2 text-sm"
            />
          </label>
        </div>

      </div>

      <div className="space-y-4 mt-6">
        {payload.selected_threats.map((threat, index) => (
          <article key={`${threat.name}-${index}`} className="rounded-2xl border border-border-subtle bg-white p-6">
            <div className="flex items-center justify-between gap-3 mb-4">
              <h2 className="font-semibold text-text-primary">Menace {index + 1}</h2>
              <button
                onClick={() => removeThreat(index)}
                className="inline-flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg border border-accent-danger/40 text-accent-danger hover:bg-accent-danger/10 transition"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Supprimer
              </button>
            </div>

            <div className="space-y-3">
              <label className="space-y-1 block">
                <span className="text-xs font-semibold text-text-secondary">Nom menace</span>
                <input
                  value={threat.name}
                  onChange={(event) =>
                    updateThreat(index, {
                      ...threat,
                      name: event.target.value,
                    })
                  }
                  className="w-full rounded-lg border border-border-subtle px-3 py-2 text-sm"
                />
              </label>

              <label className="space-y-1 block">
                <span className="text-xs font-semibold text-text-secondary">Description</span>
                <textarea
                  rows={3}
                  value={threat.description ?? ''}
                  onChange={(event) =>
                    updateThreat(index, {
                      ...threat,
                      description: event.target.value,
                    })
                  }
                  className="w-full rounded-lg border border-border-subtle px-3 py-2 text-sm"
                />
              </label>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="space-y-1 block">
                  <span className="text-xs font-semibold text-text-secondary">
                    Scenarios d'attaque (une ligne = un scenario)
                  </span>
                  <textarea
                    rows={5}
                    value={toMultiline(threat.attack_scenarios)}
                    onChange={(event) =>
                      updateThreat(index, {
                        ...threat,
                        attack_scenarios: fromMultiline(event.target.value),
                      })
                    }
                    className="w-full rounded-lg border border-border-subtle px-3 py-2 text-sm"
                  />
                </label>

                <label className="space-y-1 block">
                  <span className="text-xs font-semibold text-text-secondary">
                    Mitigations (une ligne = une mitigation)
                  </span>
                  <textarea
                    rows={5}
                    value={toMultiline(threat.mitigations)}
                    onChange={(event) =>
                      updateThreat(index, {
                        ...threat,
                        mitigations: fromMultiline(event.target.value),
                      })
                    }
                    className="w-full rounded-lg border border-border-subtle px-3 py-2 text-sm"
                  />
                </label>
              </div>
            </div>
          </article>
        ))}
      </div>

      <div className="mt-5">
        <button
          onClick={addThreat}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border-subtle text-text-primary hover:border-accent-primary transition"
        >
          <FilePlus2 className="w-4 h-4" />
          Ajouter une menace
        </button>
      </div>

      {errorMessage && (
        <div className="mt-5 rounded-xl border border-accent-danger/30 bg-accent-danger/10 px-4 py-3 text-sm text-accent-danger">
          {errorMessage}
        </div>
      )}

      {successMessage && (
        <div className="mt-5 rounded-xl border border-success/30 bg-success/10 px-4 py-3 text-sm text-success">
          {successMessage}
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          onClick={handleSave}
          disabled={!canSubmit || isSaving || isRegenerating}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl border border-border-subtle text-text-primary disabled:opacity-50"
        >
          <Save className="w-4 h-4" />
          {isSaving ? 'Enregistrement...' : 'Enregistrer les modifications'}
        </button>

        <button
          onClick={handleRegenerate}
          disabled={!canSubmit || isSaving || isRegenerating}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-accent-primary text-white hover:brightness-105 transition disabled:opacity-50"
        >
          <RefreshCcw className="w-4 h-4" />
          {isRegenerating ? 'Regeneration...' : 'Regenerer le rapport'}
        </button>

        <button
          onClick={handleSubmitToManager}
          disabled={
            !canSubmit ||
            isSaving ||
            isRegenerating ||
            !['DRAFT', 'REJECTED'].includes(currentStatus) ||
            (currentStatus === 'REJECTED' && !canResubmitRejected)
          }
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-slate-900 text-white transition hover:bg-slate-700 disabled:opacity-50"
        >
          <RefreshCcw className="w-4 h-4" />
          {currentStatus === 'REJECTED' ? 'Resoumettre au manager' : 'Soumettre au manager'}
        </button>
      </div>

      {pendingAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            className="absolute inset-0 bg-black/50"
            onClick={() => {
              setPendingAction(null);
              setSelectedReasonCodes([]);
              setFreeComment('');
              setErrorMessage('');
            }}
            aria-label="Fermer"
          />
          <div className="relative w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
            <h2 className="text-lg font-bold text-slate-900">Motifs de modification SecOps</h2>
            <p className="mt-1 text-sm text-slate-500">
              Ces motifs seront traces dans l'audit trail et reutilises pour le feedback LLM.
            </p>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {SECOPS_REASON_OPTIONS.map((option) => {
                const checked = selectedReasonCodes.includes(option.value);
                return (
                  <label
                    key={option.value}
                    className={`flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 text-sm transition ${
                      checked
                        ? 'border-accent-primary bg-accent-soft text-accent-primary'
                        : 'border-slate-200 bg-white text-slate-700'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => {
                        setSelectedReasonCodes((current) =>
                          event.target.checked
                            ? [...current, option.value]
                            : current.filter((item) => item !== option.value)
                        );
                      }}
                      className="mt-1"
                    />
                    <span>{option.label}</span>
                  </label>
                );
              })}
            </div>

            <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Commentaire libre
            </label>
            <textarea
              rows={4}
              value={freeComment}
              onChange={(event) => setFreeComment(event.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-accent-primary focus:outline-none"
              placeholder="Precisez le contexte de la correction effectuee..."
            />

            <div className="mt-5 flex gap-3">
              <button
                onClick={() => {
                  setPendingAction(null);
                  setSelectedReasonCodes([]);
                  setFreeComment('');
                }}
                className="flex-1 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-600 transition hover:bg-slate-50"
              >
                Annuler
              </button>
              <button
                onClick={() => void confirmPendingAction()}
                className="flex-1 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700"
              >
                Confirmer
              </button>
            </div>
          </div>
        </div>
      )}

      {isStudioOpen && (
        <div className="fixed inset-0 z-[70] bg-[linear-gradient(180deg,#fffdf8_0%,#fff8ed_100%)]">
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-between border-b border-amber-200/70 bg-white/70 px-6 py-4 backdrop-blur-xl">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700">
                  Studio DFD
                </p>
                <h2 className="mt-1 text-xl font-bold text-slate-900">
                  Edition plein ecran du diagramme
                </h2>
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setIsStudioOpen(false)}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                >
                  Fermer
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden p-4">
              <div className="h-full rounded-2xl border border-amber-200/70 bg-white/85 p-3 shadow-[0_18px_45px_rgba(217,119,6,0.08)] backdrop-blur-sm">
                <DfdStudio
                  title="Studio DFD modifiable"
                  value={payload.dfd_json}
                  fullscreen
                  onChange={(nextDfd) =>
                    setPayload({
                      ...payload,
                      dfd_json: nextDfd,
                      dfd_image_path: null,
                    })
                  }
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
