import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  getNodesBounds,
  getViewportForBounds,
  Handle,
  MiniMap,
  MarkerType,
  NodeResizer,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
} from "@xyflow/react";
import { toPng } from "html-to-image";

import "@xyflow/react/dist/style.css";

type DfdKind = "actor" | "process" | "store" | "trustBoundary";

type DfdNodeData = {
  label: string;
  kind: DfdKind;
  boundary?: string;
  rotate?: number;
  curve?: number;
  strokeWidth?: number;
  dashLength?: number;
  dashGap?: number;
  nudgeRotate?: (delta: number) => void;
  nudgeCurve?: (delta: number) => void;
};

type DfdNode = Node<DfdNodeData>;
type DfdEdge = Edge<{ label?: string }>;

type DiagramLayout = {
  x: number;
  y: number;
  width?: number;
  height?: number;
  rotate?: number;
  curve?: number;
  strokeWidth?: number;
  dashLength?: number;
  dashGap?: number;
};

type DiagramBoundaryFile = {
  name: string;
  layout?: DiagramLayout;
};

type DiagramNodeFile = {
  name: string;
  boundary: string;
  layout?: DiagramLayout;
};

type DiagramFlowFile = {
  source: string;
  target: string;
  label: string;
  source_handle?: string;
  target_handle?: string;
};

type StructuredDiagramFile = {
  boundaries: DiagramBoundaryFile[];
  external_entities: DiagramNodeFile[];
  processes: DiagramNodeFile[];
  data_stores: DiagramNodeFile[];
  data_flows: DiagramFlowFile[];
};

const DEFAULT_SIZES: Record<DfdKind, { width: number; height: number }> = {
  actor: { width: 144, height: 76 },
  process: { width: 110, height: 110 },
  store: { width: 168, height: 80 },
  trustBoundary: { width: 220, height: 520 },
};

const TRUST_BOUNDARY_DEFAULTS = {
  rotate: 90,
  curve: 0.5,
  strokeWidth: 5,
  dashLength: 14,
  dashGap: 12,
} as const;

const NODE_COLORS: Record<DfdKind, string> = {
  actor: "#2563eb",
  process: "#0f766e",
  store: "#b45309",
  trustBoundary: "#111827",
};

const SAMPLE_NODES: DfdNode[] = [
  {
    id: "boundary-1",
    type: "trustBoundary",
    position: { x: 170, y: 30 },
    data: {
      label: "Internal Trust Zone",
      kind: "trustBoundary",
      ...TRUST_BOUNDARY_DEFAULTS,
    },
    zIndex: -1,
    style: { width: 220, height: 520 },
  },
  {
    id: "actor-1",
    type: "actor",
    position: { x: 50, y: 205 },
    data: { label: "External User", kind: "actor" },
  },
  {
    id: "process-1",
    type: "process",
    position: { x: 330, y: 180 },
    data: { label: "Frontend", kind: "process" },
  },
  {
    id: "process-2",
    type: "process",
    position: { x: 560, y: 180 },
    data: { label: "Backend API", kind: "process" },
  },
  {
    id: "store-1",
    type: "store",
    position: { x: 805, y: 205 },
    data: { label: "Primary Store", kind: "store" },
  },
];

const SAMPLE_EDGES: DfdEdge[] = [
  { id: "edge-1", source: "actor-1", target: "process-1", type: "dfd", animated: true, label: "HTTPS" },
  { id: "edge-2", source: "process-1", target: "process-2", type: "dfd", animated: true, label: "API Call" },
  { id: "edge-3", source: "process-2", target: "store-1", type: "dfd", animated: true, label: "Read / Write" },
];

function makeId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function stripRuntimeNodeData(nodes: DfdNode[]) {
  return nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      nudgeRotate: undefined,
      nudgeCurve: undefined,
    },
  }));
}

function getNodeBounds(node: DfdNode) {
  const fallback = DEFAULT_SIZES[node.type as DfdKind] ?? { width: 120, height: 80 };
  const width = Number(node.style?.width ?? node.width ?? fallback.width);
  const height = Number(node.style?.height ?? node.height ?? fallback.height);
  return {
    x: node.position.x,
    y: node.position.y,
    width,
    height,
  };
}

function findContainingBoundaryName(node: DfdNode, boundaries: DfdNode[]) {
  if (node.type === "trustBoundary") return "";

  const box = getNodeBounds(node);
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;

  for (const boundary of boundaries) {
    const boundaryBox = getNodeBounds(boundary);
    if (
      centerX >= boundaryBox.x &&
      centerX <= boundaryBox.x + boundaryBox.width &&
      centerY >= boundaryBox.y &&
      centerY <= boundaryBox.y + boundaryBox.height
    ) {
      return boundary.data.label;
    }
  }

  return node.data.boundary ?? "";
}

