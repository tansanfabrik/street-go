#!/usr/bin/env node
// Dependency-free tests for Street Go. Run: node tests/run.js
'use strict';

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const { GraphGoEngine, komiForNodeCount, humanColorForMode, isCpuTurn, undoStepsForActors } = require(path.join(ROOT, 'go-engine.js'));
const SGM = require(path.join(ROOT, 'map-graph.js'));
// Road requests: the retry after every server failed waits 5 ms here (10 s in the app)
const TEST_NET_TIMINGS = { retryWaitMs: 5, minRequestMs: 0 };
SGM.setNetworkTimings(TEST_NET_TIMINGS);

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

// Nodes of several separate parts in one map (ids must not clash)
function joinParts(...parts) {
  const nodes = new Map();
  for (const part of parts) for (const [id, n] of part) nodes.set(id, n);
  return nodes;
}
function pathGraph(ids) {
  const nodes = new Map(ids.map((id, i) => [id, { id, lat: 0, lon: i, neighbors: new Set() }]));
  for (let i = 1; i < ids.length; i++) {
    nodes.get(ids[i - 1]).neighbors.add(ids[i]);
    nodes.get(ids[i]).neighbors.add(ids[i - 1]);
  }
  return nodes;
}

test('engine: a point with five roads is captured when all five neighbours are taken (C8)', () => {
  // Wheel: hub H joined to rim r0..r4, the rim is a ring
  const nodes = new Map();
  const add = (id) => nodes.set(id, { id, lat: 0, lon: 0, neighbors: new Set() });
  const link = (a, b) => { nodes.get(a).neighbors.add(b); nodes.get(b).neighbors.add(a); };
  add('H');
  for (let k = 0; k < 5; k++) add(`r${k}`);
  for (let k = 0; k < 5; k++) { link('H', `r${k}`); link(`r${k}`, `r${(k + 1) % 5}`); }
  const e = new GraphGoEngine(nodes);
  setup(e, [['W', 'H'], ['B', 'r0'], ['B', 'r1'], ['B', 'r2'], ['B', 'r3']]);
  assert.strictEqual(e.getGroup('H').liberties.size, 1);
  if (e.turn !== 'B') e.pass();
  const r = e.playMove('r4');
  assert.ok(r.ok);
  assert.deepStrictEqual(r.capturedIds, ['H']);
  assert.strictEqual(e.board.get('H'), null);
  assert.strictEqual(e.getGroup('r4').liberties.size, 1);
});

test('engine: separate parts of one board share the turn, the position history and the score (C8, S11)', () => {
  // Part A: the ko shape of the test above; part B: a 3-point road b0-b1-b2
  const nodes = joinParts(makeGrid(4, 3), pathGraph(['b0', 'b1', 'b2']));
  const e = new GraphGoEngine(nodes);
  setup(e, [
    ['B', '1,0'], ['W', '2,0'],
    ['B', '0,1'], ['W', '3,1'],
    ['B', '1,2'], ['W', '2,2'],
    ['W', '1,1']
  ]);
  if (e.turn !== 'B') e.pass();
  assert.strictEqual(e.playMove('2,1').capturedCount, 1);
  assert.strictEqual(e.playMove('1,1').reason, 'ko', 'immediate retake is the same whole-board position');
  // a move in the other part changes the whole position: the retake is then allowed
  assert.ok(e.playMove('b0').ok); // W in part B
  assert.ok(e.playMove('b2').ok); // B in part B
  assert.ok(e.playMove('1,1').ok, 'retake after moves in the other part');
  // Score: part B alone (fresh board): a black stone in the middle owns both ends
  const f = new GraphGoEngine(joinParts(makeGrid(2, 2), pathGraph(['b0', 'b1', 'b2'])), { komi: 0.5 });
  assert.ok(f.playMove('b1').ok);
  const sc = f.computeScore();
  assert.strictEqual(sc.blackStones, 1);
  assert.strictEqual(sc.blackTerritory, 2, 'b0 and b2');
  assert.strictEqual(sc.whiteTerritory, 0, 'the empty part A belongs to nobody');
  assert.strictEqual(sc.blackTotal, 3);
  assert.strictEqual(sc.winner, 'B');
});

