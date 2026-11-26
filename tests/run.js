#!/usr/bin/env node
// Dependency-free tests for Street Go. Run: node tests/run.js
'use strict';

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const { GraphGoEngine, komiForNodeCount, humanColorForMode, isCpuTurn, undoStepsForActors } = require(path.join(ROOT, 'go-engine.js'));
const SGM = require(path.join(ROOT, 'map-graph.js'));

// ---------------------------------------------------------------------------
// Tiny harness
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// Seeded PRNG (mulberry32)
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Grid graph: ids "x,y", 4-neighbourhood
function makeGrid(w, h) {
  const nodes = new Map();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      nodes.set(`${x},${y}`, { id: `${x},${y}`, lat: y, lon: x, neighbors: new Set() });
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const n = nodes.get(`${x},${y}`);
      if (x + 1 < w) { n.neighbors.add(`${x + 1},${y}`); nodes.get(`${x + 1},${y}`).neighbors.add(n.id); }
      if (y + 1 < h) { n.neighbors.add(`${x},${y + 1}`); nodes.get(`${x},${y + 1}`).neighbors.add(n.id); }
    }
  }
  return nodes;
}

function snapshot(e) {
  return JSON.stringify({
    board: e.nodeIds.map((id) => e.board.get(id) || '.').join(''),
    turn: e.turn,
    captures: e.captures,
    seen: Array.from(e.seenStates).sort(),
    passes: e.consecutivePasses,
    lastMove: e.lastMove,
    gameOver: e.gameOver,
    moveCount: e.moveCount,
    historyLength: e.history.length
  });
}

// Play a sequence of [color, id] using passes to fix the colour to move
function setup(engine, moves) {
  for (const [color, id] of moves) {
    if (engine.turn !== color) engine.pass();
    const r = engine.playMove(id);
    assert.ok(r.ok, `setup move ${color} ${id} failed: ${r.reason}`);
  }
}

// Synthetic OSM-like elements: an n x n street grid with spacing ~100 m
function gridElements(n, originLat, originLon, idBase, spacingDeg = 0.0009) {
  const elements = [];
  const nid = (x, y) => idBase + y * n + x;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      elements.push({ type: 'node', id: nid(x, y), lat: originLat + y * spacingDeg, lon: originLon + x * spacingDeg });
    }
  }
  let wid = idBase;
  for (let y = 0; y < n; y++) {
    elements.push({ type: 'way', id: wid++, nodes: Array.from({ length: n }, (_, x) => nid(x, y)) });
  }
  for (let x = 0; x < n; x++) {
    elements.push({ type: 'way', id: wid++, nodes: Array.from({ length: n }, (_, y) => nid(x, y)) });
  }
  return elements;
}

function withFetch(stub, fn) {
  const real = global.fetch;
  global.fetch = stub;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      global.fetch = real;
    });
}

async function localPresetFetcher(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file.split('?')[0]), 'utf8'));
}

function noNetwork() {
  return async (url) => {
    throw new Error(`unexpected network access: ${url}`);
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

async function rejectsKind(promise, kind) {
  try {
    await promise;
  } catch (err) {
    assert.strictEqual(err.kind, kind, `expected kind ${kind}, got ${err.kind}: ${err.message}`);
    return err;
  }
  assert.fail(`expected rejection with kind ${kind}`);
}

// ---------------------------------------------------------------------------
// Go engine

test('capture removes a surrounded stone and counts prisoners', () => {
  const e = new GraphGoEngine(makeGrid(3, 3));
  setup(e, [['W', '0,0'], ['B', '1,0']]);
  if (e.turn !== 'B') e.pass();
  const r = e.playMove('0,1');
  assert.ok(r.ok);
  assert.strictEqual(r.capturedCount, 1);
  assert.deepStrictEqual(r.capturedIds, ['0,0']);
  assert.strictEqual(e.board.get('0,0'), null);
  assert.strictEqual(e.captures.B, 1);
});

test('suicide is illegal and leaves the state untouched', () => {
  const e = new GraphGoEngine(makeGrid(3, 3));
  setup(e, [['B', '1,0'], ['B', '0,1']]);
  if (e.turn !== 'W') e.pass();
  const before = snapshot(e);
  const sim = e.simulateMove('0,0', 'W');
  assert.strictEqual(sim.legal, false);
  assert.strictEqual(sim.reason, 'suicide');
  const r = e.playMove('0,0');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'suicide');
  assert.strictEqual(snapshot(e), before);
});

test('ko: immediate recapture into an earlier position is illegal (superko)', () => {
  // . B W .
  // B W . W
  // . B W .
  const e = new GraphGoEngine(makeGrid(4, 3));
  setup(e, [
    ['B', '1,0'], ['W', '2,0'],
    ['B', '0,1'], ['W', '3,1'],
    ['B', '1,2'], ['W', '2,2'],
    ['W', '1,1']
  ]);
  if (e.turn !== 'B') e.pass();
  const take = e.playMove('2,1');
  assert.ok(take.ok);
  assert.strictEqual(take.capturedCount, 1);
  assert.strictEqual(e.turn, 'W');
  const before = snapshot(e);
  const retake = e.playMove('1,1');
  assert.strictEqual(retake.ok, false);
  assert.strictEqual(retake.reason, 'ko');
  assert.strictEqual(snapshot(e), before);
  // After a move elsewhere and a reply, the position differs, so recapture is allowed
  assert.ok(e.playMove('3,0').ok); // W elsewhere
  assert.ok(e.playMove('0,0').ok); // B elsewhere
  const later = e.playMove('1,1');
  assert.ok(later.ok);
  assert.strictEqual(later.capturedCount, 1);
});

test('two consecutive passes end the game', () => {
  const e = new GraphGoEngine(makeGrid(3, 3));
  assert.ok(e.playMove('1,1').ok);
  assert.strictEqual(e.pass().gameOver, false);
  const r = e.pass();
  assert.ok(r.ok);
  assert.strictEqual(r.gameOver, true);
  assert.strictEqual(e.gameOver, true);
  assert.strictEqual(e.playMove('0,0').reason, 'gameover');
  assert.strictEqual(e.pass().ok, false);
  // a move between passes resets the counter
  const e2 = new GraphGoEngine(makeGrid(3, 3));
  e2.pass();
  e2.playMove('0,0');
  assert.strictEqual(e2.pass().gameOver, false);
});

function randomGameUndoCheck(nodes, seed, steps) {
  const e = new GraphGoEngine(nodes);
  const rand = rng(seed);
  const snaps = [snapshot(e)];
  let played = 0;
  let captures = 0;
  for (let i = 0; i < steps && !e.gameOver; i++) {
    let done = false;
    if (rand() < 0.03) {
      e.pass();
      done = true;
    } else {
      const empties = e.nodeIds.filter((id) => e.board.get(id) === null);
      for (let tries = 0; tries < 30 && !done && empties.length; tries++) {
        const id = empties[Math.floor(rand() * empties.length)];
        const r = e.playMove(id);
        if (r.ok) {
          done = true;
          captures += r.capturedCount;
        }
      }
      if (!done) {
        e.pass();
        done = true;
      }
    }
    played++;
    snaps.push(snapshot(e));
  }
  for (let i = snaps.length - 1; i > 0; i--) {
    assert.strictEqual(snapshot(e), snaps[i], `state mismatch before undo #${snaps.length - i}`);
    assert.ok(e.undo());
  }
  assert.strictEqual(snapshot(e), snaps[0], 'not back to the initial state');
  assert.strictEqual(e.undo(), false);
  return { played, captures };
}

test('undo restores board, prisoners, turn and hash history exactly (random games)', () => {
  let total = 0;
  let caps = 0;
  for (const [w, h, seed] of [[9, 9, 1], [9, 9, 2], [7, 5, 3], [13, 13, 4]]) {
    const r = randomGameUndoCheck(makeGrid(w, h), seed, 400);
    total += r.played;
    caps += r.captures;
  }
  assert.ok(total >= 600, `only ${total} plies played`);
  assert.ok(caps > 0, 'random games should include captures');
});

test('undo also works on a real preset graph', () => {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'presets/kyoto-shijo-karasuma.json'), 'utf8'));
  const g = SGM.buildRoadGraph(data.elements, data.location.lat, data.location.lon, { targetNodes: 81 });
  const r = randomGameUndoCheck(g.nodes, 42, 300);
  assert.ok(r.played > 50);
});

test('simulateMove and chooseCpuMove do not change the state', () => {
  const e = new GraphGoEngine(makeGrid(5, 5));
  setup(e, [['B', '2,2'], ['W', '2,1'], ['B', '1,1'], ['W', '3,2']]);
  const before = snapshot(e);
  for (const id of e.nodeIds) e.simulateMove(id, 'B');
  for (const id of e.nodeIds) e.simulateMove(id, 'W');
  e.chooseCpuMove('W');
  e.chooseCpuMove('B');
  assert.strictEqual(snapshot(e), before);
});

test('komi steps by number of intersections', () => {
  const cases = [[9, 0.5], [19, 0.5], [20, 2.5], [39, 2.5], [40, 4.5], [69, 4.5], [70, 6.5], [450, 6.5]];
  for (const [n, k] of cases) assert.strictEqual(komiForNodeCount(n), k, `N=${n}`);
  assert.strictEqual(new GraphGoEngine(makeGrid(3, 3)).komi, 0.5);
  assert.strictEqual(new GraphGoEngine(makeGrid(5, 5)).komi, 2.5);
  assert.strictEqual(new GraphGoEngine(makeGrid(7, 7)).komi, 4.5);
  const e = new GraphGoEngine(makeGrid(9, 9));
  assert.strictEqual(e.komi, 6.5);
  assert.strictEqual(e.computeScore().komi, 6.5);
  // empty board: white wins by komi only
  const s = new GraphGoEngine(makeGrid(5, 5)).computeScore();
  assert.strictEqual(s.winner, 'W');
  assert.strictEqual(s.margin, 2.5);
});

// ---------------------------------------------------------------------------
// Game modes (CPU colour, whose turn, undo depth)

test('humanColorForMode: cpu = Black, cpu-white = White, pvp / unknown = none', () => {
  assert.strictEqual(humanColorForMode('cpu'), 'B');
  assert.strictEqual(humanColorForMode('cpu-white'), 'W');
  assert.strictEqual(humanColorForMode('pvp'), null);
  assert.strictEqual(humanColorForMode(''), null);
  assert.strictEqual(humanColorForMode(undefined), null);
});

test('isCpuTurn: 3 modes x turn x game over', () => {
  const expected = {
    cpu: { B: false, W: true },
    'cpu-white': { B: true, W: false },
    pvp: { B: false, W: false }
  };
  for (const mode of Object.keys(expected)) {
    for (const turn of ['B', 'W']) {
      assert.strictEqual(isCpuTurn(mode, turn, false), expected[mode][turn], `${mode} ${turn} playing`);
      assert.strictEqual(isCpuTurn(mode, turn, true), false, `${mode} ${turn} game over`);
    }
  }
  assert.strictEqual(isCpuTurn('cpu', null, false), false);
  assert.strictEqual(isCpuTurn('unknown', 'W', false), false);
});

