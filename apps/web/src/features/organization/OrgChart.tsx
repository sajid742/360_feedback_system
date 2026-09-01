import { useMemo } from 'react';
import dagre from 'dagre';
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Employee } from './api';

const NODE_W = 210;
const NODE_H = 64;

/** Org chart: dagre auto-layout. Solid edges = line management, dashed = matrix
 *  (dotted-line) managers. */
export function OrgChart({ employees }: { employees: Employee[] }): JSX.Element {
  const { nodes, edges } = useMemo(() => buildGraph(employees), [employees]);

  if (employees.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-border bg-muted/40 text-sm text-muted-foreground">
        No employees to chart yet.
      </div>
    );
  }

  return (
    <div className="h-[600px] w-full overflow-hidden rounded-lg border border-border bg-card">
      <ReactFlow nodes={nodes} edges={edges} fitView minZoom={0.2} proOptions={{ hideAttribution: true }}>
        <Background />
        <MiniMap pannable zoomable />
        <Controls />
      </ReactFlow>
    </div>
  );
}

function buildGraph(employees: Employee[]): { nodes: Node[]; edges: Edge[] } {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 70 });

  const ids = new Set(employees.map((e) => e.id));
  employees.forEach((e) => graph.setNode(e.id, { width: NODE_W, height: NODE_H }));

  const edges: Edge[] = [];
  for (const e of employees) {
    if (e.lineManagerId && ids.has(e.lineManagerId)) {
      graph.setEdge(e.lineManagerId, e.id);
      edges.push({ id: `l-${e.id}`, source: e.lineManagerId, target: e.id });
    }
    for (const m of e.matrixManagers) {
      if (ids.has(m.id)) {
        edges.push({
          id: `m-${m.id}-${e.id}`,
          source: m.id,
          target: e.id,
          animated: true,
          style: { strokeDasharray: '6 4', stroke: '#46c2cb' },
        });
      }
    }
  }

  dagre.layout(graph);

  const nodes: Node[] = employees.map((e) => {
    const pos = graph.node(e.id) as { x: number; y: number };
    return {
      id: e.id,
      position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
      data: { label: nodeLabel(e) },
      style: {
        width: NODE_W,
        height: NODE_H,
        borderRadius: 10,
        border: '1px solid #e3e6f0',
        background: '#ffffff',
        fontSize: 12,
        padding: 8,
        boxShadow: '0 1px 2px rgba(16,24,40,0.06)',
      },
    };
  });

  return { nodes, edges };
}

function nodeLabel(e: Employee): string {
  const name = e.user.fullName ?? e.user.email;
  const role = e.designation?.name ?? e.employeeCode;
  return `${name}\n${role}`;
}
