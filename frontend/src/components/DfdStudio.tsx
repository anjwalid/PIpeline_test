import { useEffect, useMemo, useRef, useState } from 'react';
import {
  addEdge,
  BaseEdge,
  Background,
  BackgroundVariant,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  MiniMap,
  NodeResizer,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getNodesBounds,
  getViewportForBounds,
  getSmoothStepPath,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { Download, ImageDown, Plus, Trash2 } from 'lucide-react';
import { toJpeg, toPng } from 'html-to-image';

import type {
  DfdBoundaryFile,
  DfdFlowFile,
  DfdLayout,
  DfdNodeFile,
  StructuredDfd,
} from '../types';

import '@xyflow/react/dist/style.css';
import './DfdStudio.css';

type DfdKind = 'actor' | 'process' | 'store' | 'trustBoundary';

type DfdNodeData = {
  label: string;
  kind: DfdKind;
  boundaryName?: string;
  autoLayoutBoundary?: boolean;
  rotate?: number;
  curve?: number;
  strokeWidth?: number;
  dashLength?: number;
  dashGap?: number;
};

type DfdNode = Node<DfdNodeData>;
type DfdEdge = Edge<{
  label?: string;
  labelOffsetY?: number;
  labelStrategy?: 'smoothstep' | 'geometry';
  sourceKind?: DfdKind;
  targetKind?: DfdKind;
  labelX?: number;
  labelY?: number;
}>;

const DEFAULT_SIZES: Record<DfdKind, { width: number; height: number }> = {
  actor: { width: 150, height: 76 },
  process: { width: 118, height: 118 },
  store: { width: 180, height: 86 },
  trustBoundary: { width: 240, height: 520 },
};

const TRUST_BOUNDARY_DEFAULTS = {
  rotate: 90,
  curve: 0.5,
  strokeWidth: 5,
  dashLength: 14,
  dashGap: 12,
} as const;

const NODE_COLORS: Record<DfdKind, string> = {
  actor: '#1d4ed8',
  process: '#0f766e',
  store: '#b45309',
  trustBoundary: '#111827',
};

const EMPTY_DFD: StructuredDfd = {
  boundaries: [],
  external_entities: [],
  processes: [],
  data_stores: [],
  data_flows: [],
};

const AUTO_LAYOUT = {
  canvasPaddingX: 80,
  canvasPaddingY: 72,
  boundaryWidth: 520,
  boundaryGap: 120,
  boundaryPaddingX: 44,
  boundaryPaddingTop: 84,
  boundaryPaddingBottom: 56,
  laneGap: 88,
  rowGap: 40,
  columnGap: 112,
  curveWidth: 124,
  curveOffsetX: 16,
  curveOffsetY: 52,
} as const;

const EDGE_LABEL_OFFSETS = [-34, 34, -26, 26, -40, 40] as const;

function makeId(prefix: string) {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeDfd(value?: StructuredDfd | null): StructuredDfd {
  if (!value) return { ...EMPTY_DFD };
  return {
    boundaries: Array.isArray(value.boundaries) ? value.boundaries : [],
    external_entities: Array.isArray(value.external_entities) ? value.external_entities : [],
    processes: Array.isArray(value.processes) ? value.processes : [],
    data_stores: Array.isArray(value.data_stores) ? value.data_stores : [],
    data_flows: Array.isArray(value.data_flows) ? value.data_flows : [],
  };
}

function serializeStructuredDfd(value: StructuredDfd) {
  return JSON.stringify(value);
}

function normalizeBoundaryName(value?: string | null) {
  return (value ?? '').trim();
}

function hasStoredLayout(value: StructuredDfd) {
  const hasNodeLayout = [
    ...value.boundaries,
    ...value.external_entities,
    ...value.processes,
    ...value.data_stores,
  ].some((item) => item.layout);
  if (hasNodeLayout) {
    return true;
  }

  return value.data_flows.some((flow) => flow.source_handle || flow.target_handle);
}

function getNodeBounds(node: DfdNode) {
  const defaults = DEFAULT_SIZES[node.type as DfdKind];
  const width = Number(node.style?.width ?? node.width ?? defaults.width);
  const height = Number(node.style?.height ?? node.height ?? defaults.height);
  return {
    x: node.position.x,
    y: node.position.y,
    width,
    height,
  };
}

function nodeCenter(node: DfdNode) {
  const box = getNodeBounds(node);
  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  };
}

function findContainingBoundary(node: DfdNode, boundaries: DfdNode[]) {
  if (node.type === 'trustBoundary') return '';
  const center = nodeCenter(node);
  for (const boundary of boundaries) {
    const box = getNodeBounds(boundary);
    if (
      center.x >= box.x &&
      center.x <= box.x + box.width &&
      center.y >= box.y &&
      center.y <= box.y + box.height
    ) {
      return boundary.data.label;
    }
  }
  return '';
}

function exportLayout(node: DfdNode): DfdLayout {
  const box = getNodeBounds(node);
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
    rotate: node.type === 'trustBoundary' ? node.data.rotate : undefined,
    curve: node.type === 'trustBoundary' ? node.data.curve : undefined,
    strokeWidth: node.type === 'trustBoundary' ? node.data.strokeWidth : undefined,
    dashLength: node.type === 'trustBoundary' ? node.data.dashLength : undefined,
    dashGap: node.type === 'trustBoundary' ? node.data.dashGap : undefined,
  };
}