test('isCpuTurn: someone can always move (no deadlock after switching modes)', () => {
  for (const mode of ['cpu', 'cpu-white', 'pvp']) {
    for (const turn of ['B', 'W']) {
      const human = humanColorForMode(mode);
      const humanCanMove = human === null || human === turn;
      assert.ok(humanCanMove !== isCpuTurn(mode, turn, false), `${mode} ${turn}`);
    }
  }
});

test('undoStepsForActors: back to the human\'s last ply; nothing when only the CPU has played', () => {
  const H = 'human';
  const C = 'cpu';
  // empty / missing history
  for (const mode of ['cpu', 'cpu-white', 'pvp']) {
    assert.strictEqual(undoStepsForActors(mode, []), 0, mode);
    assert.strictEqual(undoStepsForActors(mode, null), 0, mode);
  }
  // pvp: always one ply
  assert.strictEqual(undoStepsForActors('pvp', [H]), 1);
  assert.strictEqual(undoStepsForActors('pvp', [H, H]), 1);
  assert.strictEqual(undoStepsForActors('pvp', [C, C]), 1);
  // CPU modes: up to and including the human's latest ply
  for (const mode of ['cpu', 'cpu-white']) {
    assert.strictEqual(undoStepsForActors(mode, [H]), 1, mode);
    assert.strictEqual(undoStepsForActors(mode, [H, C]), 2, mode);
    assert.strictEqual(undoStepsForActors(mode, [C, H, C]), 2, mode);
    assert.strictEqual(undoStepsForActors(mode, [C, H]), 1, mode);
    // only the CPU has played
    assert.strictEqual(undoStepsForActors(mode, [C]), 0, mode);
    assert.strictEqual(undoStepsForActors(mode, [C, C]), 0, mode);
  }
});

test('undoStepsForActors: CPU moves on both sides of a mode switch cannot be undone (review R5)', () => {
  // cpu-white: the CPU plays Black. Switch to cpu: the CPU now plays White too.
  // Nobody at the screen has played, so 待った must do nothing (it used to empty the board).
  const e = new GraphGoEngine(makeGrid(5, 5));
  const actors = [];
  let mode = 'cpu-white';
  assert.ok(isCpuTurn(mode, e.turn, e.gameOver));
  assert.ok(e.playMove(e.chooseCpuMove('B')).ok);
  actors.push('cpu');
  mode = 'cpu';
  assert.ok(isCpuTurn(mode, e.turn, e.gameOver), 'after the switch White belongs to the CPU');
  assert.ok(e.playMove(e.chooseCpuMove('W')).ok);
  actors.push('cpu');
  assert.strictEqual(e.history.length, actors.length);
  assert.strictEqual(undoStepsForActors(mode, actors), 0);
  // The human (Black) is to move, so nobody is stuck
  assert.ok(!isCpuTurn(mode, e.turn, e.gameOver));
  // After the human plays and the CPU replies, 待った takes back exactly those two plies
  assert.ok(e.playMove('0,0').ok);
  actors.push('human');
  assert.ok(e.playMove(e.chooseCpuMove('W')).ok);
  actors.push('cpu');
  assert.strictEqual(undoStepsForActors(mode, actors), 2);
});

test('undoStepsForActors: mode switches mid-game use who actually played', () => {
  const e = new GraphGoEngine(makeGrid(5, 5));
  const actors = [];
  const play = (id, actor) => {
    assert.ok(e.playMove(id).ok, id);
    actors.push(actor);
  };
  // pvp: two humans play B and W
  play('2,2', 'human');
  play('1,1', 'human');
  assert.strictEqual(undoStepsForActors('pvp', actors), 1);
  // switch to cpu (human Black): Black to move; latest human ply is the last one
  assert.strictEqual(undoStepsForActors('cpu', actors), 1);
  play('3,3', 'human'); // B (human)
  play('1,3', 'cpu'); // W (CPU)
  assert.strictEqual(undoStepsForActors('cpu', actors), 2);
  // switch to cpu-white (human White): Black is now the CPU's
  play('3,1', 'cpu'); // B (CPU)
  assert.strictEqual(undoStepsForActors('cpu-white', actors), 3, 'back through the CPU plies to the human B move');
  play('0,2', 'human'); // W (human)
  assert.strictEqual(undoStepsForActors('cpu-white', actors), 1);
  // Undo with the engine keeps both arrays the same length and lands on the human's turn
  const steps = undoStepsForActors('cpu-white', actors);
  for (let i = 0; i < steps; i++) {
    assert.ok(e.undo());
    actors.pop();
  }
  assert.strictEqual(e.history.length, actors.length);
  assert.strictEqual(e.turn, 'W');
  assert.ok(!isCpuTurn('cpu-white', e.turn, e.gameOver));
});

test('undoStepsForActors with the engine: the human is to move afterwards', () => {
  const moves = ['2,2', '1,1', '3,3', '1,3', '3,1', '0,2', '4,2', '2,0'];
  for (const mode of ['cpu', 'cpu-white']) {
    const human = humanColorForMode(mode);
    const e = new GraphGoEngine(makeGrid(5, 5));
    const actors = [];
    const actorOf = (color) => (color === human ? 'human' : 'cpu');
    const play = (id) => {
      const color = e.turn;
      assert.ok(e.playMove(id).ok);
      actors.push(actorOf(color));
    };
    const pass = () => {
      const color = e.turn;
      assert.ok(e.pass().ok);
      actors.push(actorOf(color));
    };
    const snaps = [snapshot(e)]; // snaps[k] = state after k plies
    for (const id of moves) {
      play(id);
      snaps.push(snapshot(e));
      if (e.turn !== human) continue;
      // Human to move after the CPU's reply: undo must land on the previous human turn
      const steps = undoStepsForActors(mode, actors);
      const plies = e.history.length;
      if (plies === 1) {
        assert.strictEqual(mode, 'cpu-white');
        assert.strictEqual(steps, 0, 'only the CPU first move: nothing to undo');
        continue;
      }
      assert.strictEqual(steps, 2, `${mode} after ${plies} plies`);
      for (let i = 0; i < steps; i++) {
        assert.ok(e.undo());
        actors.pop();
      }
      assert.strictEqual(e.turn, human);
      assert.ok(!isCpuTurn(mode, e.turn, e.gameOver));
      assert.strictEqual(snapshot(e), snaps[plies - 2]);
      // replay the two plies to continue the sequence
      play(moves[plies - 2]);
      play(moves[plies - 1]);
      assert.strictEqual(snapshot(e), snaps[plies]);
    }
    // Human passes, CPU passes: game over; undo reopens the game on the human's turn
    if (e.turn !== human) play('4,4');
    pass();
    pass();
    assert.ok(e.gameOver);
    assert.ok(!isCpuTurn(mode, e.turn, e.gameOver));
    const steps = undoStepsForActors(mode, actors);
    assert.strictEqual(steps, 2);
    for (let i = 0; i < steps; i++) {
      e.undo();
      actors.pop();
    }
    assert.strictEqual(e.gameOver, false);
    assert.strictEqual(e.turn, human);
    assert.strictEqual(e.history.length, actors.length);
  }
});

// ---------------------------------------------------------------------------
// Map graph

test('pruneToLargestComponent drops isolated points and small islands', () => {
  const nodes = new Map();
  const add = (id) => nodes.set(id, { id, lat: 0, lon: 0, neighbors: new Set() });
  const link = (a, b) => { nodes.get(a).neighbors.add(b); nodes.get(b).neighbors.add(a); };
  ['a', 'b', 'c', 'd', 'e', 'x', 'y', 'z', 'lonely'].forEach(add);
  link('a', 'b'); link('b', 'c'); link('c', 'd'); link('d', 'e'); link('e', 'a');
  link('x', 'y'); link('y', 'z');
  const edges = [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e'], ['e', 'a'], ['x', 'y'], ['y', 'z']].map(([u, v]) => ({ u, v }));
  const out = SGM.pruneToLargestComponent(nodes, edges);
  assert.deepStrictEqual(Array.from(out.nodes.keys()).sort(), ['a', 'b', 'c', 'd', 'e']);
  assert.strictEqual(out.edges.length, 5);
  for (const n of out.nodes.values()) {
    for (const nb of n.neighbors) assert.ok(out.nodes.has(nb));
    assert.ok(n.neighbors.size > 0);
  }
  // input is not mutated
  assert.ok(nodes.has('lonely'));
  // nothing connected at all
  const lone = new Map([['q', { id: 'q', neighbors: new Set() }]]);
  assert.strictEqual(SGM.pruneToLargestComponent(lone, []).nodes.size, 0);
});

test('buildRoadGraph keeps only the largest connected component', () => {
  // Main 6x6 grid plus a separate 3x3 island ~500 m away, both inside the drawn bounds.
  // Grid corners have degree 2 and are contracted, so the main grid yields 32 points
  // and the island 5.
  const els = gridElements(6, 35.0, 135.0, 1000).concat(gridElements(3, 35.0, 135.009, 5000));
  const bounds = { south: 34.999, north: 35.006, west: 134.999, east: 135.012 };
  const g = SGM.buildRoadGraph(els, 35.003, 135.006, { targetNodes: 81, mergeRadiusMeters: 5, bounds });
  assert.strictEqual(g.stats.nodeCount, 32);
  for (const n of g.nodes.values()) assert.ok(n.lon < 135.006, 'island node kept');
  // connected: BFS reaches everything
  const start = g.nodes.keys().next().value;
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    for (const nb of g.nodes.get(stack.pop()).neighbors) {
      if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
    }
  }
  assert.strictEqual(seen.size, g.nodes.size);
  for (const n of g.nodes.values()) assert.ok(n.neighbors.size > 0);
});

test('assertPlayableBoard rejects fewer than 9 and more than 450 points', () => {
  assert.throws(() => SGM.assertPlayableBoard(8), (err) => err.kind === 'too-few' && /交点が少なすぎます/.test(err.message));
  assert.throws(() => SGM.assertPlayableBoard(0), (err) => err.kind === 'too-few');
  SGM.assertPlayableBoard(9);
  SGM.assertPlayableBoard(450);
  assert.throws(() => SGM.assertPlayableBoard(451), (err) => err.kind === 'too-many' && err.message.includes('(451点)'));
});

test('a drawn square with fewer than 9 points is rejected without network access', async () => {
  SGM.clearCaches();
  // 2x2 grid = 4 junctions
  SGM.seedRoadCache(35.0, 135.0, 1000, gridElements(2, 35.0, 135.0, 1), false);
  const bounds = { south: 34.999, north: 35.002, west: 134.999, east: 135.002 };
  await withFetch(noNetwork(), () =>
    rejectsKind(SGM.generateStreetGoBoardInBounds(bounds, { targetNodes: 81, mergeRadiusMeters: 5 }), 'too-few')
  );
  // 4x4 grid = 12 junctions (corners are contracted) -> accepted
  SGM.clearCaches();
  SGM.seedRoadCache(35.0, 135.0, 1000, gridElements(4, 35.0, 135.0, 1), false);
  const b2 = { south: 34.999, north: 35.004, west: 134.999, east: 135.004 };
  const ok = await withFetch(noNetwork(), () => SGM.generateStreetGoBoardInBounds(b2, { targetNodes: 81, mergeRadiusMeters: 5 }));
  assert.strictEqual(ok.stats.nodeCount, 12);
  SGM.clearCaches();
});

