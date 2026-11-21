type Edge = { fromNodeId: string; toNodeId: string; bidirectional: boolean };

export function isConnectedPath(nodeIds: string[], nodeSet: Set<string>, edges: Edge[]) {
  if (nodeIds.length < 2 || nodeIds.some(id => !nodeSet.has(id))) return false;
  const connections = new Set(edges.map(e => `${e.fromNodeId}:${e.toNodeId}`));
  for (const edge of edges) if (edge.bidirectional) connections.add(`${edge.toNodeId}:${edge.fromNodeId}`);
  for (let i = 1; i < nodeIds.length; i++) {
    if (!connections.has(`${nodeIds[i - 1]}:${nodeIds[i]}`)) return false;
  }
  return true;
}