function exportStructuredDfd(nodes: DfdNode[], edges: DfdEdge[]): StructuredDfd {
  const boundaries = nodes.filter((node) => node.type === 'trustBoundary');
  const regularNodes = nodes.filter((node) => node.type !== 'trustBoundary');
  const labelById = new Map(regularNodes.map((node) => [node.id, node.data.label]));

  const mapNodes = (type: DfdKind): DfdNodeFile[] =>
    regularNodes
      .filter((node) => node.type === type)
      .map((node) => ({
        name: node.data.label,
        boundary: node.data.boundaryName || findContainingBoundary(node, boundaries),
        layout: exportLayout(node),
      }));

  return {
    boundaries: boundaries.map((node) => ({
      name: node.data.label,
      layout: exportLayout(node),
    })) satisfies DfdBoundaryFile[],
    external_entities: mapNodes('actor'),
    processes: mapNodes('process'),
    data_stores: mapNodes('store'),
    data_flows: edges.map((edge) => ({
      source: labelById.get(edge.source) ?? edge.source,
      target: labelById.get(edge.target) ?? edge.target,
      label: String(edge.label ?? ''),
      source_handle: edge.sourceHandle ?? undefined,
      target_handle: edge.targetHandle ?? undefined,
    })) satisfies DfdFlowFile[],
  };
}

type AutoLayoutItem = {
  name: string;
  kind: Exclude<DfdKind, 'trustBoundary'>;
  boundary: string;
};

function resolveAutoLabelOffsetY(
  sourceItem: AutoLayoutItem | undefined,
  targetItem: AutoLayoutItem | undefined,
  index: number
) {
  if (!sourceItem || !targetItem) {
    return EDGE_LABEL_OFFSETS[index % EDGE_LABEL_OFFSETS.length];
  }

  if (targetItem.kind === 'store') {
    return -34;
  }

  if (sourceItem.kind === 'actor') {
    return -22;
  }

  if (sourceItem.kind === 'process' && targetItem.kind === 'process') {
    return index % 2 === 0 ? -22 : 22;
  }

  return index % 2 === 0 ? -18 : 18;
}

function resolveStoredLabelOffsetY(sourceKind: DfdKind | undefined, targetKind: DfdKind | undefined) {
  if (targetKind === 'store') {
    return -34;
  }
  if (sourceKind === 'actor') {
    return -26;
  }
  return -18;
}

function resolveStoredLabelPlacement(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  sourceKind: DfdKind | undefined,
  targetKind: DfdKind | undefined
) {
  const deltaX = targetX - sourceX;
  const deltaY = targetY - sourceY;
  const isMostlyVertical = Math.abs(deltaY) > Math.abs(deltaX);

  if (isMostlyVertical) {
    return {
      x: sourceX + 92,
      y: (sourceY + targetY) / 2,
    };
  }

  return {
    x: (sourceX + targetX) / 2,
    y: (sourceY + targetY) / 2 + resolveStoredLabelOffsetY(sourceKind, targetKind),
  };
}