test('offline mode never touches the network', async () => {
  SGM.clearCaches();
  await withFetch(noNetwork(), async () => {
    await rejectsKind(SGM.fetchOverpassRoads(35, 135, 300, { allowNetwork: false }), 'offline');
    await rejectsKind(SGM.geocodePlace('どこか', { allowNetwork: false }), 'offline');
  });
});

test('validateOverpassJson: remark/empty, bad coordinates and huge responses', () => {
  assert.throws(() => SGM.validateOverpassJson({ remark: 'runtime error: timeout', elements: [] }), (e) => e.kind === 'incomplete');
  assert.throws(() => SGM.validateOverpassJson({ elements: [{ type: 'node', id: 1, lat: NaN, lon: 1 }] }), (e) => e.kind === 'incomplete');
  assert.throws(() => SGM.validateOverpassJson({ elements: [{ type: 'node', id: 1, lat: 1 }] }), (e) => e.kind === 'incomplete');
  assert.throws(() => SGM.validateOverpassJson(null), (e) => e.kind === 'incomplete');
  const huge = { elements: new Array(SGM.MAX_OVERPASS_ELEMENTS + 1).fill({ type: 'way', id: 1, nodes: [] }) };
  assert.throws(() => SGM.validateOverpassJson(huge), (e) => e.kind === 'too-many');
  assert.strictEqual(SGM.validateOverpassJson({ elements: [] }).cacheable, true);
  assert.strictEqual(SGM.validateOverpassJson({ remark: 'partial', elements: [{ type: 'way', id: 1, nodes: [] }] }).cacheable, false);
});

test('Overpass endpoints: only the two allowed servers', () => {
  assert.deepStrictEqual(SGM.OVERPASS_ENDPOINTS, [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter'
  ]);
});

test('Overpass 429 / 504 stop immediately (no hammering of the next server)', async () => {
  for (const status of [429, 504]) {
    SGM.clearCaches();
    let calls = 0;
    await withFetch(async () => { calls++; return jsonResponse(status, {}); }, () =>
      rejectsKind(SGM.fetchOverpassRoads(35, 135, 300), 'busy')
    );
    assert.strictEqual(calls, 1, `HTTP ${status} should not try another endpoint`);
  }
});

test('Overpass network failure / 5xx switch to the next endpoint', async () => {
  SGM.clearCaches();
  const urls = [];
  const els = gridElements(3, 35, 135, 1);
  const got = await withFetch(async (url) => {
    urls.push(url);
    if (urls.length === 1) return jsonResponse(502, {});
    return jsonResponse(200, { elements: els });
  }, () => SGM.fetchOverpassRoads(35, 135, 300));
  assert.strictEqual(got.length, els.length);
  assert.deepStrictEqual(urls, SGM.OVERPASS_ENDPOINTS);

  SGM.clearCaches();
  let calls = 0;
  const err = await withFetch(async () => { calls++; throw new TypeError('Failed to fetch'); }, () =>
    rejectsKind(SGM.fetchOverpassRoads(35, 135, 300), 'network')
  );
  assert.strictEqual(calls, 2);
  assert.ok(/通信エラー/.test(err.message));

  // other 4xx: no retry on the other server
  SGM.clearCaches();
  calls = 0;
  await withFetch(async () => { calls++; return jsonResponse(400, {}); }, () =>
    rejectsKind(SGM.fetchOverpassRoads(35, 135, 300), 'network')
  );
  assert.strictEqual(calls, 1);
});

test('incomplete Overpass responses are not cached; good ones are', async () => {
  SGM.clearCaches();
  let calls = 0;
  const stub = async () => { calls++; return jsonResponse(200, { remark: 'runtime error', elements: [] }); };
  await withFetch(stub, async () => {
    await rejectsKind(SGM.fetchOverpassRoads(35, 135, 300), 'incomplete');
    await rejectsKind(SGM.fetchOverpassRoads(35, 135, 300), 'incomplete');
  });
  assert.strictEqual(calls, 2);
  assert.strictEqual(SGM.findCachedRoads(35, 135, 300), null);

  calls = 0;
  const els = gridElements(3, 35, 135, 1);
  await withFetch(async () => { calls++; return jsonResponse(200, { elements: els }); }, async () => {
    await SGM.fetchOverpassRoads(35, 135, 300);
    await SGM.fetchOverpassRoads(35, 135, 200); // covered by cache
  });
  assert.strictEqual(calls, 1);
  SGM.clearCaches();
});

test('cancel (AbortController) interrupts a pending Overpass request', async () => {
  SGM.clearCaches();
  const controller = new AbortController();
  const stub = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const p = withFetch(stub, () => rejectsKind(SGM.fetchOverpassRoads(35, 135, 300, { signal: controller.signal }), 'aborted'));
  setTimeout(() => controller.abort(), 20);
  await p;
});

test('Nominatim requests are spaced at least 1.1 s apart', async () => {
  SGM.clearCaches();
  const starts = [];
  await withFetch(async () => {
    starts.push(Date.now());
    return jsonResponse(200, [{ lat: '35.0', lon: '135.0', display_name: 'x' }]);
  }, async () => {
    await SGM.geocodePlace('テスト地点A');
    await SGM.geocodePlace('テスト地点B');
    await SGM.geocodePlace('テスト地点A'); // cached, no request
  });
  assert.strictEqual(starts.length, 2);
  assert.ok(starts[1] - starts[0] >= 1090, `gap was ${starts[1] - starts[0]} ms`);
  SGM.clearCaches();
});

// ---------------------------------------------------------------------------
// Bundled presets

// Build a node map + edge list from [id, x(m), y(m)] points and [u, v] pairs (straight edges)
function planarGraph(points, links) {
  const nodes = new Map();
  for (const [id, x, y] of points) {
    nodes.set(id, { id, lat: 35 + y / 110540, lon: 135 + x / (111320 * Math.cos((35 * Math.PI) / 180)), neighbors: new Set() });
  }
  const edges = links.map(([u, v]) => {
    nodes.get(u).neighbors.add(v);
    nodes.get(v).neighbors.add(u);
    const a = nodes.get(u);
    const b = nodes.get(v);
    return { u, v, coords: [[a.lat, a.lon], [b.lat, b.lon]] };
  });
  return { nodes, edges };
}

function isConnected(nodes) {
  if (nodes.size === 0) return false;
  const start = nodes.keys().next().value;
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    for (const nb of nodes.get(stack.pop()).neighbors) {
      if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
    }
  }
  return seen.size === nodes.size;
}

function maxDeg(nodes) {
  let m = 0;
  for (const n of nodes.values()) m = Math.max(m, n.neighbors.size);
  return m;
}

function minNodeDistance(nodes) {
  const arr = Array.from(nodes.values());
  let m = Infinity;
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      m = Math.min(m, SGM.distanceMeters(arr[i].lat, arr[i].lon, arr[j].lat, arr[j].lon));
    }
  }
  return m;
}

test('S6: crossing edges without a shared node are resolved (longer one removed)', () => {
  // Square with both diagonals; the diagonals cross in the middle. A-C is longer.
  const g = planarGraph(
    [['A', 0, 0], ['B', 100, 0], ['C', 110, 100], ['D', 0, 100]],
    [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'A'], ['A', 'C'], ['B', 'D']]
  );
  assert.strictEqual(SGM.countEdgeCrossings(g.nodes, g.edges), 1);
  const out = SGM.simplifyBoardGraph(g.nodes, g.edges, { includeDeadEnds: true });
  assert.strictEqual(SGM.countEdgeCrossings(out.nodes, out.edges), 0);
  assert.strictEqual(out.info.crossingsRemaining, 0);
  assert.strictEqual(out.edges.length, 5);
  assert.ok(!out.edges.some((e) => (e.u === 'A' && e.v === 'C') || (e.u === 'C' && e.v === 'A')), 'longer diagonal A-C should go');
  assert.ok(isConnected(out.nodes));
  // input not mutated
  assert.strictEqual(g.edges.length, 6);
  assert.strictEqual(g.nodes.get('A').neighbors.size, 3);
});

test('S6: a crossing between two bridges is kept and reported', () => {
  // a-b and c-d cross; they are only linked through b-x-c, so both are bridges
  const g = planarGraph(
    [['a', 0, 50], ['b', 100, 50], ['c', 50, 0], ['d', 50, 100], ['x', 150, -50]],
    [['a', 'b'], ['c', 'd'], ['b', 'x'], ['x', 'c']]
  );
  const out = SGM.simplifyBoardGraph(g.nodes, g.edges, { includeDeadEnds: true });
  assert.strictEqual(out.edges.length, 4);
  assert.strictEqual(out.info.crossingsRemaining, 1);
  assert.ok(isConnected(out.nodes));
});

test('S6: an edge crossing several others is removed first', () => {
  // A long "overpass" P-Q crosses three parallel streets of a ladder
  const pts = [];
  const links = [];
  for (let k = 0; k < 4; k++) {
    pts.push([`L${k}`, 0, k * 100], [`R${k}`, 300, k * 100]);
    links.push([`L${k}`, `R${k}`]);
    if (k > 0) links.push([`L${k - 1}`, `L${k}`], [`R${k - 1}`, `R${k}`]);
  }
  pts.push(['P', 150, -50], ['Q', 150, 350]);
  links.push(['P', 'L0'], ['Q', 'R3'], ['P', 'Q']);
  const g = planarGraph(pts, links);
  assert.strictEqual(SGM.countEdgeCrossings(g.nodes, g.edges), 4);
  const out = SGM.simplifyBoardGraph(g.nodes, g.edges, { includeDeadEnds: true });
  assert.strictEqual(out.info.crossingsRemaining, 0);
  assert.strictEqual(out.info.removedEdges, 1, 'only the overpass should be removed');
  assert.ok(isConnected(out.nodes));
});

test('S7: degree is capped at 4 while staying connected', () => {
  // Wheel: hub H with 6 spokes, rim r0..r5 forms a cycle
  const pts = [['H', 0, 0]];
  const links = [];
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3;
    pts.push([`r${k}`, 100 * Math.cos(a), 100 * Math.sin(a)]);
    links.push(['H', `r${k}`], [`r${k}`, `r${(k + 1) % 6}`]);
  }
  const g = planarGraph(pts, links);
  const out = SGM.simplifyBoardGraph(g.nodes, g.edges, { includeDeadEnds: true });
  assert.ok(maxDeg(out.nodes) <= 4, `max degree ${maxDeg(out.nodes)}`);
  assert.strictEqual(out.nodes.get('H').neighbors.size, 4);
  assert.strictEqual(out.info.overDegreeRemaining, 0);
  assert.strictEqual(out.nodes.size, 7);
  assert.ok(isConnected(out.nodes));
});

