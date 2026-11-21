import type { Graph, NavNode, SavedPath } from "./space-api";

const distance = (a: NavNode, b: NavNode) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function indexGraph(graph: Graph) {
  const nodes = new Map(graph.nodes.map(n => [n.id, n]));
  if (nodes.size !== graph.nodes.length || graph.nodes.some(n => n.spaceId !== graph.spaceId || ![n.x, n.y, n.z].every(Number.isFinite))) {
    throw new Error("The navigation graph has invalid nodes or belongs to another space.");
  }
  const adjacent = new Map<string, { to: string; cost: number }[]>(graph.nodes.map(n => [n.id, []]));
  let heuristicScale = Infinity;
  for (const edge of graph.edges) {
    const from = nodes.get(edge.fromNodeId), to = nodes.get(edge.toNodeId);
    if (edge.spaceId !== graph.spaceId || !from || !to || !Number.isFinite(edge.distance) || edge.distance <= 0) {
      throw new Error("The navigation graph has an invalid edge.");
    }
    adjacent.get(from.id)!.push({ to: to.id, cost: edge.distance });
    if (edge.bidirectional) adjacent.get(to.id)!.push({ to: from.id, cost: edge.distance });
    const length = distance(from, to);
    if (length > 0) heuristicScale = Math.min(heuristicScale, edge.distance / length);
  }
  if (graph.destinations.some(d => d.spaceId !== graph.spaceId || !nodes.has(d.nodeId))) throw new Error("A destination is outside this graph.");
  // Scaling by the cheapest cost per geometric unit keeps A* admissible even
  // when legacy edge costs are smaller than the straight-line distance.
  return { nodes, adjacent, heuristicScale: Number.isFinite(heuristicScale) ? heuristicScale : 0 };
}

export interface Route { nodes: NavNode[]; distance: number }

export function validateGraph(graph: Graph): void { indexGraph(graph); }

export function findRoute(graph: Graph, startId: string, endId: string): Route | null {
  const { nodes, adjacent, heuristicScale } = indexGraph(graph);
  const start = nodes.get(startId), end = nodes.get(endId);
  if (!start || !end) throw new Error("Choose start and destination nodes in this space.");
  const open = new Set([startId]);
  const costs = new Map([[startId, 0]]);
  const previous = new Map<string, string>();
  const estimate = (id: string) => costs.get(id)! + heuristicScale * distance(nodes.get(id)!, end);
  while (open.size) {
    let current = open.values().next().value!;
    for (const candidate of open) if (estimate(candidate) < estimate(current)) current = candidate;
    if (current === endId) {
      const ids = [current];
      while (previous.has(ids[0]!)) ids.unshift(previous.get(ids[0]!)!);
      return { nodes: ids.map(id => nodes.get(id)!), distance: costs.get(current)! };
    }
    open.delete(current);
    for (const edge of adjacent.get(current)!) {
      const cost = costs.get(current)! + edge.cost;
      if (cost < (costs.get(edge.to) ?? Infinity)) {
        costs.set(edge.to, cost); previous.set(edge.to, current); open.add(edge.to);
      }
    }
  }
  return null;
}

export function savedRoute(graph: Graph, path: SavedPath): Route {
  const { nodes, adjacent } = indexGraph(graph);
  if (path.spaceId !== graph.spaceId || !path.waypoints || path.waypoints.length < 2) throw new Error("This saved path is not valid in this space.");
  const points = [...path.waypoints].sort((a, b) => a.sequence - b.sequence);
  if (points.some((p, i) => p.sequence !== i || !nodes.has(p.nodeId))) throw new Error("The saved path has missing or invalid waypoints.");
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const matching = adjacent.get(points[i - 1]!.nodeId)!.filter(e => e.to === points[i]!.nodeId);
    if (!matching.length) throw new Error("The saved path no longer follows the graph's allowed edges.");
    total += Math.min(...matching.map(e => e.cost));
  }
  return { nodes: points.map(p => nodes.get(p.nodeId)!), distance: total };
}
