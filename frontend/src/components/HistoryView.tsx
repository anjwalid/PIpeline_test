import { CalendarClock, FileSearch, RefreshCcw, Trash2 } from 'lucide-react';
import type { ReportRecord, ReportStatus } from '../types';

interface HistoryViewProps {
  history: ReportRecord[];
  onOpenReport: (reportId: string, url: string) => void;
  onEditReport?: (reportId: string) => void;
  onDeleteReport?: (reportId: string) => void;
  onNewAnalysis?: () => void;
  showNewAnalysisButton?: boolean;
  title?: string;
  subtitle?: string;
}

const STATUS_LABELS: Record<ReportStatus, string> = {
  DRAFT: 'Brouillon',
  PENDING: 'En attente manager',
  APPROVED: 'Approuve',
  REJECTED: 'Rejete',
};

function getStatusLabel(status: ReportStatus): string {
  return STATUS_LABELS[status] || 'Statut inconnu';
}

export function HistoryView({
  history,
  onOpenReport,
  onEditReport,
  onDeleteReport,
  onNewAnalysis,
  showNewAnalysisButton = true,
  title = 'Versions precedentes',
  subtitle = 'Consultez les anciennes analyses et reutilisez leurs rapports.',
}: Readonly<HistoryViewProps>) {
  return (
    <div
      className="max-w-[980px] mx-auto px-6 pt-36 pb-12"
      data-guide-target="history"
    >
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-8">
        <div>
          <h1 className="font-sans font-extrabold text-[30px] text-text-primary">{title}</h1>
          <p className="text-text-secondary text-sm mt-1">
            {subtitle}
          </p>
        </div>

        {showNewAnalysisButton && onNewAnalysis && (
          <button
            onClick={onNewAnalysis}
            className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-accent-primary text-white font-semibold hover:brightness-105 transition"
          >
            <RefreshCcw className="w-4 h-4" />
            Nouvelle analyse
          </button>
        )}
      </div>

      {history.length === 0 ? (
        <div className="rounded-2xl border border-border-subtle bg-white p-8 text-center">
          <FileSearch className="w-10 h-10 mx-auto text-text-muted mb-3" />
          <h2 className="font-sans font-bold text-xl text-text-primary mb-2">Aucune version enregistree</h2>
          <p className="text-sm text-text-secondary">
            Lancez votre premiere analyse pour alimenter cet historique.
          </p>
        </div>
      ) : (
        <div className="grid gap-4" data-guide-target="history-list">
          {history.map((item) => (
            <article
              key={item.id}
              className="rounded-2xl border border-border-subtle bg-white p-5 hover:shadow-[0_12px_40px_rgba(217,119,6,0.16)] transition"
            >
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-sans font-bold text-lg text-text-primary">{item.app_name}</h3>
                    <span className="rounded-full bg-bg-panel px-3 py-1 text-[11px] font-semibold text-text-secondary">
                      {getStatusLabel(item.status)}
                    </span>
                  </div>
                  <p className="text-sm text-text-secondary mt-1">{item.summary}</p>
                  <p className="text-xs text-text-muted mt-2">
                    Analyste: {item.generated_by_username || 'Non renseigne'}
                  </p>
                  {item.validated_by_username && (
                    <p className="text-xs text-text-muted mt-1">
                      Manager: {item.validated_by_username}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-3">
                  <span className="inline-flex items-center gap-2 rounded-full border border-border-subtle bg-bg-panel px-3 py-1.5 text-xs text-text-secondary">
                    <CalendarClock className="w-3.5 h-3.5" />
                    {new Date(item.generated_at).toLocaleString('fr-FR')}
                  </span>
                  {onEditReport && (item.status === 'DRAFT' || item.status === 'REJECTED') && (
                    <button
                      onClick={() => onEditReport(item.id)}
                      className="px-4 py-2 rounded-lg border border-border-subtle text-text-primary hover:border-accent-primary transition"
                    >
                      Modifier
                    </button>
                  )}
                  {onDeleteReport && item.status === 'DRAFT' && (
                    <button
                      onClick={() => onDeleteReport(item.id)}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition"
                    >
                      <Trash2 className="w-4 h-4" />
                      Supprimer
                    </button>
                  )}
                  <button
                    onClick={() => onOpenReport(item.id, item.report_url)}
                    className="px-4 py-2 rounded-lg border border-accent-primary text-accent-primary hover:bg-accent-soft transition"
                  >
                    Ouvrir rapport
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