function buildAutoLayout(data: StructuredDfd): { nodes: DfdNode[]; edges: DfdEdge[] } {
  const items: AutoLayoutItem[] = [
    ...data.external_entities.map((item) => ({
      name: item.name,
      kind: 'actor' as const,
      boundary: normalizeBoundaryName(item.boundary),
    })),
    ...data.processes.map((item) => ({
      name: item.name,
      kind: 'process' as const,
      boundary: normalizeBoundaryName(item.boundary),
    })),
    ...data.data_stores.map((item) => ({
      name: item.name,
      kind: 'store' as const,
      boundary: normalizeBoundaryName(item.boundary),
    })),
  ];
  const itemByName = new Map(items.map((item) => [item.name, item]));

  const boundaryNames = Array.from(
    new Set(
      [
        ...data.boundaries.map((boundary) => normalizeBoundaryName(boundary.name)),
        ...items.map((item) => item.boundary),
      ].filter(Boolean)
    )
  );
  const groupOrder = boundaryNames.length > 0 ? boundaryNames : ['System'];
  const nodes: DfdNode[] = [];
  const nameToId = new Map<string, string>();

  groupOrder.forEach((boundaryName, boundaryIndex) => {
    const members = items.filter((item) => {
      const itemBoundary = item.boundary || groupOrder[0];
      return itemBoundary === boundaryName;
    });

    const actors = members.filter((item) => item.kind === 'actor');
    const processes = members.filter((item) => item.kind === 'process');
    const stores = members.filter((item) => item.kind === 'store');
    const laneHeight = (laneItems: AutoLayoutItem[]) => {
      if (laneItems.length === 0) {
        return 0;
      }
      const size = DEFAULT_SIZES[laneItems[0].kind];
      return size.height;
    };

    const actorsHeight = laneHeight(actors);
    const processesHeight = laneHeight(processes);
    const storesHeight = laneHeight(stores);
    const visibleLaneCount = [actors, processes, stores].filter((lane) => lane.length > 0).length;
    const contentHeight =
      actorsHeight +
      processesHeight +
      storesHeight +
      Math.max(0, visibleLaneCount - 1) * AUTO_LAYOUT.laneGap;
    const boundaryX =
      AUTO_LAYOUT.canvasPaddingX +
      boundaryIndex * (AUTO_LAYOUT.boundaryWidth + AUTO_LAYOUT.boundaryGap);
    const boundaryY = AUTO_LAYOUT.canvasPaddingY;

    nodes.push({
      id: makeId('boundary'),
      type: 'trustBoundary',
      position: { x: boundaryX, y: boundaryY },
      data: {
        label: boundaryName,
        kind: 'trustBoundary',
        autoLayoutBoundary: true,
        rotate: TRUST_BOUNDARY_DEFAULTS.rotate,
        curve: 0.22,
        strokeWidth: TRUST_BOUNDARY_DEFAULTS.strokeWidth,
        dashLength: TRUST_BOUNDARY_DEFAULTS.dashLength,
        dashGap: TRUST_BOUNDARY_DEFAULTS.dashGap,
      },
      style: {
        width: AUTO_LAYOUT.curveWidth,
        height: Math.max(210, contentHeight + 18),
      },
      draggable: false,
      selectable: false,
      zIndex: -1,
    });

    const placeLane = (laneItems: AutoLayoutItem[], startY: number) => {
      if (laneItems.length === 0) {
        return;
      }

      const size = DEFAULT_SIZES[laneItems[0].kind];
      const totalWidth =
        laneItems.length * size.width + Math.max(0, laneItems.length - 1) * AUTO_LAYOUT.columnGap;
      const startX = boundaryX + (AUTO_LAYOUT.boundaryWidth - totalWidth) / 2;

      laneItems
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name))
        .forEach((item, index) => {
          const node: DfdNode = {
            id: makeId(item.kind),
            type: item.kind,
            position: {
              x: startX + index * (size.width + AUTO_LAYOUT.columnGap),
              y: boundaryY + startY,
            },
            data: { label: item.name, kind: item.kind, boundaryName: boundaryName },
            style: {
              width: size.width,
              height: size.height,
            },
            sourcePosition: Position.Right,
            targetPosition: Position.Left,
            zIndex: 10,
          };
          nodes.push(node);
          nameToId.set(item.name, node.id);
        });
    };

    let laneCursor = AUTO_LAYOUT.boundaryPaddingTop;
    if (actors.length > 0) {
      placeLane(actors, laneCursor);
      laneCursor += actorsHeight + AUTO_LAYOUT.laneGap;
    }
    if (processes.length > 0) {
      placeLane(processes, laneCursor);
      laneCursor += processesHeight + AUTO_LAYOUT.laneGap;
    }
    if (stores.length > 0) {
      placeLane(stores, laneCursor);
    }
  });

  const edges = data.data_flows.reduce<DfdEdge[]>((accumulator, flow, index) => {
    const sourceId = nameToId.get(flow.source);
    const targetId = nameToId.get(flow.target);
    if (!sourceId || !targetId || sourceId === targetId) {
      return accumulator;
    }

    accumulator.push({
      id: makeId('flow'),
      source: sourceId,
      target: targetId,
      label: flow.label,
      data: {
        label: flow.label,
        labelOffsetY: resolveAutoLabelOffsetY(
          itemByName.get(flow.source),
          itemByName.get(flow.target),
          index
        ),
      },
      sourceHandle: flow.source_handle,
      targetHandle: flow.target_handle,
      type: 'dfd',
      markerEnd: { type: MarkerType.ArrowClosed, color: '#334155' },
    });
    return accumulator;
  }, []);

  return {
    nodes: nodes.sort((left, right) => (left.zIndex ?? 0) - (right.zIndex ?? 0)),
    edges,
  };
}

