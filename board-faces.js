// Street Go: the faces (blocks between roads) of a board and who owns them.
// Pure functions, no DOM: used by app.js for the score view and by tests/run.js.
(function (global) {
  'use strict';

  const EARTH_M_PER_DEG = 111195;

  // Local flat projection (metres, x east / y north) around the mean latitude of the points
  function makeProjector(nodes) {
    let latSum = 0;
    let count = 0;
    for (const n of nodes.values()) {
      if (n && Number.isFinite(n.lat)) {
        latSum += n.lat;
        count++;
      }
    }
    const lat0 = count > 0 ? latSum / count : 0;
    const kx = EARTH_M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
    return (lat, lon) => [lon * kx, lat * EARTH_M_PER_DEG];
  }

  function validLatLon(c) {
    return Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]);
  }

  // The drawn shape of an edge from u to v ([lat, lon] list, at least 2 points). Coordinates
  // that run from v to u are turned round; an edge without a usable shape is the straight
  // line between its points.
  function orientedCoords(edge, nu, nv) {
    const raw = Array.isArray(edge.coords) ? edge.coords.filter(validLatLon) : [];
    if (raw.length < 2) return [[nu.lat, nu.lon], [nv.lat, nv.lon]];
    const a = raw[0];
    const b = raw[raw.length - 1];
    const d = (p, n) => Math.hypot(p[0] - n.lat, p[1] - n.lon);
    if (edge.u !== edge.v && d(a, nv) + d(b, nu) < d(a, nu) + d(b, nv)) return raw.slice().reverse();
    return raw.slice();
  }

  // Roads leaving one point may be drawn on top of each other for a while, or cross each
  // other near it (merged junctions: map-graph.js lets two roads from a common point run
  // together within OVERLAP_WITHIN_M for up to OVERLAP_MAX_M without making a bridge). Their
  // first pieces then give a wrong order round the point. The order is instead read where
  // the roads leave a circle round the point drawn just outside every place two of its roads
  // meet, cross or stop running on top of each other: outside it they are apart.
  const MARGIN_M = 1; // circle radius beyond the farthest meeting place
  const MAX_TANGLE_M = 60; // meeting places farther than this (real crossings) are ignored

  function sub(a, b) {
    return [a[0] - b[0], a[1] - b[1]];
  }
  function cross(a, b) {
    return a[0] * b[1] - a[1] * b[0];
  }

  // Points where segments p1-p2 and p3-p4 meet: a crossing / touching point, or both ends of
  // a stretch where they lie on top of each other. Coordinates relative to the shared point.
  function segmentMeets(p1, p2, p3, p4, out) {
    const d1 = sub(p2, p1);
    const d2 = sub(p4, p3);
    const l1 = Math.hypot(d1[0], d1[1]);
    const l2 = Math.hypot(d2[0], d2[1]);
    if (l1 === 0 || l2 === 0) return;
    const den = cross(d1, d2);
    const w = sub(p3, p1);
    if (Math.abs(den) <= 1e-9 * l1 * l2) {
      // parallel: on top of each other when p3 lies on the line p1-p2
      if (Math.abs(cross(d1, w)) / l1 > 1e-6) return;
      const t3 = (w[0] * d1[0] + w[1] * d1[1]) / (l1 * l1);
      const w4 = sub(p4, p1);
      const t4 = (w4[0] * d1[0] + w4[1] * d1[1]) / (l1 * l1);
      const lo = Math.max(0, Math.min(t3, t4));
      const hi = Math.min(1, Math.max(t3, t4));
      if (lo > hi) return;
      out.push([p1[0] + d1[0] * lo, p1[1] + d1[1] * lo]);
      out.push([p1[0] + d1[0] * hi, p1[1] + d1[1] * hi]);
      return;
    }
    const t = cross(w, d2) / den;
    const u = cross(w, d1) / den;
    const E = 1e-9;
    if (t < -E || t > 1 + E || u < -E || u > 1 + E) return;
    out.push([p1[0] + d1[0] * t, p1[1] + d1[1] * t]);
  }

  // Farthest distance from the shared start (0, 0) at which two paths meet (0: never)
  function farthestMeet(a, b) {
    let far = 0;
    const pts = [];
    for (let i = 1; i < a.length; i++) {
      for (let j = 1; j < b.length; j++) {
        const p1 = a[i - 1];
        const p2 = a[i];
        const p3 = b[j - 1];
        const p4 = b[j];
        // bounding boxes apart: no meeting
        if (Math.max(p1[0], p2[0]) < Math.min(p3[0], p4[0]) - 1e-6 || Math.min(p1[0], p2[0]) > Math.max(p3[0], p4[0]) + 1e-6) continue;
        if (Math.max(p1[1], p2[1]) < Math.min(p3[1], p4[1]) - 1e-6 || Math.min(p1[1], p2[1]) > Math.max(p3[1], p4[1]) + 1e-6) continue;
        pts.length = 0;
        segmentMeets(p1, p2, p3, p4, pts);
        for (const p of pts) {
          const d = Math.hypot(p[0], p[1]);
          if (d > far && d <= MAX_TANGLE_M) far = d;
        }
      }
    }
    return far;
  }

  // Direction (radians, counter-clockwise from east) of the place where the path (starting
  // at (0, 0)) first gets `r` away from its start; a path that never does: its far end
  function exitAngle(xy, r) {
    for (let i = 1; i < xy.length; i++) {
      const p = xy[i];
      if (Math.hypot(p[0], p[1]) < r) continue;
      // on segment xy[i-1] -> p: solve |q + t d| = r for the first t in [0, 1]
      const q = xy[i - 1];
      const d = sub(p, q);
      const A = d[0] * d[0] + d[1] * d[1];
      const B = 2 * (q[0] * d[0] + q[1] * d[1]);
      const C = q[0] * q[0] + q[1] * q[1] - r * r;
      const disc = B * B - 4 * A * C;
      let t = 1;
      if (A > 0 && disc >= 0) {
        const root = (-B + Math.sqrt(disc)) / (2 * A);
        if (root >= 0 && root <= 1) t = root;
      }
      return Math.atan2(q[1] + d[1] * t, q[0] + d[0] * t);
    }
    const last = xy[xy.length - 1];
    if (Math.hypot(last[0], last[1]) > 0) return Math.atan2(last[1], last[0]);
    // the path comes back to its start (a loop): its first piece
    for (let i = 1; i < xy.length; i++) {
      if (Math.hypot(xy[i][0], xy[i][1]) > 0) return Math.atan2(xy[i][1], xy[i][0]);
    }
    return 0;
  }

  // Half-edges leaving one point ([{ h, xy }], each xy starting at the point) in
  // counter-clockwise order
  function sortRound(list) {
    if (list.length < 2) return list;
    const o = list[0].xy[0];
    const rel = list.map((item) => item.xy.map((p) => [p[0] - o[0], p[1] - o[1]]));
    let far = 0;
    for (let i = 0; i < rel.length; i++) {
      for (let j = i + 1; j < rel.length; j++) {
        // the two ends of one loop road are the same line
        if (list[i].h >> 1 !== list[j].h >> 1) far = Math.max(far, farthestMeet(rel[i], rel[j]));
      }
    }
    const r = far + MARGIN_M;
    list.forEach((item, i) => {
      item.angle = exitAngle(rel[i], r);
    });
    return list.slice().sort((p, q) => p.angle - q.angle || p.h - q.h);
  }

  // Signed area (m², counter-clockwise positive) of a closed ring of [x, y]
  function signedAreaXY(ring) {
    if (ring.length < 3) return 0;
    // relative to the first point (projected coordinates are large numbers)
    const [ox, oy] = ring[0];
    let s = 0;
    for (let i = 0, n = ring.length; i < n; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % n];
      s += (a[0] - ox) * (b[1] - oy) - (b[0] - ox) * (a[1] - oy);
    }
    return s / 2;
  }

  // Faces of the board's road graph (the blocks enclosed by roads), outer faces left out.
  //
  // board: { nodes: Map id -> { lat, lon }, edges: [{ u, v, coords: [[lat, lon], ...] }] }
  // (tails and bridges are not part of the graph and are ignored).
  //
  // Every edge gives two half-edges (u -> v, v -> u). At each point the half-edges leaving it
  // are sorted by the direction of their first drawn piece (flat projection around the
  // board). A face is traced by following a half-edge into its end point and leaving along
  // the next half-edge clockwise from the one coming back: the face stays on the left, so
  // the enclosed blocks come out counter-clockwise (positive area) and the outside of each
  // connected part clockwise. In each connected part the face with the smallest signed area
  // (the clockwise one with the largest area) is that part's outside and is left out.
  // Dead-end branches are walked out and back inside the face they sit in, so their points
  // belong to that face's boundary. Roads crossing without a shared point (bridges) make the
  // graph non-planar; the tracing is the same and a face ring may then cross itself.
  //
  // Returns {
  //   faces: [{ nodes: [ids on the boundary, each once, in walking order],
  //             edges: [indices into board.edges, each once],
  //             ring: [[lat, lon], ...] (the drawn shapes joined; not closed),
  //             area: signed area in m² (positive for an ordinary block) }],
  //   components: connected parts with at least one edge,
  //   outerFaces: faces left out (one per such part),
  //   edgeCount: edges used (both ends are points of the board),
  //   nodeCount: points on at least one used edge
  // For a planar board faces.length = edgeCount - nodeCount + components.
  // }
  function computeBoardFaces(board) {
    const empty = { faces: [], components: 0, outerFaces: 0, edgeCount: 0, nodeCount: 0 };
    if (!board || !(board.nodes instanceof Map)) return empty;
    const nodes = board.nodes;
    const edgesIn = Array.isArray(board.edges) ? board.edges : [];
    const proj = makeProjector(nodes);

    // Half-edge h: edge he = h >> 1; h even = u -> v, odd = v -> u
    const used = []; // { index, u, v, ll: oriented [lat, lon] u -> v, xy }
    for (let i = 0; i < edgesIn.length; i++) {
      const e = edgesIn[i];
      if (!e) continue;
      const nu = nodes.get(e.u);
      const nv = nodes.get(e.v);
      if (!nu || !nv || !Number.isFinite(nu.lat) || !Number.isFinite(nv.lat)) continue;
      const ll = orientedCoords(e, nu, nv);
      used.push({ index: i, u: e.u, v: e.v, ll, xy: ll.map((c) => proj(c[0], c[1])) });
    }
    const H = used.length * 2;
    if (H === 0) return { ...empty, nodeCount: nodes.size };

    const origin = (h) => (h & 1 ? used[h >> 1].v : used[h >> 1].u);
    const xyOf = (h) => (h & 1 ? used[h >> 1].xy.slice().reverse() : used[h >> 1].xy);
    const llOf = (h) => (h & 1 ? used[h >> 1].ll.slice().reverse() : used[h >> 1].ll);

    // Half-edges leaving each point, counter-clockwise
    const out = new Map();
    for (let h = 0; h < H; h++) {
      const id = origin(h);
      if (!out.has(id)) out.set(id, []);
      out.get(id).push({ h, xy: xyOf(h) });
    }
    const posInRing = new Int32Array(H);
    for (const [id, list] of out) {
      const sorted = sortRound(list);
      out.set(id, sorted);
      sorted.forEach((item, k) => {
        posInRing[item.h] = k;
      });
    }
    const next = (h) => {
      const twin = h ^ 1;
      const list = out.get(origin(twin));
      const k = posInRing[twin];
      return list[(k - 1 + list.length) % list.length].h;
    };

    // Connected parts (union-find over the used edges)
    const parent = new Map();
    const find = (x) => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r);
      while (parent.get(x) !== r) {
        const p = parent.get(x);
        parent.set(x, r);
        x = p;
      }
      return r;
    };
    for (const e of used) {
      if (!parent.has(e.u)) parent.set(e.u, e.u);
      if (!parent.has(e.v)) parent.set(e.v, e.v);
      const ru = find(e.u);
      const rv = find(e.v);
      if (ru !== rv) parent.set(ru, rv);
    }

    const seen = new Uint8Array(H);
    const traced = [];
    for (let start = 0; start < H; start++) {
      if (seen[start]) continue;
      const loop = [];
      let h = start;
      // every half-edge has exactly one successor and one predecessor, so this returns to start
      while (!seen[h]) {
        seen[h] = 1;
        loop.push(h);
        h = next(h);
      }
      const ring = [];
      const ringXY = [];
      const nodeIds = [];
      const nodeSeen = new Set();
      const edgeIdx = [];
      const edgeSeen = new Set();
      for (const x of loop) {
        const ll = llOf(x);
        const xy = xyOf(x);
        for (let k = 0; k < ll.length - 1; k++) {
          ring.push(ll[k]);
          ringXY.push(xy[k]);
        }
        const id = origin(x);
        if (!nodeSeen.has(id)) {
          nodeSeen.add(id);
          nodeIds.push(id);
        }
        const ei = used[x >> 1].index;
        if (!edgeSeen.has(ei)) {
          edgeSeen.add(ei);
          edgeIdx.push(ei);
        }
      }
      traced.push({
        nodes: nodeIds,
        edges: edgeIdx,
        ring,
        area: signedAreaXY(ringXY),
        component: find(origin(start))
      });
    }

    // One outside per connected part: the smallest signed area
    const outer = new Map(); // component -> index into traced
    traced.forEach((f, i) => {
      const cur = outer.get(f.component);
      if (cur === undefined || f.area < traced[cur].area) outer.set(f.component, i);
    });
    const outerSet = new Set(outer.values());
    const faces = [];
    traced.forEach((f, i) => {
      if (outerSet.has(i)) return;
      faces.push({ nodes: f.nodes, edges: f.edges, ring: f.ring, area: f.area });
    });
    // points on at least one used edge (a point without roads is a part of its own with no face)
    return { faces, components: outer.size, outerFaces: outerSet.size, edgeCount: used.length, nodeCount: parent.size };
  }

  // Colour a point counts for in the score view: its stone, else the colour whose territory
  // it is, else null. stones: Map id -> 'B' | 'W' | null; territoryMap: Map id -> 'B' | 'W'.
  function pointColor(id, stones, territoryMap) {
    const s = stones && typeof stones.get === 'function' ? stones.get(id) : null;
    if (s === 'B' || s === 'W') return s;
    const t = territoryMap && typeof territoryMap.get === 'function' ? territoryMap.get(id) : null;
    return t === 'B' || t === 'W' ? t : null;
  }

  // 'B' / 'W' when every id is a stone or territory of that one colour, else null (also for
  // an empty list)
  function ownerOfPoints(ids, stones, territoryMap) {
    let owner = null;
    for (const id of ids) {
      const c = pointColor(id, stones, territoryMap);
      if (c === null) return null;
      if (owner === null) owner = c;
      else if (owner !== c) return null;
    }
    return owner;
  }

  // Owners for the score view. faces: computeBoardFaces(board).faces; edges: board.edges.
  // A face belongs to X when every point on its boundary is X's stone or X's territory;
  // a road (edge) when both its ends are. Returns { faceOwners: [], edgeOwners: [] }
  // ('B' | 'W' | null, parallel to the inputs).
  function territoryOwners(faces, edges, stones, territoryMap) {
    const faceOwners = (faces || []).map((f) => ownerOfPoints(f && Array.isArray(f.nodes) ? f.nodes : [], stones, territoryMap));
    const edgeOwners = (edges || []).map((e) => (e ? ownerOfPoints([e.u, e.v], stones, territoryMap) : null));
    return { faceOwners, edgeOwners };
  }

  const api = { computeBoardFaces, territoryOwners, ownerOfPoints, pointColor, signedAreaXY };
  global.StreetGoFaces = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
