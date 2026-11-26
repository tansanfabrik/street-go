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
  const EARLY_TOO_MANY_FACTOR = 3; // abort before simplification above 3 x MAX_BOARD_NODES
  const MAX_BOARD_NODES = 450;
  const MAX_OVERPASS_ELEMENTS = 200000;

  const MSG_BUSY = '混雑しています。しばらく待って再試行してください';
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
    for (const c of clusters) {
      const nid = `n${nextNodeId++}`;
      for (const m of c.members) clusterOfJunction.set(m.id, nid);
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
            subdividedEdges.push({
              u: prevId,
              v: currId,
              coords: subCoords,
              length: polylineLength(subCoords)
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

    // Edges are used only if their whole drawn polyline stays inside the square
    // (a road that leaves the square on the way is not part of the board).
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

    // 11. Keep the connections simple: remove crossing edges, cap the degree at 4,
    //     then prune dead ends (if excluded) and keep the largest component again.
    const simple = simplifyBoardGraph(largest.nodes, largest.edges, { includeDeadEnds });

    return {
      nodes: simple.nodes,
      edges: simple.edges,
      boardBounds,
      stats: { ...computeGraphStats(simple.nodes, simple.edges), ...simple.info }
    };
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
    const polys = edges.map((e) => edgeCoords(e, nodes).map(([lat, lon]) => proj(lat, lon)));
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
    //     closest in direction to a neighbouring edge, then the longer one. Never a bridge.
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
        const bearings = incident.map((i) => edgeBearingAt(edges[i], nid, polys[i]));
        const cands = incident.map((i, k) => {
          let minAngle = Infinity;
          for (let m = 0; m < incident.length; m++) {
            if (m !== k) minAngle = Math.min(minAngle, angleBetween(bearings[k], bearings[m]));
          }
          const other = edges[i].u === nid ? edges[i].v : edges[i].u;
          return { i, otherDeg: nodes.get(other).neighbors.size, minAngle, len: lengths[i] };
        });
        cands.sort((a, b) => (b.otherDeg - a.otherDeg) || (a.minAngle - b.minAngle) || (b.len - a.len));
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
  function buildWithLocalGrowth(elements, lat, lon, options, coverage) {
    const targetNodes = options.targetNodes || 81;
    const want = wantedNodes(targetNodes);
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

    const centerLat = (bounds.south + bounds.north) / 2;
    const centerLon = (bounds.west + bounds.east) / 2;
    const halfDiag = distanceMeters(bounds.south, bounds.west, bounds.north, bounds.east) / 2;

    if (halfDiag > 3500) {
      throw new StreetGoError('area', '指定した範囲が広すぎます。もう少しズームインして一辺 4km 以内の正方形を引いてください。');
    }

    const fetchRadius = Math.max(120, Math.round(halfDiag + 60));
    report(`選択範囲の道路網を取得中 (半径 ${fetchRadius}m)...`);
    const mode = options.includeFootways ? 'all' : 'simple';
    const elements = await fetchOverpassRoads(centerLat, centerLon, fetchRadius, { signal, allowNetwork, mode });

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
    simplifyBoardGraph,
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