test('S7: edges whose removal would disconnect are kept (reported in stats)', () => {
  // Hub with 4 dead-end spokes and a triangle H-p-q: only one of H-p / H-q can go
  const g = planarGraph(
    [['H', 0, 0], ['p', 100, 0], ['q', 100, 100], ['l1', -100, 0], ['l2', 0, -100], ['l3', -100, -100], ['l4', -100, 100]],
    [['H', 'p'], ['H', 'q'], ['p', 'q'], ['H', 'l1'], ['H', 'l2'], ['H', 'l3'], ['H', 'l4']]
  );
  const out = SGM.simplifyBoardGraph(g.nodes, g.edges, { includeDeadEnds: true });
  assert.strictEqual(out.nodes.get('H').neighbors.size, 5);
  assert.strictEqual(out.info.overDegreeRemaining, 1);
  assert.ok(isConnected(out.nodes));
  assert.strictEqual(out.nodes.size, 7);
});

test('S8: dead ends created by simplification are pruned when excluded', () => {
  // 3x3 grid of 100 m blocks (16 points) plus one dangling spur
  const pts = [];
  const links = [];
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      pts.push([`${x},${y}`, x * 100, y * 100]);
      if (x > 0) links.push([`${x - 1},${y}`, `${x},${y}`]);
      if (y > 0) links.push([`${x},${y - 1}`, `${x},${y}`]);
    }
  }
  pts.push(['spur', 450, 150]);
  links.push(['3,1', 'spur']);
  const g = planarGraph(pts, links);
  const without = SGM.simplifyBoardGraph(g.nodes, g.edges, { includeDeadEnds: false });
  assert.ok(!without.nodes.has('spur'));
  assert.strictEqual(without.nodes.size, 16);
  const withSpur = SGM.simplifyBoardGraph(g.nodes, g.edges, { includeDeadEnds: true });
  assert.ok(withSpur.nodes.has('spur'));
});

test('road modes: simple query drops footpaths, tunnels and covered ways; caches do not mix', async () => {
  const simple = SGM.buildOverpassQuery(35, 135, 500, 'simple');
  for (const w of ['footway', 'path', 'steps', 'cycleway', 'service', 'track', 'bridleway']) {
    assert.ok(new RegExp(`\\|${w}[|)]`).test(simple), `simple query should exclude ${w}`);
  }
  assert.ok(simple.includes('(if: !is_tag("tunnel") || t["tunnel"] == "no")') && simple.includes('["covered"!="yes"]'));
  assert.ok(!/pedestrian|living_street/.test(simple), 'pedestrian / living_street must stay');
  const all = SGM.buildOverpassQuery(35, 135, 500, 'all');
  assert.ok(!/footway\|path|service/.test(all) && !all.includes('tunnel'));

  SGM.clearCaches();
  SGM.seedRoadCache(35, 135, 1000, gridElements(4, 35, 135, 1), false, 'simple');
  let calls = 0;
  const els = gridElements(3, 35, 135, 1);
  await withFetch(async (url, opts) => {
    calls++;
    assert.ok(decodeURIComponent(opts.body).includes('"highway"!~"^(proposed|construction|abandoned|platform|bus_stop|elevator|corridor)$"'));
    return jsonResponse(200, { elements: els });
  }, async () => {
    assert.ok(await SGM.fetchOverpassRoads(35, 135, 300, { mode: 'simple' })); // cached
    assert.strictEqual(calls, 0);
    await SGM.fetchOverpassRoads(35, 135, 300, { mode: 'all' }); // different mode -> network
    assert.strictEqual(calls, 1);
    await SGM.fetchOverpassRoads(35, 135, 300, { mode: 'all' }); // now cached for "all"
    assert.strictEqual(calls, 1);
  });
  SGM.clearCaches();
});

test('presets with footpaths enabled: geocode from bundle, roads from Overpass', async () => {
  SGM.clearCaches();
  SGM.setPresetFetcher(localPresetFetcher);
  const urls = [];
  await withFetch(async (url) => {
    urls.push(url);
    return jsonResponse(429, {});
  }, () => rejectsKind(SGM.generateStreetGoBoard('東京 銀座', { targetNodes: 81, includeFootways: true }), 'busy'));
  assert.strictEqual(urls.length, 1);
  assert.ok(urls[0].includes('overpass'), 'no Nominatim request for a preset name');
  SGM.clearCaches();
});

test('defaults: merge radius 30 m, dead ends excluded', () => {
  assert.strictEqual(SGM.DEFAULT_MERGE_RADIUS_M, 30);
  assert.strictEqual(SGM.MAX_NODE_DEGREE, 4);
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(/id="merge-radius"[^>]*max="60"[^>]*value="30"/.test(html));
  assert.ok(/<input type="checkbox" id="include-deadends" \/>/.test(html));
  assert.ok(/<input type="checkbox" id="include-footways" autocomplete="off" \/>/.test(html));
});

test('bundled presets x 36/81/169 with default settings: simple, planar, spaced, connected', async () => {
  SGM.clearCaches();
  SGM.setPresetFetcher(localPresetFetcher);
  assert.strictEqual(SGM.PRESETS.length, 11);
  await withFetch(noNetwork(), async () => {
    for (const p of SGM.PRESETS) {
      const data = JSON.parse(fs.readFileSync(path.join(ROOT, p.file), 'utf8'));
      assert.strictEqual(data.roadMode, 'simple', `${p.file} roadMode`);
      const size = fs.statSync(path.join(ROOT, p.file)).size;
      assert.ok(size <= 1.5 * 1024 * 1024, `${p.file} is ${size} bytes`);
      for (const target of [36, 81, 169]) {
        const label = `${p.query} ${target}`;
        const b = await SGM.generateStreetGoBoard(p.query, { targetNodes: target }, null, { allowNetwork: true });
        assert.ok(b.stats.nodeCount >= 9 && b.stats.nodeCount <= 450, `${label}: ${b.stats.nodeCount}`);
        assert.ok(maxDeg(b.nodes) <= 4, `${label}: max degree ${maxDeg(b.nodes)}`);
        assert.strictEqual(SGM.countEdgeCrossings(b.nodes, b.edges), 0, `${label}: crossings`);
        assert.ok(minNodeDistance(b.nodes) >= SGM.DEFAULT_MERGE_RADIUS_M, `${label}: min distance ${minNodeDistance(b.nodes)}`);
        assert.ok(isConnected(b.nodes), `${label}: not connected`);
        for (const n of b.nodes.values()) assert.ok(n.neighbors.size > 0, `${label}: isolated point`);
      }
    }
    // Offline initial board even if a large size was restored by the browser
    const big = await SGM.generateStreetGoBoard('京都 四条烏丸', { targetNodes: 400 }, null, { allowNetwork: false });
    assert.ok(big.stats.nodeCount >= 9 && big.stats.nodeCount <= 450);
  });
  SGM.clearCaches();
});

// ---------------------------------------------------------------------------
// Review fixes (F1-F13)

function readPreset(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file.split('?')[0]), 'utf8'));
}

function seedPresetRoads(name) {
  const d = readPreset(`presets/${name}.json`);
  SGM.seedRoadCache(d.location.lat, d.location.lon, d.radius, d.elements, true, 'simple');
  return d;
}

function squareAround(lat, lon, sideM) {
  const h = sideM / 2;
  const dLat = h / 111000;
  const dLon = h / (111000 * Math.cos((lat * Math.PI) / 180));
  return { south: lat - dLat, north: lat + dLat, west: lon - dLon, east: lon + dLon };
}

// n x n street grid with the given spacing in metres
function meterGrid(n, spacingM, lat0, lon0) {
  const els = [];
  const dLat = spacingM / 111195;
  const dLon = spacingM / (111195 * Math.cos((lat0 * Math.PI) / 180));
  const id = (x, y) => 1 + y * n + x;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) els.push({ type: 'node', id: id(x, y), lat: lat0 + y * dLat, lon: lon0 + x * dLon });
  }
  let w = 1;
  for (let y = 0; y < n; y++) els.push({ type: 'way', id: w++, nodes: Array.from({ length: n }, (_, x) => id(x, y)) });
  for (let x = 0; x < n; x++) els.push({ type: 'way', id: w++, nodes: Array.from({ length: n }, (_, y) => id(x, y)) });
  return { els, center: [lat0 + ((n - 1) / 2) * dLat, lon0 + ((n - 1) / 2) * dLon] };
}

test('F12a: clusters whose centroids end up within the radius are merged again', () => {
  // Points on one street at 0, 5, 35 and 40 m. Leader clustering gives {0,5,35} and {40};
  // their centroids are 26.7 m apart, so the second step must merge them into one point.
  const k = 111195 * Math.cos((35 * Math.PI) / 180);
  const js = [0, 5, 35, 40].map((x, i) => ({ id: `p${i}`, lat: 35, lon: 135 + x / k, deg: 3 }));
  const cl = SGM.clusterJunctions(js, 30);
  assert.strictEqual(cl.length, 1, `got ${cl.length} clusters`);
  assert.strictEqual(cl[0].members.length, 4);
  assert.ok(Math.abs((cl[0].lon - 135) * k - 20) < 0.01, 'merged point sits at the centroid (20 m)');
});

test('F12a: points never closer than the merge radius, and no chaining (F3)', () => {
  // Five points 25 m apart in a row: single linkage would make one 100 m blob
  const k = 111195 * Math.cos((35 * Math.PI) / 180);
  const js = [0, 25, 50, 75, 100].map((x, i) => ({ id: `q${i}`, lat: 35, lon: 135 + x / k, deg: 3 }));
  const cl = SGM.clusterJunctions(js, 30);
  assert.ok(cl.length >= 2, 'a 100 m row must not collapse into one point');
  for (const c of cl) {
    for (const a of c.members) for (const b of c.members) {
      assert.ok(SGM.distanceMeters(a.lat, a.lon, b.lat, b.lon) <= 60 + 1e-6, 'cluster diameter <= 2 x radius');
    }
  }
  for (let i = 0; i < cl.length; i++) {
    for (let j = i + 1; j < cl.length; j++) {
      assert.ok(SGM.distanceMeters(cl[i].lat, cl[i].lon, cl[j].lat, cl[j].lon) >= 30, 'spacing >= radius');
    }
  }
});

test('F3: a dense 25 m grid with a 30 m merge radius keeps a board', () => {
  const g = meterGrid(12, 25, 35, 135);
  const b = SGM.buildRoadGraph(g.els, g.center[0], g.center[1], { targetNodes: 400, mergeRadiusMeters: 30 });
  assert.ok(b.stats.nodeCount >= 9, `only ${b.stats.nodeCount} points`);
  assert.ok(minNodeDistance(b.nodes) >= 30);
  assert.ok(isConnected(b.nodes));
  assert.ok(maxDeg(b.nodes) <= 4);
});