function importStructuredDfd(value?: StructuredDfd | null): { nodes: DfdNode[]; edges: DfdEdge[] } {
  const data = normalizeDfd(value);
  if (!hasStoredLayout(data)) {
    return buildAutoLayout(data);
  }

  const nodes: DfdNode[] = [];
  const nameToId = new Map<string, string>();
  const kindByName = new Map<string, DfdKind>();

  data.boundaries
    .filter((boundary) => normalizeBoundaryName(boundary.name))
    .forEach((boundary, index) => {
    const node: DfdNode = {
      id: makeId('boundary'),
      type: 'trustBoundary',
      position: boundary.layout ? { x: boundary.layout.x, y: boundary.layout.y } : { x: 260 * index + 40, y: 40 },
      data: {
        label: boundary.name,
        kind: 'trustBoundary',
        rotate: boundary.layout?.rotate ?? TRUST_BOUNDARY_DEFAULTS.rotate,
        curve: boundary.layout?.curve ?? TRUST_BOUNDARY_DEFAULTS.curve,
        strokeWidth: boundary.layout?.strokeWidth ?? TRUST_BOUNDARY_DEFAULTS.strokeWidth,
        dashLength: boundary.layout?.dashLength ?? TRUST_BOUNDARY_DEFAULTS.dashLength,
        dashGap: boundary.layout?.dashGap ?? TRUST_BOUNDARY_DEFAULTS.dashGap,
      },
      style: {
        width: boundary.layout?.width ?? DEFAULT_SIZES.trustBoundary.width,
        height: boundary.layout?.height ?? DEFAULT_SIZES.trustBoundary.height,
      },
      zIndex: -1,
    };
    nodes.push(node);
  });

  const placeRegularNodes = (
    items: DfdNodeFile[],
    type: Exclude<DfdKind, 'trustBoundary'>,
    baseX: number,
    baseY: number
  ) => {
    items.forEach((item, index) => {
      const node: DfdNode = {
        id: makeId(type),
        type,
        position: item.layout ? { x: item.layout.x, y: item.layout.y } : { x: baseX + index * 210, y: baseY },
        data: { label: item.name, kind: type, boundaryName: normalizeBoundaryName(item.boundary) },
        style: {
          width: item.layout?.width ?? DEFAULT_SIZES[type].width,
          height: item.layout?.height ?? DEFAULT_SIZES[type].height,
        },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        zIndex: 10,
      };
      nodes.push(node);
      nameToId.set(item.name, node.id);
      kindByName.set(item.name, type);
    });
  };

  placeRegularNodes(data.external_entities, 'actor', 40, 120);
  placeRegularNodes(data.processes, 'process', 280, 250);
  placeRegularNodes(data.data_stores, 'store', 560, 430);

  const edges = data.data_flows.reduce<DfdEdge[]>((accumulator, flow) => {
      const sourceId = nameToId.get(flow.source);
      const targetId = nameToId.get(flow.target);
      if (!sourceId || !targetId || sourceId === targetId) {
        return accumulator;
      }

      const sourceNode = nodes.find((node) => node.id === sourceId);
      const targetNode = nodes.find((node) => node.id === targetId);
      const sourceCenter = sourceNode ? nodeCenter(sourceNode as DfdNode) : { x: 0, y: 0 };
      const targetCenter = targetNode ? nodeCenter(targetNode as DfdNode) : { x: 0, y: 0 };
      const sourceKind = kindByName.get(flow.source);
      const targetKind = kindByName.get(flow.target);
      const placement = resolveStoredLabelPlacement(
        sourceCenter.x,
        sourceCenter.y,
        targetCenter.x,
        targetCenter.y,
        sourceKind,
        targetKind
      );

      accumulator.push({
        id: makeId('flow'),
        source: sourceId,
        target: targetId,
        label: flow.label,
        data: {
          label: flow.label,
          labelStrategy: 'geometry',
          sourceKind,
          targetKind,
          labelX: placement.x,
          labelY: placement.y,
        },
        sourceHandle: flow.source_handle,
        targetHandle: flow.target_handle,
        type: 'dfd',
        markerEnd: { type: MarkerType.ArrowClosed, color: '#334155' },
      });
      return accumulator;
    }, []);

  return {
    nodes: nodes.sort((left, right) => (left.zIndex ?? 0) - (right.zIndex ?? 0)),
    edges,
  };
}

