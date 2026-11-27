(function () {
  'use strict';

  // Leaflet (and our own modules) must be present before anything else runs.
  // The small mode helpers of go-engine.js are not required: an older cached go-engine.js
  // lacks them, and the copies below are used instead.
  if (
    typeof L === 'undefined' ||
    !window.StreetGoMap ||
    typeof window.StreetGoMap.generateStreetGoBoard !== 'function' ||
    typeof window.GraphGoEngine !== 'function'
  ) {
    const msg = typeof L === 'undefined'
      ? '地図ライブラリ（Leaflet）を読み込めませんでした。ページを再読み込みしてください。'
      : 'アプリのスクリプトを読み込めませんでした。ページを再読み込みしてください。';
    const box = document.getElementById('error-box');
    if (box) {
      box.textContent = msg;
      box.classList.remove('hidden');
    }
    const mapDiv = document.getElementById('map');
    if (mapDiv) {
      const note = document.createElement('div');
      note.className = 'map-load-error';
      note.textContent = msg;
      mapDiv.appendChild(note);
    }
    ['generate-btn', 'draw-square-btn'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = true;
    });
    return;
  }

  const INITIAL_PRESET = '京都 四条烏丸';
  const CPU_DELAY_MS = 320;

  // Mode helpers from go-engine.js; same-behaviour fallbacks for an older cached copy
  const humanColorForMode = typeof window.humanColorForMode === 'function'
    ? window.humanColorForMode
    : (mode) => (mode === 'cpu' ? 'B' : mode === 'cpu-white' ? 'W' : null);
  const isCpuTurn = typeof window.isCpuTurn === 'function'
    ? window.isCpuTurn
    : (mode, turn, gameOver) => {
      const human = humanColorForMode(mode);
      if (human === null || gameOver) return false;
      return (turn === 'B' || turn === 'W') && turn !== human;
    };
  const undoStepsForActors = typeof window.undoStepsForActors === 'function'
    ? window.undoStepsForActors
    : (mode, actors) => {
      const n = Array.isArray(actors) ? actors.length : 0;
      if (n === 0) return 0;
      if (humanColorForMode(mode) === null) return 1;
      for (let i = n - 1; i >= 0; i--) if (actors[i] === 'human') return n - i;
      return 0;
    };

  // DOM Elements
  const searchForm = document.getElementById('search-form');
  const placeInput = document.getElementById('place-input');
  const generateBtn = document.getElementById('generate-btn');
  const drawSquareBtn = document.getElementById('draw-square-btn');
  const drawBanner = document.getElementById('draw-banner');
  const drawSizeLabel = document.getElementById('draw-size-label');
  const cancelDrawBtn = document.getElementById('cancel-draw-btn');
  const drawErrorEl = document.getElementById('draw-error');
  const presetChips = document.querySelectorAll('.chip[data-place]');

  const sizeSelect = document.getElementById('size-select');
  const customSizeRow = document.getElementById('custom-size-row');
  const customSizeInput = document.getElementById('custom-size-input');
  const customSizeNumber = document.getElementById('custom-size-number');
  const targetNodesBadge = document.getElementById('target-nodes-badge');

  const modeSelect = document.getElementById('mode-select');
  const mergeRadiusInput = document.getElementById('merge-radius');
  const mergeRadiusVal = document.getElementById('merge-radius-val');
  const includeDeadEndsInput = document.getElementById('include-deadends');
  const includeFootwaysInput = document.getElementById('include-footways');
  const subdivideRoadsInput = document.getElementById('subdivide-roads');
  const subdivideSpacingGroup = document.getElementById('subdivide-spacing-group');
  const subdivideSpacingInput = document.getElementById('subdivide-spacing');
  const subdivideSpacingVal = document.getElementById('subdivide-spacing-val');
  const mapStyleSelect = document.getElementById('map-style');

  const statusBar = document.getElementById('status-bar');
  const statusText = document.getElementById('status-text');
  const cancelGenerateBtn = document.getElementById('cancel-generate-btn');
  const errorBox = document.getElementById('error-box');

  const boardStatsEl = document.getElementById('board-stats');
  const komiValueEl = document.getElementById('komi-value');
  const turnStoneEl = document.getElementById('turn-stone');
  const turnTextEl = document.getElementById('turn-text');
  const blackStonesEl = document.getElementById('black-stones');
  const blackCapturesEl = document.getElementById('black-captures');
  const blackTerritoryEl = document.getElementById('black-territory');
  const whiteStonesEl = document.getElementById('white-stones');
  const whiteCapturesEl = document.getElementById('white-captures');
  const whiteTerritoryEl = document.getElementById('white-territory');
  const resultBox = document.getElementById('result-box');
  const blackPlayerTagEl = document.getElementById('black-player-tag');
  const whitePlayerTagEl = document.getElementById('white-player-tag');

  const passBtn = document.getElementById('pass-btn');
  const undoBtn = document.getElementById('undo-btn');
  const scoreBtn = document.getElementById('score-btn');
  const resetBtn = document.getElementById('reset-btn');

  const hoverHud = document.getElementById('hover-hud');
  const toastEl = document.getElementById('toast');
  const mapContainerEl = document.getElementById('map-container');

  // Tile Layer (OpenStreetMap standard tiles, styled via CSS classes so no API key is required)
  const mapEl = document.getElementById('map');
  const map = L.map('map', {
    center: [35.0037, 135.7596], // Kyoto Shijo-Karasuma
    zoom: 16,
    zoomControl: true,
    // Fractional zoom lets fitBounds fill small screens (integer steps often leave the board at ~40%)
    zoomSnap: 0.25,
    zoomDelta: 0.5
  });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    maxZoom: 19
  }).addTo(map);
  mapEl.classList.add('map-style-light');

  // Score view panes: the blocks (faces) a colour holds are filled between the tiles (200)
  // and the roads (overlayPane, 400); the roads inside a colour's area are drawn over the
  // roads and under the stones (markerPane, 600)
  map.createPane('territoryFacePane').style.zIndex = '350';
  map.createPane('territoryRoadPane').style.zIndex = '450';
  map.getPane('territoryFacePane').style.pointerEvents = 'none';
  map.getPane('territoryRoadPane').style.pointerEvents = 'none';

  const territoryFaceLayer = L.layerGroup().addTo(map);
  const boundaryLayer = L.layerGroup().addTo(map);
  const edgeLayer = L.layerGroup().addTo(map);
  const territoryRoadLayer = L.layerGroup().addTo(map);
  const nodeLayer = L.layerGroup().addTo(map);

  let currentBoardData = null;
  let engine = null;
  let nodeMarkers = new Map(); // id -> { marker, el, wrapper, tabIndex, label, size (px), dotScale, dotBorder }
  let edgePolylines = []; // { u, v, polyline }
  let showTerritory = false;
  // Faces of the current board (computed once per board, the first time the score view is
  // shown) and what the score view overlay shows now ('' = nothing drawn)
  let boardFaces = null; // { board, faces }
  let territorySignature = '';
  let territoryPolylines = []; // { key, polyline, style }: score view road lines, highlighted with their road
  let highlightedLiberties = new Set();
  let highlightedEdgeKeys = new Set();
  let cpuThinking = false;
  let cpuTimer = null; // at most one pending CPU move
  let toastTimer = null;
  let isGenerating = false;
  let generateController = null; // AbortController of the running generation
  // Who made each ply, parallel to engine.history ('human' | 'cpu'). Same length always:
  // pushed after every successful move / pass, popped with every engine.undo(), cleared
  // with a new engine or engine.reset().
  let plyActors = [];
  // The human's colour (or null in pvp) when the game ended. The result text uses it, so
  // switching modes afterwards does not change who is said to have won. null = not ended.
  let endedWith = null; // { human: 'B' | 'W' | null }
  let pendingFit = false; // fitBounds postponed until the map has a usable size

  // Area drawing state (a rectangle; Shift + mouse drag makes it a square)
  let isDrawMode = false;
  let isDraggingSquare = false;
  let drawStartLatLng = null; // start of the drag as a map position (survives resize / zoom)
  let drawLastClient = null; // last pointer position on the page { clientX, clientY }
  let drawPointerType = '';
  let drawShift = false; // Shift held (squares mouse drags)
  let drawPreviewRect = null;
  let drawPointerId = null;
  let savedMapInteractions = null;
  let suppressClickUntil = 0; // ignore the click that follows an area drag

  // Helpers
  function showToast(msg, duration = 2200) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.add('hidden');
    }, duration);
  }

  function setLoading(loading, msg = '') {
    isGenerating = loading;
    generateBtn.disabled = loading;
    drawSquareBtn.disabled = loading;
    if (cancelGenerateBtn) cancelGenerateBtn.disabled = !loading;
    if (loading) {
      statusText.textContent = msg;
      statusBar.classList.remove('hidden');
      errorBox.classList.add('hidden');
      revealInSidebar(statusBar);
    } else {
      statusBar.classList.add('hidden');
      // An error shown during the run: scroll to it once the status bar has gone, since
      // removing the bar moves it
      if (!errorBox.classList.contains('hidden')) revealInSidebar(errorBox);
    }
  }

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.remove('hidden');
    if (!isGenerating) revealInSidebar(errorBox); // otherwise setLoading(false) does it
  }

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // Scroll the sidebar (only as far as needed) so a status / error line just shown is
  // visible, e.g. when the user had scrolled down to the setup panel on a small screen.
  function revealInSidebar(el) {
    if (!el || typeof el.scrollIntoView !== 'function') return;
    try {
      el.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    } catch (err) {
      el.scrollIntoView(false); // very old browsers: boolean form only
    }
  }

  function getTargetNodes() {
    if (sizeSelect.value === 'custom') {
      return Math.max(20, Math.min(400, parseInt(customSizeNumber.value, 10) || 81));
    }
    return parseInt(sizeSelect.value, 10) || 81;
  }

  function updateTargetBadge() {
    targetNodesBadge.textContent = `${getTargetNodes()} 交点`;
  }

  // Marker size per zoom level (13 -> 13 px ... 18 -> 36 px), interpolated for fractional zoom
  const NODE_PX_BY_ZOOM = [[13, 16], [14, 20], [15, 26], [16, 32], [17, 38], [18, 43]];

  function getNodePixelSize() {
    const z = map.getZoom();
    const first = NODE_PX_BY_ZOOM[0];
    const last = NODE_PX_BY_ZOOM[NODE_PX_BY_ZOOM.length - 1];
    if (!Number.isFinite(z) || z <= first[0]) return first[1];
    if (z >= last[0]) return last[1];
    for (let i = 1; i < NODE_PX_BY_ZOOM.length; i++) {
      const [z1, px1] = NODE_PX_BY_ZOOM[i];
      if (z <= z1) {
        const [z0, px0] = NODE_PX_BY_ZOOM[i - 1];
        return Math.round(px0 + ((z - z0) / (z1 - z0)) * (px1 - px0));
      }
    }
    return last[1];
  }

  // Pure marker helpers from map-graph.js; plain stand-ins for an older cached copy
  // (every point at the base size, a click stays on the marker that got it)
  const nodeStoneDiameters = typeof window.StreetGoMap.nodeStoneDiameters === 'function'
    ? window.StreetGoMap.nodeStoneDiameters
    : (points, neighbors, basePx) => new Map(Array.from(points.keys(), (id) => [id, basePx]));
  const pickNodeAtPoint = typeof window.StreetGoMap.pickNodeAtPoint === 'function'
    ? window.StreetGoMap.pickNodeAtPoint
    : (point, candidates, fallbackId) => fallbackId;

  // Marker diameter of every point at the current zoom (fractional zoom included): the
  // base size, smaller where a road-connected neighbour is close on screen
  function computeNodeSizes() {
    const sizes = new Map();
    if (!currentBoardData) return sizes;
    const zoom = map.getZoom();
    const points = new Map();
    const neighbors = new Map();
    for (const [id, node] of currentBoardData.nodes) {
      points.set(id, map.project([node.lat, node.lon], zoom)); // unrounded pixels
      neighbors.set(id, node.neighbors);
    }
    return nodeStoneDiameters(points, neighbors, getNodePixelSize());
  }

  // Resize one marker to `px` (base: the zoom's base size). The DOM is only written when a
  // value actually changes.
  function applyMarkerSize(entry, px, base) {
    if (!(px > 0)) return;
    if (entry.size !== px) {
      entry.size = px;
      const icon = entry.marker.getIcon();
      if (icon && icon.options) {
        icon.options.iconSize = [px, px];
        icon.options.iconAnchor = [px / 2, px / 2];
      }
      const el = entry.marker.getElement();
      if (el) {
        el.style.width = `${px}px`;
        el.style.height = `${px}px`;
        el.style.marginLeft = `${-px / 2}px`;
        el.style.marginTop = `${-px / 2}px`;
      }
    }
    // An empty point's dot looks the same as at the base size, however small the marker
    // (the stone) is made: the CSS scale and ring width are rescaled by base / px. The ring
    // is whole pixels (Chrome floors a fractional border width, other browsers do not).
    const k = base > 0 ? base / px : 1;
    const dotScale = (0.22 * k).toFixed(4);
    const dotBorder = `${Math.max(1, Math.round(4 / k))}px`;
    if (entry.dotScale !== dotScale || entry.dotBorder !== dotBorder) {
      entry.dotScale = dotScale;
      entry.dotBorder = dotBorder;
      entry.wrapper.style.setProperty('--dot-scale', dotScale);
      entry.wrapper.style.setProperty('--dot-border', dotBorder);
    }
  }

  function updateMarkerSizes() {
    if (nodeMarkers.size === 0) return;
    const sizes = computeNodeSizes();
    const base = getNodePixelSize();
    for (const [id, entry] of nodeMarkers) {
      const px = sizes.get(id);
      applyMarkerSize(entry, px > 0 ? px : base, base);
    }
  }

  map.on('zoomend', updateMarkerSizes);

  // The point a pointer click / tap on marker `id` is meant for: the point whose circle
  // contains the press and whose centre is nearest to it (close points overlap on screen,
  // and the marker on top is not always the one aimed at). A click without a pointer
  // position (detail 0: keyboard or assistive technology) stays on the marker itself.
  function nodeAtPointer(id, ev) {
    if (!ev || ev.detail === 0 || !currentBoardData) return id;
    if (!Number.isFinite(ev.clientX) || !Number.isFinite(ev.clientY)) return id;
    const point = map.mouseEventToContainerPoint(ev);
    const candidates = [];
    for (const [nid, entry] of nodeMarkers) {
      const node = currentBoardData.nodes.get(nid);
      if (!node) continue;
      // The same (rounded) position Leaflet draws the marker at
      const c = map.latLngToContainerPoint([node.lat, node.lon]);
      candidates.push({ id: nid, x: c.x, y: c.y, diameter: entry.size });
    }
    return pickNodeAtPoint(point, candidates, id);
  }

  function edgeKey(u, v) {
    return u < v ? `${u}|${v}` : `${v}|${u}`;
  }

  function getBaseEdgeStyle() {
    const isDark = mapStyleSelect.value === 'dark';
    return {
      color: isDark ? '#cfcfcc' : '#5a5a58',
      weight: 2.2,
      opacity: isDark ? 0.6 : 0.8
    };
  }

  // Drawn-only pieces: the road colour at half the width and half the opacity
  function getTailStyle() {
    const base = getBaseEdgeStyle();
    return { color: base.color, weight: base.weight / 2, opacity: 0.5 };
  }

  function getHighlightEdgeStyle() {
    const isDark = mapStyleSelect.value === 'dark';
    return {
      color: isDark ? '#f6fb7a' : '#1f1f1f',
      weight: 5,
      opacity: 1
    };
  }

  // Render Board Boundary as a rectangular board frame + dimmed outside mask. The frame is a
  // thin dashed line, so it does not read as a road.
  function renderBoundary() {
    boundaryLayer.clearLayers();
    if (!currentBoardData || currentBoardData.nodes.size === 0) return;

    const b = boardRect();
    if (!b) return;
    const rectRing = [
      [b.north, b.west],
      [b.north, b.east],
      [b.south, b.east],
      [b.south, b.west]
    ];

    const isDark = mapStyleSelect.value === 'dark';
    const worldRing = [
      [85, -180],
      [85, 180],
      [-85, 180],
      [-85, -180]
    ];

    // Dim area outside the rectangular board
    L.polygon([worldRing, rectRing], {
      stroke: false,
      fillColor: isDark ? '#000000' : '#1f1f1f',
      fillOpacity: isDark ? 0.38 : 0.18,
      interactive: false
    }).addTo(boundaryLayer);

    // Board border: thinner and lighter than a road, dashed
    L.polygon(rectRing, {
      fill: false,
      color: isDark ? '#cfcfcc' : '#5a5a58',
      weight: 1,
      opacity: 0.7,
      dashArray: '5 5',
      lineJoin: 'miter',
      interactive: false
    }).addTo(boundaryLayer);
  }

  // Map background behind the roads (for the gap a bridge cuts into the road below it)
  function getMapBackgroundColor() {
    return mapStyleSelect.value === 'dark' ? '#2b2b2a' : '#f7f7f6';
  }

  // Render Road Edges. Roads crossing without a shared point (bridges, overpasses) are not
  // joined: the upper road is drawn again over the crossing with a casing in the map's
  // background colour, which leaves a small gap in the road below.
  function renderEdges() {
    edgeLayer.clearLayers();
    edgePolylines = [];
    if (!currentBoardData) return;

    const baseStyle = getBaseEdgeStyle();
    const edges = currentBoardData.edges;
    const tails = Array.isArray(currentBoardData.tails) ? currentBoardData.tails : [];
    const tailStyle = getTailStyle();
    const casingColor = mapStyleSelect.value === 'dark' ? '#1f1f1f' : '#ffffff';
    const casingOf = (style, extra) => ({
      color: casingColor,
      weight: style.weight + (style === tailStyle ? 1.5 : 2),
      opacity: 1,
      smoothFactor: 0,
      interactive: false,
      ...extra
    });

    // Draw order: every casing first, then every line, so a casing never covers a
    // neighbouring road's line at a junction
    for (const edge of edges) {
      L.polyline(edge.coords, casingOf(baseStyle)).addTo(edgeLayer);
    }
    for (const t of tails) {
      if (!Array.isArray(t.coords) || t.coords.length < 2) continue;
      L.polyline(t.coords, casingOf(tailStyle)).addTo(edgeLayer);
    }

    for (const edge of edges) {
      const polyline = L.polyline(edge.coords, {
        ...baseStyle,
        smoothFactor: 0, // draw the shape map-graph chose, without dropping small bends
        interactive: false
      }).addTo(edgeLayer);
      edgePolylines.push({
        key: edgeKey(edge.u, edge.v),
        u: edge.u,
        v: edge.v,
        polyline
      });
    }

    // Pieces of road drawn without points (short dead-end branches, points too close to
    // others): the road colour, thinner and lighter, no stone on them
    for (const t of tails) {
      if (!Array.isArray(t.coords) || t.coords.length < 2) continue;
      L.polyline(t.coords, { ...tailStyle, smoothFactor: 0, interactive: false }).addTo(edgeLayer);
    }

    const bridges = Array.isArray(currentBoardData.bridges) ? currentBoardData.bridges : [];
    for (const br of bridges) {
      if (!Array.isArray(br.overCoords) || br.overCoords.length < 2) continue;
      // older data: the upper line is a road edge given by its index
      const over = br.overTail ? null : (br.overU !== undefined && br.overU !== null ? { u: br.overU, v: br.overV } : edges[br.over]);
      if (!br.overTail && !over) continue;
      L.polyline(br.overCoords, {
        color: getMapBackgroundColor(),
        weight: 8,
        opacity: 1,
        lineCap: 'butt',
        smoothFactor: 0,
        interactive: false
      }).addTo(edgeLayer);
      const overStyle = br.overTail ? tailStyle : baseStyle;
      L.polyline(br.overCoords, casingOf(overStyle, { lineCap: 'butt' })).addTo(edgeLayer);
      const polyline = L.polyline(br.overCoords, {
        ...overStyle,
        lineCap: 'butt',
        smoothFactor: 0,
        interactive: false
      }).addTo(edgeLayer);
      // highlighted together with its road
      if (over) edgePolylines.push({ key: edgeKey(over.u, over.v), u: over.u, v: over.v, polyline });
    }

    // The score view's blocks and roads go with the roads (new board, map style)
    refreshTerritoryOverlay();
  }

  function updateEdgeHighlights() {
    const baseStyle = getBaseEdgeStyle();
    const hiStyle = getHighlightEdgeStyle();
    for (const item of edgePolylines) {
      item.polyline.setStyle(highlightedEdgeKeys.has(item.key) ? hiStyle : baseStyle);
    }
    // The score view's road lines (and bridge tops drawn again over them) follow their road
    for (const item of territoryPolylines) {
      item.polyline.setStyle(highlightedEdgeKeys.has(item.key) ? hiStyle : item.style);
    }
  }

  // ---------------------------------------------------------------------------
  // Score view overlay: the blocks a colour holds and the roads inside its area.
  // A block (face of the road graph) belongs to X when every point on its edge is X's stone
  // or X's territory; a road when both its ends are (board-faces.js).
  const boardFacesApi = window.StreetGoFaces && typeof window.StreetGoFaces.computeBoardFaces === 'function'
    ? window.StreetGoFaces
    : null; // an older cached copy without board-faces.js: only the point marks are shown

  function getTerritoryStyles() {
    if (mapStyleSelect.value === 'dark') {
      return {
        B: {
          face: { fillColor: '#000000', fillOpacity: 0.22 },
          casing: { color: '#cfcfcc', weight: 4.8, opacity: 0.3 },
          road: { color: '#000000', weight: 2.8, opacity: 0.5 }
        },
        W: {
          face: { fillColor: '#ffffff', fillOpacity: 0.14 },
          casing: null,
          road: { color: '#ffffff', weight: 2.8, opacity: 0.6 }
        }
      };
    }
    return {
      B: {
        face: { fillColor: '#1f1f1f', fillOpacity: 0.1 },
        casing: null,
        road: { color: '#1f1f1f', weight: 2.8, opacity: 0.4 }
      },
      W: {
        face: { fillColor: '#ffffff', fillOpacity: 0.28 },
        // keeps the white road apart from the map's own white roads
        casing: { color: '#5a5a58', weight: 4.8, opacity: 0.3 },
        road: { color: '#ffffff', weight: 2.8, opacity: 0.7 }
      }
    };
  }

  // Faces of the current board, computed once per board
  function getBoardFaces() {
    if (!currentBoardData || !boardFacesApi) return [];
    if (!boardFaces || boardFaces.board !== currentBoardData) {
      let faces = [];
      try {
        faces = boardFacesApi.computeBoardFaces(currentBoardData).faces;
      } catch (err) {
        console.warn('Street Go: no blocks for the score view', err);
      }
      boardFaces = { board: currentBoardData, faces };
    }
    return boardFaces.faces;
  }

  function clearTerritoryOverlay() {
    territoryFaceLayer.clearLayers();
    territoryRoadLayer.clearLayers();
    territoryPolylines = [];
    territorySignature = '';
  }

  // Draw (or remove) the overlay for `score` (engine.computeScore()). Nothing is redrawn
  // when the owners have not changed since the last call.
  function renderTerritory(score) {
    const shown = !!engine && (showTerritory || engine.gameOver);
    if (!shown || !currentBoardData || !boardFacesApi || !score) {
      if (territorySignature !== '') clearTerritoryOverlay();
      return;
    }
    const faces = getBoardFaces();
    const edges = Array.isArray(currentBoardData.edges) ? currentBoardData.edges : [];
    const { faceOwners, edgeOwners } = boardFacesApi.territoryOwners(faces, edges, engine.board, score.territoryMap);
    const sig = `${mapStyleSelect.value}|${faceOwners.map((o) => o || '-').join('')}|${edgeOwners.map((o) => o || '-').join('')}`;
    if (sig === territorySignature) return;
    clearTerritoryOverlay();
    territorySignature = sig;

    const styles = getTerritoryStyles();
    faces.forEach((face, i) => {
      const owner = faceOwners[i];
      if (!owner || !Array.isArray(face.ring) || face.ring.length < 3) return;
      L.polygon(face.ring, {
        pane: 'territoryFacePane',
        stroke: false,
        fill: true,
        ...styles[owner].face,
        // a ring of a block next to a bridge may cross itself: fill every part it goes round
        fillRule: 'nonzero',
        smoothFactor: 0,
        interactive: false
      }).addTo(territoryFaceLayer);
    });

    // Roads: every casing first, then every line (as renderEdges does)
    const owned = [];
    edges.forEach((edge, i) => {
      if (edgeOwners[i] && Array.isArray(edge.coords) && edge.coords.length >= 2) owned.push([edge, styles[edgeOwners[i]]]);
    });
    if (owned.length === 0) return;
    const lineOpts = { pane: 'territoryRoadPane', smoothFactor: 0, interactive: false };
    for (const [edge, st] of owned) {
      if (st.casing) L.polyline(edge.coords, { ...st.casing, ...lineOpts }).addTo(territoryRoadLayer);
    }
    const hiStyle = getHighlightEdgeStyle();
    const addLine = (coords, key, style, opts) => {
      const polyline = L.polyline(coords, { ...style, ...opts }).addTo(territoryRoadLayer);
      if (key) {
        territoryPolylines.push({ key, polyline, style });
        if (highlightedEdgeKeys.has(key)) polyline.setStyle(hiStyle);
      }
    };
    for (const [edge, st] of owned) addLine(edge.coords, edgeKey(edge.u, edge.v), st.road, lineOpts);

    // Bridges: the road below may now be drawn over the upper one, so the top of every
    // bridge is drawn again here the way renderEdges draws it (the upper road in its score
    // view colour when it has one)
    const bridges = Array.isArray(currentBoardData.bridges) ? currentBoardData.bridges : [];
    if (bridges.length === 0) return;
    const ownerByKey = new Map();
    edges.forEach((edge, i) => {
      if (edgeOwners[i]) ownerByKey.set(edgeKey(edge.u, edge.v), edgeOwners[i]);
    });
    const baseStyle = getBaseEdgeStyle();
    const tailStyle = getTailStyle();
    const casingColor = mapStyleSelect.value === 'dark' ? '#1f1f1f' : '#ffffff';
    for (const br of bridges) {
      if (!Array.isArray(br.overCoords) || br.overCoords.length < 2) continue;
      const over = br.overTail ? null : (br.overU !== undefined && br.overU !== null ? { u: br.overU, v: br.overV } : edges[br.over]);
      if (!br.overTail && !over) continue;
      const overStyle = br.overTail ? tailStyle : baseStyle;
      const key = over ? edgeKey(over.u, over.v) : null;
      const owner = key ? ownerByKey.get(key) : null;
      const opts = { ...lineOpts, lineCap: 'butt' };
      L.polyline(br.overCoords, { color: getMapBackgroundColor(), weight: 8, opacity: 1, ...opts }).addTo(territoryRoadLayer);
      L.polyline(br.overCoords, {
        color: casingColor,
        weight: overStyle.weight + (overStyle === tailStyle ? 1.5 : 2),
        opacity: 1,
        ...opts
      }).addTo(territoryRoadLayer);
      if (owner) {
        const st = styles[owner];
        if (st.casing) L.polyline(br.overCoords, { ...st.casing, ...opts }).addTo(territoryRoadLayer);
        addLine(br.overCoords, key, st.road, opts);
      } else {
        addLine(br.overCoords, key, overStyle, opts);
      }
    }
  }

  // Redraw the overlay from scratch (new board, map style, roads redrawn)
  function refreshTerritoryOverlay() {
    clearTerritoryOverlay();
    if (engine && currentBoardData) renderTerritory(engine.computeScore());
  }

  // Create Node Markers once per generated board
  function buildNodeMarkers() {
    nodeLayer.clearLayers();
    nodeMarkers.clear();
    if (!currentBoardData) return;

    const base = getNodePixelSize();
    const sizes = computeNodeSizes();

    for (const [id, node] of currentBoardData.nodes) {
      const size = sizes.get(id);
      const px = size > 0 ? size : base;
      const icon = L.divIcon({
        className: 'go-node-wrapper',
        html: `<div class="go-node empty" data-id="${id}"></div>`,
        iconSize: [px, px],
        iconAnchor: [px / 2, px / 2]
      });

      const marker = L.marker([node.lat, node.lon], {
        icon,
        keyboard: false
      }).addTo(nodeLayer);

      const wrapper = marker.getElement();
      const el = wrapper.querySelector('.go-node');
      // Keyboard access: empty points are tabbable (set in renderGameState), Enter/Space plays
      wrapper.setAttribute('role', 'button');
      wrapper.tabIndex = -1;
      const entry = { marker, el, wrapper, tabIndex: -1, label: '', size: px, dotScale: '', dotBorder: '' };
      nodeMarkers.set(id, entry);
      applyMarkerSize(entry, px, base); // the empty-point dot of a smaller marker

      // Pointer clicks / taps go to the nearest point under the press (see nodeAtPointer)
      marker.on('click', (e) => handleNodeClick(nodeAtPointer(id, e && e.originalEvent)));
      marker.on('mouseover', () => handleNodeHover(id));
      marker.on('mouseout', () => handleNodeLeave());
      wrapper.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault();
          e.stopPropagation();
          handleNodeClick(id);
        } else if (ARROW_DIRECTIONS[e.key]) {
          // Arrow keys move the focus along a road to the neighbour in that direction
          // (stones included; focusing shows the liberties like hovering does)
          e.preventDefault();
          e.stopPropagation();
          cyclePivot = null;
          const next = neighborInDirection(id, ARROW_DIRECTIONS[e.key]);
          if (next !== null) {
            const target = nodeMarkers.get(next);
            if (target) target.wrapper.focus();
          }
        } else if (e.key === ']' || e.key === '[') {
          // ] / [ go round every point joined to this one (clockwise / anticlockwise) and back:
          // points with 5 or more roads have neighbours no arrow key reaches. Stones included.
          e.preventDefault();
          e.stopPropagation();
          const next = cycleNeighbor(id, e.key === ']' ? 1 : -1);
          if (next !== null) {
            const target = nodeMarkers.get(next);
            if (target) target.wrapper.focus();
          }
        }
      });
      wrapper.addEventListener('focus', () => handleNodeHover(id));
      wrapper.addEventListener('blur', () => handleNodeLeave());
    }
  }

  // The point whose neighbours the ] / [ keys go round (null: start at the focused point)
  let cyclePivot = null;

  function cycleNeighbor(id, step) {
    if (!currentBoardData) return null;
    const nodes = currentBoardData.nodes;
    // keep going round the same point while the focus is on it or one of its neighbours
    if (cyclePivot === null || !nodes.has(cyclePivot) || (cyclePivot !== id && !nodes.get(cyclePivot).neighbors.has(id))) {
      cyclePivot = id;
    }
    const pivot = nodes.get(cyclePivot);
    if (!pivot || pivot.neighbors.size === 0) return null;
    const c = map.latLngToContainerPoint([pivot.lat, pivot.lon]);
    const around = Array.from(pivot.neighbors).map((nb) => {
      const n = nodes.get(nb);
      const p = map.latLngToContainerPoint([n.lat, n.lon]);
      return { id: nb, x: p.x, y: p.y };
    });
    const order = window.StreetGoMap.neighborsClockwise
      ? window.StreetGoMap.neighborsClockwise({ x: c.x, y: c.y }, around)
      : around.map((n) => n.id);
    return window.StreetGoMap.nextInCycle
      ? window.StreetGoMap.nextInCycle(cyclePivot, order, id, step)
      : order[0];
  }

  // Screen directions for the arrow keys (container pixels, y grows downwards)
  const ARROW_DIRECTIONS = {
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0]
  };

  // Road-connected neighbour of `id` closest to the given screen direction (within 90 deg)
  function neighborInDirection(id, [dx, dy]) {
    if (!currentBoardData) return null;
    const node = currentBoardData.nodes.get(id);
    if (!node) return null;
    const p0 = map.latLngToContainerPoint([node.lat, node.lon]);
    let best = null;
    let bestCos = 0;
    for (const nb of node.neighbors) {
      const n = currentBoardData.nodes.get(nb);
      const p = map.latLngToContainerPoint([n.lat, n.lon]);
      const vx = p.x - p0.x;
      const vy = p.y - p0.y;
      const len = Math.hypot(vx, vy);
      if (len === 0) continue;
      const cos = (vx * dx + vy * dy) / len;
      if (cos > bestCos) {
        bestCos = cos;
        best = nb;
      }
    }
    return best;
  }

  // What a point is: a junction ("3叉路"), a dead end (one road), or a point in the middle of
  // a road (loops, a second route, long roads)
  function nodeKindLabel(node) {
    const deg = node.neighbors.size;
    if (node.kind === 'deadEnd') return '行き止まり';
    if (node.kind === 'shape' || node.kind === 'midpoint' || node.isMidpoint) return '道路の中間点';
    return deg === 1 ? '行き止まり' : `${deg}叉路`;
  }

  // --- Game mode helpers (the pure rules live in go-engine.js) ---
  function currentMode() {
    return modeSelect.value;
  }

  function colorLabel(color) {
    return color === 'B' ? '黒' : '白';
  }

  // Keep endedWith in step with the engine: record the mode's human colour the first time
  // the game is seen as over, forget it once the game is open again (undo, reset, new board).
  function syncEndedWith() {
    if (engine && engine.gameOver) {
      if (!endedWith) endedWith = { human: humanColorForMode(currentMode()) };
    } else {
      endedWith = null;
    }
  }

  // Human colour used for "あなた" / "CPU" labels: fixed at the end of a game, else the mode's
  function labelHumanColor() {
    if (engine && engine.gameOver && endedWith) return endedWith.human;
    return humanColorForMode(currentMode());
  }

  // "あなた（黒）" / "CPU（白）" in CPU games, "黒" / "白" otherwise
  function playerLabel(color) {
    const human = labelHumanColor();
    if (human === null) return colorLabel(color);
    return `${color === human ? 'あなた' : 'CPU'}（${colorLabel(color)}）`;
  }

  // Record who made the ply just added to engine.history
  function recordPly(actor) {
    plyActors.push(actor);
    syncPlyActors();
  }

  // Safety net: plyActors must have exactly engine.history.length entries. Should they
  // ever differ, unknown plies count as the CPU's (待った never removes more than the
  // human played).
  function syncPlyActors() {
    const n = engine ? engine.history.length : 0;
    if (plyActors.length > n) plyActors.length = n;
    while (plyActors.length < n) plyActors.unshift('cpu');
  }

  function currentUndoSteps() {
    if (!engine) return 0;
    syncPlyActors();
    return undoStepsForActors(currentMode(), plyActors);
  }

  // Can the person at the screen place a stone / pass right now?
  function humanCanAct() {
    return !!engine &&
      !engine.gameOver &&
      !cpuThinking &&
      !isGenerating &&
      !isCpuTurn(currentMode(), engine.turn, engine.gameOver);
  }

  function updatePlayerTags() {
    const human = labelHumanColor();
    for (const [el, color] of [[blackPlayerTagEl, 'B'], [whitePlayerTagEl, 'W']]) {
      if (!el) continue; // optional: old cached HTML
      if (human === null) {
        el.hidden = true;
        el.textContent = '';
      } else {
        el.textContent = color === human ? 'あなた' : 'CPU';
        el.hidden = false;
      }
    }
  }

  function renderResultBox(score) {
    const winnerText = `${playerLabel(score.winner)}の ${score.margin} 目勝ち`;
    resultBox.innerHTML = `
      <div class="result-heading">終局結果</div>
      <p class="result-winner">${winnerText}</p>
      <ul class="result-breakdown">
        <li><span class="stone-dot black" aria-hidden="true"></span><span class="result-color">黒</span> <span>石 ${score.blackStones} + 囲んだ交点 ${score.blackTerritory} = ${score.blackTotal}</span></li>
        <li><span class="stone-dot white" aria-hidden="true"></span><span class="result-color">白</span> <span>石 ${score.whiteStones} + 囲んだ交点 ${score.whiteTerritory} + コミ ${score.komi} = ${score.whiteTotal}</span></li>
      </ul>
      <p class="result-note">数え方とコミの説明は「ルールと注意」にあります。</p>
    `;
  }

  // Update visual state of all nodes & sidebar HUD
  function renderGameState() {
    if (!engine) return;

    const human = humanColorForMode(currentMode());
    const canAct = humanCanAct();
    const atariNodes = engine.getAtariNodes();
    const score = engine.computeScore();
    syncEndedWith();
    updatePlayerTags();

    for (const [id, entry] of nodeMarkers) {
      const { el, wrapper } = entry;
      const stone = engine.board.get(id);

      // Accessibility attributes (only touch the DOM when something changed)
      const tabIndex = stone === null ? 0 : -1;
      if (entry.tabIndex !== tabIndex) {
        wrapper.tabIndex = tabIndex;
        entry.tabIndex = tabIndex;
      }
      const label = stone === null
        ? `空き交点（${nodeKindLabel(currentBoardData.nodes.get(id))}）`
        : (stone === 'B' ? '黒石' : '白石') + (atariNodes.has(id) ? '（アタリ）' : '');
      if (entry.label !== label) {
        wrapper.setAttribute('aria-label', label);
        entry.label = label;
      }
      const classes = ['go-node'];

      if (stone === null) {
        classes.push('empty');
        // Preview in the human's colour (pvp: the colour to move), only when they can play
        if (canAct) {
          classes.push(`preview-${human || engine.turn}`);
        }
        if (showTerritory || engine.gameOver) {
          const owner = score.territoryMap.get(id);
          if (owner === 'B') classes.push('territory-B');
          else if (owner === 'W') classes.push('territory-W');
        }
      } else {
        classes.push(`stone-${stone}`);
        if (engine.lastMove === id) classes.push('last-move');
        if (atariNodes.has(id)) classes.push('atari');
      }

      if (highlightedLiberties.has(id)) {
        classes.push('liberty-highlight');
      }

      el.className = classes.join(' ');
    }

    // Score view: blocks and roads held by a colour (redrawn only when they change)
    renderTerritory(score);

    // Update Sidebar Stats
    blackStonesEl.textContent = score.blackStones;
    blackCapturesEl.textContent = score.blackCaptures;
    blackTerritoryEl.textContent = score.blackTerritory;
    whiteStonesEl.textContent = score.whiteStones;
    whiteCapturesEl.textContent = score.whiteCaptures;
    whiteTerritoryEl.textContent = score.whiteTerritory;
    if (komiValueEl) komiValueEl.textContent = `${score.komi}目`;

    // Turn Banner
    if (engine.gameOver) {
      turnStoneEl.className = `stone-indicator ${score.winner === 'B' ? 'black' : 'white'}`;
      turnTextEl.textContent = `終局 — ${playerLabel(score.winner)}の勝ち (+${score.margin}目)`;
      renderResultBox(score);
      resultBox.classList.remove('hidden');
    } else {
      resultBox.classList.add('hidden');
      const isBlack = engine.turn === 'B';
      turnStoneEl.className = `stone-indicator ${isBlack ? 'black' : 'white'}`;
      if (human !== null && engine.turn !== human) {
        // CPU's turn (normally it is already thinking; while a new board is generated it waits)
        turnTextEl.textContent = cpuThinking
          ? `${playerLabel(engine.turn)}が思考中...`
          : `${playerLabel(engine.turn)}の番 — ${engine.moveCount + 1}手目`;
      } else {
        const who = human !== null
          ? playerLabel(engine.turn)
          : (isBlack ? '黒（先手）' : '白（後手）');
        turnTextEl.textContent = `${who}の番 — ${engine.moveCount + 1}手目`;
      }
    }

    passBtn.disabled = !canAct;
    undoBtn.disabled = currentUndoSteps() === 0 || cpuThinking || isGenerating;
    scoreBtn.disabled = isGenerating;
    const territoryShown = showTerritory || engine.gameOver;
    scoreBtn.classList.toggle('active', territoryShown);
    scoreBtn.setAttribute('aria-pressed', String(territoryShown));
    resetBtn.disabled = cpuThinking || isGenerating;
  }

  // Interactions
  function handleNodeHover(id) {
    // No hover / focus info while drawing an area (a touch drag starting on a point
    // would otherwise light it up)
    if (!engine || isDrawMode) return;
    const node = currentBoardData.nodes.get(id);
    const stone = engine.board.get(id);
    highlightedLiberties.clear();
    highlightedEdgeKeys.clear();

    if (stone !== null) {
      const grp = engine.getGroup(id);
      for (const libId of grp.liberties) {
        highlightedLiberties.add(libId);
      }
      // Highlight roads connecting this group and its liberties
      for (const sid of grp.stones) {
        for (const nb of currentBoardData.nodes.get(sid).neighbors) {
          if (grp.stones.has(nb) || grp.liberties.has(nb)) {
            highlightedEdgeKeys.add(edgeKey(sid, nb));
          }
        }
      }
      updateEdgeHighlights();
      const colorName = stone === 'B' ? '黒石' : '白石';
      const atariTag = grp.liberties.size === 1 ? ' <span class="atari-dot"></span>アタリ!' : '';
      hoverHud.innerHTML = `
        <div><strong>${colorName}</strong>（連: ${grp.stones.size}子）</div>
        <div>残り呼吸点: <strong>${grp.liberties.size}</strong>${atariTag}</div>
        <div class="muted">この交点の道数: ${node.neighbors.size}本</div>
      `;
      hoverHud.classList.remove('hidden');
      renderGameState();
    } else {
      for (const nb of node.neighbors) {
        highlightedEdgeKeys.add(edgeKey(id, nb));
      }
      updateEdgeHighlights();
      const deg = node.neighbors.size;
      const kindLabel = nodeKindLabel(node);
      let statusLine = '';
      if (humanCanAct()) {
        const sim = engine.simulateMove(id, engine.turn);
        if (!sim.legal) {
          if (sim.reason === 'suicide') statusLine = '<div style="color:#1f1f1f;">着手禁止（自殺手）</div>';
          else if (sim.reason === 'ko') statusLine = '<div style="color:#1f1f1f;">着手禁止（以前と同じ石の配置には戻せません）</div>';
        } else {
          const capMsg = sim.capturedIds.length > 0 ? ` / ${sim.capturedIds.length}子取れる!` : '';
          statusLine = `<div style="color:#1f1f1f;">着手後の呼吸点: ${sim.ownGroup.liberties.size}${capMsg}</div>`;
        }
      }
      hoverHud.innerHTML = `
        <div><strong>空き交点</strong>（${kindLabel}）</div>
        <div>つながる道（最大呼吸点）: <strong>${deg}</strong></div>
        ${statusLine}
      `;
      hoverHud.classList.remove('hidden');
    }
  }

  // The position changed (move, CPU reply, pass, undo, reset, mode change, new board):
  // the hover HUD and the highlighted roads / liberties describe the old position, so drop
  // them. The caller re-renders the board.
  function clearHover() {
    hoverHud.classList.add('hidden');
    highlightedLiberties.clear();
    if (highlightedEdgeKeys.size > 0) {
      highlightedEdgeKeys.clear();
      updateEdgeHighlights();
    }
  }

  function handleNodeLeave() {
    hoverHud.classList.add('hidden');
    if (highlightedEdgeKeys.size > 0) {
      highlightedEdgeKeys.clear();
      updateEdgeHighlights();
    }
    if (highlightedLiberties.size > 0) {
      highlightedLiberties.clear();
      renderGameState();
    }
  }

  function handleNodeClick(id) {
    if (isDrawMode || !engine) return;
    if (Date.now() < suppressClickUntil) return;

    // Tapping / clicking a stone shows its liberties (same as hover)
    if (engine.board.get(id) !== null) {
      handleNodeHover(id);
      return;
    }

    // Not the human's turn (game over, CPU to move / thinking, generating): ignore
    if (!humanCanAct()) return;

    const res = engine.playMove(id);
    if (!res.ok) {
      if (res.reason === 'suicide') showToast('そこは自殺手のため打てません');
      else if (res.reason === 'ko') showToast('以前と同じ石の配置には戻せません');
      else if (res.reason === 'occupied') showToast('すでに石が置かれています');
      return;
    }

    recordPly('human');
    clearHover();
    if (res.capturedCount > 0) {
      showToast(`${res.capturedCount}個の石を取りました！`);
    }

    renderGameState();
    maybeTriggerCpuTurn();
  }

  // Cancel any pending CPU move (mode change, new board, reset, undo)
  function cancelCpuTurn() {
    if (cpuTimer !== null) {
      clearTimeout(cpuTimer);
      cpuTimer = null;
    }
    cpuThinking = false;
  }

  // Schedule the CPU's move when it is the CPU's turn (the CPU's colour follows the mode:
  // White in "cpu", Black in "cpu-white"). Called after every human action, undo, reset,
  // mode change and board generation.
  function maybeTriggerCpuTurn() {
    if (!engine || engine.gameOver || isGenerating) return;
    if (!isCpuTurn(currentMode(), engine.turn, engine.gameOver)) return;
    if (cpuTimer !== null) return; // already scheduled: never more than one

    const scheduledEngine = engine;
    const cpuColor = engine.turn;
    cpuThinking = true;
    renderGameState();

    cpuTimer = setTimeout(() => {
      cpuTimer = null;
      cpuThinking = false;
      // Re-check everything right before moving
      if (
        !engine ||
        engine !== scheduledEngine ||
        isGenerating ||
        engine.gameOver ||
        engine.turn !== cpuColor ||
        !isCpuTurn(currentMode(), engine.turn, engine.gameOver)
      ) {
        if (engine) renderGameState();
        return;
      }
      const moveId = engine.chooseCpuMove(cpuColor);
      const who = `${colorLabel(cpuColor)}（CPU）`;

      // chooseCpuMove only returns legal points; a rejected move falls back to a pass so the
      // game never stalls on the CPU's turn
      const res = moveId === null ? null : engine.playMove(moveId);
      if (!res || !res.ok) {
        const passRes = engine.pass();
        if (passRes.ok) recordPly('cpu');
        showToast(`${who}はパスしました`);
        if (passRes.gameOver) {
          showTerritory = true;
        }
      } else {
        recordPly('cpu');
        if (res.capturedCount > 0) showToast(`${who}が${res.capturedCount}個の石を取りました`);
      }
      clearHover();
      renderGameState();
    }, CPU_DELAY_MS);
  }

  // Small map areas (phones) get a thin margin around the board so it can fill the width.
  // Stacked layout (same width as the CSS): notices and the zoom buttons sit at the top of
  // the map and the attribution at the bottom, so the board keeps clear of them there
  // (at least 72 px, or below the notice when it is taller). Returns [topLeft, bottomRight].
  const STACKED_MEDIA = '(max-width: 780px)';
  function boardFitPadding() {
    const size = map.getSize();
    const p = Math.min(size.x, size.y) < 420 ? 16 : 44;
    if (!(window.matchMedia && window.matchMedia(STACKED_MEDIA).matches)) return [[p, p], [p, p]];
    let top = Math.max(p, 72);
    if (!toastEl.classList.contains('hidden')) {
      top = Math.max(top, toastEl.offsetTop + toastEl.offsetHeight + 10);
    }
    return [[p, top], [p, Math.max(p, 44)]];
  }

  function isRect(b) {
    return !!b && [b.south, b.west, b.north, b.east].every(Number.isFinite) && b.north > b.south && b.east > b.west;
  }

  // The board frame (frameBounds): its points and lines with a small margin, cut to the
  // rectangle the roads were cut to. For a drawn range that rectangle is the drawn one with
  // its sides moved to the nearest ring of roads, so the frame may reach past the drawn
  // range. Roads leaving the range end at their last junction inside. The mask and the fit
  // use the same rectangle.
  function boardRect() {
    if (!currentBoardData || currentBoardData.nodes.size === 0) return null;
    if (isRect(currentBoardData.frameBounds)) return currentBoardData.frameBounds;
    if (isRect(currentBoardData.boardBounds)) return currentBoardData.boardBounds;
    if (isRect(currentBoardData.customBounds)) return currentBoardData.customBounds;
    return null;
  }

  // Fit to the same rectangle the frame is drawn on, so the whole frame is on screen
  function boardLatLngBounds() {
    if (!currentBoardData) return null;
    const b = boardRect();
    if (b) return L.latLngBounds([b.south, b.west], [b.north, b.east]);
    const latLngs = Array.from(currentBoardData.nodes.values()).map((n) => [n.lat, n.lon]);
    return latLngs.length > 0 ? L.latLngBounds(latLngs) : null;
  }

  // Fit the map to the current board, without animation (a zoom animation still running
  // from earlier would otherwise swallow the move). If the map has no usable size right now
  // (hidden, zero height, or smaller than the padding), postpone: the resize watcher runs
  // it once the size is positive again.
  function fitBoard() {
    const bounds = boardLatLngBounds();
    if (!bounds) {
      pendingFit = false;
      return;
    }
    map.invalidateSize({ animate: false });
    const size = map.getSize();
    const [topLeft, bottomRight] = boardFitPadding();
    if (!(size.x - topLeft[0] - bottomRight[0] > 0 && size.y - topLeft[1] - bottomRight[1] > 0)) {
      pendingFit = true;
      return;
    }
    pendingFit = false;
    map.stop();
    map.fitBounds(bounds, { paddingTopLeft: topLeft, paddingBottomRight: bottomRight, maxZoom: 18, animate: false });
  }

  // Keep Leaflet's idea of the map size equal to the real one: the result box, error box,
  // status bar, panel toggles and screen rotation all change the map area. Bursts of
  // resize events are folded into one invalidateSize per animation frame.
  let resizeFrame = null;
  function onMapAreaResize() {
    if (resizeFrame !== null) return;
    const raf = window.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
    resizeFrame = raf(() => {
      resizeFrame = null;
      map.invalidateSize({ animate: false });
      if (pendingFit) fitBoard();
    });
  }
  if (typeof window.ResizeObserver === 'function' && mapContainerEl) {
    new window.ResizeObserver(onMapAreaResize).observe(mapContainerEl);
  } else {
    window.addEventListener('resize', onMapAreaResize);
    window.addEventListener('orientationchange', onMapAreaResize);
  }

  function applyGeneratedBoard(boardData, label) {
    cancelCpuTurn();
    clearHover();
    showTerritory = false;

    currentBoardData = boardData;
    engine = new window.GraphGoEngine(boardData.nodes);
    plyActors = [];
    endedWith = null;

    renderBoundary();
    renderEdges();
    buildNodeMarkers();

    const { nodeCount, edgeCount, avgDegree, maxDegree } = boardData.stats;
    boardStatsEl.textContent = `${nodeCount}交点 / ${edgeCount}道 (平均${avgDegree}・最大${maxDegree}叉路)`;
    const quality = boardData.stats.quality;
    const warnings = (quality && Array.isArray(quality.warnings) ? quality.warnings : [])
      .concat(Array.isArray(boardData.stats.notices) ? boardData.stats.notices : []);
    // Settle the sidebar height before measuring the map: the new game state (an old result
    // box goes away) and the yellow status bar, which setLoading(false) hides later in this
    // same task anyway. Stacked layouts otherwise fit the board into a map that then grows,
    // leaving it small and off-centre.
    renderGameState();
    statusBar.classList.add('hidden');

    // The notice first: on narrow screens it sits at the top of the map and the fit
    // keeps the board below it
    if (warnings.length > 0) {
      showToast(`${label}の盤面（${nodeCount}交点）を生成しました。${warnings.join('')}`, 6000);
    } else {
      showToast(`${label}の盤面（${nodeCount}交点）を生成しました`);
    }

    // Close the panel first, then re-measure the map, then fit (a stale size leaves the board small)
    closeSetupIfCompact();
    fitBoard();
    flashDrawnRect(boardData.drawnBounds);
  }

  // A drawn range: the rectangle as drawn stays on the map for a moment (0.6 s) over the new
  // board, whose frame may reach past it (the sides moved to the nearest ring of roads)
  let drawnFlash = null;
  function flashDrawnRect(b) {
    if (drawnFlash) {
      clearTimeout(drawnFlash.timer);
      map.removeLayer(drawnFlash.layer);
      drawnFlash = null;
    }
    if (!isRect(b)) return;
    const layer = L.rectangle([[b.south, b.west], [b.north, b.east]], {
      color: mapStyleSelect.value === 'dark' ? '#f7f7f6' : '#1f1f1f',
      weight: 1.5,
      fill: false,
      dashArray: '6 4',
      interactive: false
    }).addTo(map);
    const flash = { layer, timer: null };
    flash.timer = setTimeout(() => {
      map.removeLayer(layer);
      if (drawnFlash === flash) drawnFlash = null;
    }, 600);
    drawnFlash = flash;
  }

  function getBoardOptions() {
    return {
      targetNodes: getTargetNodes(),
      mergeRadiusMeters: parseInt(mergeRadiusInput.value, 10) || 30,
      includeDeadEnds: includeDeadEndsInput.checked,
      // Footpaths / alleys use a separate Overpass query; no bundled data for it.
      // Changing it never triggers a request by itself: it applies on the next generation.
      includeFootways: includeFootwaysInput ? includeFootwaysInput.checked : false,
      subdivideLongRoads: subdivideRoadsInput.checked,
      subdivideSpacingMeters: parseInt(subdivideSpacingInput.value, 10) || 80
    };
  }

  function isAbortError(err) {
    return !!err && (err.kind === 'aborted' || err.name === 'AbortError');
  }

  // Shared wrapper: one generation at a time, cancellable, always restores the UI (finally)
  async function runGeneration(startMsg, label, task) {
    if (isGenerating) return;
    if (isDrawMode) exitDrawMode();

    const controller = new AbortController();
    generateController = controller;
    setLoading(true, startMsg);
    clearHover();
    // The current board is frozen while the next one is being built
    cancelCpuTurn();
    if (engine) renderGameState();

    try {
      const boardData = await task(controller.signal, (msg) => {
        if (generateController === controller) statusText.textContent = msg;
      });
      if (controller.signal.aborted) throw Object.assign(new Error('aborted'), { kind: 'aborted' });
      applyGeneratedBoard(boardData, label);
    } catch (err) {
      if (isAbortError(err)) {
        showToast('生成をキャンセルしました');
      } else if (err && err.kind === 'small-board' && err.board && !controller.signal.aborted) {
        // Only a board of fewer than 9 points was found: used if the player says so
        if (window.confirm(err.message)) applyGeneratedBoard(err.board, label);
        else showToast('盤面の生成をやめました');
      } else {
        showError((err && err.message) || '盤面の生成中にエラーが発生しました。');
      }
    } finally {
      if (generateController === controller) generateController = null;
      setLoading(false);
      if (engine) {
        // Failure / cancel: resume the previous board where it stopped (CPU included)
        renderGameState();
        maybeTriggerCpuTurn();
      }
    }
  }

  // Board Generation by Place Name (bundled presets are used without any network access)
  function generateBoard(placeQuery, ctx = {}) {
    const query = (placeQuery || '').trim();
    if (!query) return Promise.resolve();
    const allowNetwork = ctx.allowNetwork !== false;
    return runGeneration(`「${query}」を検索中...`, `「${query}」`, (signal, onProgress) =>
      window.StreetGoMap.generateStreetGoBoard(query, getBoardOptions(), onProgress, { signal, allowNetwork })
    );
  }

  // Board Generation by Drawn Area Bounds
  function generateBoardInBounds(bounds) {
    return runGeneration('選択した範囲の道路網を取得中...', '指定範囲', (signal, onProgress) =>
      window.StreetGoMap.generateStreetGoBoardInBounds(bounds, getBoardOptions(), onProgress, { signal })
    );
  }

  if (cancelGenerateBtn) cancelGenerateBtn.addEventListener('click', () => {
    if (generateController) generateController.abort();
  });

  // Area Drawing Mode
  function enterDrawMode() {
    if (isGenerating) return;
    isDrawMode = true;
    isDraggingSquare = false;
    drawStartLatLng = null;
    drawLastClient = null;
    drawPointerType = '';
    drawShift = false;
    drawPointerId = null;
    // Disable map gestures while drawing; restore the previous state on exit
    savedMapInteractions = {};
    for (const name of ['dragging', 'touchZoom', 'doubleClickZoom', 'boxZoom']) {
      const handler = map[name];
      if (handler) {
        savedMapInteractions[name] = handler.enabled();
        handler.disable();
      }
    }
    mapEl.classList.add('draw-mode');
    drawSquareBtn.classList.add('active');
    drawBanner.classList.remove('hidden');
    drawSizeLabel.textContent = '';
    setDrawError('');
    // No hover / focus info while drawing: drop what is shown now
    handleNodeLeave();
    // A notice left over from the last action would cover the banner on small screens
    toastEl.classList.add('hidden');
  }

  // The banner's live region: written only when a finished drag is refused (and the
  // draw mode goes on), emptied on the next drag and when the draw mode ends
  function setDrawError(msg) {
    if (drawErrorEl && drawErrorEl.textContent !== msg) drawErrorEl.textContent = msg;
  }

  function releaseDrawPointer() {
    if (drawPointerId !== null) {
      try {
        if (mapEl.hasPointerCapture(drawPointerId)) mapEl.releasePointerCapture(drawPointerId);
      } catch (err) {
        // pointer already gone
      }
      drawPointerId = null;
    }
  }

  // Drop the current drag (if any); draw mode itself stays as it is
  function resetDrawDrag() {
    isDraggingSquare = false;
    drawStartLatLng = null;
    drawLastClient = null;
    drawPointerType = '';
    releaseDrawPointer();
    if (drawPreviewRect) {
      map.removeLayer(drawPreviewRect);
      drawPreviewRect = null;
    }
  }

  function exitDrawMode() {
    isDrawMode = false;
    resetDrawDrag();
    if (savedMapInteractions) {
      for (const [name, wasEnabled] of Object.entries(savedMapInteractions)) {
        if (wasEnabled && map[name]) map[name].enable();
      }
      savedMapInteractions = null;
    }
    mapEl.classList.remove('draw-mode');
    drawSquareBtn.classList.remove('active');
    drawBanner.classList.add('hidden');
    drawSizeLabel.textContent = '';
    setDrawError('');
  }

  // The current drag as map bounds. The start is kept as a map position and the pointer
  // as a page position, and both are turned into map pixels now: after a resize or a zoom
  // during the drag, the preview and the final area still agree. `square` (Shift + mouse)
  // stretches the shorter side to the longer one on screen, as the square-only drawing did.
  function computeDrawBounds(client, square) {
    const SGM = window.StreetGoMap;
    // Unrounded (latLngToContainerPoint rounds to whole pixels); the start corner itself
    // is the kept map position
    const startPt = map.layerPointToContainerPoint(map.project(drawStartLatLng).subtract(map.getPixelOrigin()));
    const currPt = map.mouseEventToContainerPoint(client);
    const r = SGM.dragRectPx(startPt, currPt, square);
    const p1 = drawStartLatLng;
    const p2 = map.containerPointToLatLng(L.point(r.end.x, r.end.y));
    const bounds = {
      south: Math.min(p1.lat, p2.lat),
      north: Math.max(p1.lat, p2.lat),
      west: Math.min(p1.lng, p2.lng),
      east: Math.max(p1.lng, p2.lng)
    };
    const { widthM, heightM } = SGM.rectSizeMeters(bounds);
    return {
      bounds,
      widthM,
      heightM,
      check: SGM.checkDrawnRect({ widthM, heightM, widthPx: r.widthPx, heightPx: r.heightPx })
    };
  }

  // Shift squares only mouse drags (touch and pen have no Shift key)
  function drawSquareLock() {
    return drawPointerType === 'mouse' && drawShift;
  }

  function clientPos(e) {
    return { clientX: e.clientX, clientY: e.clientY };
  }

  // Area drawing with Pointer Events (mouse / touch / pen). Listeners run in the capture
  // phase on the map container so Leaflet and the node markers never see the gesture.
  mapEl.addEventListener('pointerdown', (e) => {
    if (!isDrawMode) return;
    if (e.target && e.target.closest && e.target.closest('.leaflet-control-container')) return;
    if (drawPointerId !== null) return; // ignore extra fingers
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    resetDrawDrag();
    drawPointerId = e.pointerId;
    try {
      mapEl.setPointerCapture(e.pointerId);
    } catch (err) {
      // capture is best-effort
    }
    isDraggingSquare = true;
    drawPointerType = e.pointerType || 'mouse';
    drawShift = !!e.shiftKey;
    drawStartLatLng = map.containerPointToLatLng(map.mouseEventToContainerPoint(e));
    drawLastClient = clientPos(e);
    drawSizeLabel.textContent = '';
    setDrawError('');
  }, true);

  mapEl.addEventListener('pointermove', (e) => {
    if (!isDrawMode || !isDraggingSquare || !drawStartLatLng || e.pointerId !== drawPointerId) return;
    e.preventDefault();
    e.stopPropagation();
    drawShift = !!e.shiftKey;
    updateDrawPreview(clientPos(e));
  }, true);

  mapEl.addEventListener('pointerup', (e) => {
    if (!isDrawMode || !isDraggingSquare || !drawStartLatLng || e.pointerId !== drawPointerId) return;
    e.preventDefault();
    e.stopPropagation();
    drawShift = !!e.shiftKey;
    const drawn = updateDrawPreview(clientPos(e));
    suppressClickUntil = Date.now() + 400;
    if (drawn.check.kind === 'too-small') {
      exitDrawMode();
      showToast(drawn.check.message);
      return;
    }
    // Longitudes of a wrapped world copy are brought back to -180..180; an area across
    // the antimeridian is not supported
    const place = window.StreetGoMap.normalizeDrawnBounds(drawn.bounds);
    if (!place.ok || drawn.check.kind === 'too-thin') {
      // Stay in draw mode: drop this drag and say why in the banner's live region
      resetDrawDrag();
      drawSizeLabel.textContent = '';
      setDrawError(place.ok ? drawn.check.message : place.message);
      return;
    }
    exitDrawMode();
    // OK, or too large: generation rejects a too large area with its usual message
    generateBoardInBounds(place.bounds);
  }, true);

  mapEl.addEventListener('pointercancel', (e) => {
    if (!isDrawMode || e.pointerId !== drawPointerId) return;
    // The browser took over the gesture: drop this drag but stay in draw mode
    resetDrawDrag();
    drawSizeLabel.textContent = '';
  }, true);

  function updateDrawPreview(client) {
    drawLastClient = client;
    const drawn = computeDrawBounds(client, drawSquareLock());
    const { bounds } = drawn;

    const leafletBounds = [[bounds.south, bounds.west], [bounds.north, bounds.east]];
    if (!drawPreviewRect) {
      drawPreviewRect = L.rectangle(leafletBounds, {
        color: mapStyleSelect.value === 'dark' ? '#f7f7f6' : '#1f1f1f',
        weight: 1.5,
        fillColor: '#c6d7db',
        fillOpacity: 0.35,
        dashArray: '6 4',
        interactive: false
      }).addTo(map);
    } else {
      drawPreviewRect.setBounds(leafletBounds);
    }

    // wider ranges are made from the major roads only (see drawRoadMode)
    const major = drawn.check.ok && Math.max(drawn.widthM, drawn.heightM) > window.StreetGoMap.DRAW_SIMPLE_MAX_M;
    drawSizeLabel.textContent = window.StreetGoMap.formatRectSize(drawn.widthM, drawn.heightM) + (major ? '・大通りのみ' : '');
    return drawn;
  }

  // Redraw the preview from the kept start / pointer (map resized, zoomed or moved, or
  // Shift pressed / released) so it always shows what releasing would choose
  function refreshDrawPreview() {
    if (!isDrawMode || !isDraggingSquare || !drawStartLatLng || !drawLastClient) return;
    updateDrawPreview(drawLastClient);
  }
  map.on('move zoom resize viewreset', refreshDrawPreview);

  // Tapping the map background clears the stone info shown by a tap
  map.on('click', () => {
    if (!isDrawMode) handleNodeLeave();
  });

  window.addEventListener('keydown', (e) => {
    // While the rules dialog is open, Esc only closes the dialog (never the draw mode)
    if (isRulesDialogOpen()) {
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.stopPropagation();
        if (!dialogIsModalCapable) {
          e.preventDefault();
          closeRulesDialog();
        }
      }
      return;
    }
    if (e.key === 'Escape' && isDrawMode) {
      exitDrawMode();
      return;
    }
    if (e.key === 'Shift') setDrawShift(e.shiftKey);
  });

  // e.shiftKey (not the key itself): with both Shift keys down, releasing one keeps it true
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') setDrawShift(e.shiftKey);
  });

  // Keys released while the window had no focus never send keyup
  window.addEventListener('blur', () => setDrawShift(false));

  function setDrawShift(down) {
    const next = !!down;
    if (drawShift === next) return;
    drawShift = next;
    if (drawPointerType === 'mouse') refreshDrawPreview();
  }

  drawSquareBtn.addEventListener('click', () => {
    if (isDrawMode) exitDrawMode();
    else {
      enterDrawMode();
      if (isDrawMode) closeSetupIfCompact();
    }
  });

  cancelDrawBtn.addEventListener('click', exitDrawMode);

  // Event Listeners
  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    generateBoard(placeInput.value);
  });

  presetChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      if (isGenerating) return;
      const place = chip.getAttribute('data-place');
      placeInput.value = place;
      generateBoard(place);
    });
  });

  sizeSelect.addEventListener('change', () => {
    const isCustom = sizeSelect.value === 'custom';
    customSizeRow.classList.toggle('hidden', !isCustom);
    updateTargetBadge();
  });

  customSizeInput.addEventListener('input', () => {
    customSizeNumber.value = customSizeInput.value;
    updateTargetBadge();
  });

  customSizeNumber.addEventListener('input', () => {
    const v = Math.max(20, Math.min(400, parseInt(customSizeNumber.value, 10) || 81));
    customSizeInput.value = v;
    updateTargetBadge();
  });

  mergeRadiusInput.addEventListener('input', () => {
    mergeRadiusVal.textContent = `${mergeRadiusInput.value}m`;
  });

  subdivideRoadsInput.addEventListener('change', () => {
    subdivideSpacingGroup.classList.toggle('hidden', !subdivideRoadsInput.checked);
  });

  subdivideSpacingInput.addEventListener('input', () => {
    subdivideSpacingVal.textContent = `${subdivideSpacingInput.value}m`;
  });

  mapStyleSelect.addEventListener('change', () => {
    const style = mapStyleSelect.value;
    mapEl.classList.remove('map-style-light', 'map-style-dark', 'map-style-osm');
    mapEl.classList.add(`map-style-${style}`);
    renderBoundary();
    renderEdges();
  });

  // Switching modes keeps the current position: any pending CPU move is dropped, and if the
  // side to move now belongs to the CPU (e.g. switching to "あなたが白" on a fresh board),
  // the CPU moves. The human can always act otherwise, so nobody is ever stuck.
  // A finished game keeps the result as it was announced (endedWith).
  modeSelect.addEventListener('change', () => {
    cancelCpuTurn();
    clearHover();
    updatePlayerTags();
    if (engine) {
      renderGameState();
      maybeTriggerCpuTurn();
    }
  });

  passBtn.addEventListener('click', () => {
    if (!humanCanAct()) return;
    const res = engine.pass();
    if (!res.ok) return;
    recordPly('human');
    clearHover();
    const colorName = res.passedColor === 'B' ? '黒' : '白';
    if (res.gameOver) {
      showTerritory = true;
      showToast('両者パスにより終局しました');
    } else {
      showToast(`${colorName}がパスしました`);
    }
    renderGameState();
    maybeTriggerCpuTurn();
  });

  // 待った: pvp takes back one ply. CPU games go back to just before the latest ply the
  // human made (usually the CPU's reply + the human's move = 2 plies), so the human is to
  // move again. Plies made only by the CPU (its first move as Black, or moves it made
  // before / after a mode switch with no human ply in between) are never taken back alone.
  undoBtn.addEventListener('click', () => {
    if (!engine || cpuThinking || isGenerating) return;
    const steps = currentUndoSteps();
    if (steps === 0) return;
    cancelCpuTurn();
    for (let i = 0; i < steps; i++) {
      if (!engine.undo()) break;
      plyActors.pop();
    }
    syncPlyActors();
    clearHover();
    renderGameState();
    // Safety net: should the position still be the CPU's turn, the CPU moves again
    maybeTriggerCpuTurn();
  });

  scoreBtn.addEventListener('click', () => {
    if (!engine || isGenerating) return;
    showTerritory = !showTerritory;
    renderGameState();
  });

  resetBtn.addEventListener('click', () => {
    if (!engine || cpuThinking || isGenerating) return;
    cancelCpuTurn();
    engine.reset();
    plyActors = [];
    endedWith = null;
    showTerritory = false;
    clearHover();
    renderGameState();
    showToast('盤面をリセットしました');
    // "あなたが白": the CPU opens the new game as Black
    maybeTriggerCpuTurn();
  });

  // Setup panel: open state is synced with hidden + aria-expanded.
  // Compact screens (narrow, or too short for the open panel) fold the setup panel away
  // after use. Keep this query identical to the "Compact" @media rule in style.css.
  const COMPACT_MEDIA = '(max-width: 780px), (max-height: 860px)';
  const compactQuery = window.matchMedia ? window.matchMedia(COMPACT_MEDIA) : { matches: false };
  const setupPanel = document.getElementById('setup-panel');
  const toggleSetupBtn = document.getElementById('toggle-setup');
  const toggleRulesBtn = document.getElementById('toggle-rules');
  // An older cached HTML has no toggle button: the setup panel then always stays open
  const setupToggleAvailable = !!(setupPanel && toggleSetupBtn);

  function setPanelOpen(panel, btn, open) {
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  }

  function afterPanelChange() {
    map.invalidateSize({ animate: false });
  }

  function closeSetupIfCompact() {
    if (!setupToggleAvailable || !compactQuery.matches || setupPanel.hidden) return;
    // Focus inside the panel would vanish with it: hand it to the toggle button
    if (setupPanel.contains(document.activeElement)) toggleSetupBtn.focus();
    setPanelOpen(setupPanel, toggleSetupBtn, false);
    afterPanelChange();
  }

  if (setupToggleAvailable) {
    toggleSetupBtn.addEventListener('click', () => {
      setPanelOpen(setupPanel, toggleSetupBtn, setupPanel.hidden);
      afterPanelChange();
    });
    setPanelOpen(setupPanel, toggleSetupBtn, !compactQuery.matches);
  }
  // Safari < 14 has only the older addListener on MediaQueryList
  if (typeof compactQuery.addEventListener === 'function') {
    compactQuery.addEventListener('change', afterPanelChange);
  } else if (typeof compactQuery.addListener === 'function') {
    compactQuery.addListener(afterPanelChange);
  }
  afterPanelChange();

  // Rules: a modal <dialog>. Closes with the x button, Esc (built in) or a click on the
  // backdrop; focus returns to the "ルールと注意" button. Browsers without showModal()
  // get a plain open attribute (shown fixed in the middle by CSS) plus a stand-in backdrop
  // and a minimal focus trap.
  const rulesDialog = document.getElementById('rules-dialog');
  const rulesCloseBtn = document.getElementById('rules-close-btn');
  const dialogIsModalCapable = !!rulesDialog && typeof rulesDialog.showModal === 'function';
  let fallbackBackdrop = null;

  function isRulesDialogOpen() {
    return !!rulesDialog && (rulesDialog.open || rulesDialog.hasAttribute('open'));
  }

  function dialogFocusables() {
    return Array.from(rulesDialog.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter((el) => el.offsetParent !== null || el === document.activeElement);
  }

  function openRulesDialog() {
    if (!rulesDialog || isRulesDialogOpen()) return;
    if (dialogIsModalCapable) {
      rulesDialog.showModal();
    } else {
      if (!fallbackBackdrop) {
        fallbackBackdrop = document.createElement('div');
        fallbackBackdrop.className = 'rules-backdrop';
        fallbackBackdrop.setAttribute('aria-hidden', 'true');
        fallbackBackdrop.addEventListener('click', closeRulesDialog);
        rulesDialog.parentNode.insertBefore(fallbackBackdrop, rulesDialog);
      }
      fallbackBackdrop.hidden = false;
      rulesDialog.setAttribute('open', '');
      if (rulesCloseBtn) rulesCloseBtn.focus();
    }
  }

  function closeRulesDialog() {
    if (!rulesDialog) return;
    if (dialogIsModalCapable) {
      if (rulesDialog.open) rulesDialog.close(); // the 'close' event restores focus
    } else if (rulesDialog.hasAttribute('open')) {
      rulesDialog.removeAttribute('open');
      if (fallbackBackdrop) fallbackBackdrop.hidden = true;
      if (toggleRulesBtn) toggleRulesBtn.focus();
    }
  }

  if (rulesDialog && toggleRulesBtn) {
    toggleRulesBtn.addEventListener('click', openRulesDialog);
    if (rulesCloseBtn) rulesCloseBtn.addEventListener('click', closeRulesDialog);
    // Backdrop click: the dialog itself is the target only outside its content (it has no
    // padding). Require the press to start there too, so a text drag that ends outside
    // does not close it.
    let pressStartedOnBackdrop = false;
    rulesDialog.addEventListener('pointerdown', (e) => {
      pressStartedOnBackdrop = e.target === rulesDialog;
    });
    rulesDialog.addEventListener('click', (e) => {
      if (e.target === rulesDialog && pressStartedOnBackdrop) closeRulesDialog();
      pressStartedOnBackdrop = false;
    });
    rulesDialog.addEventListener('close', () => {
      // Not every browser hands focus back to the opener
      if (document.activeElement !== toggleRulesBtn) toggleRulesBtn.focus();
    });
    // Esc while the dialog is open never reaches other handlers (e.g. the draw mode)
    rulesDialog.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.stopPropagation();
        if (!dialogIsModalCapable) {
          e.preventDefault();
          closeRulesDialog();
        }
        return;
      }
      // Fallback only (showModal keeps focus inside by itself): Tab wraps around
      if (!dialogIsModalCapable && e.key === 'Tab') {
        const items = dialogFocusables();
        if (items.length === 0) {
          e.preventDefault();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === first || !rulesDialog.contains(document.activeElement))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });
    if (!dialogIsModalCapable) {
      // Focus that still escapes (e.g. a click elsewhere) is brought back into the dialog
      document.addEventListener('focusin', (e) => {
        if (!isRulesDialogOpen() || rulesDialog.contains(e.target)) return;
        if (rulesCloseBtn) rulesCloseBtn.focus();
      });
    }
  }

  // Initial load: build the Kyoto Shijo-Karasuma board from bundled data only
  // (no Nominatim / Overpass request on page load).
  updateTargetBadge();
  placeInput.value = INITIAL_PRESET;
  // Elements added in later versions may be missing if an old cached HTML is paired with
  // this script; every such element is optional and falls back to its default.
  if (includeFootwaysInput) includeFootwaysInput.checked = false; // bundled data is the simple query
  mergeRadiusVal.textContent = `${mergeRadiusInput.value}m`; // in case the browser restored the slider
  generateBoard(INITIAL_PRESET, { allowNetwork: false });
})();