test('F12b: T-shaped and collinear endpoint contacts count as crossings', () => {
  // T: C touches the middle of A-B
  const t = planarGraph([['A', 0, 0], ['B', 100, 0], ['C', 50, 0], ['D', 50, 100]], [['A', 'B'], ['C', 'D']]);
  assert.strictEqual(SGM.countEdgeCrossings(t.nodes, t.edges), 1);
  // Collinear overlap: C-D lies on the same line and starts inside A-B
  const c = planarGraph([['A', 0, 0], ['B', 100, 0], ['C', 60, 0], ['D', 150, 0]], [['A', 'B'], ['C', 'D']]);
  assert.strictEqual(SGM.countEdgeCrossings(c.nodes, c.edges), 1);
  // Collinear endpoint contact: C-D starts exactly at B's position (different point id)
  const e = planarGraph([['A', 0, 0], ['B', 100, 0], ['C', 100, 0.0], ['D', 150, 0]], [['A', 'B'], ['C', 'D']]);
  assert.strictEqual(SGM.countEdgeCrossings(e.nodes, e.edges), 1);
  // Collinear but apart: no contact
  const d = planarGraph([['A', 0, 0], ['B', 100, 0], ['C', 120, 0], ['D', 150, 0]], [['A', 'B'], ['C', 'D']]);
  assert.strictEqual(SGM.countEdgeCrossings(d.nodes, d.edges), 0);
});

test('F12c: a dead end that appears only after removing a crossing edge is pruned', () => {
  // 4x4 points (100 m blocks) + X inside the top-middle block. X-(3,1) crosses two grid
  // edges and is removed; X is then left with one road (to (1,3)) and must be pruned.
  const pts = [];
  const links = [];
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      pts.push([`${x},${y}`, x * 100, y * 100]);
      if (x > 0) links.push([`${x - 1},${y}`, `${x},${y}`]);
      if (y > 0) links.push([`${x},${y - 1}`, `${x},${y}`]);
    }
  }
  pts.push(['X', 130, 260]);
  links.push(['X', '3,1'], ['X', '1,3']);
  const g = planarGraph(pts, links);
  assert.strictEqual(SGM.countEdgeCrossings(g.nodes, g.edges), 2);
  const out = SGM.simplifyBoardGraph(g.nodes, g.edges, { includeDeadEnds: false });
  assert.strictEqual(out.info.removedEdges, 1);
  assert.ok(!out.nodes.has('X'), 'X became a dead end and must be pruned');
  assert.strictEqual(out.nodes.size, 16);
  assert.strictEqual(out.edges.length, 24);
  assert.strictEqual(out.info.crossingsRemaining, 0);
  const keepX = SGM.simplifyBoardGraph(g.nodes, g.edges, { includeDeadEnds: true });
  assert.ok(keepX.nodes.has('X'));
  assert.strictEqual(keepX.nodes.get('X').neighbors.size, 1);
  assert.deepStrictEqual(Array.from(keepX.nodes.get('X').neighbors), ['1,3']);
});

test('F1: small drawn square keeps its spurs when the loops alone are too small', async () => {
  // Ginza, 250 m square: the closed loops alone (2-core) are fewer than 9 points, and so is
  // the board once dead ends are pruned after simplification. Only the two fallbacks that
  // keep the spurs make it playable (without either of them this square is rejected as
  // too-few; checked by disabling each in map-graph.js).
  SGM.clearCaches();
  const d = seedPresetRoads('tokyo-ginza');
  const b = squareAround(d.location.lat, d.location.lon, 250);
  const g = await withFetch(noNetwork(), () => SGM.generateStreetGoBoardInBounds(b, {}, null, {}));
  assert.ok(g.stats.nodeCount >= 9 && g.stats.nodeCount <= 20, `${g.stats.nodeCount} points`);
  assert.ok(isConnected(g.nodes));
  const deadEnds = Array.from(g.nodes.values()).filter((n) => n.neighbors.size === 1).length;
  assert.ok(deadEnds > 0, 'the board must include kept spurs (dead ends)');
  SGM.clearCaches();
});

test('F2: a short board grows within the data at hand before asking the network', async () => {
  SGM.clearCaches();
  SGM.setPresetFetcher(localPresetFetcher);
  const g = await withFetch(noNetwork(), () =>
    SGM.generateStreetGoBoard('東京 銀座', { targetNodes: 20, mergeRadiusMeters: 5 }, null, {})
  );
  assert.ok(g.stats.nodeCount >= 17, `${g.stats.nodeCount} points`);
  SGM.clearCaches();
});

test('F6: midpoints are never placed closer than the merge radius', async () => {
  SGM.clearCaches();
  SGM.setPresetFetcher(localPresetFetcher);
  const g = await withFetch(noNetwork(), () =>
    SGM.generateStreetGoBoard('東京 銀座', { targetNodes: 361, subdivideLongRoads: true, subdivideSpacingMeters: 30 }, null, {})
  );
  assert.ok(g.stats.nodeCount >= 9);
  assert.ok(minNodeDistance(g.nodes) >= SGM.DEFAULT_MERGE_RADIUS_M, `min distance ${minNodeDistance(g.nodes)}`);
  SGM.clearCaches();
});

test('F8: no edge of a drawn board leaves the square', async () => {
  // A 4 x 4 street grid (100 m blocks) inside the square, plus one road whose two ends are
  // grid corners inside the square but whose middle runs 60 m outside it (below the grid).
  // Checking only the two ends would keep that road; the whole polyline must be checked.
  SGM.clearCaches();
  const lat0 = 35;
  const lon0 = 135;
  const kLat = 111195;
  const kLon = 111195 * Math.cos((lat0 * Math.PI) / 180);
  const at = (xm, ym) => ({ lat: lat0 + ym / kLat, lon: lon0 + xm / kLon });
  const els = [];
  const gid = (x, y) => 1 + y * 4 + x;
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) els.push({ type: 'node', id: gid(x, y), ...at(x * 100, y * 100) });
  }
  let w = 1;
  for (let y = 0; y < 4; y++) els.push({ type: 'way', id: w++, nodes: [0, 1, 2, 3].map((x) => gid(x, y)) });
  for (let x = 0; x < 4; x++) els.push({ type: 'way', id: w++, nodes: [0, 1, 2, 3].map((y) => gid(x, y)) });
  els.push({ type: 'node', id: 101, ...at(0, -60) }, { type: 'node', id: 102, ...at(300, -60) });
  els.push({ type: 'way', id: w++, nodes: [gid(0, 0), 101, 102, gid(3, 0)] }); // the detour
  const sw = at(-20, -20);
  const ne = at(320, 320);
  const b = { south: sw.lat, west: sw.lon, north: ne.lat, east: ne.lon };
  const centre = at(150, 150);
  SGM.seedRoadCache(centre.lat, centre.lon, 1000, els, false);
  const g = await withFetch(noNetwork(), () =>
    SGM.generateStreetGoBoardInBounds(b, { mergeRadiusMeters: 5, includeDeadEnds: true }, null, {}));
  // Both ends of the detour are board points, so only the inside check can drop the road
  const pointAt = (p) => Array.from(g.nodes.values()).find((n) => Math.abs(n.lat - p.lat) < 1e-7 && Math.abs(n.lon - p.lon) < 1e-7);
  const endA = pointAt(at(0, 0));
  const endB = pointAt(at(300, 0));
  assert.ok(endA && endB, 'detour ends should be board points');
  assert.ok(!endA.neighbors.has(endB.id), 'the detour must not link its two ends');
  for (const e of g.edges) {
    for (const [la, lo] of e.coords) {
      assert.ok(la >= b.south - 1e-9 && la <= b.north + 1e-9 && lo >= b.west - 1e-9 && lo <= b.east + 1e-9, `edge ${e.u}-${e.v} leaves the square`);
    }
  }
  SGM.clearCaches();
});

// ---------------------------------------------------------------------------
// Drawn rectangles (any width x height; Shift + mouse = square)

function rectAround(lat, lon, widthM, heightM) {
  const dLat = heightM / 2 / 111000;
  const dLon = widthM / 2 / (111000 * Math.cos((lat * Math.PI) / 180));
  return { south: lat - dLat, north: lat + dLat, west: lon - dLon, east: lon + dLon };
}

function assertBoardInside(g, b, label) {
  for (const n of g.nodes.values()) {
    assert.ok(n.lat >= b.south && n.lat <= b.north && n.lon >= b.west && n.lon <= b.east, `${label}: point ${n.id} outside`);
  }
  for (const e of g.edges) {
    for (const [la, lo] of e.coords) {
      assert.ok(la >= b.south - 1e-9 && la <= b.north + 1e-9 && lo >= b.west - 1e-9 && lo <= b.east + 1e-9, `${label}: edge ${e.u}-${e.v} leaves the rectangle`);
    }
  }
}

test('rect: landscape and portrait rectangles on bundled data make valid boards inside them', async () => {
  for (const name of ['nagoya-sakae', 'tokyo-ginza', 'kyoto-shijo-karasuma']) {
    SGM.clearCaches();
    const d = seedPresetRoads(name);
    for (const [w, h] of [[600, 300], [300, 600]]) {
      const label = `${name} ${w}x${h}`;
      const b = rectAround(d.location.lat, d.location.lon, w, h);
      const g = await withFetch(noNetwork(), () => SGM.generateStreetGoBoardInBounds(b, {}, null, {}));
      assert.ok(g.stats.nodeCount >= 9 && g.stats.nodeCount <= 450, `${label}: ${g.stats.nodeCount} points`);
      assertBoardInside(g, b, label);
      assert.ok(maxDeg(g.nodes) <= 4, `${label}: max degree ${maxDeg(g.nodes)}`);
      assert.strictEqual(SGM.countEdgeCrossings(g.nodes, g.edges), 0, `${label}: crossings`);
      assert.ok(isConnected(g.nodes), `${label}: not connected`);
      for (const n of g.nodes.values()) assert.ok(n.neighbors.size > 0, `${label}: isolated point`);
      assert.deepStrictEqual(g.customBounds, b, `${label}: the frame is the drawn rectangle`);
      const size = SGM.rectSizeMeters(g.customBounds);
      assert.ok(w > h ? size.widthM > size.heightM : size.heightM > size.widthM, `${label}: frame orientation`);
    }
  }
  SGM.clearCaches();
});

// Recorded with the square-only version (HEAD before rectangles: `git show HEAD:map-graph.js`
// loaded in node): point ids and road end pairs (each pair sorted, then the list sorted)
const SQUARE_400_EXPECTED = {
  'nagoya-sakae': {
    ids: ["n110", "n111", "n20", "n291", "n292", "n293", "n296", "n297", "n298", "n301", "n302", "n303", "n70", "n94", "n95", "n96"],
    edges: ["n110-n20", "n110-n298", "n110-n70", "n111-n303", "n111-n70", "n20-n96", "n291-n292", "n291-n296", "n291-n301", "n292-n293", "n292-n297", "n292-n302", "n293-n298", "n293-n303", "n293-n70", "n296-n297", "n296-n94", "n297-n298", "n297-n95", "n298-n96", "n301-n302", "n302-n303", "n94-n95", "n95-n96"]
  },
  'tokyo-ginza': {
    ids: ["n135", "n139", "n151", "n152", "n166", "n222", "n257", "n339", "n345", "n346", "n366", "n367", "n368", "n373", "n38", "n52", "n53", "n54", "n56", "n581", "n621", "n673", "n703", "n704", "n710", "n776"],
    edges: ["n135-n339", "n135-n52", "n135-n581", "n135-n673", "n139-n346", "n139-n38", "n139-n704", "n151-n257", "n151-n703", "n151-n704", "n152-n367", "n152-n373", "n152-n38", "n166-n373", "n166-n621", "n222-n373", "n222-n38", "n222-n710", "n257-n53", "n257-n710", "n339-n345", "n345-n346", "n345-n54", "n346-n54", "n366-n367", "n366-n368", "n366-n54", "n367-n54", "n368-n673", "n52-n581", "n52-n776", "n53-n56", "n53-n621", "n53-n703", "n56-n621", "n56-n703", "n673-n776", "n704-n710"]
  }
};