function ActorNode({ data, selected }: NodeProps<DfdNode>) {
  return (
    <div className={`dfd-node-card actor ${selected ? 'selected' : ''}`}>
      <NodeHandles />
      <div className="dfd-node-label">{data.label}</div>
    </div>
  );
}

function ProcessNode({ data, selected }: NodeProps<DfdNode>) {
  return (
    <div className={`dfd-node-card process ${selected ? 'selected' : ''}`}>
      <NodeHandles />
      <div className="dfd-node-label">{data.label}</div>
    </div>
  );
}

function StoreNode({ data, selected }: NodeProps<DfdNode>) {
  return (
    <div className={`dfd-node-card store ${selected ? 'selected' : ''}`}>
      <NodeHandles />
      <div className="dfd-store-line" />
      <div className="dfd-node-label">{data.label}</div>
      <div className="dfd-store-line" />
    </div>
  );
}

function TrustBoundaryNode({ data, selected }: NodeProps<DfdNode>) {
  if (data.autoLayoutBoundary) {
    return (
      <div className="dfd-node-card boundary auto-layout">
        <div className="dfd-boundary-badge">{data.label}</div>
        <div
          className="dfd-boundary-curve auto-layout"
          style={{
            width: '100%',
            height: '100%',
            transform: `translate(${AUTO_LAYOUT.curveOffsetX}px, ${AUTO_LAYOUT.curveOffsetY}px)`,
          }}
        >
          <svg width="100%" height="100%" viewBox="0 0 124 360" preserveAspectRatio="none">
            <path
              d="M 28 8
                 C 94 60, 94 130, 34 180
                 C -14 222, -10 296, 56 352"
              fill="none"
              stroke="#111827"
              strokeWidth={4.5}
              strokeDasharray="14 12"
              strokeLinecap="round"
            />
          </svg>
        </div>
      </div>
    );
  }

  const rotate = data.rotate ?? TRUST_BOUNDARY_DEFAULTS.rotate;
  const curve = data.curve ?? TRUST_BOUNDARY_DEFAULTS.curve;
  const strokeWidth = data.strokeWidth ?? TRUST_BOUNDARY_DEFAULTS.strokeWidth;
  const dashLength = data.dashLength ?? TRUST_BOUNDARY_DEFAULTS.dashLength;
  const dashGap = data.dashGap ?? TRUST_BOUNDARY_DEFAULTS.dashGap;
  const topCurve = Math.max(0.02, 0.14 - curve * 0.12);
  const bottomCurve = Math.min(0.98, 0.86 + curve * 0.12);

  return (
    <div className={`dfd-node-card boundary ${selected ? 'selected' : ''}`}>
      <NodeResizer
        minWidth={260}
        minHeight={220}
        isVisible={selected}
        lineClassName="dfd-resize-line"
        handleClassName="dfd-resize-handle"
      />
      <div className="dfd-boundary-badge">{data.label}</div>
      <div
        className="dfd-boundary-curve"
        style={{
          width: '100%',
          height: '100%',
          transform: `rotate(${rotate}deg)`,
        }}
      >
        <svg width="100%" height="100%" viewBox="0 0 240 520" preserveAspectRatio="none">
          <path
            d={`M 20 260
              C ${240 * 0.22} ${520 * topCurve},
                ${240 * 0.55} ${520 * bottomCurve},
                ${240 - 20} 260`}
            fill="none"
            stroke="#111827"
            strokeWidth={strokeWidth}
            strokeDasharray={`${dashLength} ${dashGap}`}
            strokeLinecap="round"
          />
        </svg>
      </div>
    </div>
  );
}