function exportStructuredDiagram(nodes: DfdNode[], edges: DfdEdge[]): StructuredDiagramFile {
  const cleanNodes = stripRuntimeNodeData(nodes);
  const boundaryNodes = cleanNodes.filter((node) => node.type === "trustBoundary");
  const regularNodes = cleanNodes.filter((node) => node.type !== "trustBoundary");
  const labelById = new Map(regularNodes.map((node) => [node.id, node.data.label]));

  const exportNodeLayout = (node: DfdNode): DiagramLayout => {
    const bounds = getNodeBounds(node);
    return {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
      rotate: node.type === "trustBoundary" ? node.data.rotate : undefined,
      curve: node.type === "trustBoundary" ? node.data.curve : undefined,
      strokeWidth: node.type === "trustBoundary" ? node.data.strokeWidth : undefined,
      dashLength: node.type === "trustBoundary" ? node.data.dashLength : undefined,
      dashGap: node.type === "trustBoundary" ? node.data.dashGap : undefined,
    };
  };

  const mapNodesByType = (type: DfdKind) =>
    regularNodes
      .filter((node) => node.type === type)
      .map((node) => ({
        name: node.data.label,
        boundary: findContainingBoundaryName(node, boundaryNodes),
        layout: exportNodeLayout(node),
      }));

  return {
    boundaries: boundaryNodes.map((node) => ({
      name: node.data.label,
      layout: exportNodeLayout(node),
    })),
    external_entities: mapNodesByType("actor"),
    processes: mapNodesByType("process"),
    data_stores: mapNodesByType("store"),
    data_flows: edges.map((edge) => ({
      source: labelById.get(edge.source) ?? edge.source,
      target: labelById.get(edge.target) ?? edge.target,
      label: String(edge.label ?? ""),
      source_handle: edge.sourceHandle ?? undefined,
      target_handle: edge.targetHandle ?? undefined,
    })),
  };
}

