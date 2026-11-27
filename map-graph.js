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
  const DEFAULT_MERGE_RADIUS_M = 30;
  const MAX_NODE_DEGREE = 4;
  const SQUARE_MARGINS_M = [15, 10, 5, 1]; // auto square: margin past the outermost junction, widest first
  const SQUARE_MARGIN_MAX_RATIO = 1.15; // ...as long as the board has at most this x targetNodes points
  const SQUARE_MARGIN_MIN_RATIO = 0.85; // ...and at least this x targetNodes points
  const EARLY_TOO_MANY_FACTOR = 3; // abort before simplification above 3 x MAX_BOARD_NODES
  const MAX_BOARD_NODES = 450;
  const MAX_OVERPASS_ELEMENTS = 200000;

  // Drawn board area (a rectangle; Shift + mouse drag makes it a square)
  const MIN_DRAW_SIDE_PX = 15; // shorter side on screen
  const MAX_DRAW_SIDE_M = 4000; // longer side on the ground
  const MAX_DRAW_ASPECT = 6; // longer / shorter side
  const MAX_DRAW_HALF_DIAG_M = 3500; // radius cap of the Overpass request (before the margin)
  const DRAW_FETCH_MARGIN_M = 60;
  const MIN_DRAW_FETCH_RADIUS_M = 120;

  const MSG_BUSY = '混雑しています。しばらく待って再試行してください';
  const MSG_DRAW_TOO_SMALL = 'もう少し大きくドラッグして範囲を引いてください';
  const MSG_DRAW_TOO_LARGE = '指定した範囲が広すぎます。もう少しズームインして一辺 4km 以内の範囲を引いてください。';
  const MSG_DRAW_TOO_THIN = '範囲が細長すぎます。もう少し幅を広げてください';
  const MSG_DRAW_BAD_PLACE = 'この位置では範囲を指定できません';
  const MAX_DRAW_ABS_LAT = 85; // Web Mercator shows about +-85.05 degrees
  const MSG_TOO_FEW = '交点が少なすぎます。範囲を広げるか別の場所を選んでください';

  // Cache-busting generation of the bundled preset JSON files only (presets/*.json?v=).
  // Raise it whenever a preset JSON is replaced. It is independent of the ?v= in index.html.
  const ASSET_VERSION = '4';
  const PRESET_FETCH_TIMEOUT_MS = 15000;

  // Bundled preset data (same-origin static JSON; no external request).
  // The location is kept here too, so a preset never needs Nominatim even if its JSON
  // cannot be loaded (then only the road data falls back to Overpass).
  const PRESETS = [
    {
      query: '京都 四条烏丸',
      aliases: ['京都', '京都・四条烏丸', '四条烏丸'],
      file: 'presets/kyoto-shijo-karasuma.json',
      lat: 35.0036577,
      lon: 135.7597188,
      displayName: '四条烏丸, 烏丸通, 水銀屋町, 下京区, 京都市, 京都府, 600-8411, 日本'
    },
    {
      query: '札幌 大通公園',
      aliases: ['札幌', '札幌・大通', '大通', '大通公園'],
      file: 'presets/sapporo-odori.json',
      lat: 43.0599018,
      lon: 141.3475101,
      displayName: '大通公園, 中央区, 札幌市, 石狩振興局, 北海道, 北海道地方, 060-0042, 日本'
    },
    {
      query: '東京 銀座',
      aliases: ['東京', '東京・銀座', '銀座'],
      file: 'presets/tokyo-ginza.json',
      lat: 35.6712,
      lon: 139.765,
      displayName: '東京・銀座'
    },
    {
      query: '名古屋 栄',
      aliases: ['名古屋', '名古屋・栄', '栄'],
      file: 'presets/nagoya-sakae.json',
      lat: 35.1712,
      lon: 136.905,
      displayName: '名古屋・栄'
    },
    {
      query: '上海 南京東路',
      aliases: ['上海', '上海・南京東路', '南京東路'],
      file: 'presets/shanghai-nanjing-road.json',
      lat: 31.2365,
      lon: 121.481,
      displayName: '上海・南京東路'
    },
    {
      query: 'ソウル 論峴洞',
      aliases: ['ソウル', 'ソウル・論峴洞', '論峴洞'],
      file: 'presets/seoul-nonhyeon.json',
      lat: 37.5078,
      lon: 127.025,
      displayName: 'ソウル・論峴洞'
    },
    {
      query: 'ニューヨーク ミッドタウン',
      aliases: ['NY', 'ニューヨーク', 'ニューヨーク・ミッドタウン', 'New York'],
      file: 'presets/newyork-midtown.json',
      lat: 40.7536,
      lon: -73.9832,
      displayName: 'ニューヨーク・ミッドタウン'
    },
    {
      query: 'Paris Arc de Triomphe',
      aliases: ['パリ', 'パリ・凱旋門', '凱旋門', 'Paris'],
      file: 'presets/paris-arc-de-triomphe.json',
      lat: 48.8738,
      lon: 2.295,
      displayName: 'Paris Arc de Triomphe, Avenue des Ternes, Quartier des Ternes, 17区, パリ, イル＝ド＝フランス地域圏, フランス・メトロポリテーヌ, 75017, フランス'
    },
    {
      query: 'バルセロナ アシャンプラ',
      aliases: ['バルセロナ', 'バルセロナ・アシャンプラ', 'アシャンプラ'],
      file: 'presets/barcelona-eixample.json',
      lat: 41.3925,
      lon: 2.164,
      displayName: 'バルセロナ・アシャンプラ'
    },
    {
      query: 'メルボルン 中心部',
      aliases: ['メルボルン', 'メルボルン・中心部'],
      file: 'presets/melbourne-cbd.json',
      lat: -37.811,
      lon: 144.961,
      displayName: 'メルボルン・中心部'
    },
    {
      query: 'トリノ 旧市街',
      aliases: ['トリノ', 'トリノ・旧市街'],
      file: 'presets/turin-old-town.json',
      lat: 45.071,
      lon: 7.683,
      displayName: 'トリノ・旧市街'
    }
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
  const roadCache = []; // { lat, lon, radius, elements, mode } (network results, LRU-ish, max 12)
  const presetRoadCache = []; // bundled preset data (mode 'simple'), never evicted
  let nextNominatimSlot = 0; // earliest time (ms) the next Nominatim request may start

  function cacheEntries(mode) {
    const m = normalizeRoadMode(mode);
    return presetRoadCache.concat(roadCache).filter((entry) => entry.mode === m);
  }

  // Returns { elements, coverage } where coverage is the radius (m) around (lat, lon)
  // that the cached data is known to cover, or null if nothing covers radiusMeters.
  // Only entries fetched with the same road mode are considered.
  function findCachedEntry(lat, lon, radiusMeters, mode = 'simple') {
    for (const entry of cacheEntries(mode)) {
      const shift = distanceMeters(lat, lon, entry.lat, entry.lon);
      if (shift + radiusMeters <= entry.radius + 15) {
        return { elements: entry.elements, coverage: Math.max(radiusMeters, entry.radius - shift) };
      }
    }
    return null;
  }

  // Largest radius around (lat, lon) that some cache entry fully covers (0 if none).
  function maxCachedRadius(lat, lon, mode = 'simple') {
    let best = 0;
    for (const entry of cacheEntries(mode)) {
      const r = entry.radius + 15 - distanceMeters(lat, lon, entry.lat, entry.lon);
      if (r > best) best = r;
    }
    return Math.floor(best);
  }

  function findCachedRoads(lat, lon, radiusMeters, mode = 'simple') {
    const hit = findCachedEntry(lat, lon, radiusMeters, mode);
    return hit ? hit.elements : null;
  }

  // Cached roads usable for a drawn rectangle: some entry's circle must hold all four
  // corners plus the same margin a new request would add (DRAW_FETCH_MARGIN_M).
  // The farthest point of a rectangle from any centre is one of its corners.
  function findCachedRoadsForRect(b, mode = 'simple') {
    const corners = [[b.south, b.west], [b.south, b.east], [b.north, b.west], [b.north, b.east]];
    for (const entry of cacheEntries(mode)) {
      let far = 0;
      for (const [la, lo] of corners) far = Math.max(far, distanceMeters(entry.lat, entry.lon, la, lo));
      if (far + DRAW_FETCH_MARGIN_M <= entry.radius + 15) return entry.elements;
    }
    return null;
  }

  function seedRoadCache(lat, lon, radius, elements, isPreset = false, mode = 'simple') {
    const entry = { lat, lon, radius, elements, mode: normalizeRoadMode(mode) };
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

  // Key for matching a typed name against the presets: full-width / half-width forms
  // unified (NFKC), "・" and any run of spaces become one space, trimmed, lower-case.
  // "東京・銀座", "東京　銀座" and " 東京  銀座 " all give "東京 銀座".
  function presetMatchKey(query) {
    let s = String(query || '');
    if (typeof s.normalize === 'function') s = s.normalize('NFKC');
    return s.replace(/[・\s]+/g, ' ').trim().toLowerCase();
  }

  // A preset is found by its query (the chip's data-place) or one of its aliases
  // (the chip label, the full name shown in its title, and the parts of that name).
  function findPreset(query) {
    const key = presetMatchKey(query);
    if (!key) return null;
    return PRESETS.find((p) =>
      presetMatchKey(p.query) === key ||
      (p.aliases || []).some((a) => presetMatchKey(a) === key)
    ) || null;
  }

  // Same-origin fetch of a bundled JSON with a 15 s limit (body included)
  const defaultPresetFetcher = async (url, signal) => {
    const req = makeRequestSignal(signal, PRESET_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: req.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      req.cleanup();
    }
  };

  let presetFetcher = defaultPresetFetcher;

  // Replace the bundled-JSON loader (tests); pass null to restore the default
  function setPresetFetcher(fn) {
    presetFetcher = typeof fn === 'function' ? fn : defaultPresetFetcher;
  }

  function installPresetData(preset, data) {
    const loc = data && data.location;
    if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon) || !Number.isFinite(data.radius)) {
      throw new Error('invalid preset data');
    }
    // Only data fetched with the "simple" query may be registered; anything else
    // (missing / unknown roadMode, e.g. an older bundle) is ignored.
    if (data.roadMode !== 'simple') {
      throw new Error('preset road data is not the simple query');
    }
    const { elements } = validateOverpassJson(data);
    seedRoadCache(loc.lat, loc.lon, data.radius, elements, true, 'simple');
    preset.loaded = true;
  }

  function presetLocation(preset) {
    return { lat: preset.lat, lon: preset.lon, displayName: preset.displayName || preset.query };
  }

  // Load bundled data for a preset query into the caches. Returns true if a preset was used.
  // The preset location is registered first, so Nominatim is never needed for presets.
  async function ensurePresetLoaded(query, signal) {
    const preset = findPreset(query);
    if (!preset) return false;
    seedGeocodeCache(preset.query, presetLocation(preset));
    // The name as typed (e.g. an alias such as "東京") resolves to the same location
    seedGeocodeCache(query, presetLocation(preset));
    if (preset.loaded) return true;
    const data = await presetFetcher(`${preset.file}?v=${ASSET_VERSION}`, signal);
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

  // ---------------------------------------------------------------------------
  // Drawn rectangle helpers (pure; used by app.js and the tests)

  // Screen rectangle of a drag from `start` to `end` ({ x, y } in pixels). With
  // `square`, the shorter side is stretched to the longer one, keeping the drag direction.
  function dragRectPx(start, end, square = false) {
    let dx = end.x - start.x;
    let dy = end.y - start.y;
    if (square) {
      const side = Math.max(Math.abs(dx), Math.abs(dy));
      dx = (dx >= 0 ? 1 : -1) * side;
      dy = (dy >= 0 ? 1 : -1) * side;
    }
    return {
      start: { x: start.x, y: start.y },
      end: { x: start.x + dx, y: start.y + dy },
      widthPx: Math.abs(dx),
      heightPx: Math.abs(dy)
    };
  }

  // Ground size (m) of bounds { south, west, north, east }: width along the middle
  // latitude, height along the middle meridian (haversine, like every other distance here).
  function rectSizeMeters(b) {
    const midLat = (b.south + b.north) / 2;
    const midLon = (b.west + b.east) / 2;
    return {
      widthM: distanceMeters(midLat, b.west, midLat, b.east),
      heightM: distanceMeters(b.south, midLon, b.north, midLon)
    };
  }

  // Circle around the centre of the bounds that covers all four corners, and the
  // radius sent to Overpass. Spec: radius = round(distance from the centre to the
  // farthest corner + 60 m), at least 120 m. "Half the diagonal" is only an approximation
  // of that distance (the corners nearer the equator are a little farther away).
  function rectCoverCircle(b) {
    const lat = (b.south + b.north) / 2;
    const lon = (b.west + b.east) / 2;
    let halfDiagM = 0;
    for (const [la, lo] of [[b.south, b.west], [b.south, b.east], [b.north, b.west], [b.north, b.east]]) {
      halfDiagM = Math.max(halfDiagM, distanceMeters(lat, lon, la, lo));
    }
    return {
      lat,
      lon,
      halfDiagM,
      radiusM: Math.max(MIN_DRAW_FETCH_RADIUS_M, Math.round(halfDiagM + DRAW_FETCH_MARGIN_M))
    };
  }

  // Is a drawn rectangle usable as a board area?
  // size: { widthM, heightM, widthPx?, heightPx? } (the pixel checks run only when given)
  // Returns { ok: true } or { ok: false, kind: 'too-small' | 'too-large' | 'too-thin', message }.
  // Order: too small (shorter side on screen) -> too large -> too thin. The square-only
  // drawing also rejected a small drag on screen first and a large area only later.
  function checkDrawnRect(size) {
    const fail = (kind, message) => ({ ok: false, kind, message });
    const hasPx = Number.isFinite(size.widthPx) && Number.isFinite(size.heightPx);
    if (hasPx && !(Math.min(size.widthPx, size.heightPx) >= MIN_DRAW_SIDE_PX)) {
      return fail('too-small', MSG_DRAW_TOO_SMALL);
    }
    const longM = Math.max(size.widthM, size.heightM);
    const shortM = Math.min(size.widthM, size.heightM);
    if (!Number.isFinite(longM) || longM > MAX_DRAW_SIDE_M) return fail('too-large', MSG_DRAW_TOO_LARGE);
    if (!(shortM > 0) || longM / shortM > MAX_DRAW_ASPECT) return fail('too-thin', MSG_DRAW_TOO_THIN);
    return { ok: true };
  }

  // Bring drawn bounds into longitude -180..180 (Leaflet gives e.g. +360 on a wrapped
  // world copy) by moving west and east together by whole turns, and reject what cannot
  // be a board area: non-finite values, south >= north, west >= east, latitudes outside
  // +-85 (Web Mercator), and areas across the antimeridian (not supported: too costly
  // for what it gives). Returns { ok: true, bounds } or { ok: false, kind, message }.
  function normalizeDrawnBounds(b) {
    const bad = (kind) => ({ ok: false, kind, message: MSG_DRAW_BAD_PLACE });
    if (!b) return bad('invalid');
    const { south, north, west, east } = b;
    if (![south, north, west, east].every(Number.isFinite)) return bad('invalid');
    if (!(south < north) || !(west < east)) return bad('invalid');
    if (south < -MAX_DRAW_ABS_LAT || north > MAX_DRAW_ABS_LAT) return bad('latitude');
    const mid = (west + east) / 2;
    const shift = -360 * Math.floor((mid + 180) / 360); // whole turns; 0 when already in range
    const w = west + shift;
    const e = east + shift;
    if (w < -180 || e > 180) return bad('antimeridian');
    return { ok: true, bounds: { south, west: w, north, east: e } };
  }

  // "横 420m × 縦 260m" (1000 m and more: "1.23km")
  function formatRectSize(widthM, heightM) {
    const fmt = (m) => {
      const r = Math.round(m);
      return r >= 1000 ? `${(r / 1000).toFixed(2)}km` : `${r}m`;
    };
    return `横 ${fmt(widthM)} × 縦 ${fmt(heightM)}`;
  }

  // ---------------------------------------------------------------------------
  // Stone marker helpers (pure, screen pixels; used by app.js and the tests)

  // Diameter of one point's marker: the zoom's base size, but no more than 80% of the
  // screen distance to the nearest road-connected neighbour (so stones at both ends of a
  // short road leave the road visible), and never below 70% of the base size.
  // A point without a usable neighbour distance keeps the base size. Whole pixels.
  function stoneDiameterPx(basePx, nearestNeighborPx) {
    if (!(basePx > 0)) return 0;
    if (!Number.isFinite(nearestNeighborPx) || nearestNeighborPx < 0) return Math.round(basePx);
    const d = Math.min(basePx, Math.max(basePx * 0.7, nearestNeighborPx * 0.8));
    return Math.round(d);
  }

  // Marker diameters for a whole board.
  // points: Map id -> { x, y } (screen pixels at the current zoom; any common origin)
  // neighbors: Map id -> iterable of neighbour ids (road connections)
  // Returns Map id -> diameter (px) for every id in `points`.
  function nodeStoneDiameters(points, neighbors, basePx) {
    const out = new Map();
    for (const [id, p] of points) {
      let nearest = Infinity;
      const nbs = neighbors && neighbors.get(id);
      if (nbs && p) {
        for (const nb of nbs) {
          if (nb === id) continue;
          const q = points.get(nb);
          if (!q) continue;
          const dist = Math.hypot(q.x - p.x, q.y - p.y);
          if (Number.isFinite(dist) && dist < nearest) nearest = dist;
        }
      }
      out.set(id, stoneDiameterPx(basePx, nearest));
    }
    return out;
  }

  // The point a click / tap at `point` ({ x, y }, screen pixels) means: among the
  // candidates ({ id, x, y, diameter }) whose circle contains the point, the one whose
  // centre is nearest. Equal distances keep `fallbackId` (the marker that got the event),
  // else the earlier candidate. No candidate contains the point (or no usable point):
  // `fallbackId`.
  function pickNodeAtPoint(point, candidates, fallbackId) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return fallbackId;
    let best = fallbackId;
    let bestDist = Infinity;
    let bestIsFallback = false;
    for (const c of candidates) {
      if (!c || !(c.diameter > 0)) continue;
      const dist = Math.hypot(c.x - point.x, c.y - point.y);
      if (!(dist <= c.diameter / 2)) continue;
      const isFallback = c.id === fallbackId;
      if (dist < bestDist || (dist === bestDist && isFallback && !bestIsFallback)) {
        best = c.id;
        bestDist = dist;
        bestIsFallback = isFallback;
      }
    }
    return best;
  }

  function polylineLength(coords) {
    let total = 0;
    for (let i = 1; i < coords.length; i++) {
      total += distanceMeters(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
    }
    return total;
  }

  // Metres the two ends of `coords` were moved away from `rawEnds` (the junctions before merging)
  function endShiftMeters(coords, rawEnds) {
    const a = coords[0];
    const b = coords[coords.length - 1];
    return distanceMeters(a[0], a[1], rawEnds[0][0], rawEnds[0][1]) + distanceMeters(b[0], b[1], rawEnds[1][0], rawEnds[1][1]);
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

  // Way filters per road mode.
  //  simple (default): drops footways, paths, steps, cycleways, service roads, tracks,
  //                    bridleways, any tunnel=* except "no" (building passages too) and
  //                    covered=yes (covered=arcade shopping streets stay; so do
  //                    pedestrian / living_street)
  //  all:              the original filter (includes footpaths and alleys)
  const ROAD_WAY_FILTERS = {
    simple: '["highway"]["highway"!~"^(proposed|construction|abandoned|platform|bus_stop|elevator|corridor|footway|path|steps|cycleway|service|track|bridleway)$"]["footway"!~"^(sidewalk|crossing)$"]["indoor"!="yes"]["covered"!="yes"](if: !is_tag("tunnel") || t["tunnel"] == "no")',
    all: '["highway"]["highway"!~"^(proposed|construction|abandoned|platform|bus_stop|elevator|corridor)$"]["footway"!~"^(sidewalk|crossing)$"]["indoor"!="yes"]'
  };

  function normalizeRoadMode(mode) {
    return mode === 'all' ? 'all' : 'simple';
  }

  function buildOverpassQuery(lat, lon, radiusMeters, mode = 'simple') {
    const filter = ROAD_WAY_FILTERS[normalizeRoadMode(mode)];
    return `
[out:json][timeout:${OVERPASS_SERVER_TIMEOUT_S}];
(
  way${filter}(around:${Math.round(radiusMeters)},${lat},${lon});
);
(._;>;);
out skel qt;
`.trim();
  }

  // Fetch road ways around a point. Uses cached / bundled data when it covers the area.
  // ctx: { signal, allowNetwork, mode }  (mode: 'simple' | 'all'; caches never mix modes)
  async function fetchOverpassRoads(lat, lon, radiusMeters, ctx = {}) {
    const { signal, allowNetwork = true } = ctx;
    const mode = normalizeRoadMode(ctx.mode);
    const cached = findCachedRoads(lat, lon, radiusMeters, mode);
    if (cached) return cached;
    if (!allowNetwork) {
      throw new StreetGoError('offline', '同梱データの範囲外です。');
    }
    throwIfAborted(signal);

    const query = buildOverpassQuery(lat, lon, radiusMeters, mode);
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
      if (cacheable) seedRoadCache(lat, lon, radiusMeters, elements, false, mode);
      return elements;
    }

    throw new StreetGoError(
      'network',
      `道路データの取得に失敗しました（通信エラー: ${lastFailure || '不明'}）。しばらく待って再試行してください。`
    );
  }

  // Grid cell sizes (degrees) that cover a real distance r at every latitude up to
  // maxAbsLat (no clamping of the cosine, so high latitudes still find their neighbours).
  function cellSizesDeg(r, maxAbsLat) {
    const lat = Math.min(89.9, Math.abs(maxAbsLat || 0));
    const cos = Math.max(1e-4, Math.cos((lat * Math.PI) / 180));
    return {
      degLat: (r / 111195) * 1.02,
      degLon: (r / (111195 * cos)) * 1.02
    };
  }

  // Simple uniform grid over lat/lon for "points within r" queries.
  function makePointGrid(r, maxAbsLat) {
    const { degLat, degLon } = cellSizesDeg(r, maxAbsLat);
    const cells = new Map();
    const cellOf = (lat, lon) => [Math.floor(lat / degLat), Math.floor(lon / degLon)];
    return {
      add(lat, lon, item) {
        const [gx, gy] = cellOf(lat, lon);
        const k = `${gx},${gy}`;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push({ lat, lon, item });
      },
      // Calls fn(entry) for every stored point in the 3x3 neighbourhood of (lat, lon)
      near(lat, lon, fn) {
        const [gx, gy] = cellOf(lat, lon);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const bucket = cells.get(`${gx + dx},${gy + dy}`);
            if (bucket) for (const entry of bucket) fn(entry);
          }
        }
      }
    };
  }

  function maxAbsLatOf(points) {
    let m = 0;
    for (const p of points) m = Math.max(m, Math.abs(p.lat));
    return m;
  }

  // Merge junctions closer than r without chaining.
  //  1. Leader clustering from the densest spot outwards: a junction becomes a leader only
  //     if no leader is within r, otherwise it joins the nearest leader. Every member is
  //     within r of its leader (cluster diameter <= 2r) and leaders are more than r apart.
  //  2. Clusters whose centroids are within r are merged if the result still has a
  //     diameter <= 2r.
  //  3. Positions are centroids; clusters still closer than r to another one are moved
  //     to their leader, which guarantees a spacing of at least r between all points.
  // Returns [{ lat, lon, members: [junction] }].
  function clusterJunctions(jList, r) {
    if (!(r > 0) || jList.length === 0) {
      return jList.map((j) => ({ lat: j.lat, lon: j.lon, members: [j] }));
    }
    const maxLat = maxAbsLatOf(jList);

    // Density = number of other junctions within r
    const all = makePointGrid(r, maxLat);
    jList.forEach((j) => all.add(j.lat, j.lon, j));
    const density = new Map();
    for (const j of jList) {
      let count = 0;
      all.near(j.lat, j.lon, (e) => {
        if (e.item !== j && distanceMeters(j.lat, j.lon, e.lat, e.lon) <= r) count++;
      });
      density.set(j.id, count);
    }
    const order = jList.slice().sort((a, b) =>
      (density.get(b.id) - density.get(a.id)) || (b.deg - a.deg) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );

    const leaders = makePointGrid(r, maxLat);
    let clusters = [];
    for (const j of order) {
      let best = null;
      let bestD = Infinity;
      leaders.near(j.lat, j.lon, (e) => {
        const d = distanceMeters(j.lat, j.lon, e.lat, e.lon);
        if (d <= r && d < bestD) {
          best = e.item;
          bestD = d;
        }
      });
      if (best) {
        best.members.push(j);
      } else {
        const c = { leader: j, members: [j], alive: true };
        clusters.push(c);
        leaders.add(j.lat, j.lon, c);
      }
    }

    const centroid = (c) => {
      let la = 0;
      let lo = 0;
      for (const m of c.members) {
        la += m.lat;
        lo += m.lon;
      }
      return [la / c.members.length, lo / c.members.length];
    };
    const diameterOk = (a, b) => {
      for (const p of a.members) {
        for (const q of b.members) {
          if (distanceMeters(p.lat, p.lon, q.lat, q.lon) > 2 * r) return false;
        }
      }
      return true;
    };

    // 2. Merge clusters with close centroids while the diameter limit allows it
    for (let iter = 0; iter < 20; iter++) {
      const grid = makePointGrid(r, maxLat);
      for (const c of clusters) {
        [c.lat, c.lon] = centroid(c);
        grid.add(c.lat, c.lon, c);
      }
      let merged = false;
      for (const c of clusters) {
        if (!c.alive) continue;
        grid.near(c.lat, c.lon, (e) => {
          const o = e.item;
          if (o === c || !o.alive || !c.alive) return;
          if (distanceMeters(c.lat, c.lon, o.lat, o.lon) > r) return;
          if (!diameterOk(c, o)) return;
          const [keep, drop] = c.members.length >= o.members.length ? [c, o] : [o, c];
          keep.members = keep.members.concat(drop.members);
          drop.alive = false;
          merged = true;
        });
      }
      clusters = clusters.filter((c) => c.alive);
      if (!merged) break;
    }

    // 3. Positions: centroid, or the leader when a centroid would sit closer than r
    for (const c of clusters) {
      [c.lat, c.lon] = centroid(c);
      c.snapped = false;
    }
    for (let iter = 0; iter <= clusters.length; iter++) {
      const grid = makePointGrid(r, maxLat);
      for (const c of clusters) grid.add(c.lat, c.lon, c);
      let changed = false;
      for (const c of clusters) {
        grid.near(c.lat, c.lon, (e) => {
          const o = e.item;
          if (o === c || distanceMeters(c.lat, c.lon, o.lat, o.lon) >= r) return;
          for (const x of [c, o]) {
            if (!x.snapped) {
              x.lat = x.leader.lat;
              x.lon = x.leader.lon;
              x.snapped = true;
              changed = true;
            }
          }
        });
      }
      if (!changed) break;
    }
    return clusters.map((c) => ({ lat: c.lat, lon: c.lon, members: c.members }));
  }

  function buildRoadGraph(elements, centerLat, centerLon, options) {
    const {
      targetNodes = 81,
      mergeRadiusMeters = DEFAULT_MERGE_RADIUS_M,
      includeDeadEnds = false,
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

    // 4. Merge nearby junctions (dual carriageways, offset crossings).
    const jList = Array.from(junctionIds).map((id) => ({
      id,
      lat: rawNodes.get(id).lat,
      lon: rawNodes.get(id).lon,
      deg: rawAdj.get(id).size
    }));
    const clusters = clusterJunctions(jList, mergeRadiusMeters);
    const clusterOfJunction = new Map();

    let nextNodeId = 1;
    let mergedNodes = new Map();
    const memberPos = new Map(); // point id -> positions [lat, lon] of the junctions merged into it
    for (const c of clusters) {
      const nid = `n${nextNodeId++}`;
      for (const m of c.members) clusterOfJunction.set(m.id, nid);
      memberPos.set(nid, c.members.map((m) => [m.lat, m.lon]));
      mergedNodes.set(nid, {
        id: nid,
        lat: c.lat,
        lon: c.lon,
        isMidpoint: false
      });
    }

    // Remap edges, drop self-loops, deduplicate parallel edges (keep shortest)
    const edgeMap = new Map();
    for (const e of contractedEdges) {
      const u = clusterOfJunction.get(e.u);
      const v = clusterOfJunction.get(e.v);
      if (!u || !v || u === v) continue;

      const key = u < v ? `${u}|${v}` : `${v}|${u}`;
      const coords = e.coords.slice();
      // Where the road really ends (the junction before merging), kept per edge so the
      // degree cap and the drawn shape can tell how far merging moved each end.
      const rawU = coords[0];
      const rawV = coords[coords.length - 1];
      const nu = mergedNodes.get(u);
      const nv = mergedNodes.get(v);
      coords[0] = [nu.lat, nu.lon];
      coords[coords.length - 1] = [nv.lat, nv.lon];

      const orderedCoords = u < v ? coords : coords.reverse();
      const len = polylineLength(orderedCoords);

      const prev = edgeMap.get(key);
      // the shortest road between the two points; an exact tie goes by its course, not by input order
      if (!prev || len < prev.length - 1e-9 ||
        (Math.abs(len - prev.length) <= 1e-9 && JSON.stringify(orderedCoords) < JSON.stringify(prev.coords))) {
        const rawEnds = u < v ? [rawU, rawV] : [rawV, rawU];
        edgeMap.set(key, {
          u: u < v ? u : v,
          v: u < v ? v : u,
          coords: orderedCoords,
          length: len,
          rawEnds,
          endShift: endShiftMeters(orderedCoords, rawEnds)
        });
      }
    }

    // Sorted by end points, so the board does not depend on the order of the input data
    let currentEdges = Array.from(edgeMap.values()).sort((a, b) => (a.u < b.u ? -1 : a.u > b.u ? 1 : a.v < b.v ? -1 : a.v > b.v ? 1 : 0));

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

    // 6. Optional: subdivide long roads at regular intervals.
    //    A split point closer than the merge radius to an existing point (junction or an
    //    earlier midpoint) is skipped; that piece of road then runs on to the next split.
    if (subdivideLongRoads && subdivideSpacingMeters >= 20) {
      const minGap = Math.max(mergeRadiusMeters, 1);
      const pointGrid = makePointGrid(minGap, maxAbsLatOf(Array.from(mergedNodes.values())) + 0.5);
      for (const n of mergedNodes.values()) pointGrid.add(n.lat, n.lon, n.id);
      const tooClose = (lat, lon) => {
        let close = false;
        pointGrid.near(lat, lon, (e) => {
          if (!close && distanceMeters(lat, lon, e.lat, e.lon) < minGap) close = true;
        });
        return close;
      };

      const subdividedEdges = [];
      for (const e of currentEdges) {
        if (e.length >= subdivideSpacingMeters * 1.35) {
          const numSegments = Math.max(2, Math.round(e.length / subdivideSpacingMeters));
          const subPolylines = splitPolyline(e.coords, numSegments);

          let prevId = e.u;
          let pending = null; // coords accumulated since the last accepted point
          for (let i = 0; i < subPolylines.length; i++) {
            const subCoords = pending ? pending.concat(subPolylines[i].slice(1)) : subPolylines[i];
            const isLast = i === subPolylines.length - 1;
            const endPt = subCoords[subCoords.length - 1];
            if (!isLast && tooClose(endPt[0], endPt[1])) {
              pending = subCoords;
              continue;
            }
            let currId;
            if (isLast) {
              currId = e.v;
            } else {
              currId = `m${nextNodeId++}`;
              mergedNodes.set(currId, {
                id: currId,
                lat: endPt[0],
                lon: endPt[1],
                isMidpoint: true
              });
              pointGrid.add(endPt[0], endPt[1], currId);
            }
            const rawEnds = [
              prevId === e.u ? e.rawEnds[0] : subCoords[0],
              currId === e.v ? e.rawEnds[1] : subCoords[subCoords.length - 1]
            ];
            subdividedEdges.push({
              u: prevId,
              v: currId,
              coords: subCoords,
              length: polylineLength(subCoords),
              rawEnds,
              endShift: endShiftMeters(subCoords, rawEnds)
            });
            prevId = currId;
            pending = null;
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

    // 7. Determine the board area: the user-drawn rectangle `bounds` as it is, or a square
    //    around the centre holding ~targetNodes junctions. The square reaches a little past
    //    its outermost junction, so a street lying right on its edge is not cut in half: the
    //    widest of SQUARE_MARGINS_M whose board has between options.minNodes and
    //    options.maxNodes points (default 0.85 / 1.15 x targetNodes) is used, and a margin
    //    never takes the square's corner past options.coverageM (the radius the road data is
    //    known to cover).
    const finishBoard = (boardBounds) => {
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

      // Edges are used only if their whole drawn polyline stays inside the board rectangle
      // (a road that leaves it on the way is not part of the board).
      const EPS_DEG = 1e-9;
      const edgeInside = (e) => {
        if (!inBox.has(e.u) || !inBox.has(e.v)) return false;
        for (const [la, lo] of e.coords) {
          if (
            la < boardBounds.south - EPS_DEG || la > boardBounds.north + EPS_DEG ||
            lo < boardBounds.west - EPS_DEG || lo > boardBounds.east + EPS_DEG
          ) return false;
        }
        return true;
      };
      const boxEdges = currentEdges.filter(edgeInside);

      // Build subgraph adjacency inside the box
      const subAdj = new Map();
      for (const id of inBox) subAdj.set(id, new Set());
      for (const e of boxEdges) {
        subAdj.get(e.u).add(e.v);
        subAdj.get(e.v).add(e.u);
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

      // Use the closed enclosure (2-core) only if its largest connected part is a playable
      // board by itself; otherwise keep the spurs (all non-isolated points in the box).
      let selected;
      if (largestComponentSize(coreAdj) >= MIN_BOARD_NODES) {
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
      for (const e of boxEdges) {
        if (selected.has(e.u) && selected.has(e.v)) {
          finalNodes.get(e.u).neighbors.add(e.v);
          finalNodes.get(e.v).neighbors.add(e.u);
          finalEdges.push(e);
        }
      }

      // 10. Drop isolated points and keep only the largest connected component
      const largest = pruneToLargestComponent(finalNodes, finalEdges);

      // Far too many points: stop before the (heavier) simplification step
      if (largest.nodes.size > EARLY_TOO_MANY_FACTOR * MAX_BOARD_NODES) {
        throw new StreetGoError('too-many', `交点が多すぎます(${largest.nodes.size}点以上)。範囲を狭めてください`);
      }

      // 11. Draw each road with a simpler shape (see buildDisplayShapes), then keep the
      //     connections simple: remove crossing edges, cap the degree at 4, prune dead
      //     ends (if excluded) and keep the largest component again. Crossings are judged
      //     on the drawn shapes. Shapes that had to stay unsimplified because of a road
      //     removed meanwhile get a second try on the final board.
      const shaped = buildDisplayShapes(largest.nodes, largest.edges, boardBounds);
      let simple = simplifyBoardGraph(largest.nodes, shaped, { includeDeadEnds });
      // 12. A merged point left just beside a straight road it belongs to (a thin sliver
      //     between that road and the point) is moved onto the road, which is split there;
      //     the degree cap then runs again if a point got more than 4 roads.
      const aligned = alignPointsOntoRoads(simple.nodes, simple.edges, mergeRadiusMeters, memberPos, {
        minDegree: ALIGN_GUARD_DEGREE && !includeDeadEnds ? 2 : 0
      });
      if (aligned.applied.length > 0) {
        // Moving a point adds no crossing; a point may get more than MAX_NODE_DEGREE roads,
        // or (when a road it shared with the moved point is merged into one) fewer, even
        // one. Then the simplification runs again (degree cap, dead ends).
        let again = false;
        for (const n of aligned.nodes.values()) {
          if (n.neighbors.size > MAX_NODE_DEGREE || (!includeDeadEnds && n.neighbors.size <= 1)) again = true;
        }
        if (again) {
          const re = simplifyBoardGraph(aligned.nodes, aligned.edges, { includeDeadEnds });
          simple = { ...re, info: { ...re.info, removedEdges: simple.info.removedEdges + re.info.removedEdges } };
        } else {
          simple = { nodes: aligned.nodes, edges: aligned.edges, info: simple.info };
        }
      }
      // Final drawn shapes; this pass keeps the set of crossing pairs (checked here too)
      let edgesOut = buildDisplayShapes(simple.nodes, simple.edges, boardBounds);
      if (countEdgeCrossings(simple.nodes, edgesOut) > countEdgeCrossings(simple.nodes, simple.edges)) edgesOut = simple.edges;

      return {
        nodes: simple.nodes,
        edges: edgesOut,
        boardBounds,
        stats: {
          ...computeGraphStats(simple.nodes, edgesOut),
          ...simple.info,
          crossingsRemaining: countEdgeCrossings(simple.nodes, edgesOut),
          alignedPoints: aligned.applied.length
        }
      };
    };

    if (options.bounds) {
      const g = finishBoard(options.bounds);
      g.stats.marginM = 0;
      return g;
    }

    const cosCenterLat = Math.max(0.2, Math.cos((centerLat * Math.PI) / 180));
    const chebyshevDists = [];
    for (const n of mergedNodes.values()) {
      const dLatM = Math.abs(n.lat - centerLat) * 111000;
      const dLonM = Math.abs(n.lon - centerLon) * 111000 * cosCenterLat;
      chebyshevDists.push(Math.max(dLatM, dLonM));
    }
    chebyshevDists.sort((a, b) => a - b);
    const idx = Math.min(chebyshevDists.length - 1, Math.max(0, targetNodes - 1));
    const squareAt = (halfSizeM) => {
      const dLat = halfSizeM / 111000;
      const dLon = halfSizeM / (111000 * cosCenterLat);
      return {
        south: centerLat - dLat,
        north: centerLat + dLat,
        west: centerLon - dLon,
        east: centerLon + dLon
      };
    };
    const maxNodes = Math.min(MAX_BOARD_NODES, Number.isFinite(options.maxNodes) ? options.maxNodes : SQUARE_MARGIN_MAX_RATIO * targetNodes);
    const minNodes = Number.isFinite(options.minNodes) ? options.minNodes : SQUARE_MARGIN_MIN_RATIO * targetNodes;
    const coverageM = Number.isFinite(options.coverageM) ? options.coverageM : Infinity;
    // The widest margin whose board has between minNodes and maxNodes points; if none does,
    // the plain square as before (SQUARE_MARGINS_M ends with the margin used before margins
    // existed), so a short board is still enlarged the usual way.
    const lastMargin = SQUARE_MARGINS_M[SQUARE_MARGINS_M.length - 1];
    for (const marginM of SQUARE_MARGINS_M) {
      const isLast = marginM === lastMargin;
      const halfSizeM = chebyshevDists[idx] + marginM;
      if (!isLast && halfSizeM * Math.SQRT2 > coverageM) continue;
      let g;
      try {
        g = finishBoard(squareAt(halfSizeM));
      } catch (err) {
        if (!isLast && err && err.kind === 'too-many') continue;
        throw err;
      }
      g.stats.marginM = marginM;
      if (isLast || (g.nodes.size <= maxNodes && g.nodes.size >= minNodes)) return g;
    }
    return null; // not reached: the last margin always returns
  }

  // Size of the largest connected component of an adjacency Map<id, Set<id>>
  function largestComponentSize(adjMap) {
    let best = 0;
    const seen = new Set();
    for (const id of adjMap.keys()) {
      if (seen.has(id)) continue;
      seen.add(id);
      let size = 0;
      const stack = [id];
      while (stack.length) {
        const cur = stack.pop();
        size++;
        for (const nb of adjMap.get(cur)) {
          if (!seen.has(nb) && adjMap.has(nb)) {
            seen.add(nb);
            stack.push(nb);
          }
        }
      }
      if (size > best) best = size;
    }
    return best;
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

  // ---------------------------------------------------------------------------
  // Board simplification (crossing edges, degree cap)

  // Local planar projection in meters around the mean position of the nodes.
  function makeProjector(nodes) {
    let sumLat = 0;
    let sumLon = 0;
    let count = 0;
    for (const n of nodes.values()) {
      sumLat += n.lat;
      sumLon += n.lon;
      count++;
    }
    const lat0 = count ? sumLat / count : 0;
    const lon0 = count ? sumLon / count : 0;
    const kx = 111320 * Math.max(0.2, Math.cos((lat0 * Math.PI) / 180));
    const ky = 110540;
    return (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky];
  }

  // Like makeProjector, but with the true scale at every latitude (no lower bound on the
  // cosine), for checks that compare real distances (drawn shapes, moving points).
  function makeMetricProjector(nodes) {
    let sumLat = 0;
    let sumLon = 0;
    let count = 0;
    for (const n of nodes.values()) {
      sumLat += n.lat;
      sumLon += n.lon;
      count++;
    }
    const lat0 = count ? sumLat / count : 0;
    const lon0 = count ? sumLon / count : 0;
    const kx = 111320 * Math.max(1e-6, Math.cos((lat0 * Math.PI) / 180));
    const ky = 110540;
    return (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky];
  }

  function edgeCoords(e, nodes) {
    if (Array.isArray(e.coords) && e.coords.length >= 2) return e.coords;
    const a = nodes.get(e.u);
    const b = nodes.get(e.v);
    return [[a.lat, a.lon], [b.lat, b.lon]];
  }

  const ORIENT_EPS = 1e-7; // m^2, treats nearly collinear points as collinear

  function orient(a, b, c) {
    const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    return Math.abs(v) < ORIENT_EPS ? 0 : v;
  }

  function onSegment(a, b, p) {
    return (
      Math.min(a[0], b[0]) - 1e-9 <= p[0] && p[0] <= Math.max(a[0], b[0]) + 1e-9 &&
      Math.min(a[1], b[1]) - 1e-9 <= p[1] && p[1] <= Math.max(a[1], b[1]) + 1e-9
    );
  }

  // True if segments p1-p2 and p3-p4 intersect or touch.
  function segmentsIntersect(p1, p2, p3, p4) {
    const d1 = orient(p3, p4, p1);
    const d2 = orient(p3, p4, p2);
    const d3 = orient(p1, p2, p3);
    const d4 = orient(p1, p2, p4);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    if (d1 === 0 && onSegment(p3, p4, p1)) return true;
    if (d2 === 0 && onSegment(p3, p4, p2)) return true;
    if (d3 === 0 && onSegment(p1, p2, p3)) return true;
    if (d4 === 0 && onSegment(p1, p2, p4)) return true;
    return false;
  }

  function bbox(points) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of points) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
  }

  function polylinesIntersect(a, b) {
    for (let i = 1; i < a.length; i++) {
      const a0 = a[i - 1];
      const a1 = a[i];
      const aMinX = Math.min(a0[0], a1[0]);
      const aMaxX = Math.max(a0[0], a1[0]);
      const aMinY = Math.min(a0[1], a1[1]);
      const aMaxY = Math.max(a0[1], a1[1]);
      for (let j = 1; j < b.length; j++) {
        const b0 = b[j - 1];
        const b1 = b[j];
        if (Math.max(b0[0], b1[0]) < aMinX || Math.min(b0[0], b1[0]) > aMaxX) continue;
        if (Math.max(b0[1], b1[1]) < aMinY || Math.min(b0[1], b1[1]) > aMaxY) continue;
        if (segmentsIntersect(a0, a1, b0, b1)) return true;
      }
    }
    return false;
  }

  // Pairs [i, j] of edges that do not share an endpoint but whose polylines meet.
  function findCrossingPairs(edges, polys) {
    const boxes = polys.map(bbox);
    const order = edges.map((_, i) => i).sort((i, j) => boxes[i].minX - boxes[j].minX);
    const pairs = [];
    for (let oi = 0; oi < order.length; oi++) {
      const i = order[oi];
      const bi = boxes[i];
      for (let oj = oi + 1; oj < order.length; oj++) {
        const j = order[oj];
        const bj = boxes[j];
        if (bj.minX > bi.maxX) break;
        if (bj.maxY < bi.minY || bj.minY > bi.maxY) continue;
        const ei = edges[i];
        const ej = edges[j];
        if (ei.u === ej.u || ei.u === ej.v || ei.v === ej.u || ei.v === ej.v) continue;
        if (polylinesIntersect(polys[i], polys[j])) pairs.push(i < j ? [i, j] : [j, i]);
      }
    }
    return pairs;
  }

  // Number of edge pairs (not sharing a node) whose drawn polylines cross or touch.
  function countEdgeCrossings(nodes, edges) {
    const proj = makeProjector(nodes);
    const polys = edges.map((e) => edgeCoords(e, nodes).map(([lat, lon]) => proj(lat, lon)));
    return findCrossingPairs(edges, polys).length;
  }

  // Direction (radians) in which edge e leaves node id.
  function edgeBearingAt(e, id, poly) {
    const pts = e.u === id ? poly : poly.slice().reverse();
    const start = pts[0];
    let target = pts[pts.length - 1];
    for (let k = 1; k < pts.length; k++) {
      const dx = pts[k][0] - start[0];
      const dy = pts[k][1] - start[1];
      if (dx * dx + dy * dy >= 25) { // first point at least 5 m away
        target = pts[k];
        break;
      }
    }
    return Math.atan2(target[1] - start[1], target[0] - start[0]);
  }

  // Direction (radians) from node id towards the point `dist` metres along edge e's polyline
  // (its far end if shorter): the way the road heads, past small bends at the point itself.
  function bearingAlong(e, id, poly, dist) {
    const pts = e.u === id ? poly : poly.slice().reverse();
    const start = pts[0];
    let target = pts[pts.length - 1];
    let acc = 0;
    for (let k = 1; k < pts.length; k++) {
      const seg = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
      if (acc + seg >= dist && seg > 0) {
        const t = (dist - acc) / seg;
        target = [pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * t, pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * t];
        break;
      }
      acc += seg;
    }
    return Math.atan2(target[1] - start[1], target[0] - start[0]);
  }

  const THROUGH_LOOK_M = 30; // how far along a road its direction is taken
  const THROUGH_MIN_ANGLE = (165 * Math.PI) / 180; // two roads this close to opposite run straight through

  function angleBetween(a, b) {
    let d = Math.abs(a - b) % (2 * Math.PI);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d;
  }

  // S6-S8: remove crossing edges, cap the degree at MAX_NODE_DEGREE without breaking
  // connectivity, then prune dead ends (unless included) and keep the largest component.
  // nodes/edges are not mutated. Returns { nodes, edges, info }.
  function simplifyBoardGraph(nodesIn, edgesIn, opts = {}) {
    const includeDeadEnds = !!opts.includeDeadEnds;
    const maxDegree = opts.maxDegree || MAX_NODE_DEGREE;

    const nodes = new Map();
    for (const [id, n] of nodesIn) nodes.set(id, { ...n, neighbors: new Set(n.neighbors) });
    const edges = edgesIn.slice();
    const pairKey = (u, v) => (u < v ? `${u}|${v}` : `${v}|${u}`);
    const edgeIndex = new Map();
    edges.forEach((e, i) => edgeIndex.set(pairKey(e.u, e.v), i));
    const alive = new Set(edges.map((_, i) => i));

    const proj = makeProjector(nodes);
    // polys: the drawn shapes (crossings are judged on what is drawn); roadPolys: the roads'
    // own courses (directions and bends at a point, for the degree cap)
    const polys = edges.map((e) => edgeCoords(e, nodes).map(([lat, lon]) => proj(lat, lon)));
    const roadPolys = edges.map((e, i) => (Array.isArray(e.roadCoords) && e.roadCoords !== e.coords ? e.roadCoords.map(([lat, lon]) => proj(lat, lon)) : polys[i]));
    const lengths = edges.map((e, i) => (Number.isFinite(e.length) ? e.length : polylineLengthXY(polys[i])));

    const removeEdge = (i) => {
      const e = edges[i];
      nodes.get(e.u).neighbors.delete(e.v);
      nodes.get(e.v).neighbors.delete(e.u);
      alive.delete(i);
    };

    // True if removing edge i would disconnect its endpoints
    const isBridge = (i) => {
      const { u, v } = edges[i];
      const seen = new Set([u]);
      const stack = [u];
      while (stack.length > 0) {
        const cur = stack.pop();
        for (const nb of nodes.get(cur).neighbors) {
          if ((cur === u && nb === v) || (cur === v && nb === u)) continue;
          if (nb === v) return false;
          if (!seen.has(nb)) {
            seen.add(nb);
            stack.push(nb);
          }
        }
      }
      return true;
    };

    // --- S6: crossing edges. Prefer the edge involved in the most crossings, then the longer one.
    const pairs = findCrossingPairs(edges, polys);
    const partners = new Map();
    for (const [a, b] of pairs) {
      if (!partners.has(a)) partners.set(a, new Set());
      if (!partners.has(b)) partners.set(b, new Set());
      partners.get(a).add(b);
      partners.get(b).add(a);
    }
    // Active crossing counts are updated incrementally; a max-heap (count, length) with
    // lazy deletion picks the next candidate without rescanning all crossings.
    const activeCount = new Map();
    for (const [i, ps] of partners) activeCount.set(i, ps.size);
    const heap = [];
    const better = (a, b) => (a.count !== b.count ? a.count > b.count : a.len > b.len);
    const push = (item) => {
      heap.push(item);
      let k = heap.length - 1;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (!better(heap[k], heap[p])) break;
        [heap[k], heap[p]] = [heap[p], heap[k]];
        k = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length > 0) {
        heap[0] = last;
        let k = 0;
        for (;;) {
          const l = 2 * k + 1;
          const r = l + 1;
          let m = k;
          if (l < heap.length && better(heap[l], heap[m])) m = l;
          if (r < heap.length && better(heap[r], heap[m])) m = r;
          if (m === k) break;
          [heap[k], heap[m]] = [heap[m], heap[k]];
          k = m;
        }
      }
      return top;
    };
    for (const [i, count] of activeCount) push({ i, count, len: lengths[i] });

    const keep = new Set(); // bridges: once a bridge, always a bridge (edges only disappear)
    let removedForCrossing = 0;
    while (heap.length > 0) {
      const top = pop();
      const i = top.i;
      if (!alive.has(i) || keep.has(i) || top.count !== activeCount.get(i) || top.count === 0) continue;
      if (isBridge(i)) {
        keep.add(i);
        continue;
      }
      removeEdge(i);
      removedForCrossing++;
      for (const j of partners.get(i)) {
        if (!alive.has(j)) continue;
        const c = activeCount.get(j) - 1;
        activeCount.set(j, c);
        if (c > 0 && !keep.has(j)) push({ i: j, count: c, len: lengths[j] });
      }
    }

    // --- S7: degree cap. Prefer edges whose other end has a high degree, then the edge
    //     closest in direction to a neighbouring edge. Between edges ranked equal so far
    //     (typically the two of a narrow pair), keep the one that runs straight through the
    //     point (another edge leaves it in the opposite direction) and drop first a road that
    //     runs along another remaining road, then the one that bends most or whose ends
    //     merging moved most; then the longer one. Never a bridge.
    //     "Straight through" is judged on the drawn lines; the other directions and the
    //     bends on the roads' own courses.
    const bendOf = (i) => maxDevXY(roadPolys[i]) + (Number.isFinite(edges[i].endShift) ? edges[i].endShift : 0);
    let roadBoxes = null;
    // True if edge i's road runs along another remaining road (a duplicate line on the board)
    const runsAlongAnother = (i) => {
      if (!roadBoxes) roadBoxes = roadPolys.map((p) => bboxXY(p, SHAPE_OVERLAP_M));
      const e = edges[i];
      const bi = roadBoxes[i];
      for (const j of alive) {
        if (j === i) continue;
        const bj = roadBoxes[j];
        if (bj.maxX < bi.minX || bj.minX > bi.maxX || bj.maxY < bi.minY || bj.minY > bi.maxY) continue;
        const o = edges[j];
        const shared = [];
        if (o.u === e.u || o.v === e.u) shared.push(proj(nodes.get(e.u).lat, nodes.get(e.u).lon));
        if (o.u === e.v || o.v === e.v) shared.push(proj(nodes.get(e.v).lat, nodes.get(e.v).lon));
        if (polylinesRunTogether(roadPolys[i], roadPolys[j], shared)) return true;
      }
      return false;
    };
    let removedForDegree = 0;
    for (let pass = 0; pass < 1000; pass++) {
      const over = Array.from(nodes.keys())
        .filter((id) => nodes.get(id).neighbors.size > maxDegree)
        .sort((a, b) => nodes.get(b).neighbors.size - nodes.get(a).neighbors.size);
      if (over.length === 0) break;
      let progress = false;
      for (const nid of over) {
        const n = nodes.get(nid);
        if (n.neighbors.size <= maxDegree) continue;
        const incident = Array.from(n.neighbors).map((nb) => edgeIndex.get(pairKey(nid, nb)));
        const bearings = incident.map((i) => edgeBearingAt(edges[i], nid, roadPolys[i]));
        const farBearings = incident.map((i) => bearingAlong(edges[i], nid, polys[i], THROUGH_LOOK_M));
        const cands = incident.map((i, k) => {
          let minAngle = Infinity;
          let through = false;
          for (let m = 0; m < incident.length; m++) {
            if (m === k) continue;
            minAngle = Math.min(minAngle, angleBetween(bearings[k], bearings[m]));
            if (angleBetween(farBearings[k], farBearings[m]) >= THROUGH_MIN_ANGLE) through = true;
          }
          const other = edges[i].u === nid ? edges[i].v : edges[i].u;
          return { i, otherDeg: nodes.get(other).neighbors.size, minAngle, through: through ? 1 : 0, len: lengths[i] };
        });
        // the later keys are needed only between candidates tied so far
        const runs = (c) => (c.runs === undefined ? (c.runs = runsAlongAnother(c.i) ? 1 : 0) : c.runs);
        const bend = (c) => (c.bend === undefined ? (c.bend = bendOf(c.i)) : c.bend);
        cands.sort((a, b) =>
          (b.otherDeg - a.otherDeg) || (a.minAngle - b.minAngle) ||
          (runs(b) - runs(a)) || (a.through - b.through) || (bend(b) - bend(a)) || (b.len - a.len)
        );
        for (const c of cands) {
          if (!isBridge(c.i)) {
            removeEdge(c.i);
            removedForDegree++;
            progress = true;
            break;
          }
        }
      }
      if (!progress) break;
    }

    // --- S8: prune dead ends (when excluded) and isolated points, keep the largest component
    let liveEdges = edges.filter((_, i) => alive.has(i));
    let workNodes = nodes;
    if (!includeDeadEnds) {
      const pruned = new Map();
      for (const [id, n] of nodes) pruned.set(id, { ...n, neighbors: new Set(n.neighbors) });
      let changed = true;
      while (changed) {
        changed = false;
        for (const [id, n] of pruned) {
          if (n.neighbors.size <= 1) {
            for (const nb of n.neighbors) pruned.get(nb).neighbors.delete(id);
            pruned.delete(id);
            changed = true;
          }
        }
      }
      // Keep the spurs if pruning would leave too small a board (judged on the largest
      // connected part that would remain, since only that part becomes the board)
      const prunedAdj = new Map();
      for (const [id, n] of pruned) prunedAdj.set(id, n.neighbors);
      if (largestComponentSize(prunedAdj) >= MIN_BOARD_NODES) {
        workNodes = pruned;
        liveEdges = liveEdges.filter((e) => pruned.has(e.u) && pruned.has(e.v));
      }
    }
    const largest = pruneToLargestComponent(workNodes, liveEdges);

    let overDegreeRemaining = 0;
    for (const n of largest.nodes.values()) if (n.neighbors.size > maxDegree) overDegreeRemaining++;

    return {
      nodes: largest.nodes,
      edges: largest.edges,
      info: {
        crossingsRemaining: countEdgeCrossings(largest.nodes, largest.edges),
        overDegreeRemaining,
        removedEdges: removedForCrossing + removedForDegree
      }
    };
  }

  function polylineLengthXY(pts) {
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    }
    return total;
  }

  // ---------------------------------------------------------------------------
  // Drawn shapes. Each road is drawn with a simpler line than its real course so the board
  // reads like a grid: a nearly straight road becomes one straight line, and small bends
  // next to a junction (often left by merging nearby junctions) are dropped. A simpler
  // line is used only if it does not create anything the real course did not have.

  const SHAPE_STRAIGHT_DEV_M = 8; // road within this of its chord -> straight line
  const SHAPE_END_ZONE_M = 25; // bends this close to a junction may be dropped...
  const SHAPE_END_DEV_M = 8; // ...if the line stays within this of the road there
  const SHAPE_DP_TOL_M = 6; // Douglas-Peucker tolerance for the rest of the road
  const SHAPE_NEAR_NODE_M = 8; // a line must not newly pass this close to another point
  const SHAPE_OVERLAP_M = 10; // two lines this close over a long stretch run together
  const SHAPE_OVERLAP_MIN_M = 20;
  const SHAPE_OVERLAP_SHARED_M = 15; // ignored around a point both lines start from
  const SHAPE_TOUCH_M = 1; // where two lines meet at a shared point
  const SHAPE_SLACK_M = 1; // borderline cases count against the simpler shape

  function pointSegDistXY(p, a, b) {
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const l2 = abx * abx + aby * aby;
    let t = l2 > 0 ? ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - a[0] - abx * t, p[1] - a[1] - aby * t);
  }

  function pointPolyDistXY(p, poly) {
    let m = Infinity;
    for (let i = 1; i < poly.length; i++) m = Math.min(m, pointSegDistXY(p, poly[i - 1], poly[i]));
    return m;
  }

  // Largest distance of pts[from..to] from the segment pts[from]-pts[to]
  function maxDevXY(pts, from = 0, to = pts.length - 1) {
    let m = 0;
    for (let i = from + 1; i < to; i++) m = Math.max(m, pointSegDistXY(pts[i], pts[from], pts[to]));
    return m;
  }

  // Indices kept by Douglas-Peucker on pts restricted to the index list idx
  function douglasPeuckerIdx(pts, idx, tol) {
    if (idx.length <= 2) return idx.slice();
    // Iterative (a stack of index ranges), so a road with thousands of points cannot
    // exhaust the call stack
    const keep = new Array(idx.length).fill(false);
    keep[0] = true;
    keep[idx.length - 1] = true;
    const stack = [[0, idx.length - 1]];
    while (stack.length > 0) {
      const [lo, hi] = stack.pop();
      if (hi - lo < 2) continue;
      const a = pts[idx[lo]];
      const b = pts[idx[hi]];
      let worst = -1;
      let worstD = -1;
      for (let k = lo + 1; k < hi; k++) {
        const d = pointSegDistXY(pts[idx[k]], a, b);
        if (d > worstD) {
          worstD = d;
          worst = k;
        }
      }
      if (worstD > tol) {
        keep[worst] = true;
        stack.push([lo, worst], [worst, hi]);
      }
    }
    return idx.filter((_, k) => keep[k]);
  }


  // Candidate shape (indices into pts, metres). rawPts: the same road with its real ends.
  //  1. within SHAPE_STRAIGHT_DEV_M of its chord (as drawn, or as the road really runs
  //     between its original junctions) -> straight line between the two points;
  //  2. otherwise drop the bends within SHAPE_END_ZONE_M of either end whose removal keeps
  //     the line within SHAPE_END_DEV_M of the road (a real corner stays), then simplify
  //     the rest with Douglas-Peucker.
  function candidateShapeIdx(pts, rawPts) {
    const n = pts.length;
    if (n <= 2) return pts.map((_, i) => i);
    if (maxDevXY(pts) < SHAPE_STRAIGHT_DEV_M || (rawPts && maxDevXY(rawPts) < SHAPE_STRAIGHT_DEV_M)) return [0, n - 1];
    let idx = pts.map((_, i) => i);
    // from the start: drop the bend next to the end while allowed
    while (idx.length > 2) {
      const k = idx[1];
      if (Math.hypot(pts[k][0] - pts[0][0], pts[k][1] - pts[0][1]) > SHAPE_END_ZONE_M) break;
      if (maxDevXY(pts, idx[0], idx[2]) > SHAPE_END_DEV_M) break;
      idx.splice(1, 1);
    }
    while (idx.length > 2) {
      const last = idx.length - 1;
      const k = idx[last - 1];
      if (Math.hypot(pts[k][0] - pts[n - 1][0], pts[k][1] - pts[n - 1][1]) > SHAPE_END_ZONE_M) break;
      if (maxDevXY(pts, idx[last - 2], idx[last]) > SHAPE_END_DEV_M) break;
      idx.splice(last - 1, 1);
    }
    return douglasPeuckerIdx(pts, idx, SHAPE_DP_TOL_M);
  }

  // Points where segments a0-a1 and b0-b1 meet (one point, or the ends of a collinear overlap)
  function segmentMeetPoints(a0, a1, b0, b1) {
    const rx = a1[0] - a0[0];
    const ry = a1[1] - a0[1];
    const sx = b1[0] - b0[0];
    const sy = b1[1] - b0[1];
    const den = rx * sy - ry * sx;
    const qx = b0[0] - a0[0];
    const qy = b0[1] - a0[1];
    if (Math.abs(den) < 1e-9) {
      if (Math.abs(qx * ry - qy * rx) > 1e-6) return [];
      const rr = rx * rx + ry * ry;
      if (rr < 1e-12) return [];
      const t0 = (qx * rx + qy * ry) / rr;
      const t1 = t0 + (sx * rx + sy * ry) / rr;
      const lo = Math.max(0, Math.min(t0, t1));
      const hi = Math.min(1, Math.max(t0, t1));
      if (lo > hi) return [];
      return [[a0[0] + rx * lo, a0[1] + ry * lo], [a0[0] + rx * hi, a0[1] + ry * hi]];
    }
    const t = (qx * sy - qy * sx) / den;
    const u = (qx * ry - qy * rx) / den;
    const E = 1e-9;
    if (t < -E || t > 1 + E || u < -E || u > 1 + E) return [];
    return [[a0[0] + rx * t, a0[1] + ry * t]];
  }

  // True if polylines a and b meet anywhere farther than SHAPE_TOUCH_M from the points in `shared`
  function polylinesMeetAwayFrom(a, b, shared) {
    for (let i = 1; i < a.length; i++) {
      const a0 = a[i - 1];
      const a1 = a[i];
      for (let j = 1; j < b.length; j++) {
        const b0 = b[j - 1];
        const b1 = b[j];
        if (Math.max(b0[0], b1[0]) < Math.min(a0[0], a1[0]) || Math.min(b0[0], b1[0]) > Math.max(a0[0], a1[0])) continue;
        if (Math.max(b0[1], b1[1]) < Math.min(a0[1], a1[1]) || Math.min(b0[1], b1[1]) > Math.max(a0[1], a1[1])) continue;
        for (const p of segmentMeetPoints(a0, a1, b0, b1)) {
          if (!shared.some((s) => Math.hypot(p[0] - s[0], p[1] - s[1]) <= SHAPE_TOUCH_M)) return true;
        }
      }
    }
    return false;
  }

  // Sharp reversals (> 150 degrees) between segments of at least 3 m
  function countFoldBacks(p) {
    let count = 0;
    for (let k = 1; k < p.length - 1; k++) {
      const v1x = p[k][0] - p[k - 1][0];
      const v1y = p[k][1] - p[k - 1][1];
      const v2x = p[k + 1][0] - p[k][0];
      const v2y = p[k + 1][1] - p[k][1];
      const l1 = Math.hypot(v1x, v1y);
      const l2 = Math.hypot(v2x, v2y);
      if (l1 < 3 || l2 < 3) continue;
      if ((v1x * v2x + v1y * v2y) / (l1 * l2) < Math.cos((150 * Math.PI) / 180)) count++;
    }
    return count;
  }

  function polylineSelfIntersects(p) {
    for (let a = 1; a < p.length; a++) {
      for (let b = a + 2; b < p.length; b++) {
        if (segmentMeetPoints(p[a - 1], p[a], p[b - 1], p[b]).length > 0) return true;
      }
    }
    return false;
  }

  // Two lines run together: along the shorter one, at least SHAPE_OVERLAP_MIN_M (and half
  // its length) lies within SHAPE_OVERLAP_M of the other, not counting the stretch near a
  // point both start from.
  function polylinesRunTogether(a, b, shared, within = SHAPE_OVERLAP_M) {
    const [s, o] = polylineLengthXY(a) <= polylineLengthXY(b) ? [a, b] : [b, a];
    const total = polylineLengthXY(s);
    const need = Math.max(SHAPE_OVERLAP_MIN_M, 0.5 * total);
    if (total < need) return false;
    // Quick reject: the pieces of s that come near o's bounding box are too short
    const ob = bboxXY(o, within);
    let nearLen = 0;
    for (let i = 1; i < s.length; i++) {
      const p0 = s[i - 1];
      const p1 = s[i];
      if (Math.max(p0[0], p1[0]) < ob.minX || Math.min(p0[0], p1[0]) > ob.maxX) continue;
      if (Math.max(p0[1], p1[1]) < ob.minY || Math.min(p0[1], p1[1]) > ob.maxY) continue;
      nearLen += Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    }
    if (nearLen < need) return false;
    // Coarse pass (8 m steps, 4 m wider): a run shorter than this bound cannot reach `need`
    let coarse = 0;
    for (let i = 1; i < s.length; i++) {
      const p0 = s[i - 1];
      const p1 = s[i];
      const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      const steps = Math.max(1, Math.ceil(len / 8));
      for (let k = 0; k < steps; k++) {
        const t = (k + 0.5) / steps;
        if (pointPolyDistXY([p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t], o) < within + 4) coarse += len / steps;
      }
    }
    if (coarse + 16 < need) return false;
    let seen = 0;
    let close = 0;
    for (let i = 1; i < s.length; i++) {
      const p0 = s[i - 1];
      const p1 = s[i];
      const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      const steps = Math.max(1, Math.ceil(len / 2));
      const piece = len / steps;
      for (let k = 0; k < steps; k++) {
        const t = (k + 0.5) / steps;
        const m = [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
        seen += piece;
        if (!shared.some((q) => Math.hypot(m[0] - q[0], m[1] - q[1]) < SHAPE_OVERLAP_SHARED_M) && pointPolyDistXY(m, o) < within) {
          close += piece;
          if (close >= need) return true;
        }
        if (close + (total - seen) < need) return false;
      }
    }
    return close >= need;
  }

  function bboxXY(points, pad) {
    const b = bbox(points);
    return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
  }

  // ---------------------------------------------------------------------------
  // Slivers. Merging can leave a point B a few metres beside a straight road A-C that B
  // itself belongs to (one of the junctions merged into B lies on that road or on its other
  // carriageway), with a thin triangle between the road and B's roads to A or C. B is then
  // moved onto A-C and A-C is split there into A-B and B-C (an existing A-B / B-C is
  // replaced by the straight piece). Conditions, with r the merge radius:
  //  - B is joined to A or C, lies within r of A-C, and its foot on A-C is at least r from
  //    both A and C;
  //  - a junction merged into B lies within ALIGN_ON_ROAD_M of A-C's road, or B's road to A
  //    or C starts at a junction merged into B and runs within ALIGN_CARRIAGEWAY_M of A-C's
  //    road all along (the other carriageway of the same street);
  //  - B was merged from two or more junctions (merging moved it);
  //  - B moves at most r, ends at least r from every other point, no point drops below
  //    opts.minDegree roads, and the board gets no new crossing (of roads with or without a
  //    shared point), no new narrow angle (< ALIGN_NARROW_DEG) at B or any point joined
  //    to B, A or C, and no more roads running together or passing close to a point.
  // Candidates are taken in the order of their end point ids, so the result does not depend
  // on the order of the input data.
  // B's other roads keep their course with the end moved to B's new place.
  const ALIGN_ON_ROAD_M = 5;
  const ALIGN_CARRIAGEWAY_M = 20; // the other carriageway stays this close to the road
  const ALIGN_MAX_APPLIED = 200;
  const ALIGN_GUARD_DEGREE = true; // skip a move that would leave a point with fewer than 2 roads
  const ALIGN_MAX_REJECTED = 400; // candidates that failed the checks (bounds the work)
  const ALIGN_NARROW_DEG = 15;
  const ALIGN_KINK_MIN_DEG = 135; // second form: A-B-C bends by at most 45 degrees at B
  const ALIGN_KINK_ON_LINE_M = 8; // ...the junction the road passes is this close to A-C
  const ALIGN_KINK_MIN_OFFSET_M = 5; // ...and merging moved B at least this much further off

  function alignPointsOntoRoads(nodesIn, edgesIn, r, memberPos, opts = {}) {
    const applied = [];
    if (!(r > 0) || !memberPos || edgesIn.length === 0) return { nodes: nodesIn, edges: edgesIn, applied };
    const minDegree = opts.minDegree || 0; // no point may end with fewer roads than this (if it had them)
    const nodes = new Map();
    for (const [id, n] of nodesIn) nodes.set(id, { ...n, neighbors: new Set(n.neighbors) });
    const keyOf = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    // Deterministic order (independent of the order of the input data)
    let edges = edgesIn.slice().sort((x, y) => (keyOf(x.u, x.v) < keyOf(y.u, y.v) ? -1 : keyOf(x.u, x.v) > keyOf(y.u, y.v) ? 1 : 0));
    const byKey = new Map(edges.map((e) => [keyOf(e.u, e.v), e]));
    const proj = makeMetricProjector(nodes);
    const posCache = new Map();
    const P = (id) => {
      const n = nodes.get(id);
      const c = posCache.get(id);
      if (c && c.lat === n.lat && c.lon === n.lon) return c.xy;
      const xy = proj(n.lat, n.lon);
      posCache.set(id, { lat: n.lat, lon: n.lon, xy });
      return xy;
    };
    const xyOf = (coords) => coords.map(([lat, lon]) => proj(lat, lon));
    const realRoad = (e) => {
      const road = (e.roadCoords || e.coords).slice();
      if (Array.isArray(e.rawEnds)) {
        road[0] = e.rawEnds[0];
        road[road.length - 1] = e.rawEnds[1];
      }
      return road;
    };
    // nearest point of a lat/lon polyline to p (metres): { seg, t, d }
    const nearestOn = (coords, p) => {
      const pts = xyOf(coords);
      let best = { seg: 1, t: 0, d: Infinity };
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const abx = b[0] - a[0];
        const aby = b[1] - a[1];
        const l2 = abx * abx + aby * aby;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / l2)) : 0;
        const d = Math.hypot(p[0] - a[0] - abx * t, p[1] - a[1] - aby * t);
        if (d < best.d) best = { seg: i, t, d };
      }
      return best;
    };
    const pointAt = (coords, at) => {
      const a = coords[at.seg - 1];
      const b = coords[at.seg];
      return [a[0] + (b[0] - a[0]) * at.t, a[1] + (b[1] - a[1]) * at.t];
    };
    const makeEdge = (a, b, coords, roadCoords, rawA, rawB) => {
      const [u, v, c, rc, ru, rv] = a < b ? [a, b, coords, roadCoords, rawA, rawB] : [b, a, coords.slice().reverse(), roadCoords.slice().reverse(), rawB, rawA];
      const rawEnds = [ru, rv];
      return { u, v, coords: c, roadCoords: rc, length: polylineLength(rc), rawEnds, endShift: endShiftMeters(rc, rawEnds) };
    };
    // Crossings of roads without a shared point that involve a road of `subset` (each pair once)
    const crossingsInvolving = (list, subset) => {
      const xy = new Map();
      const box = new Map();
      for (const e of list) {
        const p = xyOf(edgeCoords(e, nodes));
        xy.set(e, p);
        box.set(e, bbox(p));
      }
      const counted = new Set();
      let count = 0;
      for (const e of subset) {
        const be = box.get(e);
        for (const o of list) {
          if (o === e || (subset.has(o) && counted.has(o))) continue;
          if (o.u === e.u || o.u === e.v || o.v === e.u || o.v === e.v) continue;
          const bo = box.get(o);
          if (bo.maxX < be.minX || bo.minX > be.maxX || bo.maxY < be.minY || bo.minY > be.maxY) continue;
          if (polylinesIntersect(xy.get(e), xy.get(o))) count++;
        }
        counted.add(e);
      }
      return count;
    };
    const roadsAt = (list, id) => list.filter((e) => e.u === id || e.v === id);
    // Pairs that run together, and points passed within SHAPE_NEAR_NODE_M by a road not
    // ending there, that involve a road of `subset` or the point `pid`
    const closenessInvolving = (list, subset, pid) => {
      const xy = new Map(list.map((e) => [e, xyOf(e.coords)]));
      const box = new Map(list.map((e) => [e, bboxXY(xy.get(e), SHAPE_OVERLAP_M)]));
      let count = 0;
      const counted = new Set();
      for (const e of subset) {
        const be = box.get(e);
        for (const o of list) {
          if (o === e || (subset.has(o) && counted.has(o))) continue;
          const bo = box.get(o);
          if (bo.maxX < be.minX || bo.minX > be.maxX || bo.maxY < be.minY || bo.minY > be.maxY) continue;
          const shared = [];
          if (o.u === e.u || o.v === e.u) shared.push(P(e.u));
          if (o.u === e.v || o.v === e.v) shared.push(P(e.v));
          if (polylinesRunTogether(xy.get(e), xy.get(o), shared)) count++;
        }
        counted.add(e);
        for (const [id] of nodes) {
          if (id === e.u || id === e.v) continue;
          const p = P(id);
          if (p[0] < be.minX || p[0] > be.maxX || p[1] < be.minY || p[1] > be.maxY) continue;
          if (pointPolyDistXY(p, xy.get(e)) < SHAPE_NEAR_NODE_M) count++;
        }
      }
      const pp = P(pid);
      for (const o of list) {
        if (o.u === pid || o.v === pid || subset.has(o)) continue;
        if (pointPolyDistXY(pp, xy.get(o)) < SHAPE_NEAR_NODE_M) count++;
      }
      return count;
    };
    // Pairs of roads from one point that meet again elsewhere, among the roads at `ids`
    const adjacentCrossingsAt = (list, ids) => {
      let count = 0;
      for (const id of ids) {
        const here = roadsAt(list, id);
        const at = P(id);
        for (let x = 0; x < here.length; x++) {
          for (let y = x + 1; y < here.length; y++) {
            const shared = [at];
            const ox = here[x].u === id ? here[x].v : here[x].u;
            const oy = here[y].u === id ? here[y].v : here[y].u;
            if (ox === oy) shared.push(P(ox));
            if (polylinesMeetAwayFrom(xyOf(here[x].coords), xyOf(here[y].coords), shared)) count++;
          }
        }
      }
      return count;
    };
    // Narrow angles per point (so a narrow angle fixed at one point cannot pay for a new one
    // at another)
    const narrowAt = (list, ids) => {
      const out = new Map();
      for (const id of ids) {
        let count = 0;
        const dirs = roadsAt(list, id).map((e) => bearingAlong(e, id, xyOf(e.coords), 15));
        for (let x = 0; x < dirs.length; x++) {
          for (let y = x + 1; y < dirs.length; y++) {
            if (angleBetween(dirs[x], dirs[y]) < (ALIGN_NARROW_DEG * Math.PI) / 180) count++;
          }
        }
        out.set(id, count);
      }
      return out;
    };
    const narrowGrew = (before, after) => {
      for (const [id, n] of after) if (n > (before.get(id) || 0)) return true;
      return false;
    };
    const tooCloseToOthers = (B, pos) => {
      for (const [id, n] of nodes) {
        if (id !== B && distanceMeters(n.lat, n.lon, pos[0], pos[1]) < r) return true;
      }
      return false;
    };

    // Move B to newPos: `replaced` (edge keys) are dropped, `added` edges come in, B's other
    // roads keep their course with the end moved. Applied only if it passes the checks.
    let rejected = 0;
    const tryApply = (B, newPos, replaced, added, info) => {
      const nb = nodes.get(B);
      const next = [];
      const changed = new Set();
      for (const e of edges) {
        if (replaced.has(e)) continue;
        if (e.u === B || e.v === B) {
          const moveEnd = (c) => (e.u === B ? [newPos].concat(c.slice(1)) : c.slice(0, -1).concat([newPos]));
          const rc = moveEnd(e.roadCoords || e.coords);
          const moved = { ...e, coords: rc, roadCoords: rc, length: polylineLength(rc), endShift: Array.isArray(e.rawEnds) ? endShiftMeters(rc, e.rawEnds) : e.endShift };
          next.push(moved);
          changed.add(moved);
        } else {
          next.push(e);
        }
      }
      for (const e of added) {
        next.push(e);
        changed.add(e);
      }
      // degrees after the change
      const deg = new Map();
      for (const e of next) {
        deg.set(e.u, (deg.get(e.u) || 0) + 1);
        deg.set(e.v, (deg.get(e.v) || 0) + 1);
      }
      const touched = new Set([B]);
      for (const e of edges) if (e.u === B || e.v === B || replaced.has(e)) { touched.add(e.u); touched.add(e.v); }
      for (const e of added) { touched.add(e.u); touched.add(e.v); }
      for (const id of touched) {
        const before = nodes.get(id).neighbors.size;
        if ((deg.get(id) || 0) < Math.min(before, minDegree)) { rejected++; return false; }
      }
      const oldSet = new Set(edges.filter((e) => replaced.has(e) || e.u === B || e.v === B));
      const crossBefore = crossingsInvolving(edges, oldSet);
      const adjBefore = adjacentCrossingsAt(edges, touched);
      const narrowBefore = narrowAt(edges, touched);
      const oldPos = [nb.lat, nb.lon];
      nb.lat = newPos[0];
      nb.lon = newPos[1];
      // the closeness count is the dearest check, so it comes last (counted at both places)
      const closeness = () => {
        const after = closenessInvolving(next, changed, B);
        nb.lat = oldPos[0];
        nb.lon = oldPos[1];
        const before = closenessInvolving(edges, oldSet, B);
        nb.lat = newPos[0];
        nb.lon = newPos[1];
        return after > before;
      };
      if (
        crossingsInvolving(next, changed) > crossBefore ||
        adjacentCrossingsAt(next, touched) > adjBefore ||
        narrowGrew(narrowBefore, narrowAt(next, touched)) ||
        closeness()
      ) {
        nb.lat = oldPos[0];
        nb.lon = oldPos[1];
        rejected++;
        return false;
      }
      // commit: neighbours from the new edge list
      for (const id of touched) nodes.get(id).neighbors = new Set();
      for (const e of next) {
        if (touched.has(e.u)) nodes.get(e.u).neighbors.add(e.v);
        if (touched.has(e.v)) nodes.get(e.v).neighbors.add(e.u);
      }
      applied.push({ ...info, point: B, movedM: distanceMeters(oldPos[0], oldPos[1], newPos[0], newPos[1]) });
      edges = next;
      byKey.clear();
      for (const e of edges) byKey.set(keyOf(e.u, e.v), e);
      return true;
    };
    const canTry = () => applied.length < ALIGN_MAX_APPLIED && rejected < ALIGN_MAX_REJECTED;

    // First form: the road A-C still exists
    const queue = edges.slice();
    for (let qi = 0; qi < queue.length && canTry(); qi++) {
      const ac = queue[qi];
      if (byKey.get(keyOf(ac.u, ac.v)) !== ac) continue; // replaced meanwhile
      const A = ac.u;
      const C = ac.v;
      const pa = P(A);
      const pc = P(C);
      const len = Math.hypot(pc[0] - pa[0], pc[1] - pa[1]);
      if (len < 2 * r) continue;
      const acXY = xyOf(ac.coords);
      const box = bboxXY(acXY, r);
      let acRoadXYc = null;
      const acRoadXY = () => acRoadXYc || (acRoadXYc = xyOf(realRoad(ac)));
      // B must be joined to A or C, so only their neighbours are candidates (sorted ids)
      const candidates = Array.from(new Set([...nodes.get(A).neighbors, ...nodes.get(C).neighbors])).sort();
      for (const B of candidates) {
        if (B === A || B === C || !canTry()) continue;
        const nb = nodes.get(B);
        const members = memberPos.get(B) || [];
        if (members.length < 2) continue; // only a point moved by merging
        const pb = P(B);
        if (pb[0] < box.minX || pb[0] > box.maxX || pb[1] < box.minY || pb[1] > box.maxY) continue;
        if (Math.min(pointPolyDistXY(pb, acXY), pointSegDistXY(pb, pa, pc)) > r) continue;
        const foot = ((pb[0] - pa[0]) * (pc[0] - pa[0]) + (pb[1] - pa[1]) * (pc[1] - pa[1])) / len;
        if (foot < r || len - foot < r) continue;
        // a junction of B on A-C's road (or on its other carriageway)
        let via = 'road';
        let onRoad = members.find((m) => pointPolyDistXY(proj(m[0], m[1]), acRoadXY()) <= ALIGN_ON_ROAD_M) || null;
        if (!onRoad) {
          via = 'carriageway';
          for (const X of [A, C]) {
            if (onRoad || !nb.neighbors.has(X)) continue;
            const bx = byKey.get(keyOf(B, X));
            if (!bx || !Array.isArray(bx.rawEnds)) continue;
            const rawAtB = bx.u === B ? bx.rawEnds[0] : bx.rawEnds[1];
            const m = members.find((q) => distanceMeters(rawAtB[0], rawAtB[1], q[0], q[1]) <= 0.5);
            if (!m) continue;
            if (xyOf(realRoad(bx)).every((q) => pointPolyDistXY(q, acRoadXY()) <= ALIGN_CARRIAGEWAY_M)) onRoad = m;
          }
        }
        if (!onRoad) continue;
        const newPos = pointAt(ac.coords, nearestOn(ac.coords, proj(onRoad[0], onRoad[1])));
        if (distanceMeters(nb.lat, nb.lon, newPos[0], newPos[1]) > r || tooCloseToOthers(B, newPos)) continue;
        // Split A-C there; the road course is split at its point nearest to it
        const road = ac.roadCoords || ac.coords;
        const roadAt = nearestOn(road, proj(newPos[0], newPos[1]));
        const roadA = road.slice(0, roadAt.seg).concat([newPos]);
        const roadC = [newPos].concat(road.slice(roadAt.seg));
        const rawA = ac.rawEnds ? ac.rawEnds[0] : road[0];
        const rawC = ac.rawEnds ? ac.rawEnds[1] : road[road.length - 1];
        const added = [
          makeEdge(A, B, [road[0], newPos], roadA, rawA, onRoad),
          makeEdge(B, C, [newPos, road[road.length - 1]], roadC, onRoad, rawC)
        ];
        const replaced = new Set([ac]);
        for (const X of [A, C]) if (byKey.has(keyOf(B, X))) replaced.add(byKey.get(keyOf(B, X)));
        if (tryApply(B, newPos, replaced, added, { form: 'road', via, road: [A, C] })) {
          for (const e of edges) if (e.u === B || e.v === B) queue.push(e); // check the new pieces too
          break;
        }
      }
    }

    // Second form: the straight road A-C was already dropped (by the degree cap) and B sits
    // in a kink A-B-C: B's roads to A and C both follow the line A-C (within
    // ALIGN_CARRIAGEWAY_M) and start at the same junction m merged into B; m lies within
    // ALIGN_KINK_ON_LINE_M of the line, B at least ALIGN_KINK_MIN_OFFSET_M further off.
    // B is moved onto the line A-C, at the foot of m; the same limits apply.
    for (const B of Array.from(nodes.keys()).sort()) {
      if (!canTry()) break;
      const members = memberPos.get(B) || [];
      if (members.length < 2) continue;
      const nb = nodes.get(B);
      const around = Array.from(nb.neighbors).sort();
      let done = false;
      for (let x = 0; x < around.length && !done && canTry(); x++) {
        for (let y = x + 1; y < around.length && !done && canTry(); y++) {
          const A = around[x];
          const C = around[y];
          const pa = P(A);
          const pb = P(B);
          const pc = P(C);
          const len = Math.hypot(pc[0] - pa[0], pc[1] - pa[1]);
          if (len < 2 * r) continue;
          const v1 = [pa[0] - pb[0], pa[1] - pb[1]];
          const v2 = [pc[0] - pb[0], pc[1] - pb[1]];
          const cosB = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2));
          if (cosB > Math.cos((ALIGN_KINK_MIN_DEG * Math.PI) / 180)) continue;
          const off = pointSegDistXY(pb, pa, pc);
          if (off < ALIGN_KINK_MIN_OFFSET_M || off > r) continue;
          const foot = ((pb[0] - pa[0]) * (pc[0] - pa[0]) + (pb[1] - pa[1]) * (pc[1] - pa[1])) / len;
          if (foot < r || len - foot < r) continue;
          const eBA = byKey.get(keyOf(B, A));
          const eBC = byKey.get(keyOf(B, C));
          if (!eBA || !eBC || !Array.isArray(eBA.rawEnds) || !Array.isArray(eBC.rawEnds)) continue;
          const chord = [pa, pc];
          if (!xyOf(realRoad(eBA)).every((q) => pointPolyDistXY(q, chord) <= ALIGN_CARRIAGEWAY_M)) continue;
          if (!xyOf(realRoad(eBC)).every((q) => pointPolyDistXY(q, chord) <= ALIGN_CARRIAGEWAY_M)) continue;
          // The road runs through one junction m merged into B (both roads start there), m
          // is on the line A-C, and merging moved B well off it
          const rawA = eBA.u === B ? eBA.rawEnds[0] : eBA.rawEnds[1];
          const rawC = eBC.u === B ? eBC.rawEnds[0] : eBC.rawEnds[1];
          if (distanceMeters(rawA[0], rawA[1], rawC[0], rawC[1]) > 0.5) continue;
          const m = members.find((q) => distanceMeters(rawA[0], rawA[1], q[0], q[1]) <= 0.5);
          if (!m) continue;
          const mOff = pointPolyDistXY(proj(m[0], m[1]), chord);
          if (mOff > ALIGN_KINK_ON_LINE_M || off - mOff < ALIGN_KINK_MIN_OFFSET_M) continue;
          const a = nodes.get(A);
          const c = nodes.get(C);
          const line = [[a.lat, a.lon], [c.lat, c.lon]];
          const newPos = pointAt(line, nearestOn(line, proj(m[0], m[1])));
          if (distanceMeters(nb.lat, nb.lon, newPos[0], newPos[1]) > r || tooCloseToOthers(B, newPos)) continue;
          const straightTo = (e, X) => {
            const moveEnd = (cc) => (e.u === B ? [newPos].concat(cc.slice(1)) : cc.slice(0, -1).concat([newPos]));
            const rc = moveEnd(e.roadCoords || e.coords);
            const px = [nodes.get(X).lat, nodes.get(X).lon];
            const drawn = e.u === B ? [newPos, px] : [px, newPos];
            return { ...e, coords: drawn, roadCoords: rc, length: polylineLength(rc), endShift: endShiftMeters(rc, e.rawEnds) };
          };
          done = tryApply(B, newPos, new Set([eBA, eBC]), [straightTo(eBA, A), straightTo(eBC, C)], { form: 'kink', road: [A, C] });
        }
      }
    }
    if (applied.length === 0) return { nodes: nodesIn, edges: edgesIn, applied };
    return { nodes, edges, applied };
  }

  // Returns new edge objects whose `coords` is the drawn shape; the road's own course (with
  // its ends at the merged points) stays in `roadCoords`. An edge keeps its current line if
  // the simpler shape would change which drawn lines it crosses, newly run along one, newly
  // pass within SHAPE_NEAR_NODE_M of a point that is not its end, cross itself, fold back
  // more sharply or leave `bounds`. Edges are taken in order; each check is against the
  // lines chosen so far, so the set of crossing pairs never changes. Running it again only
  // tries the edges not yet simplified (or changed since).
  function buildDisplayShapes(nodes, edgesIn, bounds) {
    const edges = edgesIn.map((e) => ({ ...e, roadCoords: e.roadCoords || e.coords }));
    if (edges.length === 0) return edges;
    const proj = makeMetricProjector(nodes);
    const P = new Map();
    for (const [id, n] of nodes) P.set(id, proj(n.lat, n.lon));
    const road = edges.map((e) => e.roadCoords.map(([lat, lon]) => proj(lat, lon)));
    const cur = edges.map((e) => e.coords.map(([lat, lon]) => proj(lat, lon)));
    const boxes = cur.map((p) => bboxXY(p, 0));
    // Coarse grid of the road boxes and the points. A simpler shape only drops points of its
    // road, so it stays inside the road's box and the grid stays valid.
    const CELL = 60;
    const cellKey = (cx, cy) => `${cx},${cy}`;
    const edgeCells = new Map();
    road.forEach((p, j) => {
      const b = bboxXY(p, 0);
      for (let cx = Math.floor(b.minX / CELL); cx <= Math.floor(b.maxX / CELL); cx++) {
        for (let cy = Math.floor(b.minY / CELL); cy <= Math.floor(b.maxY / CELL); cy++) {
          const k = cellKey(cx, cy);
          if (!edgeCells.has(k)) edgeCells.set(k, []);
          edgeCells.get(k).push(j);
        }
      }
    });
    const nodeCells = new Map();
    for (const [id, p] of P) {
      const k = cellKey(Math.floor(p[0] / CELL), Math.floor(p[1] / CELL));
      if (!nodeCells.has(k)) nodeCells.set(k, []);
      nodeCells.get(k).push([id, p]);
    }
    const inCells = (cells, b, visit) => {
      for (let cx = Math.floor(b.minX / CELL); cx <= Math.floor(b.maxX / CELL); cx++) {
        for (let cy = Math.floor(b.minY / CELL); cy <= Math.floor(b.maxY / CELL); cy++) {
          const list = cells.get(cellKey(cx, cy));
          if (list) for (const item of list) if (visit(item) === false) return;
        }
      }
    };
    const EPS_DEG = 1e-9;
    const inside = ([lat, lon]) => !bounds || (
      lat >= bounds.south - EPS_DEG && lat <= bounds.north + EPS_DEG &&
      lon >= bounds.west - EPS_DEG && lon <= bounds.east + EPS_DEG
    );

    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const rp = road[i];
      let rawPts = null;
      if (Array.isArray(e.rawEnds) && rp.length >= 2) {
        rawPts = rp.slice();
        rawPts[0] = proj(e.rawEnds[0][0], e.rawEnds[0][1]);
        rawPts[rawPts.length - 1] = proj(e.rawEnds[1][0], e.rawEnds[1][1]);
      }
      const keepIdx = candidateShapeIdx(rp, rawPts);
      if (keepIdx.length >= cur[i].length) continue; // nothing simpler than the line drawn now
      const cand = keepIdx.map((k) => rp[k]);
      const candLatLon = keepIdx.map((k) => e.roadCoords[k]);
      if (!candLatLon.every(inside)) continue;
      if (polylineSelfIntersects(cand)) continue;
      if (countFoldBacks(cand) > countFoldBacks(cur[i])) continue;
      // Look around both the simpler line and the current one: a road the current line
      // crosses may lie away from the simpler line
      const box = bboxXY(cand.concat(cur[i], rp), Math.max(SHAPE_OVERLAP_M, SHAPE_NEAR_NODE_M) + SHAPE_SLACK_M);
      let ok = true;
      inCells(nodeCells, box, ([id, p]) => {
        if (id === e.u || id === e.v) return true;
        if (p[0] < box.minX || p[0] > box.maxX || p[1] < box.minY || p[1] > box.maxY) return true;
        if (pointPolyDistXY(p, cand) < SHAPE_NEAR_NODE_M + SHAPE_SLACK_M && pointPolyDistXY(p, cur[i]) >= SHAPE_NEAR_NODE_M - SHAPE_SLACK_M) {
          ok = false;
          return false;
        }
        return true;
      });
      const near = new Set();
      if (ok) inCells(edgeCells, box, (j) => { near.add(j); });
      for (const j of near) {
        if (!ok) break;
        if (j === i) continue;
        const bj = boxes[j];
        if (bj.maxX < box.minX || bj.minX > box.maxX || bj.maxY < box.minY || bj.minY > box.maxY) continue;
        const o = edges[j];
        const shared = [];
        if (o.u === e.u || o.v === e.u) shared.push(P.get(e.u));
        if (o.u === e.v || o.v === e.v) shared.push(P.get(e.v));
        // The same roads cross as with the lines drawn now (so removing crossing roads gives
        // the same result, and a later pass cannot bring back a crossing), and no pair runs
        // together that did not on the roads' own courses.
        if (polylinesMeetAwayFrom(cand, cur[j], shared) !== polylinesMeetAwayFrom(cur[i], cur[j], shared)) ok = false;
        else if (
          polylinesRunTogether(cand, cur[j], shared, SHAPE_OVERLAP_M + SHAPE_SLACK_M) &&
          !polylinesRunTogether(rp, road[j], shared, SHAPE_OVERLAP_M - SHAPE_SLACK_M)
        ) ok = false;
      }
      if (!ok) continue;
      cur[i] = cand;
      boxes[i] = bboxXY(cand, 0);
      edges[i] = { ...e, coords: candLatLon };
    }
    return edges;
  }

  function wantedNodes(targetNodes) {
    return Math.max(MIN_BOARD_NODES, Math.floor(targetNodes * 0.85));
  }

  // Distance (m) from the centre to a corner of the auto-selected square
  function squareCornerMeters(graph) {
    if (!graph.boardBounds) return 0;
    return ((graph.boardBounds.north - graph.boardBounds.south) / 2) * 111000 * Math.SQRT2;
  }

  // Build the board; if it falls short of the wanted size, first try larger squares within
  // the data already at hand (coverage = radius in metres the data is complete for).
  // Returns { graph, hitCoverage } where hitCoverage tells whether more data could help.
  function buildWithLocalGrowth(elements, lat, lon, optionsIn, coverage) {
    const targetNodes = optionsIn.targetNodes || 81;
    const want = wantedNodes(targetNodes);
    // The square's margin stays within the data coverage and the size limit of the
    // requested board (not of the enlarged targets tried below).
    const options = {
      ...optionsIn,
      coverageM: coverage,
      maxNodes: Math.min(MAX_BOARD_NODES, SQUARE_MARGIN_MAX_RATIO * targetNodes),
      minNodes: SQUARE_MARGIN_MIN_RATIO * targetNodes
    };
    let best = buildRoadGraph(elements, lat, lon, options);
    if (best.stats.nodeCount >= want) return { graph: best, hitCoverage: false };
    if (squareCornerMeters(best) > coverage) return { graph: best, hitCoverage: true };

    let t = targetNodes;
    for (let k = 0; k < 16 && best.stats.nodeCount < want; k++) {
      t = Math.ceil(t * 1.25);
      if (t > EARLY_TOO_MANY_FACTOR * MAX_BOARD_NODES) break;
      let g;
      try {
        g = buildRoadGraph(elements, lat, lon, { ...options, targetNodes: t });
      } catch (err) {
        if (err && err.kind === 'too-many') break;
        throw err;
      }
      if (squareCornerMeters(g) > coverage) return { graph: best, hitCoverage: true };
      if (g.stats.nodeCount > best.stats.nodeCount) best = g;
      if (g.stats.nodeCount === 0 && t > 4 * targetNodes) break;
    }
    return { graph: best, hitCoverage: false };
  }

  // ctx: { signal, allowNetwork } — allowNetwork=false restricts to bundled / cached data.
  async function generateStreetGoBoard(placeQuery, options, onProgress, ctx = {}) {
    const { signal, allowNetwork = true } = ctx;
    const report = (msg) => {
      if (typeof onProgress === 'function') onProgress(msg);
    };

    try {
      await ensurePresetLoaded(placeQuery, signal);
    } catch (err) {
      if (err && err.kind === 'aborted') throw err;
      if (signal && signal.aborted) throw abortedError();
      if (!allowNetwork) {
        throw new StreetGoError('offline', '同梱の盤面データを読み込めませんでした。ページを再読み込みしてください。');
      }
      // Bundled file unavailable: fall through to the normal (network) path.
    }

    if (!findPreset(placeQuery)) report(`「${placeQuery}」の位置を検索中...`);
    const location = await geocodePlace(placeQuery, { signal, allowNetwork });
    const mode = options.includeFootways ? 'all' : 'simple';

    const targetNodes = options.targetNodes || 81;
    let radius = Math.max(300, Math.round(Math.sqrt(targetNodes) * 45));
    if (!allowNetwork && !findCachedEntry(location.lat, location.lon, radius, mode)) {
      // Offline (initial board): shrink the request to what the bundled data covers
      const maxR = maxCachedRadius(location.lat, location.lon, mode);
      if (maxR > 0) radius = maxR;
    }
    let graph = null;

    // At most one automatic enlargement (2 attempts total).
    for (let attempt = 1; attempt <= 2; attempt++) {
      throwIfAborted(signal);
      const cachedBefore = findCachedEntry(location.lat, location.lon, radius, mode);
      report(cachedBefore ? '道路データを読み込み中...' : `周辺の道路網を取得中 (半径 ${radius}m)...`);
      const elements = await fetchOverpassRoads(location.lat, location.lon, radius, { signal, allowNetwork, mode });
      const coverage = cachedBefore ? cachedBefore.coverage : radius;

      report('交差点グラフを構築中...');
      const built = buildWithLocalGrowth(elements, location.lat, location.lon, options, coverage);
      graph = built.graph;

      if (graph.stats.nodeCount >= wantedNodes(targetNodes) || radius >= 2800 || attempt === 2) {
        break;
      }
      // A new fetch only helps when the square had to reach beyond the data we have.
      // (A short count caused by pruning dangling spurs would not improve with more data.)
      if (!built.hitCoverage) break;
      const nextRadius = Math.min(3000, Math.round(radius * 1.85));
      if (!allowNetwork && !findCachedRoads(location.lat, location.lon, nextRadius, mode)) {
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

    // `bounds` is any rectangle { south, west, north, east }. Checked before any request.
    const place = normalizeDrawnBounds(bounds);
    if (!place.ok) throw new StreetGoError('area', place.message);
    bounds = place.bounds;
    const circle = rectCoverCircle(bounds);
    const centerLat = circle.lat;
    const centerLon = circle.lon;

    if (!(circle.halfDiagM <= MAX_DRAW_HALF_DIAG_M)) {
      throw new StreetGoError('area', MSG_DRAW_TOO_LARGE);
    }
    const shape = checkDrawnRect(rectSizeMeters(bounds));
    if (!shape.ok) throw new StreetGoError('area', shape.message);

    // Data at hand (bundled / fetched earlier) is used when its circle holds the whole
    // rectangle; only a new request uses the circle that covers the rectangle.
    const fetchRadius = circle.radiusM;
    const mode = options.includeFootways ? 'all' : 'simple';
    let elements = findCachedRoadsForRect(bounds, mode);
    if (elements) {
      report('道路データを読み込み中...');
    } else {
      report(`選択範囲の道路網を取得中 (半径 ${fetchRadius}m)...`);
      elements = await fetchOverpassRoads(centerLat, centerLon, fetchRadius, { signal, allowNetwork, mode });
    }

    report('範囲内の交差点グラフを構築中...');
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
    dragRectPx,
    rectSizeMeters,
    rectCoverCircle,
    checkDrawnRect,
    normalizeDrawnBounds,
    findCachedRoadsForRect,
    formatRectSize,
    stoneDiameterPx,
    nodeStoneDiameters,
    pickNodeAtPoint,
    MIN_DRAW_SIDE_PX,
    MAX_DRAW_SIDE_M,
    MAX_DRAW_ASPECT,
    MAX_DRAW_HALF_DIAG_M,
    DRAW_FETCH_MARGIN_M,
    // exposed for tests / tooling
    buildRoadGraph,
    pruneToLargestComponent,
    simplifyBoardGraph,
    buildDisplayShapes,
    alignPointsOntoRoads,
    countEdgeCrossings,
    clusterJunctions,
    ASSET_VERSION,
    buildOverpassQuery,
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
    MAX_NODE_DEGREE,
    DEFAULT_MERGE_RADIUS_M,
    MAX_OVERPASS_ELEMENTS
  };

  global.StreetGoMap = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
