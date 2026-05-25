import { ChevronDown, Network, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import type { CveGraphEdge, CveGraphMatch, CveGraphNode, CveGraphSearchResponse, CveGraphStats } from '../types';

interface CveGraphExplorerProps {
  graph: CveGraphSearchResponse | null;
  stats: CveGraphStats | null;
  isLoading: boolean;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearch: () => void;
}

const COLUMN_ORDER = ['Vendor', 'Product', 'ProductVersion', 'CVE', 'AttackVector'] as const;
const NODE_WIDTH = 220;
const NODE_HEIGHT = 66;
const COLUMN_SPACING = 280;
const ROW_SPACING = 92;
const GRAPH_PADDING_X = 180;
const GRAPH_PADDING_Y = 110;

function buildNodePositions(nodes: CveGraphNode[]) {
  const grouped = new Map<string, CveGraphNode[]>();

  for (const nodeType of COLUMN_ORDER) {
    grouped.set(nodeType, []);
  }

  for (const node of nodes) {
    const bucket = grouped.get(node.node_type) ?? [];
    bucket.push(node);
    grouped.set(node.node_type, bucket);
  }

  const widestColumn = Math.max(...COLUMN_ORDER.map((nodeType) => (grouped.get(nodeType) ?? []).length), 1);
  const width = GRAPH_PADDING_X * 2 + (COLUMN_ORDER.length - 1) * COLUMN_SPACING + NODE_WIDTH;
  const height = Math.max(560, GRAPH_PADDING_Y * 2 + (widestColumn - 1) * ROW_SPACING + NODE_HEIGHT);
  const positions = new Map<string, { x: number; y: number }>();

  COLUMN_ORDER.forEach((nodeType, columnIndex) => {
    const columnNodes = grouped.get(nodeType) ?? [];
    const x = GRAPH_PADDING_X + NODE_WIDTH / 2 + columnIndex * COLUMN_SPACING;
    const columnHeight = Math.max((columnNodes.length - 1) * ROW_SPACING, 0);
    const startY = Math.max(GRAPH_PADDING_Y + NODE_HEIGHT / 2, (height - columnHeight) / 2);
    columnNodes.forEach((node, rowIndex) => {
      positions.set(node.id, { x, y: startY + rowIndex * ROW_SPACING });
    });
  });

  return { positions, width, height };
}

function nodeTone(nodeType: string) {
  if (nodeType === 'CVE') return 'fill-[#ffedd5] stroke-[#f97316]';
  if (nodeType === 'AttackVector') return 'fill-[#ecfeff] stroke-[#0891b2]';
  if (nodeType === 'ProductVersion') return 'fill-[#eff6ff] stroke-[#2563eb]';
  if (nodeType === 'Product') return 'fill-[#f8fafc] stroke-[#475569]';
  return 'fill-[#f1f5f9] stroke-[#334155]';
}

function renderEdge(edge: CveGraphEdge, positions: Map<string, { x: number; y: number }>) {
  const source = positions.get(edge.source);
  const target = positions.get(edge.target);
  if (!source || !target) return null;

  return (
    <g key={`${edge.source}-${edge.target}-${edge.label}`}>
      <line
        x1={source.x + NODE_WIDTH / 2}
        y1={source.y}
        x2={target.x - NODE_WIDTH / 2}
        y2={target.y}
        stroke="#cbd5e1"
        strokeWidth="2.4"
      />
      <text
        x={(source.x + target.x) / 2}
        y={(source.y + target.y) / 2 - 8}
        textAnchor="middle"
        className="fill-slate-400 text-[10px] font-semibold"
      >
        {edge.label}
      </text>
    </g>
  );
}

function renderNode(node: CveGraphNode, positions: Map<string, { x: number; y: number }>) {
  const position = positions.get(node.id);
  if (!position) return null;

  return (
    <g key={node.id} transform={`translate(${position.x}, ${position.y})`}>
      <rect
        x={-NODE_WIDTH / 2}
        y={-NODE_HEIGHT / 2}
        width={NODE_WIDTH}
        height={NODE_HEIGHT}
        rx={20}
        className={`${nodeTone(node.node_type)} stroke-[1.6]`}
      />
      <text
        x="0"
        y="-6"
        textAnchor="middle"
        className="fill-slate-900 text-[13px] font-bold"
      >
        {node.label.length > 28 ? `${node.label.slice(0, 28)}...` : node.label}
      </text>
      <text
        x="0"
        y="16"
        textAnchor="middle"
        className="fill-slate-500 text-[11px] font-medium uppercase"
      >
        {node.node_type}
      </text>
    </g>
  );
}

function cveBadge(match: CveGraphMatch) {
  if (match.base_score == null) return 'bg-slate-100 text-slate-700';
  if (match.base_score >= 9) return 'bg-red-100 text-red-700';
  if (match.base_score >= 7) return 'bg-orange-100 text-orange-700';
  return 'bg-amber-100 text-amber-700';
}

function formatPublishedDate(value?: string | null) {
  if (!value) return 'Date inconnue';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
}

export function CveGraphExplorer({
  graph,
  stats,
  isLoading,
  searchQuery,
  onSearchQueryChange,
  onSearch,
}: Readonly<CveGraphExplorerProps>) {
  const [isMetricsExpanded, setIsMetricsExpanded] = useState(true);
  const [isSearchExpanded, setIsSearchExpanded] = useState(true);
  const [isGraphExpanded, setIsGraphExpanded] = useState(true);
  const [isRecentExpanded, setIsRecentExpanded] = useState(true);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [recentLimit, setRecentLimit] = useState(10);
  const [listSort, setListSort] = useState<'recent' | 'critical' | 'score' | 'network'>('recent');
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];
  const { positions, width, height } = buildNodePositions(nodes);
  const rawDisabledReason =
    graph?.disabled_reason ??
    stats?.disabled_reason ??
    "Le module CVE n'est pas activé dans le backend.";
  const disabledReason = rawDisabledReason
    .replace(/Neo4j/gi, 'base CVE')
    .replace(/Knowledge Graph/gi, 'Base de connaissances');
  const recentMatches = stats?.latest_cves ?? [];
  const displayedMatches = graph?.query?.trim() ? graph?.matches ?? [] : recentMatches;
  const sortedMatches = useMemo(() => {
    const copy = [...displayedMatches];
    if (listSort === 'network') {
      copy.sort((left, right) => {
        const leftNetwork = left.attack_vectors.some((vector) => vector.toUpperCase() === 'NETWORK') ? 1 : 0;
        const rightNetwork = right.attack_vectors.some((vector) => vector.toUpperCase() === 'NETWORK') ? 1 : 0;
        if (rightNetwork !== leftNetwork) return rightNetwork - leftNetwork;
        return (right.base_score ?? -1) - (left.base_score ?? -1);
      });
      return copy;
    }
    if (listSort === 'critical' || listSort === 'score') {
      copy.sort((left, right) => (right.base_score ?? -1) - (left.base_score ?? -1));
      return copy;
    }
    copy.sort((left, right) => {
      const leftTime = left.published ? new Date(left.published).getTime() : 0;
      const rightTime = right.published ? new Date(right.published).getTime() : 0;
      return rightTime - leftTime;
    });
    return copy;
  }, [displayedMatches, listSort]);
  const visibleMatches = sortedMatches.slice(0, recentLimit);
  const maxScore = useMemo(
    () => visibleMatches.reduce((max, match) => Math.max(max, match.base_score ?? 0), 0),
    [visibleMatches]
  );
  const networkVisibleCount = useMemo(
    () =>
      visibleMatches.filter((match) =>
        match.attack_vectors.some((vector) => vector.toUpperCase() === 'NETWORK')
      ).length,
    [visibleMatches]
  );

  useEffect(() => {
    setPan({ x: 0, y: 0 });
    setZoom(1);
  }, [graph?.query, nodes.length, edges.length]);

  const handleGraphPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
    setIsDragging(true);
  };

  const handleGraphPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current) return;
    const deltaX = event.clientX - dragStartRef.current.x;
    const deltaY = event.clientY - dragStartRef.current.y;
    setPan({
      x: dragStartRef.current.panX + deltaX,
      y: dragStartRef.current.panY + deltaY,
    });
  };

  const stopDragging = () => {
    dragStartRef.current = null;
    setIsDragging(false);
  };

  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-slate-900">Indicateurs du référentiel CVE</h2>
            <p className="mt-1 text-sm text-slate-500">
              Vue synthétique du volume chargé dans la base de connaissances sécurité.
            </p>
          </div>
          <CollapseToggle
            expanded={isMetricsExpanded}
            onToggle={() => setIsMetricsExpanded((previous) => !previous)}
          />
        </div>
        {isMetricsExpanded ? (
          <div className="grid grid-cols-1 gap-5 md:grid-cols-3 xl:grid-cols-6">
            <Metric label="Vendors" value={String(stats?.vendor_count ?? 0)} />
            <Metric label="Products" value={String(stats?.product_count ?? 0)} />
            <Metric label="Versions" value={String(stats?.version_count ?? 0)} />
            <Metric label="CVE" value={String(stats?.cve_count ?? 0)} />
            <Metric label="Vectors" value={String(stats?.attack_vector_count ?? 0)} />
            <Metric label="CVE critiques" value={String(stats?.critical_cve_count ?? 0)} />
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-500">
            Les indicateurs sont réduits.
          </div>
        )}
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-slate-900">Exploration simple des CVE</h2>
            <p className="mt-1 text-sm text-slate-500">
              Recherche libre par technologie, éditeur, produit ou identifiant CVE, sans écrire de requête technique.
            </p>
          </div>
          <CollapseToggle
            expanded={isSearchExpanded}
            onToggle={() => setIsSearchExpanded((previous) => !previous)}
          />
        </div>
        {isSearchExpanded ? (
          <>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div className="flex w-full max-w-2xl gap-3">
                <label className="flex-1">
                  <span className="sr-only">Recherche CVE</span>
                  <input
                    value={searchQuery}
                    onChange={(event) => onSearchQueryChange(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        onSearch();
                      }
                    }}
                    placeholder="Exemple: react, postgresql, keycloak, CVE-2024"
                    className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-orange-400"
                  />
                </label>
                <button
                  type="button"
                  onClick={onSearch}
                  className="inline-flex items-center gap-2 rounded-2xl bg-orange-500 px-5 py-3 text-sm font-semibold text-white transition hover:bg-orange-600"
                >
                  <Search className="h-4 w-4" />
                  Rechercher
                </button>
              </div>
            </div>

            {graph && graph.extracted_terms.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2">
                {graph.extracted_terms.map((term) => (
                  <span
                    key={term}
                    className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-600"
                  >
                    {term}
                  </span>
                ))}
              </div>
            )}

            {(graph?.enabled === false || stats?.enabled === false) && (
              <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                <span className="font-semibold">Module CVE désactivé :</span> {disabledReason}
              </div>
            )}
          </>
        ) : (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-500">
            La zone de recherche est réduite.
          </div>
        )}
      </section>

      <div className="space-y-6">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-bold text-slate-900">
                {graph?.query?.trim() ? 'CVE trouvées' : 'CVE les plus récentes'}
              </h3>
              <p className="text-sm text-slate-500">
                {graph?.query?.trim()
                  ? 'Résultats exploités pour des scénarios plus spécifiques et plus techniques.'
                  : 'Vue rapide des dernières CVE chargées dans le graphe pour exploration initiale.'}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <label className="text-sm font-medium text-slate-500">
                Trier
                <select
                  value={listSort}
                  onChange={(event) =>
                    setListSort(event.target.value as 'recent' | 'critical' | 'score' | 'network')
                  }
                  className="ml-2 rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm text-slate-700 outline-none"
                >
                  <option value="recent">Plus récentes</option>
                  <option value="critical">Plus critiques</option>
                  <option value="score">Meilleur score</option>
                  <option value="network">Exposition réseau</option>
                </select>
              </label>
              <label className="text-sm font-medium text-slate-500">
                Afficher
                <select
                  value={recentLimit}
                  onChange={(event) => setRecentLimit(Number(event.target.value))}
                  className="ml-2 rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm text-slate-700 outline-none"
                >
                  <option value={10}>10</option>
                  <option value={20}>20</option>
                  <option value={30}>30</option>
                </select>
              </label>
              <CollapseToggle
                expanded={isRecentExpanded}
                onToggle={() => setIsRecentExpanded((previous) => !previous)}
              />
            </div>
          </div>

          {!isRecentExpanded ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-500">
              La liste des CVE est réduite.
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <MiniMetric
                  label="Date la plus récente"
                  value={visibleMatches[0]?.published ? formatPublishedDate(visibleMatches[0]?.published) : 'N/A'}
                />
                <MiniMetric
                  label="Score CVSS max"
                  value={maxScore > 0 ? String(maxScore) : 'N/A'}
                />
                <MiniMetric
                  label="Exposition réseau"
                  value={`${networkVisibleCount}/${visibleMatches.length || 0} CVE`}
                />
                <MiniMetric
                  label="Mode de tri"
                  value={
                    listSort === 'recent'
                      ? 'Plus récentes'
                      : listSort === 'critical'
                        ? 'Plus critiques'
                        : listSort === 'network'
                          ? 'Exposition réseau'
                          : 'Meilleur score'
                  }
                />
              </div>

              {visibleMatches.map((match) => (
                <article key={match.cve_id} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-bold text-slate-900">{match.cve_id}</p>
                      <p className="mt-1 text-xs uppercase tracking-wide text-slate-500">
                        {(match.vendor || 'Vendor inconnu')} · {(match.product || 'Produit inconnu')}
                      </p>
                      <p className="mt-2 text-xs font-medium text-slate-500">
                        Sortie : {formatPublishedDate(match.published)}
                      </p>
                    </div>
                    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${cveBadge(match)}`}>
                      {match.base_score != null ? `CVSS ${match.base_score}` : match.severity || 'N/A'}
                    </span>
                  </div>

                  <p className="mt-3 text-sm leading-relaxed text-slate-600">
                    {match.description.length > 260 ? `${match.description.slice(0, 260)}...` : match.description}
                  </p>

                  {match.attack_vectors.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {match.attack_vectors.map((vector) => (
                        <span
                          key={`${match.cve_id}-${vector}`}
                          className="rounded-full bg-cyan-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-cyan-700"
                        >
                          {vector}
                        </span>
                      ))}
                    </div>
                  )}
                </article>
              ))}
              {displayedMatches.length === 0 && (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-500">
                  Aucune CVE à afficher pour le moment.
                </div>
              )}
            </div>
          )}
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="rounded-2xl bg-slate-900 p-3 text-white">
                <Network className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-slate-900">Sous-graphe visuel</h3>
                <p className="text-sm text-slate-500">
                  Vue orientée métier du chemin Vendor → Product → Version → CVE → AttackVector.
                </p>
              </div>
            </div>
            <CollapseToggle
              expanded={isGraphExpanded}
              onToggle={() => setIsGraphExpanded((previous) => !previous)}
            />
          </div>

          {!isGraphExpanded ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-500">
              Le sous-graphe est réduit. Ouvrez-le pour afficher la visualisation.
            </div>
          ) : !graph?.enabled ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-500">
              {disabledReason}
            </div>
          ) : isLoading ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-500">
              Chargement du sous-graphe CVE...
            </div>
          ) : nodes.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-500">
              Aucun résultat trouvé pour cette recherche.
            </div>
          ) : (
            <div
              onPointerDown={handleGraphPointerDown}
              onPointerMove={handleGraphPointerMove}
              onPointerUp={stopDragging}
              onPointerLeave={stopDragging}
              className={`touch-none overflow-auto rounded-2xl border border-slate-200 bg-[radial-gradient(circle_at_top,rgba(255,237,213,0.45),rgba(255,255,255,1)_42%)] ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
            >
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2 text-xs text-slate-500">
                <span>Glissez pour déplacer la vue</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setZoom((previous) => Math.max(0.6, previous - 0.1))}
                    className="rounded-lg border border-slate-200 px-2 py-1 font-semibold text-slate-600 transition hover:bg-slate-50"
                  >
                    -
                  </button>
                  <span className="min-w-12 text-center font-semibold text-slate-600">
                    {Math.round(zoom * 100)}%
                  </span>
                  <button
                    type="button"
                    onClick={() => setZoom((previous) => Math.min(1.8, previous + 0.1))}
                    className="rounded-lg border border-slate-200 px-2 py-1 font-semibold text-slate-600 transition hover:bg-slate-50"
                  >
                    +
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPan({ x: 0, y: 0 });
                      setZoom(1);
                    }}
                    className="rounded-lg border border-slate-200 px-2 py-1 font-semibold text-slate-600 transition hover:bg-slate-50"
                  >
                    Réinitialiser
                  </button>
                </div>
              </div>
              <div className="flex min-w-full justify-center px-6 py-6">
                <svg
                  viewBox={`0 0 ${width} ${height}`}
                  preserveAspectRatio="xMidYMid meet"
                  className="h-[820px] w-full min-w-[1600px] max-w-[1900px]"
                >
                  <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
                    {edges.map((edge) => renderEdge(edge, positions))}
                    {nodes.map((node) => renderNode(node, positions))}
                  </g>
                </svg>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CollapseToggle({
  expanded,
  onToggle,
}: Readonly<{ expanded: boolean; onToggle: () => void }>) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
    >
      {expanded ? 'Réduire' : 'Ouvrir'}
      <ChevronDown className={`h-4 w-4 transition ${expanded ? 'rotate-180' : ''}`} />
    </button>
  );
}

function Metric({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-3xl font-bold text-slate-900">{value}</p>
    </div>
  );
}

function MiniMetric({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-sm font-semibold text-slate-900">{value}</p>
    </div>
  );
}
