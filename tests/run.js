#!/usr/bin/env node
// Dependency-free tests for Street Go. Run: node tests/run.js
'use strict';

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const { GraphGoEngine, komiForNodeCount } = require(path.join(ROOT, 'go-engine.js'));
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

test('bundled presets: size limit and playable default boards without network', async () => {
  SGM.clearCaches();
  SGM.setPresetFetcher(async (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')));
  assert.strictEqual(SGM.PRESETS.length, 5);
  await withFetch(noNetwork(), async () => {
    for (const p of SGM.PRESETS) {
      const size = fs.statSync(path.join(ROOT, p.file)).size;
      assert.ok(size <= 1.5 * 1024 * 1024, `${p.file} is ${size} bytes`);
      for (const target of [36, 81, 169]) {
        const b = await SGM.generateStreetGoBoard(p.query, { targetNodes: target, mergeRadiusMeters: 18, includeDeadEnds: true }, null, { allowNetwork: true });
        assert.ok(b.stats.nodeCount >= 9 && b.stats.nodeCount <= 450, `${p.query} ${target}: ${b.stats.nodeCount}`);
      }
    }
    // Offline initial board even if a large size was restored by the browser
    const big = await SGM.generateStreetGoBoard('京都 四条烏丸', { targetNodes: 400 }, null, { allowNetwork: false });
    assert.ok(big.stats.nodeCount >= 9 && big.stats.nodeCount <= 450);
  });
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
