import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type Node,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CascadeEdge, CascadeNode, GateFinding, PlanStep } from '../api/types';
import { num } from '../lib/format';

// Graphs draw at 1:1 so the type stays readable. When one is wider than its column it scrolls inside
// its own container, which is what a phone needs. There is no pan or zoom to fight with page scrolling.

function Frame({ width, height, nodes, edges, label, nodeTypes, edgeTypes, center }: {
  width: number;
  height: number;
  nodes: Node[];
  edges: Edge[];
  label: string;
  nodeTypes: NodeTypes;
  edgeTypes?: EdgeTypes;
  /** Start scrolled to the middle, where the root of a tree sits, when the graph is wider than its column. */
  center?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollWidth > el.clientWidth + 1);
    measure();
    if (center) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width, center]);

  return (
    <div className="flow-frame">
      <div className="flow-scroll" ref={ref} role="img" aria-label={label} tabIndex={0}>
        <div className="flow-canvas" style={{ width, height }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            defaultViewport={{ x: 0, y: 0, zoom: 1 }}
            minZoom={1}
            maxZoom={1}
            nodesDraggable={false}
            nodesConnectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            elementsSelectable={false}
            panOnDrag={false}
            panOnScroll={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            preventScrolling={false}
            proOptions={{ hideAttribution: true }}
          />
        </div>
      </div>
      {overflows && <p className="flow-hint">Wider than this screen. Swipe sideways to see all of it.</p>}
    </div>
  );
}

const hidden = { opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0, pointerEvents: 'none' as const };

// ------------------------------------------------------------------ cascade graph

const NODE_W = 190;
const NODE_H = 86;
const GAP_X = 24;
const GAP_Y = 76;
const PAD = 12;

interface TableData extends Record<string, unknown> {
  node: CascadeNode;
}

function TableNode({ data }: NodeProps<Node<TableData>>) {
  const { node } = data;
  const deleted = node.deleted ?? 0;
  const updated = node.updated ?? 0;
  const direct = (node.direct ?? 0) > 0;
  const kind = deleted > 0 ? 'is-deleted' : updated > 0 ? 'is-updated' : 'is-none';
  return (
    <div className={`tnode ${kind}${direct ? ' is-direct' : ''}`}>
      <Handle type="target" position={Position.Top} style={hidden} isConnectable={false} />
      <div className="tnode-name mono">{node.table}</div>
      {deleted > 0 && (
        <div className="tnode-rows mono">
          <strong>{num(deleted)}</strong> deleted
        </div>
      )}
      {updated > 0 && (
        <div className="tnode-rows mono">
          <strong>{num(updated)}</strong> updated
        </div>
      )}
      {deleted === 0 && updated === 0 && <div className="tnode-rows mono">no rows changed</div>}
      <div className="tnode-via">{direct ? 'Named by the plan' : 'Via cascade'}</div>
      <Handle type="source" position={Position.Bottom} style={hidden} isConnectable={false} />
    </div>
  );
}

function FkEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd }: EdgeProps<Edge<{ onDelete?: string; nudge?: number }>>) {
  const [path] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 3 });
  const onDelete = data?.onDelete ?? '';
  const dashed = onDelete !== 'CASCADE';
  // The label sits on the last vertical run, just above the child. Fanned-out edges share the run below the parent.
  const x = targetX + (data?.nudge ?? 0);
  const y = targetY - 20;
  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} style={{ stroke: 'var(--line-2)', strokeWidth: 1.5, strokeDasharray: dashed ? '5 4' : undefined }} />
      <EdgeLabelRenderer>
        <div className={`flow-edge-label${dashed ? ' is-dashed' : ''}`} style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}>
          {onDelete}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