function boardSignature(g) {
  return {
    ids: Array.from(g.nodes.keys()).map(String).sort(),
    edges: g.edges.map((e) => [String(e.u), String(e.v)].sort().join('-')).sort()
  };
}

test('rect: a 400 m square passed as a rectangle gives the same board as the square did', async () => {
  for (const [name, expected] of Object.entries(SQUARE_400_EXPECTED)) {
    SGM.clearCaches();
    const d = seedPresetRoads(name);
    const sq = await withFetch(noNetwork(), () =>
      SGM.generateStreetGoBoardInBounds(squareAround(d.location.lat, d.location.lon, 400), {}, null, {}));
    const rc = await withFetch(noNetwork(), () =>
      SGM.generateStreetGoBoardInBounds(rectAround(d.location.lat, d.location.lon, 400, 400), {}, null, {}));
    for (const g of [sq, rc]) {
      assert.deepStrictEqual(boardSignature(g), expected, `${name}: points / roads differ from the square version`);
      assert.strictEqual(g.stats.nodeCount, expected.ids.length);
      assert.strictEqual(g.stats.edgeCount, expected.edges.length);
    }
  }
  SGM.clearCaches();
});

test('rect: size limits (short side on screen, long side on the ground, aspect ratio) at the boundaries', () => {
  const c = (widthM, heightM, widthPx, heightPx) => SGM.checkDrawnRect({ widthM, heightM, widthPx, heightPx });
  assert.strictEqual(SGM.MIN_DRAW_SIDE_PX, 15);
  assert.strictEqual(SGM.MAX_DRAW_SIDE_M, 4000);
  assert.strictEqual(SGM.MAX_DRAW_ASPECT, 6);
  // aspect ratio: 1:6 is fine, anything thinner is not (both orientations)
  assert.ok(c(600, 100, 600, 100).ok);
  assert.ok(c(100, 600, 100, 600).ok);
  assert.strictEqual(c(600.1, 100, 600, 100).kind, 'too-thin');
  assert.strictEqual(c(100, 600.1, 100, 600).kind, 'too-thin');
  assert.strictEqual(c(500, 0).kind, 'too-thin'); // metres only
  assert.strictEqual(c(500, 0, 300, 0).kind, 'too-small');
  assert.strictEqual(c(600.1, 100, 600, 100).message, '範囲が細長すぎます。もう少し幅を広げてください');
  // shorter side on screen: 15 px is fine, less is too small
  assert.ok(c(300, 300, 15, 15).ok);
  assert.ok(c(300, 100, 45, 15).ok);
  assert.strictEqual(c(300, 100, 45, 14.9).kind, 'too-small');
  assert.strictEqual(c(300, 100, 14.9, 45).kind, 'too-small');
  // a click / tiny drag is too small, whatever its shape
  assert.strictEqual(c(0, 0, 0, 0).kind, 'too-small');
  assert.strictEqual(c(140, 10, 14, 1).kind, 'too-small');
  assert.strictEqual(c(140, 10, 14, 1).message, 'もう少し大きくドラッグして範囲を引いてください');
  // order: too small -> too large -> too thin
  assert.strictEqual(c(1000, 100, 100, 10).kind, 'too-small', '100 x 10 px is too small (not too thin)');
  assert.strictEqual(c(10000, 100, 1000, 10).kind, 'too-small');
  assert.strictEqual(c(10000, 100, 1000, 15).kind, 'too-large');
  assert.strictEqual(c(700, 100, 70, 15).kind, 'too-thin');
  // longer side on the ground: 4000 m is fine, more is too large
  assert.ok(c(4000, 4000, 400, 400).ok);
  assert.ok(c(4000, 1000).ok); // metres only (no pixel checks)
  assert.strictEqual(c(4000.1, 1000).kind, 'too-large');
  assert.strictEqual(c(1000, 4000.1).kind, 'too-large');
  assert.ok(/一辺 4km 以内の範囲/.test(c(4000.1, 1000).message));
  assert.ok(!/正方形/.test(c(4000.1, 1000).message));
});

test('rect: generation rejects too thin / too large rectangles before any request', async () => {
  SGM.clearCaches();
  await withFetch(noNetwork(), async () => {
    const thin = await rejectsKind(SGM.generateStreetGoBoardInBounds(rectAround(35, 135, 700, 100), {}, null, {}), 'area');
    assert.ok(/細長すぎます/.test(thin.message));
    const wide = await rejectsKind(SGM.generateStreetGoBoardInBounds(rectAround(35, 135, 4100, 1000), {}, null, {}), 'area');
    assert.ok(/広すぎます/.test(wide.message));
    // the radius cap of the request still applies on its own
    const huge = await rejectsKind(SGM.generateStreetGoBoardInBounds(rectAround(35, 135, 5000, 5000), {}, null, {}), 'area');
    assert.strictEqual(huge.message, wide.message);
  });
});

test('rect: the Overpass circle covers the rectangle (centre, half diagonal + 60 m, at least 120 m)', async () => {
  for (const [w, h] of [[600, 300], [300, 600], [400, 400], [3000, 800]]) {
    const b = rectAround(35, 135, w, h);
    const circle = SGM.rectCoverCircle(b);
    const half = Math.hypot(w, h) / 2;
    assert.ok(Math.abs(circle.halfDiagM - half) < 0.01 * half, `${w}x${h}: ${circle.halfDiagM} vs ${half}`);
    assert.strictEqual(circle.radiusM, Math.max(120, Math.round(circle.halfDiagM + 60)));
    assert.ok(Math.abs(circle.lat - 35) < 1e-12 && Math.abs(circle.lon - 135) < 1e-12);
    for (const [la, lo] of [[b.south, b.west], [b.south, b.east], [b.north, b.west], [b.north, b.east]]) {
      assert.ok(SGM.distanceMeters(circle.lat, circle.lon, la, lo) <= circle.halfDiagM + 1e-9, `${w}x${h}: corner outside`);
    }
    // the square case matches the former radius (half the SW-NE diagonal) to the metre
    if (w === h) {
      const former = Math.max(120, Math.round(SGM.distanceMeters(b.south, b.west, b.north, b.east) / 2 + 60));
      assert.ok(Math.abs(circle.radiusM - former) <= 1, `${circle.radiusM} vs ${former}`);
    }
  }
  assert.strictEqual(SGM.rectCoverCircle(rectAround(35, 135, 40, 30)).radiusM, 120);
  // size along the middle latitude / meridian (cos(latitude) handled by the haversine)
  const s = SGM.rectSizeMeters(rectAround(60, 10, 600, 300));
  assert.ok(Math.abs(s.widthM - 600) < 3 && Math.abs(s.heightM - 300) < 3, `${s.widthM} x ${s.heightM}`);
  // the request itself goes to the centre with that radius
  SGM.clearCaches();
  const b = rectAround(35.1, 135.2, 600, 300);
  const bodies = [];
  await withFetch(async (url, init) => {
    bodies.push(decodeURIComponent(init.body.replace(/^data=/, '')));
    return jsonResponse(200, { elements: gridElements(5, 35.0985, 135.1975, 1) });
  }, () => SGM.generateStreetGoBoardInBounds(b, { mergeRadiusMeters: 5 }, null, {}));
  assert.strictEqual(bodies.length, 1);
  const m = /around:(\d+),([\d.]+),([\d.]+)\)/.exec(bodies[0]);
  assert.ok(m, bodies[0]);
  const circle = SGM.rectCoverCircle(b);
  assert.strictEqual(Number(m[1]), circle.radiusM);
  assert.ok(Math.abs(Number(m[2]) - 35.1) < 1e-9 && Math.abs(Number(m[3]) - 135.2) < 1e-9);
  SGM.clearCaches();
});

test('rect: data at hand is used when its circle holds the rectangle corners (+60 m); otherwise one request', async () => {
  // Kyoto bundle: 1300 m around its centre. A 1000 x 200 m rectangle 950 m north of it has
  // its farthest corner ~1163 m away (+60 = ~1223 m <= 1300 m), although a circle covering
  // the rectangle (950 + 510 + 60 m) would reach outside the bundle.
  SGM.clearCaches();
  const d = seedPresetRoads('kyoto-shijo-karasuma');
  const north = 950 / 111000;
  const b = rectAround(d.location.lat + north, d.location.lon, 1000, 200);
  const far = Math.max(...[[b.north, b.west], [b.north, b.east]].map(([la, lo]) => SGM.distanceMeters(d.location.lat, d.location.lon, la, lo)));
  assert.ok(far > 1150 && far < 1175, `farthest corner ${far}`);
  assert.ok(SGM.findCachedRoadsForRect(b, 'simple'));
  let calls = 0;
  const g = await withFetch(async (url) => { calls++; throw new Error(`unexpected network access: ${url}`); },
    () => SGM.generateStreetGoBoardInBounds(b, {}, null, { allowNetwork: false }));
  assert.strictEqual(calls, 0);
  assert.ok(g.stats.nodeCount >= 9, `${g.stats.nodeCount} points`);
  assertBoardInside(g, b, 'kyoto north');
  // A corner outside the bundle's circle (1000 x 600 m: ~1346 m) -> one Overpass request
  const b2 = rectAround(d.location.lat + north, d.location.lon, 1000, 600);
  assert.strictEqual(SGM.findCachedRoadsForRect(b2, 'simple'), null);
  const bodies = [];
  await withFetch(async (url, init) => {
    bodies.push(decodeURIComponent(init.body.replace(/^data=/, '')));
    return jsonResponse(200, { elements: d.elements });
  }, () => SGM.generateStreetGoBoardInBounds(b2, {}, null, {}));
  assert.strictEqual(bodies.length, 1);
  assert.ok(bodies[0].includes(`around:${SGM.rectCoverCircle(b2).radiusM},`));
  // Offline, the same rectangle is refused instead of requested
  SGM.clearCaches();
  seedPresetRoads('kyoto-shijo-karasuma');
  await withFetch(noNetwork(), () => rejectsKind(SGM.generateStreetGoBoardInBounds(b2, {}, null, { allowNetwork: false }), 'offline'));
  // footpath mode never uses the (simple) bundle
  assert.strictEqual(SGM.findCachedRoadsForRect(b, 'all'), null);
  SGM.clearCaches();
});

