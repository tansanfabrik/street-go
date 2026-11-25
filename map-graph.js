(function (global) {
  'use strict';

  const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter'
  ];
  const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

  const NOMINATIM_TIMEOUT_MS = 15000;
  const NOMINATIM_MIN_INTERVAL_MS = 1100;
  const OVERPASS_TIMEOUT_MS = 30000; // covers headers + body download
  const OVERPASS_SERVER_TIMEOUT_S = 22;

  const MIN_BOARD_NODES = 9;
  const MAX_BOARD_NODES = 450;
  const MAX_OVERPASS_ELEMENTS = 200000;

  const MSG_BUSY = '混雑しています。しばらく待って再試行してください';
  const MSG_TOO_FEW = '交点が少なすぎます。範囲を広げるか別の場所を選んでください';

  // Bundled preset data (same-origin static JSON; no external request)
  const PRESETS = [
    { query: '京都 四条烏丸', file: 'presets/kyoto-shijo-karasuma.json' },
    { query: '東京 渋谷駅', file: 'presets/tokyo-shibuya.json' },
    { query: '東京 下北沢', file: 'presets/tokyo-shimokitazawa.json' },
    { query: '札幌 大通公園', file: 'presets/sapporo-odori.json' },
    { query: 'Paris Arc de Triomphe', file: 'presets/paris-arc-de-triomphe.json' }
  ];

  // Error with a machine-readable kind so the UI can choose the wording.
  // kinds: aborted | busy | network | incomplete | not-found | too-few | too-many | offline | area
  class StreetGoError extends Error {
    constructor(kind, message) {
      super(message);
      this.name = 'StreetGoError';
      this.kind = kind;
    }
  }

  function abortedError() {
    return new StreetGoError('aborted', '生成をキャンセルしました');
  }

  function throwIfAborted(signal) {
    if (signal && signal.aborted) throw abortedError();
  }

  // Combine an optional caller signal with a timeout. The timeout stays armed until cleanup().
  function makeRequestSignal(userSignal, timeoutMs) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    if (userSignal) {
      if (userSignal.aborted) controller.abort();
      else userSignal.addEventListener('abort', onAbort, { once: true });
    }
    return {
      signal: controller.signal,
      isTimedOut: () => timedOut,
      cleanup() {
        clearTimeout(timer);
        if (userSignal) userSignal.removeEventListener('abort', onAbort);
      }
    };
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(abortedError());
        return;
      }
      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      function onAbort() {
        clearTimeout(timer);
        reject(abortedError());
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function normalizeQuery(query) {
    return String(query || '').trim().toLowerCase();
  }

  // In-memory caches to make option tweaks & retries instant
  const geocodeCache = new Map();
  const roadCache = []; // { lat, lon, radius, elements } (network results, LRU-ish, max 12)
  const presetRoadCache = []; // bundled preset data, never evicted
  let nextNominatimSlot = 0; // earliest time (ms) the next Nominatim request may start

  // Returns { elements, coverage } where coverage is the radius (m) around (lat, lon)
  // that the cached data is known to cover, or null if nothing covers radiusMeters.
  function findCachedEntry(lat, lon, radiusMeters) {
    for (const entry of presetRoadCache.concat(roadCache)) {
      const shift = distanceMeters(lat, lon, entry.lat, entry.lon);
      if (shift + radiusMeters <= entry.radius + 15) {
        return { elements: entry.elements, coverage: Math.max(radiusMeters, entry.radius - shift) };
      }
    }
    return null;
  }

  // Largest radius around (lat, lon) that some cache entry fully covers (0 if none).
  function maxCachedRadius(lat, lon) {
    let best = 0;
    for (const entry of presetRoadCache.concat(roadCache)) {
      const r = entry.radius + 15 - distanceMeters(lat, lon, entry.lat, entry.lon);
      if (r > best) best = r;
    }
    return Math.floor(best);
  }

  function findCachedRoads(lat, lon, radiusMeters) {
    const hit = findCachedEntry(lat, lon, radiusMeters);
    return hit ? hit.elements : null;
  }

  function seedRoadCache(lat, lon, radius, elements, isPreset = false) {
    const entry = { lat, lon, radius, elements };
    if (isPreset) {
      presetRoadCache.push(entry);
    } else {
      roadCache.unshift(entry);
      if (roadCache.length > 12) roadCache.pop();
    }
  }

  function seedGeocodeCache(query, location) {
    geocodeCache.set(normalizeQuery(query), location);
  }

  function clearCaches() {
    geocodeCache.clear();
    roadCache.length = 0;
    presetRoadCache.length = 0;
    for (const p of PRESETS) p.loaded = false;
  }

  // Validate an Overpass JSON response. Throws on incomplete / oversized data.
  // Returns { elements, cacheable }.
  function validateOverpassJson(json) {
    if (!json || !Array.isArray(json.elements)) {
      throw new StreetGoError('incomplete', '道路データの応答が不完全でした。しばらく待って再試行してください。');
    }
    const elements = json.elements;
    const remark = typeof json.remark === 'string' && json.remark.trim() !== '' ? json.remark : null;
    if (remark && elements.length === 0) {
      throw new StreetGoError('incomplete', '道路データの応答が不完全でした（サーバー側で処理が打ち切られました）。しばらく待って再試行してください。');
    }
    if (elements.length > MAX_OVERPASS_ELEMENTS) {
      throw new StreetGoError('too-many', `道路データが多すぎます（${elements.length}要素）。範囲を狭めてください`);
    }
    for (const el of elements) {
      if (el && el.type === 'node' && !(Number.isFinite(el.lat) && Number.isFinite(el.lon))) {
        throw new StreetGoError('incomplete', '道路データの応答が不完全でした（座標が欠けています）。しばらく待って再試行してください。');
      }
    }
    // A remark means the server cut the query short; use the data but never cache it.
    return { elements, cacheable: !remark };
  }

  function assertPlayableBoard(nodeCount) {
    if (!(nodeCount >= MIN_BOARD_NODES)) {
      throw new StreetGoError('too-few', MSG_TOO_FEW);
    }
    if (nodeCount > MAX_BOARD_NODES) {
      throw new StreetGoError('too-many', `交点が多すぎます(${nodeCount}点)。範囲を狭めてください`);
    }
  }

  function findPreset(query) {
    const key = normalizeQuery(query);
    return PRESETS.find((p) => normalizeQuery(p.query) === key) || null;
  }

  let presetFetcher = (url, signal) => fetch(url, { signal }).then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });

  function setPresetFetcher(fn) {
    presetFetcher = fn;
  }

  function installPresetData(preset, data) {
    const loc = data && data.location;
    if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon) || !Number.isFinite(data.radius)) {
      throw new Error('invalid preset data');
    }
    const { elements } = validateOverpassJson(data);
    seedGeocodeCache(preset.query, { lat: loc.lat, lon: loc.lon, displayName: loc.displayName || preset.query });
    seedRoadCache(loc.lat, loc.lon, data.radius, elements, true);
    preset.loaded = true;
  }

  // Load bundled data for a preset query into the caches. Returns true if a preset was used.
  async function ensurePresetLoaded(query, signal) {
    const preset = findPreset(query);
    if (!preset) return false;
    if (preset.loaded) return true;
    const data = await presetFetcher(preset.file, signal);
    throwIfAborted(signal);
    installPresetData(preset, data);
    return true;
  }

  // Haversine distance in meters
  function distanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function polylineLength(coords) {
    let total = 0;
    for (let i = 1; i < coords.length; i++) {
      total += distanceMeters(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
    }
    return total;
  }

  // Split a polyline into `numSegments` equal-length parts and return sub-polylines
  function splitPolyline(coords, numSegments) {
    const totalLen = polylineLength(coords);
    if (numSegments <= 1 || totalLen <= 0) return [coords];

    const segLen = totalLen / numSegments;
    const parts = [];
    let currentPart = [coords[0]];
    let accum = 0;
    let target = segLen;

    for (let i = 1; i < coords.length; i++) {
      let p0 = coords[i - 1];
      const p1 = coords[i];
      let d = distanceMeters(p0[0], p0[1], p1[0], p1[1]);

      while (accum + d >= target && parts.length < numSegments - 1) {
        const remain = target - accum;
        const ratio = d > 0 ? remain / d : 0;
        const splitPt = [
          p0[0] + (p1[0] - p0[0]) * ratio,
          p0[1] + (p1[1] - p0[1]) * ratio
        ];
        currentPart.push(splitPt);
        parts.push(currentPart);
        currentPart = [splitPt];
        p0 = splitPt;
        d = distanceMeters(p0[0], p0[1], p1[0], p1[1]);
        accum = 0;
        target = segLen;
      }

      accum += d;
      currentPart.push(p1);
    }

    parts.push(currentPart);
    return parts;
  }

  // Liang-Barsky segment clipping against rectangular bounds { south, west, north, east }
  function clipSegmentToBounds(p0, p1, b) {
    const x0 = p0[1], y0 = p0[0];
    const x1 = p1[1], y1 = p1[0];
    const dx = x1 - x0;
    const dy = y1 - y0;

    let t0 = 0;
    let t1 = 1;
    const checks = [
      [-dx, x0 - b.west],
      [dx, b.east - x0],
      [-dy, y0 - b.south],
      [dy, b.north - y0]
    ];

    for (const [p, q] of checks) {
      if (p === 0) {
        if (q < 0) return null;
      } else {
        const r = q / p;
        if (p < 0) {
          if (r > t1) return null;
          if (r > t0) t0 = r;
        } else {
          if (r < t0) return null;
          if (r < t1) t1 = r;
        }
      }
    }

    return {
      start: [y0 + t0 * dy, x0 + t0 * dx],
      end: [y0 + t1 * dy, x0 + t1 * dx],
      clippedStart: t0 > 1e-9,
      clippedEnd: t1 < 1 - 1e-9
    };
  }

  // Clip a polyline to bounds, returning 0+ continuous sub-polylines inside the box
  function clipPolylineToBounds(coords, b) {
    const pieces = [];
    let current = null;

    for (let i = 1; i < coords.length; i++) {
      const seg = clipSegmentToBounds(coords[i - 1], coords[i], b);
      if (!seg) {
        if (current) {
          pieces.push(current);
          current = null;
        }
        continue;
      }

      if (!current) {
        current = {
          coords: [seg.start, seg.end],
          startsAtOriginal: i === 1 && !seg.clippedStart,
          endsAtOriginal: i === coords.length - 1 && !seg.clippedEnd
        };
      } else {
        if (seg.clippedStart) {
          // Re-entered box after leaving
          pieces.push(current);
          current = {
            coords: [seg.start, seg.end],
            startsAtOriginal: false,
            endsAtOriginal: i === coords.length - 1 && !seg.clippedEnd
          };
        } else {
          current.coords.push(seg.end);
          current.endsAtOriginal = i === coords.length - 1 && !seg.clippedEnd;
        }
      }

      if (seg.clippedEnd) {
        pieces.push(current);
        current = null;
      }
    }

    if (current) pieces.push(current);
    return pieces;
  }

  async function geocodePlace(query, ctx = {}) {
    const { signal, allowNetwork = true } = ctx;
    const key = normalizeQuery(query);
    if (geocodeCache.has(key)) {
      return geocodeCache.get(key);
    }
    if (!allowNetwork) {
      throw new StreetGoError('offline', '同梱データにない地名です。');
    }
    throwIfAborted(signal);

    // Keep at least NOMINATIM_MIN_INTERVAL_MS between request starts (per tab).
    const now = Date.now();
    const slot = Math.max(now, nextNominatimSlot);
    nextNominatimSlot = slot + NOMINATIM_MIN_INTERVAL_MS;
    if (slot > now) await sleep(slot - now, signal);

    const url = `${NOMINATIM_URL}?format=json&limit=1&accept-language=ja,en&q=${encodeURIComponent(query)}`;
    const req = makeRequestSignal(signal, NOMINATIM_TIMEOUT_MS);
    let data;
    try {
      let res;
      try {
        res = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: req.signal
        });
      } catch (err) {
        if (signal && signal.aborted) throw abortedError();
        if (req.isTimedOut()) throw new StreetGoError('network', '地名検索の通信がタイムアウトしました。しばらく待って再試行してください。');
        throw new StreetGoError('network', '地名検索の通信に失敗しました。接続を確認して再試行してください。');
      }
      if (res.status === 429) {
        throw new StreetGoError('busy', MSG_BUSY);
      }
      if (!res.ok) {
        throw new StreetGoError('network', `地名検索に失敗しました (HTTP ${res.status})`);
      }
      try {
        data = await res.json();
      } catch (err) {
        if (signal && signal.aborted) throw abortedError();
        if (req.isTimedOut()) throw new StreetGoError('network', '地名検索の通信がタイムアウトしました。しばらく待って再試行してください。');
        throw new StreetGoError('network', '地名検索の応答を読み取れませんでした。しばらく待って再試行してください。');
      }
    } finally {
      req.cleanup();
    }

    if (!Array.isArray(data) || data.length === 0) {
      throw new StreetGoError('not-found', `「${query}」が見つかりませんでした。別の地名や駅名で試してください。`);
    }
    const result = {
      lat: parseFloat(data[0].lat),
      lon: parseFloat(data[0].lon),
      displayName: data[0].display_name
    };
    if (!Number.isFinite(result.lat) || !Number.isFinite(result.lon)) {
      throw new StreetGoError('network', '地名検索の応答が不正でした。別の地名で試してください。');
    }
    geocodeCache.set(key, result);
    return result;
  }

  function buildOverpassQuery(lat, lon, radiusMeters) {
    return `
[out:json][timeout:${OVERPASS_SERVER_TIMEOUT_S}];
(
  way["highway"]["highway"!~"^(proposed|construction|abandoned|platform|bus_stop|elevator|corridor)$"]["footway"!~"^(sidewalk|crossing)$"]["indoor"!="yes"](around:${Math.round(radiusMeters)},${lat},${lon});
);
(._;>;);
out skel qt;
`.trim();
  }

  // Fetch road ways around a point. Uses cached / bundled data when it covers the area.
  // ctx: { signal, allowNetwork }
  async function fetchOverpassRoads(lat, lon, radiusMeters, ctx = {}) {
    const { signal, allowNetwork = true } = ctx;
    const cached = findCachedRoads(lat, lon, radiusMeters);
    if (cached) return cached;
    if (!allowNetwork) {
      throw new StreetGoError('offline', '同梱データの範囲外です。');
    }
    throwIfAborted(signal);

    const query = buildOverpassQuery(lat, lon, radiusMeters);
    let lastFailure = '';

    for (const endpoint of OVERPASS_ENDPOINTS) {
      const req = makeRequestSignal(signal, OVERPASS_TIMEOUT_MS);
      let json;
      try {
        let res;
        try {
          res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: `data=${encodeURIComponent(query)}`,
            signal: req.signal
          });
        } catch (err) {
          if (signal && signal.aborted) throw abortedError();
          lastFailure = req.isTimedOut() ? 'タイムアウト' : '接続エラー';
          continue; // network failure -> try next endpoint
        }

        if (res.status === 429 || res.status === 504) {
          // Rate limited / gateway timeout: do not hammer the next server.
          throw new StreetGoError('busy', MSG_BUSY);
        }
        if (res.status >= 500) {
          lastFailure = `HTTP ${res.status}`;
          continue; // server error -> try next endpoint
        }
        if (!res.ok) {
          throw new StreetGoError('network', `道路データの取得に失敗しました (HTTP ${res.status})。しばらく待って再試行してください。`);
        }

        try {
          json = await res.json(); // still under the request timeout
        } catch (err) {
          if (signal && signal.aborted) throw abortedError();
          lastFailure = req.isTimedOut() ? 'タイムアウト' : '応答の読み取りエラー';
          continue;
        }
      } finally {
        req.cleanup();
      }

      const { elements, cacheable } = validateOverpassJson(json);
      if (cacheable) seedRoadCache(lat, lon, radiusMeters, elements, false);
      return elements;
    }

    throw new StreetGoError(
      'network',
      `道路データの取得に失敗しました（通信エラー: ${lastFailure || '不明'}）。しばらく待って再試行してください。`
    );
  }

  function buildRoadGraph(elements, centerLat, centerLon, options) {
    const {
      targetNodes = 81,
      mergeRadiusMeters = 18,
      includeDeadEnds = true,
      subdivideLongRoads = false,
      subdivideSpacingMeters = 80
    } = options;

    // 1. Parse raw nodes and ways
    const rawNodes = new Map();
    const ways = [];
    for (const el of elements) {
      if (el.type === 'node') {
        rawNodes.set(el.id, { id: el.id, lat: el.lat, lon: el.lon });
      } else if (el.type === 'way' && Array.isArray(el.nodes) && el.nodes.length >= 2) {
        ways.push(el.nodes);
      }
    }

    // 2. Build raw undirected adjacency (avoid duplicate segments)
    const rawAdj = new Map();
    const addRawEdge = (a, b) => {
      if (a === b) return;
      if (!rawNodes.has(a) || !rawNodes.has(b)) return;
      if (!rawAdj.has(a)) rawAdj.set(a, new Set());
      if (!rawAdj.has(b)) rawAdj.set(b, new Set());
      rawAdj.get(a).add(b);
      rawAdj.get(b).add(a);
    };

    for (const nodeIds of ways) {
      for (let i = 1; i < nodeIds.length; i++) {
        addRawEdge(nodeIds[i - 1], nodeIds[i]);
      }
    }

    if (rawAdj.size === 0) {
      return { nodes: new Map(), edges: [], stats: { nodeCount: 0, edgeCount: 0, avgDegree: 0, maxDegree: 0 } };
    }

    // 3. Contract degree-2 intermediate nodes while preserving road polyline geometry
    const isJunction = (id) => {
      const deg = rawAdj.get(id).size;
      return deg !== 2;
    };

    const visitedDirected = new Set();
    const contractedEdges = [];
    const junctionIds = new Set();

    for (const [id] of rawAdj) {
      if (isJunction(id)) {
        junctionIds.add(id);
      }
    }

    for (const startId of junctionIds) {
      for (const nextId of rawAdj.get(startId)) {
        const dirKey = `${startId}->${nextId}`;
        if (visitedDirected.has(dirKey)) continue;

        const pathIds = [startId, nextId];
        visitedDirected.add(dirKey);

        let prev = startId;
        let curr = nextId;
        while (!junctionIds.has(curr)) {
          const neighbors = Array.from(rawAdj.get(curr));
          const nxt = neighbors[0] === prev ? neighbors[1] : neighbors[0];
          if (nxt === undefined) break;
          const stepKey = `${curr}->${nxt}`;
          if (visitedDirected.has(stepKey)) break;
          visitedDirected.add(stepKey);
          pathIds.push(nxt);
          prev = curr;
          curr = nxt;
          if (curr === startId) break;
        }

        // Mark reverse direction as visited too
        const revKey = `${pathIds[pathIds.length - 1]}->${pathIds[pathIds.length - 2]}`;
        visitedDirected.add(revKey);

        const endId = pathIds[pathIds.length - 1];
        if (startId === endId) continue;

        const coords = pathIds.map((nid) => {
          const n = rawNodes.get(nid);
          return [n.lat, n.lon];
        });

        contractedEdges.push({
          u: startId,
          v: endId,
          coords,
          length: polylineLength(coords)
        });
      }
    }

    // 4. Cluster nearby junctions (Union-Find) to merge dual-carriageway intersections
    const jList = Array.from(junctionIds).map((id) => ({
      id,
      lat: rawNodes.get(id).lat,
      lon: rawNodes.get(id).lon
    }));

    const parent = new Map();
    for (const j of jList) parent.set(j.id, j.id);
    const find = (x) => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r);
      let c = x;
      while (parent.get(c) !== r) {
        const p = parent.get(c);
        parent.set(c, r);
        c = p;
      }
      return r;
    };
    const union = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };

    if (mergeRadiusMeters > 0) {
      // Spatial grid hash for fast proximity clustering
      const degLat = mergeRadiusMeters / 111000;
      const degLon = mergeRadiusMeters / (111000 * Math.max(0.2, Math.cos((centerLat * Math.PI) / 180)));
      const grid = new Map();
      const cellKey = (gx, gy) => `${gx},${gy}`;

      for (const j of jList) {
        const gx = Math.floor(j.lat / degLat);
        const gy = Math.floor(j.lon / degLon);
        const k = cellKey(gx, gy);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(j);
      }

      for (const j of jList) {
        const gx = Math.floor(j.lat / degLat);
        const gy = Math.floor(j.lon / degLon);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const bucket = grid.get(cellKey(gx + dx, gy + dy));
            if (!bucket) continue;
            for (const other of bucket) {
              if (other.id <= j.id) continue;
              if (distanceMeters(j.lat, j.lon, other.lat, other.lon) <= mergeRadiusMeters) {
                union(j.id, other.id);
              }
            }
          }
        }
      }
    }

    // Compute cluster centroids
    const clusters = new Map();
    for (const j of jList) {
      const root = find(j.id);
      if (!clusters.has(root)) {
        clusters.set(root, { sumLat: 0, sumLon: 0, count: 0 });
      }
      const c = clusters.get(root);
      c.sumLat += j.lat;
      c.sumLon += j.lon;
      c.count += 1;
    }

    let nextNodeId = 1;
    const rootToNewId = new Map();
    let mergedNodes = new Map();
    for (const [root, c] of clusters) {
      const nid = `n${nextNodeId++}`;
      rootToNewId.set(root, nid);
      mergedNodes.set(nid, {
        id: nid,
        lat: c.sumLat / c.count,
        lon: c.sumLon / c.count,
        isMidpoint: false
      });
    }

    // Remap edges, drop self-loops, deduplicate parallel edges (keep shortest)
    const edgeMap = new Map();
    for (const e of contractedEdges) {
      const u = rootToNewId.get(find(e.u));
      const v = rootToNewId.get(find(e.v));
      if (!u || !v || u === v) continue;

      const key = u < v ? `${u}|${v}` : `${v}|${u}`;
      const coords = e.coords.slice();
      const nu = mergedNodes.get(u);
      const nv = mergedNodes.get(v);
      coords[0] = [nu.lat, nu.lon];
      coords[coords.length - 1] = [nv.lat, nv.lon];

      const orderedCoords = u < v ? coords : coords.reverse();
      const len = polylineLength(orderedCoords);

      if (!edgeMap.has(key) || len < edgeMap.get(key).length) {
        edgeMap.set(key, {
          u: u < v ? u : v,
          v: u < v ? v : u,
          coords: orderedCoords,
          length: len
        });
      }
    }

    let currentEdges = Array.from(edgeMap.values());

    // 5. Optional: remove dead ends (degree 1) iteratively
    if (!includeDeadEnds) {
      let changed = true;
      while (changed) {
        changed = false;
        const deg = new Map();
        for (const e of currentEdges) {
          deg.set(e.u, (deg.get(e.u) || 0) + 1);
          deg.set(e.v, (deg.get(e.v) || 0) + 1);
        }
        const deadNodes = new Set();
        for (const [id, d] of deg) {
          if (d <= 1) deadNodes.add(id);
        }
        if (deadNodes.size > 0 && mergedNodes.size - deadNodes.size >= Math.min(12, targetNodes)) {
          currentEdges = currentEdges.filter((e) => !deadNodes.has(e.u) && !deadNodes.has(e.v));
          for (const id of deadNodes) mergedNodes.delete(id);
          changed = true;
        }
      }
    }

    // 6. Optional: subdivide long roads at regular intervals
    if (subdivideLongRoads && subdivideSpacingMeters >= 20) {
      const subdividedEdges = [];
      for (const e of currentEdges) {
        if (e.length >= subdivideSpacingMeters * 1.35) {
          const numSegments = Math.max(2, Math.round(e.length / subdivideSpacingMeters));
          const subPolylines = splitPolyline(e.coords, numSegments);

          let prevId = e.u;
          for (let i = 0; i < subPolylines.length; i++) {
            const subCoords = subPolylines[i];
            let currId;
            if (i === subPolylines.length - 1) {
              currId = e.v;
            } else {
              const endPt = subCoords[subCoords.length - 1];
              currId = `m${nextNodeId++}`;
              mergedNodes.set(currId, {
                id: currId,
                lat: endPt[0],
                lon: endPt[1],
                isMidpoint: true
              });
            }
            subdividedEdges.push({
              u: prevId,
              v: currId,
              coords: subCoords,
              length: polylineLength(subCoords)
            });
            prevId = currId;
          }
        } else {
          subdividedEdges.push(e);
        }
      }
      currentEdges = subdividedEdges;
    }

    // Build adjacency list for connected selection
    const adj = new Map();
    for (const id of mergedNodes.keys()) adj.set(id, new Set());
    for (const e of currentEdges) {
      adj.get(e.u).add(e.v);
      adj.get(e.v).add(e.u);
    }

    // Remove isolated nodes
    for (const [id, nbrs] of adj) {
      if (nbrs.size === 0) {
        mergedNodes.delete(id);
        adj.delete(id);
      }
    }

    if (mergedNodes.size === 0) {
      return { nodes: new Map(), edges: [], stats: { nodeCount: 0, edgeCount: 0, avgDegree: 0, maxDegree: 0 } };
    }

    // 7. Determine square area (either user-drawn `bounds` or an auto-sized square matching `targetNodes`)
    const cosCenterLat = Math.max(0.2, Math.cos((centerLat * Math.PI) / 180));
    let boardBounds = options.bounds || null;

    if (!boardBounds) {
      // Find the square half-size (in meters) around center that contains ~targetNodes junctions
      const chebyshevDists = [];
      for (const n of mergedNodes.values()) {
        const dLatM = Math.abs(n.lat - centerLat) * 111000;
        const dLonM = Math.abs(n.lon - centerLon) * 111000 * cosCenterLat;
        chebyshevDists.push(Math.max(dLatM, dLonM));
      }
      chebyshevDists.sort((a, b) => a - b);
      const idx = Math.min(chebyshevDists.length - 1, Math.max(0, targetNodes - 1));
      const halfSizeM = chebyshevDists[idx] + 1;

      const dLat = halfSizeM / 111000;
      const dLon = halfSizeM / (111000 * cosCenterLat);
      boardBounds = {
        south: centerLat - dLat,
        north: centerLat + dLat,
        west: centerLon - dLon,
        east: centerLon + dLon
      };
    }

    // 8. Collect nodes strictly inside `boardBounds` and edges whose both endpoints are inside
    const inBox = new Set();
    for (const [id, n] of mergedNodes) {
      if (
        n.lat >= boardBounds.south &&
        n.lat <= boardBounds.north &&
        n.lon >= boardBounds.west &&
        n.lon <= boardBounds.east
      ) {
        inBox.add(id);
      }
    }

    if (inBox.size === 0) {
      return { nodes: new Map(), edges: [], boardBounds, stats: { nodeCount: 0, edgeCount: 0, avgDegree: 0, maxDegree: 0 } };
    }

    // Build subgraph adjacency inside the box
    const subAdj = new Map();
    for (const id of inBox) subAdj.set(id, new Set());
    for (const e of currentEdges) {
      if (inBox.has(e.u) && inBox.has(e.v)) {
        subAdj.get(e.u).add(e.v);
        subAdj.get(e.v).add(e.u);
      }
    }

    // Compute 2-core (closed loops / enclosures) by iteratively pruning degree <= 1 dangling spurs
    const coreNodes = new Set(inBox);
    const coreAdj = new Map();
    for (const [id, nbrs] of subAdj) coreAdj.set(id, new Set(nbrs));

    let pruned = true;
    while (pruned) {
      pruned = false;
      for (const id of Array.from(coreNodes)) {
        if (coreAdj.get(id).size <= 1) {
          for (const nb of coreAdj.get(id)) {
            coreAdj.get(nb).delete(id);
          }
          coreAdj.delete(id);
          coreNodes.delete(id);
          pruned = true;
        }
      }
    }

    // Use the closed enclosure (2-core) if it has enough nodes; otherwise fall back to non-isolated nodes in box
    let selected;
    if (coreNodes.size >= 4) {
      selected = new Set(coreNodes);
      // If user enabled "include dead ends", re-attach only true interior dead-ends (degree 1 in original street graph)
      // that connect directly to the enclosure — never re-attach boundary-cut spurs.
      if (includeDeadEnds) {
        for (const id of inBox) {
          if (selected.has(id)) continue;
          if (adj.get(id).size === 1) {
            const [onlyNb] = subAdj.get(id);
            if (onlyNb && coreNodes.has(onlyNb)) {
              selected.add(id);
            }
          }
        }
      }
    } else {
      selected = new Set();
      for (const [id, nbrs] of subAdj) {
        if (nbrs.size > 0) selected.add(id);
      }
      if (selected.size === 0) {
        for (const id of inBox) selected.add(id);
      }
    }

    // 9. Build final graph from selected nodes & edges
    const finalNodes = new Map();
    for (const id of selected) {
      const n = mergedNodes.get(id);
      finalNodes.set(id, {
        id: n.id,
        lat: n.lat,
        lon: n.lon,
        isMidpoint: n.isMidpoint,
        neighbors: new Set()
      });
    }

    const finalEdges = [];
    for (const e of currentEdges) {
      if (selected.has(e.u) && selected.has(e.v)) {
        finalNodes.get(e.u).neighbors.add(e.v);
        finalNodes.get(e.v).neighbors.add(e.u);
        finalEdges.push(e);
      }
    }

    // 10. Drop isolated points and keep only the largest connected component
    const largest = pruneToLargestComponent(finalNodes, finalEdges);

    return {
      nodes: largest.nodes,
      edges: largest.edges,
      boardBounds,
      stats: computeGraphStats(largest.nodes, largest.edges)
    };
  }

  function computeGraphStats(nodes, edges) {
    let degSum = 0;
    let maxDegree = 0;
    for (const n of nodes.values()) {
      const d = n.neighbors.size;
      degSum += d;
      if (d > maxDegree) maxDegree = d;
    }
    return {
      nodeCount: nodes.size,
      edgeCount: edges.length,
      avgDegree: nodes.size > 0 ? +(degSum / nodes.size).toFixed(2) : 0,
      maxDegree
    };
  }

  // Remove degree-0 nodes, then keep the largest connected component.
  // nodes: Map<id, { neighbors: Set<id>, ... }>, edges: [{ u, v, ... }]
  // Returns new { nodes, edges } (node objects are copied with filtered neighbor sets).
  function pruneToLargestComponent(nodes, edges) {
    let best = null;
    const seen = new Set();
    for (const [id, n] of nodes) {
      if (seen.has(id) || n.neighbors.size === 0) continue;
      const comp = new Set([id]);
      seen.add(id);
      const stack = [id];
      while (stack.length > 0) {
        const cur = stack.pop();
        for (const nb of nodes.get(cur).neighbors) {
          if (!seen.has(nb) && nodes.has(nb)) {
            seen.add(nb);
            comp.add(nb);
            stack.push(nb);
          }
        }
      }
      if (!best || comp.size > best.size) best = comp;
    }

    const outNodes = new Map();
    if (!best) return { nodes: outNodes, edges: [] };

    for (const [id, n] of nodes) {
      if (!best.has(id)) continue;
      const neighbors = new Set();
      for (const nb of n.neighbors) if (best.has(nb)) neighbors.add(nb);
      outNodes.set(id, { ...n, neighbors });
    }
    const outEdges = edges.filter((e) => best.has(e.u) && best.has(e.v));
    return { nodes: outNodes, edges: outEdges };
  }

  // ctx: { signal, allowNetwork } — allowNetwork=false restricts to bundled / cached data.
  async function generateStreetGoBoard(placeQuery, options, onProgress, ctx = {}) {
    const { signal, allowNetwork = true } = ctx;
    const report = (msg) => {
      if (typeof onProgress === 'function') onProgress(msg);
    };

    let usedPreset = false;
    try {
      usedPreset = await ensurePresetLoaded(placeQuery, signal);
    } catch (err) {
      if (err && err.kind === 'aborted') throw err;
      if (signal && signal.aborted) throw abortedError();
      if (!allowNetwork) {
        throw new StreetGoError('offline', '同梱の盤面データを読み込めませんでした。ページを再読み込みしてください。');
      }
      // Bundled file unavailable: fall through to the normal (network) path.
    }

    if (!usedPreset) report(`「${placeQuery}」の位置を検索中...`);
    const location = await geocodePlace(placeQuery, { signal, allowNetwork });

    const targetNodes = options.targetNodes || 81;
    let radius = Math.max(300, Math.round(Math.sqrt(targetNodes) * 45));
    if (!allowNetwork && !findCachedEntry(location.lat, location.lon, radius)) {
      // Offline (initial board): shrink the request to what the bundled data covers
      const maxR = maxCachedRadius(location.lat, location.lon);
      if (maxR > 0) radius = maxR;
    }
    let graph = null;

    // At most one automatic enlargement (2 attempts total).
    for (let attempt = 1; attempt <= 2; attempt++) {
      throwIfAborted(signal);
      const cachedBefore = findCachedEntry(location.lat, location.lon, radius);
      report(cachedBefore ? '道路データを読み込み中...' : `周辺の道路網を取得中 (半径 ${radius}m)...`);
      const elements = await fetchOverpassRoads(location.lat, location.lon, radius, { signal, allowNetwork });
      const coverage = cachedBefore ? cachedBefore.coverage : radius;

      report('交差点グラフを構築中...');
      graph = buildRoadGraph(elements, location.lat, location.lon, options);

      if (graph.stats.nodeCount >= Math.floor(targetNodes * 0.85) || radius >= 2800 || attempt === 2) {
        break;
      }
      // Enlarging only helps when the chosen square reaches beyond the data we have.
      // (A short count caused by pruning dangling spurs would not improve with more data.)
      if (graph.boardBounds && graph.stats.nodeCount > 0) {
        const halfSizeM = ((graph.boardBounds.north - graph.boardBounds.south) / 2) * 111000;
        if (halfSizeM * Math.SQRT2 <= coverage) break;
      }
      const nextRadius = Math.min(3000, Math.round(radius * 1.85));
      if (!allowNetwork && !findCachedRoads(location.lat, location.lon, nextRadius)) {
        break; // offline: use what the bundled data gives
      }
      radius = nextRadius;
    }

    throwIfAborted(signal);
    assertPlayableBoard(graph ? graph.stats.nodeCount : 0);

    return {
      location,
      radiusUsed: radius,
      ...graph
    };
  }

  async function generateStreetGoBoardInBounds(bounds, options, onProgress, ctx = {}) {
    const { signal, allowNetwork = true } = ctx;
    const report = (msg) => {
      if (typeof onProgress === 'function') onProgress(msg);
    };

    const centerLat = (bounds.south + bounds.north) / 2;
    const centerLon = (bounds.west + bounds.east) / 2;
    const halfDiag = distanceMeters(bounds.south, bounds.west, bounds.north, bounds.east) / 2;

    if (halfDiag > 3500) {
      throw new StreetGoError('area', '指定した範囲が広すぎます。もう少しズームインして一辺 4km 以内の正方形を引いてください。');
    }

    const fetchRadius = Math.max(120, Math.round(halfDiag + 60));
    report(`選択範囲の道路網を取得中 (半径 ${fetchRadius}m)...`);
    const elements = await fetchOverpassRoads(centerLat, centerLon, fetchRadius, { signal, allowNetwork });

    report('正方形内の交差点グラフを構築中...');
    const graph = buildRoadGraph(elements, centerLat, centerLon, {
      ...options,
      bounds
    });

    throwIfAborted(signal);
    assertPlayableBoard(graph ? graph.stats.nodeCount : 0);

    return {
      location: { lat: centerLat, lon: centerLon, displayName: '指定範囲' },
      radiusUsed: fetchRadius,
      customBounds: bounds,
      ...graph
    };
  }

  const api = {
    generateStreetGoBoard,
    generateStreetGoBoardInBounds,
    distanceMeters,
    // exposed for tests / tooling
    buildRoadGraph,
    pruneToLargestComponent,
    assertPlayableBoard,
    validateOverpassJson,
    fetchOverpassRoads,
    geocodePlace,
    findCachedRoads,
    seedRoadCache,
    seedGeocodeCache,
    installPresetData,
    setPresetFetcher,
    clearCaches,
    findPreset,
    PRESETS,
    StreetGoError,
    OVERPASS_ENDPOINTS,
    MIN_BOARD_NODES,
    MAX_BOARD_NODES,
    MAX_OVERPASS_ELEMENTS
  };

  global.StreetGoMap = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