function importStructuredDiagram(data: StructuredDiagramFile): { nodes: DfdNode[]; edges: DfdEdge[] } {
  const boundaries = Array.isArray(data.boundaries) ? data.boundaries : [];
  const externalEntities = Array.isArray(data.external_entities) ? data.external_entities : [];
  const processes = Array.isArray(data.processes) ? data.processes : [];
  const dataStores = Array.isArray(data.data_stores) ? data.data_stores : [];
  const dataFlows = Array.isArray(data.data_flows) ? data.data_flows : [];

  const hasStoredLayout =
    boundaries.some((boundary) => boundary.layout) ||
    [...externalEntities, ...processes, ...dataStores].some((item) => item.layout);

  const assignedBoundaries = new Set(
    [...externalEntities, ...processes, ...dataStores]
      .map((item) => item.boundary?.trim())
      .filter((boundaryName): boundaryName is string => Boolean(boundaryName))
  );

  const boundaryNodes: DfdNode[] = boundaries.map((boundary, index) => {
    const isAssigned = assignedBoundaries.has(boundary.name);

    return {
      id: makeId("boundary"),
      type: "trustBoundary",
      position: boundary.layout
        ? { x: boundary.layout.x, y: boundary.layout.y }
        : isAssigned
          ? { x: 170 + index * 260, y: 30 }
          : { x: 24 + index * 160, y: 18 },
      data: {
        label: boundary.name,
        kind: "trustBoundary",
        rotate: boundary.layout?.rotate ?? TRUST_BOUNDARY_DEFAULTS.rotate,
        curve: boundary.layout?.curve ?? TRUST_BOUNDARY_DEFAULTS.curve,
        strokeWidth: boundary.layout?.strokeWidth ?? TRUST_BOUNDARY_DEFAULTS.strokeWidth,
        dashLength: boundary.layout?.dashLength ?? TRUST_BOUNDARY_DEFAULTS.dashLength,
        dashGap: boundary.layout?.dashGap ?? TRUST_BOUNDARY_DEFAULTS.dashGap,
      },
      zIndex: -1,
      style: {
        width: boundary.layout?.width ?? (isAssigned ? 220 : 120),
        height: boundary.layout?.height ?? (isAssigned ? 520 : 170),
      },
    };
  });
  const nameToId = new Map<string, string>();
  const regularNodes: DfdNode[] = [];
  const nodeByName = new Map<string, DfdNode>();

  const buildPositionedNode = (
    kind: DfdKind,
    name: string,
    boundaryName: string,
    position: { x: number; y: number },
    layout?: DiagramLayout
  ): DfdNode => {
    const size = DEFAULT_SIZES[kind];
    const node: DfdNode = {
      id: makeId(kind),
      type: kind,
      position: layout ? { x: layout.x, y: layout.y } : position,
      sourcePosition: kind === "store" ? Position.Bottom : Position.Right,
      targetPosition: kind === "store" ? Position.Top : Position.Left,
      data: {
        label: name,
        kind,
        boundary: boundaryName,
      },
      zIndex: 10,
      style: {
        width: layout?.width ?? size.width,
        height: layout?.height ?? size.height,
      },
    };

    regularNodes.push(node);
    nodeByName.set(name, node);
    if (!nameToId.has(name)) nameToId.set(name, node.id);
    return node;
  };

  const layoutGroup = (
    items: Array<{ kind: DfdKind; name: string; boundary: string; layout?: DiagramLayout }>,
    originX: number,
    originY: number,
    compact: boolean
  ) => {
    const actorsInGroup = items.filter((item) => item.kind === "actor");
    const processesInGroup = items.filter((item) => item.kind === "process");
    const storesInGroup = items.filter((item) => item.kind === "store");

    const actorY = originY;
    const processY = originY + (compact ? 146 : 136);
    const storeY = processY + (compact ? 190 : 176);

    actorsInGroup.forEach((item, index) => {
      buildPositionedNode("actor", item.name, item.boundary, {
        x: originX + index * 216,
        y: actorY,
      }, item.layout);
    });

    processesInGroup.forEach((item, index) => {
      buildPositionedNode("process", item.name, item.boundary, {
        x: originX + 70 + index * 214,
        y: processY,
      }, item.layout);
    });

    storesInGroup.forEach((item, index) => {
      buildPositionedNode("store", item.name, item.boundary, {
        x: originX + 92 + index * 224,
        y: storeY,
      }, item.layout);
    });
  };

  const allItems = [
    ...externalEntities.map((item) => ({ kind: "actor" as const, name: item.name, boundary: item.boundary, layout: item.layout })),
    ...processes.map((item) => ({ kind: "process" as const, name: item.name, boundary: item.boundary, layout: item.layout })),
    ...dataStores.map((item) => ({ kind: "store" as const, name: item.name, boundary: item.boundary, layout: item.layout })),
  ];

  const outsideItems = allItems.filter((item) => !item.boundary?.trim());
  const boundaryItems = new Map<string, Array<{ kind: DfdKind; name: string; boundary: string; layout?: DiagramLayout }>>();

  allItems
    .filter((item) => item.boundary?.trim())
    .forEach((item) => {
      const key = item.boundary.trim();
      const list = boundaryItems.get(key) ?? [];
      list.push({ ...item, boundary: key });
      boundaryItems.set(key, list);
    });

  layoutGroup(outsideItems, 40, 90, true);

  boundaryNodes.forEach((boundaryNode) => {
    const items = boundaryItems.get(boundaryNode.data.label) ?? [];
    layoutGroup(items, boundaryNode.position.x + 48, boundaryNode.position.y + 42, false);
  });

  if (!hasStoredLayout) {
    dataStores.forEach((item) => {
    const node = nodeByName.get(item.name);
    if (!node) return;

    const incomingSources = dataFlows
      .filter((flow) => flow.target === item.name)
      .map((flow) => nodeByName.get(flow.source))
      .filter((source): source is DfdNode => Boolean(source));

    if (incomingSources.length === 0) return;

    const averageCenterX =
      incomingSources.reduce((sum, source) => {
        const sourceWidth = Number(source.style?.width ?? DEFAULT_SIZES[source.type as DfdKind].width);
        return sum + source.position.x + sourceWidth / 2;
      }, 0) / incomingSources.length;

    const storeWidth = Number(node.style?.width ?? DEFAULT_SIZES.store.width);
    node.position.x = Math.round(averageCenterX - storeWidth / 2);
    node.targetPosition = Position.Top;
    });
  }

  const getNodeCenter = (node: DfdNode) => {
    const size = DEFAULT_SIZES[node.type as DfdKind];
    const width = Number(node.style?.width ?? size.width);
    const height = Number(node.style?.height ?? size.height);
    return {
      x: node.position.x + width / 2,
      y: node.position.y + height / 2,
    };
  };

  const resolveHandleIds = (sourceNode: DfdNode, targetNode: DfdNode) => {
    const sourceCenter = getNodeCenter(sourceNode);
    const targetCenter = getNodeCenter(targetNode);
    const dx = targetCenter.x - sourceCenter.x;
    const dy = targetCenter.y - sourceCenter.y;

    if (Math.abs(dy) > Math.abs(dx)) {
      return dy >= 0
        ? { sourceHandle: "bottom-source", targetHandle: "top-target" }
        : { sourceHandle: "top-source", targetHandle: "bottom-target" };
    }

    return dx >= 0
      ? { sourceHandle: "right-source", targetHandle: "left-target" }
      : { sourceHandle: "left-source", targetHandle: "right-target" };
  };

  const flowEdges = dataFlows
    .map((flow) => {
      const sourceId = nameToId.get(flow.source);
      const targetId = nameToId.get(flow.target);
      if (!sourceId || !targetId) return null;
      const sourceNode = nodeByName.get(flow.source);
      const targetNode = nodeByName.get(flow.target);
      if (!sourceNode || !targetNode) return null;
      const { sourceHandle, targetHandle } = flow.source_handle && flow.target_handle
        ? { sourceHandle: flow.source_handle, targetHandle: flow.target_handle }
        : resolveHandleIds(sourceNode, targetNode);

      return {
        id: makeId("flow"),
        source: sourceId,
        target: targetId,
        sourceHandle,
        targetHandle,
        type: "dfd",
        animated: true,
        label: flow.label ?? "",
        markerEnd: { type: MarkerType.ArrowClosed, width: 22, height: 22, color: "#334155" },
      } satisfies DfdEdge;
    })
    .filter((edge): edge is NonNullable<typeof edge> => edge !== null);

  return {
    nodes: [...boundaryNodes, ...regularNodes].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0)),
    edges: flowEdges,
  };
}