test('rect: longitudes of a wrapped world copy are brought back; the antimeridian is refused', async () => {
  SGM.clearCaches();
  const d = seedPresetRoads('kyoto-shijo-karasuma');
  const b = rectAround(d.location.lat, d.location.lon, 600, 300);
  const normal = await withFetch(noNetwork(), () => SGM.generateStreetGoBoardInBounds(b, {}, null, {}));
  for (const turns of [1, -1, 2]) {
    const shifted = { ...b, west: b.west + 360 * turns, east: b.east + 360 * turns };
    const g = await withFetch(noNetwork(), () => SGM.generateStreetGoBoardInBounds(shifted, {}, null, {}));
    assert.strictEqual(g.stats.nodeCount, normal.stats.nodeCount, `${turns} turns`);
    assert.strictEqual(g.stats.edgeCount, normal.stats.edgeCount, `${turns} turns`);
    assert.ok(Math.abs(g.customBounds.west - b.west) < 1e-9 && Math.abs(g.customBounds.east - b.east) < 1e-9);
  }
  const n = SGM.normalizeDrawnBounds(b);
  assert.ok(n.ok);
  assert.deepStrictEqual(n.bounds, b, 'bounds already in range are left exactly as they are');
  for (const [w, e] of [[179.99, 180.01], [-180.01, -179.99], [539.99, 540.01]]) {
    const r = SGM.normalizeDrawnBounds({ south: 0, north: 0.01, west: w, east: e });
    assert.ok(!r.ok && r.kind === 'antimeridian', `${w}..${e}`);
    assert.strictEqual(r.message, 'この位置では範囲を指定できません');
  }
  SGM.clearCaches();
});

test('rect: impossible bounds are refused before any request (F7)', async () => {
  SGM.clearCaches();
  let calls = 0;
  const counting = async (url) => { calls++; throw new Error(`unexpected network access: ${url}`); };
  const cases = [
    { south: 35.01, north: 35.0, west: 135.0, east: 135.01 }, // south > north
    { south: 35.0, north: 35.0, west: 135.0, east: 135.01 }, // south = north
    { south: 94.99, north: 95.0, west: 135.0, east: 135.01 }, // latitude 95
    { south: 84.99, north: 85.01, west: 10.0, east: 10.1 }, // beyond Web Mercator
    { south: -85.01, north: -84.99, west: 10.0, east: 10.1 },
    { south: 35.0, north: 35.01, west: 135.01, east: 135.0 }, // west > east
    { south: 35.0, north: 35.01, west: 135.0, east: 135.0 },
    { south: NaN, north: 35.01, west: 135.0, east: 135.01 },
    { south: 35.0, north: Infinity, west: 135.0, east: 135.01 }
  ];
  await withFetch(counting, async () => {
    for (const b of cases) {
      const err = await rejectsKind(SGM.generateStreetGoBoardInBounds(b, {}, null, {}), 'area');
      assert.strictEqual(err.message, 'この位置では範囲を指定できません', JSON.stringify(b));
    }
    await rejectsKind(SGM.generateStreetGoBoardInBounds(null, {}, null, {}), 'area');
  });
  assert.strictEqual(calls, 0);
});

test('rect: the covering radius near latitude 85 (farthest corner, not half the diagonal)', () => {
  const b = rectAround(84.99, 10, 600, 300);
  const c = SGM.rectCoverCircle(b);
  assert.strictEqual(c.radiusM, 396);
  assert.ok(Math.abs(c.halfDiagM - 336.035) < 0.01, String(c.halfDiagM));
  assert.ok(SGM.normalizeDrawnBounds(b).ok);
});

test('rect: drag on screen -> rectangle, Shift squares it on the longer side; size label', () => {
  const r = SGM.dragRectPx({ x: 100, y: 100 }, { x: 40, y: 180 });
  assert.deepStrictEqual([r.end.x, r.end.y, r.widthPx, r.heightPx], [40, 180, 60, 80]);
  const s = SGM.dragRectPx({ x: 100, y: 100 }, { x: 40, y: 180 }, true);
  assert.deepStrictEqual([s.end.x, s.end.y, s.widthPx, s.heightPx], [20, 180, 80, 80]);
  const s2 = SGM.dragRectPx({ x: 0, y: 0 }, { x: 120, y: -30 }, true);
  assert.deepStrictEqual([s2.end.x, s2.end.y], [120, -120]);
  assert.strictEqual(SGM.formatRectSize(420.4, 259.6), '横 420m × 縦 260m');
  assert.strictEqual(SGM.formatRectSize(1234, 999.6), '横 1.23km × 縦 1.00km');
  assert.strictEqual(SGM.formatRectSize(999.4, 80), '横 999m × 縦 80m');
});

test('F13: junctions are merged at high latitudes too', () => {
  for (const lat of [60, 80, 85]) {
    const k = 111195 * Math.cos((lat * Math.PI) / 180);
    for (let off = 0; off < 200; off += 7) {
      const js = [0, 25].map((x, i) => ({ id: `h${i}`, lat, lon: 10 + (off + x) / k, deg: 3 }));
      assert.strictEqual(SGM.clusterJunctions(js, 30).length, 1, `lat ${lat} offset ${off}`);
    }
  }
});

test('F7: far too many points stop before simplification', () => {
  const g = meterGrid(45, 60, 35, 135); // 2025 junctions in the square
  assert.throws(
    () => SGM.buildRoadGraph(g.els, g.center[0], g.center[1], {
      mergeRadiusMeters: 5,
      bounds: { south: 34.99, north: 35.1, west: 134.99, east: 135.1 }
    }),
    // the early check reports "N点以上" (the final check after simplification says "N点")
    (err) => err.kind === 'too-many' && /交点が多すぎます\(\d+点以上\)/.test(err.message)
  );
});

test('F5/F10: preset JSON is versioned, must be roadMode "simple", and never needs Nominatim', async () => {
  SGM.clearCaches();
  const requested = [];
  // 1. bundle without roadMode -> ignored, roads from Overpass, no Nominatim
  SGM.setPresetFetcher(async (file) => {
    requested.push(file);
    const d = readPreset(file);
    delete d.roadMode;
    return d;
  });
  let urls = [];
  await withFetch(async (url) => { urls.push(url); return jsonResponse(429, {}); },
    () => rejectsKind(SGM.generateStreetGoBoard('東京 銀座', { targetNodes: 81 }), 'busy'));
  assert.ok(requested[0].endsWith(`.json?v=${SGM.ASSET_VERSION}`), requested[0]);
  assert.strictEqual(urls.length, 1);
  assert.ok(urls[0].includes('overpass'));
  assert.ok(SGM.findCachedRoads(35.6712, 139.765, 300) === null, 'old bundle must not be registered');

  // 2. bundle cannot be loaded at all -> still no Nominatim
  SGM.clearCaches();
  SGM.setPresetFetcher(async () => { throw new Error('timeout'); });
  urls = [];
  await withFetch(async (url) => { urls.push(url); return jsonResponse(429, {}); },
    () => rejectsKind(SGM.generateStreetGoBoard('札幌 大通公園', { targetNodes: 81 }), 'busy'));
  assert.strictEqual(urls.length, 1);
  assert.ok(!urls.some((u) => u.includes('nominatim')));

  // 3. offline initial board with a broken bundle -> clear error, no request
  SGM.clearCaches();
  await withFetch(noNetwork(), () =>
    rejectsKind(SGM.generateStreetGoBoard('京都 四条烏丸', {}, null, { allowNetwork: false }), 'offline'));
  SGM.setPresetFetcher(localPresetFetcher);
  SGM.clearCaches();
});

test('F5: the default preset loader adds the version query and a time limit', async () => {
  SGM.clearCaches();
  SGM.setPresetFetcher(null); // default loader
  const seen = [];
  await withFetch(async (url, opts) => {
    seen.push({ url, hasSignal: !!(opts && opts.signal) });
    return jsonResponse(200, readPreset('presets/kyoto-shijo-karasuma.json'));
  }, () => SGM.generateStreetGoBoard('京都 四条烏丸', { targetNodes: 36 }, null, { allowNetwork: false }));
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].url, `presets/kyoto-shijo-karasuma.json?v=${SGM.ASSET_VERSION}`);
  assert.ok(seen[0].hasSignal, 'the request carries an abort signal (15 s limit)');
  SGM.setPresetFetcher(localPresetFetcher);
  SGM.clearCaches();
});