function NodeHandles() {
  return (
    <>
      <Handle id="left-target" type="target" position={Position.Left} className="dfd-handle" />
      <Handle id="top-target" type="target" position={Position.Top} className="dfd-handle" />
      <Handle id="right-source" type="source" position={Position.Right} className="dfd-handle" />
      <Handle id="bottom-source" type="source" position={Position.Bottom} className="dfd-handle" />
    </>
  );
}

function DfdEdgeRenderer({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  label,
  selected,
  markerEnd,
  style,
  data,
}: EdgeProps<DfdEdge>) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 18,
    offset: 72,
  });
  const computedLabelX =
    data?.labelStrategy === 'geometry' ? (data.labelX ?? (sourceX + targetX) / 2) : labelX;
  const computedLabelY =
    data?.labelStrategy === 'geometry' ? (data.labelY ?? (sourceY + targetY) / 2) : labelY;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: selected ? '#0f172a' : '#94a3b8',
          strokeWidth: selected ? 2.6 : 1.8,
        }}
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            className="dfd-edge-label"
            style={{
              transform: `translate(-50%, -50%) translate(${computedLabelX}px, ${computedLabelY}px)`,
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

interface DfdStudioCanvasProps {
  value: StructuredDfd;
  onChange?: (nextValue: StructuredDfd) => void;
  readOnly?: boolean;
  title?: string;
  fullscreen?: boolean;
}

function DfdStudioCanvas({
  value,
  onChange,
  readOnly = false,
  title = 'DFD Studio',
  fullscreen = false,
}: Readonly<DfdStudioCanvasProps>) {
  const imported = useMemo(() => importStructuredDfd(value), [value]);
  const [nodes, setNodes, onNodesChange] = useNodesState(imported.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(imported.edges);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [isExportingImage, setIsExportingImage] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const lastEmittedSignatureRef = useRef<string>('');
  const pendingAutoFitRef = useRef(false);
  const { fitView, screenToFlowPosition } = useReactFlow();
  const valueSignature = useMemo(() => serializeStructuredDfd(normalizeDfd(value)), [value]);

  const settleViewport = async () => {
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
    fitView({ padding: 0.18, duration: 0 });
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
  };

  useEffect(() => {
    if (valueSignature === lastEmittedSignatureRef.current) {
      return;
    }
    pendingAutoFitRef.current = true;
    setNodes(imported.nodes);
    setEdges(imported.edges);
  }, [imported, setEdges, setNodes, valueSignature]);

  useEffect(() => {
    if (!pendingAutoFitRef.current) {
      return;
    }
    pendingAutoFitRef.current = false;
    void settleViewport();
  }, [edges, fitView, nodes]);

  useEffect(() => {
    const exported = exportStructuredDfd(nodes as DfdNode[], edges as DfdEdge[]);
    const signature = serializeStructuredDfd(exported);
    lastEmittedSignatureRef.current = signature;
    onChange?.(exported);
  }, [edges, nodes, onChange]);

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) as DfdNode | undefined;
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId) as DfdEdge | undefined;

  const nodeTypes = useMemo(
    () => ({
      actor: ActorNode,
      process: ProcessNode,
      store: StoreNode,
      trustBoundary: TrustBoundaryNode,
    }),
    []
  );

  const edgeTypes = useMemo(
    () => ({
      dfd: DfdEdgeRenderer,
    }),
    []
  );

  const addNode = (kind: DfdKind) => {
    const size = DEFAULT_SIZES[kind];
    const center = screenToFlowPosition({
      x: (wrapperRef.current?.clientWidth ?? 800) / 2,
      y: (wrapperRef.current?.clientHeight ?? 600) / 2,
    });
    const nextNode: DfdNode = {
      id: makeId(kind),
      type: kind,
      position: { x: center.x - size.width / 2, y: center.y - size.height / 2 },
      data: {
        label:
          kind === 'actor'
            ? 'New Actor'
            : kind === 'process'
              ? 'New Process'
              : kind === 'store'
                ? 'New Store'
                : 'Trust Zone',
        kind,
        rotate: kind === 'trustBoundary' ? TRUST_BOUNDARY_DEFAULTS.rotate : undefined,
        curve: kind === 'trustBoundary' ? TRUST_BOUNDARY_DEFAULTS.curve : undefined,
        strokeWidth: kind === 'trustBoundary' ? TRUST_BOUNDARY_DEFAULTS.strokeWidth : undefined,
        dashLength: kind === 'trustBoundary' ? TRUST_BOUNDARY_DEFAULTS.dashLength : undefined,
        dashGap: kind === 'trustBoundary' ? TRUST_BOUNDARY_DEFAULTS.dashGap : undefined,
      },
      style: { width: size.width, height: size.height },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      zIndex: kind === 'trustBoundary' ? -1 : 10,
    };
    setNodes((current) => [...current, nextNode].sort((left, right) => (left.zIndex ?? 0) - (right.zIndex ?? 0)));
    setSelectedNodeId(nextNode.id);
    setSelectedEdgeId(null);
  };

  const onConnect = (connection: Connection) => {
    if (readOnly) return;
    setEdges((current) =>
      addEdge(
        {
          ...connection,
          markerEnd: { type: MarkerType.ArrowClosed, color: '#334155' },
          label: 'Data Flow',
        },
        current
      )
    );
  };

  const deleteSelection = () => {
    if (readOnly) return;
    if (selectedNodeId) {
      setNodes((current) => current.filter((node) => node.id !== selectedNodeId));
      setEdges((current) => current.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId));
      setSelectedNodeId(null);
      return;
    }
    if (selectedEdgeId) {
      setEdges((current) => current.filter((edge) => edge.id !== selectedEdgeId));
      setSelectedEdgeId(null);
    }
  };

  const exportJson = () => {
    const payload = exportStructuredDfd(nodes as DfdNode[], edges as DfdEdge[]);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'diagramme-dfd.json';
    link.click();
    URL.revokeObjectURL(url);
  };

  const exportImage = async (format: 'png' | 'jpeg') => {
    const viewportElement = wrapperRef.current?.querySelector('.react-flow__viewport') as HTMLElement | null;
    if (!viewportElement) return;
    if (nodes.length === 0) return;

    const previousSelectedNodeId = selectedNodeId;
    const previousSelectedEdgeId = selectedEdgeId;

    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setIsExportingImage(true);

    await settleViewport();

    const canvasWidth = Math.max(wrapperRef.current?.clientWidth ?? 0, 1200);
    const canvasHeight = Math.max(wrapperRef.current?.clientHeight ?? 0, 720);
    const bounds = getNodesBounds(nodes);
    const paddedBounds = {
      x: bounds.x - 48,
      y: bounds.y - 48,
      width: bounds.width + 96,
      height: bounds.height + 96,
    };
    const viewport = getViewportForBounds(
      paddedBounds,
      canvasWidth,
      canvasHeight,
      0.2,
      2.5,
      0.02
    );

    const exporter = format === 'jpeg' ? toJpeg : toPng;
    const dataUrl = await exporter(viewportElement, {
      backgroundColor: format === 'jpeg' ? '#ffffff' : 'rgba(255,255,255,0)',
      pixelRatio: 2.5,
      cacheBust: true,
      width: canvasWidth,
      height: canvasHeight,
      style: {
        width: `${canvasWidth}px`,
        height: `${canvasHeight}px`,
        transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
        transformOrigin: '0 0',
      },
    });

    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = `diagramme-dfd.${format === 'jpeg' ? 'jpg' : 'png'}`;
    link.click();

    setIsExportingImage(false);
    setSelectedNodeId(previousSelectedNodeId);
    setSelectedEdgeId(previousSelectedEdgeId);
  };

  return (
    <div className={`dfd-studio-shell ${fullscreen ? 'fullscreen' : ''} ${isExportingImage ? 'is-exporting' : ''}`}>
      <div className="dfd-toolbar">
        <div className="dfd-toolbar-brand">
          <div>
            <p className="dfd-toolbar-kicker">Interactive DFD</p>
            <h3>{title}</h3>
          </div>
        </div>
        <div className="dfd-toolbar-actions">
          {!readOnly && (
            <>
              <button type="button" onClick={() => addNode('actor')}><Plus className="h-4 w-4" /> Actor</button>
              <button type="button" onClick={() => addNode('process')}><Plus className="h-4 w-4" /> Process</button>
              <button type="button" onClick={() => addNode('store')}><Plus className="h-4 w-4" /> Store</button>
              <button type="button" onClick={() => addNode('trustBoundary')}><Plus className="h-4 w-4" /> Boundary</button>
            </>
          )}
          <button type="button" onClick={exportJson}><Download className="h-4 w-4" /> JSON</button>
          <button type="button" onClick={() => void exportImage('png')}><ImageDown className="h-4 w-4" /> PNG</button>
          <button type="button" onClick={() => void exportImage('jpeg')}><ImageDown className="h-4 w-4" /> JPEG</button>
        </div>
      </div>

      <div className={`dfd-layout ${fullscreen ? 'fullscreen' : ''}`}>
        <div className="dfd-canvas-card" ref={wrapperRef}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={readOnly ? undefined : onNodesChange}
            onEdgesChange={readOnly ? undefined : onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => {
              setSelectedNodeId(node.id);
              setSelectedEdgeId(null);
            }}
            onEdgeClick={(_, edge) => {
              setSelectedEdgeId(edge.id);
              setSelectedNodeId(null);
            }}
            onPaneClick={() => {
              setSelectedNodeId(null);
              setSelectedEdgeId(null);
            }}
            fitView
            minZoom={0.2}
            maxZoom={2.5}
            nodesDraggable={!readOnly}
            elementsSelectable
            nodesConnectable={!readOnly}
            edgesFocusable
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{
              type: 'dfd',
              markerEnd: { type: MarkerType.ArrowClosed, color: '#334155' },
            }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="#d8dee9" />
            <Controls />
            <MiniMap nodeColor={(node) => NODE_COLORS[(node.type as DfdKind) ?? 'process']} />
          </ReactFlow>
        </div>

        <div className="dfd-inspector">
          <div className="dfd-inspector-head">
            <p className="dfd-toolbar-kicker">Inspector</p>
            <h4>
              {selectedNode ? 'Node Properties' : selectedEdge ? 'Flow Properties' : 'No selection'}
            </h4>
          </div>

          {selectedNode ? (
            <div className="dfd-inspector-form">
              <label>
                Label
                <input
                  value={selectedNode.data.label}
                  onChange={(event) => {
                    if (readOnly) return;
                    setNodes((current) =>
                      current.map((node) =>
                        node.id === selectedNode.id
                          ? { ...node, data: { ...node.data, label: event.target.value } }
                          : node
                      )
                    );
                  }}
                  readOnly={readOnly}
                />
              </label>
              <label>
                X
                <input
                  type="number"
                  value={Math.round(selectedNode.position.x)}
                  onChange={(event) => {
                    if (readOnly) return;
                    setNodes((current) =>
                      current.map((node) =>
                        node.id === selectedNode.id
                          ? { ...node, position: { ...node.position, x: Number(event.target.value) } }
                          : node
                      )
                    );
                  }}
                  readOnly={readOnly}
                />
              </label>
              <label>
                Y
                <input
                  type="number"
                  value={Math.round(selectedNode.position.y)}
                  onChange={(event) => {
                    if (readOnly) return;
                    setNodes((current) =>
                      current.map((node) =>
                        node.id === selectedNode.id
                          ? { ...node, position: { ...node.position, y: Number(event.target.value) } }
                          : node
                      )
                    );
                  }}
                  readOnly={readOnly}
                />
              </label>
              {!readOnly && (
                <button type="button" className="dfd-danger-button" onClick={deleteSelection}>
                  <Trash2 className="h-4 w-4" /> Delete Node
                </button>
              )}
            </div>
          ) : selectedEdge ? (
            <div className="dfd-inspector-form">
              <label>
                Flow Label
                <input
                  value={String(selectedEdge.label ?? '')}
                  onChange={(event) => {
                    if (readOnly) return;
                    setEdges((current) =>
                      current.map((edge) =>
                        edge.id === selectedEdge.id ? { ...edge, label: event.target.value } : edge
                      )
                    );
                  }}
                  readOnly={readOnly}
                />
              </label>
              {!readOnly && (
                <button type="button" className="dfd-danger-button" onClick={deleteSelection}>
                  <Trash2 className="h-4 w-4" /> Delete Flow
                </button>
              )}
            </div>
          ) : (
            <div className="dfd-empty-state">
              <p>Le JSON DFD est rendu ici sous forme visuelle.</p>
              <p>Tu peux exporter en PNG ou ajuster le diagramme avant régénération du rapport.</p>
              <button type="button" onClick={() => fitView({ duration: 450, padding: 0.16 })}>
                Fit View
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function DfdStudio(props: Readonly<DfdStudioCanvasProps>) {
  return (
    <ReactFlowProvider>
      <DfdStudioCanvas {...props} />
    </ReactFlowProvider>
  );
}
