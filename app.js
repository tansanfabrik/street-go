(function () {
  'use strict';

  // Leaflet (and our own modules) must be present before anything else runs
  if (typeof L === 'undefined' || !window.StreetGoMap || !window.GraphGoEngine) {
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

  // DOM Elements
  const searchForm = document.getElementById('search-form');
  const placeInput = document.getElementById('place-input');
  const generateBtn = document.getElementById('generate-btn');
  const drawSquareBtn = document.getElementById('draw-square-btn');
  const drawBanner = document.getElementById('draw-banner');
  const drawSizeLabel = document.getElementById('draw-size-label');
  const cancelDrawBtn = document.getElementById('cancel-draw-btn');
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

  const passBtn = document.getElementById('pass-btn');
  const undoBtn = document.getElementById('undo-btn');
  const scoreBtn = document.getElementById('score-btn');
  const resetBtn = document.getElementById('reset-btn');

  const hoverHud = document.getElementById('hover-hud');
  const toastEl = document.getElementById('toast');

  // Tile Layer (OpenStreetMap standard tiles, styled via CSS classes so no API key is required)
  const mapEl = document.getElementById('map');
  const map = L.map('map', {
    center: [35.0037, 135.7596], // Kyoto Shijo-Karasuma
    zoom: 16,
    zoomControl: true
  });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    maxZoom: 19
  }).addTo(map);
  mapEl.classList.add('map-style-light');

  const boundaryLayer = L.layerGroup().addTo(map);
  const edgeLayer = L.layerGroup().addTo(map);
  const nodeLayer = L.layerGroup().addTo(map);

  let currentBoardData = null;
  let engine = null;
  let nodeMarkers = new Map(); // id -> { marker, el }
  let edgePolylines = []; // { u, v, polyline }
  let showTerritory = false;
  let highlightedLiberties = new Set();
  let highlightedEdgeKeys = new Set();
  let cpuThinking = false;
  let cpuTimer = null; // at most one pending CPU move
  let toastTimer = null;
  let isGenerating = false;
  let generateController = null; // AbortController of the running generation

  // Square drawing state
  let isDrawMode = false;
  let isDraggingSquare = false;
  let drawStartPt = null;
  let drawPreviewRect = null;
  let lastSquareBounds = null;
  let drawPointerId = null;
  let savedMapInteractions = null;
  let suppressClickUntil = 0; // ignore the click that follows a square drag

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
    } else {
      statusBar.classList.add('hidden');
    }
  }

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.remove('hidden');
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

  function getNodePixelSize() {
    const z = map.getZoom();
    if (z <= 13) return 11;
    if (z === 14) return 14;
    if (z === 15) return 18;
    if (z === 16) return 22;
    if (z === 17) return 26;
    return 30;
  }

  function updateMarkerSizes() {
    const px = getNodePixelSize();
    for (const { marker } of nodeMarkers.values()) {
      const icon = marker.getIcon();
      if (icon && icon.options) {
        icon.options.iconSize = [px, px];
        icon.options.iconAnchor = [px / 2, px / 2];
        const el = marker.getElement();
        if (el) {
          el.style.width = `${px}px`;
          el.style.height = `${px}px`;
          el.style.marginLeft = `${-px / 2}px`;
          el.style.marginTop = `${-px / 2}px`;
        }
      }
    }
  }

  map.on('zoomend', updateMarkerSizes);

  function edgeKey(u, v) {
    return u < v ? `${u}|${v}` : `${v}|${u}`;
  }

  function getBaseEdgeStyle() {
    const isDark = mapStyleSelect.value === 'dark';
    return {
      color: isDark ? '#fb923c' : '#f97316',
      weight: 2.2,
      opacity: isDark ? 0.55 : 0.48
    };
  }

  function getHighlightEdgeStyle() {
    const isDark = mapStyleSelect.value === 'dark';
    return {
      color: isDark ? '#60a5fa' : '#2563eb',
      weight: 3.2,
      opacity: 0.78
    };
  }

  // Render Board Boundary as a clean rectangular board frame + dimmed outside mask
  function renderBoundary() {
    boundaryLayer.clearLayers();
    if (!currentBoardData || currentBoardData.nodes.size === 0) return;

    let rectRing;
    if (currentBoardData.customBounds) {
      const { south, west, north, east } = currentBoardData.customBounds;
      rectRing = [
        [north, west],
        [north, east],
        [south, east],
        [south, west]
      ];
    } else {
      let minLat = Infinity;
      let maxLat = -Infinity;
      let minLon = Infinity;
      let maxLon = -Infinity;

      for (const n of currentBoardData.nodes.values()) {
        if (n.lat < minLat) minLat = n.lat;
        if (n.lat > maxLat) maxLat = n.lat;
        if (n.lon < minLon) minLon = n.lon;
        if (n.lon > maxLon) maxLon = n.lon;
      }
      for (const e of currentBoardData.edges) {
        for (const [lat, lon] of e.coords) {
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
        }
      }

      const midLat = (minLat + maxLat) / 2;
      const cosLat = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
      const padLat = Math.max(22 / 111000, (maxLat - minLat) * 0.045);
      const padLon = Math.max(22 / (111000 * cosLat), (maxLon - minLon) * 0.045);

      rectRing = [
        [maxLat + padLat, minLon - padLon],
        [maxLat + padLat, maxLon + padLon],
        [minLat - padLat, maxLon + padLon],
        [minLat - padLat, minLon - padLon]
      ];
    }

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
      fillColor: isDark ? '#020617' : '#0f172a',
      fillOpacity: isDark ? 0.38 : 0.18,
      interactive: false
    }).addTo(boundaryLayer);

    // Crisp straight-line board border
    L.polygon(rectRing, {
      fill: false,
      color: isDark ? '#93c5fd' : '#1e293b',
      weight: 2.5,
      opacity: isDark ? 0.7 : 0.65,
      lineJoin: 'miter',
      interactive: false
    }).addTo(boundaryLayer);
  }

  // Render Road Edges
  function renderEdges() {
    edgeLayer.clearLayers();
    edgePolylines = [];
    if (!currentBoardData) return;

    const baseStyle = getBaseEdgeStyle();

    for (const edge of currentBoardData.edges) {
      const polyline = L.polyline(edge.coords, {
        ...baseStyle,
        interactive: false
      }).addTo(edgeLayer);
      edgePolylines.push({
        key: edgeKey(edge.u, edge.v),
        u: edge.u,
        v: edge.v,
        polyline
      });
    }
  }

  function updateEdgeHighlights() {
    const baseStyle = getBaseEdgeStyle();
    const hiStyle = getHighlightEdgeStyle();
    for (const item of edgePolylines) {
      item.polyline.setStyle(highlightedEdgeKeys.has(item.key) ? hiStyle : baseStyle);
    }
  }

  // Create Node Markers once per generated board
  function buildNodeMarkers() {
    nodeLayer.clearLayers();
    nodeMarkers.clear();
    if (!currentBoardData) return;

    const px = getNodePixelSize();

    for (const [id, node] of currentBoardData.nodes) {
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
      nodeMarkers.set(id, { marker, el, wrapper, tabIndex: -1, label: '' });

      marker.on('click', () => handleNodeClick(id));
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
          const next = neighborInDirection(id, ARROW_DIRECTIONS[e.key]);
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

  function nodeKindLabel(node) {
    const deg = node.neighbors.size;
    return node.isMidpoint ? '道路の中間点' : (deg === 1 ? '行き止まり' : `${deg}叉路`);
  }

  // Update visual state of all nodes & sidebar HUD
  function renderGameState() {
    if (!engine) return;

    const atariNodes = engine.getAtariNodes();
    const score = engine.computeScore();

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
        if (!engine.gameOver && !cpuThinking && !isGenerating) {
          classes.push(`preview-${engine.turn}`);
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
      turnTextEl.textContent = `終局 — ${score.winner === 'B' ? '黒' : '白'}の勝ち (+${score.margin}目)`;
      resultBox.innerHTML = `
        <strong>終局結果（中国ルール・コミ${score.komi}目）</strong><br>
        黒: ${score.blackTotal}点（石 ${score.blackStones} + 地 ${score.blackTerritory}）<br>
        白: ${score.whiteTotal}点（石 ${score.whiteStones} + 地 ${score.whiteTerritory} + コミ ${score.komi}）<br>
        <strong>勝者: ${score.winner === 'B' ? '黒' : '白'}（${score.margin}目差）</strong>
      `;
      resultBox.classList.remove('hidden');
    } else {
      resultBox.classList.add('hidden');
      const isBlack = engine.turn === 'B';
      turnStoneEl.className = `stone-indicator ${isBlack ? 'black' : 'white'}`;
      if (cpuThinking) {
        turnTextEl.textContent = '白（CPU）が思考中...';
      } else {
        const who = isBlack ? '黒（先手）' : (modeSelect.value === 'cpu' ? '白（CPU）' : '白（後手）');
        turnTextEl.textContent = `${who}の番 — ${engine.moveCount + 1}手目`;
      }
    }

    passBtn.disabled = engine.gameOver || cpuThinking || isGenerating;
    undoBtn.disabled = engine.history.length === 0 || cpuThinking || isGenerating;
    scoreBtn.disabled = isGenerating;
    scoreBtn.classList.toggle('active', showTerritory || engine.gameOver);
    resetBtn.disabled = cpuThinking || isGenerating;
  }

  // Interactions
  function handleNodeHover(id) {
    if (!engine) return;
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
      const atariTag = grp.liberties.size === 1 ? ' ⚠️ アタリ!' : '';
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
      if (!engine.gameOver && !cpuThinking) {
        const sim = engine.simulateMove(id, engine.turn);
        if (!sim.legal) {
          if (sim.reason === 'suicide') statusLine = '<div style="color:#fca5a5;">着手禁止（自殺手）</div>';
          else if (sim.reason === 'ko') statusLine = '<div style="color:#fca5a5;">着手禁止（以前と同じ石の配置には戻せません）</div>';
        } else {
          const capMsg = sim.capturedIds.length > 0 ? ` / ${sim.capturedIds.length}子取れる!` : '';
          statusLine = `<div style="color:#86efac;">着手後の呼吸点: ${sim.ownGroup.liberties.size}${capMsg}</div>`;
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

    if (engine.gameOver || cpuThinking || isGenerating) return;
    if (modeSelect.value === 'cpu' && engine.turn === 'W') return;

    const res = engine.playMove(id);
    if (!res.ok) {
      if (res.reason === 'suicide') showToast('そこは自殺手のため打てません');
      else if (res.reason === 'ko') showToast('以前と同じ石の配置には戻せません');
      else if (res.reason === 'occupied') showToast('すでに石が置かれています');
      return;
    }

    highlightedLiberties.clear();
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

  function maybeTriggerCpuTurn() {
    if (!engine || engine.gameOver || isGenerating) return;
    if (modeSelect.value !== 'cpu' || engine.turn !== 'W') return;
    if (cpuTimer !== null) return; // already scheduled: never more than one

    const scheduledEngine = engine;
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
        modeSelect.value !== 'cpu' ||
        engine.turn !== 'W' ||
        engine.gameOver
      ) {
        if (engine) renderGameState();
        return;
      }
      const moveId = engine.chooseCpuMove('W');

      if (moveId === null) {
        const passRes = engine.pass();
        showToast('白（CPU）はパスしました');
        if (passRes.gameOver) {
          showTerritory = true;
        }
      } else {
        const res = engine.playMove(moveId);
        if (res.ok && res.capturedCount > 0) {
          showToast(`白（CPU）が${res.capturedCount}個の石を取りました`);
        }
      }
      renderGameState();
    }, CPU_DELAY_MS);
  }

  function applyGeneratedBoard(boardData, label) {
    cancelCpuTurn();
    hoverHud.classList.add('hidden');
    highlightedLiberties.clear();
    highlightedEdgeKeys.clear();
    showTerritory = false;

    currentBoardData = boardData;
    engine = new window.GraphGoEngine(boardData.nodes);

    renderBoundary();
    renderEdges();
    buildNodeMarkers();

    if (boardData.customBounds) {
      const b = boardData.customBounds;
      map.fitBounds(L.latLngBounds([b.south, b.west], [b.north, b.east]), { padding: [44, 44], maxZoom: 18 });
    } else {
      const latLngs = Array.from(boardData.nodes.values()).map((n) => [n.lat, n.lon]);
      if (latLngs.length > 0) {
        map.fitBounds(L.latLngBounds(latLngs), { padding: [44, 44], maxZoom: 18 });
      }
    }

    const { nodeCount, edgeCount, avgDegree, maxDegree } = boardData.stats;
    boardStatsEl.textContent = `${nodeCount}交点 / ${edgeCount}道 (平均${avgDegree}・最大${maxDegree}叉路)`;

    renderGameState();
    showToast(`${label}の盤面（${nodeCount}交点）を生成しました`);
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
    hoverHud.classList.add('hidden');
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

  // Board Generation by Drawn Square Bounds
  function generateBoardInBounds(bounds) {
    return runGeneration('選択した正方形の道路網を取得中...', '指定範囲', (signal, onProgress) =>
      window.StreetGoMap.generateStreetGoBoardInBounds(bounds, getBoardOptions(), onProgress, { signal })
    );
  }

  if (cancelGenerateBtn) cancelGenerateBtn.addEventListener('click', () => {
    if (generateController) generateController.abort();
  });

  // Square Drawing Mode
  function enterDrawMode() {
    if (isGenerating) return;
    isDrawMode = true;
    isDraggingSquare = false;
    drawStartPt = null;
    lastSquareBounds = null;
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
    hoverHud.classList.add('hidden');
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

  function exitDrawMode() {
    isDrawMode = false;
    isDraggingSquare = false;
    drawStartPt = null;
    lastSquareBounds = null;
    releaseDrawPointer();
    if (drawPreviewRect) {
      map.removeLayer(drawPreviewRect);
      drawPreviewRect = null;
    }
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
  }

  function computeSquareBounds(startPt, currPt) {
    const dx = currPt.x - startPt.x;
    const dy = currPt.y - startPt.y;
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    const endPt = L.point(
      startPt.x + (dx >= 0 ? 1 : -1) * side,
      startPt.y + (dy >= 0 ? 1 : -1) * side
    );
    const p1 = map.containerPointToLatLng(startPt);
    const p2 = map.containerPointToLatLng(endPt);
    return {
      sidePx: side,
      bounds: {
        south: Math.min(p1.lat, p2.lat),
        north: Math.max(p1.lat, p2.lat),
        west: Math.min(p1.lng, p2.lng),
        east: Math.max(p1.lng, p2.lng)
      }
    };
  }

  // Square drawing with Pointer Events (mouse / touch / pen). Listeners run in the capture
  // phase on the map container so Leaflet and the node markers never see the gesture.
  mapEl.addEventListener('pointerdown', (e) => {
    if (!isDrawMode) return;
    if (e.target && e.target.closest && e.target.closest('.leaflet-control-container')) return;
    if (drawPointerId !== null) return; // ignore extra fingers
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    drawPointerId = e.pointerId;
    try {
      mapEl.setPointerCapture(e.pointerId);
    } catch (err) {
      // capture is best-effort
    }
    isDraggingSquare = true;
    drawStartPt = map.mouseEventToContainerPoint(e);
    lastSquareBounds = null;
    if (drawPreviewRect) {
      map.removeLayer(drawPreviewRect);
      drawPreviewRect = null;
    }
  }, true);

  mapEl.addEventListener('pointermove', (e) => {
    if (!isDrawMode || !isDraggingSquare || !drawStartPt || e.pointerId !== drawPointerId) return;
    e.preventDefault();
    e.stopPropagation();
    updateSquarePreview(map.mouseEventToContainerPoint(e));
  }, true);

  mapEl.addEventListener('pointerup', (e) => {
    if (!isDrawMode || !isDraggingSquare || e.pointerId !== drawPointerId) return;
    e.preventDefault();
    e.stopPropagation();
    const chosen = lastSquareBounds;
    suppressClickUntil = Date.now() + 400;
    exitDrawMode();
    if (chosen) {
      generateBoardInBounds(chosen);
    } else {
      showToast('もう少し大きくドラッグして正方形を引いてください');
    }
  }, true);

  mapEl.addEventListener('pointercancel', (e) => {
    if (!isDrawMode || e.pointerId !== drawPointerId) return;
    // The browser took over the gesture: drop this drag but stay in draw mode
    releaseDrawPointer();
    isDraggingSquare = false;
    drawStartPt = null;
    lastSquareBounds = null;
    if (drawPreviewRect) {
      map.removeLayer(drawPreviewRect);
      drawPreviewRect = null;
    }
    drawSizeLabel.textContent = '';
  }, true);

  function updateSquarePreview(currPt) {
    const { sidePx, bounds } = computeSquareBounds(drawStartPt, currPt);
    lastSquareBounds = sidePx >= 15 ? bounds : null;

    const leafletBounds = [[bounds.south, bounds.west], [bounds.north, bounds.east]];
    if (!drawPreviewRect) {
      drawPreviewRect = L.rectangle(leafletBounds, {
        color: '#2563eb',
        weight: 2.5,
        fillColor: '#3b82f6',
        fillOpacity: 0.14,
        dashArray: '6 4',
        interactive: false
      }).addTo(map);
    } else {
      drawPreviewRect.setBounds(leafletBounds);
    }

    const sideMeters = Math.round(window.StreetGoMap.distanceMeters(
      bounds.south, bounds.west, bounds.north, bounds.west
    ));
    drawSizeLabel.textContent = sideMeters >= 1000
      ? `約 ${(sideMeters / 1000).toFixed(2)}km 四方`
      : `約 ${sideMeters}m 四方`;
  }

  // Tapping the map background clears the stone info shown by a tap
  map.on('click', () => {
    if (!isDrawMode) handleNodeLeave();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isDrawMode) {
      exitDrawMode();
    }
  });

  drawSquareBtn.addEventListener('click', () => {
    if (isDrawMode) exitDrawMode();
    else enterDrawMode();
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

  modeSelect.addEventListener('change', () => {
    cancelCpuTurn();
    if (engine) {
      renderGameState();
      maybeTriggerCpuTurn();
    }
  });

  passBtn.addEventListener('click', () => {
    if (!engine || engine.gameOver || cpuThinking || isGenerating) return;
    const res = engine.pass();
    if (!res.ok) return;
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

  undoBtn.addEventListener('click', () => {
    if (!engine || cpuThinking || isGenerating || engine.history.length === 0) return;
    cancelCpuTurn();
    engine.undo();
    // In CPU mode, if it's now CPU's turn, undo one more step back to human's turn
    if (modeSelect.value === 'cpu' && engine.turn === 'W' && engine.history.length > 0) {
      engine.undo();
    }
    highlightedLiberties.clear();
    renderGameState();
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
    showTerritory = false;
    highlightedLiberties.clear();
    renderGameState();
    showToast('盤面をリセットしました');
  });

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