function DfdActorNode({ data, selected }: NodeProps<DfdNode>) {
  return (
    <div className={`dfd-node actor ${selected ? "selected" : ""}`}>
      <Handle id="left-target" type="target" position={Position.Left} className="dfd-handle" />
      <Handle id="left-source" type="source" position={Position.Left} className="dfd-handle" />
      <Handle id="top-target" type="target" position={Position.Top} className="dfd-handle" />
      <Handle id="top-source" type="source" position={Position.Top} className="dfd-handle" />
      <div className="dfd-label">{data.label}</div>
      <Handle id="right-target" type="target" position={Position.Right} className="dfd-handle" />
      <Handle id="right-source" type="source" position={Position.Right} className="dfd-handle" />
      <Handle id="bottom-target" type="target" position={Position.Bottom} className="dfd-handle" />
      <Handle id="bottom-source" type="source" position={Position.Bottom} className="dfd-handle" />
    </div>
  );
}

function DfdProcessNode({ data, selected }: NodeProps<DfdNode>) {
  return (
    <div className={`dfd-node process ${selected ? "selected" : ""}`}>
      <Handle id="left-target" type="target" position={Position.Left} className="dfd-handle" />
      <Handle id="left-source" type="source" position={Position.Left} className="dfd-handle" />
      <Handle id="right-target" type="target" position={Position.Right} className="dfd-handle" />
      <Handle id="right-source" type="source" position={Position.Right} className="dfd-handle" />
      <Handle id="top-target" type="target" position={Position.Top} className="dfd-handle" />
      <Handle id="top-source" type="source" position={Position.Top} className="dfd-handle" />
      <Handle id="bottom-target" type="target" position={Position.Bottom} className="dfd-handle" />
      <Handle id="bottom-source" type="source" position={Position.Bottom} className="dfd-handle" />
      <div className="dfd-label">{data.label}</div>
    </div>
  );
}

function DfdStoreNode({ data, selected }: NodeProps<DfdNode>) {
  return (
    <div className={`dfd-node store ${selected ? "selected" : ""}`}>
      <Handle id="left-target" type="target" position={Position.Left} className="dfd-handle" />
      <Handle id="left-source" type="source" position={Position.Left} className="dfd-handle" />
      <Handle id="top-target" type="target" position={Position.Top} className="dfd-handle" />
      <Handle id="top-source" type="source" position={Position.Top} className="dfd-handle" />
      <div className="store-line" />
      <div className="dfd-label">{data.label}</div>
      <div className="store-line" />
      <Handle id="right-target" type="target" position={Position.Right} className="dfd-handle" />
      <Handle id="right-source" type="source" position={Position.Right} className="dfd-handle" />
      <Handle id="bottom-target" type="target" position={Position.Bottom} className="dfd-handle" />
      <Handle id="bottom-source" type="source" position={Position.Bottom} className="dfd-handle" />
    </div>
  );
}

function TrustBoundaryNode({ data, selected, width, height }: NodeProps<DfdNode>) {
  const resolvedWidth = width ?? DEFAULT_SIZES.trustBoundary.width;
  const resolvedHeight = height ?? DEFAULT_SIZES.trustBoundary.height;
  const rotate = data.rotate ?? TRUST_BOUNDARY_DEFAULTS.rotate;
  const curve = data.curve ?? TRUST_BOUNDARY_DEFAULTS.curve;
  const strokeWidth = data.strokeWidth ?? TRUST_BOUNDARY_DEFAULTS.strokeWidth;
  const dashLength = data.dashLength ?? TRUST_BOUNDARY_DEFAULTS.dashLength;
  const dashGap = data.dashGap ?? TRUST_BOUNDARY_DEFAULTS.dashGap;
  const topCurve = Math.max(0.02, 0.14 - curve * 0.12);
  const bottomCurve = Math.min(0.98, 0.86 + curve * 0.12);

  return (
    <div className="trust-boundary-shell" style={{ width: resolvedWidth, height: resolvedHeight }}>
      <div className={`trust-boundary-label ${selected ? "selected" : ""}`}>{data.label}</div>
      {selected && (
        <div className="trust-boundary-actions nodrag nopan">
          <button type="button" onClick={(event) => { event.stopPropagation(); data.nudgeRotate?.(-5); }}>-5deg</button>
          <button type="button" onClick={(event) => { event.stopPropagation(); data.nudgeRotate?.(5); }}>+5deg</button>
          <button type="button" onClick={(event) => { event.stopPropagation(); data.nudgeCurve?.(-0.08); }}>Flatter</button>
          <button type="button" onClick={(event) => { event.stopPropagation(); data.nudgeCurve?.(0.08); }}>More Curve</button>
        </div>
      )}
      <div
        className="trust-boundary-curve"
        style={{
          width: resolvedWidth,
          height: resolvedHeight,
          transform: `rotate(${rotate}deg)`,
        }}
      >
        <svg width={resolvedWidth} height={resolvedHeight} viewBox={`0 0 ${resolvedWidth} ${resolvedHeight}`} preserveAspectRatio="none">
          <path
            d={`M 20 ${resolvedHeight / 2}
              C ${resolvedWidth * 0.22} ${resolvedHeight * topCurve},
                ${resolvedWidth * 0.55} ${resolvedHeight * bottomCurve},
                ${resolvedWidth - 20} ${resolvedHeight / 2}`}
            fill="none"
            stroke="#111827"
            strokeWidth={strokeWidth}
            strokeDasharray={`${dashLength} ${dashGap}`}
            strokeLinecap="round"
          />
        </svg>
      </div>
      <NodeResizer minWidth={260} minHeight={110} isVisible={selected} lineClassName="trust-resize-line" handleClassName="trust-resize-handle" />
    </div>
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
}: EdgeProps<DfdEdge>) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 18,
    offset: 24,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: selected ? "#0f172a" : "#334155",
          strokeWidth: selected ? 2.6 : 1.8,
        }}
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            className="edge-label"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = {
  actor: DfdActorNode,
  process: DfdProcessNode,
  store: DfdStoreNode,
  trustBoundary: TrustBoundaryNode,
};

