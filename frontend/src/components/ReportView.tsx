import { useEffect, useState } from 'react';

import { fetchReportBlobUrl, fetchReportResults } from '../api/reports';
import type { CatalogReference, ReportResultsRecord } from '../types';

interface ReportViewProps {
  reportId?: string;
  reportUrl: string;
  onNewAnalysis: () => void;
  onEditResults?: () => void;
  canEditResults?: boolean;
  managerName?: string | null;
  statusLabel?: string | null;
}

export function ReportView({
  reportId,
  reportUrl,
  onNewAnalysis,
  onEditResults,
  canEditResults = true,
  managerName,
  statusLabel,
}: Readonly<ReportViewProps>) {
  const [blobUrl, setBlobUrl] = useState('');
  const [loadingError, setLoadingError] = useState('');
  const [reportResults, setReportResults] = useState<ReportResultsRecord | null>(null);

  useEffect(() => {
    let currentBlobUrl = '';
    let cancelled = false;

    const loadReport = async () => {
      try {
        setLoadingError('');
        setBlobUrl('');

        const nextBlobUrl = await fetchReportBlobUrl(reportUrl);
        currentBlobUrl = nextBlobUrl;

        if (!cancelled) {
          setBlobUrl(nextBlobUrl);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadingError(
            error instanceof Error ? error.message : 'Erreur chargement rapport.'
          );
        }
      }
    };

    if (reportUrl) {
      void loadReport();
    }

    return () => {
      cancelled = true;
      if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl);
      }
    };
  }, [reportUrl]);

  useEffect(() => {
    let cancelled = false;

    const loadReportResults = async () => {
      if (!reportId) {
        setReportResults(null);
        return;
      }

      try {
        const nextResults = await fetchReportResults(reportId);
        if (!cancelled) {
          setReportResults(nextResults);
        }
      } catch {
        if (!cancelled) {
          setReportResults(null);
        }
      }
    };

    void loadReportResults();

    return () => {
      cancelled = true;
    };
  }, [reportId]);

  const cveReferences = collectCveReferences(reportResults);
  const cveSummary = buildCveSummary(reportResults, cveReferences.length);

  return (
    <div className="max-w-[1200px] mx-auto px-6 pt-40 pb-12">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-mono text-[30px] text-text-primary">
            Rapport final
          </h1>
          {managerName && (
            <p className="text-sm text-text-secondary mt-1">Validé par: {managerName}</p>
          )}
          {statusLabel && (
            <p className="text-sm text-text-secondary mt-1">Statut: {statusLabel}</p>
          )}
        </div>

        <div className="flex gap-3">
          {onEditResults && canEditResults && (
            <button
              onClick={onEditResults}
              className="px-5 py-3 border border-border-subtle bg-white text-text-primary rounded-lg font-mono hover:bg-bg-card-hover transition"
            >
              Modifier resultats
            </button>
          )}
          <button
            onClick={() => {
              if (!blobUrl) return;
              const link = document.createElement('a');
              link.href = blobUrl;
              link.download = 'rapport.pdf';
              link.click();
            }}
            className="px-5 py-3 bg-accent-primary text-white rounded-lg font-mono hover:brightness-105 transition"
          >
            Télécharger
          </button>

          <button
            onClick={onNewAnalysis}
            className="px-5 py-3 border border-border-subtle bg-white text-text-primary rounded-lg font-mono hover:bg-bg-card-hover transition"
          >
            Nouvelle analyse
          </button>
        </div>
      </div>

      {reportResults && (
        <div className="mb-6 rounded-2xl border border-orange-100 bg-[linear-gradient(135deg,#fff8f1,#fffdfb)] p-5 shadow-[0_12px_30px_rgba(249,115,22,0.08)]">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-orange-600">
                Exposition CVE
              </p>
              <p className="mt-2 text-sm leading-7 text-slate-600">
                {cveSummary}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <div className="rounded-2xl bg-white px-4 py-3 text-center shadow-sm">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Menaces
                </p>
                <p className="mt-1 text-2xl font-bold text-slate-900">
                  {reportResults.selected_threats.length}
                </p>
              </div>
              <div className="rounded-2xl bg-white px-4 py-3 text-center shadow-sm">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  CVE
                </p>
                <p className="mt-1 text-2xl font-bold text-slate-900">
                  {cveReferences.length}
                </p>
              </div>
            </div>
          </div>

          {cveReferences.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {cveReferences.slice(0, 8).map((reference) => (
                <span
                  key={`${reference.reference_menace}-${reference.nom_reference}`}
                  className="rounded-full border border-orange-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700"
                >
                  {reference.reference_menace}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="bg-white rounded-2xl overflow-hidden border border-border-subtle h-[80vh] shadow-[0_18px_50px_rgba(217,119,6,0.14)]">
        {blobUrl ? (
          <iframe title="Rapport analyse" src={blobUrl} className="w-full h-full" />
        ) : (
          <div className="p-8 text-text-secondary">
            {loadingError || 'Chargement du rapport...'}
          </div>
        )}
      </div>
    </div>
  );
}

function collectCveReferences(reportResults: ReportResultsRecord | null): CatalogReference[] {
  if (!reportResults) return [];

  const seen = new Set<string>();
  const references: CatalogReference[] = [];

  for (const threat of reportResults.selected_threats) {
    for (const reference of threat.references || []) {
      const code = String(reference.reference_menace || '').trim().toUpperCase();
      if (!code.startsWith('CVE-')) continue;

      const dedupeKey = `${code}|${reference.nom_reference}|${reference.lien || ''}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      references.push({
        ...reference,
        reference_menace: code,
      });
    }
  }

  return references;
}

function buildCveSummary(
  reportResults: ReportResultsRecord | null,
  cveReferenceCount: number
): string {
  if (!reportResults) {
    return "Le contexte d'exposition n'est pas disponible pour ce rapport.";
  }

  if (cveReferenceCount === 0) {
    return "Aucune reference CVE explicite n'a ete rattachee aux menaces de cette version. Le rapport reste fonde sur les menaces et scenarios retenus.";
  }

  const scenariosCount = reportResults.selected_threats.reduce(
    (total, threat) => total + threat.attack_scenarios.length,
    0
  );

  return `${cveReferenceCount} reference(s) CVE distincte(s) ont ete rattachees a ${reportResults.selected_threats.length} menace(s) et ${scenariosCount} scenario(s). Elles servent d'ancrage technique pour qualifier l'exposition des composants analyses.`;
}
