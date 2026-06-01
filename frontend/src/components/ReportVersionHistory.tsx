import { ChevronDown, Eye } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ReportResultVersionRecord } from '../types';

interface ReportVersionHistoryProps {
  versions: ReportResultVersionRecord[];
  currentVersionNumber?: number | null;
  selectedVersionNumber?: number | null;
  onSelectVersion?: (version: ReportResultVersionRecord) => void;
  title?: string;
  subtitle?: string;
}

function buildVersionMetrics(version: ReportResultVersionRecord) {
  const threatCount = version.selected_threats.length;
  const scenarioCount = version.selected_threats.reduce(
    (sum, threat) => sum + threat.attack_scenarios.length,
    0
  );
  const mitigationCount = version.selected_threats.reduce(
    (sum, threat) => sum + threat.mitigations.length,
    0
  );

  return { threatCount, scenarioCount, mitigationCount };
}

export function ReportVersionHistory({
  versions,
  currentVersionNumber,
  selectedVersionNumber,
  onSelectVersion,
  title = 'Historique des versions',
  subtitle = 'Conservez la visibilité sur les versions successives du même projet.',
}: Readonly<ReportVersionHistoryProps>) {
  const defaultVersionNumber = useMemo(
    () => selectedVersionNumber ?? currentVersionNumber ?? versions[0]?.version_number ?? null,
    [currentVersionNumber, selectedVersionNumber, versions]
  );
  const [openVersionNumber, setOpenVersionNumber] = useState<number | null>(defaultVersionNumber);

  if (versions.length === 0) {
    return null;
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4">
        <h2 className="text-lg font-bold text-slate-900">{title}</h2>
        <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
      </div>

      <div className="space-y-3">
        {versions.map((version) => {
          const metrics = buildVersionMetrics(version);
          const isCurrent = currentVersionNumber === version.version_number;
          const isOpen = openVersionNumber === version.version_number;
          const isSelected = selectedVersionNumber === version.version_number;

          return (
            <div
              key={`${version.version_label}-${version.created_at}`}
              className={`overflow-hidden rounded-2xl border ${
                isSelected
                  ? 'border-slate-900 bg-white shadow-sm'
                  : isCurrent
                  ? 'border-orange-200 bg-[linear-gradient(135deg,#fff8f1,#fffdfb)]'
                  : 'border-slate-200 bg-slate-50'
              }`}
            >
              <button
                type="button"
                onClick={() => {
                  setOpenVersionNumber((current) =>
                    current === version.version_number ? null : version.version_number
                  );
                  onSelectVersion?.(version);
                }}
                className="flex w-full items-start justify-between gap-3 px-4 py-4 text-left transition hover:bg-white/40"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-slate-900 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-white">
                      {version.version_label}
                    </span>
                    {isCurrent && (
                      <span className="rounded-full bg-orange-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-orange-700">
                        Version courante
                      </span>
                    )}
                    {isSelected && (
                      <span className="rounded-full bg-slate-900 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-white">
                        Version affichee
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1 rounded-full bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                      <Eye className="h-3.5 w-3.5" />
                      Cliquer pour ouvrir
                    </span>
                  </div>

                  <p className="mt-3 text-sm font-semibold text-slate-900">{version.app_name}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {new Date(version.created_at).toLocaleString('fr-FR')}
                    {version.created_by_username ? ` · ${version.created_by_username}` : ''}
                  </p>
                  <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-slate-600">
                    {version.change_reason?.trim() || 'Aucun commentaire de version renseigné.'}
                  </p>
                </div>

                <div
                  className={`mt-1 rounded-full border border-slate-200 bg-white p-2 text-slate-500 transition ${
                    isOpen ? 'rotate-180' : ''
                  }`}
                >
                  <ChevronDown className="h-4 w-4" />
                </div>
              </button>

              {isOpen && (
                <div className="border-t border-slate-200/80 bg-white/80 px-4 py-4">
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-600">
                    <p>
                      {metrics.threatCount} menace(s) · {metrics.scenarioCount} scenario(s) · {metrics.mitigationCount} mitigation(s)
                    </p>
                    <p className="mt-1">Les details complets s'affichent dans le panneau de version.</p>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