const edgeTypes = {
  dfd: DfdEdgeRenderer,
};

function PaletteItem({ kind, title, hint }: { kind: DfdKind; title: string; hint: string }) {
  const handleDragStart = (event: React.DragEvent<HTMLButtonElement>) => {
    event.dataTransfer.setData("application/digaramme-dfd", kind);
    event.dataTransfer.effectAllowed = "move";
  };

  return (
    <button className={`palette-card ${kind}`} draggable onDragStart={handleDragStart} type="button">
      <span className="palette-title">{title}</span>
      <span className="palette-hint">{hint}</span>
    </button>
  );
}

function buildNode(kind: DfdKind, position: { x: number; y: number }): DfdNode {
  const labelMap: Record<DfdKind, string> = {
    actor: "New Actor",
    process: "New Process",
    store: "New Store",
    trustBoundary: "Trust Zone",
  };

  const size = DEFAULT_SIZES[kind];

  return {
    id: makeId(kind),
    type: kind,
    position,
    data: {
      label: labelMap[kind],
      kind,
      rotate: kind === "trustBoundary" ? TRUST_BOUNDARY_DEFAULTS.rotate : undefined,
      curve: kind === "trustBoundary" ? TRUST_BOUNDARY_DEFAULTS.curve : undefined,
      strokeWidth: kind === "trustBoundary" ? TRUST_BOUNDARY_DEFAULTS.strokeWidth : undefined,
      dashLength: kind === "trustBoundary" ? TRUST_BOUNDARY_DEFAULTS.dashLength : undefined,
      dashGap: kind === "trustBoundary" ? TRUST_BOUNDARY_DEFAULTS.dashGap : undefined,
    },
    style: {
      width: size.width,
      height: size.height,
    },
    zIndex: kind === "trustBoundary" ? -1 : 10,
  };
}