test('F9: tunnels other than "no" are excluded, covered=arcade stays', () => {
  const q = SGM.buildOverpassQuery(35, 135, 500, 'simple');
  assert.ok(q.includes('(if: !is_tag("tunnel") || t["tunnel"] == "no")'));
  assert.ok(q.includes('["covered"!="yes"]'));
  assert.ok(!/covered"!~|arcade/.test(q));
});

// ---------------------------------------------------------------------------
// Review fixes (R1, R16)

// The preset chips in index.html: data-place (= query), label and title (full name)
function presetChips() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const chips = [];
  const re = /<button[^>]*class="chip"[^>]*data-place="([^"]+)"[^>]*title="([^"]+)"[^>]*>([^<]+)<\/button>/g;
  let m;
  while ((m = re.exec(html)) !== null) chips.push({ place: m[1], title: m[2], label: m[3].trim() });
  return chips;
}

test('R1: every preset is found by its query, chip label and full name', () => {
  const chips = presetChips();
  assert.strictEqual(chips.length, 11);
  assert.strictEqual(SGM.PRESETS.length, 11);
  for (const p of SGM.PRESETS) {
    const chip = chips.find((c) => c.place === p.query);
    assert.ok(chip, `no chip for ${p.query}`);
    for (const name of [p.query, chip.label, chip.title]) {
      assert.strictEqual(SGM.findPreset(name), p, `"${name}" should select ${p.query}`);
    }
  }
  // Spacing, the middle dot, full-width forms and letter case do not matter
  const ginza = SGM.findPreset('東京 銀座');
  for (const name of ['東京・銀座', '東京　銀座', '  東京   銀座 ', '東京･銀座', '銀座', '東京']) {
    assert.strictEqual(SGM.findPreset(name), ginza, name);
  }
  const ny = SGM.findPreset('ニューヨーク ミッドタウン');
  for (const name of ['NY', 'ny', 'ＮＹ', 'ニューヨーク', 'ニューヨーク・ミッドタウン']) {
    assert.strictEqual(SGM.findPreset(name), ny, name);
  }
  assert.strictEqual(SGM.findPreset('京都'), SGM.findPreset('京都 四条烏丸'));
  assert.strictEqual(SGM.findPreset('札幌'), SGM.findPreset('札幌 大通公園'));
  assert.strictEqual(SGM.findPreset('パリ'), SGM.findPreset('Paris Arc de Triomphe'));
  assert.strictEqual(SGM.findPreset('paris arc de triomphe'), SGM.findPreset('Paris Arc de Triomphe'));
});

test('R1: unrelated names do not match a preset; no alias is shared', () => {
  for (const name of ['大阪', '渋谷', '下北沢', '東京 渋谷', '京都駅', '', '  ', '・', 'New', 'ミッドタウン', '中心部', '旧市街']) {
    assert.strictEqual(SGM.findPreset(name), null, `"${name}" must not match`);
  }
  const owner = new Map();
  for (const p of SGM.PRESETS) {
    for (const a of [p.query].concat(p.aliases || [])) {
      const hit = SGM.findPreset(a);
      assert.strictEqual(hit, p, `alias "${a}" of ${p.query} resolves to ${hit && hit.query}`);
      const key = a.normalize('NFKC').replace(/[・\s]+/g, ' ').trim().toLowerCase();
      assert.ok(!owner.has(key) || owner.get(key) === p, `"${a}" is used by two presets`);
      owner.set(key, p);
    }
  }
});

test('R1: typing a preset name (chip label / full name) never contacts Nominatim or Overpass', async () => {
  SGM.setPresetFetcher(localPresetFetcher);
  for (const name of ['東京', '東京・銀座', 'NY', 'ニューヨーク', '京都', 'パリ・凱旋門']) {
    SGM.clearCaches();
    const g = await withFetch(noNetwork(), () =>
      SGM.generateStreetGoBoard(name, { targetNodes: 81 }, null, { allowNetwork: true }));
    assert.ok(g.stats.nodeCount >= 9, `${name}: ${g.stats.nodeCount}`);
    const p = SGM.findPreset(name);
    assert.strictEqual(g.location.lat, p.lat, name);
    assert.strictEqual(g.location.lon, p.lon, name);
  }
  // An unrelated name still goes to Nominatim
  SGM.clearCaches();
  const urls = [];
  await withFetch(async (url) => { urls.push(url); return jsonResponse(429, {}); },
    () => rejectsKind(SGM.generateStreetGoBoard('大阪', { targetNodes: 81 }), 'busy'));
  assert.strictEqual(urls.length, 1);
  assert.ok(urls[0].includes('nominatim'));
  SGM.clearCaches();
});

test('R16: index.html uses one ?v= for every file; style.css fonts carry it too', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const versions = Array.from(html.matchAll(/\?v=([^"'&\s]+)/g), (m) => m[1]);
  assert.ok(versions.length >= 6, `only ${versions.length} versioned URLs`);
  assert.deepStrictEqual(Array.from(new Set(versions)), [versions[0]], `mixed versions: ${versions.join(', ')}`);
  for (const file of ['style.css', 'app.js', 'go-engine.js', 'map-graph.js', 'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css']) {
    assert.ok(html.includes(`${file}?v=${versions[0]}`), `${file} without ?v=${versions[0]}`);
  }
  const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  const fontUrls = Array.from(css.matchAll(/url\("(vendor\/fonts\/[^"]+)"\)/g), (m) => m[1]);
  assert.ok(fontUrls.length > 0);
  for (const u of fontUrls) assert.ok(u.endsWith(`.woff2?v=${versions[0]}`), u);
});

test('R16: preset JSON requests carry ASSET_VERSION (its own generation)', async () => {
  assert.ok(typeof SGM.ASSET_VERSION === 'string' && /^\w+$/.test(SGM.ASSET_VERSION), `ASSET_VERSION ${SGM.ASSET_VERSION}`);
  const requested = [];
  SGM.setPresetFetcher(async (url) => {
    requested.push(url);
    return readPreset(url);
  });
  for (const p of SGM.PRESETS) {
    SGM.clearCaches();
    await withFetch(noNetwork(), () => SGM.generateStreetGoBoard(p.query, { targetNodes: 36 }, null, { allowNetwork: false }));
  }
  assert.deepStrictEqual(requested, SGM.PRESETS.map((p) => `${p.file}?v=${SGM.ASSET_VERSION}`));
  SGM.setPresetFetcher(localPresetFetcher);
  SGM.clearCaches();
});

// ---------------------------------------------------------------------------
// Stone markers: per-point diameter and the point a click means

// Web Mercator pixels at zoom z (what Leaflet's map.project gives, unrounded)
function projectPx(lat, lon, z) {
  const scale = 256 * Math.pow(2, z);
  const s = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale
  };
}

function boardScreen(nodes, z) {
  const points = new Map();
  const neighbors = new Map();
  for (const [id, n] of nodes) {
    points.set(id, projectPx(n.lat, n.lon, z));
    neighbors.set(id, n.neighbors);
  }
  return { points, neighbors };
}

test('stones: diameter = min(base, max(0.7 base, 0.8 x nearest road neighbour)), whole px', () => {
  assert.strictEqual(SGM.stoneDiameterPx(17, 100), 17);
  assert.strictEqual(SGM.stoneDiameterPx(17, 7.8), 12); // floor 11.9
  assert.strictEqual(SGM.stoneDiameterPx(17, 18), 14); // 14.4
  assert.strictEqual(SGM.stoneDiameterPx(17, 21.25), 17); // exactly the base
  assert.strictEqual(SGM.stoneDiameterPx(13, 0), 9); // same spot: floor 9.1
  assert.strictEqual(SGM.stoneDiameterPx(22, Infinity), 22); // no neighbour
  assert.strictEqual(SGM.stoneDiameterPx(22, NaN), 22);
  assert.strictEqual(SGM.stoneDiameterPx(0, 10), 0);
});

test('stones: per-point diameters use the nearest road-connected neighbour only', () => {
  const points = new Map([
    ['a', { x: 0, y: 0 }],
    ['b', { x: 10, y: 0 }],
    ['c', { x: 100, y: 0 }],
    ['d', { x: 5, y: 1 }], // close to a and b, but no road to them
    ['e', { x: 300, y: 0 }]
  ]);
  const neighbors = new Map([
    ['a', new Set(['b'])],
    ['b', new Set(['a', 'c'])],
    ['c', new Set(['b', 'missing'])],
    ['d', new Set()],
    ['e', new Set(['e'])] // a self loop is not a neighbour
  ]);
  const sizes = SGM.nodeStoneDiameters(points, neighbors, 22);
  assert.deepStrictEqual(Array.from(sizes), [['a', 15], ['b', 15], ['c', 22], ['d', 22], ['e', 22]]);
  // Twice the scale (one zoom level in): the distances double
  const points2 = new Map(Array.from(points, ([id, p]) => [id, { x: p.x * 2, y: p.y * 2 }]));
  assert.strictEqual(SGM.nodeStoneDiameters(points2, neighbors, 22).get('a'), 16);
  assert.strictEqual(SGM.nodeStoneDiameters(new Map(), neighbors, 22).size, 0);
  assert.strictEqual(SGM.nodeStoneDiameters(points, null, 22).get('a'), 22);
});

test('stones: click picks the nearest point whose circle holds the press, else the marker hit', () => {
  // Two points 7.8 px apart (as on the Kyoto board at zoom 14), both 12 px
  const cands = [{ id: 'A', x: 0, y: 0, diameter: 12 }, { id: 'B', x: 7.8, y: 0, diameter: 12 }];
  // B's centre, though A's marker (on top) got the event
  assert.strictEqual(SGM.pickNodeAtPoint({ x: 7.8, y: 0 }, cands, 'A'), 'B');
  assert.strictEqual(SGM.pickNodeAtPoint({ x: 2, y: 1 }, cands, 'B'), 'A');
  // Exactly half way: the marker that got the event
  assert.strictEqual(SGM.pickNodeAtPoint({ x: 3.9, y: 0 }, cands, 'A'), 'A');
  assert.strictEqual(SGM.pickNodeAtPoint({ x: 3.9, y: 0 }, cands, 'B'), 'B');
  // Outside every circle (e.g. a marker's square corner): the marker that got the event
  assert.strictEqual(SGM.pickNodeAtPoint({ x: -5, y: -5 }, cands, 'A'), 'A');
  assert.strictEqual(SGM.pickNodeAtPoint({ x: 1, y: 0 }, [], 'B'), 'B');
  assert.strictEqual(SGM.pickNodeAtPoint({ x: NaN, y: 0 }, cands, 'B'), 'B');
  assert.strictEqual(SGM.pickNodeAtPoint(null, cands, 'B'), 'B');
  // A point with no size never takes a click
  assert.strictEqual(SGM.pickNodeAtPoint({ x: 0, y: 0 }, [{ id: 'A', x: 0, y: 0, diameter: 0 }, cands[1]], 'B'), 'B');
  // The edge of a circle still counts
  assert.strictEqual(SGM.pickNodeAtPoint({ x: 6, y: 0 }, [{ id: 'A', x: 0, y: 0, diameter: 12 }], 'Z'), 'A');
  assert.strictEqual(SGM.pickNodeAtPoint({ x: 6.01, y: 0 }, [{ id: 'A', x: 0, y: 0, diameter: 12 }], 'Z'), 'Z');
});

test('stones: Kyoto 81 points, zooms 13-18 and fractional: sizes in range, centre clicks hit their own point', async () => {
  SGM.clearCaches();
  const board = await withFetch(noNetwork(), () =>
    SGM.generateStreetGoBoard('京都 四条烏丸', { targetNodes: 81 }, null, { allowNetwork: false }));
  const BASE = [[13, 13], [14, 17], [15, 22], [16, 27], [17, 32], [18, 36]];
  const baseAt = (z) => {
    if (z <= 13) return 13;
    if (z >= 18) return 36;
    for (let i = 1; i < BASE.length; i++) {
      if (z <= BASE[i][0]) {
        const [z0, p0] = BASE[i - 1];
        const [z1, p1] = BASE[i];
        return Math.round(p0 + ((z - z0) / (z1 - z0)) * (p1 - p0));
      }
    }
    return 36;
  };
  let shrunk = 0;
  for (const z of [13, 14, 14.25, 15.5, 16, 17.75, 18]) {
    const base = baseAt(z);
    const { points, neighbors } = boardScreen(board.nodes, z);
    const sizes = SGM.nodeStoneDiameters(points, neighbors, base);
    assert.strictEqual(sizes.size, board.nodes.size);
    for (const [id, px] of sizes) {
      const p = points.get(id);
      let nearest = Infinity;
      for (const nb of board.nodes.get(id).neighbors) {
        const q = points.get(nb);
        nearest = Math.min(nearest, Math.hypot(q.x - p.x, q.y - p.y));
      }
      assert.ok(px <= base && px >= Math.round(base * 0.7), `z${z} ${id}: ${px} (base ${base})`);
      assert.ok(px <= Math.max(Math.round(base * 0.7), nearest * 0.8 + 0.5), `z${z} ${id}: ${px} near ${nearest}`);
      if (px < base) shrunk++;
    }
    // Clicking exactly at a point's drawn (rounded) centre plays there, whichever
    // overlapping marker got the event
    const cands = Array.from(points, ([id, p]) => ({ id, x: Math.round(p.x), y: Math.round(p.y), diameter: sizes.get(id) }));
    for (const c of cands) {
      const sameSpot = cands.some((o) => o.id !== c.id && o.x === c.x && o.y === c.y);
      if (sameSpot) continue;
      const overlapping = cands.filter((o) => Math.hypot(o.x - c.x, o.y - c.y) <= o.diameter / 2);
      for (const hit of overlapping) {
        assert.strictEqual(SGM.pickNodeAtPoint({ x: c.x, y: c.y }, cands, hit.id), c.id, `z${z}: ${c.id} via ${hit.id}`);
      }
    }
  }
  assert.ok(shrunk > 0, 'no point was made smaller on the Kyoto board');
  SGM.clearCaches();
});

// ---------------------------------------------------------------------------
(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    const start = Date.now();
    try {
      await t.fn();
      passed++;
      console.log(`ok   ${t.name} (${Date.now() - start} ms)`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${t.name}`);
      console.log(`     ${(err && err.stack) || err}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`);
  process.exit(failed ? 1 : 0);
})();
