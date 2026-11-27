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
  const SQUARE_MAX_RATIO = 1.15; // auto square: the board aims at 0.85..1.15 x targetNodes points
  const SQUARE_MIN_RATIO = 0.85;
  const EARLY_TOO_MANY_FACTOR = 3; // abort before the heavier steps above 3 x MAX_BOARD_NODES
  const MAX_BOARD_NODES = 450;
  const MAX_OVERPASS_ELEMENTS = 200000;

  // ---------------------------------------------------------------------------
  // Board generation thresholds (metres unless stated). The steps they belong to are
  // described at buildBoardGen.
  const SHIFT_MAX_M = 80; // a place's square: its centre may move this far east-west / north-south ...
  const SHIFT_STEP_M = 20; // ... in steps of this
  const SHIFT_NEAR_M = 30; // roads this close to a side ...
  const SHIFT_ANGLE_DEG = 20; // ... and this close to its direction run along it
  const SHIFT_PIECE_M = 5; // (measured on road pieces of at most this length)
  const SHIFT_MAX_BUILDS = 2; // moved squares built at most
  const SHIFT_JUNCTION_SHARE = 0.2; // a moved square is built only if its raw junctions stay within this share
  const FRAME_PAD_M = 22; // a place's frame: margin around its points and lines ...
  const FRAME_PAD_SHARE = 0.045; // ... or this share of their extent, if larger
  const FIRST_RADIUS_PER_SQRT_M = 95; // first road request for a place: radius = this x sqrt(target)

  // clipping, links, merging, side-by-side roads, loops, parts, dead ends
  const CLAMP_TOL_M = 1; // points this close to the rectangle's outline (outside or inside) are put on it
  const CUT_EPS_M = 1e-6; // shorter clipped stretches (a corner touch) are dropped
  const ZERO_SEG_M = 0.01; // consecutive points closer than this are one point
  const MAX_CLIPPED_SEGMENTS = 60000; // road segments inside the rectangle
  const PARALLEL_WITHIN_M = 12; // two roads this close ...
  const PARALLEL_MIN_RUN_M = 25; // ... over this length run together (one centre line)
  const PARALLEL_SHARED_M = 15; // the stretch around a point both roads start from does not count
  const PARALLEL_END_SNAP_M = 15; // a run ending this close (or within the merge radius) to a road's end ends at that point
  const PARALLEL_COS = Math.cos((30 * Math.PI) / 180); // directions within 30 degrees
  const PARALLEL_MAX_PAIRS = 200000; // candidate road pairs per pass
  const PARALLEL_LINK_M = 2 * PARALLEL_WITHIN_M; // see mergeParallelRoads
  const COINCIDENT_M = 1; // two lines this close lie on top of each other ...
  const COINCIDENT_MIN_RUN_M = 10; // ... and are one line over such a stretch, even from a shared point
  const PARALLEL_MAX_MERGES = 3000;
  const DUPLICATE_ROUTE_M = 15; // two roads between the same points this close everywhere are one
  const LOOP_MIN_M = 30; // a loop shorter than this is part of its point
  const SMALL_LOOP_M = 150; // a loop with one way in, shorter than this, is left out
  const SMALL_ROUTES_M = 150; // two routes between two points, together shorter: the shorter stays
  const SHORT_ROUTE_M = 80; // ... and so when both are shorter than this
  const FACING_MAX_M = 25; // two dead ends this close, facing each other, are one road
  const FACING_MAX_DEG = 25;
  const SHORT_SPUR_M = 12; // a dead-end branch shorter than this has no point at its end (drawn only)
  const TAIL_MAX_M = 40; // a piece this long or longer keeps its point (never drawn only)
  const END_GAP_M = 8; // points closer than this that no road joins: one is drawn only
  const MIN_POINT_GAP_M = 1; // see collapseTinyGaps
  const END_MOVE_DEV_M = 3; // a road end moved to its merged point may take the line this far off the road
  const MOVE_MAX_DEV_M = 8; // a point moved onto a centre line may take its other roads this far off
  const RING_TOL_M = 0.5; // a dead-end branch this close to the board's outline is inside it
  const BRIDGE_HALF_M = 7; // length of the upper road drawn over a crossing, each side
  const OVERLAP_WITHIN_M = 3; // two roads from a common point this close from a crossing to it ...
  const OVERLAP_MAX_M = 60; // ... over at most this length run together there (no bridge)
  // Leave out closed ways that look like area outlines (see isAreaOutline): the data has no
  // tags to tell a plaza outline from a loop road (options.dropAreaOutlines overrides).
  const DROP_AREA_OUTLINES = true;
  const AREA_SHARP_CORNERS = 4;

  // drawn shapes (buildDisplayShapes)
  const SHAPE_STRAIGHT_DEV_M = 4; // road within this of its chord -> straight line
  const SHAPE_END_ZONE_M = 25; // bends this close to a junction may be dropped...
  const SHAPE_END_DEV_M = 2.5; // ...if the line stays within this of the road there
  const SHAPE_DP_TOL_M = 2.5; // Douglas-Peucker tolerance for the rest of the road
  const SHAPE_NEAR_NODE_M = 8; // a line must not newly pass this close to another point
  const SHAPE_OVERLAP_M = 10; // two lines this close over a long stretch run together
  const SHAPE_OVERLAP_MIN_M = 20;
  const SHAPE_OVERLAP_SHARED_M = 15; // ignored around a point both lines start from
  const SHAPE_TOUCH_M = 1; // where two lines meet at a shared point
  const SHAPE_SLACK_M = 1; // borderline cases count against the simpler shape
  const SHAPE_MIN_LEN_M = 0.5; // a drawn line never gets shorter than this

  // merged points moved onto their road (alignPointsOntoRoads)
  const ALIGN_ON_ROAD_M = 5;
  const ALIGN_CARRIAGEWAY_M = 20; // the other carriageway stays this close to the road
  const ALIGN_MAX_APPLIED = 200;
  const ALIGN_MAX_REJECTED = 400; // candidates that failed the checks (bounds the work)
  const ALIGN_NARROW_DEG = 15;
  const ALIGN_KINK_MIN_DEG = 135; // second form: A-B-C bends by at most 45 degrees at B
  const ALIGN_KINK_ON_LINE_M = 8; // ...the junction the road passes is this close to A-C
  const ALIGN_KINK_MIN_OFFSET_M = 5; // ...and merging moved B at least this much further off

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

  // Validate an Overpass JSON response. Throws on incomplete / oversized data: a remark
  // (the server cut the query short) and a way that refers to a node missing from the
  // response both mean some roads would be missing, so no board is made from it.
  // Returns { elements, cacheable }.
  function validateOverpassJson(json) {
    if (!json || !Array.isArray(json.elements)) {
      throw new StreetGoError('incomplete', '道路データの応答が不完全でした。しばらく待って再試行してください。');
    }
    const elements = json.elements;
    const remark = typeof json.remark === 'string' && json.remark.trim() !== '' ? json.remark : null;
    if (remark) {
      throw new StreetGoError('incomplete', '道路データの応答が不完全でした（サーバー側で処理が打ち切られました）。しばらく待って再試行してください。');
    }
    if (elements.length > MAX_OVERPASS_ELEMENTS) {
      throw new StreetGoError('too-many', `道路データが多すぎます（${elements.length}要素）。範囲を狭めてください`);
    }
    const nodeIds = new Set();
    for (const el of elements) {
      if (el && el.type === 'node') {
        if (!(Number.isFinite(el.lat) && Number.isFinite(el.lon))) {
          throw new StreetGoError('incomplete', '道路データの応答が不完全でした（座標が欠けています）。しばらく待って再試行してください。');
        }
        nodeIds.add(el.id);
      }
    }
    for (const el of elements) {
      if (el && el.type === 'way' && (!Array.isArray(el.nodes) || el.nodes.length < 2)) {
        throw new StreetGoError('incomplete', '道路データの応答が不完全でした（道の点の一覧が欠けています）。しばらく待って再試行してください。');
      }
      if (el && el.type === 'way' && Array.isArray(el.nodes)) {
        for (const nid of el.nodes) {
          if (!nodeIds.has(nid)) {
            throw new StreetGoError('incomplete', '道路データの応答が不完全でした（道の点が欠けています）。しばらく待って再試行してください。');
          }
        }
      }
    }
    return { elements, cacheable: true };
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

  // Diameter of one point's marker: the zoom's base size, but no more than 88% of the
  // screen distance to the nearest road-connected neighbour (so stones at both ends of a
  // short road leave the road visible), and never below 70% of the base size.
  // A point without a usable neighbour distance keeps the base size. Whole pixels.
  function stoneDiameterPx(basePx, nearestNeighborPx) {
    if (!(basePx > 0)) return 0;
    if (!Number.isFinite(nearestNeighborPx) || nearestNeighborPx < 0) return Math.round(basePx);
    const d = Math.min(basePx, Math.max(basePx * 0.7, nearestNeighborPx * 0.88));
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

  // Keyboard: the neighbours of a point in clockwise order on screen, starting from straight
  // up (screen pixels, y downwards). center { x, y }; neighbours [{ id, x, y }]. Returns ids.
  function neighborsClockwise(center, neighbors) {
    const withAngle = neighbors
      .filter((n) => n && Number.isFinite(n.x) && Number.isFinite(n.y))
      .map((n) => {
        // angle from "up", growing clockwise (east = 90 degrees)
        let a = Math.atan2(n.x - center.x, center.y - n.y);
        if (a < 0) a += 2 * Math.PI;
        return { id: n.id, a };
      });
    withAngle.sort((p, q) => p.a - q.a || (String(p.id) < String(q.id) ? -1 : 1));
    return withAngle.map((n) => n.id);
  }

  // The point focus moves to with the cycle keys: around `pivot`, through its neighbours in
  // clockwise order (step 1) or anticlockwise (step -1) and back to the pivot itself.
  // order: neighborsClockwise of the pivot; current: the focused point id.
  function nextInCycle(pivot, order, current, step) {
    const ring = order.concat([pivot]);
    const i = ring.indexOf(current);
    if (i < 0) return step > 0 ? ring[0] : ring[ring.length - 2] !== undefined ? ring[ring.length - 2] : pivot;
    return ring[(i + (step > 0 ? 1 : ring.length - 1)) % ring.length];
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
  // linked(a, b) (optional): only junctions a road joins nearby may share a cluster (a
  // member and its leader, and the leaders of two clusters merged in step 2).
  // Returns [{ lat, lon, members: [junction] }].
  function clusterJunctions(jList, r, linked) {
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
        if (d <= r && d < bestD && (!linked || linked(j.id, e.item.leader.id))) {
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
          if (linked && !linked(c.leader.id, o.leader.id)) return;
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

  // ---------------------------------------------------------------------------
  // Board generation. Outline (one board rectangle, every distance in metres):
  //  1. Every way is clipped to the board rectangle first (points within CLAMP_TOL_M of the
  //     outline count as on it). A road leaving the rectangle is used up to its last
  //     junction (or real dead end) inside; the piece from there to the frame is left out,
  //     and so is a road crossing without a junction inside. A way that leaves and comes back
  //     gives separate stretches (no link through the outside). A junction that keeps only
  //     one or two roads this way stays a point.
  //  2. Roads are joined only where OpenStreetMap shares a node. Lines that cross without a
  //     shared node (bridges, overpasses) both stay, without a point at the crossing.
  //     Points are typed: junction, deadEnd (one road) and shape (a point that keeps a loop
  //     or a second route).
  //  3. Junctions closer than the merge radius r are merged (only junctions, and only if a
  //     road joins them within 2 r).
  //  4. Two roads running side by side (dual carriageways) are drawn as one centre line over
  //     the stretch they run together; the roads before and after it keep their links.
  //  5. Loops and second routes between the same two points keep a shape point.
  //  6. Dead ends: kept, or (option) removed branch by branch. A junction left with one road
  //     by the frame always stays.
  //  7. Every connected part with 3+ points stays; a board split into many parts gets a
  //     warning.
  //  8. Merged points beside their road are moved onto it; lines are drawn simpler.


  function cmpKey(a, b) {
    const na = typeof a === 'number';
    const nb = typeof b === 'number';
    if (na && nb) return a - b;
    if (na !== nb) return na ? -1 : 1;
    const sa = String(a);
    const sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }

  function nowMs() {
    return typeof performance !== 'undefined' && performance && typeof performance.now === 'function' ? performance.now() : Date.now();
  }

  // Parsed road data, cached per elements array (the square search builds many boards
  // from the same data).
  const prepCache = new WeakMap();
  function prepareRoadData(elements) {
    const list = Array.isArray(elements) ? elements : [];
    if (prepCache.has(list)) return prepCache.get(list);
    const nodes = new Map();
    for (const el of list) {
      if (el && el.type === 'node' && Number.isFinite(el.lat) && Number.isFinite(el.lon)) nodes.set(el.id, [el.lat, el.lon]);
    }
    const wayById = new Map();
    for (const el of list) {
      if (!el || el.type !== 'way' || !Array.isArray(el.nodes) || el.nodes.length < 2) continue;
      const sig = el.nodes.join(',');
      const id = el.id !== undefined && el.id !== null ? el.id : `w:${sig}`;
      const prev = wayById.get(id);
      if (!prev || sig < prev.sig) wayById.set(id, { id, nodes: el.nodes, sig });
    }
    const ways = [];
    const nbrs = new Map();
    const link = (a, b) => {
      if (!nbrs.has(a)) nbrs.set(a, new Set());
      if (!nbrs.has(b)) nbrs.set(b, new Set());
      nbrs.get(a).add(b);
      nbrs.get(b).add(a);
    };
    const sorted = Array.from(wayById.values()).sort((a, b) => cmpKey(a.id, b.id));
    // Closed ways that look like the outline of an area (a square, a plaza) rather than a road:
    // not joined to any other way, or with AREA_SHARP_CORNERS corners of 60 degrees or more
    // (roundabouts and loop roads bend smoothly). Used only with options.dropAreaOutlines.
    const wayCount = new Map();
    for (const w of sorted) for (const nid of new Set(w.nodes)) wayCount.set(nid, (wayCount.get(nid) || 0) + 1);
    for (const w of sorted) w.areaLike = isAreaOutline(w.nodes, nodes, wayCount);
    for (const w of sorted) {
      // A way referring to a node that is not in the data is split there (the response check
      // refuses such data before it gets here).
      let run = [];
      const flush = () => {
        if (run.length >= 2) {
          let minLat = Infinity;
          let maxLat = -Infinity;
          let minLon = Infinity;
          let maxLon = -Infinity;
          for (const nid of run) {
            const [la, lo] = nodes.get(nid);
            if (la < minLat) minLat = la;
            if (la > maxLat) maxLat = la;
            if (lo < minLon) minLon = lo;
            if (lo > maxLon) maxLon = lo;
          }
          ways.push({ id: w.id, nodes: run, minLat, maxLat, minLon, maxLon, areaLike: w.areaLike });
          for (let i = 1; i < run.length; i++) link(run[i - 1], run[i]);
        }
        run = [];
      };
      for (const nid of w.nodes) {
        if (!nodes.has(nid)) {
          flush();
          continue;
        }
        if (run.length > 0 && run[run.length - 1] === nid) continue;
        run.push(nid);
      }
      flush();
    }
    const rawDeg = new Map();
    const junctionIds = [];
    for (const [id, s] of nbrs) {
      rawDeg.set(id, s.size);
      if (s.size >= 3) junctionIds.push(id);
    }
    junctionIds.sort(cmpKey);
    const prep = { nodes, ways, rawDeg, junctionIds };
    prepCache.set(list, prep);
    return prep;
  }

  function isAreaOutline(ids, nodes, wayCount) {
    if (ids.length < 4 || ids[0] !== ids[ids.length - 1] || !ids.every((id) => nodes.has(id))) return false;
    if (ids.every((id) => wayCount.get(id) === 1)) return true;
    const lat0 = nodes.get(ids[0])[0];
    const kx = 111320 * Math.max(1e-6, Math.cos((lat0 * Math.PI) / 180));
    const p = ids.map((id) => [nodes.get(id)[1] * kx, nodes.get(id)[0] * 110540]);
    const m = p.length - 1;
    let sharp = 0;
    for (let i = 0; i < m; i++) {
      const a = p[(i - 1 + m) % m];
      const b = p[i];
      const c = p[(i + 1) % m];
      const v1 = [b[0] - a[0], b[1] - a[1]];
      const v2 = [c[0] - b[0], c[1] - b[1]];
      const l1 = Math.hypot(v1[0], v1[1]);
      const l2 = Math.hypot(v2[0], v2[1]);
      if (l1 < 0.5 || l2 < 0.5) continue;
      if ((v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2) <= 0.5) sharp++;
    }
    return sharp >= AREA_SHARP_CORNERS;
  }

  // Local metres around the middle of the rectangle (x east, y north) and back.
  function makeFrame(rect) {
    const lat0 = (rect.south + rect.north) / 2;
    const lon0 = (rect.west + rect.east) / 2;
    const kx = 111320 * Math.max(1e-6, Math.cos((lat0 * Math.PI) / 180));
    const ky = 110540;
    const F = {
      rect,
      kx,
      ky,
      x0: (rect.west - lon0) * kx,
      x1: (rect.east - lon0) * kx,
      y0: (rect.south - lat0) * ky,
      y1: (rect.north - lat0) * ky
    };
    F.xy = (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky];
    // Back to latitude / longitude, kept inside the rectangle (rounding only)
    F.ll = (p) => [
      Math.min(rect.north, Math.max(rect.south, lat0 + p[1] / ky)),
      Math.min(rect.east, Math.max(rect.west, lon0 + p[0] / kx))
    ];
    const E = 1e-6;
    F.onFrame = (p) => Math.abs(p[0] - F.x0) < E || Math.abs(p[0] - F.x1) < E || Math.abs(p[1] - F.y0) < E || Math.abs(p[1] - F.y1) < E;
    F.snap = (p) => {
      let [x, y] = p;
      if (Math.abs(x - F.x0) < 1e-7) x = F.x0;
      if (Math.abs(x - F.x1) < 1e-7) x = F.x1;
      if (Math.abs(y - F.y0) < 1e-7) y = F.y0;
      if (Math.abs(y - F.y1) < 1e-7) y = F.y1;
      return [Math.min(F.x1, Math.max(F.x0, x)), Math.min(F.y1, Math.max(F.y0, y))];
    };
    return F;
  }

  // Liang-Barsky: [t0, t1] of segment p-q inside the rectangle, or null
  function clipParams(p, q, F) {
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    let t0 = 0;
    let t1 = 1;
    const checks = [[-dx, p[0] - F.x0], [dx, F.x1 - p[0]], [-dy, p[1] - F.y0], [dy, F.y1 - p[1]]];
    for (const [pp, qq] of checks) {
      if (pp === 0) {
        if (qq < 0) return null;
      } else {
        const r = qq / pp;
        if (pp < 0) {
          if (r > t1) return null;
          if (r > t0) t0 = r;
        } else {
          if (r < t0) return null;
          if (r < t1) t1 = r;
        }
      }
    }
    return [t0, t1];
  }

  // --- polyline helpers (metres) ---
  function lenXY(pts) {
    let t = 0;
    for (let i = 1; i < pts.length; i++) t += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return t;
  }
  function cumXY(pts) {
    const c = [0];
    for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    return c;
  }
  function atXY(pts, cum, s) {
    if (s <= 0) return pts[0].slice();
    const L = cum[cum.length - 1];
    if (s >= L) return pts[pts.length - 1].slice();
    let lo = 1;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < s) lo = mid + 1;
      else hi = mid;
    }
    const seg = cum[lo] - cum[lo - 1];
    const t = seg > 0 ? (s - cum[lo - 1]) / seg : 0;
    return [pts[lo - 1][0] + (pts[lo][0] - pts[lo - 1][0]) * t, pts[lo - 1][1] + (pts[lo][1] - pts[lo - 1][1]) * t];
  }
  function dirAtXY(pts, cum, s) {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const dx = pts[i][0] - pts[i - 1][0];
    const dy = pts[i][1] - pts[i - 1][1];
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  }
  // pts between arc lengths s0 < s1
  function subXY(pts, cum, s0, s1) {
    const out = [atXY(pts, cum, s0)];
    for (let i = 1; i < pts.length - 1; i++) if (cum[i] > s0 && cum[i] < s1) out.push(pts[i].slice());
    out.push(atXY(pts, cum, s1));
    return out;
  }
  // nearest point of polyline pts to p: { d, s, dir }
  function nearestXY(pts, cum, p) {
    let best = { d: Infinity, s: 0, dir: [1, 0] };
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const abx = b[0] - a[0];
      const aby = b[1] - a[1];
      const l2 = abx * abx + aby * aby;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / l2)) : 0;
      const d = Math.hypot(p[0] - a[0] - abx * t, p[1] - a[1] - aby * t);
      if (d < best.d) {
        const l = Math.sqrt(l2) || 1;
        best = { d, s: cum[i - 1] + (cum[i] - cum[i - 1]) * t, dir: [abx / l, aby / l] };
      }
    }
    return best;
  }
  // nearestXY restricted to the arc lengths lo..hi of pts
  function nearestXYRange(pts, cum, p, lo, hi) {
    let best = { d: Infinity, s: Math.max(0, lo), dir: [1, 0] };
    for (let i = 1; i < pts.length; i++) {
      if (cum[i] < lo || cum[i - 1] > hi) continue;
      const a = pts[i - 1];
      const b = pts[i];
      const abx = b[0] - a[0];
      const aby = b[1] - a[1];
      const l2 = abx * abx + aby * aby;
      const segLen = Math.sqrt(l2) || 1;
      let t = l2 > 0 ? ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / l2 : 0;
      const tLo = Math.max(0, (lo - cum[i - 1]) / segLen);
      const tHi = Math.min(1, (hi - cum[i - 1]) / segLen);
      t = Math.max(tLo, Math.min(tHi, t));
      const d = Math.hypot(p[0] - a[0] - abx * t, p[1] - a[1] - aby * t);
      if (d < best.d) best = { d, s: cum[i - 1] + (cum[i] - cum[i - 1]) * t, dir: [abx / segLen, aby / segLen] };
    }
    return best;
  }
  function simplifyXY(pts, tol) {
    if (pts.length <= 2) return pts;
    const idx = douglasPeuckerIdx(pts, pts.map((_, i) => i), tol);
    return idx.map((i) => pts[i]);
  }
  // Largest distance of polyline a (sampled every 2 m) from polyline b, not counting a's ends
  function maxDeviationXY(a, b) {
    const ca = cumXY(a);
    const cb = cumXY(b);
    const L = ca[ca.length - 1];
    const n = Math.max(2, Math.ceil(L / 2));
    let m = 0;
    for (let k = 1; k < n; k++) m = Math.max(m, nearestXY(b, cb, atXY(a, ca, (k * L) / n)).d);
    return m;
  }
  function segSegDistXY(a0, a1, b0, b1) {
    if (segmentMeetPoints(a0, a1, b0, b1).length > 0) return 0;
    return Math.min(pointSegDistXY(a0, b0, b1), pointSegDistXY(a1, b0, b1), pointSegDistXY(b0, a0, a1), pointSegDistXY(b1, a0, a1));
  }
  // Largest distance of the samples of a from polyline b (both ways)
  function hausdorffXY(a, b, step = 3) {
    const one = (p, q) => {
      const cq = cumXY(q);
      const cp = cumXY(p);
      const L = cp[cp.length - 1];
      const n = Math.max(1, Math.ceil(L / step));
      let m = 0;
      for (let k = 0; k <= n; k++) m = Math.max(m, nearestXY(q, cq, atXY(p, cp, (k * L) / n)).d);
      return m;
    };
    return Math.max(one(a, b), one(b, a));
  }
  // Two polylines of the same direction averaged point by point (equal fractions of length)
  function averageXY(a, b) {
    const ca = cumXY(a);
    const cb = cumXY(b);
    const La = ca[ca.length - 1];
    const Lb = cb[cb.length - 1];
    const n = Math.max(2, Math.ceil(Math.max(La, Lb) / 4) + 1);
    const out = [];
    for (let k = 0; k < n; k++) {
      const t = k / (n - 1);
      const p = atXY(a, ca, t * La);
      const q = atXY(b, cb, t * Lb);
      out.push([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
    }
    return out;
  }

  // Shortest road distance between junctions, searched up to `limit` metres
  function makeRoadLink(jAdj, limit) {
    const memo = new Map();
    const from = (src) => {
      if (memo.has(src)) return memo.get(src);
      const dist = new Map([[src, 0]]);
      const done = new Set();
      const queue = [[0, src]];
      while (queue.length > 0) {
        let bi = 0;
        for (let i = 1; i < queue.length; i++) if (queue[i][0] < queue[bi][0]) bi = i;
        const [d, cur] = queue[bi];
        queue[bi] = queue[queue.length - 1];
        queue.pop();
        if (done.has(cur)) continue;
        done.add(cur);
        const out = jAdj.get(cur);
        if (!out) continue;
        for (const [nb, len] of out) {
          const nd = d + len;
          if (nd > limit) continue;
          if (!dist.has(nb) || nd < dist.get(nb)) {
            dist.set(nb, nd);
            queue.push([nd, nb]);
          }
        }
      }
      memo.set(src, dist);
      return dist;
    };
    return (a, b) => a === b || from(a).has(b);
  }

  // Working graph: points (metres) and roads (polylines), with incidence lists.
  function makeWorkGraph() {
    const G = {
      points: new Map(), // pid -> { pid, p: [x, y], shape, mid, real, pin, stub, members: [[x, y]] | null }
      edges: new Map(), // eid -> { eid, u, v, pts, ways: Set, src, rawA, rawB }
      inc: new Map(), // pid -> Set(eid)
      alias: new Map(), // merged pid -> pid it went into
      tails: [], // { pid, pts } drawn from point pid (short dead-end branches), not on the board
      streetWays: [], // way ids of roads merged as one street (side by side)
      nextP: 0,
      nextE: 0
    };
    G.addPoint = (p, props = {}) => {
      const pid = `p${++G.nextP}`;
      G.points.set(pid, { pid, p: p.slice(), shape: false, mid: false, members: null, ...props });
      G.inc.set(pid, new Set());
      return pid;
    };
    G.resolve = (pid) => {
      while (G.alias.has(pid)) pid = G.alias.get(pid);
      return pid;
    };
    G.addEdge = (u, v, pts, ways, src, rawA, rawB) => {
      if (pts.length < 2) return null;
      const out = pts.map((q) => q.slice());
      out[0] = G.points.get(u).p.slice();
      out[out.length - 1] = G.points.get(v).p.slice();
      const eid = ++G.nextE;
      G.edges.set(eid, {
        eid,
        u,
        v,
        pts: out,
        ways: new Set(ways),
        src: Number.isFinite(src) ? src : lenXY(out),
        rawA: rawA ? rawA.slice() : out[0].slice(),
        rawB: rawB ? rawB.slice() : out[out.length - 1].slice()
      });
      G.inc.get(u).add(eid);
      G.inc.get(v).add(eid);
      return eid;
    };
    G.removeEdge = (eid) => {
      const e = G.edges.get(eid);
      if (!e) return null;
      G.edges.delete(eid);
      if (G.inc.has(e.u)) G.inc.get(e.u).delete(eid);
      if (G.inc.has(e.v)) G.inc.get(e.v).delete(eid);
      return e;
    };
    G.removePoint = (pid) => {
      for (const eid of Array.from(G.inc.get(pid) || [])) G.removeEdge(eid);
      G.points.delete(pid);
      G.inc.delete(pid);
    };
    G.degree = (pid) => (G.inc.get(pid) ? G.inc.get(pid).size : 0);
    // Move point pid to p; its roads keep their course with the end moved
    G.movePoint = (pid, p) => {
      G.points.get(pid).p = p.slice();
      for (const eid of G.inc.get(pid)) {
        const e = G.edges.get(eid);
        if (e.u === pid) e.pts[0] = p.slice();
        if (e.v === pid) e.pts[e.pts.length - 1] = p.slice();
      }
    };
    // Merge points a and b into a new point at p
    G.mergePoints = (a, b, p) => {
      a = G.resolve(a);
      b = G.resolve(b);
      if (a === b) return a;
      const pa = G.points.get(a);
      const pb = G.points.get(b);
      const members = (pa.members || [pa.p]).concat(pb.members || [pb.p]);
      const r = G.addPoint(p, { members, real: pa.real || pb.real, pin: pa.pin || pb.pin });
      for (const old of [a, b]) {
        for (const eid of Array.from(G.inc.get(old))) {
          const e = G.edges.get(eid);
          if (e.u === old) e.u = r;
          if (e.v === old) e.v = r;
          G.inc.get(r).add(eid);
        }
        G.inc.get(old).clear();
        G.points.delete(old);
        G.inc.delete(old);
        G.alias.set(old, r);
      }
      G.movePoint(r, p);
      return r;
    };
    // Split edge e at the arc lengths `at` (ascending, strictly inside); returns the new pids
    G.splitEdge = (eid, at, props) => {
      const e = G.edges.get(eid);
      const cum = cumXY(e.pts);
      const L = cum[cum.length - 1];
      const pids = at.map((s) => G.addPoint(atXY(e.pts, cum, s), props));
      G.removeEdge(eid);
      const cuts = [0].concat(at, [L]);
      const ends = [e.u].concat(pids, [e.v]);
      for (let k = 1; k < cuts.length; k++) {
        const piece = subXY(e.pts, cum, cuts[k - 1], cuts[k]);
        const frac = L > 0 ? (cuts[k] - cuts[k - 1]) / L : 0;
        G.addEdge(ends[k - 1], ends[k], piece, e.ways, e.src * frac,
          k === 1 ? e.rawA : piece[0], k === cuts.length - 1 ? e.rawB : piece[piece.length - 1]);
      }
      return pids;
    };
    return G;
  }

  function newCoverage() {
    return { totalM: 0, keptM: 0, mergedM: 0, tailM: 0, areaM: 0, leavingM: 0, droppedM: { deadEnd: 0, smallComponent: 0, smallLoop: 0, outsideRing: 0 } };
  }

  // Edges whose segments run within PARALLEL_WITHIN_M of each other in nearly the same
  // direction over some length (grid of segments; the exact test follows).
  function* parallelCandidates(G) {
    const CELL = 25;
    const half = PARALLEL_WITHIN_M / 2;
    const cells = new Map();
    const segs = [];
    for (const e of G.edges.values()) {
      if (e.u === e.v) continue;
      for (let i = 1; i < e.pts.length; i++) {
        const a = e.pts[i - 1];
        const b = e.pts[i];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 1e-6) continue;
        const sidx = segs.length;
        segs.push({ eid: e.eid, a, b, len, dx: (b[0] - a[0]) / len, dy: (b[1] - a[1]) / len });
        const x0 = Math.floor((Math.min(a[0], b[0]) - half) / CELL);
        const x1 = Math.floor((Math.max(a[0], b[0]) + half) / CELL);
        const y0 = Math.floor((Math.min(a[1], b[1]) - half) / CELL);
        const y1 = Math.floor((Math.max(a[1], b[1]) + half) / CELL);
        for (let cx = x0; cx <= x1; cx++) {
          for (let cy = y0; cy <= y1; cy++) {
            const k = `${cx},${cy}`;
            if (!cells.has(k)) cells.set(k, []);
            cells.get(k).push(sidx);
          }
        }
      }
    }
    const seenSeg = new Set();
    const score = new Map();
    let checks = 0;
    for (const list of cells.values()) {
      yield;
      for (let i = 0; i < list.length; i++) {
        const si = segs[list[i]];
        for (let j = i + 1; j < list.length; j++) {
          const sj = segs[list[j]];
          if (si.eid === sj.eid) continue;
          if (Math.abs(si.dx * sj.dx + si.dy * sj.dy) < PARALLEL_COS) continue;
          const sk = list[i] < list[j] ? `${list[i]}/${list[j]}` : `${list[j]}/${list[i]}`;
          if (seenSeg.has(sk)) continue;
          seenSeg.add(sk);
          if (++checks > PARALLEL_MAX_PAIRS * 20) throw new StreetGoError('too-many', '道路が多すぎます。範囲を狭めてください');
          if (segSegDistXY(si.a, si.b, sj.a, sj.b) >= PARALLEL_WITHIN_M) continue;
          const [ea, eb] = si.eid < sj.eid ? [si.eid, sj.eid] : [sj.eid, si.eid];
          const pk = `${ea}|${eb}`;
          score.set(pk, (score.get(pk) || 0) + Math.min(si.len, sj.len));
        }
      }
    }
    const pairs = [];
    for (const [pk, s] of score) {
      if (s < COINCIDENT_MIN_RUN_M) continue;
      const [a, b] = pk.split('|').map(Number);
      pairs.push([a, b]);
    }
    if (pairs.length > PARALLEL_MAX_PAIRS) throw new StreetGoError('too-many', '道路が多すぎます。範囲を狭めてください');
    pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    return pairs;
  }

  // The longest stretch over which edges A and B run together, or null.
  // Returns arc lengths on both: { S, O, s0, s1, o0, o1 } (S is the shorter edge).
  function findParallelRun(G, A, B) {
    const [S, O] = lenXY(A.pts) <= lenXY(B.pts) ? [A, B] : [B, A];
    const cs = cumXY(S.pts);
    const cO = cumXY(O.pts);
    const Ls = cs[cs.length - 1];
    if (Ls < COINCIDENT_MIN_RUN_M) return null;
    const shared = [];
    for (const x of [S.u, S.v]) if (x === O.u || x === O.v) shared.push(G.points.get(x).p);
    const n = Math.max(1, Math.ceil(Ls / 2));
    const step = Ls / n;
    const close = new Array(n);
    const counts = new Array(n);
    const same = new Array(n);
    const oAt = new Array(n);
    // The matching place on O is followed along the run (it moves at most a few metres per
    // sample), so a run never jumps to another part of O that passes nearby (a U-turn).
    const window = 2 * step + 3;
    let oPrev = null;
    let misses = 0;
    for (let k = 0; k < n; k++) {
      const s = (k + 0.5) * step;
      const p = atXY(S.pts, cs, s);
      const near = oPrev === null ? nearestXY(O.pts, cO, p) : nearestXYRange(O.pts, cO, p, oPrev - window, oPrev + window);
      const dir = dirAtXY(S.pts, cs, s);
      close[k] = near.d < PARALLEL_WITHIN_M && Math.abs(dir[0] * near.dir[0] + dir[1] * near.dir[1]) >= PARALLEL_COS;
      same[k] = close[k] && near.d < COINCIDENT_M;
      counts[k] = close[k] && !shared.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < PARALLEL_SHARED_M);
      oAt[k] = near.s;
      if (close[k]) {
        oPrev = near.s;
        misses = 0;
      } else if (oPrev !== null && ++misses > 1) {
        oPrev = null;
      }
    }
    let best = null;
    let k = 0;
    while (k < n) {
      if (!close[k]) {
        k++;
        continue;
      }
      let end = k;
      let eff = 0;
      let co = 0;
      let j = k;
      while (j < n) {
        if (close[j]) {
          end = j;
          if (counts[j]) eff += step;
          if (same[j]) co += step;
          j++;
        } else if (j + 1 < n && close[j + 1]) {
          j++; // a single sample apart: same run
        } else break;
      }
      const s0 = k * step;
      const s1 = (end + 1) * step;
      const score = Math.max(eff, co >= COINCIDENT_MIN_RUN_M ? co : 0);
      if ((eff >= PARALLEL_MIN_RUN_M || co >= COINCIDENT_MIN_RUN_M) && (!best || score > best.eff)) {
        // ends of the run on O: the followed places, half a sample further out
        const sgn = oAt[end] >= oAt[k] ? 1 : -1;
        const LO = cO[cO.length - 1];
        const o0 = Math.max(0, Math.min(LO, oAt[k] - (sgn * step) / 2));
        const o1 = Math.max(0, Math.min(LO, oAt[end] + (sgn * step) / 2));
        const need = eff >= PARALLEL_MIN_RUN_M ? PARALLEL_MIN_RUN_M * 0.5 : COINCIDENT_MIN_RUN_M * 0.8;
        if (Math.abs(o1 - o0) >= need) best = { S, O, s0, s1, o0, o1, eff: score, coincidentOnly: eff < PARALLEL_MIN_RUN_M };
      }
      k = end + 1;
    }
    return best;
  }

  // Replace the stretch where two roads run together with one centre line. The ends of the
  // stretch become one point each (an existing end point, or a new point where the roads
  // part); the parts before and after keep their own course and links.
  function applyParallelRun(G, run, F, cov, r) {
    const snap = Math.max(PARALLEL_END_SNAP_M, r || 0);
    let A = run.S;
    let B = run.O;
    let a0 = run.s0;
    let a1 = run.s1;
    let b0 = run.o0;
    let b1 = run.o1;
    const LA = lenXY(A.pts);
    const LB = lenXY(B.pts);
    let bView = { u: B.u, v: B.v, pts: B.pts, rawA: B.rawA, rawB: B.rawB };
    if (b0 > b1) {
      bView = { u: B.v, v: B.u, pts: B.pts.slice().reverse(), rawA: B.rawB, rawB: B.rawA };
      b0 = LB - b0;
      b1 = LB - b1;
    }
    // where the two roads start / stop running together (before snapping to an end point)
    const runAt = [[a0, b0], [a1, b1]];
    if (a0 <= snap) a0 = 0;
    if (LA - a1 <= snap) a1 = LA;
    if (b0 <= snap) b0 = 0;
    if (LB - b1 <= snap) b1 = LB;
    if (a1 - a0 < 1 || b1 - b0 < 1) return false;
    // Two lines on top of each other from a shared point (the roads of one merged junction
    // reaching it along the same short road inside it) are left as they are: a new point where
    // they part would undo the merge.
    if (run.coincidentOnly && (a0 === 0 || a1 === LA) && (b0 === 0 || b1 === LB)) {
      const sharedEnd = (a0 === 0 && b0 === 0 && A.u === bView.u) || (a1 === LA && b1 === LB && A.v === bView.v);
      const otherEndApart = !(a0 === 0 && b0 === 0 && a1 === LA && b1 === LB);
      if (sharedEnd && otherEndApart) return false;
    }
    const ca = cumXY(A.pts);
    const cb = cumXY(bView.pts);
    // Which of the two roads the merged line follows (the same side all along a street): the
    // road whose end points stay (an end point of only one road at a stretch end), else the
    // one already merged before (more ways), else the longer one.
    let votesA = 0;
    let votesB = 0;
    for (const side of [0, 1]) {
      const aNode = side === 0 ? a0 === 0 : a1 === LA;
      const bNode = side === 0 ? b0 === 0 : b1 === LB;
      if (aNode && !bNode) votesA++;
      if (bNode && !aNode) votesB++;
    }
    // (last: the shorter one, which has no detour to a merged point)
    const keepA = votesA !== votesB ? votesA > votesB : A.ways.size !== B.ways.size ? A.ways.size > B.ways.size : LA <= LB;
    if (G.streetWays) G.streetWays.push(new Set([...A.ways, ...B.ways]));
    // Two end points that become one keep the place of one of them (a real junction, not a
    // point between): the one with more roads, then the kept road's
    const keepOneOf = (x, y) => {
      const px = G.points.get(x);
      const py = G.points.get(y);
      const dx = G.degree(x);
      const dy = G.degree(y);
      if (dx !== dy) return (dx > dy ? px : py).p.slice();
      return (keepA ? px : py).p.slice();
    };
    // Moving a point takes the ends of its other roads along: a move that would take one of
    // them more than MOVE_MAX_DEV_M off its course is not made (two end points that would
    // have to merge: the stretch is left as it is; one end point: it stays where it is)
    const otherRoadsOk = (pid, q) => {
      for (const eid of G.inc.get(pid)) {
        if (eid === A.eid || eid === B.eid) continue;
        const e = G.edges.get(eid);
        if (e.u === e.v) continue;
        const replaced = e.pts.slice();
        replaced[e.u === pid ? 0 : replaced.length - 1] = q;
        // measured from the roads themselves (the input data), so a line moved along its street
        // (over a short road merged into the point) is fine
        if (G.offRoad && G.maxOffRoad(replaced) > MOVE_MAX_DEV_M) return false;
      }
      return true;
    };
    // The same check for the pieces before / after the stretch, which end at the new point
    const pieceOk = (pts, atEnd, q) => {
      if (!G.maxOffRoad) return true;
      const out = pts.slice();
      out[atEnd ? out.length - 1 : 0] = q;
      return G.maxOffRoad(out) <= MOVE_MAX_DEV_M;
    };
    for (const side of [0, 1]) {
      const aAt = side === 0 ? a0 : a1;
      const bAt = side === 0 ? b0 : b1;
      const aNode = side === 0 ? aAt === 0 : aAt === LA;
      const bNode = side === 0 ? bAt === 0 : bAt === LB;
      const aPart = aNode ? null : side === 0 ? subXY(A.pts, ca, 0, aAt) : subXY(A.pts, ca, aAt, LA);
      const bPart = bNode ? null : side === 0 ? subXY(bView.pts, cb, 0, bAt) : subXY(bView.pts, cb, bAt, LB);
      const atEnd = side === 0; // the piece before the stretch ends at the new point
      if (aNode && bNode) {
        const x = G.resolve(side === 0 ? A.u : A.v);
        const y = G.resolve(side === 0 ? bView.u : bView.v);
        if (x === y) continue;
        const q = keepOneOf(x, y);
        if (!otherRoadsOk(x, q) || !otherRoadsOk(y, q)) return false;
      } else if (aNode || bNode) {
        // the passing road's piece goes to the end point (where it is, or on the centre line)
        const P = G.points.get(G.resolve(aNode ? (side === 0 ? A.u : A.v) : (side === 0 ? bView.u : bView.v)));
        const part = aNode ? bPart : aPart;
        const [ra, rb] = runAt[side];
        const pa0 = atXY(A.pts, ca, ra);
        const pb0 = atXY(bView.pts, cb, rb);
        let q = [(pa0[0] + pb0[0]) / 2, (pa0[1] + pb0[1]) / 2];
        if (P.real || !otherRoadsOk(P.pid, q)) q = P.p;
        if (!pieceOk(part, atEnd, q)) return false;
      } else {
        const pa = atXY(A.pts, ca, aAt);
        const pb = atXY(bView.pts, cb, bAt);
        const q = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
        if (Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) > 1.5 * PARALLEL_WITHIN_M) return false;
        if (!pieceOk(aPart, atEnd, q) || !pieceOk(bPart, atEnd, q)) return false;
      }
    }
    const ways = new Set([...A.ways, ...B.ways]);
    G.removeEdge(A.eid);
    G.removeEdge(B.eid);
    const touched = new Set();
    const piece = (from, to, pts, srcEdge, frac, raw) => {
      const f = G.resolve(from);
      const t = G.resolve(to);
      if (lenXY(pts) < 0.5 && f === t) return;
      G.addEdge(f, t, pts, srcEdge.ways, srcEdge.src * frac, raw ? raw[0] : null, raw ? raw[1] : null);
    };
    const mergeAt = (x, y) => {
      x = G.resolve(x);
      y = G.resolve(y);
      if (x === y) return x;
      const merged = G.mergePoints(x, y, keepOneOf(x, y));
      touched.add(merged);
      return merged;
    };
    // one end of the stretch: side 0 = start, 1 = end
    const joinEnd = (side) => {
      const aAt = side === 0 ? a0 : a1;
      const bAt = side === 0 ? b0 : b1;
      const aNode = side === 0 ? aAt === 0 : aAt === LA;
      const bNode = side === 0 ? bAt === 0 : bAt === LB;
      const aEnd = side === 0 ? A.u : A.v;
      const bEnd = side === 0 ? bView.u : bView.v;
      const aPart = side === 0 ? (aNode ? null : subXY(A.pts, ca, 0, aAt)) : (aNode ? null : subXY(A.pts, ca, aAt, LA));
      const bPart = side === 0 ? (bNode ? null : subXY(bView.pts, cb, 0, bAt)) : (bNode ? null : subXY(bView.pts, cb, bAt, LB));
      const aFrac = side === 0 ? aAt / LA : (LA - aAt) / LA;
      const bFrac = side === 0 ? bAt / LB : (LB - bAt) / LB;
      const rawA = side === 0 ? [A.rawA, null] : [null, A.rawB];
      const rawB = side === 0 ? [bView.rawA, null] : [null, bView.rawB];
      const link = (endPid, P, part, srcEdge, frac, raw) => {
        if (side === 0) piece(endPid, P, part, srcEdge, frac, raw);
        else piece(P, endPid, part, srcEdge, frac, raw);
      };
      if (aNode && bNode) return mergeAt(aEnd, bEnd);
      // One road ends here at a point, the other passes by: the point moves onto the centre
      // line where the two roads start (stop) running together, and the passing road joins it.
      const [ra, rb] = runAt[side];
      const pa0 = atXY(A.pts, ca, ra);
      const pb0 = atXY(bView.pts, cb, rb);
      // (a real junction stays where it is; the centre line comes to it)
      const meetAt = (P) => {
        const pt = G.points.get(P);
        if (!pt.real) {
          const p = [(pa0[0] + pb0[0]) / 2, (pa0[1] + pb0[1]) / 2];
          if (otherRoadsOk(P, p)) G.movePoint(P, p);
        }
        touched.add(P);
        return P;
      };
      if (aNode) {
        const P = G.resolve(aEnd);
        link(bEnd, P, bPart, B, bFrac, rawB);
        return meetAt(P);
      }
      if (bNode) {
        const P = G.resolve(bEnd);
        link(aEnd, P, aPart, A, aFrac, rawA);
        return meetAt(P);
      }
      const pa = atXY(A.pts, ca, aAt);
      const pb = atXY(bView.pts, cb, bAt);
      const P = G.addPoint([(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2]); // where the roads part (a new point, between them)
      link(aEnd, P, aPart, A, aFrac, rawA);
      link(bEnd, P, bPart, B, bFrac, rawB);
      touched.add(P);
      return P;
    };
    const P0 = joinEnd(0);
    const P1 = G.resolve(joinEnd(1));
    const Q0 = G.resolve(P0);
    // The two roads become one line: the course of the road both end points lie on (they stay
    // on real junctions), else the line between the two
    const subA = subXY(A.pts, ca, a0, a1);
    const subB = subXY(bView.pts, cb, b0, b1);
    const q0 = G.points.get(Q0).p;
    const q1 = G.points.get(P1).p;
    const offA = Math.hypot(q0[0] - subA[0][0], q0[1] - subA[0][1]) + Math.hypot(q1[0] - subA[subA.length - 1][0], q1[1] - subA[subA.length - 1][1]);
    const offB = Math.hypot(q0[0] - subB[0][0], q0[1] - subB[0][1]) + Math.hypot(q1[0] - subB[subB.length - 1][0], q1[1] - subB[subB.length - 1][1]);
    const center = Math.min(offA, offB) < 2 ? (offA <= offB ? subA : subB) : simplifyXY(averageXY(subA, subB), 0.5);
    const src = A.src * ((a1 - a0) / LA) + B.src * ((b1 - b0) / LB);
    const eid = G.addEdge(Q0, P1, center, ways, src);
    if (eid !== null) {
      const len = lenXY(G.edges.get(eid).pts);
      cov.mergedM += Math.max(0, src - len);
      G.edges.get(eid).src = len;
    }
    return touched;
  }

  // True if one of the points `from` reaches one of `to` along the roads within `limit` m
  function linkedWithin(G, from, to, limit) {
    const goal = new Set(to.map((x) => G.resolve(x)));
    const dist = new Map();
    const queue = [];
    for (const x of from) {
      const id = G.resolve(x);
      if (goal.has(id)) return true;
      dist.set(id, 0);
      queue.push([0, id]);
    }
    const done = new Set();
    while (queue.length > 0) {
      let bi = 0;
      for (let i = 1; i < queue.length; i++) if (queue[i][0] < queue[bi][0]) bi = i;
      const [d, cur] = queue[bi];
      queue[bi] = queue[queue.length - 1];
      queue.pop();
      if (done.has(cur)) continue;
      done.add(cur);
      if (goal.has(cur)) return true;
      for (const eid of G.inc.get(cur) || []) {
        const e = G.edges.get(eid);
        const o = e.u === cur ? e.v : e.u;
        const nd = d + lenXY(e.pts);
        if (nd > limit || (dist.has(o) && dist.get(o) <= nd)) continue;
        dist.set(o, nd);
        queue.push([nd, o]);
      }
    }
    return false;
  }

  // Roads that run side by side are merged only if they are already joined near each other
  // (a road links them within PARALLEL_LINK_M + 2 r): two carriageways of one street. A
  // road over another (a viaduct above a street) has no such link and both stay.
  function* mergeParallelRoads(G, F, cov, r) {
    let merges = 0;
    const rejectedPairs = new Set();
    for (let pass = 0; pass < 60; pass++) {
      const pairs = yield* parallelCandidates(G);
      const busy = new Set();
      let changed = false;
      for (const [ea, eb] of pairs) {
        yield;
        if (busy.has(ea) || busy.has(eb) || rejectedPairs.has(`${ea}|${eb}`)) continue;
        const A = G.edges.get(ea);
        const B = G.edges.get(eb);
        if (!A || !B || A.u === A.v || B.u === B.v) continue;
        const run = findParallelRun(G, A, B);
        if (!run) continue;
        if (!linkedWithin(G, [A.u, A.v], [B.u, B.v], PARALLEL_LINK_M + 2 * (r || 0))) continue;
        const touched = applyParallelRun(G, run, F, cov, r);
        if (!touched) {
          rejectedPairs.add(`${ea}|${eb}`);
          continue;
        }
        changed = true;
        busy.add(ea);
        busy.add(eb);
        for (const pid of touched) for (const eid of G.inc.get(G.resolve(pid)) || []) busy.add(eid);
        if (++merges >= PARALLEL_MAX_MERGES) return merges;
      }
      if (!changed) break;
    }
    return merges;
  }

  // Loops get two shape points (three points around), short loops belong to their point. A
  // loop whose two halves run together (both carriageways of a dead-end street) is one road
  // out to its far end. Roads between the same two points: one that stays close to another
  // everywhere is the same road (one centre line); another route keeps a shape point in its
  // middle.
  function normalizeLoopsAndRoutes(G, F, cov) {
    collapseTinyGaps(G);
    // Removing a loop can turn a point into a pass-through; joining its two roads can make a
    // new loop: repeat until no loop is left (each loop ends as 3+ different points or gone)
    for (let round = 0; round < 20; round++) {
      if (!normalizeLoopsOnce(G, cov)) break;
    }
    normalizeRoutes(G, cov);
  }

  function normalizeLoopsOnce(G, cov) {
    const lostLoop = new Set();
    let any = false;
    for (const e of Array.from(G.edges.values())) {
      if (e.u !== e.v || !G.edges.has(e.eid)) continue;
      any = true;
      const cum = cumXY(e.pts);
      const L = cum[cum.length - 1];
      if (L < LOOP_MIN_M) {
        G.removeEdge(e.eid);
        cov.mergedM += e.src;
        lostLoop.add(e.u);
        continue;
      }
      // A small loop with one way in (a turning loop, a block ring) is left out whole: no
      // shape points, no dead end at its far side
      if (L < SMALL_LOOP_M) {
        G.removeEdge(e.eid);
        cov.droppedM.smallLoop += e.src;
        lostLoop.add(e.u);
        continue;
      }
      const out = subXY(e.pts, cum, 0, L / 2);
      const back = subXY(e.pts, cum, L / 2, L).reverse();
      if (hausdorffXY(out, back) <= DUPLICATE_ROUTE_M) {
        const center = simplifyXY(averageXY(out, back), 0.5);
        const far = G.addPoint(center[center.length - 1]);
        G.removeEdge(e.eid);
        G.addEdge(e.u, far, center, e.ways, lenXY(center), e.rawA, null);
        cov.mergedM += Math.max(0, e.src - lenXY(center));
      } else {
        // the two shape points where the three points (with the loop's own point) are farthest
        // apart (a loop that doubles back near its point would put thirds next to each other)
        const anchor = e.pts[0];
        let bestPair = [L / 3, (2 * L) / 3];
        let bestGap = -1;
        const N = 24;
        for (let i = 2; i < N - 3; i++) {
          for (let j = i + 2; j < N - 1; j++) {
            const s1 = (i * L) / N;
            const s2 = (j * L) / N;
            const p1 = atXY(e.pts, cum, s1);
            const p2 = atXY(e.pts, cum, s2);
            const gap = Math.min(Math.hypot(p1[0] - anchor[0], p1[1] - anchor[1]), Math.hypot(p2[0] - anchor[0], p2[1] - anchor[1]), Math.hypot(p1[0] - p2[0], p1[1] - p2[1]));
            if (gap > bestGap + 1e-9) {
              bestGap = gap;
              bestPair = [s1, s2];
            }
          }
        }
        G.splitEdge(e.eid, bestPair, { shape: true });
      }
    }
    // A point left with two roads by a removed loop is no junction any more: one road
    for (const pid of lostLoop) contractPassThrough(G, pid);
    return any;
  }

  function normalizeRoutes(G, cov) {
    const groups = new Map();
    for (const e of G.edges.values()) {
      const k = cmpKey(e.u, e.v) < 0 ? `${e.u}|${e.v}` : `${e.v}|${e.u}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e.eid);
    }
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const es = list.map((id) => G.edges.get(id)).sort((x, y) => lenXY(x.pts) - lenXY(y.pts) || x.eid - y.eid);
      const keep = es[0];
      for (const e of es.slice(1)) {
        const pts = e.u === keep.u ? e.pts : e.pts.slice().reverse();
        const lk = lenXY(keep.pts);
        const le = lenXY(pts);
        const duplicate = hausdorffXY(pts, keep.pts) <= DUPLICATE_ROUTE_M;
        if (!duplicate && (lk + le < SMALL_ROUTES_M || (lk < SHORT_ROUTE_M && le < SHORT_ROUTE_M))) {
          // two short routes: the shorter one stays (the other cannot cut the board in two)
          G.removeEdge(e.eid);
          cov.droppedM.smallLoop += e.src;
          continue;
        }
        if (duplicate) {
          const before = keep.src + e.src;
          const center = simplifyXY(averageXY(keep.pts, pts), 0.5);
          center[0] = keep.pts[0];
          center[center.length - 1] = keep.pts[keep.pts.length - 1];
          keep.pts = center;
          for (const w of e.ways) keep.ways.add(w);
          G.removeEdge(e.eid);
          const len = lenXY(center);
          cov.mergedM += Math.max(0, before - len);
          keep.src = len;
        } else {
          // the shape point goes where this route is farthest from the kept one
          const ce = cumXY(pts);
          const ck = cumXY(keep.pts);
          const L = ce[ce.length - 1];
          let bestS = L / 2;
          let bestD = -1;
          // (and away from every other point: routes sharing their first metres from one
          // point would otherwise get shape points next to each other)
          const nearestPoint = (q) => {
            let m = Infinity;
            for (const pt of G.points.values()) m = Math.min(m, Math.hypot(pt.p[0] - q[0], pt.p[1] - q[1]));
            return m;
          };
          for (let k = 1; k < 20; k++) {
            const sv = (k * L) / 20;
            if (sv < 0.2 * L || sv > 0.8 * L) continue;
            const q = atXY(pts, ce, sv);
            const d = Math.min(nearestXY(keep.pts, ck, q).d, nearestPoint(q));
            if (d > bestD + 1e-9) {
              bestD = d;
              bestS = sv;
            }
          }
          G.splitEdge(e.eid, [e.u === keep.u ? bestS : L - bestS], { shape: true });
        }
      }
    }
  }

  // A point with exactly two roads that is neither pinned (a junction that lost roads at the
  // frame) nor a shape / mid point (a junction whose third road was removed): its two roads
  // become one road.
  function contractPassThrough(G, pid) {
    const pt = G.points.get(pid);
    if (!pt || pt.pin || pt.shape || pt.mid || G.degree(pid) !== 2) return false;
    const [e1, e2] = Array.from(G.inc.get(pid)).map((id) => G.edges.get(id));
    if (!e1 || !e2 || e1 === e2) return false;
    const a = e1.u === pid ? e1.pts.slice().reverse() : e1.pts.slice(); // ... -> pid
    const b = e2.u === pid ? e2.pts.slice() : e2.pts.slice().reverse(); // pid -> ...
    const x = e1.u === pid ? e1.v : e1.u;
    const y = e2.u === pid ? e2.v : e2.u;
    if (x === pid || y === pid) return false;
    const ways = new Set([...e1.ways, ...e2.ways]);
    const src = e1.src + e2.src;
    const rawX = e1.u === pid ? e1.rawB : e1.rawA;
    const rawY = e2.u === pid ? e2.rawB : e2.rawA;
    G.removePoint(pid);
    G.addEdge(x, y, a.concat(b.slice(1)), ways, src, rawX, rawY);
    return true;
  }

  // Two dead ends close together that face each other along one line are the same street,
  // cut by a short piece the road filter leaves out (an arcade with covered=yes, a gate):
  // they are joined by a straight road and are no points any more.
  function joinFacingDeadEnds(G) {
    const cosMax = Math.cos((FACING_MAX_DEG * Math.PI) / 180);
    const ends = [];
    for (const pt of G.points.values()) {
      if (pt.pin || pt.shape || pt.mid || G.degree(pt.pid) !== 1) continue; // (a pinned junction is no dead end)
      const e = G.edges.get(Array.from(G.inc.get(pt.pid))[0]);
      if (e.u === e.v) continue;
      const pts = e.v === pt.pid ? e.pts : e.pts.slice().reverse(); // ... -> the dead end
      const cum = cumXY(pts);
      const L = cum[cum.length - 1];
      if (L <= 0) continue;
      const back = atXY(pts, cum, Math.max(0, L - 10));
      const dx = pt.p[0] - back[0];
      const dy = pt.p[1] - back[1];
      const dl = Math.hypot(dx, dy);
      if (dl < 1e-6) continue;
      ends.push({ pid: pt.pid, p: pt.p, dir: [dx / dl, dy / dl], eid: e.eid });
    }
    const pairs = [];
    for (let i = 0; i < ends.length; i++) {
      for (let j = i + 1; j < ends.length; j++) {
        const a = ends[i];
        const b = ends[j];
        if (a.eid === b.eid) continue;
        const vx = b.p[0] - a.p[0];
        const vy = b.p[1] - a.p[1];
        const d = Math.hypot(vx, vy);
        if (d > FACING_MAX_M || d < 1e-6) continue;
        const u = [vx / d, vy / d];
        if (a.dir[0] * u[0] + a.dir[1] * u[1] < cosMax) continue; // a heads towards b
        if (-(b.dir[0] * u[0] + b.dir[1] * u[1]) < cosMax) continue; // b heads towards a
        if (-(a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1]) < cosMax) continue; // on one line
        pairs.push([d, a, b]);
      }
    }
    pairs.sort((x, y) => x[0] - y[0] || cmpKey(x[1].pid, y[1].pid) || cmpKey(x[2].pid, y[2].pid));
    const used = new Set();
    let joined = 0;
    for (const [, a, b] of pairs) {
      if (used.has(a.pid) || used.has(b.pid) || !G.edges.has(a.eid) || !G.edges.has(b.eid)) continue;
      used.add(a.pid);
      used.add(b.pid);
      const ea = G.edges.get(a.eid);
      const eb = G.edges.get(b.eid);
      const pa = ea.v === a.pid ? ea.pts : ea.pts.slice().reverse(); // x -> a
      const pb = eb.u === b.pid ? eb.pts : eb.pts.slice().reverse(); // b -> y
      const x = ea.v === a.pid ? ea.u : ea.v;
      const y = eb.u === b.pid ? eb.v : eb.u;
      const rawX = ea.v === a.pid ? ea.rawA : ea.rawB;
      const rawY = eb.u === b.pid ? eb.rawB : eb.rawA;
      const ways = new Set([...ea.ways, ...eb.ways]);
      const src = ea.src + eb.src;
      G.removePoint(a.pid);
      G.removePoint(b.pid);
      G.addEdge(x, y, pa.concat(pb), ways, src, rawX, rawY);
      joined++;
    }
    return joined;
  }

  // A dead-end branch shorter than SHORT_SPUR_M has no point at its end: its stone would sit
  // on top of the junction's. The branch is drawn from the junction (`tails`, not playable).
  function dropShortSpurs(G, cov) {
    const drop = [];
    for (const pt of G.points.values()) {
      if (pt.pin || pt.shape || pt.mid || G.degree(pt.pid) !== 1) continue; // (a pinned junction stays)
      const e = G.edges.get(Array.from(G.inc.get(pt.pid))[0]);
      const inner = e.u === pt.pid ? e.v : e.u;
      if (inner === pt.pid || lenXY(e.pts) >= SHORT_SPUR_M) continue;
      const ip = G.points.get(inner);
      if (!ip || G.degree(inner) === 1) continue; // a 2-point road: not a branch
      drop.push([pt.pid, e.eid, inner]);
    }
    for (const [pid, eid, inner] of drop) {
      const e = G.edges.get(eid);
      if (!e || !G.points.has(inner)) continue;
      const pts = e.u === inner ? e.pts : e.pts.slice().reverse(); // inner -> dead end
      G.tails.push({ pid: inner, pts, ways: new Set(e.ways), to: 'deadEnd' });
      cov.tailM += e.src;
      G.removePoint(pid);
      G.points.get(inner).stub = true;
    }
    return drop.length;
  }

  // Way ids merged as one street (two carriageways): sameStreet(waysA, waysB) is true when the
  // two lines belong to one such street.
  function makeSameStreet(sets) {
    const parent = new Map();
    const find = (x) => {
      while (parent.has(x) && parent.get(x) !== x) x = parent.get(x);
      return x;
    };
    for (const set of sets) {
      const list = Array.from(set);
      for (const w of list) if (!parent.has(w)) parent.set(w, w);
      for (let i = 1; i < list.length; i++) {
        const a = find(list[0]);
        const b = find(list[i]);
        if (a !== b) parent.set(b, a);
      }
    }
    const groupOf = (ways) => {
      const gs = new Set();
      for (const w of ways) if (parent.has(w)) gs.add(find(w));
      return gs;
    };
    return (wa, wb) => {
      const ga = groupOf(wa);
      if (ga.size === 0) return false;
      for (const g of groupOf(wb)) if (ga.has(g)) return true;
      return false;
    };
  }

  // After two carriageways were merged into one line, what is left of the other carriageway
  // (a short stretch not merged, a short branch) is not drawn when it runs within
  // DUPLICATE_ROUTE_M of the street's line: the street stays on one side, without switching.
  // Only roads with an end of their own (a dead end, or a drawn-only piece).
  function dropOtherCarriageway(G, sameStreet, cov) {
    const lines = [];
    for (const e of G.edges.values()) lines.push({ kind: 'edge', e, pts: e.pts, ways: e.ways, len: lenXY(e.pts) });
    for (const t of G.tails) lines.push({ kind: 'tail', t, pts: t.pts, ways: t.ways, len: lenXY(t.pts) });
    const alongside = (x, y) => {
      const cum = cumXY(x.pts);
      const cy = cumXY(y.pts);
      const n = Math.max(2, Math.ceil(x.len / 2));
      let near = 0;
      const Ly = cy[cy.length - 1];
      for (let k = 0; k <= n; k++) {
        const hit = nearestXY(y.pts, cy, atXY(x.pts, cum, (k * x.len) / n));
        // beside the line, not beyond its end (a line going on from its end is no remainder)
        if (hit.d <= DUPLICATE_ROUTE_M && hit.s > 1 && hit.s < Ly - 1) near++;
      }
      return near >= 0.5 * (n + 1);
    };
    // (an end that is a junction left with one road by the frame is no loose end: it stays)
    const loose = (l) => {
      if (l.kind === 'tail') return true;
      const du = G.degree(l.e.u) === 1 && !G.points.get(l.e.u).pin;
      const dv = G.degree(l.e.v) === 1 && !G.points.get(l.e.v).pin;
      return du !== dv && !(G.degree(l.e.u) === 1 && G.degree(l.e.v) === 1);
    };
    let dropped = 0;
    const gone = new Set();
    // a loose line goes when it runs alongside a longer line of the street that is no loose
    // end (the street's own line), or alongside a shorter loose one (the one without a detour
    // stays)
    lines.forEach((l, i) => { l.order = i; });
    lines.sort((x, y) => y.len - x.len || x.order - y.order);
    for (const x of lines) {
      if (!loose(x) || gone.has(x)) continue;
      const other = lines.find((y) => y !== x && !gone.has(y) && sameStreet(x.ways, y.ways) &&
        (loose(y) ? y.len < x.len || (y.len === x.len && y.order < x.order) : y.len > x.len) && alongside(x, y));
      if (!other) continue;
      gone.add(x);
      dropped++;
      cov.mergedM += x.kind === 'edge' ? x.e.src : 0;
      if (x.kind === 'tail') {
        G.tails = G.tails.filter((t) => t !== x.t);
      } else {
        const end = G.degree(x.e.u) === 1 && !G.points.get(x.e.u).pin ? x.e.u : x.e.v;
        G.removePoint(end);
      }
    }
    return dropped;
  }

  // Turn the point pid (one road) into a drawn-only piece from the point its road leads to.
  // Pieces already drawn from pid are joined on. Returns false if not allowed: a road on its
  // own (2 points), or a piece of TAIL_MAX_M or more.
  function pointToTail(G, pid) {
    const pt = G.points.get(pid);
    if (!pt || G.degree(pid) !== 1) return false;
    const e = G.edges.get(Array.from(G.inc.get(pid))[0]);
    const inner = e.u === pid ? e.v : e.u;
    if (inner === pid || G.degree(inner) === 1) return false;
    const pts = e.u === inner ? e.pts : e.pts.slice().reverse(); // inner -> pid
    const own = G.tails.filter((t) => t.pid === pid);
    const extra = own.length ? Math.max(...own.map((t) => lenXY(t.pts))) : 0;
    if (lenXY(pts) + extra >= TAIL_MAX_M) return false;
    const ways = new Set(e.ways);
    G.tails = G.tails.filter((t) => t.pid !== pid);
    if (own.length === 0) {
      G.tails.push({ pid: inner, pts, ways });
    } else {
      for (const t of own) G.tails.push({ pid: inner, pts: pts.concat(t.pts.slice(1)), ways: new Set([...ways, ...t.ways]) });
    }
    G.removePoint(pid);
    G.points.get(inner).stub = true;
    return true;
  }

  // Points closer than END_GAP_M that no road joins (two dead ends at a gap that do not face
  // each other, a dead end beside another street's junction ...) are never joined by
  // distance. The one with the shorter road (a dead end, its road under TAIL_MAX_M) gets no
  // point: its road is drawn only; a junction left with one road by the frame only if the
  // other cannot go. Junctions with more roads stay.
  function resolveClosePoints(G) {
    let n = 0;
    for (let pass = 0; pass < 10; pass++) {
      const pts = Array.from(G.points.values());
      const pairs = [];
      const CELL = END_GAP_M;
      const cells = new Map();
      for (const p of pts) {
        const k = `${Math.floor(p.p[0] / CELL)},${Math.floor(p.p[1] / CELL)}`;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(p);
      }
      for (const a of pts) {
        const cx = Math.floor(a.p[0] / CELL);
        const cy = Math.floor(a.p[1] / CELL);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (const b of cells.get(`${cx + dx},${cy + dy}`) || []) {
              if (cmpKey(b.pid, a.pid) <= 0) continue;
              const d = Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]);
              if (d < END_GAP_M) pairs.push([d, a.pid, b.pid]);
            }
          }
        }
      }
      pairs.sort((x, y) => x[0] - y[0] || cmpKey(x[1], y[1]) || cmpKey(x[2], y[2]));
      let changed = false;
      for (const [, x, y] of pairs) {
        if (!G.points.has(x) || !G.points.has(y)) continue;
        const joined = Array.from(G.inc.get(x)).some((eid) => { const e = G.edges.get(eid); return e.u === y || e.v === y; });
        if (joined) continue;
        const branch = (pid) => {
          const pt = G.points.get(pid);
          if (pt.shape || pt.mid || G.degree(pid) !== 1) return Infinity;
          const e = G.edges.get(Array.from(G.inc.get(pid))[0]);
          const inner = e.u === pid ? e.v : e.u;
          if (G.degree(inner) === 1) return Infinity;
          return lenXY(e.pts);
        };
        const pinOf = (pid) => (G.points.get(pid).pin ? 1 : 0);
        const order = [[branch(x), x], [branch(y), y]].sort((p, q) => pinOf(p[1]) - pinOf(q[1]) || p[0] - q[0]);
        for (const [len, pid] of order) {
          if (!Number.isFinite(len)) continue;
          if (pointToTail(G, pid)) {
            n++;
            changed = true;
            break;
          }
        }
      }
      if (!changed) break;
    }
    return n;
  }

  // Two points closer than MIN_POINT_GAP_M cannot both be played (their stones would cover
  // each other). They are one point only when a road already joins them (the two ends of a
  // road of almost no length). Points that no road joins are never joined by distance alone
  // (see resolveClosePoints).
  function collapseTinyGaps(G) {
    const gap = (a, b) => Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]);
    const mergeTwo = (x, y) => {
      const a = G.points.get(x);
      const b = G.points.get(y);
      return G.mergePoints(x, y, [(a.p[0] + b.p[0]) / 2, (a.p[1] + b.p[1]) / 2]);
    };
    for (let pass = 0; pass < 10; pass++) {
      let changed = false;
      for (const e of Array.from(G.edges.values()).sort((x, y) => x.eid - y.eid)) {
        if (!G.edges.has(e.eid) || e.u === e.v) continue;
        if (gap(G.points.get(e.u), G.points.get(e.v)) >= MIN_POINT_GAP_M) continue;
        mergeTwo(e.u, e.v);
        changed = true;
      }
      if (!changed) break;
    }
  }

  // The dead-end setting, decided in this one place. Off: real dead ends are removed branch
  // by branch (a point left with one road is removed next). A junction left with one road by
  // the frame (pinned) is no dead end: it stays.
  function applyDeadEndPolicy(G, includeDeadEnds, cov) {
    if (includeDeadEnds) return 0;
    let removed = 0;
    for (;;) {
      const dead = Array.from(G.points.values()).filter((p) => G.degree(p.pid) === 0 || (G.degree(p.pid) === 1 && !p.pin));
      if (dead.length === 0) break;
      for (const p of dead) {
        for (const eid of Array.from(G.inc.get(p.pid))) cov.droppedM.deadEnd += G.edges.get(eid).src;
        G.removePoint(p.pid);
        removed++;
      }
    }
    return removed;
  }

  // Only the largest connected part stays (most points, then the longest roads); the other
  // parts are left out (counted as smallComponent). Returns the number of parts left out.
  function keepLargestComponent(G, cov) {
    const seen = new Set();
    const comps = [];
    for (const pid of Array.from(G.points.keys()).sort(cmpKey)) {
      if (seen.has(pid)) continue;
      const comp = [pid];
      seen.add(pid);
      let len = 0;
      for (let i = 0; i < comp.length; i++) {
        for (const eid of G.inc.get(comp[i])) {
          const e = G.edges.get(eid);
          if (e.u === comp[i]) len += e.src;
          const o = e.u === comp[i] ? e.v : e.u;
          if (!seen.has(o)) {
            seen.add(o);
            comp.push(o);
          }
        }
      }
      comps.push({ comp, len, first: pid });
    }
    if (comps.length <= 1) return 0;
    comps.sort((a, b) => b.comp.length - a.comp.length || b.len - a.len || cmpKey(a.first, b.first));
    for (const { comp, len } of comps.slice(1)) {
      cov.droppedM.smallComponent += len;
      for (const pid of comp) G.removePoint(pid);
    }
    const left = new Set(G.points.keys());
    G.tails = G.tails.filter((t) => left.has(t.pid));
    return comps.length - 1;
  }

  // The points of the roads that are no dead-end branches (2-core: points with one road are
  // taken off again and again)
  function twoCore(G) {
    const deg = new Map();
    for (const pid of G.points.keys()) deg.set(pid, 0);
    for (const e of G.edges.values()) {
      deg.set(e.u, deg.get(e.u) + 1);
      deg.set(e.v, deg.get(e.v) + 1);
    }
    const core = new Set(G.points.keys());
    const stack = Array.from(core).filter((pid) => deg.get(pid) <= 1);
    while (stack.length) {
      const pid = stack.pop();
      if (!core.has(pid)) continue;
      core.delete(pid);
      for (const eid of G.inc.get(pid)) {
        const e = G.edges.get(eid);
        const o = e.u === pid ? e.v : e.u;
        if (o === pid || !core.has(o)) continue;
        deg.set(o, deg.get(o) - 1);
        if (deg.get(o) <= 1) stack.push(o);
      }
    }
    return core;
  }

  // The board's outline: the outer boundary of the lines of the 2-core, as a polygon
  // [[x, y], ...] (closed: the last point is the first). The lines are made planar first:
  // every segment is split where another one crosses or touches it (roads crossing without a
  // shared point, bridges, and lines lying on top of each other), then the outer face is
  // walked from the westernmost point, always taking the next line clockwise. Null if the
  // core has no line.
  function* outerRingXY(G, core) {
    const segs = [];
    for (const e of G.edges.values()) {
      if (!core.has(e.u) || !core.has(e.v)) continue;
      for (let i = 1; i < e.pts.length; i++) {
        const a = e.pts[i - 1];
        const b = e.pts[i];
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-6) segs.push([a, b]);
      }
    }
    if (segs.length === 0) return null;
    const EPS = 1e-3;
    const cuts = segs.map(() => [0, 1]);
    const CELL = 25;
    const cells = new Map();
    segs.forEach(([a, b], i) => {
      for (let cx = Math.floor(Math.min(a[0], b[0]) / CELL); cx <= Math.floor(Math.max(a[0], b[0]) / CELL); cx++) {
        for (let cy = Math.floor(Math.min(a[1], b[1]) / CELL); cy <= Math.floor(Math.max(a[1], b[1]) / CELL); cy++) {
          const k = `${cx},${cy}`;
          if (!cells.has(k)) cells.set(k, []);
          cells.get(k).push(i);
        }
      }
    });
    // t of point q on segment i if q lies on it (within EPS), else null
    const onSeg = (i, q) => {
      const [a, b] = segs[i];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy;
      const t = ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2;
      if (t <= 0 || t >= 1) return null;
      const px = a[0] + dx * t - q[0];
      const py = a[1] + dy * t - q[1];
      return px * px + py * py <= EPS * EPS ? t : null;
    };
    const done = new Set();
    let work = 0;
    for (const list of cells.values()) {
      work += list.length * list.length;
      if (work > 20000) {
        work = 0;
        yield;
      }
      for (let x = 0; x < list.length; x++) {
        for (let y = x + 1; y < list.length; y++) {
          const i = Math.min(list[x], list[y]);
          const j = Math.max(list[x], list[y]);
          const key = `${i},${j}`;
          if (done.has(key)) continue;
          done.add(key);
          const [p, p2] = segs[i];
          const [q, q2] = segs[j];
          for (const [s, o, pt] of [[i, j, q], [i, j, q2], [j, i, p], [j, i, p2]]) {
            const t = onSeg(s, pt);
            if (t !== null) cuts[s].push(t);
          }
          const rx = p2[0] - p[0];
          const ry = p2[1] - p[1];
          const sx = q2[0] - q[0];
          const sy = q2[1] - q[1];
          const d = rx * sy - ry * sx;
          if (Math.abs(d) < 1e-12) continue;
          const t = ((q[0] - p[0]) * sy - (q[1] - p[1]) * sx) / d;
          const u = ((q[0] - p[0]) * ry - (q[1] - p[1]) * rx) / d;
          if (t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9) {
            cuts[i].push(t);
            cuts[j].push(u);
          }
        }
      }
    }
    const pos = new Map();
    const adj = new Map();
    const keyOf = (pt) => {
      const k = `${Math.round(pt[0] * 100)},${Math.round(pt[1] * 100)}`;
      if (!pos.has(k)) {
        pos.set(k, pt);
        adj.set(k, new Map());
      }
      return k;
    };
    segs.forEach(([a, b], i) => {
      const ts = Array.from(new Set(cuts[i])).sort((x, y) => x - y);
      let prev = keyOf(a);
      for (let n = 1; n < ts.length; n++) {
        const t = ts[n];
        const k = keyOf(t === 1 ? b : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        if (k !== prev) {
          const pa = pos.get(prev);
          const pb = pos.get(k);
          adj.get(prev).set(k, Math.atan2(pb[1] - pa[1], pb[0] - pa[0]));
          adj.get(k).set(prev, Math.atan2(pa[1] - pb[1], pa[0] - pb[0]));
          prev = k;
        }
      }
    });
    yield;
    let start = null;
    for (const [k, p] of pos) {
      if (adj.get(k).size === 0) continue;
      const s = start && pos.get(start);
      if (!s || p[0] < s[0] || (p[0] === s[0] && p[1] < s[1])) start = k;
    }
    if (start === null) return null;
    // the line leaving v next clockwise from the direction `theta` (the one with the largest
    // angle below theta, else the largest one)
    const nextFrom = (v, theta) => {
      let best = null;
      let bestA = -Infinity;
      let top = null;
      let topA = -Infinity;
      for (const [w, a] of adj.get(v)) {
        if (a < theta - 1e-12 && a > bestA) {
          best = w;
          bestA = a;
        }
        if (a > topA || (a === topA && w < top)) {
          top = w;
          topA = a;
        }
      }
      return best !== null ? best : top;
    };
    let halfEdges = 0;
    for (const m of adj.values()) halfEdges += m.size;
    const firstV = nextFrom(start, Math.PI); // (the outside lies west of the westernmost point)
    const poly = [pos.get(start)];
    let u = start;
    let v = firstV;
    for (let guard = 0; guard <= halfEdges; guard++) {
      poly.push(pos.get(v));
      const w = nextFrom(v, adj.get(v).get(u));
      u = v;
      v = w;
      if (u === start && v === firstV) break;
    }
    return poly;
  }

  // Inside the polygon (even-odd), or within tol of its outline
  function makeInsideTest(poly, tol) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of poly) {
      minX = Math.min(minX, p[0]);
      maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1]);
    }
    return (q) => {
      if (q[0] < minX - tol || q[0] > maxX + tol || q[1] < minY - tol || q[1] > maxY + tol) return false;
      let inside = false;
      for (let i = 1; i < poly.length; i++) {
        const a = poly[i - 1];
        const b = poly[i];
        if (pointSegDistXY(q, a, b) <= tol) return true;
        if ((a[1] > q[1]) !== (b[1] > q[1]) && q[0] < a[0] + ((q[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1])) inside = !inside;
      }
      return inside;
    };
  }

  // The board's outline is a ring of roads (the outer boundary of the 2-core). A dead-end
  // branch with any point or line outside it is left out whole (no line drawn); branches
  // inside it (on the outline included) stay. Drawn-only pieces outside it go too.
  // Returns { branches: number left out, ring: polygon or null }.
  function* trimOutsideRing(G, cov) {
    const core = twoCore(G);
    if (core.size === 0) return { branches: 0, ring: null };
    const ring = yield* outerRingXY(G, core);
    if (!ring) return { branches: 0, ring: null };
    const inside = makeInsideTest(ring, RING_TOL_M);
    const lineInside = (pts) => {
      for (let i = 0; i < pts.length; i++) {
        if (!inside(pts[i])) return false;
        if (i === 0) continue;
        const a = pts[i - 1];
        const b = pts[i];
        const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2);
        for (let k = 1; k < n; k++) if (!inside([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n])) return false;
      }
      return true;
    };
    const tailsAt = new Map();
    for (const t of G.tails) {
      if (!tailsAt.has(t.pid)) tailsAt.set(t.pid, []);
      tailsAt.get(t.pid).push(t);
    }
    const dropTails = new Set();
    let branches = 0;
    let done = 0;
    for (const c of Array.from(core).sort(cmpKey)) {
      if (++done % 200 === 0) yield;
      for (const t of tailsAt.get(c) || []) if (!lineInside(t.pts)) dropTails.add(t);
      for (const eid of Array.from(G.inc.get(c)).sort((x, y) => x - y)) {
        const e0 = G.edges.get(eid);
        if (!e0) continue;
        const o0 = e0.u === c ? e0.v : e0.u;
        if (core.has(o0)) continue;
        // the branch: every point reached from o0 without passing c
        const pts = [o0];
        const seen = new Set([c, o0]);
        const edges = [e0];
        for (let i = 0; i < pts.length; i++) {
          for (const id of G.inc.get(pts[i])) {
            const e = G.edges.get(id);
            const o = e.u === pts[i] ? e.v : e.u;
            if (seen.has(o)) continue;
            seen.add(o);
            pts.push(o);
            edges.push(e);
          }
        }
        let ok = edges.every((e) => lineInside(e.pts));
        if (ok) for (const pid of pts) for (const t of tailsAt.get(pid) || []) if (!lineInside(t.pts)) ok = false;
        if (ok) continue;
        branches++;
        for (const e of edges) cov.droppedM.outsideRing += e.src;
        for (const pid of pts) {
          for (const t of tailsAt.get(pid) || []) dropTails.add(t);
          G.removePoint(pid);
        }
      }
    }
    if (dropTails.size) G.tails = G.tails.filter((t) => !dropTails.has(t));
    return { branches, ring };
  }

  function subdivideLong(G, spacing, minGap) {
    const CELL = Math.max(minGap, 1);
    const grid = new Map();
    const key = (p) => `${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)}`;
    const add = (p) => {
      const k = key(p);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(p);
    };
    const tooClose = (p) => {
      const cx = Math.floor(p[0] / CELL);
      const cy = Math.floor(p[1] / CELL);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const q of grid.get(`${cx + dx},${cy + dy}`) || []) if (Math.hypot(p[0] - q[0], p[1] - q[1]) < minGap) return true;
        }
      }
      return false;
    };
    for (const pt of G.points.values()) add(pt.p);
    for (const e of Array.from(G.edges.values()).sort((x, y) => x.eid - y.eid)) {
      const cum = cumXY(e.pts);
      const L = cum[cum.length - 1];
      if (L < spacing * 1.35) continue;
      const n = Math.max(2, Math.round(L / spacing));
      const at = [];
      for (let k = 1; k < n; k++) {
        const s = (k * L) / n;
        const p = atXY(e.pts, cum, s);
        if (tooClose(p)) continue;
        at.push(s);
        add(p);
      }
      if (at.length > 0) G.splitEdge(e.eid, at, { mid: true });
    }
  }

  function emptyBoard(rect) {
    return { nodes: new Map(), edges: [], bridges: [], tails: [], boardBounds: rect, frameBounds: rect, stats: { nodeCount: 0, edgeCount: 0, avgDegree: 0, maxDegree: 0 } };
  }

  // Build the board inside `rect` (a generator: it yields between the steps, so the caller
  // can hand control back to the browser and stop on cancel).
  function* buildBoardGen(prep, rect, options) {
    const r = Number.isFinite(options.mergeRadiusMeters) && options.mergeRadiusMeters > 0 ? options.mergeRadiusMeters : DEFAULT_MERGE_RADIUS_M;
    const includeDeadEnds = options.includeDeadEnds !== false;
    const F = makeFrame(rect);
    const cov = newCoverage();
    const t0 = nowMs();

    // 1. Clip the ways to the rectangle
    const nodeXY = new Map();
    const posOf = (id) => {
      let v = nodeXY.get(id);
      if (v) return v;
      const [lat, lon] = prep.nodes.get(id);
      let [x, y] = F.xy(lat, lon);
      if (x >= F.x0 - CLAMP_TOL_M && x <= F.x1 + CLAMP_TOL_M && y >= F.y0 - CLAMP_TOL_M && y <= F.y1 + CLAMP_TOL_M) {
        // within CLAMP_TOL_M of the outline (either side): on it
        if (Math.abs(x - F.x0) <= CLAMP_TOL_M) x = F.x0;
        else if (Math.abs(x - F.x1) <= CLAMP_TOL_M) x = F.x1;
        if (Math.abs(y - F.y0) <= CLAMP_TOL_M) y = F.y0;
        else if (Math.abs(y - F.y1) <= CLAMP_TOL_M) y = F.y1;
      }
      v = { p: [x, y], inside: x >= F.x0 && x <= F.x1 && y >= F.y0 && y <= F.y1 };
      nodeXY.set(id, v);
      return v;
    };
    const vertPos = new Map();
    const cutVerts = new Set();
    const rawSegs = [];
    const FE = { x0: F.x0 - CLAMP_TOL_M, x1: F.x1 + CLAMP_TOL_M, y0: F.y0 - CLAMP_TOL_M, y1: F.y1 + CLAMP_TOL_M };
    const areaSegs = new Map(); // node pair -> length inside (area outlines left out)
    const roadPairs = new Set(); // node pairs of the roads used
    const eLat = 5 / F.ky;
    const eLon = 5 / F.kx;
    const dropAreas = options.dropAreaOutlines === undefined ? DROP_AREA_OUTLINES : !!options.dropAreaOutlines;
    for (const w of prep.ways) {
      if (w.maxLat < rect.south - eLat || w.minLat > rect.north + eLat || w.maxLon < rect.west - eLon || w.minLon > rect.east + eLon) continue;
      if (dropAreas && w.areaLike) {
        // left out as an area outline: its length inside the rectangle is counted (each
        // segment once, and not if a road uses it too), clipped like a road
        for (let i = 1; i < w.nodes.length; i++) {
          const a = w.nodes[i - 1];
          const b = w.nodes[i];
          if (a === b) continue;
          const pa = posOf(a).p;
          const pb = posOf(b).p;
          const L = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
          let t = clipParams(pa, pb, F);
          if (!t || (t[1] - t[0]) * L < CUT_EPS_M) t = clipParams(pa, pb, FE);
          if (!t) continue;
          areaSegs.set(cmpKey(a, b) < 0 ? `${a}|${b}` : `${b}|${a}`, (t[1] - t[0]) * L);
        }
        continue;
      }
      for (let i = 1; i < w.nodes.length; i++) {
        const a = w.nodes[i - 1];
        const b = w.nodes[i];
        const pa = posOf(a);
        const pb = posOf(b);
        roadPairs.add(cmpKey(a, b) < 0 ? `${a}|${b}` : `${b}|${a}`);
        if (pa.inside && pb.inside) {
          vertPos.set(a, pa.p);
          vertPos.set(b, pb.p);
          rawSegs.push([a, b, w.id]);
          continue;
        }
        // Clipped to the rectangle itself (a road crossing the frame is cut where it crosses).
        // A segment that never enters the rectangle but runs within CLAMP_TOL_M outside it (a
        // road along the frame) is clipped to the widened rectangle and laid on the outline.
        const [lo, hi, plo, phi] = cmpKey(a, b) < 0 ? [a, b, pa, pb] : [b, a, pb, pa];
        const segL = Math.hypot(phi.p[0] - plo.p[0], phi.p[1] - plo.p[1]);
        let t = clipParams(plo.p, phi.p, F);
        if (!t || (t[1] - t[0]) * segL < CUT_EPS_M) t = clipParams(plo.p, phi.p, FE);
        if (!t) continue;
        const at = (tt) => F.snap([plo.p[0] + (phi.p[0] - plo.p[0]) * tt, plo.p[1] + (phi.p[1] - plo.p[1]) * tt]);
        const q0 = at(t[0]);
        const q1 = at(t[1]);
        if (Math.hypot(q1[0] - q0[0], q1[1] - q0[1]) < CUT_EPS_M) continue;
        let k0 = lo;
        let k1 = hi;
        if (t[0] > 0) {
          k0 = `c:${lo}:${hi}:${t[0].toFixed(9)}`;
          vertPos.set(k0, q0);
          cutVerts.add(k0);
        } else vertPos.set(lo, plo.p);
        if (t[1] < 1) {
          k1 = `c:${lo}:${hi}:${t[1].toFixed(9)}`;
          vertPos.set(k1, q1);
          cutVerts.add(k1);
        } else vertPos.set(hi, phi.p);
        rawSegs.push([k0, k1, w.id]);
      }
    }
    for (const [k, len] of areaSegs) if (!roadPairs.has(k)) cov.areaM += len;
    if (rawSegs.length > MAX_CLIPPED_SEGMENTS) {
      throw new StreetGoError('too-many', '範囲内の道路が多すぎます。範囲を狭めてください');
    }
    // Points closer than ZERO_SEG_M along a road are one point
    const parent = new Map();
    const find = (k) => {
      while (parent.has(k)) k = parent.get(k);
      return k;
    };
    for (const [a, b] of rawSegs) {
      const pa = vertPos.get(a);
      const pb = vertPos.get(b);
      if (Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) >= ZERO_SEG_M) continue;
      const ra = find(a);
      const rb = find(b);
      if (ra === rb) continue;
      const [keepK, dropK] = cmpKey(ra, rb) < 0 ? [ra, rb] : [rb, ra];
      parent.set(dropK, keepK);
      if (cutVerts.has(dropK)) cutVerts.add(keepK);
    }
    const segMap = new Map();
    const adj = new Map();
    const segKeyOf = (a, b) => (cmpKey(a, b) < 0 ? `${a}|${b}` : `${b}|${a}`);
    for (const [a0, b0, wid] of rawSegs) {
      const a = find(a0);
      const b = find(b0);
      if (a === b) continue;
      const k = segKeyOf(a, b);
      let s = segMap.get(k);
      if (!s) {
        const pa = vertPos.get(a);
        const pb = vertPos.get(b);
        s = { len: Math.hypot(pa[0] - pb[0], pa[1] - pb[1]), ways: new Set() };
        segMap.set(k, s);
        if (!adj.has(a)) adj.set(a, new Set());
        if (!adj.has(b)) adj.set(b, new Set());
        adj.get(a).add(b);
        adj.get(b).add(a);
        cov.totalM += s.len;
      }
      s.ways.add(wid);
    }
    if (adj.size === 0) return emptyBoard(rect);
    // Distance to the nearest input road (segments inside the rectangle), for checks of moved
    // lines; searched up to 30 m
    const roadCells = new Map();
    const RC = 20;
    for (const [k] of segMap) {
      const [ka, kb] = k.split('|');
      const pa = vertPos.get(vertPos.has(ka) ? ka : Number(ka));
      const pb = vertPos.get(vertPos.has(kb) ? kb : Number(kb));
      if (!pa || !pb) continue;
      for (let cx = Math.floor(Math.min(pa[0], pb[0]) / RC); cx <= Math.floor(Math.max(pa[0], pb[0]) / RC); cx++) {
        for (let cy = Math.floor(Math.min(pa[1], pb[1]) / RC); cy <= Math.floor(Math.max(pa[1], pb[1]) / RC); cy++) {
          const ck = `${cx},${cy}`;
          if (!roadCells.has(ck)) roadCells.set(ck, []);
          roadCells.get(ck).push([pa, pb]);
        }
      }
    }
    const offRoad = (p) => {
      const cx = Math.floor(p[0] / RC);
      const cy = Math.floor(p[1] / RC);
      let m = 30;
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          for (const [a, b] of roadCells.get(`${cx + dx},${cy + dy}`) || []) m = Math.min(m, pointSegDistXY(p, a, b));
        }
      }
      return m;
    };
    yield 'clip';

    // 1b. Roads leaving the rectangle are used up to their last junction (or real dead end)
    //     inside: from a road's cut at the frame back to the first point with another degree
    //     than 2, nothing is kept (no road, no drawn-only piece). A road crossing without a
    //     junction inside is left out whole. A junction losing roads this way stays a point
    //     (`pinned`), even with one or two roads left.
    const deg = (k) => adj.get(k).size;
    const isCutEnd = (k) => deg(k) === 1 && (cutVerts.has(k) ||
      (typeof k === 'number' && (prep.rawDeg.get(k) || 0) > 1 && F.onFrame(vertPos.get(k))));
    const pinned = new Set();
    {
      const dropSeg = new Set();
      const stops = new Set();
      for (const s of Array.from(adj.keys()).sort(cmpKey)) {
        if (!isCutEnd(s)) continue;
        const first = adj.get(s).values().next().value;
        let prev = s;
        let cur = first;
        dropSeg.add(segKeyOf(s, first));
        for (let guard = 0; deg(cur) === 2 && guard < 1e6; guard++) {
          let nxt;
          for (const nb of adj.get(cur)) if (nb !== prev) nxt = nb;
          if (nxt === undefined) break;
          const sk = segKeyOf(cur, nxt);
          if (dropSeg.has(sk)) break;
          dropSeg.add(sk);
          prev = cur;
          cur = nxt;
        }
        if (deg(cur) >= 3) stops.add(cur);
      }
      for (const sk of dropSeg) {
        const s = segMap.get(sk);
        if (!s) continue;
        cov.leavingM += s.len; // not a road of the board: outside the coverage's denominator
        cov.totalM -= s.len;
        segMap.delete(sk);
      }
      for (const [k, nbs] of adj) {
        for (const nb of Array.from(nbs)) if (dropSeg.has(segKeyOf(k, nb))) nbs.delete(nb);
      }
      for (const k of Array.from(adj.keys())) if (adj.get(k).size === 0) adj.delete(k);
      for (const k of stops) if (adj.has(k) && deg(k) <= 2) pinned.add(k);
    }
    if (adj.size === 0) return emptyBoard(rect);

    // 2. Chains between key points (degree other than 2, and pinned junctions); rings
    //    without one get a shape point
    const isJ = (k) => deg(k) >= 3 || pinned.has(k);
    const keys = Array.from(adj.keys()).sort(cmpKey);
    const usedSeg = new Set();
    const chains = [];
    const walk = (start, first) => {
      const path = [start, first];
      usedSeg.add(segKeyOf(start, first));
      let prev = start;
      let cur = first;
      while (deg(cur) === 2 && !pinned.has(cur) && cur !== start) {
        let nxt;
        for (const nb of adj.get(cur)) if (nb !== prev) nxt = nb;
        if (nxt === undefined) break;
        const sk = segKeyOf(cur, nxt);
        if (usedSeg.has(sk)) break;
        usedSeg.add(sk);
        path.push(nxt);
        prev = cur;
        cur = nxt;
      }
      const ways = new Set();
      for (let i = 1; i < path.length; i++) for (const wid of segMap.get(segKeyOf(path[i - 1], path[i])).ways) ways.add(wid);
      const pts = path.map((k) => vertPos.get(k));
      return { a: path[0], b: path[path.length - 1], pts, ways, len: lenXY(pts) };
    };
    const ringAnchors = new Set();
    for (const k of keys) {
      if (deg(k) === 2 && !pinned.has(k)) continue;
      for (const nb of Array.from(adj.get(k)).sort(cmpKey)) {
        if (!usedSeg.has(segKeyOf(k, nb))) chains.push(walk(k, nb));
      }
    }
    for (const k of keys) {
      if (deg(k) !== 2 || pinned.has(k)) continue;
      const nbs = Array.from(adj.get(k)).sort(cmpKey);
      if (nbs.every((nb) => usedSeg.has(segKeyOf(k, nb)))) continue;
      ringAnchors.add(k);
      chains.push(walk(k, nbs.find((nb) => !usedSeg.has(segKeyOf(k, nb)))));
    }
    yield 'chains';

    // 3. Merge junctions closer than r that a road joins within 2 r
    const junctionKeys = keys.filter(isJ);
    const jAdj = new Map();
    for (const c of chains) {
      if (c.a === c.b || !isJ(c.a) || !isJ(c.b)) continue;
      for (const [x, y] of [[c.a, c.b], [c.b, c.a]]) {
        if (!jAdj.has(x)) jAdj.set(x, new Map());
        const m = jAdj.get(x);
        if (!m.has(y) || c.len < m.get(y)) m.set(y, c.len);
      }
    }
    const linked = makeRoadLink(jAdj, 2 * r);
    const jList = junctionKeys.map((k) => {
      const [lat, lon] = F.ll(vertPos.get(k));
      return { id: k, lat, lon, deg: deg(k), p: vertPos.get(k) };
    });
    const clusters = clusterJunctions(jList, r, linked);
    const G = makeWorkGraph();
    G.offRoad = offRoad;
    G.maxOffRoad = (pts) => {
      const cum = cumXY(pts);
      const L = cum[cum.length - 1];
      const n = Math.max(1, Math.ceil(L / 2));
      let m = 0;
      for (let k = 0; k <= n; k++) m = Math.max(m, offRoad(atXY(pts, cum, (k * L) / n)));
      return m;
    };
    const pointOf = new Map();
    // A merged junction is placed on one of its real junctions (never between them). The
    // roads of the others reach it along the real roads joining the members (the short roads
    // inside the merged junction). Chosen: the member with the least line off the roads (a
    // member another one cannot reach by such roads costs the straight connector), then the
    // one with most roads, then the one nearest the centre of the members.
    const clusterOfKey = new Map();
    clusters.forEach((c, ci) => { for (const m of c.members) clusterOfKey.set(m.id, ci); });
    const inner = clusters.map(() => new Map()); // member key -> [{ to, pts (from -> to), len }]
    const outerEnds = clusters.map(() => new Map()); // member key -> number of roads leaving the cluster
    const outerLen = clusters.map(() => new Map()); // member key -> length of those roads
    for (const ch of chains) {
      const ca = clusterOfKey.get(ch.a);
      const cb = clusterOfKey.get(ch.b);
      if (ca !== undefined && ca === cb && ch.a !== ch.b) {
        const m = inner[ca];
        if (!m.has(ch.a)) m.set(ch.a, []);
        if (!m.has(ch.b)) m.set(ch.b, []);
        m.get(ch.a).push({ to: ch.b, pts: ch.pts, len: ch.len });
        m.get(ch.b).push({ to: ch.a, pts: ch.pts.slice().reverse(), len: ch.len });
        continue;
      }
      for (const [k, ci] of [[ch.a, ca], [ch.b, cb]]) {
        if (ci === undefined) continue;
        outerEnds[ci].set(k, (outerEnds[ci].get(k) || 0) + 1);
        outerLen[ci].set(k, (outerLen[ci].get(k) || 0) + ch.len);
      }
    }
    // shortest road path inside a cluster from `src` to every member: Map key -> pts (src -> key)
    const pathsFrom = (ci, src) => {
      const dist = new Map([[src, 0]]);
      const via = new Map([[src, [vertPos.get(src)]]]);
      const done = new Set();
      for (;;) {
        let cur = null;
        for (const [k, d] of dist) if (!done.has(k) && (cur === null || d < dist.get(cur))) cur = k;
        if (cur === null) break;
        done.add(cur);
        for (const step of inner[ci].get(cur) || []) {
          const nd = dist.get(cur) + step.len;
          if (nd > 2 * r + 1e-9) continue;
          if (!dist.has(step.to) || nd < dist.get(step.to)) {
            dist.set(step.to, nd);
            via.set(step.to, via.get(cur).concat(step.pts.slice(1)));
          }
        }
      }
      return via;
    };
    const routeTo = new Map(); // member key -> pts from the chosen member to it
    clusters.forEach((c, ci) => {
      let best = null;
      if (c.members.length > 1) {
        let cx = 0;
        let cy = 0;
        for (const m of c.members) {
          cx += m.p[0];
          cy += m.p[1];
        }
        cx /= c.members.length;
        cy /= c.members.length;
        for (const m of c.members) {
          const paths = pathsFrom(ci, m.id);
          let off = 0;
          for (const [k, n] of outerEnds[ci]) {
            if (k === m.id || paths.has(k)) continue;
            off += n * Math.hypot(vertPos.get(k)[0] - m.p[0], vertPos.get(k)[1] - m.p[1]);
          }
          const cand = { m, paths, off, roads: outerEnds[ci].get(m.id) || 0, along: outerLen[ci].get(m.id) || 0, centre: Math.hypot(m.p[0] - cx, m.p[1] - cy) };
          const better = (x, y) => {
            if (Math.abs(x.off - y.off) > 1e-9) return x.off < y.off;
            if (x.roads !== y.roads) return x.roads > y.roads;
            // then the member the longer roads start from (the main street goes straight on)
            if (Math.abs(x.along - y.along) > 1e-6) return x.along > y.along;
            if (Math.abs(x.centre - y.centre) > 1e-9) return x.centre < y.centre;
            return cmpKey(x.m.id, y.m.id) < 0;
          };
          if (!best || better(cand, best)) best = cand;
        }
      }
      const at = best ? best.m : c.members[0];
      const pin = c.members.some((m) => pinned.has(m.id));
      const pid = G.addPoint(at.p, { members: c.members.map((m) => m.p), real: true, pin });
      for (const m of c.members) {
        pointOf.set(m.id, pid);
        if (best && m.id !== at.id && best.paths.has(m.id)) routeTo.set(m.id, best.paths.get(m.id));
      }
    });
    for (const k of keys) {
      if (isJ(k)) continue;
      if (deg(k) === 2 && !ringAnchors.has(k)) continue;
      pointOf.set(k, G.addPoint(vertPos.get(k), { shape: ringAnchors.has(k) }));
    }
    if (G.points.size > EARLY_TOO_MANY_FACTOR * MAX_BOARD_NODES) {
      throw new StreetGoError('too-many', `交点が多すぎます(${G.points.size}点以上)。範囲を狭めてください`);
    }
    const kindOfKey = (k) => (isJ(k) ? 'junction' : 'end');
    for (const c of chains) {
      const u = pointOf.get(c.a);
      const v = pointOf.get(c.b);
      if (u === v && c.a !== c.b && c.len <= 2 * r) {
        cov.mergedM += c.len; // the short road inside a merged junction
        continue;
      }
      let pts = c.pts.slice();
      // a road from a member that is not the merged point comes along the real roads to it
      const ra = routeTo.get(c.a);
      const rb = routeTo.get(c.b);
      if (ra) pts = ra.concat(pts.slice(1));
      if (rb) pts = pts.concat(rb.slice().reverse().slice(1));
      const pu = G.points.get(u).p;
      const pv = G.points.get(v).p;
      // A junction's end moves to the merged point. If moving the end would take a long road
      // off its course (more than END_MOVE_DEV_M; the road at least twice as long as the
      // move and not shorter than r), or leave a road to a dead end much shorter,
      // the road keeps its course and gets a short connector to the merged point. Short roads
      // (dense blocks) are drawn straight to the merged point instead.
      const moveEnd = (list, p, atStart, farKind) => {
        const endIdx = atStart ? 0 : list.length - 1;
        if (list[endIdx][0] === p[0] && list[endIdx][1] === p[1]) return list;
        const replaced = list.slice();
        replaced[endIdx] = p;
        const keepCourse = atStart ? [p].concat(list) : list.concat([p]);
        const moveLen = Math.hypot(list[endIdx][0] - p[0], list[endIdx][1] - p[1]);
        if (c.len >= Math.max(r, 2 * moveLen) && maxDeviationXY(replaced, list) > END_MOVE_DEV_M) return keepCourse;
        if (farKind !== 'junction' && lenXY(replaced) < Math.min(r / 3, 0.5 * c.len)) return keepCourse;
        return replaced;
      };
      pts = moveEnd(pts, pu, true, kindOfKey(c.b));
      pts = moveEnd(pts, pv, false, kindOfKey(c.a));
      G.addEdge(u, v, pts, c.ways, c.len, c.pts[0], c.pts[c.pts.length - 1]);
    }
    // Dead ends facing each other across a short gap: one road (again after each round: a
    // joined road may face the next gap)
    let facingJoined = 0;
    for (let round = 0; round < 50; round++) {
      const n = joinFacingDeadEnds(G);
      facingJoined += n;
      if (n === 0) break;
    }
    yield 'merge';

    // 4. Roads running side by side -> one centre line over that stretch
    const parallelMerges = yield* mergeParallelRoads(G, F, cov, r);
    yield 'parallel';

    // 5. Loops and second routes
    normalizeLoopsAndRoutes(G, F, cov);
    // 6. Dead ends (one place)
    const deadEndsRemoved = applyDeadEndPolicy(G, includeDeadEnds, cov);
    // 7. Only the largest connected part; its outline is a ring of roads (dead-end branches
    //    leaving it are left out); then short dead-end branches and points too close to others
    //    become drawn-only pieces (these only take off ends: the part stays one)
    const partsDropped = keepLargestComponent(G, cov);
    const outside = yield* trimOutsideRing(G, cov);
    yield 'ring';
    const shortSpurs = dropShortSpurs(G, cov);
    const closeResolved = resolveClosePoints(G);
    const sameStreet = makeSameStreet(G.streetWays);
    const remaindersDropped = dropOtherCarriageway(G, sameStreet, cov);
    if (options.subdivideLongRoads && options.subdivideSpacingMeters >= 20) {
      subdivideLong(G, options.subdivideSpacingMeters, Math.max(r, 1));
    }
    if (G.points.size === 0) return emptyBoard(rect);
    if (G.points.size > EARLY_TOO_MANY_FACTOR * MAX_BOARD_NODES) {
      throw new StreetGoError('too-many', `交点が多すぎます(${G.points.size}点以上)。範囲を狭めてください`);
    }
    yield 'normalize';

    // 8. Board in latitude / longitude
    const idOf = new Map();
    let seq = 0;
    for (const pid of G.points.keys()) idOf.set(pid, `n${++seq}`);
    const nodes = new Map();
    const memberPos = new Map();
    const preKind = new Map();
    const fixed = new Set();
    for (const pt of G.points.values()) {
      const id = idOf.get(pt.pid);
      const [lat, lon] = F.ll(pt.p);
      nodes.set(id, { id, lat, lon, isMidpoint: !!(pt.mid || pt.shape), neighbors: new Set() });
      if (pt.stub) fixed.add(id); // a drawn-only piece starts here: the point stays
      if (pt.real) fixed.add(id); // a merged junction sits on a real junction: it stays
      if (pt.pin && G.degree(pt.pid) <= 2) nodes.get(id).pinned = true; // a junction left with one or two roads by the frame
      if (pt.members && pt.members.length >= 2) memberPos.set(id, pt.members.map((m) => F.ll(m)));
      const d = G.degree(pt.pid);
      preKind.set(id, pt.mid ? 'midpoint' : pt.shape && d === 2 ? 'shape' : d === 1 ? 'deadEnd' : 'junction');
    }
    let edges = [];
    for (const e of G.edges.values()) {
      let u = idOf.get(e.u);
      let v = idOf.get(e.v);
      let coords = e.pts.map((p) => F.ll(p));
      let rawEnds = [F.ll(e.rawA), F.ll(e.rawB)];
      if (u > v) {
        [u, v] = [v, u];
        coords = coords.reverse();
        rawEnds = [rawEnds[1], rawEnds[0]];
      }
      nodes.get(u).neighbors.add(v);
      nodes.get(v).neighbors.add(u);
      edges.push({
        u,
        v,
        coords,
        roadCoords: coords,
        length: polylineLength(coords),
        rawEnds,
        endShift: endShiftMeters(coords, rawEnds),
        wayIds: Array.from(e.ways).sort(cmpKey),
        srcLength: e.src
      });
    }
    edges.sort((a, b) => (a.u < b.u ? -1 : a.u > b.u ? 1 : a.v < b.v ? -1 : a.v > b.v ? 1 : 0));

    // 9. Merged junctions beside their road go onto it (junctions only)
    const minDeg = (id) => (preKind.get(id) === 'deadEnd' ? 1 : 2);
    const aligned = yield* alignPointsOntoRoadsGen(nodes, edges, r, memberPos, {
      canMove: (id) => preKind.get(id) === 'junction' && !fixed.has(id),
      minDegreeOf: minDeg
    });
    yield 'align';

    // 10. Simpler drawn lines
    const edgesOut = yield* buildDisplayShapesGen(aligned.nodes, aligned.edges, rect);
    const finalNodes = aligned.nodes;
    for (const [id, n] of finalNodes) {
      const d = n.neighbors.size;
      const pk = preKind.get(id);
      n.kind = pk === 'midpoint' || pk === 'shape' ? pk : d === 1 ? 'deadEnd' : 'junction';
    }
    // Pieces drawn but not played on (short dead-end branches, points too close to others)
    const tails = [];
    for (const t of G.tails) {
      const id = idOf.get(t.pid);
      const n = id && finalNodes.get(id);
      if (!n) continue;
      const coords = t.pts.map((p) => F.ll(p));
      coords[0] = [n.lat, n.lon];
      tails.push({ node: id, coords, wayIds: Array.from(t.ways).sort(cmpKey) });
    }
    // Crossings of drawn lines without a shared point, drawn-only pieces included (they are
    // not joined to anything they cross either)
    const bridges = yield* findBridges(finalNodes, edgesOut, tails, (a, b) => sameStreet(new Set(a), new Set(b)) || a.some((w) => b.includes(w)));

    // stats
    let keptLen = 0;
    for (const e of edgesOut) keptLen += Number.isFinite(e.srcLength) ? e.srcLength : e.length;
    const kinds = { junction: 0, deadEnd: 0, shape: 0, midpoint: 0 };
    const degreeHistogram = {};
    for (const n of finalNodes.values()) {
      kinds[n.kind] = (kinds[n.kind] || 0) + 1;
      const d = n.neighbors.size;
      degreeHistogram[d] = (degreeHistogram[d] || 0) + 1;
    }
    // parts counted on the board handed to the game (after midpoints and moves)
    const finalSizes = [];
    {
      const seenF = new Set();
      for (const id of finalNodes.keys()) {
        if (seenF.has(id)) continue;
        let size = 0;
        const st = [id];
        seenF.add(id);
        while (st.length) {
          size++;
          for (const nb of finalNodes.get(st.pop()).neighbors) if (!seenF.has(nb)) { seenF.add(nb); st.push(nb); }
        }
        finalSizes.push(size);
      }
      finalSizes.sort((a, b) => b - a);
    }
    // (one part: only the largest is kept; no warning is left to give)
    const warnings = [];
    // Coverage of the input roads inside the rectangle: the denominator is every road of the
    // query cut to the rectangle (area outlines included), with what was left out by reason.
    // Pieces of roads leaving the rectangle (beyond their last junction inside) are no roads
    // of the board: not in the denominator, their length is given as `leavingRange`.
    // `tailM` is measured on the drawn-only pieces as they are output.
    let tailLen = 0;
    for (const t of tails) tailLen += polylineLength(t.coords);
    const roadsM = cov.totalM;
    const allM = roadsM + cov.areaM;
    const lostRoads = cov.droppedM.deadEnd + cov.droppedM.smallComponent + cov.droppedM.smallLoop + cov.droppedM.outsideRing;
    const coverage = {
      totalM: Math.round(allM),
      roadsM: Math.round(roadsM),
      keptM: Math.round(Math.min(roadsM, keptLen)),
      mergedM: Math.round(cov.mergedM),
      tailM: Math.round(tailLen),
      droppedM: {
        areaOutline: Math.round(cov.areaM),
        leavingRange: Math.round(cov.leavingM),
        deadEnd: Math.round(cov.droppedM.deadEnd),
        smallComponent: Math.round(cov.droppedM.smallComponent),
        smallLoop: Math.round(cov.droppedM.smallLoop),
        outsideRing: Math.round(cov.droppedM.outsideRing)
      },
      rate: allM > 0 ? +((allM - cov.areaM - lostRoads) / allM).toFixed(4) : 1,
      rateRoads: roadsM > 0 ? +((roadsM - lostRoads) / roadsM).toFixed(4) : 1
    };
    return {
      nodes: finalNodes,
      edges: edgesOut,
      bridges,
      tails,
      boardBounds: rect,
      frameBounds: rect, // the frame drawn: the rectangle (a place's board: see fitFrame)
      // the board's outline (outer boundary of its ring roads, as the roads ran before their
      // lines were simplified), or null when the board has no ring
      outline: outside.ring ? outside.ring.map((p) => F.ll(p)) : null,
      stats: {
        ...computeGraphStats(finalNodes, edgesOut),
        degreeHistogram,
        kinds,
        components: finalSizes.length,
        componentSizes: finalSizes,
        partsDropped,
        outsideBranches: outside.branches,
        crossingsRemaining: bridges.length,
        oneStreetCrossings: bridges.oneStreetCrossings,
        bridges: bridges.length,
        parallelMerges,
        facingJoined,
        shortSpurs,
        closeResolved,
        remaindersDropped,
        tails: tails.length,
        deadEndsRemoved,
        alignedPoints: aligned.applied.length,
        alignedMoves: aligned.applied.map((a) => ({ point: a.point, form: a.form, road: a.road, movedM: Math.round(a.movedM * 10) / 10 })),
        coverage,
        quality: { ok: warnings.length === 0, warnings },
        buildMs: Math.round(nowMs() - t0)
      }
    };
  }

  function runGenSync(gen) {
    let r = gen.next();
    while (!r.done) r = gen.next();
    return r.value;
  }

  // Runs a board generator, giving control back to the browser every ~30 ms; a cancel
  // (signal) stops it at the next step.
  async function runGenAsync(gen, signal) {
    let last = nowMs();
    let r = gen.next();
    while (!r.done) {
      throwIfAborted(signal);
      if (nowMs() - last > 30) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        throwIfAborted(signal);
        last = nowMs();
      }
      r = gen.next();
    }
    throwIfAborted(signal);
    return r.value;
  }

  // Square of half side `half` metres around (lat, lon) (sides as distanceMeters measures them)
  function squareBounds(lat, lon, half) {
    const dLat = half / 111195;
    const dLon = half / (111195 * Math.max(1e-6, Math.cos((lat * Math.PI) / 180)));
    return { south: lat - dLat, north: lat + dLat, west: lon - dLon, east: lon + dLon };
  }

  function cornerDistance(lat, lon, b) {
    let far = 0;
    for (const [la, lo] of [[b.south, b.west], [b.south, b.east], [b.north, b.west], [b.north, b.east]]) {
      far = Math.max(far, distanceMeters(lat, lon, la, lo));
    }
    return far;
  }

  // Square board for a place: the side is searched (both ways) so the final number of points
  // (end points included) is within SQUARE_MIN_RATIO..SQUARE_MAX_RATIO x target, or else as
  // close to it as found, never past MAX_BOARD_NODES. The corners stay within coverageM.
  // Returns { graph, hitCoverage, evaluations }.
  function* searchSquareGen(prep, lat, lon, options, coverageM) {
    const target = options.targetNodes || 81;
    const minN = SQUARE_MIN_RATIO * target;
    const maxN = Math.min(MAX_BOARD_NODES, SQUARE_MAX_RATIO * target);
    const coverage = Number.isFinite(coverageM) ? coverageM : Infinity;
    // Largest half side whose corners stay within the coverage
    let maxHalf = 4000;
    if (Number.isFinite(coverage)) {
      maxHalf = coverage / Math.SQRT2;
      while (maxHalf > 1 && cornerDistance(lat, lon, squareBounds(lat, lon, maxHalf)) > coverage) maxHalf *= 0.995;
    }
    const minHalf = 15;
    // First guess: the square holding about 0.7 x target raw junctions
    const cos = Math.max(1e-6, Math.cos((lat * Math.PI) / 180));
    const cheb = prep.junctionIds.map((id) => {
      const [la, lo] = prep.nodes.get(id);
      return Math.max(Math.abs(la - lat) * 110540, Math.abs(lo - lon) * 111320 * cos);
    }).sort((a, b) => a - b);
    let half = cheb.length ? cheb[Math.min(cheb.length - 1, Math.max(0, Math.round(0.7 * target) - 1))] + 10 : 200;
    half = Math.max(minHalf, Math.min(maxHalf, half));
    const tried = [];
    let best = null;
    const score = (n) => (n >= minN && n <= maxN ? 0 : 1) * 1e6 + Math.abs(n - target);
    let lo = null; // largest half with too few points
    let hi = null; // smallest half with too many points
    let hitCoverage = false;
    let bestHalf = minHalf;
    for (let iter = 0; iter < 16; iter++) {
      const rect = squareBounds(lat, lon, half);
      let g = null;
      let count;
      try {
        g = yield* buildBoardGen(prep, rect, options);
        count = g.nodes.size;
      } catch (err) {
        if (!err || err.kind !== 'too-many') throw err;
        count = Infinity;
      }
      tried.push({ half: Math.round(half * 10) / 10, count });
      if (g && count <= MAX_BOARD_NODES && (!best || score(count) < score(best.nodes.size))) {
        best = g;
        bestHalf = half;
        best.stats.sideM = Math.round(2 * half);
      }
      if (count >= minN && count <= maxN) break;
      if (count < minN) {
        lo = half;
        if (half >= maxHalf - 0.5) {
          hitCoverage = true;
          break;
        }
        half = hi !== null ? (lo + hi) / 2 : Math.min(maxHalf, half * 1.3);
      } else {
        hi = half;
        if (half <= minHalf + 0.5) break;
        half = lo !== null ? (lo + hi) / 2 : Math.max(minHalf, half / 1.3);
      }
      if (lo !== null && hi !== null && hi - lo < 1) break;
    }
    if (!best) {
      // nothing within the limit: the smallest square tried decides the error
      const rect = squareBounds(lat, lon, minHalf);
      best = yield* buildBoardGen(prep, rect, options);
    }
    best.stats.search = tried;
    // The square's position: moved a little (up to SHIFT_MAX_M east-west and north-south) so
    // that its sides do not run along roads (see shiftSquareGen)
    const shifted = yield* shiftSquareGen(prep, lat, lon, bestHalf, best, options, coverage, score);
    best = shifted.graph;
    best.frameBounds = fitFrame(best);
    return { graph: best, hitCoverage: hitCoverage && best.nodes.size < minN, evaluations: tried.length + shifted.builds };
  }

  // Length of roads running along the sides of a rectangle: road pieces (of SHIFT_PIECE_M at
  // most) within SHIFT_NEAR_M of a side (inside or outside), at most SHIFT_ANGLE_DEG off its
  // direction. Built once for the area around (lat, lon) the shifted squares can cover;
  // returns (bounds) => metres.
  function makeSideRoadScore(prep, lat, lon, reachM, dropAreas) {
    const ky = 111195;
    const kx = 111195 * Math.max(1e-6, Math.cos((lat * Math.PI) / 180));
    const box = squareBounds(lat, lon, reachM);
    const tan = Math.tan((SHIFT_ANGLE_DEG * Math.PI) / 180);
    const hx = [];
    const hy = [];
    const hl = [];
    const vx = [];
    const vy = [];
    const vl = [];
    for (const w of prep.ways) {
      if (dropAreas && w.areaLike) continue;
      if (w.maxLat < box.south || w.minLat > box.north || w.maxLon < box.west || w.minLon > box.east) continue;
      for (let i = 1; i < w.nodes.length; i++) {
        const [la0, lo0] = prep.nodes.get(w.nodes[i - 1]);
        const [la1, lo1] = prep.nodes.get(w.nodes[i]);
        const x0 = (lo0 - lon) * kx;
        const y0 = (la0 - lat) * ky;
        const dx = (lo1 - lon) * kx - x0;
        const dy = (la1 - lat) * ky - y0;
        const L = Math.hypot(dx, dy);
        if (L < 1e-6) continue;
        const east = Math.abs(dy) <= tan * Math.abs(dx);
        const north = Math.abs(dx) <= tan * Math.abs(dy);
        if (!east && !north) continue;
        const n = Math.ceil(L / SHIFT_PIECE_M);
        for (let k = 0; k < n; k++) {
          const x = x0 + (dx * (k + 0.5)) / n;
          const y = y0 + (dy * (k + 0.5)) / n;
          if (east) { hx.push(x); hy.push(y); hl.push(L / n); }
          if (north) { vx.push(x); vy.push(y); vl.push(L / n); }
        }
      }
    }
    return (b) => {
      const x0 = (b.west - lon) * kx;
      const x1 = (b.east - lon) * kx;
      const y0 = (b.south - lat) * ky;
      const y1 = (b.north - lat) * ky;
      let sum = 0;
      for (let i = 0; i < hx.length; i++) {
        if (hx[i] < x0 || hx[i] > x1) continue;
        if (Math.abs(hy[i] - y0) <= SHIFT_NEAR_M) sum += hl[i];
        if (Math.abs(hy[i] - y1) <= SHIFT_NEAR_M) sum += hl[i];
      }
      for (let i = 0; i < vx.length; i++) {
        if (vy[i] < y0 || vy[i] > y1) continue;
        if (Math.abs(vx[i] - x0) <= SHIFT_NEAR_M) sum += vl[i];
        if (Math.abs(vx[i] - x1) <= SHIFT_NEAR_M) sum += vl[i];
      }
      return sum;
    };
  }

  // The square of side 2 x half found around (lat, lon) is moved (centre up to SHIFT_MAX_M
  // east-west and north-south, in SHIFT_STEP_M steps; corners within the coverage) to where
  // the fewest roads run along its sides. Candidates are ranked by that length (then by the
  // distance moved); only a few are built (SHIFT_MAX_BUILDS), and only those whose count of
  // raw junctions stays within SHIFT_JUNCTION_SHARE of the found square's. A candidate is
  // taken when its board is in the target band (or, if the found one is not, closer to the
  // target) and has less road along its sides. Deterministic.
  function* shiftSquareGen(prep, lat, lon, half, graph, options, coverage, score) {
    const dropAreas = options.dropAreaOutlines === undefined ? DROP_AREA_OUTLINES : !!options.dropAreaOutlines;
    const sideScore = makeSideRoadScore(prep, lat, lon, half + SHIFT_MAX_M + SHIFT_NEAR_M + SHIFT_PIECE_M, dropAreas);
    const cos = Math.max(1e-6, Math.cos((lat * Math.PI) / 180));
    const centre = (dx, dy) => [lat + dy / 111195, lon + dx / (111195 * cos)];
    const base = sideScore(graph.boardBounds);
    const out = { graph, builds: 0 };
    graph.stats.shift = { dx: 0, dy: 0, sideRoadM: Math.round(base), sideRoadM0: Math.round(base) };
    if (base <= 0 || graph.nodes.size === 0) return out;
    const junctionsIn = (b) => {
      let n = 0;
      for (const id of prep.junctionIds) {
        const [la, lo] = prep.nodes.get(id);
        if (la >= b.south && la <= b.north && lo >= b.west && lo <= b.east) n++;
      }
      return n;
    };
    const j0 = junctionsIn(graph.boardBounds);
    const cands = [];
    for (let dx = -SHIFT_MAX_M; dx <= SHIFT_MAX_M; dx += SHIFT_STEP_M) {
      for (let dy = -SHIFT_MAX_M; dy <= SHIFT_MAX_M; dy += SHIFT_STEP_M) {
        if (dx === 0 && dy === 0) continue;
        const [la, lo] = centre(dx, dy);
        const b = squareBounds(la, lo, half);
        if (cornerDistance(lat, lon, b) > coverage) continue;
        const sc = sideScore(b);
        if (sc >= base) continue;
        cands.push({ dx, dy, b, sc, dist: Math.hypot(dx, dy) });
      }
    }
    cands.sort((p, q) => p.sc - q.sc || p.dist - q.dist || p.dx - q.dx || p.dy - q.dy);
    yield;
    // in the target band: 0 (then the road along the sides decides); else the distance to it
    const band = (n) => (score(n) >= 1e6 ? score(n) : 0);
    let bestKey = [band(graph.nodes.size), base, 0];
    const better = (k) => k[0] < bestKey[0] || (k[0] === bestKey[0] && (k[1] < bestKey[1] || (k[1] === bestKey[1] && k[2] < bestKey[2])));
    for (const c of cands) {
      if (out.builds >= SHIFT_MAX_BUILDS) break;
      if (Math.abs(junctionsIn(c.b) - j0) > SHIFT_JUNCTION_SHARE * Math.max(j0, 1)) continue;
      out.builds++;
      let g = null;
      try {
        g = yield* buildBoardGen(prep, c.b, options);
      } catch (err) {
        if (!err || err.kind !== 'too-many') throw err;
        continue;
      }
      if (g.nodes.size > MAX_BOARD_NODES) continue;
      const key = [band(g.nodes.size), c.sc, c.dist];
      if (!better(key)) continue;
      bestKey = key;
      g.stats.search = graph.stats.search;
      g.stats.sideM = graph.stats.sideM;
      g.stats.shift = { dx: c.dx, dy: c.dy, sideRoadM: Math.round(c.sc), sideRoadM0: Math.round(base) };
      out.graph = g;
      if (key[0] === 0) break; // in the band, with the least road along the sides tried so far
    }
    return out;
  }

  // The frame of a board made for a place: its points and drawn lines (roads, drawn-only
  // pieces) with a margin of max(FRAME_PAD_M, FRAME_PAD_SHARE x the extent) on each axis, cut
  // to the square the roads were cut to (boardBounds). The roads leaving the square end at
  // their last junction inside, so the square itself would leave an empty band at its sides.
  function fitFrame(g) {
    const b = g.boardBounds;
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;
    const add = ([la, lo]) => {
      if (la < minLat) minLat = la;
      if (la > maxLat) maxLat = la;
      if (lo < minLon) minLon = lo;
      if (lo > maxLon) maxLon = lo;
    };
    for (const n of g.nodes.values()) add([n.lat, n.lon]);
    for (const e of g.edges) for (const c of e.coords) add(c);
    for (const t of g.tails || []) for (const c of t.coords) add(c);
    if (!(maxLat >= minLat && maxLon >= minLon)) return b;
    const cos = Math.max(0.2, Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180));
    const padLat = Math.max(FRAME_PAD_M / 110540, (maxLat - minLat) * FRAME_PAD_SHARE);
    const padLon = Math.max(FRAME_PAD_M / (111320 * cos), (maxLon - minLon) * FRAME_PAD_SHARE);
    return {
      south: Math.max(b.south, minLat - padLat),
      north: Math.min(b.north, maxLat + padLat),
      west: Math.max(b.west, minLon - padLon),
      east: Math.min(b.east, maxLon + padLon)
    };
  }

  // Board from road data (synchronous; for tests and tools). options.bounds: the rectangle as
  // it is; otherwise a square around (centerLat, centerLon) (options.coverageM: the radius
  // the data is complete for).
  function buildRoadGraph(elements, centerLat, centerLon, options = {}) {
    const prep = prepareRoadData(elements);
    const t0 = nowMs();
    let g;
    if (options.bounds) {
      g = runGenSync(buildBoardGen(prep, options.bounds, options));
    } else {
      const res = runGenSync(searchSquareGen(prep, centerLat, centerLon, options, options.coverageM));
      g = res.graph;
      g.stats.hitCoverage = res.hitCoverage;
    }
    g.stats.totalMs = Math.round(nowMs() - t0);
    return g;
  }

  // True if segments a0-a1 and b0-b1 cross (each has its ends on both sides of the other)
  function crossesProperly(a0, a1, b0, b1) {
    const side = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const E = 1e-6;
    const d1 = side(b0, b1, a0);
    const d2 = side(b0, b1, a1);
    const d3 = side(a0, a1, b0);
    const d4 = side(a0, a1, b1);
    return ((d1 > E && d2 < -E) || (d1 < -E && d2 > E)) && ((d3 > E && d4 < -E) || (d3 < -E && d4 > E));
  }

  // Crossings of drawn roads without a shared point (bridges / overpasses). The longer road
  // is drawn on top: `overCoords` is its piece around the crossing.
  function* findBridges(nodes, roadEdges, tails = [], oneStreet = null) {
    // drawn-only pieces take part as lines from their point to a point of their own
    const edges = roadEdges.concat(tails.map((t, i) => ({ u: t.node, v: `~tail${i}`, coords: t.coords, length: polylineLength(t.coords), tail: true, wayIds: t.wayIds })));
    if (edges.length === 0) return [];
    const proj = makeMetricProjector(nodes);
    const polys = edges.map((e) => e.coords.map(([la, lo]) => proj(la, lo)));
    const pos = new Map();
    for (const [id, n] of nodes) pos.set(id, proj(n.lat, n.lon));
    const CELL = 60;
    const cells = new Map();
    polys.forEach((p, i) => {
      const b = bboxXY(p, 1);
      for (let cx = Math.floor(b.minX / CELL); cx <= Math.floor(b.maxX / CELL); cx++) {
        for (let cy = Math.floor(b.minY / CELL); cy <= Math.floor(b.maxY / CELL); cy++) {
          const k = `${cx},${cy}`;
          if (!cells.has(k)) cells.set(k, []);
          cells.get(k).push(i);
        }
      }
    });
    const pairs = new Set();
    for (const list of cells.values()) {
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          const i = Math.min(list[a], list[b]);
          const j = Math.max(list[a], list[b]);
          if (i !== j) pairs.add(i * 1e6 + j);
        }
      }
    }
    const out = [];
    out.oneStreetCrossings = 0; // crossings of two lines of one street, left without a gap
    for (const key of Array.from(pairs).sort((x, y) => x - y)) {
      yield;
      const i = Math.floor(key / 1e6);
      const j = key % 1e6;
      const ei = edges[i];
      const ej = edges[j];
      // the two lines of one street (or one way) do not bridge each other (counted)
      const sameStreet = oneStreet && Array.isArray(ei.wayIds) && Array.isArray(ej.wayIds) && oneStreet(ei.wayIds, ej.wayIds);
      const shared = [];
      for (const x of [ei.u, ei.v]) if (x === ej.u || x === ej.v) shared.push(pos.get(x));
      const meets = [];
      const a = polys[i];
      const b = polys[j];
      for (let s = 1; s < a.length; s++) {
        for (let t = 1; t < b.length; t++) {
          if (Math.max(b[t - 1][0], b[t][0]) < Math.min(a[s - 1][0], a[s][0]) - 1e-9 || Math.min(b[t - 1][0], b[t][0]) > Math.max(a[s - 1][0], a[s][0]) + 1e-9) continue;
          if (Math.max(b[t - 1][1], b[t][1]) < Math.min(a[s - 1][1], a[s][1]) - 1e-9 || Math.min(b[t - 1][1], b[t][1]) > Math.max(a[s - 1][1], a[s][1]) + 1e-9) continue;
          const hits = segmentMeetPoints(a[s - 1], a[s], b[t - 1], b[t]);
          // Roads from a common point may run on top of each other near it (merged junctions):
          // between those only a true crossing counts.
          if (shared.length > 0 && hits.length > 0 && !crossesProperly(a[s - 1], a[s], b[t - 1], b[t])) continue;
          for (const m of hits) {
            if (shared.some((q) => Math.hypot(m[0] - q[0], m[1] - q[1]) <= SHAPE_TOUCH_M)) continue;
            if (meets.some((q) => Math.hypot(m[0] - q.m[0], m[1] - q.m[1]) <= SHAPE_TOUCH_M)) continue;
            meets.push({ m, s, t });
          }
        }
      }
      // Two roads from a common point that run on top of each other from the crossing to that
      // point (a road brought to a merged junction along another one; the simpler drawn
      // shape of one cuts the corner of the other) do not cross: no bridge.
      const pieceTo = (poly, seg, m, q) => {
        if (Math.hypot(poly[0][0] - q[0], poly[0][1] - q[1]) < 1e-6) return poly.slice(0, seg).concat([m]);
        return [m].concat(poly.slice(seg));
      };
      const runTogether = (m, s, t) => shared.some((q) => {
        const pa = pieceTo(a, s, m, q);
        const pb = pieceTo(b, t, m, q);
        if (lenXY(pa) > OVERLAP_MAX_M || lenXY(pb) > OVERLAP_MAX_M) return false;
        return hausdorffXY(pa, pb, 1) <= OVERLAP_WITHIN_M;
      });
      if (sameStreet) {
        if (meets.length > 0 && !ei.tail && !ej.tail && shared.length === 0) out.oneStreetCrossings++;
        continue;
      }
      for (const { m, s, t } of meets) {
        if (shared.length > 0 && runTogether(m, s, t)) continue;
        const li = ei.length;
        const lj = ej.length;
        const overIdx = li > lj || (li === lj && i < j) ? i : j;
        const underIdx = overIdx === i ? j : i;
        const seg = overIdx === i ? s : t;
        const op = polys[overIdx];
        const oc = edges[overIdx].coords;
        // latitude / longitude of the crossing, on the upper road's segment
        const p0 = op[seg - 1];
        const p1 = op[seg];
        const segLen = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
        const tt = segLen > 0 ? Math.hypot(m[0] - p0[0], m[1] - p0[1]) / segLen : 0;
        const at = [oc[seg - 1][0] + (oc[seg][0] - oc[seg - 1][0]) * tt, oc[seg - 1][1] + (oc[seg][1] - oc[seg - 1][1]) * tt];
        // the upper road's piece around the crossing (BRIDGE_HALF_M each side)
        const cum = cumXY(op);
        const sAt = cum[seg - 1] + segLen * tt;
        const L = cum[cum.length - 1];
        const s0 = Math.max(0, sAt - BRIDGE_HALF_M);
        const s1 = Math.min(L, sAt + BRIDGE_HALF_M);
        const llAt = (sv) => {
          let k = 1;
          while (k < cum.length - 1 && cum[k] < sv) k++;
          const sl = cum[k] - cum[k - 1];
          const f = sl > 0 ? (sv - cum[k - 1]) / sl : 0;
          return [oc[k - 1][0] + (oc[k][0] - oc[k - 1][0]) * f, oc[k - 1][1] + (oc[k][1] - oc[k - 1][1]) * f];
        };
        const overCoords = [llAt(s0)];
        for (let k = 1; k < cum.length - 1; k++) if (cum[k] > s0 && cum[k] < s1) overCoords.push(oc[k]);
        overCoords.push(llAt(s1));
        const oe = edges[overIdx];
        out.push({
          over: overIdx,
          under: underIdx,
          lat: at[0],
          lon: at[1],
          overCoords,
          overTail: !!oe.tail,
          overU: oe.tail ? null : oe.u,
          overV: oe.tail ? null : oe.v,
          underTail: !!edges[underIdx].tail
        });
      }
    }
    return out;
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


  function angleBetween(a, b) {
    let d = Math.abs(a - b) % (2 * Math.PI);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d;
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
    // (rawPts, the road between its original junctions, is not used: the 4 m / 2.5 m limits
    // apply to the line as drawn, ends moved or not)
    if (maxDevXY(pts) < SHAPE_STRAIGHT_DEV_M) return [0, n - 1];
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

  // Points where polylines a and b meet farther than SHAPE_TOUCH_M from the points in
  // `shared` (points closer than SHAPE_TOUCH_M to each other count once)
  function meetPointsAwayFrom(a, b, shared) {
    const out = [];
    for (let i = 1; i < a.length; i++) {
      const a0 = a[i - 1];
      const a1 = a[i];
      for (let j = 1; j < b.length; j++) {
        const b0 = b[j - 1];
        const b1 = b[j];
        if (Math.max(b0[0], b1[0]) < Math.min(a0[0], a1[0]) || Math.min(b0[0], b1[0]) > Math.max(a0[0], a1[0])) continue;
        if (Math.max(b0[1], b1[1]) < Math.min(a0[1], a1[1]) || Math.min(b0[1], b1[1]) > Math.max(a0[1], a1[1])) continue;
        for (const p of segmentMeetPoints(a0, a1, b0, b1)) {
          if (shared.some((s) => Math.hypot(p[0] - s[0], p[1] - s[1]) <= SHAPE_TOUCH_M)) continue;
          if (out.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= SHAPE_TOUCH_M)) continue;
          out.push(p);
        }
      }
    }
    return out;
  }

  // Pairs of meeting points [lineIndex, point] of different lines within SHAPE_TOUCH_M
  function closeMeetPairs(list) {
    let n = 0;
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        if (list[x][0] === list[y][0]) continue;
        if (Math.hypot(list[x][1][0] - list[y][1][0], list[x][1][1] - list[y][1][1]) <= SHAPE_TOUCH_M) n++;
      }
    }
    return n;
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
  //  - B was merged from two or more junctions (merging moved it), and opts.canMove(B)
  //    allows it (the board moves junctions only, never dead ends or shape points);
  //  - B moves at most r, ends at least r from every other point, no point drops below
  //    opts.minDegree roads (or opts.minDegreeOf(id): by the kind of the point, e.g. 1 for a
  //    dead end, 2 otherwise), and the board gets no new crossing (of roads with or without a
  //    shared point), no new narrow angle (< ALIGN_NARROW_DEG) at B or any point joined
  //    to B, A or C, and no more roads running together or passing close to a point.
  // Candidates are taken in the order of their end point ids, so the result does not depend
  // on the order of the input data.
  // B's other roads keep their course with the end moved to B's new place.

  function alignPointsOntoRoads(nodesIn, edgesIn, r, memberPos, opts = {}) {
    return runGenSync(alignPointsOntoRoadsGen(nodesIn, edgesIn, r, memberPos, opts));
  }

  function* alignPointsOntoRoadsGen(nodesIn, edgesIn, r, memberPos, opts = {}) {
    const applied = [];
    if (!(r > 0) || !memberPos || edgesIn.length === 0) return { nodes: nodesIn, edges: edgesIn, applied };
    const minDegree = opts.minDegree || 0; // no point may end with fewer roads than this (if it had them)
    const minDegreeOf = typeof opts.minDegreeOf === 'function' ? opts.minDegreeOf : () => minDegree;
    const canMove = typeof opts.canMove === 'function' ? opts.canMove : () => true;
    const unionWays = (...es) => {
      const set = new Set();
      for (const e of es) if (e && Array.isArray(e.wayIds)) for (const w of e.wayIds) set.add(w);
      return Array.from(set).sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
    };
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
        if ((deg.get(id) || 0) < Math.min(before, minDegreeOf(id))) { rejected++; return false; }
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
      yield;
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
        if (members.length < 2 || !canMove(B)) continue; // only a point moved by merging
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
        // the pieces are drawn along the road (the drawn shapes are made simpler afterwards)
        const added = [
          makeEdge(A, B, roadA, roadA, rawA, onRoad),
          makeEdge(B, C, roadC, roadC, onRoad, rawC)
        ];
        const replaced = new Set([ac]);
        for (const X of [A, C]) if (byKey.has(keyOf(B, X))) replaced.add(byKey.get(keyOf(B, X)));
        // The source roads (way ids, represented length) go with the pieces that replace them
        const acSrc = Number.isFinite(ac.srcLength) ? ac.srcLength : ac.length;
        [A, C].forEach((X, k) => {
          const old = byKey.get(keyOf(B, X));
          added[k].wayIds = unionWays(ac, old);
          const share = ac.length > 0 ? added[k].length / ac.length : 0.5;
          added[k].srcLength = acSrc * share + (old ? (Number.isFinite(old.srcLength) ? old.srcLength : old.length) : 0);
        });
        if (tryApply(B, newPos, replaced, added, { form: 'road', via, road: [A, C] })) {
          for (const e of edges) if (e.u === B || e.v === B) queue.push(e); // check the new pieces too
          break;
        }
      }
    }

    // Second form: there is no straight road A-C and B sits in a kink A-B-C: B's roads to A and C both follow the line A-C (within
    // ALIGN_CARRIAGEWAY_M) and start at the same junction m merged into B; m lies within
    // ALIGN_KINK_ON_LINE_M of the line, B at least ALIGN_KINK_MIN_OFFSET_M further off.
    // B is moved onto the line A-C, at the foot of m; the same limits apply.
    for (const B of Array.from(nodes.keys()).sort()) {
      yield;
      if (!canTry()) break;
      const members = memberPos.get(B) || [];
      if (members.length < 2 || !canMove(B)) continue;
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
            return { ...e, coords: rc, roadCoords: rc, length: polylineLength(rc), endShift: endShiftMeters(rc, e.rawEnds) };
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
  // the simpler shape would change how many times it meets another drawn line (each pair
  // counted, roads sharing a point included), make three lines meet at one place, newly run
  // along a line, newly pass within SHAPE_NEAR_NODE_M of a point that is not its end, be
  // (nearly) zero long, cross itself, fold back more sharply or leave `bounds`. Edges are
  // taken in order; each check is against the lines chosen so far, so the crossings never
  // change. Running it again only tries the edges not yet simplified (or changed since).
  function buildDisplayShapes(nodes, edgesIn, bounds) {
    return runGenSync(buildDisplayShapesGen(nodes, edgesIn, bounds));
  }

  function* buildDisplayShapesGen(nodes, edgesIn, bounds) {
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
      yield;
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
      if (polylineLengthXY(cand) < SHAPE_MIN_LEN_M) continue;
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
      const meetsCand = [];
      const meetsCur = [];
      for (const j of Array.from(near).sort((x, y) => x - y)) {
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
        const mc = meetPointsAwayFrom(cand, cur[j], shared);
        const mo = meetPointsAwayFrom(cur[i], cur[j], shared);
        if (mc.length !== mo.length) ok = false;
        else if (
          polylinesRunTogether(cand, cur[j], shared, SHAPE_OVERLAP_M + SHAPE_SLACK_M) &&
          !polylinesRunTogether(rp, road[j], shared, SHAPE_OVERLAP_M - SHAPE_SLACK_M)
        ) ok = false;
        for (const m of mc) meetsCand.push([j, m]);
        for (const m of mo) meetsCur.push([j, m]);
      }
      // Three lines meeting at one place (this line through another pair's meeting point)
      if (ok && closeMeetPairs(meetsCand) > closeMeetPairs(meetsCur)) ok = false;
      if (!ok) continue;
      cur[i] = cand;
      boxes[i] = bboxXY(cand, 0);
      edges[i] = { ...e, coords: candLatLon };
    }
    return edges;
  }

  function wantedNodes(targetNodes) {
    return Math.max(MIN_BOARD_NODES, Math.floor(targetNodes * SQUARE_MIN_RATIO));
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
    // First request: large enough for the square the search picks (corner distance up to
    // ~92 x sqrt(target) m on the 11 bundled places; the square moved afterwards keeps its
    // corners within the data), so a second request is rarely needed; never past the largest
    // radius asked for (3000 m)
    let radius = Math.min(3000, Math.max(400, Math.round(Math.sqrt(targetNodes) * FIRST_RADIUS_PER_SQRT_M)));
    if (!findCachedEntry(location.lat, location.lon, radius, mode)) {
      // Data at hand (bundled / fetched earlier) that covers what the former first request
      // (sqrt(target) x 45 m) covered is used as it is: never more requests than before.
      // Offline (initial board): whatever the bundled data covers.
      const maxR = maxCachedRadius(location.lat, location.lon, mode);
      const former = Math.max(300, Math.round(Math.sqrt(targetNodes) * 45));
      if (maxR > 0 && (!allowNetwork || maxR >= former)) radius = Math.min(radius, maxR);
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
      const t0 = nowMs();
      const prep = prepareRoadData(elements);
      const built = await runGenAsync(searchSquareGen(prep, location.lat, location.lon, options, coverage), signal);
      graph = built.graph;
      graph.stats.totalMs = Math.round(nowMs() - t0);

      if (graph.stats.nodeCount >= wantedNodes(targetNodes) || radius >= 2800 || attempt === 2) {
        break;
      }
      // A new fetch only helps when the square had to reach beyond the data we have.
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
    const t0 = nowMs();
    const prep = prepareRoadData(elements);
    const graph = await runGenAsync(buildBoardGen(prep, bounds, options), signal);
    graph.stats.totalMs = Math.round(nowMs() - t0);

    throwIfAborted(signal);
    if (graph.stats.nodeCount > MAX_BOARD_NODES) {
      throw new StreetGoError('too-many', `交点が多すぎます(${graph.stats.nodeCount}点)。範囲を狭めてください`);
    }
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
    neighborsClockwise,
    nextInCycle,
    MIN_DRAW_SIDE_PX,
    MAX_DRAW_SIDE_M,
    MAX_DRAW_ASPECT,
    MAX_DRAW_HALF_DIAG_M,
    DRAW_FETCH_MARGIN_M,
    // exposed for tests / tooling
    buildRoadGraph,
    prepareRoadData,
    buildBoardSteps: (elements, bounds, options = {}) => buildBoardGen(prepareRoadData(elements), bounds, options),
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
    SQUARE_MIN_RATIO,
    SQUARE_MAX_RATIO,
    DEFAULT_MERGE_RADIUS_M,
    MAX_OVERPASS_ELEMENTS
  };

  global.StreetGoMap = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
