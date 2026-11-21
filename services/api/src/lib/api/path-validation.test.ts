import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isConnectedPath } from './path-validation';

test('saved paths use only nodes in one graph and follow directed edges', () => {
  const nodes = new Set(['entrance', 'junction', 'room']);
  const edges = [
    { fromNodeId: 'entrance', toNodeId: 'junction', bidirectional: true },
    { fromNodeId: 'junction', toNodeId: 'room', bidirectional: false },
  ];
  assert.equal(isConnectedPath(['entrance', 'junction', 'room'], nodes, edges), true);
  assert.equal(isConnectedPath(['junction', 'entrance'], nodes, edges), true);
  assert.equal(isConnectedPath(['room', 'junction'], nodes, edges), false);
  assert.equal(isConnectedPath(['entrance', 'room'], nodes, edges), false);
  assert.equal(isConnectedPath(['entrance', 'other'], nodes, edges), false);
  assert.equal(isConnectedPath(['entrance'], nodes, edges), false);
});