function layoutCascade(tables: CascadeNode[], fks: CascadeEdge[]) {
  const byName = new Map<string, CascadeNode>();
  for (const t of tables) byName.set(t.table, t);
  // An edge can name a table the graph has no row counts for. Draw it rather than drop the edge.
  for (const e of fks) {
    if (!byName.has(e.from)) byName.set(e.from, { table: e.from });
    if (!byName.has(e.to)) byName.set(e.to, { table: e.to });
  }
  const names = [...byName.keys()];
  const links = fks.filter((e) => e.from !== e.to);

  // Longest path from a root, capped so a foreign-key cycle cannot loop forever.
  const layer = new Map(names.map((n) => [n, 0]));
  for (let i = 0; i < names.length; i++) {
    for (const e of links) {
      const next = (layer.get(e.from) ?? 0) + 1;
      if (next < names.length && next > (layer.get(e.to) ?? 0)) layer.set(e.to, next);
    }
  }

  const rows = (n: string) => (byName.get(n)?.deleted ?? 0) + (byName.get(n)?.updated ?? 0);
  const layers: string[][] = [];
  for (const n of names) (layers[layer.get(n) ?? 0] ??= []).push(n);
  layers.forEach((l) => l.sort((a, b) => rows(b) - rows(a)));

  const x = new Map<string, number>();
  const step = NODE_W + GAP_X;
  layers.forEach((l) => {
    if (!l) return;
    const parents = (n: string) => links.filter((e) => e.to === n).map((e) => x.get(e.from)).filter((v): v is number => v !== undefined);
    const want = new Map(l.map((n, i) => {
      const p = parents(n);
      return [n, p.length ? p.reduce((a, b) => a + b, 0) / p.length : i * step] as const;
    }));
    const ordered = [...l].sort((a, b) => (want.get(a) ?? 0) - (want.get(b) ?? 0));
    let cursor = -Infinity;
    const placed = ordered.map((n) => {
      const at = Math.max(want.get(n) ?? 0, cursor + step);
      cursor = at;
      return at;
    });
    const drift = ordered.reduce((sum, n, i) => sum + (placed[i] - (want.get(n) ?? 0)), 0) / ordered.length;
    ordered.forEach((n, i) => x.set(n, placed[i] - drift));
  });

  const values = [...x.values()];
  const minX = Math.min(...values, 0);
  const maxX = Math.max(...values, 0);
  const width = maxX - minX + NODE_W + PAD * 2;
  const height = layers.length * NODE_H + Math.max(0, layers.length - 1) * GAP_Y + PAD * 2;

  const nodes: Node<TableData>[] = names.map((n) => ({
    id: n,
    type: 'table',
    position: { x: (x.get(n) ?? 0) - minX + PAD, y: (layer.get(n) ?? 0) * (NODE_H + GAP_Y) + PAD },
    data: { node: byName.get(n) as CascadeNode },
    width: NODE_W,
    height: NODE_H,
    draggable: false,
    selectable: false,
  }));

  const edges: Edge<{ onDelete?: string; nudge?: number }>[] = links.map((e, i) => {
    // Two parents of one child would stack their labels. Spread them.
    const siblings = links.filter((l) => l.to === e.to);
    const at = siblings.indexOf(e);
    return {
    id: `${e.from}-${e.to}-${i}`,
    source: e.from,
    target: e.to,
    type: 'fk',
    data: { onDelete: e.on_delete, nudge: (at - (siblings.length - 1) / 2) * 76 },
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: 'var(--line-2)' },
    };
  });

  return { nodes, edges, width, height };
}

const cascadeNodeTypes = { table: TableNode } as unknown as NodeTypes;
const cascadeEdgeTypes = { fk: FkEdge } as unknown as EdgeTypes;

export function CascadeGraph({ nodes, edges }: { nodes: CascadeNode[]; edges: CascadeEdge[] }) {
  const layout = useMemo(() => layoutCascade(nodes, edges), [nodes, edges]);
  return (
    <Frame
      width={layout.width}
      height={layout.height}
      nodes={layout.nodes}
      edges={layout.edges}
      nodeTypes={cascadeNodeTypes}
      edgeTypes={cascadeEdgeTypes}
      center
      label={`Cascade graph of ${layout.nodes.length} tables. The per-table list below has the same numbers.`}
    />
  );
}

// ------------------------------------------------------------------ plan graph

const STEP_W = 248;
const STEP_H = 92;
const STEP_GAP = 40;

interface StepData extends Record<string, unknown> {
  n: number;
  risk?: string;
  sql: string;
  findings: number;
}

export const RISK_LABEL: Record<string, string> = {
  read: 'Read',
  reversible_write: 'Reversible write',
  irreversible_write: 'Irreversible write',
};

function StepNode({ data }: NodeProps<Node<StepData>>) {
  return (
    <div className={`snode risk-${data.risk ?? 'unknown'}`}>
      <Handle type="target" position={Position.Left} style={hidden} isConnectable={false} />
      <div className="snode-top">
        <span className="mono snode-n">Step {data.n}</span>
        <span className="snode-risk">{RISK_LABEL[data.risk ?? ''] ?? data.risk ?? 'Risk unknown'}</span>
      </div>
      <div className="snode-sql mono">{data.sql}</div>
      {data.findings > 0 && (
        <div className="snode-findings">
          {data.findings} gate {data.findings === 1 ? 'finding' : 'findings'}
        </div>
      )}
      <Handle type="source" position={Position.Right} style={hidden} isConnectable={false} />
    </div>
  );
}

const planNodeTypes = { step: StepNode } as unknown as NodeTypes;

export function PlanGraph({ steps, risks, findings }: { steps: PlanStep[]; risks: Record<number, string | undefined>; findings: GateFinding[] }) {
  const { nodes, edges, width } = useMemo(() => {
    const nodes: Node<StepData>[] = steps.map((s, i) => ({
      id: String(i + 1),
      type: 'step',
      position: { x: PAD + i * (STEP_W + STEP_GAP), y: PAD },
      data: {
        n: i + 1,
        risk: risks[i + 1],
        sql: (s.cmd ?? s.statements?.[0] ?? '').slice(0, 90),
        findings: findings.filter((f) => f.step === i + 1).length,
      },
      width: STEP_W,
      height: STEP_H,
      draggable: false,
      selectable: false,
    }));
    const edges: Edge[] = steps.slice(1).map((_, i) => ({
      id: `e${i + 1}`,
      source: String(i + 1),
      target: String(i + 2),
      style: { stroke: 'var(--line-2)', strokeWidth: 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: 'var(--line-2)' },
    }));
    return { nodes, edges, width: PAD * 2 + steps.length * STEP_W + Math.max(0, steps.length - 1) * STEP_GAP };
  }, [steps, risks, findings]);

  return <Frame width={width} height={STEP_H + PAD * 2} nodes={nodes} edges={edges} nodeTypes={planNodeTypes} label={`Plan graph of ${steps.length} steps, coloured by risk. The step list below has the same detail.`} />;
}
