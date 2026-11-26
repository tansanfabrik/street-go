(function (global) {
  'use strict';

  // Komi scaled to board size (number of intersections).
  function komiForNodeCount(n) {
    if (n < 20) return 0.5;
    if (n < 40) return 2.5;
    if (n < 70) return 4.5;
    return 6.5;
  }

  // Game modes (values of the mode <select>):
  //   'cpu'       human plays Black (moves first), CPU plays White
  //   'cpu-white' human plays White, CPU plays Black (moves first)
  //   'pvp'       two humans alternate on one device
  // Returns the human's colour ('B' | 'W'), or null when there is no CPU.
  function humanColorForMode(mode) {
    if (mode === 'cpu') return 'B';
    if (mode === 'cpu-white') return 'W';
    return null;
  }

  // True when the CPU should move now: a CPU mode, game not over, and it is not the human's turn.
  function isCpuTurn(mode, turn, gameOver) {
    const human = humanColorForMode(mode);
    if (human === null || gameOver) return false;
    return (turn === 'B' || turn === 'W') && turn !== human;
  }

  // How many undo steps one press of "待った" takes (0 = nothing to undo).
  // `actors` runs parallel to engine.history: actors[i] is 'human' or 'cpu', the one who
  // made history[i] (a move or a pass; in pvp every ply is 'human').
  // pvp: one ply. CPU modes: back to (and including) the latest ply made by the human,
  // so the human is to move afterwards; 0 when the human has made no ply at all
  // (e.g. only CPU moves are on the board, even after switching modes).
  function undoStepsForActors(mode, actors) {
    const n = Array.isArray(actors) ? actors.length : 0;
    if (n === 0) return 0;
    if (humanColorForMode(mode) === null) return 1;
    for (let i = n - 1; i >= 0; i--) {
      if (actors[i] === 'human') return n - i;
    }
    return 0;
  }

  class GraphGoEngine {
    constructor(nodesMap, options = {}) {
      this.nodes = nodesMap; // Map<id, { id, lat, lon, neighbors: Set<id> }>
      this.nodeIds = Array.from(nodesMap.keys());
      this.komi = Number.isFinite(options.komi) ? options.komi : komiForNodeCount(this.nodeIds.length);
      this.reset();
    }

    reset() {
      this.board = new Map();
      for (const id of this.nodeIds) {
        this.board.set(id, null);
      }
      this.turn = 'B';
      this.captures = { B: 0, W: 0 };
      // Undo log of diffs. Each entry:
      //   { type: 'move', color, nodeId, capturedIds, addedHash, prev }
      //   { type: 'pass', color, prev }
      // where prev = { captures, consecutivePasses, lastMove, gameOver, moveCount }
      this.history = [];
      this.seenStates = new Set([this._boardHash(this.board)]);
      this.consecutivePasses = 0;
      this.lastMove = null;
      this.gameOver = false;
      this.moveCount = 0;
    }

    _boardHash(boardMap = this.board) {
      let s = '';
      for (let i = 0; i < this.nodeIds.length; i++) {
        const v = boardMap.get(this.nodeIds[i]);
        s += v === 'B' ? 'B' : v === 'W' ? 'W' : '.';
      }
      return s;
    }

    _opponent(color) {
      return color === 'B' ? 'W' : 'B';
    }

    getGroup(startId, boardMap = this.board) {
      const color = boardMap.get(startId);
      if (!color) return null;

      const stones = new Set([startId]);
      const liberties = new Set();
      const queue = [startId];

      for (let qi = 0; qi < queue.length; qi++) {
        const cur = queue[qi];
        const node = this.nodes.get(cur);
        if (!node) continue;
        for (const nb of node.neighbors) {
          const nbColor = boardMap.get(nb);
          if (nbColor === null) {
            liberties.add(nb);
          } else if (nbColor === color && !stones.has(nb)) {
            stones.add(nb);
            queue.push(nb);
          }
        }
      }

      return { color, stones, liberties };
    }

    // Put a stone on this.board in place and remove captured opponent groups.
    // The point must be empty. Returns the captured ids (in removal order).
    _placeStone(nodeId, color) {
      const board = this.board;
      board.set(nodeId, color);
      const opp = this._opponent(color);
      const capturedIds = [];
      const checkedOpp = new Set();
      for (const nb of this.nodes.get(nodeId).neighbors) {
        if (board.get(nb) === opp && !checkedOpp.has(nb)) {
          const grp = this.getGroup(nb);
          for (const sid of grp.stones) checkedOpp.add(sid);
          if (grp.liberties.size === 0) {
            for (const sid of grp.stones) {
              board.set(sid, null);
              capturedIds.push(sid);
            }
          }
        }
      }
      return capturedIds;
    }

    // Exact inverse of _placeStone.
    _unplaceStone(nodeId, color, capturedIds) {
      const board = this.board;
      board.set(nodeId, null);
      const opp = this._opponent(color);
      for (const sid of capturedIds) board.set(sid, opp);
    }

    // Check legality without changing the observable state (play -> inspect -> revert).
    simulateMove(nodeId, color = this.turn) {
      if (!this.nodes.has(nodeId)) {
        return { legal: false, reason: 'invalid' };
      }
      if (this.board.get(nodeId) !== null) {
        return { legal: false, reason: 'occupied' };
      }

      const capturedIds = this._placeStone(nodeId, color);
      try {
        // Suicide rule
        const ownGroup = this.getGroup(nodeId);
        if (ownGroup.liberties.size === 0) {
          return { legal: false, reason: 'suicide' };
        }
        // Positional superko: no repetition of any earlier whole-board position
        const hash = this._boardHash();
        if (this.seenStates.has(hash)) {
          return { legal: false, reason: 'ko' };
        }
        return {
          legal: true,
          capturedIds,
          ownGroup,
          hash
        };
      } finally {
        this._unplaceStone(nodeId, color, capturedIds);
      }
    }

    _prevState() {
      return {
        captures: { B: this.captures.B, W: this.captures.W },
        consecutivePasses: this.consecutivePasses,
        lastMove: this.lastMove,
        gameOver: this.gameOver,
        moveCount: this.moveCount
      };
    }

    playMove(nodeId) {
      if (this.gameOver) {
        return { ok: false, reason: 'gameover' };
      }
      const color = this.turn;
      const sim = this.simulateMove(nodeId, color);
      if (!sim.legal) {
        return { ok: false, reason: sim.reason };
      }

      this.history.push({
        type: 'move',
        color,
        nodeId,
        capturedIds: sim.capturedIds,
        addedHash: sim.hash,
        prev: this._prevState()
      });

      this.board.set(nodeId, color);
      for (const sid of sim.capturedIds) this.board.set(sid, null);
      this.captures[color] += sim.capturedIds.length;
      this.seenStates.add(sim.hash);
      this.lastMove = nodeId;
      this.consecutivePasses = 0;
      this.moveCount += 1;
      this.turn = this._opponent(color);

      return {
        ok: true,
        capturedCount: sim.capturedIds.length,
        capturedIds: sim.capturedIds
      };
    }

    pass() {
      if (this.gameOver) return { ok: false };
      const passedColor = this.turn;
      this.history.push({ type: 'pass', color: passedColor, prev: this._prevState() });

      this.consecutivePasses += 1;
      this.lastMove = null;
      this.moveCount += 1;
      this.turn = this._opponent(this.turn);

      if (this.consecutivePasses >= 2) {
        this.gameOver = true;
      }

      return {
        ok: true,
        passedColor,
        gameOver: this.gameOver
      };
    }

    undo() {
      if (this.history.length === 0) return false;
      const rec = this.history.pop();
      if (rec.type === 'move') {
        this._unplaceStone(rec.nodeId, rec.color, rec.capturedIds);
        // The hash was new when added (superko forbids repeats), so removing it is exact.
        this.seenStates.delete(rec.addedHash);
      }
      const p = rec.prev;
      this.turn = rec.color;
      this.captures = { B: p.captures.B, W: p.captures.W };
      this.consecutivePasses = p.consecutivePasses;
      this.lastMove = p.lastMove;
      this.gameOver = p.gameOver;
      this.moveCount = p.moveCount;
      return true;
    }

    getAtariNodes() {
      const atari = new Set();
      const visited = new Set();
      for (const id of this.nodeIds) {
        if (visited.has(id) || this.board.get(id) === null) continue;
        const grp = this.getGroup(id);
        for (const sid of grp.stones) visited.add(sid);
        if (grp.liberties.size === 1) {
          for (const sid of grp.stones) atari.add(sid);
        }
      }
      return atari;
    }

    computeScore(komi = this.komi) {
      let blackStones = 0;
      let whiteStones = 0;
      for (const id of this.nodeIds) {
        const c = this.board.get(id);
        if (c === 'B') blackStones++;
        else if (c === 'W') whiteStones++;
      }

      const territoryMap = new Map();
      let blackTerritory = 0;
      let whiteTerritory = 0;
      const visited = new Set();

      for (const id of this.nodeIds) {
        if (visited.has(id) || this.board.get(id) !== null) continue;

        const region = [];
        const borders = new Set();
        const queue = [id];
        visited.add(id);

        for (let qi = 0; qi < queue.length; qi++) {
          const cur = queue[qi];
          region.push(cur);
          for (const nb of this.nodes.get(cur).neighbors) {
            const c = this.board.get(nb);
            if (c === null) {
              if (!visited.has(nb)) {
                visited.add(nb);
                queue.push(nb);
              }
            } else {
              borders.add(c);
            }
          }
        }

        if (borders.size === 1) {
          const owner = borders.has('B') ? 'B' : 'W';
          for (const rid of region) territoryMap.set(rid, owner);
          if (owner === 'B') blackTerritory += region.length;
          else whiteTerritory += region.length;
        }
      }

      // Area scoring (Chinese-style): stones on board + surrounded empty intersections.
      // All stones left on the board count as alive (no dead-stone agreement).
      const blackTotal = blackStones + blackTerritory;
      const whiteTotal = whiteStones + whiteTerritory + komi;
      const winner = blackTotal > whiteTotal ? 'B' : 'W';
      const margin = Math.abs(blackTotal - whiteTotal);

      return {
        blackStones,
        whiteStones,
        blackTerritory,
        whiteTerritory,
        blackCaptures: this.captures.B,
        whiteCaptures: this.captures.W,
        komi,
        blackTotal,
        whiteTotal,
        winner,
        margin,
        territoryMap
      };
    }

    chooseCpuMove(color = this.turn) {
      const opp = this._opponent(color);
      let bestMove = null;
      let bestScore = -Infinity;

      // Precompute current atari groups for own color
      const ownAtariLibs = new Map(); // libNodeId -> max rescued group size
      const visited = new Set();
      for (const id of this.nodeIds) {
        if (visited.has(id) || this.board.get(id) !== color) continue;
        const grp = this.getGroup(id);
        for (const sid of grp.stones) visited.add(sid);
        if (grp.liberties.size === 1) {
          const lib = Array.from(grp.liberties)[0];
          const prev = ownAtariLibs.get(lib) || 0;
          ownAtariLibs.set(lib, Math.max(prev, grp.stones.size));
        }
      }

      for (const id of this.nodeIds) {
        if (this.board.get(id) !== null) continue;
        const nbrs = this.nodes.get(id).neighbors;

        // Features of the current (pre-move) position
        let allOwn = nbrs.size > 0;
        for (const nb of nbrs) {
          if (this.board.get(nb) !== color) {
            allOwn = false;
            break;
          }
        }
        let touchesOpp = false;
        let touchesOwn = false;
        for (const nb of nbrs) {
          const c = this.board.get(nb);
          if (c === opp) touchesOpp = true;
          if (c === color) touchesOwn = true;
        }

        // Play -> evaluate -> revert (no board copies)
        let legal = true;
        let capturedCount = 0;
        let ownLiberties = 0;
        const atariAdds = [];
        const capturedIds = this._placeStone(id, color);
        try {
          capturedCount = capturedIds.length;
          const ownGroup = this.getGroup(id);
          ownLiberties = ownGroup.liberties.size;
          if (ownLiberties === 0 || this.seenStates.has(this._boardHash())) {
            legal = false;
          } else {
            // Putting opponent into atari (evaluated on the post-move position)
            const checkedOpp = new Set();
            for (const nb of nbrs) {
              if (this.board.get(nb) === opp && !checkedOpp.has(nb)) {
                const oppGrp = this.getGroup(nb);
                for (const sid of oppGrp.stones) checkedOpp.add(sid);
                if (oppGrp.liberties.size === 1) {
                  atariAdds.push(14 * Math.min(4, oppGrp.stones.size));
                }
              }
            }
          }
        } finally {
          this._unplaceStone(id, color, capturedIds);
        }
        if (!legal) continue;

        let score = Math.random() * 3.5;

        // 1. Capturing opponent stones
        if (capturedCount > 0) {
          score += 32 * capturedCount;
        }

        // 2. Saving own atari group
        if (ownAtariLibs.has(id) && ownLiberties >= 2) {
          score += 24 * ownAtariLibs.get(id);
        }

        // 3. Putting opponent into atari
        for (const add of atariAdds) score += add;

        // 4. Avoid filling own eye
        if (allOwn && capturedCount === 0) {
          score -= 45;
        }

        // 5. Avoid self-atari unless capturing
        if (ownLiberties === 1 && capturedCount === 0) {
          score -= 26;
        }

        // 6. Prefer hubs (more roads = more liberties) and fighting near existing stones
        score += nbrs.size * 1.6;
        if (touchesOpp) score += 4.5;
        if (touchesOwn && !allOwn) score += 2.0;

        if (score > bestScore) {
          bestScore = score;
          bestMove = id;
        }
      }

      if (bestMove === null || bestScore < -15) {
        return null; // Pass
      }
      return bestMove;
    }
  }

  global.GraphGoEngine = GraphGoEngine;
  global.komiForNodeCount = komiForNodeCount;
  global.humanColorForMode = humanColorForMode;
  global.isCpuTurn = isCpuTurn;
  global.undoStepsForActors = undoStepsForActors;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { GraphGoEngine, komiForNodeCount, humanColorForMode, isCpuTurn, undoStepsForActors };
  }
})(typeof window !== 'undefined' ? window : globalThis);