function FlowEditor() {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { screenToFlowPosition, fitView } = useReactFlow<DfdNode, DfdEdge>();

  const [nodes, setNodes, rawOnNodesChange] = useNodesState<DfdNode>([]);
  const [edges, setEdges, rawOnEdgesChange] = useEdgesState<DfdEdge>(SAMPLE_EDGES);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [status, setStatus] = useState("Ready");

  const enrichNodes = useCallback((sourceNodes: DfdNode[]) => {
    return sourceNodes.map((node) => {
      if (node.type !== "trustBoundary") return node;

      return {
        ...node,
        data: {
          ...node.data,
          rotate: node.data.rotate ?? TRUST_BOUNDARY_DEFAULTS.rotate,
          curve: node.data.curve ?? TRUST_BOUNDARY_DEFAULTS.curve,
          strokeWidth: node.data.strokeWidth ?? TRUST_BOUNDARY_DEFAULTS.strokeWidth,
          dashLength: node.data.dashLength ?? TRUST_BOUNDARY_DEFAULTS.dashLength,
          dashGap: node.data.dashGap ?? TRUST_BOUNDARY_DEFAULTS.dashGap,
          nudgeRotate: (delta: number) => {
            setNodes((current) =>
              enrichNodes(
                current.map((currentNode) =>
                  currentNode.id === node.id
                    ? {
                        ...currentNode,
                        data: {
                          ...currentNode.data,
                          rotate: Math.max(-180, Math.min(180, (currentNode.data.rotate ?? 0) + delta)),
                        },
                      }
                    : currentNode
                )
              )
            );
          },
          nudgeCurve: (delta: number) => {
            setNodes((current) =>
              enrichNodes(
                current.map((currentNode) =>
                  currentNode.id === node.id
                    ? {
                        ...currentNode,
                        data: {
                          ...currentNode.data,
                          curve: Math.max(0, Math.min(1, (currentNode.data.curve ?? 0.5) + delta)),
                        },
                      }
                    : currentNode
                )
              )
            );
          },
        },
      };
    });
  }, [setNodes]);

  useEffect(() => {
    setNodes(enrichNodes(SAMPLE_NODES));
  }, [enrichNodes, setNodes]);

  const selectedNode = useMemo(() => nodes.find((node) => node.id === selectedNodeId) ?? null, [nodes, selectedNodeId]);
  const selectedEdge = useMemo(() => edges.find((edge) => edge.id === selectedEdgeId) ?? null, [edges, selectedEdgeId]);

  const onNodesChange = useCallback(
    (changes: NodeChange<DfdNode>[]) => {
      rawOnNodesChange(changes);
      if (changes.some((change) => change.type !== "select")) {
        setStatus("Canvas updated");
      }
    },
    [rawOnNodesChange]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<DfdEdge>[]) => {
      rawOnEdgesChange(changes);
      if (changes.some((change) => change.type !== "select")) {
        setStatus("Flows updated");
      }
    },
    [rawOnEdgesChange]
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((current) =>
        addEdge(
          {
            ...connection,
            id: makeId("flow"),
            type: "dfd",
            animated: true,
            label: "Data Flow",
            markerEnd: { type: MarkerType.ArrowClosed, width: 22, height: 22, color: "#334155" },
          },
          current
        )
      );
      setStatus("New data flow added");
    },
    [setEdges]
  );

  const placeNode = useCallback(
    (kind: DfdKind) => {
      const bounds = wrapperRef.current?.getBoundingClientRect();
      const position = screenToFlowPosition(
        bounds
          ? {
              x: bounds.left + bounds.width / 2,
              y: bounds.top + bounds.height / 2,
            }
          : {
              x: window.innerWidth * 0.5,
              y: window.innerHeight * 0.42,
            }
      );
      const node = buildNode(kind, position);
      setNodes((current) => enrichNodes([...current, node]).sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0)));
      setSelectedNodeId(node.id);
      setSelectedEdgeId(null);
      setStatus(`${node.data.label} added`);
    },
    [enrichNodes, screenToFlowPosition, setNodes]
  );

  const onDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const kind = event.dataTransfer.getData("application/digaramme-dfd") as DfdKind;
      if (!kind) return;

      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const node = buildNode(kind, position);
      setNodes((current) => enrichNodes([...current, node]).sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0)));
      setSelectedNodeId(node.id);
      setSelectedEdgeId(null);
      setStatus(`${node.data.label} dropped on canvas`);
    },
    [enrichNodes, screenToFlowPosition, setNodes]
  );

  const resetDiagram = () => {
    setNodes(enrichNodes(SAMPLE_NODES));
    setEdges(SAMPLE_EDGES);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setStatus("Sample diagram restored");
    requestAnimationFrame(() => fitView({ duration: 500, padding: 0.2 }));
  };

  const exportJson = () => {
    const payload = exportStructuredDiagram(nodes, edges);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    downloadBlob(blob, "diagramme-dfd.json");
    setStatus("JSON exported");
  };

  const importJson = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(String(reader.result)) as Partial<StructuredDiagramFile>;
        if (
          !Array.isArray(raw.boundaries) ||
          !Array.isArray(raw.external_entities) ||
          !Array.isArray(raw.processes) ||
          !Array.isArray(raw.data_stores) ||
          !Array.isArray(raw.data_flows)
        ) {
          throw new Error("Invalid structure");
        }
        const imported = importStructuredDiagram(raw as StructuredDiagramFile);
        setNodes(enrichNodes(imported.nodes));
        setEdges(imported.edges);
        setSelectedNodeId(null);
        setSelectedEdgeId(null);
        setStatus(`${file.name} imported`);
        requestAnimationFrame(() => fitView({ duration: 500, padding: 0.2 }));
      } catch {
        setStatus("Import failed: invalid JSON");
        alert("Invalid DFD JSON file.");
      } finally {
        event.target.value = "";
      }
    };
    reader.readAsText(file);
  };

  const exportPng = async () => {
    const viewportElement = wrapperRef.current?.querySelector(".react-flow__viewport") as HTMLElement | null;
    if (!viewportElement || nodes.length === 0) {
      alert("Nothing to export yet.");
      return;
    }

    const bounds = getNodesBounds(nodes);
    const exportWidth = Math.max(1600, Math.ceil(bounds.width + 220));
    const exportHeight = Math.max(900, Math.ceil(bounds.height + 220));
    const viewport = getViewportForBounds(bounds, exportWidth, exportHeight, 0.15, 2.5, 0.25);

    try {
      const dataUrl = await toPng(viewportElement, {
        backgroundColor: "rgba(0,0,0,0)",
        cacheBust: true,
        pixelRatio: 4,
        width: exportWidth,
        height: exportHeight,
        style: {
          width: `${exportWidth}px`,
          height: `${exportHeight}px`,
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
          transformOrigin: "0 0",
        },
      });

      const link = document.createElement("a");
      link.href = dataUrl;
      link.download = "diagramme-dfd-transparent.png";
      link.click();
      setStatus("Transparent PNG exported");
    } catch {
      setStatus("PNG export failed");
      alert("Unable to export PNG.");
    }
  };

  const deleteSelection = useCallback(() => {
    if (selectedNodeId) {
      setNodes((current) => current.filter((node) => node.id !== selectedNodeId));
      setEdges((current) => current.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId));
      setSelectedNodeId(null);
      setStatus("Node deleted");
      return;
    }

    if (selectedEdgeId) {
      setEdges((current) => current.filter((edge) => edge.id !== selectedEdgeId));
      setSelectedEdgeId(null);
      setStatus("Flow deleted");
    }
  }, [selectedEdgeId, selectedNodeId, setEdges, setNodes]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      deleteSelection();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleteSelection]);

  const updateNode = <K extends keyof DfdNodeData>(key: K, value: DfdNodeData[K]) => {
    if (!selectedNode) return;
    setNodes((current) =>
      enrichNodes(
        current.map((node) =>
          node.id === selectedNode.id
            ? {
                ...node,
                data: {
                  ...node.data,
                  [key]: value,
                },
              }
            : node
        )
      )
    );
  };

  const updateTrustSize = (dimension: "width" | "height", value: number) => {
    if (!selectedNode) return;
    setNodes((current) =>
      enrichNodes(
        current.map((node) =>
          node.id === selectedNode.id
            ? {
                ...node,
                style: {
                  ...node.style,
                  [dimension]: value,
                },
              }
            : node
        )
      )
    );
  };

  const updateNodePosition = (dimension: "x" | "y", value: number) => {
    if (!selectedNode) return;
    setNodes((current) =>
      enrichNodes(
        current.map((node) =>
          node.id === selectedNode.id
            ? {
                ...node,
                position: {
                  ...node.position,
                  [dimension]: value,
                },
              }
            : node
        )
      )
    );
  };

  const updateEdgeLabel = (value: string) => {
    if (!selectedEdge) return;
    setEdges((current) => current.map((edge) => (edge.id === selectedEdge.id ? { ...edge, label: value } : edge)));
  };

  return (
    <div className="dfd-studio">
      <aside className="left-rail">
        <div className="panel-head">
          <p className="eyebrow">DFD Builder</p>
          <h1>Digaramme DFD</h1>
          <p className="panel-copy">
            Interface concentree uniquement sur les diagrammes DFD, avec import/export JSON et PNG transparent.
          </p>
        </div>

        <section className="panel-section">
          <div className="section-title-row">
            <h2>Palette</h2>
            <span>Drag & drop</span>
          </div>
          <div className="palette-grid">
            <PaletteItem kind="actor" title="Actor" hint="Entite externe" />
            <PaletteItem kind="process" title="Process" hint="Traitement" />
            <PaletteItem kind="store" title="Store" hint="Base ou stockage" />
            <PaletteItem kind="trustBoundary" title="Trust Zone" hint="Frontiere pointillee" />
          </div>
        </section>

        <section className="panel-section">
          <div className="section-title-row">
            <h2>Quick Add</h2>
            <span>Centre canvas</span>
          </div>
          <div className="button-grid">
            <button type="button" onClick={() => placeNode("actor")}>+ Actor</button>
            <button type="button" onClick={() => placeNode("process")}>+ Process</button>
            <button type="button" onClick={() => placeNode("store")}>+ Store</button>
            <button type="button" onClick={() => placeNode("trustBoundary")}>+ Trust Zone</button>
          </div>
        </section>

        <section className="panel-section">
          <div className="section-title-row">
            <h2>File</h2>
            <span>OWASP-style workflow</span>
          </div>
          <div className="action-stack">
            <button type="button" className="action-button primary" onClick={exportJson}>Export JSON</button>
            <button type="button" className="action-button secondary" onClick={() => fileInputRef.current?.click()}>
              Import JSON
            </button>
            <button type="button" className="action-button secondary" onClick={exportPng}>
              Export PNG Transparent
            </button>
            <button type="button" className="action-button ghost" onClick={resetDiagram}>Reset Sample</button>
            <input ref={fileInputRef} type="file" accept="application/json" hidden onChange={importJson} />
          </div>
        </section>

        <div className="status-card">
          <span className="status-dot" />
          <div>
            <strong>Status</strong>
            <p>{status}</p>
          </div>
        </div>
      </aside>

      <main className="main-stage">
        <div className="top-strip">
          <div>
            <strong>Focused DFD Editor</strong>
            <p>Renomme acteurs, process, stores et fleches, puis exporte ton diagramme.</p>
          </div>
          <div className="top-strip-actions">
            <button type="button" onClick={() => fitView({ duration: 500, padding: 0.2 })}>Fit View</button>
            <button type="button" onClick={deleteSelection} disabled={!selectedNode && !selectedEdge}>Delete Selection</button>
          </div>
        </div>

        <div className="canvas-shell" ref={wrapperRef} onDrop={onDrop} onDragOver={onDragOver}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
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
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{
              type: "dfd",
              markerEnd: { type: MarkerType.ArrowClosed, width: 22, height: 22, color: "#334155" },
            }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="#d5d9e3" />
            <MiniMap
              pannable
              zoomable
              nodeColor={(node) => NODE_COLORS[(node.type as DfdKind) ?? "process"]}
              className="dfd-minimap"
            />
            <Controls className="dfd-controls" />
          </ReactFlow>
        </div>
      </main>

      <aside className="right-rail">
        <div className="panel-head">
          <p className="eyebrow">Inspector</p>
          <h2>{selectedNode ? "Node Properties" : selectedEdge ? "Flow Properties" : "Nothing selected"}</h2>
          <p className="panel-copy">
            {selectedNode
              ? "Modifie le texte, le type ou la trust zone."
              : selectedEdge
                ? "Renomme la fleche de donnees."
                : "Clique sur un element du diagramme pour l'editer."}
          </p>
        </div>

        {selectedNode && (
          <div className="inspector-form">
            <label>
              Label
              <input
                value={selectedNode.data.label}
                onChange={(event) => updateNode("label", event.target.value)}
                placeholder="Node label"
              />
            </label>

            <label>
              Type
              <select
                value={selectedNode.type}
                onChange={(event) => {
                  const nextType = event.target.value as DfdKind;
                  setNodes((current) =>
                    enrichNodes(
                      current.map((node) =>
                        node.id === selectedNode.id
                          ? {
                              ...node,
                              type: nextType,
                              zIndex: nextType === "trustBoundary" ? -1 : 10,
                              data: {
                                ...node.data,
                                kind: nextType,
                                rotate: nextType === "trustBoundary" ? node.data.rotate ?? TRUST_BOUNDARY_DEFAULTS.rotate : undefined,
                                curve: nextType === "trustBoundary" ? node.data.curve ?? TRUST_BOUNDARY_DEFAULTS.curve : undefined,
                                strokeWidth: nextType === "trustBoundary" ? node.data.strokeWidth ?? TRUST_BOUNDARY_DEFAULTS.strokeWidth : undefined,
                                dashLength: nextType === "trustBoundary" ? node.data.dashLength ?? TRUST_BOUNDARY_DEFAULTS.dashLength : undefined,
                                dashGap: nextType === "trustBoundary" ? node.data.dashGap ?? TRUST_BOUNDARY_DEFAULTS.dashGap : undefined,
                              },
                              style: {
                                ...node.style,
                                width: DEFAULT_SIZES[nextType].width,
                                height: DEFAULT_SIZES[nextType].height,
                              },
                            }
                          : node
                      )
                    )
                  );
                }}
              >
                <option value="actor">Actor</option>
                <option value="process">Process</option>
                <option value="store">Store</option>
                <option value="trustBoundary">Trust Boundary</option>
              </select>
            </label>

            <div className="inspector-grid">
              <label>
                X
                <input
                  type="number"
                  value={Math.round(selectedNode.position.x)}
                  onChange={(event) => updateNodePosition("x", Number(event.target.value))}
                />
              </label>
              <label>
                Y
                <input
                  type="number"
                  value={Math.round(selectedNode.position.y)}
                  onChange={(event) => updateNodePosition("y", Number(event.target.value))}
                />
              </label>
            </div>

            {selectedNode.type === "trustBoundary" && (
              <>
                <div className="inspector-grid">
                  <label>
                    Width
                    <input
                      type="number"
                      min={260}
                      max={1400}
                      value={Math.round(Number(selectedNode.style?.width ?? DEFAULT_SIZES.trustBoundary.width))}
                      onChange={(event) => updateTrustSize("width", Number(event.target.value))}
                    />
                  </label>
                  <label>
                    Height
                    <input
                      type="number"
                      min={110}
                      max={700}
                      value={Math.round(Number(selectedNode.style?.height ?? DEFAULT_SIZES.trustBoundary.height))}
                      onChange={(event) => updateTrustSize("height", Number(event.target.value))}
                    />
                  </label>
                </div>

                <label>
                  Rotation
                  <input
                    type="range"
                    min={-180}
                    max={180}
                    value={selectedNode.data.rotate ?? 0}
                    onChange={(event) => updateNode("rotate", Number(event.target.value))}
                  />
                </label>

                <label>
                  Curvature
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={selectedNode.data.curve ?? 0.5}
                    onChange={(event) => updateNode("curve", Number(event.target.value))}
                  />
                </label>

                <div className="inspector-grid">
                  <label>
                    Stroke
                    <input
                      type="number"
                      min={1}
                      max={16}
                      value={selectedNode.data.strokeWidth ?? 5}
                      onChange={(event) => updateNode("strokeWidth", Number(event.target.value))}
                    />
                  </label>
                  <label>
                    Dash
                    <input
                      type="number"
                      min={4}
                      max={40}
                      value={selectedNode.data.dashLength ?? 14}
                      onChange={(event) => updateNode("dashLength", Number(event.target.value))}
                    />
                  </label>
                </div>

                <label>
                  Gap
                  <input
                    type="number"
                    min={2}
                    max={32}
                    value={selectedNode.data.dashGap ?? 12}
                    onChange={(event) => updateNode("dashGap", Number(event.target.value))}
                  />
                </label>
              </>
            )}

            <button type="button" className="danger-button" onClick={deleteSelection}>Delete Node</button>
          </div>
        )}

        {selectedEdge && (
          <div className="inspector-form">
            <label>
              Flow Label
              <input
                value={String(selectedEdge.label ?? "")}
                onChange={(event) => updateEdgeLabel(event.target.value)}
                placeholder="Data Flow"
              />
            </label>
            <button type="button" className="danger-button" onClick={deleteSelection}>Delete Flow</button>
          </div>
        )}

        {!selectedNode && !selectedEdge && (
          <div className="empty-inspector">
            <p>Conseils rapides</p>
            <ul>
              <li>Glisse un type depuis la palette vers le canvas.</li>
              <li>Connecte deux elements pour creer une fleche DFD.</li>
              <li>Selectionne un element pour modifier son nom.</li>
              <li>Utilise Export JSON pour recharger plus tard le diagramme.</li>
            </ul>
          </div>
        )}
      </aside>
    </div>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <FlowEditor />
    </ReactFlowProvider>
  );
}