test('engine: the CPU passes when it has no legal move or only its own eyes (fixed positions)', () => {
  // x0 - x1 - x2 with White on x1: Black cannot play (both ends would be suicide)
  const e = new GraphGoEngine(pathGraph(['x0', 'x1', 'x2']));
  e.pass(); // White to move
  assert.ok(e.playMove('x1').ok);
  assert.strictEqual(e.turn, 'B');
  assert.strictEqual(e.simulateMove('x0', 'B').reason, 'suicide');
  for (let i = 0; i < 20; i++) assert.strictEqual(e.chooseCpuMove('B'), null);
  // White's only moves fill its own eyes: it passes too
  for (let i = 0; i < 20; i++) assert.strictEqual(e.chooseCpuMove('W'), null);
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

test('buildRoadGraph keeps only the largest connected part; the others go, counted', () => {
  // Main 6x6 grid plus a separate 3x3 island ~500 m away, both inside the drawn bounds.
  // Grid corners have degree 2 and are contracted, so the main grid yields 32 points and
  // the island 5. A lone 64 m road and a lone 20 m road: all but the main grid go.
  const els = gridElements(6, 35.0, 135.0, 1000).concat(gridElements(3, 35.0, 135.009, 5000));
  els.push({ type: 'node', id: 9001, lat: 35.0055, lon: 135.0105 }, { type: 'node', id: 9002, lat: 35.0055, lon: 135.0112 });
  els.push({ type: 'way', id: 9000, nodes: [9001, 9002] });
  els.push({ type: 'node', id: 9011, lat: 35.0045, lon: 135.0105 }, { type: 'node', id: 9012, lat: 35.0045, lon: 135.0105 + 20 / 91150 });
  els.push({ type: 'way', id: 9010, nodes: [9011, 9012] });
  const bounds = { south: 34.999, north: 35.006, west: 134.999, east: 135.012 };
  const g = SGM.buildRoadGraph(els, 35.003, 135.006, { targetNodes: 81, mergeRadiusMeters: 5, bounds });
  assert.strictEqual(g.stats.nodeCount, 32);
  assert.deepStrictEqual(g.stats.componentSizes, [32]);
  assert.strictEqual(g.stats.partsDropped, 3);
  assert.ok(!g.edges.some((e) => e.wayIds.includes(9000) || e.wayIds.includes(9010)), 'the lone roads go');
  assert.ok(g.stats.coverage.droppedM.smallComponent > 84 + 400, 'the island and the lone roads are counted as left out');
  for (const n of g.nodes.values()) assert.ok(n.neighbors.size > 0);
  assert.strictEqual(g.stats.quality.ok, true);
  // Six separate 3-point parts (rings of 188 m) next to a small grid: only the grid stays
  const k = 111195 * Math.cos((35 * Math.PI) / 180);
  const many = gridElements(4, 35.0, 135.0, 1000);
  for (let r = 0; r < 6; r++) {
    const cx = 135.0 + (400 + r * 120) / k;
    const ids = [];
    for (let a = 0; a < 8; a++) {
      const id = 20000 + r * 10 + a;
      many.push({ type: 'node', id, lat: 35.001 + (30 * Math.sin((a * Math.PI) / 4)) / 111195, lon: cx + (30 * Math.cos((a * Math.PI) / 4)) / k });
      ids.push(id);
    }
    many.push({ type: 'way', id: 30000 + r, nodes: ids.concat([ids[0]]) });
  }
  const g2 = SGM.buildRoadGraph(many, 35.0, 135.0, { mergeRadiusMeters: 5, dropAreaOutlines: false, bounds: { south: 34.999, north: 35.004, west: 134.999, east: 135.0 + 1200 / k } });
  assert.strictEqual(g2.stats.components, 1);
  assert.strictEqual(g2.stats.partsDropped, 6);
  assert.deepStrictEqual(g2.stats.quality.warnings, []);
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

test('validateOverpassJson: remark, missing nodes, bad coordinates and huge responses', () => {
  assert.throws(() => SGM.validateOverpassJson({ remark: 'runtime error: timeout', elements: [] }), (e) => e.kind === 'incomplete');
  // A remark with data: the server cut the query short, so roads may be missing (S14)
  assert.throws(() => SGM.validateOverpassJson({ remark: 'runtime error: Query timed out', elements: gridElements(3, 35, 135, 1) }),
    (e) => e.kind === 'incomplete' && /打ち切られました/.test(e.message));
  // A way that refers to a node not in the response
  const missing = gridElements(3, 35, 135, 1).filter((el) => !(el.type === 'node' && el.id === 5));
  assert.throws(() => SGM.validateOverpassJson({ elements: missing }), (e) => e.kind === 'incomplete' && /道の点が欠けています/.test(e.message));
  assert.throws(() => SGM.validateOverpassJson({ elements: [{ type: 'node', id: 1, lat: NaN, lon: 1 }] }), (e) => e.kind === 'incomplete');
  assert.throws(() => SGM.validateOverpassJson({ elements: [{ type: 'node', id: 1, lat: 1 }] }), (e) => e.kind === 'incomplete');
  assert.throws(() => SGM.validateOverpassJson(null), (e) => e.kind === 'incomplete');
  const huge = { elements: new Array(SGM.MAX_OVERPASS_ELEMENTS + 1).fill({ type: 'way', id: 1, nodes: [] }) };
  assert.throws(() => SGM.validateOverpassJson(huge), (e) => e.kind === 'too-many');
  assert.strictEqual(SGM.validateOverpassJson({ elements: [] }).cacheable, true);
  assert.strictEqual(SGM.validateOverpassJson({ elements: gridElements(3, 35, 135, 1) }).cacheable, true);
});

test('Overpass endpoints: only overpass-api.de (more are added one per line)', () => {
  assert.deepStrictEqual(SGM.OVERPASS_ENDPOINTS, ['https://overpass-api.de/api/interpreter']);
  const src = fs.readFileSync(path.join(ROOT, 'map-graph.js'), 'utf8');
  assert.ok(!src.includes('private.coffee'), 'private.coffee is gone');
});

// Run fn with a second (test) server after the real one, then restore the list
async function withTwoServers(fn) {
  const extra = 'https://overpass.test.invalid/api/interpreter';
  SGM.OVERPASS_ENDPOINTS.push(extra);
  try {
    return await fn(SGM.OVERPASS_ENDPOINTS.slice());
  } finally {
    SGM.OVERPASS_ENDPOINTS.splice(SGM.OVERPASS_ENDPOINTS.indexOf(extra), 1);
  }
}

test('Overpass: busy answers (429 / 502 / 503 / 504) go on to the next server; all failed: once more after a wait, then "busy"', async () => {
  await withTwoServers(async (servers) => {
    for (const status of [429, 502, 503, 504]) {
      SGM.clearCaches();
      const urls = [];
      const msgs = [];
      const err = await withFetch(async (url) => { urls.push(url); return jsonResponse(status, {}); }, () =>
        rejectsKind(SGM.fetchOverpassRoads(35, 135, 300, { report: (m) => msgs.push(m) }), 'busy'));
      assert.deepStrictEqual(urls, servers.concat(servers), `HTTP ${status}: in order, then the whole list once more`);
      assert.ok(err.message.includes('混雑') && err.message.includes(`HTTP ${status}`), err.message);
      assert.ok(msgs.some((m) => m.includes('別のサーバーに切り替えています')), msgs.join('|'));
      assert.ok(msgs.some((m) => m.includes('もう一度試します')), msgs.join('|'));
    }
    // a busy first server, a good second one: its data, cached
    SGM.clearCaches();
    const urls = [];
    const els = gridElements(3, 35, 135, 1);
    const got = await withFetch(async (url) => {
      urls.push(url);
      return urls.length === 1 ? jsonResponse(429, {}) : jsonResponse(200, { elements: els });
    }, () => SGM.fetchOverpassRoads(35, 135, 300));
    assert.strictEqual(got.length, els.length);
    assert.deepStrictEqual(urls, servers);
    assert.ok(SGM.findCachedRoads(35, 135, 300));
  });
  SGM.clearCaches();
});

test('Overpass: timeouts, failed connections and other 5xx go on too ("network"); other 4xx stop at once', async () => {
  await withTwoServers(async (servers) => {
    SGM.clearCaches();
    let calls = 0;
    let err = await withFetch(async () => { calls++; throw new TypeError('Failed to fetch'); }, () =>
      rejectsKind(SGM.fetchOverpassRoads(35, 135, 300), 'network'));
    assert.strictEqual(calls, 2 * servers.length);
    assert.ok(/通信エラー: 接続エラー/.test(err.message), err.message);
    // a server that never answers: given up after perServerMs
    SGM.setNetworkTimings({ ...TEST_NET_TIMINGS, perServerMs: 30 });
    calls = 0;
    const hang = (url, opts) => new Promise((resolve, reject) => {
      calls++;
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    err = await withFetch(hang, () => rejectsKind(SGM.fetchOverpassRoads(35, 135, 300), 'network'));
    assert.strictEqual(calls, 2 * servers.length);
    assert.ok(/通信エラー: タイムアウト/.test(err.message), err.message);
    SGM.setNetworkTimings(TEST_NET_TIMINGS);
    calls = 0;
    await withFetch(async () => { calls++; return jsonResponse(500, {}); }, () => rejectsKind(SGM.fetchOverpassRoads(35, 135, 300), 'network'));
    assert.strictEqual(calls, 2 * servers.length);
    calls = 0;
    await withFetch(async () => { calls++; return jsonResponse(400, {}); }, () => rejectsKind(SGM.fetchOverpassRoads(35, 135, 300), 'network'));
    assert.strictEqual(calls, 1, 'a refused query is not sent again');
  });
  SGM.clearCaches();
});

test('Overpass: no second round without time for the wait; a cancel during the wait sends nothing more', async () => {
  // the whole generation has 100 s (here 50 ms): no time for the wait -> one round only
  SGM.clearCaches();
  SGM.setNetworkTimings({ ...TEST_NET_TIMINGS, totalMs: 50, retryWaitMs: 100, minRequestMs: 1 });
  let calls = 0;
  await withFetch(async () => { calls++; return jsonResponse(429, {}); }, () => rejectsKind(SGM.fetchOverpassRoads(35, 135, 300), 'busy'));
  assert.strictEqual(calls, SGM.OVERPASS_ENDPOINTS.length);
  // a cancel while waiting for the second round
  SGM.setNetworkTimings({ ...TEST_NET_TIMINGS, retryWaitMs: 300 });
  calls = 0;
  const ac = new AbortController();
  const msgs = [];
  const p = withFetch(async () => { calls++; return jsonResponse(504, {}); }, () =>
    rejectsKind(SGM.fetchOverpassRoads(35, 135, 300, { signal: ac.signal, report: (m) => msgs.push(m) }), 'aborted'));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(msgs.some((m) => m.includes('10秒') || m.includes('秒後にもう一度試します')), msgs.join('|'));
  ac.abort();
  await p;
  await new Promise((r) => setTimeout(r, 350));
  assert.strictEqual(calls, SGM.OVERPASS_ENDPOINTS.length, 'nothing sent after the cancel');
  SGM.setNetworkTimings(TEST_NET_TIMINGS);
  SGM.clearCaches();
});

test('incomplete Overpass responses are not cached and make no board; good ones are cached', async () => {
  SGM.clearCaches();
  let calls = 0;
  const bodies = [
    { remark: 'runtime error', elements: [] },
    { remark: 'runtime error: Query timed out in "query" at line 3', elements: gridElements(4, 35, 135, 1) },
    { elements: gridElements(4, 35, 135, 1).filter((el) => !(el.type === 'node' && el.id === 6)) }
  ];
  for (const body of bodies) {
    await withFetch(async () => { calls++; return jsonResponse(200, body); }, async () => {
      await rejectsKind(SGM.fetchOverpassRoads(35, 135, 300), 'incomplete');
      // the drawn-range generation stops with the same error (the previous game stays)
      await rejectsKind(SGM.generateStreetGoBoardInBounds({ south: 34.999, north: 35.004, west: 134.999, east: 135.004 }, { mergeRadiusMeters: 5 }), 'incomplete');
    });
  }
  assert.strictEqual(calls, 6);
  assert.strictEqual(SGM.findCachedRoads(35, 135, 300), null);
  // complete data but too few roads: a different error
  await withFetch(async () => jsonResponse(200, { elements: gridElements(2, 35, 135, 1) }), () =>
    rejectsKind(SGM.generateStreetGoBoardInBounds({ south: 34.999, north: 35.002, west: 134.999, east: 135.002 }, { mergeRadiusMeters: 5 }), 'too-few'));
  SGM.clearCaches();

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

// Synthetic OSM elements in local metres around (35, 135): ways as lists of [x, y] points;
// a point given as a number is a shared node id from `shared` ({ id: [x, y] })
const K35 = 111195 * Math.cos((35 * Math.PI) / 180);
function metreWays(ways, shared = {}) {
  const els = [];
  const ll = ([x, y]) => ({ lat: 35 + y / 111195, lon: 135 + x / K35 });
  for (const [id, p] of Object.entries(shared)) els.push({ type: 'node', id: Number(id), ...ll(p) });
  let nid = 100000;
  ways.forEach((pts, i) => {
    const ids = pts.map((p) => {
      if (typeof p === 'number') return p;
      const id = nid++;
      els.push({ type: 'node', id, ...ll(p) });
      return id;
    });
    els.push({ type: 'way', id: 1 + i, nodes: ids });
  });
  return els;
}
function metreBounds(x0, y0, x1, y1) {
  return { south: 35 + y0 / 111195, north: 35 + y1 / 111195, west: 135 + x0 / K35, east: 135 + x1 / K35 };
}
function toMetres(lat, lon) {
  return [(lon - 135) * K35, (lat - 35) * 111195];
}
// Board points of a kind
function kindsOf(g, kind) {
  return Array.from(g.nodes.values()).filter((n) => n.kind === kind);
}
function onFrame(n, b) {
  const E = 1e-9;
  return Math.abs(n.lat - b.south) < E || Math.abs(n.lat - b.north) < E || Math.abs(n.lon - b.west) < E || Math.abs(n.lon - b.east) < E;
}
// Every drawn line and road course stays within maxM metres of the input roads
function assertEdgesOnRoads(g, els, maxM, label) {
  const nodes = new Map(els.filter((e) => e.type === 'node').map((e) => [e.id, toMetres(e.lat, e.lon)]));
  const segs = [];
  for (const w of els) if (w.type === 'way') for (let i = 1; i < w.nodes.length; i++) segs.push([nodes.get(w.nodes[i - 1]), nodes.get(w.nodes[i])]);
  for (const e of g.edges) {
    for (const coords of [e.coords, e.roadCoords]) {
      const pts = coords.map(([la, lo]) => toMetres(la, lo));
      for (let i = 1; i < pts.length; i++) {
        for (let t = 0; t <= 1; t += 0.1) {
          const q = [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
          const d = Math.min(...segs.map(([a, b]) => pointSegDist(q, a, b)));
          assert.ok(d <= maxM, `${label}: ${e.u}-${e.v} is ${d.toFixed(1)} m off the roads`);
        }
      }
    }
  }
}

// A street grid (blocks of `step` m, -half..half) with shared nodes at the crossings: one
// way per row and per column. Returns { shared, ways, id(x, y) }.
function sharedGrid(half = 200, step = 100) {
  const shared = {};
  const at = new Map();
  let nid = 1;
  for (let y = -half; y <= half; y += step) for (let x = -half; x <= half; x += step) { shared[nid] = [x, y]; at.set(`${x},${y}`, nid++); }
  const ways = [];
  const line = [];
  for (let v = -half; v <= half; v += step) line.push(v);
  for (const y of line) ways.push(line.map((x) => at.get(`${x},${y}`)));
  for (const x of line) ways.push(line.map((y) => at.get(`${x},${y}`)));
  return { shared, ways, id: (x, y) => at.get(`${x},${y}`) };
}

test('bridges: roads crossing without a shared node both stay, unjoined, with no point at the crossing', () => {
  // An elevated road crossing a 5 x 5 street grid diagonally (mid-block, y = x + 50) without
  // shared nodes, from W (-200, -150) on the west street to E (150, 200) on the north street
  const { shared, ways, id } = sharedGrid();
  shared[500] = [-200, -150];
  shared[501] = [150, 200];
  ways[5] = [id(-200, -200), 500, id(-200, -100), id(-200, 0), id(-200, 100), id(-200, 200)];
  ways[4] = [id(-200, 200), id(-100, 200), id(0, 200), id(100, 200), 501, id(200, 200)];
  ways.push([500, 501]); // the elevated road (way id 11)
  const els = metreWays(ways, shared);
  const b = metreBounds(-230, -230, 230, 230);
  const g = SGM.buildRoadGraph(els, 35, 135, { mergeRadiusMeters: 5, bounds: b });
  const elevated = g.edges.filter((e) => e.wayIds.includes(11));
  assert.strictEqual(elevated.length, 1, 'the elevated road runs from W to E');
  for (const x of [elevated[0].u, elevated[0].v]) assert.strictEqual(g.nodes.get(x).kind, 'junction');
  // its crossings with the grid streets: no point there, and recorded as bridges
  assert.strictEqual(g.bridges.length, 6, `${g.bridges.length} bridges`);
  for (const br of g.bridges) {
    const p = toMetres(br.lat, br.lon);
    for (const n of g.nodes.values()) {
      const q = toMetres(n.lat, n.lon);
      assert.ok(Math.hypot(p[0] - q[0], p[1] - q[1]) > 10, `point ${n.id} sits at a crossing`);
    }
    assert.ok(br.overCoords.length >= 2);
    assert.strictEqual(g.edges[br.over].wayIds.includes(11), true, 'the longer road (the elevated one) is on top');
  }
  assert.strictEqual(SGM.countEdgeCrossings(g.nodes, g.edges), g.stats.bridges);
  assertEdgesOnRoads(g, els, 8, 'bridges');
  // A crossing road with no link to the rest is another part: not used
  const lone = metreWays(sharedGrid().ways.concat([[[-260, -210], [200, 250]]]), sharedGrid().shared);
  const g2 = SGM.buildRoadGraph(lone, 35, 135, { mergeRadiusMeters: 5, bounds: metreBounds(-280, -280, 280, 280) });
  assert.strictEqual(g2.edges.filter((e) => e.wayIds.includes(11)).length, 0);
  assert.strictEqual(g2.bridges.length, 0);
});

test('degree: five or six roads at one junction all stay (no cap)', () => {
  // Hub with 6 spokes ending on a ring road
  const shared = { 1: [0, 0] };
  const ringIds = [];
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3;
    shared[10 + k] = [150 * Math.cos(a), 150 * Math.sin(a)];
    ringIds.push(10 + k);
  }
  const ways = ringIds.map((rid) => [1, rid]);
  ways.push(ringIds.concat([ringIds[0]]));
  const els = metreWays(ways, shared);
  const g = SGM.buildRoadGraph(els, 35, 135, { mergeRadiusMeters: 30, bounds: metreBounds(-300, -300, 300, 300) });
  const hub = Array.from(g.nodes.values()).find((n) => Math.hypot(...toMetres(n.lat, n.lon)) < 1);
  assert.ok(hub, 'hub point');
  assert.strictEqual(hub.neighbors.size, 6);
  assert.strictEqual(g.stats.maxDegree, 6);
  assert.strictEqual(g.nodes.size, 7);
  assert.strictEqual(g.edges.length, 12);
});

test('dead ends: a T junction with a 20 m dead end keeps all 4 points at the default 30 m merge (S1)', () => {
  const els = metreWays([[[-150, 0], 1, [150, 0]], [1, [0, 20]]], { 1: [0, 0] });
  const g = SGM.buildRoadGraph(els, 35, 135, { bounds: metreBounds(-200, -100, 200, 100) });
  assert.strictEqual(g.nodes.size, 4);
  assert.strictEqual(g.edges.length, 3);
  assert.strictEqual(kindsOf(g, 'deadEnd').length, 3);
  const spur = g.edges.find((e) => e.wayIds.includes(2));
  assert.ok(Math.abs(spur.length - 20) < 0.5, `the 20 m dead end is ${spur.length} m`);
  // and with a merge radius of 5 m: the same board
  const g5 = SGM.buildRoadGraph(els, 35, 135, { mergeRadiusMeters: 5, bounds: metreBounds(-200, -100, 200, 100) });
  assert.strictEqual(g5.nodes.size, 4);
});

test('dead ends: off removes dead-end branches repeatedly; junctions left by the frame always stay', () => {
  // A grid with a branching dead-end tree at (100,100): (100,100)-(150,150)-(180,150) and
  // (150,150)-(150,190). The frame cuts the grid's west column off (x = -180): the rows are
  // used up to their junctions at x = -100.
  const grid = sharedGrid();
  grid.shared[100] = [150, 150];
  grid.ways.push([grid.id(100, 100), 100, [180, 150]], [100, [150, 190]]);
  const els = metreWays(grid.ways, grid.shared);
  const b = metreBounds(-180, -230, 230, 230);
  const on = SGM.buildRoadGraph(els, 35, 135, { mergeRadiusMeters: 5, bounds: b });
  const off = SGM.buildRoadGraph(els, 35, 135, { mergeRadiusMeters: 5, includeDeadEnds: false, bounds: b });
  assert.strictEqual(kindsOf(on, 'deadEnd').length, 2, 'the two ends of the tree');
  assert.strictEqual(kindsOf(off, 'deadEnd').length, 0, 'no dead end is left when they are removed');
  assert.strictEqual(off.stats.deadEndsRemoved, on.nodes.size - off.nodes.size);
  assert.ok(!Array.from(off.nodes.values()).some((n) => { const p = toMetres(n.lat, n.lon); return Math.hypot(p[0] - 150, p[1] - 150) < 1; }), 'the tree junction goes too');
  for (const g of [on, off]) {
    assert.ok(!Array.from(g.nodes.values()).some((n) => onFrame(n, b)), 'nothing reaches the frame');
    assert.ok(!g.edges.some((e) => e.coords.some(([la, lo]) => toMetres(la, lo)[0] < -100.5)), 'no road west of x = -100');
    const west = Array.from(g.nodes.values()).filter((n) => Math.abs(toMetres(n.lat, n.lon)[0] + 100) < 0.5);
    assert.strictEqual(west.length, 5, 'the five junctions at x = -100 stay');
    // the corners keep two roads and stay points (not joined into one road)
    assert.strictEqual(west.filter((n) => n.neighbors.size === 2 && n.pinned && n.kind === 'junction').length, 2);
  }
  assert.strictEqual(off.stats.coverage.droppedM.leavingRange, 5 * 80);
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
  assert.strictEqual(urls.length, 2 * SGM.OVERPASS_ENDPOINTS.length);
  assert.ok(urls[0].includes('overpass'), 'no Nominatim request for a preset name');
  SGM.clearCaches();
});

test('defaults: merge radius 30 m, dead ends included, no cap on the roads per point', () => {
  assert.strictEqual(SGM.DEFAULT_MERGE_RADIUS_M, 30);
  assert.strictEqual(SGM.MAX_NODE_DEGREE, undefined, 'the 4-road cap is gone');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(/id="merge-radius"[^>]*max="60"[^>]*value="30"/.test(html));
  assert.ok(/<input type="checkbox" id="include-deadends" checked[^>]*\/>/.test(html), 'dead ends on by default');
  assert.ok(/<input type="checkbox" id="include-footways" autocomplete="off" \/>/.test(html));
  // buildRoadGraph without the option keeps dead ends too
  const els = metreWays([[[-150, 0], 1, [150, 0]], [1, [0, 60]]], { 1: [0, 0] });
  assert.strictEqual(SGM.buildRoadGraph(els, 35, 135, { bounds: metreBounds(-200, -100, 200, 100) }).nodes.size, 4);
});

// Board invariants shared by the preset / drawn-range tests
const KINDS = new Set(['junction', 'deadEnd', 'shape', 'midpoint']);
function assertBoardInvariants(g, b, label) {
  assert.ok(g.stats.nodeCount >= 9 && g.stats.nodeCount <= 450, `${label}: ${g.stats.nodeCount} points`);
  assertBoardInside(g, b, label);
  for (const n of g.nodes.values()) {
    assert.ok(KINDS.has(n.kind), `${label}: ${n.id} kind ${n.kind}`);
    const d = n.neighbors.size;
    if (n.kind === 'deadEnd') assert.strictEqual(d, 1, `${label}: dead end ${n.id} has ${d} roads`);
    if (n.kind === 'shape') assert.strictEqual(d, 2, `${label}: shape point ${n.id} has ${d} roads`);
    if (n.kind === 'junction') assert.ok(d >= 2, `${label}: junction ${n.id} has ${d} roads`);
    for (const nb of n.neighbors) assert.ok(g.nodes.get(nb).neighbors.has(n.id), `${label}: one-way link ${n.id}-${nb}`);
  }
  // every road joins two different points that know each other; no road twice
  const seen = new Set();
  for (const e of g.edges) {
    assert.ok(e.u !== e.v, `${label}: loop road at ${e.u}`);
    assert.ok(g.nodes.get(e.u).neighbors.has(e.v), `${label}: ${e.u}-${e.v} not in neighbours`);
    const k = [e.u, e.v].sort().join('|');
    assert.ok(!seen.has(k), `${label}: two roads ${k}`);
    seen.add(k);
    assert.ok(Array.isArray(e.wayIds) && e.wayIds.length > 0, `${label}: ${k} has no source way`);
    assert.ok(e.length > 0.5, `${label}: ${k} is ${e.length} m`);
  }
  let deg = 0;
  for (const n of g.nodes.values()) deg += n.neighbors.size;
  assert.strictEqual(deg, 2 * g.edges.length, `${label}: neighbours and roads disagree`);
  // connected parts: 3+ points each
  const seenP = new Set();
  for (const id of g.nodes.keys()) {
    if (seenP.has(id)) continue;
    let size = 0;
    const st = [id];
    seenP.add(id);
    while (st.length) {
      size++;
      for (const nb of g.nodes.get(st.pop()).neighbors) if (!seenP.has(nb)) { seenP.add(nb); st.push(nb); }
    }
    if (size === 2) {
      const e = g.edges.find((x) => x.u === id || x.v === id);
      assert.ok(e.length >= 30, `${label}: a 2-point part of ${e.length.toFixed(0)} m`);
    } else {
      assert.ok(size >= 3, `${label}: a part with ${size} points`);
    }
  }
  // no clump of shape points: never 3 or more within 20 m
  const shapes = Array.from(g.nodes.values()).filter((n) => n.kind === 'shape');
  for (const a of shapes) {
    const near = shapes.filter((o) => SGM.distanceMeters(a.lat, a.lon, o.lat, o.lon) <= 20).length;
    assert.ok(near < 3, `${label}: ${near} shape points within 20 m of ${a.id}`);
  }
  // roads leaving the frame are used up to their last junction inside: no point with one
  // road on the frame but a junction left so (pinned); every dead end has a branch of 12 m or
  // more (a pinned junction is no dead-end branch)
  for (const n of g.nodes.values()) {
    if (n.neighbors.size !== 1) continue;
    if (!n.pinned) assert.ok(!onFrame(n, b), `${label}: ${n.id} ends a road at the frame`);
    const e = g.edges.find((x) => x.u === n.id || x.v === n.id);
    const other = g.nodes.get(e.u === n.id ? e.v : e.u);
    if (other.neighbors.size === 1 || n.pinned) continue; // a 2-point road
    if (n.kind === 'deadEnd') assert.ok(e.length >= 12 - 0.01, `${label}: dead end ${n.id} on a ${e.length.toFixed(1)} m branch`);
  }
  // drawn-only pieces start at their point (short dead-end branches, points too close to
  // others); none goes to the frame
  for (const t of g.tails || []) {
    const n = g.nodes.get(t.node);
    assert.ok(n, `${label}: tail of a missing point`);
    assert.ok(Math.abs(t.coords[0][0] - n.lat) < 1e-12 && Math.abs(t.coords[0][1] - n.lon) < 1e-12);
    const tl = SGM.distanceMeters ? t.coords.slice(1).reduce((acc, c, i) => acc + SGM.distanceMeters(t.coords[i][0], t.coords[i][1], c[0], c[1]), 0) : 0;
    assert.ok(tl < 40, `${label}: a drawn-only piece of ${tl.toFixed(0)} m`);
  }
  // crossings without a shared point are all recorded as bridges (drawn with a gap)
  // (two lines of one street crossing each other get no gap: counted apart)
  assert.ok(SGM.countEdgeCrossings(g.nodes, g.edges) <= g.bridges.length + (g.stats.oneStreetCrossings || 0), `${label}: unrecorded crossing`);
  // (parts other than the largest and branches beyond the outline are left out by rule:
  // lowest on the bundled boards, Seoul 36, 0.80)
  assert.ok(g.stats.coverage.rateRoads >= 0.75, `${label}: coverage ${g.stats.coverage.rateRoads}`);
}

// The 33 boards made from a place's name (11 bundled places x 36/81/169 points, default
// settings): points and the roads joining them, as saved before the drawn-range search and the
// rectangle requests came in (tests/preset-boards.json). They must not change.
function placeBoardSignature(g) {
  const key = (n) => `${n.lat.toFixed(7)},${n.lon.toFixed(7)}`;
  const points = Array.from(g.nodes.values()).map(key).sort();
  const idx = new Map(points.map((k, i) => [k, i]));
  const edges = g.edges.map((e) => {
    const a = idx.get(key(g.nodes.get(e.u)));
    const b = idx.get(key(g.nodes.get(e.v)));
    return a < b ? [a, b] : [b, a];
  }).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  return { points, edges };
}
const PLACE_BOARDS = JSON.parse(fs.readFileSync(path.join(__dirname, 'preset-boards.json'), 'utf8'));

test('bundled presets x 36/81/169 with default settings: valid boards inside their square, unchanged points and roads', async () => {
  SGM.clearCaches();
  SGM.setPresetFetcher(localPresetFetcher);
  assert.strictEqual(SGM.PRESETS.length, 11);
  assert.strictEqual(Object.keys(PLACE_BOARDS).length, 33);
  await withFetch(noNetwork(), async () => {
    for (const p of SGM.PRESETS) {
      const data = JSON.parse(fs.readFileSync(path.join(ROOT, p.file), 'utf8'));
      assert.strictEqual(data.roadMode, 'simple', `${p.file} roadMode`);
      const size = fs.statSync(path.join(ROOT, p.file)).size;
      assert.ok(size <= 1.5 * 1024 * 1024, `${p.file} is ${size} bytes`);
      for (const target of [36, 81, 169]) {
        const label = `${p.query} ${target}`;
        const b = await SGM.generateStreetGoBoard(p.query, { targetNodes: target }, null, { allowNetwork: true });
        assertBoardInvariants(b, b.boardBounds, label);
        assertBoardInside(b, b.frameBounds, `${label} (frame)`);
        // the roads are cut to a square around the place
        const sz = SGM.rectSizeMeters(b.boardBounds);
        assert.ok(Math.abs(sz.widthM - sz.heightM) < 0.01 * sz.widthM, `${label}: ${sz.widthM} x ${sz.heightM}`);
        const saved = PLACE_BOARDS[`${p.file.replace('presets/', '').replace('.json', '')} ${target}`];
        assert.ok(saved, `${label}: no saved board`);
        const now = placeBoardSignature(b);
        assert.strictEqual(now.points.length, saved.points.length, `${label}: number of points`);
        assert.deepStrictEqual(now.points, saved.points, `${label}: points moved`);
        assert.deepStrictEqual(now.edges, saved.edges, `${label}: roads changed`);
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

test('F3: a dense 25 m grid with a 30 m merge radius keeps a board; points sit on the streets', () => {
  const g = meterGrid(12, 25, 35, 135);
  const b = SGM.buildRoadGraph(g.els, g.center[0], g.center[1], { targetNodes: 100, mergeRadiusMeters: 30 });
  assert.ok(b.stats.nodeCount >= 9, `only ${b.stats.nodeCount} points`);
  const js = kindsOf(b, 'junction');
  assert.ok(js.length >= 4);
  // every junction point lies on a street of the grid (merged points on a crossing, points
  // where overlapping lines part on the street itself)
  for (const n of js) {
    const p = [(n.lon - 135) * 111195 * Math.cos((35 * Math.PI) / 180), (n.lat - 35) * 111195];
    const offX = Math.abs(p[0] / 25 - Math.round(p[0] / 25)) * 25;
    const offY = Math.abs(p[1] / 25 - Math.round(p[1] / 25)) * 25;
    assert.ok(Math.min(offX, offY) < 0.5, `${n.id} is off the streets`);
  }
  assert.ok(isConnected(b.nodes));
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

test('F1: a small drawn square keeps its dead ends; roads leaving it end at their last junction', async () => {
  SGM.clearCaches();
  const d = seedPresetRoads('tokyo-ginza');
  const b = squareAround(d.location.lat, d.location.lon, 250);
  const g = await withFetch(noNetwork(), () => SGM.generateStreetGoBoardInBounds(b, {}, null, {}));
  assertBoardInvariants(g, b, 'ginza 250 m');
  assert.ok(g.stats.coverage.droppedM.leavingRange > 0, 'roads leaving the square are cut back');
  assert.ok(!Array.from(g.nodes.values()).some((n) => onFrame(n, b)), 'nothing reaches the frame');
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

test('F6: midpoints of long roads are never placed closer than the merge radius to another point', async () => {
  SGM.clearCaches();
  SGM.setPresetFetcher(localPresetFetcher);
  const g = await withFetch(noNetwork(), () =>
    SGM.generateStreetGoBoard('東京 銀座', { targetNodes: 361, subdivideLongRoads: true, subdivideSpacingMeters: 30 }, null, {})
  );
  assert.ok(g.stats.nodeCount >= 9);
  const mids = kindsOf(g, 'midpoint');
  assert.ok(mids.length > 0, 'some roads were split');
  for (const m of mids) {
    for (const n of g.nodes.values()) {
      if (n.id === m.id) continue;
      const dist = SGM.distanceMeters(m.lat, m.lon, n.lat, n.lon);
      assert.ok(dist >= SGM.DEFAULT_MERGE_RADIUS_M - 1e-6, `midpoint ${m.id} is ${dist.toFixed(1)} m from ${n.id}`);
    }
  }
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
  // the two pieces of the detour inside the square lead out of it: not used
  assert.strictEqual(g.edges.filter((e) => e.wayIds.includes(w - 1)).length, 0);
  assert.strictEqual(g.stats.coverage.droppedM.leavingRange, 40);
  assert.strictEqual(endA.neighbors.size, 2, 'the corner keeps its two grid roads');
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

// Everything drawn lies inside the board's rectangle (0.1 m): points, road lines and their
// courses, drawn-only pieces and the pieces drawn over bridges
function assertBoardInside(g, b, label) {
  const eLat = 0.1 / 110540;
  const eLon = 0.1 / (111320 * Math.cos((((b.south + b.north) / 2) * Math.PI) / 180));
  const inside = ([la, lo]) => la >= b.south - eLat && la <= b.north + eLat && lo >= b.west - eLon && lo <= b.east + eLon;
  for (const n of g.nodes.values()) {
    assert.ok(n.lat >= b.south && n.lat <= b.north && n.lon >= b.west && n.lon <= b.east, `${label}: point ${n.id} outside`);
  }
  for (const e of g.edges) {
    for (const c of e.coords.concat(e.roadCoords || [])) assert.ok(inside(c), `${label}: edge ${e.u}-${e.v} leaves the rectangle`);
  }
  for (const t of g.tails || []) for (const c of t.coords) assert.ok(inside(c), `${label}: a drawn-only piece from ${t.node} leaves the rectangle`);
  for (const br of g.bridges || []) for (const c of br.overCoords || []) assert.ok(inside(c), `${label}: a bridge leaves the rectangle`);
}

test('rect: landscape and portrait rectangles on bundled data make valid boards inside them', async () => {
  for (const name of ['nagoya-sakae', 'tokyo-ginza', 'kyoto-shijo-karasuma']) {
    SGM.clearCaches();
    const d = seedPresetRoads(name);
    for (const [w, h] of [[600, 300], [300, 600]]) {
      const label = `${name} ${w}x${h}`;
      const b = rectAround(d.location.lat, d.location.lon, w, h);
      const g = await withFetch(noNetwork(), () => SGM.generateStreetGoBoardInBounds(b, {}, null, { allowNetwork: false }));
      // roads cut to the drawn rectangle with its sides moved (at most 150 m each way)
      assertBoardInvariants(g, g.boardBounds, label);
      assert.deepStrictEqual(g.cutBounds, g.boardBounds);
      assertSidesMoved(g.boardBounds, b, g.stats.fit.maxShiftM, label);
      assert.deepStrictEqual(g.drawnBounds, b, `${label}: the range as drawn is kept`);
      assert.deepStrictEqual(g.customBounds, b);
      // the frame shown holds everything and lies within the rectangle the roads were cut to
      assertBoardInside(g, g.frameBounds, `${label} (frame)`);
      assertSidesMoved(g.frameBounds, g.boardBounds, 0, `${label} (frame)`, true);
      const size = SGM.rectSizeMeters(g.frameBounds);
      assert.ok(w > h ? size.widthM > size.heightM : size.heightM > size.widthM, `${label}: frame orientation`);
    }
  }
  SGM.clearCaches();
});

// Each side of `a` lies within maxM of the same side of `b` (inside: `a` within `b`)
function assertSidesMoved(a, b, maxM, label, inside = false) {
  const k = 111195 * Math.cos((((b.south + b.north) / 2) * Math.PI) / 180);
  const moved = { west: (b.west - a.west) * k, east: (a.east - b.east) * k, south: (b.south - a.south) * 111195, north: (a.north - b.north) * 111195 };
  for (const [side, m] of Object.entries(moved)) {
    if (inside) assert.ok(m <= 1e-6, `${label}: ${side} side ${m.toFixed(1)} m outside`);
    else assert.ok(Math.abs(m) <= maxM + 1, `${label}: ${side} side moved ${m.toFixed(1)} m`);
  }
  return moved;
}

function boardSignature(g) {
  return {
    pos: Array.from(g.nodes.values()).map((n) => `${n.id}:${n.lat.toFixed(7)},${n.lon.toFixed(7)}:${n.kind}`).sort(),
    edges: g.edges.map((e) => [String(e.u), String(e.v)].sort().join('-')).sort()
  };
}

test('rect: a 400 m square passed as a rectangle gives the same board as the square', async () => {
  for (const name of ['nagoya-sakae', 'tokyo-ginza']) {
    SGM.clearCaches();
    const d = seedPresetRoads(name);
    const sq = await withFetch(noNetwork(), () =>
      SGM.generateStreetGoBoardInBounds(squareAround(d.location.lat, d.location.lon, 400), {}, null, {}));
    const rc = await withFetch(noNetwork(), () =>
      SGM.generateStreetGoBoardInBounds(rectAround(d.location.lat, d.location.lon, 400, 400), {}, null, {}));
    assert.deepStrictEqual(boardSignature(rc), boardSignature(sq), `${name}: square and rectangle differ`);
    assertBoardInvariants(sq, sq.customBounds, `${name} 400 m`);
  }
  SGM.clearCaches();
});

test('rect: size limits (short side on screen, long side on the ground, aspect ratio) at the boundaries', () => {
  const c = (widthM, heightM, widthPx, heightPx) => SGM.checkDrawnRect({ widthM, heightM, widthPx, heightPx });
  assert.strictEqual(SGM.MIN_DRAW_SIDE_PX, 15);
  assert.strictEqual(SGM.MAX_DRAW_SIDE_M, 20000);
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
  assert.strictEqual(c(30000, 100, 1000, 10).kind, 'too-small');
  assert.strictEqual(c(30000, 100, 1000, 15).kind, 'too-large');
  assert.strictEqual(c(700, 100, 70, 15).kind, 'too-thin');
  // longer side on the ground: 20 km is fine, more is too large
  assert.ok(c(20000, 20000, 400, 400).ok);
  assert.ok(c(20000, 4000).ok); // metres only (no pixel checks)
  assert.ok(c(4000.1, 1000).ok, 'more than 4 km: major roads only, no longer refused');
  assert.strictEqual(c(20000.1, 4000).kind, 'too-large');
  assert.strictEqual(c(4000, 20000.1).kind, 'too-large');
  assert.ok(/一辺 20km 以内の範囲/.test(c(20000.1, 4000).message));
  assert.ok(!/正方形/.test(c(20000.1, 4000).message));
});

test('rect: generation rejects too thin / too large rectangles before any request', async () => {
  SGM.clearCaches();
  await withFetch(noNetwork(), async () => {
    const thin = await rejectsKind(SGM.generateStreetGoBoardInBounds(rectAround(35, 135, 700, 100), {}, null, {}), 'area');
    assert.ok(/細長すぎます/.test(thin.message));
    const wide = await rejectsKind(SGM.generateStreetGoBoardInBounds(rectAround(35, 135, 20100, 5000), {}, null, {}), 'area');
    assert.ok(/広すぎます/.test(wide.message));
    // the cap on the distance from the centre to the corners applies on its own
    const huge = await rejectsKind(SGM.generateStreetGoBoardInBounds(rectAround(35, 135, 25000, 25000), {}, null, {}), 'area');
    assert.strictEqual(huge.message, wide.message);
    assert.ok(SGM.rectCoverCircle(rectAround(35, 135, 20000, 20000)).halfDiagM <= SGM.MAX_DRAW_HALF_DIAG_M);
    // 8 km and 20 km pass the checks (offline here: they stop for want of data instead)
    for (const side of [8000, 19990]) {
      const r = rectAround(35, 135, side * 111000 / 111195, side * 111000 / 111195);
      const sz = SGM.rectSizeMeters(r);
      assert.ok(Math.max(sz.widthM, sz.heightM) <= 20000 && Math.max(sz.widthM, sz.heightM) >= side - 20, JSON.stringify(sz));
      await rejectsKind(SGM.generateStreetGoBoardInBounds(r, {}, null, { allowNetwork: false }), 'offline');
    }
  });
});

// The request body asks for the rectangle `b` grown by growM on every side (rounded outwards)
function assertRequestRect(body, b, growM) {
  assert.ok(!body.includes('around:'), body);
  const m = /\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\);/.exec(body);
  assert.ok(m, body);
  const [s0, w0, n0, e0] = m.slice(1).map(Number);
  const midLat = (b.south + b.north) / 2;
  const midLon = (b.west + b.east) / 2;
  const grown = [
    SGM.distanceMeters(s0, midLon, b.south, midLon),
    SGM.distanceMeters(n0, midLon, b.north, midLon),
    SGM.distanceMeters(midLat, w0, midLat, b.west),
    SGM.distanceMeters(midLat, e0, midLat, b.east)
  ];
  for (const g of grown) assert.ok(g >= growM - 0.5 && g <= growM + 1, `grown by ${g.toFixed(2)} m, not ${growM} m`);
  assert.ok(s0 < b.south && n0 > b.north && w0 < b.west && e0 > b.east);
}

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
  // one request: the rectangle grown by the sides' reach (150 m) and the margin (60 m)
  assert.strictEqual(bodies.length, 1);
  assertRequestRect(bodies[0], b, SGM.FIT_SHIFT_M + SGM.DRAW_FETCH_MARGIN_M);
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
  assertBoardInside(g, g.boardBounds, 'kyoto north');
  // offline, only rectangles the bundle holds were tried
  assert.ok(SGM.findCachedRoadsForRect(g.boardBounds, 'simple'), 'the moved rectangle lies within the bundle');
  // online too: the bundle holds the range as drawn (not + 210 m) and gives a board -> no request
  const gOn = await withFetch(async (url) => { calls++; throw new Error(`unexpected network access: ${url}`); },
    () => SGM.generateStreetGoBoardInBounds(b, {}, null, {}));
  assert.strictEqual(calls, 0);
  assert.deepStrictEqual(boardSignature(gOn), boardSignature(g));
  // A corner outside the bundle's circle (1000 x 600 m: ~1346 m) -> one Overpass request
  const b2 = rectAround(d.location.lat + north, d.location.lon, 1000, 600);
  assert.strictEqual(SGM.findCachedRoadsForRect(b2, 'simple'), null);
  const bodies = [];
  await withFetch(async (url, init) => {
    bodies.push(decodeURIComponent(init.body.replace(/^data=/, '')));
    return jsonResponse(200, { elements: d.elements });
  }, () => SGM.generateStreetGoBoardInBounds(b2, {}, null, {}));
  assert.strictEqual(bodies.length, 1);
  assertRequestRect(bodies[0], b2, SGM.FIT_SHIFT_M + SGM.DRAW_FETCH_MARGIN_M);
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
  assert.strictEqual(urls.length, 2 * SGM.OVERPASS_ENDPOINTS.length, 'every server, then once more');
  assert.ok(urls[0].includes('overpass'));
  assert.ok(SGM.findCachedRoads(35.6712, 139.765, 300) === null, 'old bundle must not be registered');

  // 2. bundle cannot be loaded at all -> still no Nominatim
  SGM.clearCaches();
  SGM.setPresetFetcher(async () => { throw new Error('timeout'); });
  urls = [];
  await withFetch(async (url) => { urls.push(url); return jsonResponse(429, {}); },
    () => rejectsKind(SGM.generateStreetGoBoard('札幌 大通公園', { targetNodes: 81 }), 'busy'));
  assert.strictEqual(urls.length, 2 * SGM.OVERPASS_ENDPOINTS.length);
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

test('stones: diameter = min(base, max(0.7 base, 0.88 x nearest road neighbour)), whole px', () => {
  assert.strictEqual(SGM.stoneDiameterPx(17, 100), 17);
  assert.strictEqual(SGM.stoneDiameterPx(17, 7.8), 12); // floor 11.9
  assert.strictEqual(SGM.stoneDiameterPx(17, 18), 16); // 15.84
  assert.strictEqual(SGM.stoneDiameterPx(17, 19.32), 17); // the base
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
  assert.strictEqual(SGM.nodeStoneDiameters(points2, neighbors, 22).get('a'), 18);
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
  const BASE = [[13, 16], [14, 20], [15, 26], [16, 32], [17, 38], [18, 43]];
  const baseAt = (z) => {
    if (z <= 13) return 16;
    if (z >= 18) return 43;
    for (let i = 1; i < BASE.length; i++) {
      if (z <= BASE[i][0]) {
        const [z0, p0] = BASE[i - 1];
        const [z1, p1] = BASE[i];
        return Math.round(p0 + ((z - z0) / (z1 - z0)) * (p1 - p0));
      }
    }
    return 43;
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
      assert.ok(px <= Math.max(Math.round(base * 0.7), nearest * 0.88 + 0.5), `z${z} ${id}: ${px} near ${nearest}`);
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
// Board edge margin, straight-through roads at the degree cap, drawn shapes.
// Places on the Kyoto board are fixed by OpenStreetMap node / way ids of the bundled data.

// Local metres around a reference latitude (same scale as the board code)
function metresProjector(lat0, lon0) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * 110540];
}

function pointSegDist(p, a, b) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const l2 = abx * abx + aby * aby;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - abx * t, p[1] - a[1] - aby * t);
}

function pointPolyDist(p, poly) {
  let m = Infinity;
  for (let i = 1; i < poly.length; i++) m = Math.min(m, pointSegDist(p, poly[i - 1], poly[i]));
  return m;
}

// A fixed drawn range south-east of Shijo-Karasuma (Karasuma-dori to Fuyacho-dori, south of
// Matsubara up to Rokkaku) on the bundled data
const KYOTO_SHAPE_RECT = { south: 34.9955, north: 35.0075, west: 135.7560, east: 135.7665 };
async function kyotoBoard81() {
  SGM.clearCaches();
  const data = seedPresetRoads('kyoto-shijo-karasuma');
  const board = await withFetch(noNetwork(), () =>
    SGM.generateStreetGoBoardInBounds(KYOTO_SHAPE_RECT, {}, null, { allowNetwork: false }));
  const osm = new Map();
  for (const el of data.elements) if (el.type === 'node') osm.set(el.id, el);
  const proj = metresProjector(data.location.lat, data.location.lon);
  // Board point closest to the middle of the given OSM nodes (a merged junction)
  const pointAt = (ids, maxM = 20) => {
    const ps = ids.map((id) => proj(osm.get(id).lat, osm.get(id).lon));
    const c = [ps.reduce((s, p) => s + p[0], 0) / ps.length, ps.reduce((s, p) => s + p[1], 0) / ps.length];
    let best = null;
    let bestD = Infinity;
    for (const n of board.nodes.values()) {
      const d = Math.hypot(proj(n.lat, n.lon)[0] - c[0], proj(n.lat, n.lon)[1] - c[1]);
      if (d < bestD) { bestD = d; best = n; }
    }
    assert.ok(bestD <= maxM, `no board point within ${maxM} m of OSM ${ids.join('/')} (nearest ${bestD.toFixed(1)} m)`);
    return best;
  };
  const edgeOf = (a, b) => board.edges.find((e) => (e.u === a && e.v === b) || (e.u === b && e.v === a));
  return { board, data, osm, proj, pointAt, edgeOf };
}

test('shape: Kyoto range puts the merged point at Karasuma x Matsubara on a real junction, lines along the roads', async () => {
  const k = await kyotoBoard81();
  // merged from 354837015 (Karasuma, east carriageway, x Matsubara) and the junction 28 m east
  const mid = k.pointAt([354837015], 30);
  const pm = k.proj(mid.lat, mid.lon);
  const pj = k.proj(k.osm.get(354837015).lat, k.osm.get(354837015).lon);
  // on one of the real junctions it was merged from (never between them)
  const realNear = k.data.elements.filter((e) => e.type === 'node').some((n) => { const q = k.proj(n.lat, n.lon); return Math.hypot(q[0] - pm[0], q[1] - pm[1]) < 1; });
  assert.ok(realNear, 'the point is on a node of the data');
  assert.ok(Math.hypot(pm[0] - pj[0], pm[1] - pj[1]) < 1 || Math.hypot(pm[0] - pj[0], pm[1] - pj[1]) > 20, 'one of the two junctions');
  // every road from it is drawn along the real roads
  const segs = [];
  for (const w of k.data.elements) {
    if (w.type !== 'way') continue;
    const pts = w.nodes.map((id) => k.proj(k.osm.get(id).lat, k.osm.get(id).lon));
    for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1], pts[i]]);
  }
  for (const e of k.board.edges.filter((x) => x.u === mid.id || x.v === mid.id)) {
    for (const [la, lo] of e.coords) {
      const q = k.proj(la, lo);
      const d = Math.min(...segs.map(([a, c]) => pointSegDist(q, a, c)));
      assert.ok(d <= 6, `${e.u}-${e.v} is ${d.toFixed(1)} m off the roads`);
    }
  }
  assert.ok(mid.neighbors.size >= 3);
  SGM.clearCaches();
});

test('shape: Kyoto range has Fuyacho-dori (near the east edge) unbroken from its south end up past Takoyakushi', async () => {
  const k = await kyotoBoard81();
  // Fuyacho-dori is two ways in the data: 30175871 ends at Nishikikoji (35.004986) and
  // 772134677 starts 10 m north of it (35.005074) without a shared node (the covered market
  // between them is not in the simple query). The two dead ends face each other: one road.
  const ways = k.data.elements.filter((el) => el.type === 'way' && (el.id === 30175871 || el.id === 772134677));
  assert.strictEqual(ways.length, 2);
  const lines = ways.map((w) => w.nodes.map((id) => k.proj(k.osm.get(id).lat, k.osm.get(id).lon)));
  const distToStreet = (p) => Math.min(...lines.map((l) => pointPolyDist(p, l)));
  const along = k.board.edges.filter((e) => (e.wayIds.includes(30175871) || e.wayIds.includes(772134677)) &&
    e.coords.every(([lat, lon]) => distToStreet(k.proj(lat, lon)) < 12));
  const joined = along.find((e) => e.wayIds.includes(30175871) && e.wayIds.includes(772134677));
  assert.ok(joined, 'one road across Nishikikoji');
  const ids = new Set();
  for (const e of along) { ids.add(e.u); ids.add(e.v); }
  const pts = Array.from(ids).map((id) => k.board.nodes.get(id)).sort((a, b) => a.lat - b.lat);
  assert.ok(pts.length >= 6, `only ${pts.length} points`);
  assert.ok(pts[0].lat < 34.9992, `southernmost point at ${pts[0].lat}`);
  assert.ok(pts[pts.length - 1].lat > 35.0060, `northernmost point at ${pts[pts.length - 1].lat}`);
  assert.ok(!pts.some((n) => n.kind === 'deadEnd' && n.lat > 35.0049 && n.lat < 35.0051), 'no dead ends at the gap');
  const seen = new Set([pts[0].id]);
  const stack = [pts[0].id];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of along) {
      const nb = e.u === cur ? e.v : e.v === cur ? e.u : null;
      if (nb && !seen.has(nb)) { seen.add(nb); stack.push(nb); }
    }
  }
  assert.ok(seen.has(pts[pts.length - 1].id), 'Fuyacho-dori is broken');
  SGM.clearCaches();
});

test('shape: Kyoto range roads from the staggered Bukkoji junction follow the streets', async () => {
  const k = await kyotoBoard81();
  // Bukkoji-dori: the road from the north meets it at 309117163, the one to the south leaves
  // at 309117162 (28 m east). Both are one point; the roads from it are drawn along the real
  // streets (Bukkoji-dori, then the side streets), not straight across the blocks.
  const p = k.pointAt([309117163, 309117162]);
  const segs = [];
  for (const w of k.data.elements) {
    if (w.type !== 'way') continue;
    const pts = w.nodes.map((id) => k.proj(k.osm.get(id).lat, k.osm.get(id).lon));
    for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1], pts[i]]);
  }
  const offRoad = (q) => Math.min(...segs.map(([a, b]) => pointSegDist(q, a, b)));
  let checked = 0;
  for (const e of k.board.edges) {
    if (e.u !== p.id && e.v !== p.id) continue;
    checked++;
    const pts = (e.u === p.id ? e.coords : e.coords.slice().reverse()).map(([lat, lon]) => k.proj(lat, lon));
    let along = 0;
    for (let i = 1; i < pts.length && along < 60; i++) {
      const L = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      for (let t = 0; t <= 1; t += 0.1) {
        const q = [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
        assert.ok(offRoad(q) <= 15, `${e.u}-${e.v} is ${offRoad(q).toFixed(1)} m off the streets ${(along + L * t).toFixed(0)} m from the point`);
      }
      along += L;
    }
  }
  assert.ok(checked >= 3, `${checked} roads at the Bukkoji point`);
  SGM.clearCaches();
});

// Nodes / edges in local metres around (35, 135) for buildDisplayShapes
function metreGraph(points, edgeList) {
  const kx = 111320 * Math.cos((35 * Math.PI) / 180);
  const ll = ([x, y]) => [35 + y / 110540, 135 + x / kx];
  const nodes = new Map();
  for (const [id, p] of Object.entries(points)) {
    const [lat, lon] = ll(p);
    nodes.set(id, { id, lat, lon, neighbors: new Set() });
  }
  const edges = edgeList.map(([u, v, via]) => {
    nodes.get(u).neighbors.add(v);
    nodes.get(v).neighbors.add(u);
    return { u, v, coords: [points[u], ...(via || []), points[v]].map(ll) };
  });
  return { nodes, edges, ll };
}

test('shape: nearly straight roads become straight lines, real corners and 5 m bows stay (item 6)', () => {
  const { nodes, edges } = metreGraph(
    { a: [0, 0], b: [100, 0], c: [0, 100], d: [20, 120], g: [0, 200], h: [100, 200] },
    [['a', 'b', [[30, 3], [70, -2]]], ['c', 'd', [[20, 100]]], ['g', 'h', [[25, 203.5], [50, 205], [75, 203.5]]]]
  );
  const out = SGM.buildDisplayShapes(nodes, edges, null);
  assert.strictEqual(out[0].coords.length, 2, 'a road within 4 m of its chord is drawn straight');
  assert.ok(out[2].coords.length >= 3, 'a road bowing 5 m keeps its bow');
  // the drawn line stays within 2.5 m of the road course
  const kx = 111320 * Math.cos((35 * Math.PI) / 180);
  const xy = ([la, lo]) => [(lo - 135) * kx, (la - 35) * 110540];
  const road = edges[2].coords.map(xy);
  for (const p of out[2].coords.map(xy)) assert.ok(pointPolyDist(p, road) <= 2.6);
  for (const p of road) assert.ok(pointPolyDist(p, out[2].coords.map(xy)) <= 2.6, 'road within 2.5 m of the line');
  assert.strictEqual(out[0].roadCoords.length, 4, 'the road course is kept');
  assert.strictEqual(out[1].coords.length, 3, 'a 20 m + 20 m corner stays');
});

test('shape: a simpler line that would cross another road keeps the road course', () => {
  // a-b bulges 3 m south; e-f dips to 1.5 m below the chord of a-b without touching the road
  const { nodes, edges } = metreGraph(
    { a: [0, 0], b: [100, 0], e: [50, 30], f: [60, 30] },
    [['a', 'b', [[50, -3]]], ['e', 'f', [[50, -1.5], [60, -1.5]]]]
  );
  assert.strictEqual(SGM.countEdgeCrossings(nodes, edges), 0);
  const out = SGM.buildDisplayShapes(nodes, edges, null);
  assert.strictEqual(out[0].coords.length, 3, 'a-b stays on its road course');
  assert.strictEqual(SGM.countEdgeCrossings(nodes, out), 0);
  // Without e-f the same road is drawn straight
  const alone = metreGraph({ a: [0, 0], b: [100, 0] }, [['a', 'b', [[50, -3]]]]);
  assert.strictEqual(SGM.buildDisplayShapes(alone.nodes, alone.edges, null)[0].coords.length, 2);
});

test('sliver: a merged point beside a straight road it belongs to is moved onto the road', () => {
  // A-C: a straight road; B, 15 m off it, was merged from a junction 3 m off the road
  const make = (extra) => {
    const pts = { a: [0, 0], c: [200, 0], b: [100, 15], d: [100, 120], ...extra };
    const list = [['a', 'c'], ['b', 'c'], ['b', 'd']];
    return metreGraph(pts, list);
  };
  const { nodes, edges, ll } = make();
  const members = new Map([['b', [ll([100, 3]), ll([100, 27])]]]);
  const out = SGM.alignPointsOntoRoads(nodes, edges, 30, members);
  assert.strictEqual(out.applied.length, 1);
  const b = out.nodes.get('b');
  const kx = 111320 * Math.cos((35 * Math.PI) / 180);
  assert.ok(Math.abs((b.lat - 35) * 110540) < 0.5 && Math.abs((b.lon - 135) * kx - 100) < 3.5, 'b sits on the road');
  const pairs = out.edges.map((e) => [e.u, e.v].sort().join('-')).sort();
  assert.deepStrictEqual(pairs, ['a-b', 'b-c', 'b-d']);
  assert.ok(isConnected(out.nodes));
  // Not when the new place would be closer than the merge radius to another point
  const near = make({ k: [100, -25] });
  const outNear = SGM.alignPointsOntoRoads(near.nodes, near.edges, 30, members);
  assert.strictEqual(outNear.applied.length, 0);
  // Not when no junction of b is on the road
  const far = SGM.alignPointsOntoRoads(nodes, edges, 30, new Map([['b', [ll([100, 15])]]]));
  assert.strictEqual(far.applied.length, 0);
});

test('sliver: Barcelona 36 (merge 30 m, dead ends excluded) keeps no point with a single road but the junctions left so by the frame', async () => {
  SGM.clearCaches();
  SGM.setPresetFetcher(localPresetFetcher);
  const b = await withFetch(noNetwork(), () =>
    SGM.generateStreetGoBoard('バルセロナ アシャンプラ', { targetNodes: 36, mergeRadiusMeters: 30, includeDeadEnds: false }, null, { allowNetwork: false }));
  for (const n of b.nodes.values()) {
    if (n.pinned) continue;
    assert.ok(n.neighbors.size >= 2, `${n.id} (${n.kind}) has ${n.neighbors.size} road(s)`);
  }
  SGM.clearCaches();
});

test('sliver: no move that makes a narrow angle at a point joined to the moved point', () => {
  const { nodes, edges, ll } = metreGraph(
    { a: [0, 0], c: [200, 0], b: [100, 15], d: [160, 60], e: [136.49, 27.64] },
    [['a', 'c'], ['b', 'c'], ['b', 'd'], ['d', 'e']]
  );
  const members = new Map([['b', [ll([100, 3]), ll([100, 27])]]]);
  const out = SGM.alignPointsOntoRoads(nodes, edges, 30, members);
  assert.strictEqual(out.applied.length, 0, 'moving b would close the angle b-d-e from 17 to 9 degrees');
});

test('sliver: a point merged from one junction only is never moved', () => {
  const { nodes, edges, ll } = metreGraph(
    { a: [0, 0], c: [200, 0], b: [100, 15], d: [100, 120] },
    [['a', 'c'], ['b', 'c'], ['b', 'd']]
  );
  const out = SGM.alignPointsOntoRoads(nodes, edges, 30, new Map([['b', [ll([100, 3])]]]));
  assert.strictEqual(out.applied.length, 0);
});

test('shape: the last pass never brings back a crossing the current straight line does not have', () => {
  // a-b is drawn straight now; its road course bends 20 m south and is crossed by e-f
  const { nodes, edges, ll } = metreGraph(
    { a: [0, 0], b: [100, 0], e: [50, -30], f: [50, -10] },
    [['a', 'b'], ['e', 'f']]
  );
  edges[0].roadCoords = [ll([0, 0]), ll([50, -20]), ll([100, 0])];
  assert.strictEqual(SGM.countEdgeCrossings(nodes, edges), 0);
  const out = SGM.buildDisplayShapes(nodes, edges, null);
  assert.strictEqual(out[0].coords.length, 2, 'the straight line stays');
  assert.strictEqual(SGM.countEdgeCrossings(nodes, out), 0);
});

test('shape: a crossing that only the current line has is not lost by simplifying', () => {
  // road (0,0)-(50,25)-(100,0) whose real ends lie at (0,25) and (100,25): drawn straight it
  // would no longer cross the road (50,16)-(50,35)
  const { nodes, edges, ll } = metreGraph(
    { a: [0, 0], b: [100, 0], e: [50, 16], f: [50, 35] },
    [['a', 'b', [[50, 25]]], ['e', 'f']]
  );
  edges[0].rawEnds = [ll([0, 25]), ll([100, 25])];
  const before = SGM.countEdgeCrossings(nodes, edges);
  assert.strictEqual(before, 1);
  const out = SGM.buildDisplayShapes(nodes, edges, null);
  assert.strictEqual(SGM.countEdgeCrossings(nodes, out), before, 'the same pairs cross');
  assert.strictEqual(out[0].coords.length, 3);
});

test('shape: distances are true metres at high latitude (85 degrees north)', () => {
  const lat0 = 85;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ll = ([x, y]) => [lat0 + y / 110540, 10 + x / kx];
  const nodes = new Map();
  for (const [id, p] of Object.entries({ a: [0, 0], b: [0, 100], k: [6, 50], z: [60, 50] })) {
    const [lat, lon] = ll(p);
    nodes.set(id, { id, lat, lon, neighbors: new Set() });
  }
  // a-b bends 3 m west in the middle; drawn straight it would pass 6 m from k
  const edges = [{ u: 'a', v: 'b', coords: [ll([0, 0]), ll([-3, 50]), ll([0, 100])] }, { u: 'k', v: 'z', coords: [ll([6, 50]), ll([60, 50])] }];
  const out = SGM.buildDisplayShapes(nodes, edges, null);
  assert.strictEqual(out[0].coords.length, 3, 'kept: the straight line would pass within 8 m of k');
});

test('shape: a road with thousands of points is simplified without running out of stack', () => {
  const pts = [];
  for (let i = 0; i <= 6000; i++) pts.push([i * 2, (i % 2 ? 30 : 0) + i * 0.001]);
  const { nodes, edges } = metreGraph({ a: pts[0], b: pts[pts.length - 1] }, [['a', 'b', pts.slice(1, -1)]]);
  const out = SGM.buildDisplayShapes(nodes, edges, null);
  assert.ok(out[0].coords.length >= 2);
});

test('square search: never past 450 points (rows 6 m and 12 m beyond the square)', () => {
  const xs = Array.from({ length: 19 }, (_, i) => (i - 9) * 40);
  const ys = Array.from({ length: 21 }, (_, i) => (i - 10) * 40);
  const rows = [-406].concat(ys, [406, 412]); // 6 m south, 6 m and 12 m north of the outer rows
  const els = metreStreets(xs, rows);
  const g = SGM.buildRoadGraph(els, 35, 135, { targetNodes: 399, mergeRadiusMeters: 5 });
  assert.ok(g.stats.nodeCount <= SGM.MAX_BOARD_NODES, `${g.stats.nodeCount} points`);
  assert.ok(g.stats.nodeCount >= 0.85 * 399, `${g.stats.nodeCount} points`);
});

test('square search: Ginza with 450 points wanted stays within 450', async () => {
  SGM.clearCaches();
  SGM.setPresetFetcher(localPresetFetcher);
  const b = await withFetch(noNetwork(), () =>
    SGM.generateStreetGoBoard('東京 銀座', { targetNodes: 450 }, null, { allowNetwork: false }));
  assert.ok(b.stats.nodeCount <= 450, `${b.stats.nodeCount} points`);
  SGM.clearCaches();
});

test('order: Kyoto 81/169/361 give the same board for reversed and shuffled input data', async () => {
  const base = readPreset('presets/kyoto-shijo-karasuma.json');
  const sig = (g) => JSON.stringify({
    nodes: Array.from(g.nodes.values()).map((n) => `${n.id}:${n.lat.toFixed(7)},${n.lon.toFixed(7)}`).sort(),
    edges: g.edges.map((e) => [e.u, e.v].sort().join('-')).sort()
  });
  for (const target of [81, 169, 361]) {
    const sigs = [];
    for (const mode of ['as is', 'reversed', 'shuffled']) {
      const data = { ...base, elements: base.elements.slice() };
      if (mode === 'reversed') data.elements.reverse();
      if (mode === 'shuffled') {
        const r = rng(7);
        for (let i = data.elements.length - 1; i > 0; i--) {
          const j = Math.floor(r() * (i + 1));
          [data.elements[i], data.elements[j]] = [data.elements[j], data.elements[i]];
        }
      }
      SGM.clearCaches();
      SGM.setPresetFetcher(async () => data);
      const g = await withFetch(noNetwork(), () =>
        SGM.generateStreetGoBoard('京都 四条烏丸', { targetNodes: target }, null, { allowNetwork: false }));
      sigs.push(sig(g));
    }
    assert.strictEqual(sigs[1], sigs[0], `${target}: reversed input`);
    assert.strictEqual(sigs[2], sigs[0], `${target}: shuffled input`);
  }
  SGM.setPresetFetcher(localPresetFetcher);
  SGM.clearCaches();
});

test('shape: a simpler line outside the board rectangle keeps the road course', () => {
  const { nodes, edges, ll } = metreGraph({ a: [0, 0], b: [100, 0] }, [['a', 'b', [[50, -3]]]]);
  const [south, west] = ll([-10, -10]);
  const [north, east] = ll([90, 10]); // b lies outside
  const out = SGM.buildDisplayShapes(nodes, edges, { south, west, north, east });
  assert.strictEqual(out[0].coords.length, 3);
  const [n2, e2] = ll([110, 10]);
  assert.strictEqual(SGM.buildDisplayShapes(nodes, edges, { south, west, north: n2, east: e2 })[0].coords.length, 2);
});

// Street grid on rows / columns given in metres (one way per row and per column)
function metreStreets(xs, ys) {
  const kx = 111000 * Math.cos((35 * Math.PI) / 180);
  const els = [];
  const id = (i, j) => 1 + j * xs.length + i;
  ys.forEach((y, j) => xs.forEach((x, i) => els.push({ type: 'node', id: id(i, j), lat: 35 + y / 111000, lon: 135 + x / kx })));
  let w = 1;
  ys.forEach((_, j) => els.push({ type: 'way', id: w++, nodes: xs.map((__, i) => id(i, j)) }));
  xs.forEach((_, i) => els.push({ type: 'way', id: w++, nodes: ys.map((__, j) => id(i, j)) }));
  return els;
}

test('square search: the frame is the square the roads were cut to; it grows and shrinks to the target', () => {
  // 100 m street grid, -1000..1000 m (larger than every square tried)
  const xs = Array.from({ length: 21 }, (_, i) => (i - 10) * 100);
  const els = metreStreets(xs, xs);
  for (const target of [21, 60, 150]) {
    const g = SGM.buildRoadGraph(els, 35, 135, { targetNodes: target, mergeRadiusMeters: 5 });
    const n = g.stats.nodeCount;
    const counts = g.stats.search.map((t) => t.count);
    const inBand = counts.filter((c) => c >= 0.85 * target && c <= 1.15 * target);
    if (inBand.length > 0) {
      assert.ok(n >= 0.85 * target && n <= 1.15 * target, `target ${target}: ${n} points (${JSON.stringify(g.stats.search)})`);
    } else {
      // no size fits: the closest one is used
      assert.strictEqual(Math.abs(n - target), Math.min(...counts.filter((c) => c <= 450).map((c) => Math.abs(c - target))));
    }
    const b = g.boardBounds;
    assertBoardInside(g, b, `target ${target}`);
    // a square around the centre
    const sz = SGM.rectSizeMeters(b);
    assert.ok(Math.abs(sz.widthM - sz.heightM) < 1 && Math.abs((b.north + b.south) / 2 - 35) < 1e-9, `target ${target}: ${sz.widthM} x ${sz.heightM}`);
    // roads leaving the square end at their last junction inside: no road ends at the frame
    // (a street lying on the frame runs along it between junctions)
    for (const n of g.nodes.values()) {
      if (n.neighbors.size === 1 && !n.pinned) assert.ok(!onFrame(n, b), `target ${target}: a road ends at the frame`);
    }
    assert.strictEqual(g.tails.length, 0);
  }
  // the corners never pass the data coverage; a board that cannot reach the target says so
  const g3 = SGM.buildRoadGraph(els, 35, 135, { targetNodes: 150, mergeRadiusMeters: 5, coverageM: 250 });
  for (const [la, lo] of [[g3.boardBounds.south, g3.boardBounds.west], [g3.boardBounds.north, g3.boardBounds.east]]) {
    assert.ok(SGM.distanceMeters(35, 135, la, lo) <= 250 + 1e-6, 'corner past the coverage');
  }
  assert.ok(g3.stats.nodeCount < 0.85 * 150);
  assert.strictEqual(g3.stats.hitCoverage, true);
  // a drawn rectangle is used as it is
  const kx = 111000 * Math.cos((35 * Math.PI) / 180);
  const b = { south: 35 - 150 / 111000, north: 35 + 150 / 111000, west: 135 - 150 / kx, east: 135 + 150 / kx };
  const g4 = SGM.buildRoadGraph(els, 35, 135, { targetNodes: 9, mergeRadiusMeters: 5, bounds: b });
  assert.deepStrictEqual(g4.boardBounds, b);
});

test('square search: the square moves so that its sides run between streets, not along them; the same input gives the same square', () => {
  // 100 m street grid, -1000..1000 m
  const xs = Array.from({ length: 21 }, (_, i) => (i - 10) * 100);
  const els = metreStreets(xs, xs);
  const kx = 111000 * Math.cos((35 * Math.PI) / 180);
  const atCentre = (cx, cy) => SGM.buildRoadGraph(els, 35 + cy / 111000, 135 + cx / kx, { targetNodes: 60, mergeRadiusMeters: 5 });
  const g0 = atCentre(0, 0);
  const half = g0.stats.sideM / 2;
  // a centre that puts the east and north sides 3 m outside a street
  const c = Math.round(half / 100) * 100 - half + 3;
  const g = atCentre(c, c);
  const sh = g.stats.shift;
  assert.ok(sh.sideRoadM0 > 0 && sh.sideRoadM < sh.sideRoadM0, JSON.stringify(sh));
  assert.ok(Math.abs(sh.dx) <= 80 && Math.abs(sh.dy) <= 80 && (sh.dx !== 0 || sh.dy !== 0));
  // every side lies between two streets, at least 20 m from both
  const b = g.boardBounds;
  const sides = [(b.west - 135) * kx, (b.east - 135) * kx, (b.south - 35) * 111000, (b.north - 35) * 111000];
  for (const v of sides) {
    const off = Math.abs(v - Math.round(v / 100) * 100);
    assert.ok(off >= 20, `a side ${off.toFixed(1)} m from a street (${JSON.stringify(sh)})`);
  }
  const n = g.stats.nodeCount;
  assert.ok(n >= 0.85 * 60 && n <= 1.15 * 60, `${n} points`);
  // deterministic
  assert.deepStrictEqual(atCentre(c, c).boardBounds, g.boardBounds);
});

test('square search: presets x 36/81/169 land within 0.85-1.15 x target', async () => {
  SGM.clearCaches();
  SGM.setPresetFetcher(localPresetFetcher);
  await withFetch(noNetwork(), async () => {
    for (const p of SGM.PRESETS) {
      for (const target of [36, 81, 169]) {
        const b = await SGM.generateStreetGoBoard(p.query, { targetNodes: target }, null, { allowNetwork: false });
        const r = b.stats.nodeCount / target;
        assert.ok(r >= 0.85 && r <= 1.15, `${p.query} ${target}: ${b.stats.nodeCount} points`);
        const bb = b.boardBounds;
        for (const n of b.nodes.values()) assert.ok(n.lat >= bb.south && n.lat <= bb.north && n.lon >= bb.west && n.lon <= bb.east);
      }
    }
  });
  SGM.clearCaches();
});

// ---------------------------------------------------------------------------
// Board generation v2: clipping, links, loops, side-by-side roads (S1-S15, C1-C9)

// The Kyoto range of the user's report: Sanjo side (north of Rokkaku) down to just north of
// Shijo, Ogawa-dori to east of Sakaimachi-dori. Fixed on the bundled data (presets/, simple
// query, ASSET_VERSION 4). The streets were identified on that data by their position (the
// data has no names): E-W Nishikikoji ~35.00495, Takoyakushi ~35.00614, Rokkaku ~35.00737;
// N-S Shinmachi ~135.7566, Karasuma ~135.7596-7 (two carriageways), Higashinotoin ~135.7611,
// Takakura ~135.7626, Sakaimachi ~135.7633.
const KYOTO_RANGE = { south: 35.0040, north: 35.0078, west: 135.7540, east: 135.7650 };
const KYOTO_STREETS = {
  '六角通': [370673861], // only its part east of Yanaginobanba is in the data (simple query)
  '新町通': [33884442],
  '烏丸通': [978085966, 981951782, 978085963, 973565732],
  '東洞院通': [256457175],
  '高倉通': [1148700851, 1148700850],
  '堺町通': [268192646],
  '蛸薬師通': [1537870783, 256464040, 66705748]
};
// Pieces cut off from the rest in the data (no shared node): Sakaimachi south of Nishikikoji
// (facing its street across a 10 m gap) and Takakura north of Rokkaku (7.6 m to the side of
// where the south part ends). Both leave the range with no junction inside: not used.
const KYOTO_GAPS = { '堺町通 south of Nishikikoji': 772134681 };
const KYOTO_PAIRS = { '高倉通 north of Rokkaku': 247998818 };

function inRangeSamples(data, wayId, b, step = 2) {
  const osm = new Map(data.elements.filter((e) => e.type === 'node').map((e) => [e.id, e]));
  const w = data.elements.find((e) => e.type === 'way' && e.id === wayId);
  assert.ok(w, `way ${wayId} in the data`);
  const out = [];
  for (let i = 1; i < w.nodes.length; i++) {
    const a = osm.get(w.nodes[i - 1]);
    const c = osm.get(w.nodes[i]);
    const L = SGM.distanceMeters(a.lat, a.lon, c.lat, c.lon);
    const n = Math.max(1, Math.ceil(L / step));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const lat = a.lat + (c.lat - a.lat) * t;
      const lon = a.lon + (c.lon - a.lon) * t;
      if (lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east) out.push([lat, lon, L / n]);
    }
  }
  return out;
}

// Between the streets' junctions inside the range (the pieces from the last junction to the
// frame are not used): N-S streets from Nishikikoji to Takoyakushi (Rokkaku is in the data
// only east of 135.764, so most of them have no junction north of Takoyakushi); Takoyakushi from Ogawa-dori
// (135.7544) to the junction at 135.7649, Rokkaku from its west end in the data (135.7640)
// to that same N-S street
const KYOTO_BETWEEN = { south: 35.00502, north: 35.00614 };
// Sakaimachi leaves Takoyakushi southwards to a dead end (its link to Nishikikoji is cut by
// a data gap): outside the board's outline
const KYOTO_OUTSIDE = { '堺町通': true };
const KYOTO_NS = {};
const KYOTO_EW = { '六角通': [135.7641, 135.7649], '蛸薬師通': [135.7545, 135.7649] };

test('Kyoto range: every stretch of Rokkaku, Shinmachi, Karasuma, Higashinotoin, Takakura, Sakaimachi and Takoyakushi between their junctions stays (S15)', async () => {
  SGM.clearCaches();
  // (the board built for the roads cut to this rectangle: a drawn range moves its sides first,
  // see the fit tests)
  const data = seedPresetRoads('kyoto-shijo-karasuma');
  const g = SGM.buildRoadGraph(data.elements, 0, 0, { bounds: KYOTO_RANGE });
  assertBoardInvariants(g, KYOTO_RANGE, 'kyoto range');
  const P = metresProjector(35.006, 135.76);
  for (const [name, ids] of Object.entries(KYOTO_STREETS)) {
    if (KYOTO_OUTSIDE[name]) {
      // a dead-end branch south of the board's outline: not used
      for (const id of ids) assert.strictEqual(g.edges.filter((e) => e.wayIds.includes(id)).length, 0, `${name} ${id}`);
      continue;
    }
    const band = KYOTO_EW[name]
      ? { ...KYOTO_RANGE, west: KYOTO_EW[name][0], east: KYOTO_EW[name][1] }
      : KYOTO_NS[name] ? { ...KYOTO_RANGE, south: KYOTO_NS[name][0], north: KYOTO_NS[name][1] }
        : { ...KYOTO_RANGE, south: KYOTO_BETWEEN.south, north: KYOTO_BETWEEN.north };
    let checkedM = 0;
    for (const id of ids) {
      const samples = inRangeSamples(data, id, band);
      const total = samples.reduce((t, s) => t + s[2], 0);
      checkedM += total;
      if (total === 0) continue; // (a piece of the street outside the stretch checked)
      // the edges made from this way (way ids are kept through merging)
      const lines = g.edges.filter((e) => e.wayIds.includes(id)).map((e) => e.roadCoords.map(([la, lo]) => P(la, lo)));
      assert.ok(lines.length > 0, `${name} ${id}: no edge`);
      let covered = 0;
      for (const [la, lo, len] of samples) {
        const q = P(la, lo);
        const d = Math.min(...lines.map((l) => pointPolyDist(q, l)));
        assert.ok(d <= SGM.DEFAULT_MERGE_RADIUS_M, `${name} ${id}: a stretch ${d.toFixed(1)} m from its edges`);
        if (d <= 12) covered += len; // (two carriageways are drawn as one of them, up to 12 m apart)
      }
      assert.ok(covered / total >= 0.9, `${name} ${id}: ${(100 * covered / total).toFixed(0)} % drawn along it`);
    }
    assert.ok(checkedM > 40, `${name}: ${checkedM} m checked`);
  }
  for (const [name, id] of Object.entries({ ...KYOTO_GAPS, ...KYOTO_PAIRS })) {
    assert.ok(inRangeSamples(data, id, KYOTO_RANGE).length > 10, `${name} is in range`);
    assert.strictEqual(g.edges.filter((e) => e.wayIds.includes(id)).length + g.tails.filter((t) => t.wayIds.includes(id)).length, 0, `${name}: not used`);
  }
  assert.ok(g.stats.coverage.droppedM.smallComponent < 100, JSON.stringify(g.stats.coverage));
  assert.strictEqual(g.stats.coverage.droppedM.deadEnd, 0);
  // same board for reversed input data
  SGM.clearCaches();
  const rev = { ...data, elements: data.elements.slice().reverse() };
  const g2 = SGM.buildRoadGraph(rev.elements, 0, 0, { bounds: KYOTO_RANGE });
  assert.deepStrictEqual(boardSignature(g2), boardSignature(g));
  // the drawn range itself: the same for reversed input data too
  SGM.seedRoadCache(rev.location.lat, rev.location.lon, rev.radius, rev.elements, true, 'simple');
  const d1 = await withFetch(noNetwork(), () => SGM.generateStreetGoBoardInBounds(KYOTO_RANGE, {}, null, { allowNetwork: false }));
  SGM.clearCaches();
  seedPresetRoads('kyoto-shijo-karasuma');
  const d2 = await withFetch(noNetwork(), () => SGM.generateStreetGoBoardInBounds(KYOTO_RANGE, {}, null, { allowNetwork: false }));
  assert.deepStrictEqual(boardSignature(d1), boardSignature(d2));
  SGM.clearCaches();
});

test('frame: corner touch, a road just outside the frame, a short diagonal cut, a lone cut piece: only junction-to-junction stretches', () => {
  const els = metreWays([
    [[-250, 0], 1, [250, 0]], // 1: east-west through the middle
    [[0, -250], 1, 2], // 2: north-south up to the road along the frame
    [[-250, 200.5], 2, [250, 200.5]], // 3: 0.5 m outside the north side
    [[150, 250], [250, 150]], // 4: touches the north-east corner only
    [[-230, -130], 3, [-130, -230]], // 5: cuts the south-west corner (57 m inside)
    [3, [-160, -160]], // 6: a dead end off it
    [[150, -230], [230, -150]] // 7: cuts the south-east corner, joined to nothing
  ], { 1: [0, 0], 2: [0, 200.5], 3: [-180, -180] });
  const b = metreBounds(-200, -200, 200, 200);
  const g = SGM.buildRoadGraph(els, 35, 135, { mergeRadiusMeters: 5, bounds: b });
  assertBoardInside(g, b, 'frame');
  const byWay = (id) => g.edges.filter((e) => e.wayIds.includes(id));
  const pointNear = (x, y) => Array.from(g.nodes.values()).find((n) => { const p = toMetres(n.lat, n.lon); return Math.hypot(p[0] - x, p[1] - y) < 0.5; });
  // 4: nothing at the corner; 3 (along the frame) has no junction-to-junction stretch; 5 and
  // 7 only lead out of the frame; 6 is left as a 28 m 2-point part: none is used
  for (const id of [3, 4, 5, 6, 7]) assert.strictEqual(byWay(id).length, 0, `road ${id}`);
  // 1 and 2: only the stretch between the two junctions (0, 0) and (0, 200) stays; both stay
  // points with one road (pinned, not dead ends of their own)
  const mid = byWay(2);
  assert.strictEqual(mid.length, 1);
  assert.strictEqual(byWay(1).length, 0);
  for (const [x, y] of [[0, 0], [0, 200]]) {
    const n = pointNear(x, y);
    assert.ok(n && n.pinned && n.neighbors.size === 1, `junction at (${x}, ${y})`);
  }
  assert.strictEqual(g.nodes.size, 2);
  assert.ok(g.stats.coverage.droppedM.leavingRange > 800);
  assert.ok(g.stats.coverage.droppedM.smallComponent > 25);
  // every positive-length stretch inside the frame is drawn, counted as left out, or leads out
  const kept = g.edges.reduce((t, e) => t + e.srcLength, 0);
  const c = g.stats.coverage;
  assert.ok(Math.abs(kept + c.mergedM + c.droppedM.deadEnd + c.droppedM.smallComponent - c.totalM) <= 2, JSON.stringify({ kept, c }));
});

test('frame: a road leaving the frame and coming back is not used beyond its junctions; no link through the outside', () => {
  // A U-shaped road: in at the west, out through the north side, back in, out at the east
  const els = metreWays([
    [[-250, 0], 1, [-100, 0], [-100, 260], [100, 260], [100, 0], 2, [250, 0]],
    [1, 3],
    [2, 4],
    [3, 5, 4],
    [5, [0, -250]]
  ], { 1: [-150, 0], 2: [150, 0], 3: [-150, -150], 4: [150, -150], 5: [0, -150] });
  const b = metreBounds(-200, -200, 200, 200);
  const g = SGM.buildRoadGraph(els, 35, 135, { mergeRadiusMeters: 5, bounds: b });
  assert.strictEqual(g.edges.filter((e) => e.wayIds.includes(1)).length, 0, 'the U road only leads out of the frame');
  assert.ok(!Array.from(g.nodes.values()).some((n) => onFrame(n, b)));
  for (const x of [-150, 150]) {
    const n = Array.from(g.nodes.values()).find((q) => { const p = toMetres(q.lat, q.lon); return Math.hypot(p[0] - x, p[1]) < 0.5; });
    assert.ok(n && n.pinned && n.neighbors.size === 1, `junction at (${x}, 0) stays with one road`);
  }
  assertBoardInside(g, b, 'U road');
});

test('loops: a ring with one entrance and with two entrances keep their roads; a ring with none is another part (S3)', () => {
  const ring = (cx, cy, rad, n, ids) => Array.from({ length: n }, (_, k) => (ids && ids[k] !== undefined ? ids[k] : [cx + rad * Math.cos((2 * Math.PI * k) / n), cy + rad * Math.sin((2 * Math.PI * k) / n)]));
  const grid = sharedGrid(200, 200); // a 3 x 3 road grid (-200..200)
  // 0 entrances: a ring of 40 m radius around (-100, -100), closed on node 99
  grid.shared[99] = [-100 + 40, -100];
  const r0 = ring(-100, -100, 40, 12, { 0: 99 });
  grid.ways.push(r0.concat([99]));
  const w0 = grid.ways.length;
  // 1 entrance: a ring around (100, 100) whose node 100 is joined to the grid at (200, 200)
  grid.shared[100] = [100 + 40, 100];
  const r1 = ring(100, 100, 40, 12, { 0: 100 });
  grid.ways.push(r1.concat([100]), [100, grid.id(200, 200)]);
  const w1 = grid.ways.length - 1;
  // 2 entrances: a ring around (-100, 100) entered from (0, 200) at node 101 and from (-200, 0) at node 102
  grid.shared[98] = [-100 + 40, 100];
  grid.shared[101] = [-100, 140];
  grid.shared[102] = [-140, 100];
  const r2 = ring(-100, 100, 40, 12, { 0: 98, 3: 101, 6: 102 });
  grid.ways.push(r2.concat([98]), [101, grid.id(0, 200)], [102, grid.id(-200, 0)]);
  const w2 = grid.ways.length - 2;
  const els = metreWays(grid.ways, grid.shared);
  const b = metreBounds(-230, -230, 230, 230);
  const g = SGM.buildRoadGraph(els, 35, 135, { mergeRadiusMeters: 5, dropAreaOutlines: false, bounds: b });
  assertBoardInvariants(g, b, 'loops');
  const ringOf = (wid) => g.edges.filter((e) => e.wayIds.includes(wid));
  const pointsOf = (es) => new Set(es.flatMap((e) => [e.u, e.v]));
  const perimeter = 12 * 2 * 40 * Math.sin(Math.PI / 12); // the 12-sided ring
  assert.strictEqual(ringOf(w0).length, 0, 'no entrance: a part of its own, not used');
  for (const [wid, label] of [[w1, '1 entrance'], [w2, '2 entrances']]) {
    const es = ringOf(wid);
    const len = es.reduce((t, e) => t + e.length, 0);
    assert.ok(Math.abs(len - perimeter) < 1, `${label}: ring drawn ${len.toFixed(1)} of ${perimeter.toFixed(1)} m`);
    assert.ok(pointsOf(es).size >= 3, `${label}: at least 3 points around the ring`);
    for (const e of es) assert.ok(e.u !== e.v);
  }
  assert.strictEqual(ringOf(w1).length, 3, 'one entrance: the entrance + 2 shape points');
  assert.strictEqual(ringOf(w2).length, 3, 'two entrances: both arcs, one with a shape point');
  assert.strictEqual(kindsOf(g, 'shape').length, 2 + 1, 'ring 1: 2; ring 2: 1');
  assertEdgesOnRoads(g, els, 8, 'loops');
});

test('area outlines (on by default): closed ways with no link or with sharp corners are left out, round loops stay', () => {
  const grid = sharedGrid(200, 200);
  // a closed way joined to nothing (a plaza outline), a jagged closed way joined to the grid,
  // and a smooth ring (a roundabout) joined to the grid
  grid.shared[90] = [-60, -60];
  grid.ways.push([90, [-140, -60], [-140, -140], [-60, -140], 90]); // isolated square
  const nOutline = grid.ways.length;
  grid.shared[91] = [200, 100];
  grid.ways.push([91, [150, 100], [150, 140], [120, 140], [120, 60], [180, 60], [180, 100], 91]); // jagged, on the east column
  const nJagged = grid.ways.length;
  grid.shared[92] = [-100 + 40, 100];
  const ring = Array.from({ length: 16 }, (_, k) => (k === 0 ? 92 : [-100 + 40 * Math.cos((k * Math.PI) / 8), 100 + 40 * Math.sin((k * Math.PI) / 8)]));
  grid.ways.push(ring.concat([92]), [92, grid.id(0, 200)]);
  const nRing = grid.ways.length - 1;
  // the jagged outline shares a node with the east column: put 91 on it
  grid.ways[5] = [grid.id(200, -200), grid.id(200, 0), 91, grid.id(200, 200)];
  const els = metreWays(grid.ways, grid.shared);
  const b = metreBounds(-230, -230, 230, 230);
  const keep = SGM.buildRoadGraph(els, 35, 135, { mergeRadiusMeters: 5, dropAreaOutlines: false, bounds: b });
  const drop = SGM.buildRoadGraph(els, 35, 135, { mergeRadiusMeters: 5, dropAreaOutlines: true, bounds: b });
  const has = (g, wid) => g.edges.some((e) => e.wayIds.includes(wid));
  // (the isolated square is a part of its own: never used, as only the largest part stays)
  assert.ok(!has(keep, nOutline) && has(keep, nJagged) && has(keep, nRing), 'with the option off every joined loop stays');
  const byDefault = SGM.buildRoadGraph(els, 35, 135, { mergeRadiusMeters: 5, bounds: b });
  assert.ok(!has(byDefault, nOutline) && !has(byDefault, nJagged) && has(byDefault, nRing), 'on by default');
  assert.ok(!has(drop, nOutline), 'the plaza outline goes');
  assert.ok(!has(drop, nJagged), 'the jagged outline goes');
  assert.ok(has(drop, nRing), 'the roundabout stays');
});

test('facing dead ends across a short gap become one road; side-offset, crossing and far ones stay apart (item 2)', () => {
  // grid + a block north of it (y = 200..480) crossed by four streets ending in pairs of
  // dead ends between y = 300 and y = 400 (inside the board's outline)
  const grid = sharedGrid(200, 200);
  Object.assign(grid.shared, { 600: [-150, 200], 601: [-50, 200], 602: [50, 200], 603: [150, 200], 610: [-150, 480], 611: [-42, 480], 612: [50, 480], 620: [-200, 480], 621: [200, 480] });
  grid.ways[2] = [grid.id(-200, 200), 600, 601, grid.id(0, 200), 602, 603, grid.id(200, 200)];
  grid.ways.push([620, 610, 611, 612, 621], [grid.id(-200, 200), 620], [grid.id(200, 200), 621]);
  const extra = [
    [600, [-150, 342]], [[-150, 358], 610], // A: 16 m gap, one line -> joined
    [601, [-50, 342]], [[-42, 352], 611], // B: 8 m to the side -> stays
    [602, [50, 340]], [[50, 370], 612], // C: 30 m gap -> stays
    [603, [150, 345]], [[140, 355], [100, 355]] // D: the second road runs across -> stays
  ];
  const ids = [];
  for (const w of extra) { grid.ways.push(w); ids.push(grid.ways.length); }
  const els = metreWays(grid.ways, grid.shared);
  const b = metreBounds(-230, -230, 230, 500);
  const g = SGM.buildRoadGraph(els, 35, 135, { mergeRadiusMeters: 5, bounds: b });
  const joined = g.edges.filter((e) => e.wayIds.length > 1 && e.wayIds.every((w) => ids.includes(w)));
  assert.strictEqual(joined.length, 1, 'only pair A is joined');
  assert.deepStrictEqual(joined[0].wayIds, [ids[0], ids[1]]);
  assert.strictEqual(g.stats.facingJoined, 1);
  const deadAt = (x, y) => kindsOf(g, 'deadEnd').some((n) => { const p = toMetres(n.lat, n.lon); return Math.hypot(p[0] - x, p[1] - y) < 1; });
  assert.ok(!deadAt(-150, 342) && !deadAt(-150, 358), 'no points left at the joined gap');
  for (const [x, y] of [[-50, 342], [-42, 352], [50, 340], [50, 370], [150, 345]]) assert.ok(deadAt(x, y), `dead end at (${x}, ${y})`);
  // the joined road runs straight across the gap
  const pts = joined[0].roadCoords.map(([la, lo]) => toMetres(la, lo));
  for (const p of pts) assert.ok(Math.abs(p[0] + 150) < 0.5);
});

test('small loops and short second routes are simplified; no clump of shape points (item 4)', () => {
  const grid = sharedGrid(200, 200);
  const ring = (cx, cy, rad, n, ids) => Array.from({ length: n }, (_, k) => (ids && ids[k] !== undefined ? ids[k] : [cx + rad * Math.cos((2 * Math.PI * k) / n), cy + rad * Math.sin((2 * Math.PI * k) / n)]));
  // a turning loop (perimeter 94 m) at the end of a dead-end street: the loop goes, the street stays
  grid.shared[300] = [-100 + 15, -100];
  grid.ways.push([grid.id(-200, -200), [-150, -150], 300]);
  const street = grid.ways.length;
  const r1 = ring(-100, -100, 15, 10, { 0: 300 });
  grid.ways.push(r1.concat([300]));
  const small = grid.ways.length;
  // a small loop (perimeter 126 m) hanging on a through road at node 301: the loop goes and
  // the road through 301 becomes one road again
  grid.shared[301] = [100, -50];
  grid.shared[305] = [120, -70];
  grid.ways.push([grid.id(0, 0), 301, grid.id(200, -200)]);
  const through = grid.ways.length;
  const r2 = ring(100, -70, 20, 12, { 0: 305 }).map((p, k) => (k === 3 ? 301 : p));
  grid.ways.push(r2.concat([305]));
  // two routes of 60 m and 75 m between nodes 302 and 303: the shorter stays, no shape point
  grid.shared[302] = [-100, 60];
  grid.shared[303] = [-100, 120];
  grid.ways.push([grid.id(-200, 0), 302], [303, grid.id(-200, 200)]);
  grid.ways.push([302, 303], [302, [-80, 80], [-80, 100], 303]);
  const shortRoute = grid.ways.length - 1;
  const longRoute = grid.ways.length;
  const els = metreWays(grid.ways, grid.shared);
  const b = metreBounds(-230, -230, 230, 230);
  const g = SGM.buildRoadGraph(els, 35, 135, { mergeRadiusMeters: 5, dropAreaOutlines: false, bounds: b });
  assertBoardInvariants(g, b, 'small loops');
  const has = (wid) => g.edges.some((e) => e.wayIds.includes(wid));
  assert.ok(!has(small), 'the turning loop goes');
  assert.ok(has(street), 'its street stays');
  const end = Array.from(g.nodes.values()).find((n) => { const p = toMetres(n.lat, n.lon); return Math.hypot(p[0] + 85, p[1] + 100) < 1; });
  assert.ok(end && end.kind === 'deadEnd', 'the street ends where the loop was');
  assert.ok(!Array.from(g.nodes.values()).some((n) => { const p = toMetres(n.lat, n.lon); return Math.hypot(p[0] - 100, p[1] + 50) < 1; }), 'no point left on the through road');
  assert.ok(g.edges.some((e) => e.wayIds.includes(through) && e.wayIds.length === 1), 'the through road is one road');
  assert.ok(has(shortRoute) && !has(longRoute), 'only the shorter of two short routes stays');
  assert.strictEqual(kindsOf(g, 'shape').length, 0);
  assert.ok(g.stats.coverage.droppedM.smallLoop > 200);
  // with routes 100 m and 120 m apart (together 220 m), both stay with a shape point
  const grid2 = sharedGrid(200, 200);
  grid2.shared[302] = [-100, 30];
  grid2.shared[303] = [-100, 130];
  grid2.ways.push([grid2.id(-200, 0), 302], [303, grid2.id(-200, 200)], [302, 303], [302, [-60, 50], [-60, 110], 303]);
  const g2 = SGM.buildRoadGraph(metreWays(grid2.ways, grid2.shared), 35, 135, { mergeRadiusMeters: 5, bounds: b });
  assert.strictEqual(kindsOf(g2, 'shape').length, 1);
});

test('roads leaving the frame: the pieces from the last junction to the frame are neither roads nor drawn', () => {
  // three roads leave (0, 180) and cross the north side (y = 190) 5 m apart; a road leaves
  // the east column (200, 0) and crosses the east side (x = 205) after 5 m
  const grid = sharedGrid(200, 100);
  grid.shared[400] = [0, 180];
  grid.ways[7] = [grid.id(0, -200), grid.id(0, -100), grid.id(0, 0), grid.id(0, 100), 400, grid.id(0, 200)];
  grid.ways.push([400, [-40, 260]], [400, [40, 260]], [grid.id(200, 0), [260, 0]]);
  const els = metreWays(grid.ways, grid.shared);
  const b = metreBounds(-230, -230, 205, 190);
  const g = SGM.buildRoadGraph(els, 35, 135, { mergeRadiusMeters: 5, bounds: b });
  assertBoardInvariants(g, b, 'leaving roads');
  assert.strictEqual(g.tails.length, 0, 'nothing drawn to the frame');
  assert.ok(!Array.from(g.nodes.values()).some((n) => onFrame(n, b)));
  // (0, 180) keeps only its road south: a branch beyond the board's outline (the row y = 100),
  // left out with its road
  const p400 = Array.from(g.nodes.values()).find((n) => { const p = toMetres(n.lat, n.lon); return Math.hypot(p[0], p[1] - 180) < 0.5; });
  assert.ok(!p400);
  assert.strictEqual(g.stats.outsideBranches, 1);
  // the columns end at the row y = 100 (their last junction), the stub east of (200, 0) is gone
  assert.ok(!g.edges.some((e) => e.coords.some(([la, lo]) => { const p = toMetres(la, lo); return p[1] > 100.5 && Math.abs(p[0]) > 1; })));
  assert.ok(!g.edges.some((e) => e.coords.some(([la, lo]) => toMetres(la, lo)[0] > 200.5)));
  // (200, 100) and (-200, 100) keep two roads: still points, not joined into one road
  for (const x of [-200, 200]) {
    const n = Array.from(g.nodes.values()).find((q) => { const p = toMetres(q.lat, q.lon); return Math.hypot(p[0] - x, p[1] - 100) < 0.5; });
    assert.ok(n && n.neighbors.size === 2 && n.pinned && n.kind === 'junction', `corner (${x}, 100)`);
  }
  // with dead ends off: the same board (nothing but the outside branch had one road)
  const off = SGM.buildRoadGraph(els, 35, 135, { mergeRadiusMeters: 5, includeDeadEnds: false, bounds: b });
  assert.deepStrictEqual(boardSignature(off), boardSignature(g));
});

test('short dead-end branches have no point at their end (under 12 m); nothing is drawn to the frame', () => {
  // grid with: a road leaving (100, 100) north that crosses the frame (y = 112) after 12 m;
  // dead-end branches of 8 m and 20 m from (-100, 0) and (0, -100)
  const grid = sharedGrid(200, 100);
  grid.ways.push([grid.id(100, 100), [100 + 30, 100 + 30]]); // leaves the frame below the top row
  grid.ways.push([grid.id(-100, 0), [-100 + 5.66, 5.66]]); // 8 m branch
  grid.ways.push([grid.id(0, -100), [14.14, -100 + 14.14]]); // 20 m branch
  const els = metreWays(grid.ways, grid.shared);
  const b = metreBounds(-230, -230, 230, 108.5); // the top row (y = 200) is outside, y = 100 row 8.5 m inside
  const g = SGM.buildRoadGraph(els, 35, 135, { mergeRadiusMeters: 5, bounds: b });
  assertBoardInvariants(g, b, 'short pieces');
  const near = (x, y) => Array.from(g.nodes.values()).filter((n) => { const p = toMetres(n.lat, n.lon); return Math.hypot(p[0] - x, p[1] - y) < 2; });
  for (const x of [-200, -100, 0, 100, 200]) assert.strictEqual(near(x, 108.5).length, 0, `range end at x = ${x}`);
  // the 8 m branch: no dead end, drawn from (-100, 0) (the only drawn-only piece); the 20 m
  // branch keeps its dead end
  assert.strictEqual(near(-100 + 5.66, 5.66).length, 0);
  assert.strictEqual(g.tails.length, 1);
  assert.ok(Math.hypot(...toMetres(g.tails[0].coords[0][0], g.tails[0].coords[0][1]).map((v, i) => v - [-100, 0][i])) < 0.5);
  assert.strictEqual(near(14.14, -100 + 14.14).length, 1);
  assert.strictEqual(near(14.14, -100 + 14.14)[0].kind, 'deadEnd');
  // (-100, 0) keeps its four roads; the branch is not one of them
  assert.strictEqual(near(-100, 0)[0].neighbors.size, 4);
});

test('generation gives control back every few ms and a cancel after it started stops it (S13)', async () => {
  SGM.clearCaches();
  const d = seedPresetRoads('barcelona-eixample');
  const h = 820;
  const k = 111195 * Math.cos((d.location.lat * Math.PI) / 180);
  const b = { south: d.location.lat - h / 111195, north: d.location.lat + h / 111195, west: d.location.lon - h / k, east: d.location.lon + h / k };
  // no step of the build runs longer than 40 ms without handing control back
  const gen = SGM.buildBoardSteps(d.elements, b, {});
  let worst = 0;
  let r;
  do {
    const t = process.hrtime.bigint();
    r = gen.next();
    worst = Math.max(worst, Number(process.hrtime.bigint() - t) / 1e6);
  } while (!r.done);
  assert.ok(worst < 40, `a step ran ${worst.toFixed(1)} ms`);
  // timers run while a board is being built, and a cancel then stops the build
  const ac = new AbortController();
  let ticks = 0;
  const timer = setInterval(() => { ticks++; if (ticks === 1) ac.abort(); }, 5);
  const t0 = Date.now();
  await withFetch(noNetwork(), () => rejectsKind(SGM.generateStreetGoBoardInBounds(b, {}, null, { signal: ac.signal }), 'aborted'));
  clearInterval(timer);
  assert.ok(ticks >= 1, `${ticks} timer ticks during the build`);
  assert.ok(Date.now() - t0 < 1000);
  SGM.clearCaches();
});

// ---------------------------------------------------------------------------
// Implementation review (P0-1..5, S1-S13)

// Largest distance of the drawn lines of edges carrying way `wayId` from the raw ways they
// carry (metres)
function drawnOffWays(g, data, wayId) {
  const osm = new Map(data.elements.filter((e) => e.type === 'node').map((e) => [e.id, e]));
  const P = metresProjector(data.location.lat, data.location.lon);
  const wayLine = new Map();
  for (const w of data.elements) if (w.type === 'way') wayLine.set(w.id, w.nodes.map((id) => P(osm.get(id).lat, osm.get(id).lon)));
  let worst = 0;
  for (const e of g.edges.filter((x) => x.wayIds.includes(wayId))) {
    const lines = e.wayIds.map((w) => wayLine.get(w)).filter(Boolean);
    const pts = e.coords.map(([la, lo]) => P(la, lo));
    for (let i = 1; i < pts.length; i++) {
      for (let t = 0; t <= 1; t += 0.05) {
        const q = [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
        worst = Math.max(worst, Math.min(...lines.map((l) => pointPolyDist(q, l))));
      }
    }
  }
  return worst;
}

test('P0-1: a point moved onto a centre line does not drag its other roads off their course (Turin 169, way 664485874)', async () => {
  SGM.clearCaches();
  SGM.setPresetFetcher(localPresetFetcher);
  const g = await withFetch(noNetwork(), () => SGM.generateStreetGoBoard('トリノ 旧市街', { targetNodes: 169 }, null, { allowNetwork: false }));
  const data = readPreset('presets/turin-old-town.json');
  assert.ok(g.edges.some((e) => e.wayIds.includes(664485874)));
  const off = drawnOffWays(g, data, 664485874);
  assert.ok(off <= 8, `drawn ${off.toFixed(1)} m off way 664485874`);
  SGM.clearCaches();
});

test('P0-2: drawn-only pieces cross other roads with a bridge gap, and look different in the app', () => {
  // the row y = 0 of a grid has a 10 m branch north at x = 50 (drawn only); a road from
  // (-100, 100) to (100, 100) dips to y = 6 and crosses the branch without a shared node
  const grid = sharedGrid(200, 100);
  grid.shared[900] = [50, 0];
  grid.ways[2] = [grid.id(-200, 0), grid.id(-100, 0), grid.id(0, 0), 900, grid.id(100, 0), grid.id(200, 0)];
  grid.ways.push([900, [50, 10]], [grid.id(-100, 100), [20, 6], [80, 6], grid.id(100, 100)]);
  const els = metreWays(grid.ways, grid.shared);
  const g = SGM.buildRoadGraph(els, 35, 135, { mergeRadiusMeters: 5, dropAreaOutlines: false, bounds: metreBounds(-230, -230, 230, 230) });
  const tail = g.tails[0];
  assert.ok(tail && g.tails.length === 1, 'the 10 m branch is drawn only');
  assert.ok(g.bridges.some((br) => br.overTail || br.underTail), 'its crossing with the road at y = 6 gets a gap');
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.ok(/function getTailStyle\(\)[\s\S]*weight: base\.weight \/ 2, opacity: 0\.5/.test(app), 'tails: half width, half opacity');
});

test('P0-3: ] / [ go round every neighbour of a 5-road point, the north-east one included', () => {
  const c = { x: 0, y: 0 };
  const around = [{ id: 'E', x: 10, y: 0 }, { id: 'N', x: 0, y: -10 }, { id: 'NE', x: 7, y: -7 }, { id: 'S', x: 0, y: 10 }, { id: 'W', x: -10, y: 0 }];
  const order = SGM.neighborsClockwise(c, around);
  assert.deepStrictEqual(order, ['N', 'NE', 'E', 'S', 'W']);
  const visited = [];
  let cur = 'C';
  for (let i = 0; i < 6; i++) { cur = SGM.nextInCycle('C', order, cur, 1); visited.push(cur); }
  assert.deepStrictEqual(visited, ['N', 'NE', 'E', 'S', 'W', 'C']);
  assert.strictEqual(SGM.nextInCycle('C', order, 'N', -1), 'C');
  assert.strictEqual(SGM.nextInCycle('C', order, 'C', -1), 'W');
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.ok(/e\.key === '\]' \|\| e\.key === '\['/.test(app));
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(/\] キーを押すと/.test(html));
});

test('P0-4: three roads 3 m apart leaving the frame end at their junctions; close unjoined dead ends leave one drawn only', () => {
  // roads at x = 0, 3, 6 from y = 0 north past the frame (y = 200), each starting at a junction
  const grid = sharedGrid(200, 100);
  const shared = { ...grid.shared, 500: [0, 0], 501: [3, -50], 502: [6, -100] };
  const ways = grid.ways.slice();
  ways[1 * 0 + 2] = [grid.id(-200, 0), grid.id(-100, 0), 500, grid.id(100, 0), grid.id(200, 0)];
  ways.push([500, [0, 260]], [501, [3, 260]], [502, [6, 260]], [grid.id(-100, -100), 501], [501, 502]);
  const els = metreWays(ways, shared);
  const b = metreBounds(-230, -230, 230, 200 - 0.1);
  const g = SGM.buildRoadGraph(els, 35, 135, { mergeRadiusMeters: 1, dropAreaOutlines: false, bounds: b });
  // (the top row, 0.1 m outside, lies on the frame and keeps its junctions there)
  assert.ok(!Array.from(g.nodes.values()).some((n) => onFrame(n, b) && n.neighbors.size === 1 && !n.pinned), 'no road ends at the frame');
  for (const id of [grid.ways.length + 1, grid.ways.length + 2, grid.ways.length + 3]) {
    assert.strictEqual(g.edges.filter((e) => e.wayIds.includes(id)).length, 0, `road ${id} leads out only`);
  }
  assert.strictEqual(g.tails.length, 0);
  // two dead ends 5.8 m apart at right angles (not facing): a 30 m branch north from (50, 0)
  // and a longer one from (100, 100) ending at (55, 33) heading west: the shorter is drawn only
  const grid2 = sharedGrid(200, 100);
  grid2.shared[910] = [50, 0];
  grid2.ways[2] = [grid2.id(-200, 0), grid2.id(-100, 0), grid2.id(0, 0), 910, grid2.id(100, 0), grid2.id(200, 0)];
  grid2.ways.push([910, [50, 30]], [grid2.id(100, 100), [85, 40], [55, 33]]);
  const g2 = SGM.buildRoadGraph(metreWays(grid2.ways, grid2.shared), 35, 135, { mergeRadiusMeters: 5, dropAreaOutlines: false, bounds: metreBounds(-230, -230, 230, 230) });
  const des = kindsOf(g2, 'deadEnd');
  for (const a of des) for (const o of des) if (a !== o) assert.ok(SGM.distanceMeters(a.lat, a.lon, o.lat, o.lon) >= 8);
  assert.strictEqual(g2.stats.closeResolved, 1);
  const t30 = g2.tails[0];
  assert.ok(t30 && Math.abs(toMetres(...t30.coords[t30.coords.length - 1])[1] - 30) < 0.5, 'the 30 m branch is the one drawn only');
  assert.strictEqual(g2.stats.components, 1, 'no link made by distance');
});

test('P0-5: parts are counted on the final board; a 2-point road beside a street is left out', () => {
  // two separate 300 m roads split every 50 m: one of them stays (7 points), no warning
  const els = metreWays([[[-100, 0], [200, 0]], [[-100, 200], [200, 200]]]);
  const g = SGM.buildRoadGraph(els, 35, 135, { mergeRadiusMeters: 5, subdivideLongRoads: true, subdivideSpacingMeters: 50, bounds: metreBounds(-150, -50, 250, 250) });
  assert.deepStrictEqual(g.stats.componentSizes, [7]);
  assert.deepStrictEqual(g.stats.quality.warnings, []);
  // a 60 m promenade 8 m beside a street of the grid: no 2-point part
  const grid = sharedGrid(200, 100);
  grid.ways.push([[-80, 8], [-20, 8]]);
  const g2 = SGM.buildRoadGraph(metreWays(grid.ways, grid.shared), 35, 135, { mergeRadiusMeters: 5, bounds: metreBounds(-230, -230, 230, 230) });
  assert.strictEqual(g2.stats.components, 1);
  assert.ok(!g2.edges.some((e) => e.wayIds.includes(grid.ways.length)));
});

test('parts: lone roads beside a grid are other parts, not used; no warning', () => {
  // a grid and seven lone 40 m roads
  const grid = sharedGrid(200, 100);
  for (let k = 0; k < 7; k++) grid.ways.push([[-180 + k * 50, 230], [-180 + k * 50, 270]]);
  const g = SGM.buildRoadGraph(metreWays(grid.ways, grid.shared), 35, 135, { mergeRadiusMeters: 5, dropAreaOutlines: false, bounds: metreBounds(-230, -230, 230, 300) });
  assert.deepStrictEqual(g.stats.componentSizes, [21]); // (the corners have two roads: no points)
  assert.strictEqual(g.stats.partsDropped, 7);
  assert.ok(Math.abs(g.stats.coverage.droppedM.smallComponent - 7 * 40) < 3, JSON.stringify(g.stats.coverage));
  assert.deepStrictEqual(g.stats.quality.warnings, []);
});

test('inside the frame: everything drawn on the 33 bundled boards and the Kyoto range lies inside its frame; no road ends at the frame', () => {
  const boards = [];
  for (const p of SGM.PRESETS) {
    const d = readPreset(p.file);
    for (const t of [36, 81, 169]) boards.push([`${p.query} ${t}`, SGM.buildRoadGraph(d.elements, d.location.lat, d.location.lon, { targetNodes: t, coverageM: 1300 })]);
  }
  const k = readPreset('presets/kyoto-shijo-karasuma.json');
  boards.push(['kyoto range', SGM.buildRoadGraph(k.elements, 0, 0, { bounds: KYOTO_RANGE })]);
  assert.strictEqual(boards.length, 34);
  for (const [label, g] of boards) {
    const b = g.boardBounds;
    const f = g.frameBounds;
    // the frame drawn: a drawn range as it is; a place's board fitted to its points and lines
    // (a margin of max(22 m, 4.5 % of the extent) on each side, within the square cut to)
    if (label === 'kyoto range') assert.deepStrictEqual(f, b);
    else {
      assert.ok(f.south >= b.south && f.north <= b.north && f.west >= b.west && f.east <= b.east, `${label}: frame outside the square`);
      let s = Infinity; let n = -Infinity; let w = Infinity; let e = -Infinity;
      const add = ([la, lo]) => { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); };
      for (const x of g.nodes.values()) add([x.lat, x.lon]);
      for (const x of g.edges) x.coords.forEach(add);
      for (const x of g.tails) x.coords.forEach(add);
      const kx = 111320 * Math.cos((((s + n) / 2) * Math.PI) / 180);
      const padY = Math.max(22, 0.045 * (n - s) * 110540);
      const padX = Math.max(22, 0.045 * (e - w) * kx);
      // each side: the margin (within 0.5 m), or the square's side where the margin passes it
      const side = (marginM, wantM, atSquare) => Math.abs(marginM - wantM) < 0.5 || atSquare;
      assert.ok(side((s - f.south) * 110540, padY, f.south === b.south), `${label}: south margin`);
      assert.ok(side((f.north - n) * 110540, padY, f.north === b.north), `${label}: north margin`);
      assert.ok(side((w - f.west) * kx, padX, f.west === b.west), `${label}: west margin`);
      assert.ok(side((f.east - e) * kx, padX, f.east === b.east), `${label}: east margin`);
    }
    assertBoardInside(g, f, label); // (0.1 m)
    for (const n of g.nodes.values()) {
      if (n.neighbors.size === 1 && !n.pinned) assert.ok(!onFrame(n, b), `${label}: a road ends at the frame at ${n.id}`);
    }
    // the drawn-only pieces are short dead-end branches or points too close to others: none
    // ends on the frame
    for (const t of g.tails) assert.ok(!onFrame({ lat: t.coords[t.coords.length - 1][0], lon: t.coords[t.coords.length - 1][1] }, b), `${label}: a piece drawn to the frame`);
    assert.ok(!Array.from(g.nodes.values()).some((n) => n.kind === 'boundary'));
  }
});

// The board's outline: inside it (even-odd), or within tolM of it
function outlineTest(g, tolM) {
  const o = g.outline;
  assert.ok(Array.isArray(o) && o.length >= 4, 'an outline');
  const P = metresProjector(o[0][0], o[0][1]);
  const poly = o.map(([la, lo]) => P(la, lo));
  return ([la, lo]) => {
    const q = P(la, lo);
    let inside = false;
    for (let i = 1; i < poly.length; i++) {
      const a = poly[i - 1];
      const b = poly[i];
      if (pointSegDist(q, a, b) <= tolM) return true;
      if ((a[1] > q[1]) !== (b[1] > q[1]) && q[0] < a[0] + ((q[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1])) inside = !inside;
    }
    return inside;
  };
}
// Points and drawn lines (sampled every 2 m) of a board outside its outline
function outsideOutline(g, tolM) {
  const inside = outlineTest(g, tolM);
  const out = [];
  for (const n of g.nodes.values()) if (!inside([n.lat, n.lon])) out.push(`point ${n.id}`);
  const lines = g.edges.map((e) => [`${e.u}-${e.v}`, e.coords]).concat(g.tails.map((t) => [`tail ${t.node}`, t.coords]));
  for (const [name, coords] of lines) {
    for (let i = 1; i < coords.length; i++) {
      const [a, b] = [coords[i - 1], coords[i]];
      const L = SGM.distanceMeters(a[0], a[1], b[0], b[1]);
      const n = Math.max(1, Math.ceil(L / 2));
      for (let k = 0; k <= n; k++) {
        if (!inside([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n])) {
          out.push(name);
          k = n + 1;
          i = coords.length;
        }
      }
    }
  }
  return out;
}

test('outline: the board is one part whose outline is a ring of roads; branches leaving it go, branches inside stay', () => {
  // 3 x 3 blocks of 100 m. Branches: out of the east side from (100, 0) to (140, 0) (outside),
  // into a block from (-100, 0) to (-50, 30) (inside), out of the north side from (0, 100)
  // to (0, 160), going on to (20, 160) (a branch of two roads, outside)
  const grid = sharedGrid(100, 100);
  grid.ways.push([grid.id(100, 0), [140, 0]]); // outside
  const wOut = grid.ways.length;
  grid.ways.push([grid.id(-100, 0), [-50, 30]]); // inside
  const wIn = grid.ways.length;
  grid.shared[300] = [0, 160];
  grid.ways.push([grid.id(0, 100), 300], [300, [20, 160]]); // outside, a branch of two roads
  const wOut2 = grid.ways.length;
  const els = metreWays(grid.ways, grid.shared);
  const b = metreBounds(-150, -150, 200, 200);
  const g = SGM.buildRoadGraph(els, 35, 135, { mergeRadiusMeters: 5, bounds: b });
  assertBoardInside(g, b, 'outline');
  const has = (wid) => g.edges.some((e) => e.wayIds.includes(wid)) || g.tails.some((t) => t.wayIds.includes(wid));
  assert.ok(!has(wOut) && !has(wOut2) && !has(wOut2 - 1), 'branches leaving the outline go, whole');
  assert.ok(has(wIn), 'the branch inside stays');
  assert.strictEqual(kindsOf(g, 'deadEnd').length, 1);
  assert.strictEqual(g.stats.outsideBranches, 2);
  assert.deepStrictEqual(outsideOutline(g, 0.5), []);
  // the outline is the grid's border (4 x 200 m)
  const P = metresProjector(35, 135);
  const o = g.outline.map(([la, lo]) => P(la, lo));
  let per = 0;
  for (let i = 1; i < o.length; i++) per += Math.hypot(o[i][0] - o[i - 1][0], o[i][1] - o[i - 1][1]);
  assert.ok(Math.abs(per - 800) < 2, `outline ${per.toFixed(1)} m`);
});

test('outline: two rings joined at one point both stay; a branch in the notch between them goes', () => {
  // squares (-100..0, -100..0) and (0..100, 0..100) sharing (0, 0); a branch from (0, 0) to
  // (60, -40) lies in neither (outside); branches into each square stay
  const shared = { 1: [0, 0], 2: [-100, 0], 3: [-100, -100], 4: [0, -100], 5: [100, 0], 6: [100, 100], 7: [0, 100] };
  const els = metreWays([
    [1, 2, 3, 4, 1], [1, 5, 6, 7, 1],
    [1, [60, -40]], // the notch: outside
    [3, [-50, -60]], // inside the first square
    [6, [60, 50]] // inside the second square
  ], shared);
  const b = metreBounds(-150, -150, 150, 150);
  // (closed square ways would be taken for plaza outlines)
  const g = SGM.buildRoadGraph(els, 35, 135, { mergeRadiusMeters: 5, dropAreaOutlines: false, bounds: b });
  const has = (wid) => g.edges.some((e) => e.wayIds.includes(wid)) || g.tails.some((t) => t.wayIds.includes(wid));
  assert.ok(has(1) && has(2), 'both rings');
  assert.ok(!has(3), 'the notch branch goes');
  assert.ok(has(4) && has(5), 'the branches inside stay');
  assert.strictEqual(g.stats.components, 1);
  assert.deepStrictEqual(outsideOutline(g, 0.5), []);
});

test('outline: lines crossing without a shared point (bridges) do not break the outline', () => {
  // 3 x 3 blocks; an elevated road from (-100, -50) on the west street to (50, 100) on the
  // north street crosses two streets without shared points; a branch inside the grid from
  // (100, 100) to (70, 70), and one leaving it from (-100, -50) to (-130, -50)
  const grid = sharedGrid(100, 100);
  Object.assign(grid.shared, { 500: [-100, -50], 501: [50, 100] });
  grid.ways[3] = [grid.id(-100, -100), 500, grid.id(-100, 0), grid.id(-100, 100)];
  grid.ways[2] = [grid.id(-100, 100), grid.id(0, 100), 501, grid.id(100, 100)];
  grid.ways.push([500, 501]); // elevated
  const wElev = grid.ways.length;
  grid.ways.push([grid.id(100, 100), [70, 70]]); // inside
  const wIn = grid.ways.length;
  grid.ways.push([500, [-130, -50]]); // outside
  const wOut = grid.ways.length;
  const els = metreWays(grid.ways, grid.shared);
  const b = metreBounds(-150, -150, 150, 150);
  const g = SGM.buildRoadGraph(els, 35, 135, { mergeRadiusMeters: 5, bounds: b });
  const has = (wid) => g.edges.some((e) => e.wayIds.includes(wid)) || g.tails.some((t) => t.wayIds.includes(wid));
  assert.ok(has(wElev) && has(wIn) && !has(wOut));
  assert.ok(g.bridges.length >= 2, `${g.bridges.length} bridges`);
  assert.deepStrictEqual(outsideOutline(g, 0.5), []);
  const P = metresProjector(35, 135);
  const o = g.outline.map(([la, lo]) => P(la, lo));
  let per = 0;
  for (let i = 1; i < o.length; i++) per += Math.hypot(o[i][0] - o[i - 1][0], o[i][1] - o[i - 1][1]);
  assert.ok(Math.abs(per - 800) < 2, `outline ${per.toFixed(1)} m (the grid's border)`);
});

test('outline: the 33 bundled boards and the Kyoto range are one part, with nothing outside the outline and their inner dead ends kept', () => {
  const boards = [];
  for (const p of SGM.PRESETS) {
    const d = readPreset(p.file);
    for (const t of [36, 81, 169]) boards.push([`${p.query} ${t}`, SGM.buildRoadGraph(d.elements, d.location.lat, d.location.lon, { targetNodes: t, coverageM: 1300 })]);
  }
  const k = readPreset('presets/kyoto-shijo-karasuma.json');
  boards.push(['kyoto range', SGM.buildRoadGraph(k.elements, 0, 0, { bounds: KYOTO_RANGE })]);
  let deadEnds = 0;
  for (const [label, g] of boards) {
    assert.strictEqual(g.stats.components, 1, label);
    // (the outline follows the roads; a drawn line is straightened when the road stays within
    // 4 m of the straight line, else simplified within 2.5 m)
    assert.deepStrictEqual(outsideOutline(g, 4.5), [], label);
    deadEnds += kindsOf(g, 'deadEnd').length;
  }
  assert.ok(deadEnds > 30, `${deadEnds} dead ends inside the outlines`);
});

test('warning: no bundled board (11 places x 36/81/169) shows a warning', () => {
  for (const p of SGM.PRESETS) {
    const d = readPreset(p.file);
    for (const t of [36, 81, 169]) {
      const g = SGM.buildRoadGraph(d.elements, d.location.lat, d.location.lon, { targetNodes: t, coverageM: 1300 });
      assert.deepStrictEqual(g.stats.quality.warnings, [], `${p.query} ${t}`);
    }
  }
});

test('staggered junctions (two T junctions 25 m apart) merge onto one of them; every line stays on the roads', () => {
  const els = metreWays([
    [[-200, 0], 1, 2, [200, 0]], // the east-west street through both T junctions
    [1, [0, 200]], // the street from the north meets it at (0, 0)
    [2, [25, -200]] // the street to the south leaves at (25, 0)
  ], { 1: [0, 0], 2: [25, 0] });
  const b = metreBounds(-210, -210, 210, 210);
  const g = SGM.buildRoadGraph(els, 35, 135, { bounds: b }); // merge radius 30 m
  const js = kindsOf(g, 'junction');
  assert.strictEqual(js.length, 1, 'one merged point');
  const p = toMetres(js[0].lat, js[0].lon);
  assert.ok(Math.hypot(p[0], p[1]) < 1 || Math.hypot(p[0] - 25, p[1]) < 1, `merged point at (${p[0].toFixed(1)}, ${p[1].toFixed(1)})`);
  assert.strictEqual(js[0].neighbors.size, 4);
  assertEdgesOnRoads(g, els, 3, 'staggered');
});

test('Kyoto 81: the point at the staggered Bukkoji junction sits on one of its real junctions', async () => {
  SGM.clearCaches();
  SGM.setPresetFetcher(localPresetFetcher);
  const g = await withFetch(noNetwork(), () => SGM.generateStreetGoBoard('京都 四条烏丸', { targetNodes: 81 }, null, { allowNetwork: false }));
  const data = readPreset('presets/kyoto-shijo-karasuma.json');
  const osm = new Map(data.elements.filter((e) => e.type === 'node').map((e) => [e.id, e]));
  const P = metresProjector(data.location.lat, data.location.lon);
  const a = P(osm.get(309117163).lat, osm.get(309117163).lon);
  const c = P(osm.get(309117162).lat, osm.get(309117162).lon);
  const mid = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
  let near = null;
  let nd = Infinity;
  for (const n of g.nodes.values()) {
    const q = P(n.lat, n.lon);
    const d = Math.hypot(q[0] - mid[0], q[1] - mid[1]);
    if (d < nd) { nd = d; near = q; }
  }
  const off = Math.min(Math.hypot(near[0] - a[0], near[1] - a[1]), Math.hypot(near[0] - c[0], near[1] - c[1]));
  assert.ok(off <= 3, `the point is ${off.toFixed(1)} m from both real junctions`);
  SGM.clearCaches();
});

test('Kyoto 81: Karasuma-dori stays on one carriageway between its last junctions, no bridges on it', async () => {
  SGM.clearCaches();
  SGM.setPresetFetcher(localPresetFetcher);
  const g = await withFetch(noNetwork(), () => SGM.generateStreetGoBoard('京都 四条烏丸', { targetNodes: 81 }, null, { allowNetwork: false }));
  const KARASUMA = [20927292, 174762085, 978085966, 978085963, 973565732, 981951782];
  const P = metresProjector(35.0037, 135.7597);
  const lines = g.edges.filter((e) => e.wayIds.some((w) => KARASUMA.includes(w))).map((e) => e.coords)
    .concat(g.tails.filter((t) => t.wayIds.some((w) => KARASUMA.includes(w))).map((t) => t.coords));
  // north of Shijo-dori (y = -390; south of it only one carriageway is left between junctions)
  const pts = lines.flat().map(([la, lo]) => P(la, lo)).filter((p) => p[1] > -380);
  const xs = pts.map((p) => p[0]);
  assert.ok(Math.max(...xs) - Math.min(...xs) <= 4, `Karasuma-dori drawn between x = ${Math.min(...xs).toFixed(1)} and ${Math.max(...xs).toFixed(1)} (the carriageways are ~10 m apart)`);
  const ys = pts.map((p) => p[1]);
  assert.ok(Math.max(...ys) > 250 && Math.min(...ys) < -250, 'from its northern to its southern junctions');
  const b = g.boardBounds;
  assert.ok(!lines.flat().some(([la]) => Math.abs(la - b.north) < 1e-9 || Math.abs(la - b.south) < 1e-9), 'not drawn to the frame');
  for (const br of g.bridges) {
    const p = P(br.lat, br.lon);
    assert.ok(Math.abs(p[0]) > 20, `a bridge at (${p[0].toFixed(0)}, ${p[1].toFixed(0)}) on Karasuma-dori`);
  }
  SGM.clearCaches();
});

test('loops and second routes: shape points keep away from other points (Sapporo 169)', () => {
  const d = readPreset('presets/sapporo-odori.json');
  const g = SGM.buildRoadGraph(d.elements, d.location.lat, d.location.lon, { targetNodes: 169, coverageM: 1300 });
  const shapes = kindsOf(g, 'shape');
  for (const a of shapes) {
    for (const n of g.nodes.values()) {
      if (n === a) continue;
      assert.ok(SGM.distanceMeters(a.lat, a.lon, n.lat, n.lon) >= 8, `shape point ${a.id} is ${SGM.distanceMeters(a.lat, a.lon, n.lat, n.lon).toFixed(1)} m from ${n.id}`);
    }
  }
});

test('S1: two roads ending 0.5 m apart without a shared node stay unjoined', () => {
  const grid = sharedGrid(200, 100);
  const els = metreWays(grid.ways.concat([[[-80, 50], [-50, 50]], [[-50, 50.5], [-50, 90]]]), grid.shared);
  const g = SGM.buildRoadGraph(els, 35, 135, { mergeRadiusMeters: 5, dropAreaOutlines: false, bounds: metreBounds(-230, -230, 230, 230) });
  const a = g.edges.filter((e) => e.wayIds.includes(grid.ways.length + 1));
  const b = g.edges.filter((e) => e.wayIds.includes(grid.ways.length + 2));
  for (const x of a) for (const y of b) assert.ok(![x.u, x.v].some((p) => p === y.u || p === y.v), 'joined by distance');
});

test('S2: removing a small loop never leaves a point joined to itself', () => {
  // A and B joined by two bulging routes; a 48 m loop at A; B has two branches out
  const els = metreWays([
    [1, [50, 40], [100, 40], 2], [1, [50, -40], [100, -40], 2],
    [1, [-8, 6], [-14, 0], [-8, -6], 1],
    [2, [200, 30]], [2, [200, -30]]
  ], { 1: [0, 0], 2: [150, 0] });
  const g = SGM.buildRoadGraph(els, 35, 135, { mergeRadiusMeters: 5, dropAreaOutlines: false, bounds: metreBounds(-50, -100, 250, 100) });
  for (const n of g.nodes.values()) assert.ok(!n.neighbors.has(n.id), `${n.id} is its own neighbour`);
  for (const e of g.edges) assert.notStrictEqual(e.u, e.v);
  // the remaining ring keeps three different points or more
  const ringPts = new Set(g.edges.filter((e) => e.wayIds.includes(1) || e.wayIds.includes(2)).flatMap((e) => [e.u, e.v]));
  assert.ok(ringPts.size >= 3, `${ringPts.size} points on the ring`);
});

test('S4: two parallel 30 m+ roads of their own crossing the frame (no junction inside) are not used, and are counted', () => {
  const grid = sharedGrid(200, 100);
  const els = metreWays(grid.ways.concat([[[-150, 165], [-150, 230]], [[-145, 168], [-145, 230]]]), grid.shared);
  const b = metreBounds(-230, -230, 230, 199);
  const g = SGM.buildRoadGraph(els, 35, 135, { mergeRadiusMeters: 5, dropAreaOutlines: false, bounds: b });
  for (const wid of [grid.ways.length + 1, grid.ways.length + 2]) {
    assert.ok(!g.edges.some((x) => x.wayIds.includes(wid)) && !g.tails.some((x) => x.wayIds.includes(wid)), `road ${wid} is used`);
  }
  // 34 + 31 m (the grid's top row, 1 m outside, lies on the frame and keeps its junctions)
  assert.ok(Math.abs(g.stats.coverage.droppedM.leavingRange - (34 + 31)) <= 1, JSON.stringify(g.stats.coverage));
  assert.strictEqual(g.tails.length, 0);
  assert.strictEqual(g.stats.coverage.tailM, 0);
});

test('S5: a road crossing the frame at a shallow angle is not used from its junction on', () => {
  const grid = sharedGrid(150, 75);
  const els = metreWays(grid.ways.concat([[grid.id(-150, 150), [-150, 197], [150, 203]]]), grid.shared);
  const b = metreBounds(-230, -230, 230, 200);
  const g = SGM.buildRoadGraph(els, 35, 135, { mergeRadiusMeters: 5, dropAreaOutlines: false, bounds: b });
  const wid = grid.ways.length + 1;
  assert.strictEqual(g.edges.filter((x) => x.wayIds.includes(wid)).length, 0);
  // inside: 47 m up, then 150 m to where it crosses the frame (x = 0)
  assert.ok(Math.abs(g.stats.coverage.droppedM.leavingRange - (47 + Math.hypot(150, 3))) <= 1, JSON.stringify(g.stats.coverage));
  const corner = Array.from(g.nodes.values()).find((n) => { const p = toMetres(n.lat, n.lon); return Math.hypot(p[0] + 150, p[1] - 150) < 0.5; });
  assert.ok(corner && corner.neighbors.size === 2 && corner.kind === 'junction', 'the grid corner keeps its two roads');
});

test('S6: a straight street with two gaps is joined across both', () => {
  const grid = sharedGrid(200, 200);
  const els = metreWays(grid.ways.concat([
    [grid.id(-200, 0), [-150, 100], [-80, 100]], [[-70, 100], [0, 100]], [[10, 100], [100, 100], grid.id(200, 0)]
  ]), grid.shared);
  const g = SGM.buildRoadGraph(els, 35, 135, { mergeRadiusMeters: 5, dropAreaOutlines: false, bounds: metreBounds(-230, -230, 230, 230) });
  assert.strictEqual(g.stats.facingJoined, 2);
  assert.strictEqual(g.stats.components, 1);
});

test('S9: the 4 m straight-line rule applies to the line as drawn, ends moved or not', () => {
  const { nodes, edges, ll } = metreGraph({ a: [0, 7], b: [100, 0] }, [['a', 'b', [[10, 0]]]]);
  edges[0].rawEnds = [ll([0, 0]), ll([100, 0])];
  const out = SGM.buildDisplayShapes(nodes, edges, null);
  assert.strictEqual(out[0].coords.length, 3, 'the bend 6.3 m off the straight line stays');
});

test('S10: coverage is out of every road of the query in the range, area outlines counted by reason', async () => {
  SGM.clearCaches();
  const d = seedPresetRoads('newyork-midtown');
  const b = squareAround(d.location.lat, d.location.lon, 800);
  const on = await withFetch(noNetwork(), () => SGM.generateStreetGoBoardInBounds(b, {}, null, {}));
  const off = await withFetch(noNetwork(), () => SGM.generateStreetGoBoardInBounds(b, { dropAreaOutlines: false }, null, {}));
  // (the pieces leading out of the range depend on which lines are roads: added back)
  const all = (g) => g.stats.coverage.totalM + g.stats.coverage.droppedM.leavingRange;
  assert.ok(Math.abs(all(on) - all(off)) <= 2, `${all(on)} vs ${all(off)}`);
  assert.ok(on.stats.coverage.droppedM.areaOutline > 1000);
  assert.ok(on.stats.coverage.rate < 0.9, 'outlines left out lower the coverage');
  SGM.clearCaches();
});

test('I5: the first road request for a place covers the square the search picks (11 places x 36-361 points)', async () => {
  // the corners of the square found around the place lie within the first radius: no second
  // request (the square is moved afterwards only where its corners stay within the data)
  for (const target of [36, 81, 169]) {
    const radius = Math.max(400, Math.round(Math.sqrt(target) * 95));
    for (const p of SGM.PRESETS) {
      const d = readPreset(p.file);
      const g = SGM.buildRoadGraph(d.elements, d.location.lat, d.location.lon, { targetNodes: target, coverageM: 1300 });
      const far = (g.stats.sideM / 2) * Math.SQRT2;
      assert.ok(far <= radius, `${p.query} ${target}: corner ${far.toFixed(0)} m > first radius ${radius} m`);
    }
  }
  // the request itself (a place that is not bundled): one request with that radius
  SGM.clearCaches();
  const d = readPreset('presets/kyoto-shijo-karasuma.json');
  const bodies = [];
  await withFetch(async (url, init) => {
    if (url.includes('nominatim')) return jsonResponse(200, [{ lat: String(d.location.lat), lon: String(d.location.lon), display_name: 'x' }]);
    bodies.push(decodeURIComponent(init.body));
    return jsonResponse(200, { elements: d.elements });
  }, () => SGM.generateStreetGoBoard('テスト用の地名', { targetNodes: 81 }, null, {}));
  assert.strictEqual(bodies.length, 1, 'one Overpass request');
  // the rectangle holding the circle of 855 m around the place (no "around" search)
  assert.strictEqual(bodies[0], `data=${SGM.buildOverpassQuery(d.location.lat, d.location.lon, 855, 'simple')}`);
  const bb = /\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\);/.exec(bodies[0]);
  assert.ok(bb && !bodies[0].includes('around:'), bodies[0]);
  const [s0, w0, n0, e0] = bb.slice(1).map(Number);
  const { lat, lon } = d.location;
  for (const [la, lo] of [[s0, lon], [n0, lon], [lat, w0], [lat, e0]]) {
    const m = SGM.distanceMeters(lat, lon, la, lo);
    assert.ok(m >= 855 && m <= 855 * 1.01 + 2, `side ${m} m from the centre`);
  }
  SGM.clearCaches();
});

test('I6: no code of the former simplification is left', () => {
  const src = fs.readFileSync(path.join(ROOT, 'map-graph.js'), 'utf8');
  for (const name of ['simplifyBoardGraph', 'pruneToLargestComponent', 'clipPolylineToBounds', 'splitPolyline', 'largestComponentSize', 'edgeBearingAt', 'THROUGH_LOOK_M', 'MAX_NODE_DEGREE', 'SQUARE_MARGINS_M']) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(src), `${name} is still there`);
  }
});

test('S12: a way without its node list is an incomplete response (not cached)', async () => {
  const data = readPreset('presets/kyoto-shijo-karasuma.json');
  const els = data.elements.map((e) => ({ ...e }));
  delete els.find((e) => e.type === 'way').nodes;
  assert.throws(() => SGM.validateOverpassJson({ elements: els }), (e) => e.kind === 'incomplete');
  const one = data.elements.map((e) => ({ ...e }));
  one.find((e) => e.type === 'way').nodes = [one.find((e) => e.type === 'way').nodes[0]];
  assert.throws(() => SGM.validateOverpassJson({ elements: one }), (e) => e.kind === 'incomplete');
  SGM.clearCaches();
  await withFetch(async () => jsonResponse(200, { elements: els }), () => rejectsKind(SGM.fetchOverpassRoads(35, 135, 300), 'incomplete'));
  assert.strictEqual(SGM.findCachedRoads(35, 135, 300), null);
});

test('drawn lines follow the road: Paris arcs are drawn along the arc (item 6)', async () => {
  SGM.clearCaches();
  SGM.setPresetFetcher(localPresetFetcher);
  const g = await withFetch(noNetwork(), () => SGM.generateStreetGoBoard('Paris Arc de Triomphe', { targetNodes: 81 }, null, { allowNetwork: false }));
  const P = metresProjector(48.8738, 2.295);
  let arcs = 0;
  for (const e of g.edges) {
    const road = e.roadCoords.map(([la, lo]) => P(la, lo));
    const drawn = e.coords.map(([la, lo]) => P(la, lo));
    let dev = 0;
    for (let i = 1; i < road.length - 1; i++) dev = Math.max(dev, pointSegDist(road[i], road[0], road[road.length - 1]));
    let off = 0;
    for (const q of road) off = Math.max(off, pointPolyDist(q, drawn));
    for (const q of drawn) off = Math.max(off, pointPolyDist(q, road));
    if (dev > 8) {
      arcs++;
      assert.ok(drawn.length >= 3, `${e.u}-${e.v}: a road bending ${dev.toFixed(0)} m is drawn straight`);
      assert.ok(off <= 2.6, `${e.u}-${e.v}: drawn ${off.toFixed(1)} m off its road`);
    } else {
      assert.ok(off <= 8.1, `${e.u}-${e.v}: drawn ${off.toFixed(1)} m off its road`);
    }
  }
  assert.ok(arcs >= 5, `${arcs} curved roads`);
  SGM.clearCaches();
});

test('side by side: two carriageways become one centre line; a side road keeps its own way out (C3, S4)', () => {
  // Carriageways y = +5 and y = -5 from x = -300 to 300, joined at both ends; cross streets at
  // x = -150, 0, 150 cross both (shared nodes). A side road leaves the south carriageway at
  // x = 200, runs along it 8 m away for 60 m and turns south to (330, -200).
  const shared = {};
  const north = [];
  const south = [];
  let id = 1;
  for (const x of [-300, -150, 0, 150, 300]) {
    shared[id] = [x, 5]; north.push(id++);
    shared[id] = [x, -5]; south.push(id++);
  }
  shared[50] = [200, -5];
  const southWay = south.slice(0, 4).concat([50, south[4]]);
  const ways = [north, southWay];
  for (let k = 1; k <= 3; k++) ways.push([[[-150, 0, 150][k - 1], 150], north[k], south[k], [[-150, 0, 150][k - 1], -150]]);
  ways.push([north[0], south[0]], [north[4], south[4]]); // the carriageways meet at both ends
  ways.push([50, [215, -13], [270, -13], [330, -200]]); // the side road
  const els = metreWays(ways, shared);
  const b = metreBounds(-350, -250, 350, 250);
  const g = SGM.buildRoadGraph(els, 35, 135, { mergeRadiusMeters: 5, bounds: b });
  assertBoardInvariants(g, b, 'carriageways');
  // no two lines run side by side any more: every edge carrying a carriageway carries both
  const both = g.edges.filter((e) => e.wayIds.includes(1) || e.wayIds.includes(2));
  assert.ok(both.length >= 4);
  for (const e of both.filter((x) => x.length > 20)) {
    assert.ok(e.wayIds.includes(1) && e.wayIds.includes(2), `${e.u}-${e.v} carries only ${e.wayIds.join(',')}`);
    for (const [la] of e.coords) assert.ok(Math.abs(toMetres(la, 135)[1]) <= 5.5, 'the line lies on a carriageway or between them');
  }
  // one point per cross street on the centre line
  for (const x of [-150, 0, 150]) {
    const pts = Array.from(g.nodes.values()).filter((n) => { const p = toMetres(n.lat, n.lon); return Math.abs(p[0] - x) < 6 && Math.abs(p[1]) < 6; });
    assert.strictEqual(pts.length, 1, `cross street at ${x}`);
    assert.strictEqual(pts[0].neighbors.size, 4);
  }
  // the side road still reaches its own end, joined where it leaves the main road
  const side = g.edges.filter((e) => e.wayIds.includes(ways.length));
  assert.ok(side.length >= 1, 'side road kept');
  const endPt = Array.from(g.nodes.values()).find((n) => { const p = toMetres(n.lat, n.lon); return Math.hypot(p[0] - 330, p[1] + 200) < 1; });
  assert.ok(endPt && endPt.kind === 'deadEnd', 'the side road keeps its far end');
  assert.ok(isConnected(g.nodes));
  assertEdgesOnRoads(g, els, 8, 'carriageways');
});

test('side by side: a viaduct over a street, not joined to it nearby, is not merged into it (S2)', () => {
  // A street y = 0 (x -300..300) with cross streets; a viaduct y = 8 over it from x = -250 to
  // 250, its ramps join the cross streets 120 m north at x = -250 / 250 (far by road)
  const grid = sharedGrid(300, 150);
  grid.shared[700] = [-250, 8];
  grid.shared[701] = [250, 8];
  grid.shared[702] = [-150, 120];
  grid.shared[703] = [150, 120];
  grid.ways[1 + 5] = [grid.id(-150, -300), grid.id(-150, -150), grid.id(-150, 0), 702, grid.id(-150, 150), grid.id(-150, 300)];
  grid.ways[3 + 5] = [grid.id(150, -300), grid.id(150, -150), grid.id(150, 0), 703, grid.id(150, 150), grid.id(150, 300)];
  grid.ways.push([700, [-100, 8], [0, 8], [100, 8], 701]); // the viaduct
  const viaduct = grid.ways.length;
  grid.ways.push([700, [-250, 80], 702], [701, [250, 80], 703]); // ramps
  const els = metreWays(grid.ways, grid.shared);
  const b = metreBounds(-330, -330, 330, 330);
  const g = SGM.buildRoadGraph(els, 35, 135, { mergeRadiusMeters: 5, bounds: b });
  const v = g.edges.filter((e) => e.wayIds.includes(viaduct));
  assert.ok(v.length >= 1);
  const streetId = 3; // the row y = 0
  for (const e of v) assert.ok(!e.wayIds.includes(streetId), 'the viaduct is not merged with the street');
  assert.ok(g.edges.some((e) => e.wayIds.includes(streetId) && !e.wayIds.includes(viaduct)), 'the street stays');
  // its line stays 8 m north of the street, and it crosses the three cross streets as bridges
  for (const e of v) {
    for (const [la, lo] of e.coords) {
      const [x, y] = toMetres(la, lo);
      if (Math.abs(x) < 240 && y < 60) assert.ok(Math.abs(y - 8) < 0.5, `viaduct at (${x.toFixed(0)}, ${y.toFixed(1)})`);
    }
  }
  assert.strictEqual(g.bridges.length, 3, 'over the cross streets at x = -150, 0, 150');
  assertEdgesOnRoads(g, els, 1, 'viaduct');
});

test('shape: a simpler line that would cross a road a different number of times keeps the road course (S10)', () => {
  // a-b zigzags across e-f twice; drawn straight it would not cross it at all
  const { nodes, edges } = metreGraph(
    { a: [0, 0], b: [100, 0], e: [20, 2], f: [80, 2] },
    [['a', 'b', [[30, 5], [50, -1], [70, 5]]], ['e', 'f']]
  );
  const before = SGM.countEdgeCrossings(nodes, edges);
  assert.strictEqual(before, 1);
  const out = SGM.buildDisplayShapes(nodes, edges, null);
  assert.strictEqual(out[0].coords.length, 5, 'a-b keeps its course');
  // and a line through the meeting point of two other lines (three lines at one place) stays too
  const t = metreGraph(
    { a: [0, 0], b: [100, 0], c: [50, -50], d: [50, 50], e: [30, -40], f: [70, 40] },
    [['a', 'b', [[50, 6]]], ['c', 'd'], ['e', 'f']]
  );
  const outT = SGM.buildDisplayShapes(t.nodes, t.edges, null);
  assert.strictEqual(outT[0].coords.length, 3, 'straight a-b would pass through the c-d / e-f crossing');
});

test('cancel: a board build stops at the next step; the time of the worst preset board stays under 1 s (C9, S13)', async () => {
  SGM.clearCaches();
  seedPresetRoads('newyork-midtown');
  const ac = new AbortController();
  ac.abort();
  await withFetch(noNetwork(), () =>
    rejectsKind(SGM.generateStreetGoBoardInBounds(rectAround(40.7536, -73.9832, 800, 800), {}, null, { signal: ac.signal }), 'aborted'));
  // the largest square boards of the bundled data (361 points wanted)
  SGM.setPresetFetcher(localPresetFetcher);
  let worst = 0;
  for (const q of ['ニューヨーク ミッドタウン', 'バルセロナ アシャンプラ', 'Paris Arc de Triomphe']) {
    SGM.clearCaches();
    const t0 = Date.now();
    const g = await withFetch(noNetwork(), () => SGM.generateStreetGoBoard(q, { targetNodes: 361 }, null, { allowNetwork: false }));
    worst = Math.max(worst, Date.now() - t0);
    assert.ok(g.stats.nodeCount <= 450);
  }
  assert.ok(worst < 1000, `${worst} ms`);
  // far too many roads in a drawn range: refused with a message to narrow it
  SGM.clearCaches();
  const big = meterGrid(80, 40, 35, 135);
  assert.throws(() => SGM.buildRoadGraph(big.els, 35, 135, { mergeRadiusMeters: 5, bounds: { south: 34.999, north: 35.03, west: 134.999, east: 135.04 } }),
    (err) => err.kind === 'too-many' && /範囲を狭めてください/.test(err.message));
  SGM.clearCaches();
});

// ---------------------------------------------------------------------------
// Drawn ranges: sides moved to the nearest ring of roads (A), small boards (B), the requests
// and their cache (C), wide ranges with major roads only (D)

// Distance (m) of the board's outline (its bounding rectangle) from each drawn side
function outlineSideDev(g, b) {
  const k = 111195 * Math.cos((((b.south + b.north) / 2) * Math.PI) / 180);
  let s = Infinity;
  let n = -Infinity;
  let w = Infinity;
  let e = -Infinity;
  for (const [la, lo] of g.outline) {
    s = Math.min(s, la);
    n = Math.max(n, la);
    w = Math.min(w, lo);
    e = Math.max(e, lo);
  }
  return { west: Math.abs(w - b.west) * k, east: Math.abs(e - b.east) * k, south: Math.abs(s - b.south) * 111195, north: Math.abs(n - b.north) * 111195 };
}
const sumDev = (d) => d.west + d.east + d.south + d.north;

test('fit A: Kyoto 500 m square: more points, the outline within 150 m of each drawn side, the frame holds the board', async () => {
  SGM.clearCaches();
  const d = seedPresetRoads('kyoto-shijo-karasuma');
  const b = squareAround(d.location.lat, d.location.lon, 500);
  const asDrawn = SGM.buildRoadGraph(d.elements, 0, 0, { bounds: b });
  const g = await withFetch(noNetwork(), () => SGM.generateStreetGoBoardInBounds(b, {}, null, { allowNetwork: false }));
  assert.ok(g.stats.nodeCount > asDrawn.nodes.size, `${g.stats.nodeCount} points, ${asDrawn.nodes.size} as drawn`);
  assert.ok(g.outline, 'a ring of roads is the outline');
  const dev = outlineSideDev(g, b);
  for (const [side, m] of Object.entries(dev)) assert.ok(m <= 150, `${side}: outline ${m.toFixed(0)} m from the drawn side`);
  assert.ok(sumDev(dev) < sumDev(outlineSideDev(asDrawn, b)), 'nearer than the board cut as drawn');
  assert.ok(Math.abs(sumDev(dev) - g.stats.fit.deviationM.total) <= 2, JSON.stringify(g.stats.fit));
  assertSidesMoved(g.boardBounds, b, SGM.FIT_SHIFT_M, 'kyoto 500');
  assertBoardInvariants(g, g.boardBounds, 'kyoto 500');
  assertBoardInside(g, g.frameBounds, 'kyoto 500 (frame)');
  assert.deepStrictEqual(g.drawnBounds, b);
  assert.ok(g.stats.fit.builds >= 2 && g.stats.fit.builds <= SGM.FIT_MAX_BUILDS);
  // the same range gives the same board
  const again = await withFetch(noNetwork(), () => SGM.generateStreetGoBoardInBounds(b, {}, null, { allowNetwork: false }));
  assert.deepStrictEqual(boardSignature(again), boardSignature(g));
  assert.deepStrictEqual(again.boardBounds, g.boardBounds);
  SGM.clearCaches();
});

test('fit A: a 200 m range 250 m north of Shijo-Karasuma (no board as drawn) makes a board of 9 points or more', async () => {
  SGM.clearCaches();
  const d = seedPresetRoads('kyoto-shijo-karasuma');
  const b = squareAround(d.location.lat + 250 / 111000, d.location.lon, 200);
  const asDrawn = SGM.buildRoadGraph(d.elements, 0, 0, { bounds: b });
  assert.ok(asDrawn.nodes.size < 9, `${asDrawn.nodes.size} points as drawn`);
  const g = await withFetch(noNetwork(), () => SGM.generateStreetGoBoardInBounds(b, {}, null, { allowNetwork: false }));
  assert.ok(g.stats.nodeCount >= 9 && g.outline);
  assertSidesMoved(g.boardBounds, b, g.stats.fit.maxShiftM, 'kyoto 200');
  SGM.clearCaches();
});

test('fit A: sides already just outside a ring of roads stay where they are (the range as drawn is a candidate)', async () => {
  SGM.clearCaches();
  const grid = meterGrid(9, 100, 35, 135); // lines every 100 m, 800 m across
  SGM.seedRoadCache(grid.center[0], grid.center[1], 3000, grid.els, false);
  // 10 m outside the lines 200 m from the centre: the outline is 10 m from each side
  const dLat = 210 / 111195;
  const dLon = 210 / (111195 * Math.cos((grid.center[0] * Math.PI) / 180));
  const b = { south: grid.center[0] - dLat, north: grid.center[0] + dLat, west: grid.center[1] - dLon, east: grid.center[1] + dLon };
  const g = await withFetch(noNetwork(), () => SGM.generateStreetGoBoardInBounds(b, { mergeRadiusMeters: 5 }, null, { allowNetwork: false }));
  assert.deepStrictEqual(g.stats.fit.offsets, { west: 0, east: 0, south: 0, north: 0 });
  assert.deepStrictEqual(g.boardBounds, b);
  assert.strictEqual(g.stats.nodeCount, SGM.buildRoadGraph(grid.els, 0, 0, { bounds: b, mergeRadiusMeters: 5 }).nodes.size);
  for (const m of Object.values(outlineSideDev(g, b))) assert.ok(Math.abs(m - 10) < 1, String(m));
  SGM.clearCaches();
});

test('fit A: the search stops at its time limit with the best board so far (the first two builds always run)', async () => {
  SGM.clearCaches();
  const d = seedPresetRoads('kyoto-shijo-karasuma');
  const b = squareAround(d.location.lat, d.location.lon, 500);
  const full = await withFetch(noNetwork(), () => SGM.generateStreetGoBoardInBounds(b, {}, null, { allowNetwork: false }));
  assert.ok(full.stats.fit.builds > 2, `${full.stats.fit.builds} builds`);
  const quick = await withFetch(noNetwork(), () => SGM.generateStreetGoBoardInBounds(b, {}, null, { allowNetwork: false, fitMaxMs: 0 }));
  assert.strictEqual(quick.stats.fit.builds, 2);
  assert.strictEqual(quick.stats.fit.stopped, true);
  assert.ok(quick.stats.nodeCount >= 9);
  assert.strictEqual(SGM.FIT_MAX_MS, 1500);
  assert.strictEqual(SGM.FIT_MAX_BUILDS, 40);
  SGM.clearCaches();
});

test('fit A: worst time of a drawn range on dense data (every side free to move) stays under 1.6 s', async () => {
  // the bundled data registered as covering everything: no rectangle is ruled out
  let worst = 0;
  let worstAt = '';
  for (const name of ['nagoya-sakae', 'melbourne-cbd', 'tokyo-ginza']) {
    const d = readPreset(`presets/${name}.json`);
    for (const side of [1200, 2000]) {
      SGM.clearCaches();
      SGM.seedRoadCache(d.location.lat, d.location.lon, 50000, d.elements, true, 'simple');
      const b = squareAround(d.location.lat, d.location.lon, side);
      const t0 = Date.now();
      try {
        await withFetch(noNetwork(), () => SGM.generateStreetGoBoardInBounds(b, {}, null, { allowNetwork: false }));
      } catch (err) {
        if (err.kind !== 'too-many') throw err;
      }
      const ms = Date.now() - t0;
      if (ms > worst) {
        worst = ms;
        worstAt = `${name} ${side}`;
      }
    }
  }
  assert.ok(worst < 1600, `${worst} ms (${worstAt})`);
  SGM.clearCaches();
});

// A square ring of roads (side m metres) around (lat, lon) with a 30 m dead end into it from
// the middle of each side: 4 junctions + 4 dead ends = 8 points
function ringWithSpurs(lat, lon, m) {
  const ky = 111195;
  const kx = 111195 * Math.cos((lat * Math.PI) / 180);
  const at = (x, y) => ({ lat: lat + y / ky, lon: lon + x / kx });
  const h = m / 2;
  const pts = [[-h, -h], [0, -h], [h, -h], [h, 0], [h, h], [0, h], [-h, h], [-h, 0]];
  const els = pts.map(([x, y], i) => ({ type: 'node', id: i + 1, ...at(x, y) }));
  // (four ways, one per side: a single closed way with four corners would be taken for the
  // outline of an area)
  [[1, 2, 3], [3, 4, 5], [5, 6, 7], [7, 8, 1]].forEach((nodes, i) => els.push({ type: 'way', id: 1 + 20 * i, nodes }));
  [[2, 0, -h + 30], [4, h - 30, 0], [6, 0, h - 30], [8, -h + 30, 0]].forEach(([from, x, y], i) => {
    els.push({ type: 'node', id: 100 + i, ...at(x, y) });
    els.push({ type: 'way', id: 10 + i, nodes: [from, 100 + i] });
  });
  return els;
}

test('fit B: only a board of 4-8 points with an outline: offered with a question (kind small-board, the board attached)', async () => {
  SGM.clearCaches();
  const els = ringWithSpurs(35, 135, 160);
  SGM.seedRoadCache(35, 135, 3000, els, false);
  const b = squareAround(35, 135, 200);
  const err = await withFetch(noNetwork(), () => rejectsKind(SGM.generateStreetGoBoardInBounds(b, {}, null, { allowNetwork: false }), 'small-board'));
  assert.ok(err.board && err.board.outline, 'the board comes with the question');
  assert.strictEqual(err.board.stats.nodeCount, 8);
  assert.strictEqual(err.message, '8点の小さな盤です。この盤で始めますか？');
  assert.ok([SGM.FIT_SHIFT_M, SGM.FIT_SHIFT_WIDE_M].includes(err.board.stats.fit.maxShiftM));
  assertBoardInside(err.board, err.board.frameBounds, 'small board');
  assert.strictEqual(SGM.SMALL_BOARD_MIN_NODES, 4);
  // the place boards keep 9 as their least
  assert.throws(() => SGM.assertPlayableBoard(8), (e) => e.kind === 'too-few');
  SGM.clearCaches();
});

test('fit: data at hand first; a request only when it gives no board (small boards included)', async () => {
  // 1. a small board from the data at hand: used (asked about) without any request, although
  //    the data does not reach as far as the wider search could move the sides
  SGM.clearCaches();
  SGM.seedRoadCache(35, 135, 215, ringWithSpurs(35, 135, 160), false);
  const b = squareAround(35, 135, 200);
  const e = await withFetch(noNetwork(), () => rejectsKind(SGM.generateStreetGoBoardInBounds(b, {}, null, {}), 'small-board'));
  assert.strictEqual(e.board.stats.nodeCount, 8);
  // 2. no board from the data at hand: one request for the range + 300 m + 60 m, searched again
  SGM.clearCaches();
  const b2 = squareAround(35, 135, 300);
  SGM.seedRoadCache(35, 135, 290, [{ type: 'node', id: 1, lat: 35, lon: 135 }, { type: 'node', id: 2, lat: 35.001, lon: 135 }, { type: 'way', id: 1, nodes: [1, 2] }], false);
  const bodies = [];
  const g = await withFetch(async (url, init) => {
    bodies.push(decodeURIComponent(init.body));
    return jsonResponse(200, { elements: centredGrid(15, 100, 35, 135) });
  }, () => SGM.generateStreetGoBoardInBounds(b2, {}, null, {}));
  assert.strictEqual(bodies.length, 1);
  assertRequestRect(bodies[0], b2, SGM.FIT_SHIFT_WIDE_M + SGM.DRAW_FETCH_MARGIN_M);
  assert.ok(g.stats.nodeCount >= 9 && g.outline);
  // offline, the same range stops with the error of the data at hand
  SGM.clearCaches();
  SGM.seedRoadCache(35, 135, 290, [{ type: 'node', id: 1, lat: 35, lon: 135 }, { type: 'node', id: 2, lat: 35.001, lon: 135 }, { type: 'way', id: 1, nodes: [1, 2] }], false);
  await withFetch(noNetwork(), () => rejectsKind(SGM.generateStreetGoBoardInBounds(b2, {}, null, { allowNetwork: false }), 'too-few'));
  SGM.clearCaches();
});

test('fit: side positions are on a grid of 25 m x lenScale within +-shift', () => {
  assert.deepStrictEqual(SGM.sidePositions([], 150).slice().sort((x, y) => x - y), [0]);
  const p = SGM.sidePositions([-40, 30], 150);
  assert.ok(p.every((o) => o % 25 === 0 && Math.abs(o) <= 150), p.join(','));
  const q = SGM.sidePositions([-90, 70], 400, 2);
  assert.ok(q.every((o) => Math.abs(o / 50 - Math.round(o / 50)) < 1e-9 && Math.abs(o) <= 400), q.join(','));
  // the line 70 m out is kept by the first position at least 15 m x 2 beyond it
  assert.strictEqual(q[0], 100);
});

test('fit B: fewer than 4 points or no ring: an error with the number of points', async () => {
  SGM.clearCaches();
  // a 2 x 2 grid: one ring without junctions
  SGM.seedRoadCache(35.0, 135.0, 1000, gridElements(2, 35.0, 135.0, 1), false);
  const e1 = await withFetch(noNetwork(), () => rejectsKind(SGM.generateStreetGoBoardInBounds({ south: 34.999, north: 35.002, west: 134.999, east: 135.002 }, { mergeRadiusMeters: 5 }, null, { allowNetwork: false }), 'too-few'));
  assert.ok(/^交点が少なすぎます\(\d点\)。範囲を広げるか別の場所を選んでください$/.test(e1.message), e1.message);
  // a plus-shaped tree of roads: points enough, but no ring for an outline
  SGM.clearCaches();
  const ky = 111195;
  const kx = 111195 * Math.cos((35 * Math.PI) / 180);
  const els = [{ type: 'node', id: 1, lat: 35, lon: 135 }];
  let id = 2;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const ids = [1];
    for (let k = 1; k <= 3; k++) {
      els.push({ type: 'node', id, lat: 35 + (dy * k * 60) / ky, lon: 135 + (dx * k * 60) / kx });
      // a short side branch at every node, so that each is a junction
      els.push({ type: 'node', id: id + 1000, lat: 35 + (dy * k * 60 + dx * 20) / ky, lon: 135 + (dx * k * 60 + dy * 20) / kx });
      els.push({ type: 'way', id: id + 1000, nodes: [id, id + 1000] });
      ids.push(id++);
    }
    els.push({ type: 'way', id: id++, nodes: ids });
  }
  SGM.seedRoadCache(35, 135, 3000, els, false);
  const e2 = await withFetch(noNetwork(), () => rejectsKind(SGM.generateStreetGoBoardInBounds(squareAround(35, 135, 300), { mergeRadiusMeters: 5 }, null, { allowNetwork: false }), 'too-few'));
  assert.ok(/^道が輪になる所がなく、盤の外周をつくれません\(\d+点\)。範囲を広げるか別の場所を選んでください$/.test(e2.message), e2.message);
  assert.ok(Number(/\((\d+)点\)/.exec(e2.message)[1]) >= 9, e2.message);
  SGM.clearCaches();
});

test('fit B: no board within 150 m: the sides move up to 300 m (offline: the data at hand; online: one more request)', async () => {
  // lines every 220 m; a 150 m range in the middle of a block: within 150 m only the block's
  // own ring (4 points); within 300 m the next lines too (16 points)
  const grid = meterGrid(8, 220, 35, 135);
  const [lat, lon] = [35 + (3.5 * 220) / 111195, 135 + (3.5 * 220) / (111195 * Math.cos((35 * Math.PI) / 180))];
  const b = squareAround(lat, lon, 150);
  SGM.clearCaches();
  SGM.seedRoadCache(lat, lon, 3000, grid.els, false);
  const g = await withFetch(noNetwork(), () => SGM.generateStreetGoBoardInBounds(b, { mergeRadiusMeters: 5 }, null, { allowNetwork: false }));
  assert.strictEqual(g.stats.fit.maxShiftM, SGM.FIT_SHIFT_WIDE_M);
  assert.ok(g.stats.nodeCount >= 9, `${g.stats.nodeCount} points`);
  assertSidesMoved(g.boardBounds, b, SGM.FIT_SHIFT_WIDE_M, 'grid 220');
  // online: the first request reaches 150 m + 60 m, the second 300 m + 60 m
  SGM.clearCaches();
  const bodies = [];
  const g2 = await withFetch(async (url, init) => {
    bodies.push(decodeURIComponent(init.body));
    return jsonResponse(200, { elements: grid.els });
  }, () => SGM.generateStreetGoBoardInBounds(b, { mergeRadiusMeters: 5 }, null, {}));
  assert.strictEqual(bodies.length, 2);
  assertRequestRect(bodies[0], b, SGM.FIT_SHIFT_M + SGM.DRAW_FETCH_MARGIN_M);
  assertRequestRect(bodies[1], b, SGM.FIT_SHIFT_WIDE_M + SGM.DRAW_FETCH_MARGIN_M);
  assert.deepStrictEqual(boardSignature(g2), boardSignature(g));
  SGM.clearCaches();
});

// Road mode of a request body (which filter it carries)
function modeOfBody(body) {
  if (body.includes('"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"')) return 'tertiary';
  if (body.includes('"^(motorway|trunk|primary|secondary)(_link)?$"')) return 'secondary';
  if (body.includes('"^(motorway|trunk|primary)(_link)?$"')) return 'primary';
  return body.includes('bridleway') ? 'simple' : 'all';
}

// Grid of lines every spacingM metres, n x n, centred on (lat, lon)
function centredGrid(n, spacingM, lat, lon, idBase = 1) {
  const kx = 111195 * Math.cos((lat * Math.PI) / 180);
  const half = ((n - 1) / 2) * spacingM;
  const g = meterGrid(n, spacingM, lat - half / 111195, lon - half / kx);
  if (idBase === 1) return g.els;
  return g.els.map((e) => (e.type === 'node' ? { ...e, id: e.id + idBase } : { ...e, id: e.id + idBase, nodes: e.nodes.map((x) => x + idBase) }));
}

test('road modes D: by the longer side (4 km: every road; 10 km: tertiary and larger; beyond: secondary and larger); footpaths only up to 4 km', () => {
  assert.strictEqual(SGM.drawRoadMode(4000, false), 'simple');
  assert.strictEqual(SGM.drawRoadMode(4000, true), 'all');
  assert.strictEqual(SGM.drawRoadMode(4000.1, true), 'tertiary');
  assert.strictEqual(SGM.drawRoadMode(10000, false), 'tertiary');
  assert.strictEqual(SGM.drawRoadMode(10000.1, false), 'secondary');
  assert.strictEqual(SGM.drawRoadMode(20000, false), 'secondary');
  const q = (mode) => SGM.buildOverpassBboxQuery({ south: 35, west: 135, north: 35.1, east: 135.1 }, mode);
  assert.strictEqual(modeOfBody(q('tertiary')), 'tertiary');
  assert.strictEqual(modeOfBody(q('secondary')), 'secondary');
  assert.strictEqual(modeOfBody(q('primary')), 'primary');
  for (const mode of ['tertiary', 'secondary', 'primary']) {
    assert.ok(q(mode).includes('(_link)?') && q(mode).includes('(if: !is_tag("tunnel") || t["tunnel"] == "no")'), mode);
    assert.ok(q(mode).includes('(35,135,35.1,135.1);'), 'a rectangle, south-west-north-east');
  }
  assert.ok(!q('secondary').includes('tertiary') && !q('primary').includes('secondary'));
  // unknown modes fall back to the usual query; known ones are kept apart
  assert.strictEqual(SGM.normalizeRoadMode('xyz'), 'simple');
  for (const m of ['simple', 'all', 'tertiary', 'secondary', 'primary']) assert.strictEqual(SGM.normalizeRoadMode(m), m);
});

test('road modes D: 8 km and 20 km ranges are made from major roads, with a larger merge radius', async () => {
  for (const [side, mode, r] of [[8000, 'tertiary', 64], [19900, 'secondary', 80]]) {
    SGM.clearCaches();
    const spacing = side / 8;
    // pairs of north-south roads 50 m apart: one point each at the larger merge radius
    const els = centredGrid(11, spacing, 35, 135).concat(centredGrid(11, spacing, 35, 135 + 50 / (111195 * Math.cos((35 * Math.PI) / 180)), 100000)
      .filter((e) => e.type === 'node' || e.id - 100000 > 11)); // (its north-south lines only)
    const bodies = [];
    const msgs = [];
    const b = squareAround(35, 135, side);
    const g = await withFetch(async (url, init) => {
      bodies.push(decodeURIComponent(init.body));
      return jsonResponse(200, { elements: els });
    }, () => SGM.generateStreetGoBoardInBounds(b, {}, (m) => msgs.push(m), {}));
    assert.deepStrictEqual(bodies.map(modeOfBody), [mode], `${side}`);
    // the sides move up to 150 m x lenScale; the request margin grows the same way
    assert.ok(Math.abs(g.stats.fit.maxShiftM - SGM.FIT_SHIFT_M * g.stats.lenScale) < 1e-6, String(g.stats.fit.maxShiftM));
    assertRequestRect(bodies[0], b, (SGM.FIT_SHIFT_M + SGM.DRAW_FETCH_MARGIN_M) * g.stats.lenScale);
    assertSidesMoved(g.boardBounds, b, g.stats.fit.maxShiftM, `${side} m`);
    assert.strictEqual(g.stats.roadMode, mode);
    assert.ok(Math.abs(g.stats.mergeRadiusM - r) < 0.5, `${g.stats.mergeRadiusM}`);
    assert.ok(Math.abs(g.stats.lenScale - g.stats.mergeRadiusM / 30) < 1e-9);
    assert.ok(g.stats.notices.some((t) => t.includes('大通りだけ')), g.stats.notices.join('|'));
    assert.ok(msgs.some((m) => m.includes('大通り')), msgs.join('|'));
    let near = Infinity;
    const pts = Array.from(g.nodes.values());
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) near = Math.min(near, SGM.distanceMeters(pts[i].lat, pts[i].lon, pts[j].lat, pts[j].lon));
    assert.ok(near > 50, `points ${near.toFixed(0)} m apart: the 50 m pairs are merged`);
    assertBoardInvariants(g, g.boardBounds, `${side} m`);
  }
  // up to 4 km: the setting as it is
  SGM.clearCaches();
  const d = seedPresetRoads('kyoto-shijo-karasuma');
  const g = await withFetch(noNetwork(), () => SGM.generateStreetGoBoardInBounds(squareAround(d.location.lat, d.location.lon, 600), {}, null, { allowNetwork: false }));
  assert.strictEqual(g.stats.mergeRadiusM, 30);
  assert.strictEqual(g.stats.lenScale, 1);
  assert.strictEqual(g.stats.roadMode, 'simple');
  assert.deepStrictEqual(g.stats.notices, []);
  SGM.clearCaches();
});

test('road modes D: more than 450 points (or too much data): made again from the next road kinds; the last one is not sent twice', async () => {
  const b = squareAround(35, 135, 8000);
  const dense = centredGrid(35, 240, 35, 135); // ~1000 points in the range
  const sparse = centredGrid(11, 1000, 35, 135);
  // 1. too many points with tertiary roads -> secondary
  SGM.clearCaches();
  let modes = [];
  const msgs = [];
  const g = await withFetch(async (url, init) => {
    const m = modeOfBody(decodeURIComponent(init.body));
    modes.push(m);
    return jsonResponse(200, { elements: m === 'tertiary' ? dense : sparse });
  }, () => SGM.generateStreetGoBoardInBounds(b, {}, (m) => msgs.push(m), {}));
  assert.deepStrictEqual(modes, ['tertiary', 'secondary']);
  assert.strictEqual(g.stats.roadMode, 'secondary');
  assert.ok(g.stats.notices.some((t) => t.includes('交点が多すぎたため')), g.stats.notices.join('|'));
  assert.ok(msgs.some((m) => m.includes('つくり直しています')), msgs.join('|'));
  // 2. a response over the element limit -> the next road kinds too
  SGM.clearCaches();
  modes = [];
  const huge = new Array(SGM.MAX_OVERPASS_ELEMENTS + 1).fill({ type: 'node', id: 1, lat: 35, lon: 135 });
  const g2 = await withFetch(async (url, init) => {
    const m = modeOfBody(decodeURIComponent(init.body));
    modes.push(m);
    return jsonResponse(200, { elements: m === 'tertiary' ? huge : sparse });
  }, () => SGM.generateStreetGoBoardInBounds(b, {}, null, {}));
  assert.deepStrictEqual(modes, ['tertiary', 'secondary']);
  assert.strictEqual(g2.stats.roadMode, 'secondary');
  // 3. 20 km: secondary, then primary, then an error; nothing sent twice
  SGM.clearCaches();
  modes = [];
  const err = await withFetch(async (url, init) => {
    modes.push(modeOfBody(decodeURIComponent(init.body)));
    return jsonResponse(200, { elements: centredGrid(45, 440, 35, 135) });
  }, () => rejectsKind(SGM.generateStreetGoBoardInBounds(squareAround(35, 135, 19900), {}, null, {}), 'too-many'));
  assert.deepStrictEqual(modes, ['secondary', 'primary']);
  assert.ok(/多すぎます.*範囲を狭めてください$/.test(err.message), err.message);
  // 4. offline: no stricter data at hand -> the error at once
  SGM.clearCaches();
  SGM.seedRoadCache(35, 135, 3000, centredGrid(31, 60, 35, 135), false);
  await withFetch(noNetwork(), () => rejectsKind(SGM.generateStreetGoBoardInBounds(squareAround(35, 135, 1700), { mergeRadiusMeters: 5 }, null, { allowNetwork: false }), 'too-many'));
  SGM.clearCaches();
});

test('cache C: the query (road kinds, footpaths) is part of the key; requests are rectangles; switching modes back and forth', async () => {
  SGM.clearCaches();
  const coarse = centredGrid(11, 1000, 35, 135);
  const fine = centredGrid(21, 100, 35, 135);
  const modes = [];
  const stub = async (url, init) => {
    const m = modeOfBody(decodeURIComponent(init.body));
    modes.push(m);
    return jsonResponse(200, { elements: m === 'tertiary' ? coarse : fine });
  };
  const big = squareAround(35, 135, 8000);
  const small = squareAround(35, 135, 600);
  await withFetch(stub, async () => {
    const g1 = await SGM.generateStreetGoBoardInBounds(big, {}, null, {});
    assert.strictEqual(g1.stats.roadMode, 'tertiary');
    // the major-road data never stands in for a small range
    const g2 = await SGM.generateStreetGoBoardInBounds(small, {}, null, {});
    assert.strictEqual(g2.stats.roadMode, 'simple');
    assert.ok(g2.stats.nodeCount > 9);
    await SGM.generateStreetGoBoardInBounds(small, { includeFootways: true }, null, {});
    await SGM.generateStreetGoBoardInBounds(small, {}, null, {});
    await SGM.generateStreetGoBoardInBounds(big, {}, null, {});
    await SGM.generateStreetGoBoardInBounds(small, { includeFootways: true }, null, {});
  });
  assert.deepStrictEqual(modes, ['tertiary', 'simple', 'all']);
  // a place request cached as a rectangle serves the circle it holds, not a larger one
  SGM.clearCaches();
  let calls = 0;
  await withFetch(async () => { calls++; return jsonResponse(200, { elements: fine }); }, async () => {
    await SGM.fetchOverpassRoads(35, 135, 400);
    await SGM.fetchOverpassRoads(35, 135, 400);
    await SGM.fetchOverpassRoads(35.001, 135, 300);
  });
  assert.strictEqual(calls, 1);
  assert.strictEqual(SGM.findCachedRoads(35, 135, 500), null);
  SGM.clearCaches();
});

test('app: the frame shown is frameBounds; a small board is asked about; the size label says "major roads only"; the notes name the server', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const br = /function boardRect\(\) \{([\s\S]*?)\n  \}/.exec(app)[1];
  assert.ok(br.indexOf('frameBounds') >= 0 && br.indexOf('frameBounds') < br.indexOf('customBounds'), 'frameBounds first');
  assert.ok(/err\.kind === 'small-board'[\s\S]{0,200}window\.confirm\(err\.message\)[\s\S]{0,80}applyGeneratedBoard\(err\.board/.test(app));
  assert.ok(app.includes("'・大通りのみ'") && app.includes('DRAW_SIMPLE_MAX_M'));
  assert.ok(/flashDrawnRect\(boardData\.drawnBounds\)/.test(app) && app.includes('}, 600);'));
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(!html.includes('private.coffee'));
  assert.ok(html.includes('Overpass API（overpass-api.de）') && html.includes('長方形の座標'));
  for (const s of ['近くの道の輪', '大通りだけ', '小さな盤']) assert.ok(html.includes(s), s);
});

// ---------------------------------------------------------------------------
// Score view: blocks (faces) of the board and who holds them (board-faces.js)

const BF = require(path.join(ROOT, 'board-faces.js'));

// Board from points { id: [x, y] } (about 100 m per unit both ways near Kyoto) and links [u, v] or
// [u, v, [[x, y], ...] (bends between u and v)]; coords run u -> v unless `reversed` lists the link
function faceBoard(points, links, reversed = []) {
  const ll = ([x, y]) => [35 + y * 0.0009, 135.75 + x * 0.0011];
  const nodes = new Map();
  for (const [id, p] of Object.entries(points)) {
    const [lat, lon] = ll(p);
    nodes.set(id, { id, lat, lon, neighbors: new Set() });
  }
  const edges = links.map(([u, v, bends = []], i) => {
    nodes.get(u).neighbors.add(v);
    nodes.get(v).neighbors.add(u);
    let coords = [points[u], ...bends, points[v]].map(ll);
    if (reversed.includes(i)) coords = coords.reverse();
    return { u, v, coords };
  });
  return { nodes, edges };
}

function gridFaceBoard(n) {
  const points = {};
  const links = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) points[`${x},${y}`] = [x, y];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (x + 1 < n) links.push([`${x},${y}`, `${x + 1},${y}`]);
      if (y + 1 < n) links.push([`${x},${y}`, `${x},${y + 1}`]);
    }
  }
  return faceBoard(points, links);
}

const sortedIds = (ids) => ids.slice().sort();

test('faces: a 3 x 3 grid of points has 4 blocks; the outside is left out', () => {
  const b = gridFaceBoard(3);
  const r = BF.computeBoardFaces(b);
  assert.strictEqual(r.faces.length, 4);
  assert.strictEqual(r.components, 1);
  assert.strictEqual(r.outerFaces, 1);
  assert.strictEqual(r.faces.length, r.edgeCount - r.nodeCount + r.components);
  const got = r.faces.map((f) => sortedIds(f.nodes).join(' ')).sort();
  assert.deepStrictEqual(got, [
    '0,0 0,1 1,0 1,1',
    '0,1 0,2 1,1 1,2',
    '1,0 1,1 2,0 2,1',
    '1,1 1,2 2,1 2,2'
  ]);
  for (const f of r.faces) {
    assert.ok(f.area > 0, 'blocks run counter-clockwise');
    assert.strictEqual(f.edges.length, 4);
    assert.strictEqual(f.ring.length, 4);
    // about 100 m x 100 m
    assert.ok(Math.abs(f.area - 100 * 100) < 0.02 * 100 * 100, `${f.area}`);
  }
});

test('faces: coordinates stored v -> u, bends and a road leaving along another give the same blocks', () => {
  // a square with a diagonal; the diagonal's coordinates run backwards
  const sq = faceBoard({ a: [0, 0], b: [1, 0], c: [1, 1], d: [0, 1] },
    [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a'], ['a', 'c']], [4]);
  const r1 = BF.computeBoardFaces(sq);
  assert.deepStrictEqual(r1.faces.map((f) => sortedIds(f.nodes).join('')).sort(), ['abc', 'acd']);
  // two roads from `o` drawn on top of each other for 40 m before they part: still planar
  const together = faceBoard({ o: [0, 0], p: [2, 1], q: [2, -1], r: [-1, 0] },
    [['o', 'p', [[0.4, 0]]], ['o', 'q', [[0.4, 0]]], ['p', 'q'], ['p', 'r'], ['q', 'r'], ['o', 'r']]);
  const r2 = BF.computeBoardFaces(together);
  assert.strictEqual(r2.faces.length, r2.edgeCount - r2.nodeCount + r2.components);
  assert.deepStrictEqual(r2.faces.map((f) => sortedIds(f.nodes).join('')).sort(), ['opq', 'opr', 'oqr']);
  for (const f of r2.faces) assert.ok(f.area > 0);
});

test('faces: a T junction and a dead-end branch sit on the boundary of their block', () => {
  // square a b c d; a dead end from b into the square (b - e - f), and a T junction g on
  // c - d with a dead end g - h into the square
  const b = faceBoard(
    { a: [0, 0], b: [2, 0], c: [2, 2], d: [0, 2], e: [1.5, 0.5], f: [1, 0.8], g: [1, 2], h: [1, 1.4] },
    [['a', 'b'], ['b', 'c'], ['c', 'g'], ['g', 'd'], ['d', 'a'], ['b', 'e'], ['e', 'f'], ['g', 'h']]
  );
  const r = BF.computeBoardFaces(b);
  assert.strictEqual(r.faces.length, 1); // 8 edges - 8 points + 1
  const f = r.faces[0];
  assert.deepStrictEqual(sortedIds(f.nodes), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  assert.strictEqual(f.edges.length, 8);
  // the branches are walked out and back: they add no area
  assert.ok(Math.abs(f.area - 4 * 100 * 100) < 0.02 * 4 * 100 * 100, `${f.area}`);
  // a board that is only a tree has no block
  const tree = faceBoard({ a: [0, 0], b: [1, 0], c: [2, 0], d: [1, 1] }, [['a', 'b'], ['b', 'c'], ['b', 'd']]);
  const rt = BF.computeBoardFaces(tree);
  assert.strictEqual(rt.faces.length, 0);
  assert.strictEqual(rt.outerFaces, 1);
});

test('faces: two separate parts each lose their own outside', () => {
  const pts = {};
  const links = [];
  // part 1: 3 x 3 grid at x 0..2; part 2: a triangle at x 5..6 with a branch
  const g = gridFaceBoard(3);
  for (const [id, n] of g.nodes) pts[id] = [Math.round((n.lon - 135.75) / 0.0011), Math.round((n.lat - 35) / 0.0009)];
  for (const e of g.edges) links.push([e.u, e.v]);
  Object.assign(pts, { t1: [5, 0], t2: [6, 0], t3: [5.5, 1], t4: [7, 0] });
  links.push(['t1', 't2'], ['t2', 't3'], ['t3', 't1'], ['t2', 't4']);
  pts.lonely = [9, 9]; // a point without roads
  const b = faceBoard(pts, links);
  const r = BF.computeBoardFaces(b);
  assert.strictEqual(r.components, 2);
  assert.strictEqual(r.outerFaces, 2);
  assert.strictEqual(r.faces.length, 5);
  assert.strictEqual(r.faces.length, r.edgeCount - r.nodeCount + r.components);
  assert.ok(r.faces.some((f) => sortedIds(f.nodes).join(' ') === 't1 t2 t3'));
  assert.ok(r.faces.every((f) => !f.nodes.includes('t4') && !f.nodes.includes('lonely')));
  // empty / odd input
  assert.strictEqual(BF.computeBoardFaces(null).faces.length, 0);
  assert.strictEqual(BF.computeBoardFaces({ nodes: new Map(), edges: [] }).faces.length, 0);
  assert.strictEqual(BF.computeBoardFaces({ nodes: b.nodes, edges: [{ u: 't1', v: 'missing', coords: [] }] }).faces.length, 0);
});

test('territory owners: only the block whose points are all Black (stones or territory) is Black', () => {
  const b = gridFaceBoard(3);
  const { faces } = BF.computeBoardFaces(b);
  const stones = new Map(Array.from(b.nodes.keys(), (id) => [id, null]));
  // Black on 0,0 1,0 0,1; Black's territory 1,1 (as engine.computeScore would mark it);
  // White on 2,2; the rest empty and nobody's
  for (const id of ['0,0', '1,0', '0,1']) stones.set(id, 'B');
  stones.set('2,2', 'W');
  const territory = new Map([['1,1', 'B']]);
  const { faceOwners, edgeOwners } = BF.territoryOwners(faces, b.edges, stones, territory);
  const byNodes = new Map(faces.map((f, i) => [sortedIds(f.nodes).join(' '), faceOwners[i]]));
  assert.strictEqual(byNodes.get('0,0 0,1 1,0 1,1'), 'B');
  assert.strictEqual(byNodes.get('1,0 1,1 2,0 2,1'), null);
  assert.strictEqual(byNodes.get('0,1 0,2 1,1 1,2'), null);
  assert.strictEqual(byNodes.get('1,1 1,2 2,1 2,2'), null);
  const ownedEdges = b.edges.filter((e, i) => edgeOwners[i] === 'B').map((e) => sortedIds([e.u, e.v]).join('-')).sort();
  assert.deepStrictEqual(ownedEdges, ['0,0-0,1', '0,0-1,0', '0,1-1,1', '1,0-1,1']);
  assert.ok(edgeOwners.every((o) => o !== 'W'));
  // a block of Black and White points belongs to nobody
  assert.strictEqual(BF.ownerOfPoints(['0,0', '2,2'], stones, territory), null);
  assert.strictEqual(BF.ownerOfPoints(['2,2'], stones, territory), 'W');
  assert.strictEqual(BF.ownerOfPoints([], stones, territory), null);
  // all White: White
  const allW = new Map(Array.from(b.nodes.keys(), (id) => [id, 'W']));
  assert.ok(BF.territoryOwners(faces, b.edges, allW, new Map()).faceOwners.every((o) => o === 'W'));
});

test('faces on bundled presets: Kyoto (default settings) has edges - points + parts blocks; every board works', async () => {
  SGM.clearCaches();
  SGM.setPresetFetcher(localPresetFetcher);
  await withFetch(noNetwork(), async () => {
    const kyoto = await SGM.generateStreetGoBoard('京都 四条烏丸', {}, null, { allowNetwork: false });
    const r = BF.computeBoardFaces(kyoto);
    assert.strictEqual(r.edgeCount, kyoto.edges.length);
    assert.strictEqual(r.nodeCount, kyoto.nodes.size);
    assert.strictEqual(r.faces.length, kyoto.edges.length - kyoto.nodes.size + r.components);
    assert.ok(r.faces.every((f) => f.area > 0 && f.ring.length >= 3));
    // every road lies on two sides of blocks / the outside: each edge is walked twice in all
    for (const p of SGM.PRESETS) {
      for (const target of [81, 361]) {
        const b = await SGM.generateStreetGoBoard(p.query, { targetNodes: target }, null, { allowNetwork: false });
        const t0 = Date.now();
        const rf = BF.computeBoardFaces(b);
        const ms = Date.now() - t0;
        assert.ok(ms < 200, `${p.query} ${target}: ${ms} ms`);
        const expected = rf.edgeCount - rf.nodeCount + rf.components;
        // roads crossing without a shared point (bridges) make the board non-planar: fewer blocks
        if ((b.bridges || []).length === 0 && !(b.stats.oneStreetCrossings > 0)) {
          assert.strictEqual(rf.faces.length, expected, `${p.query} ${target}`);
        } else {
          assert.ok(rf.faces.length <= expected && rf.faces.length >= expected - 4 * (b.bridges.length + (b.stats.oneStreetCrossings || 0)), `${p.query} ${target}: ${rf.faces.length} / ${expected}`);
        }
        // owners on a full board of one colour: every block and road
        const stones = new Map(Array.from(b.nodes.keys(), (id) => [id, 'B']));
        const own = BF.territoryOwners(rf.faces, b.edges, stones, new Map());
        assert.ok(own.faceOwners.every((o) => o === 'B') && own.edgeOwners.every((o) => o === 'B'));
      }
    }
  });
  SGM.clearCaches();
});

test('index.html loads board-faces.js before app.js with the shared ?v=', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const v = html.match(/map-graph\.js\?v=([^"]+)"/)[1];
  const at = html.indexOf(`board-faces.js?v=${v}"`);
  assert.ok(at > 0, 'board-faces.js script missing');
  assert.ok(at < html.indexOf('app.js?v='), 'board-faces.js must come before app.js');
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
