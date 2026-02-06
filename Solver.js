function yield() {
  return new Promise(r=>setTimeout(r,1));
}

const BOARD_MAX_KEY = 95; // Board slots 0..95; 96-107 = build shelf; 108+ = spare

class Solver {
  constructor(weights={}) {
    this.setWeights(weights.buildRate, weights.expBonus, weights.flaggy, weights.stepsPenalty)
  }

  setWeights(buildRate, expBonus, flaggy, stepsPenalty = 0) {
    this.weights = {
      buildRate: buildRate || 0,
      expBonus: expBonus || 0,
      flaggy: flaggy || 0,
      stepsPenalty: Number(stepsPenalty) || 0
    }
  }

  /** Number of cogs that are not in their initial position (proxy for steps to apply). */
  _movedCount(state) {
    return state.cogKeys.filter((k) => {
      const cog = state.get(k);
      return cog && Number.parseInt(cog.key, 10) !== Number.parseInt(cog.initialKey, 10);
    }).length;
  }

  /** Effective score: raw score minus penalty for number of cogs moved (to prefer fewer steps). */
  getEffectiveScore(state, inventory) {
    const raw = this.getScoreSum(state.score, inventory);
    const penalty = (this.weights.stepsPenalty || 0) * this._movedCount(state);
    return raw - penalty;
  }

  /** True if swapping these two cogs does not change board score (same stats for scoring). */
  _cogsEquivalentForScore(a, b) {
    return (a.buildRate || 0) === (b.buildRate || 0)
      && (a.expBonus || 0) === (b.expBonus || 0)
      && (a.flaggy || 0) === (b.flaggy || 0)
      && (a.buildRadiusBoost || 0) === (b.buildRadiusBoost || 0)
      && (a.expRadiusBoost || 0) === (b.expRadiusBoost || 0)
      && (a.flaggyRadiusBoost || 0) === (b.flaggyRadiusBoost || 0)
      && (a.boostRadius || "") === (b.boostRadius || "")
      && !!a.isPlayer === !!b.isPlayer
      && (a.flagBoost || 0) === (b.flagBoost || 0);
  }

  /** Reduce steps without changing score: swap equivalent cogs that are in each other's initial positions. */
  minimizeSteps(inventory, inventoryRef) {
    const goal = inventory.score;
    let changed = true;
    while (changed) {
      changed = false;
      const moved = Object.values(inventory.cogs).filter(
        (c) => !c.fixed && Number.parseInt(c.key, 10) !== Number.parseInt(c.initialKey, 10)
      );
      for (let i = 0; i < moved.length && !changed; i++) {
        for (let j = i + 1; j < moved.length && !changed; j++) {
          const A = moved[i], B = moved[j];
          const ak = Number.parseInt(A.key, 10), bk = Number.parseInt(B.key, 10);
          const ai = Number.parseInt(A.initialKey, 10), bi = Number.parseInt(B.initialKey, 10);
          if (ak !== bi || bk !== ai) continue;
          if (!this._cogsEquivalentForScore(A, B)) continue;
          inventory.move(ak, bk);
          const s = inventory.score;
          if (s.buildRate === goal.buildRate && s.flaggy === goal.flaggy && s.expBonus === goal.expBonus
            && s.expBoost === goal.expBoost && s.flagBoost === goal.flagBoost) {
            changed = true;
            console.log("Step optimization: swapped equivalent cogs at", ak, "and", bk, "(both now in initial position)");
          } else {
            inventory.move(ak, bk);
          }
        }
      }
    }
  }

  /**
   * Get normalization factors from inventory for fair exp/flaggy scaling.
   * Uses actual player count and flag count when available.
   */
  _getNorm(inventory) {
    if (!inventory) return { playerCount: 10, flagCount: 4 };
    const playerCount = Math.max(1, Object.values(inventory.cogs).filter(c => c.isPlayer).length);
    const flagCount = Math.max(1, (inventory.flagPose && inventory.flagPose.length) || 4);
    return { playerCount, flagCount };
  }

  getScoreSum(score, inventory = null) {
    const { playerCount, flagCount } = this._getNorm(inventory);
    let res = 0;
    res += score.buildRate * this.weights.buildRate;
    res += score.expBonus * this.weights.expBonus * (score.expBoost + playerCount) / playerCount;
    res += score.flaggy * this.weights.flaggy * (score.flagBoost + flagCount) / flagCount;
    return res;
  }

  static _yield() {
    return new Promise(r=>setTimeout(r,1));
  }

  /** Return keys of cogs that are on the board (0..95) and not fixed */
  _boardCogKeys(state) {
    return state.cogKeys.filter(k => {
      const keyNum = Number.parseInt(k, 10);
      if (keyNum > BOARD_MAX_KEY) return false;
      const cog = state.get(k);
      return cog && !cog.fixed;
    });
  }

  /**
   * Try a random move: either move a cog to an empty slot, or swap two cogs on the board.
   * Returns { key1, key2 } if a move was performed (so caller can revert with state.move(key1, key2)), else null.
   */
  _randomMove(state, allSlots) {
    const useSwap = Math.random() < 0.4;
    const boardCogs = this._boardCogKeys(state);

    if (useSwap && boardCogs.length >= 2) {
      const i = Math.floor(Math.random() * boardCogs.length);
      let j = Math.floor(Math.random() * boardCogs.length);
      if (j === i) j = (j + 1) % boardCogs.length;
      const key1 = boardCogs[i];
      const key2 = boardCogs[j];
      state.move(key1, key2);
      return { key1, key2 };
    }

    const slotKey = allSlots[Math.floor(Math.random() * allSlots.length)];
    const allKeys = state.cogKeys;
    const cogKey = allKeys[Math.floor(Math.random() * allKeys.length)];
    const slot = state.get(slotKey);
    const cog = state.get(cogKey);

    if (slot.fixed || cog.fixed || cog.position().location === "build") return null;
    state.move(slotKey, cogKey);
    return { key1: slotKey, key2: cogKey };
  }

  /**
   * solveTime: Number - Time in ms how long the solver should run
   * Uses simulated annealing: accepts worse moves with probability exp(delta/T), T decreases over time.
   */
  async solve(inventory, solveTime=1000) {
    if (inventory.flagPose.length === 0) {
      this.weights.flaggy = 0;
    }
    console.log("Solving with goal:", this.weights);
    let lastYield = Date.now();
    let state = inventory.clone();
    const solutions = [state];
    const startTime = Date.now();
    const allSlots = inventory.availableSlotKeys;
    let counter = 0;
    let currentScore = this.getEffectiveScore(state, inventory);

    // Simulated annealing: T decays from T0 to T_min over the full solve time
    const T0 = Math.max(1, Math.abs(currentScore) * 0.2);
    const T_min = Math.max(1e-6, T0 * 0.001);

    const getT = () => {
      const elapsed = Date.now() - startTime;
      const t = Math.min(1, elapsed / Math.max(1, solveTime));
      return T_min + (T0 - T_min) * (1 - t);
    };

    console.log("Optimizing (simulated annealing + swap moves)");
    while (Date.now() - startTime < solveTime) {
      if (Date.now() - lastYield > 100) {
        await Solver._yield();
        lastYield = Date.now();
      }
      counter++;

      // Periodic restart from a shuffled state to escape bad basins
      if (counter % 12000 === 0 && counter > 0) {
        state = inventory.clone();
        this.shuffle(state);
        currentScore = this.getEffectiveScore(state, inventory);
        solutions.push(state);
      }

      const prevStateScore = currentScore;
      const move = this._randomMove(state, allSlots);
      if (!move) continue;

      const scoreSumUpdate = this.getEffectiveScore(state, inventory);
      const delta = scoreSumUpdate - prevStateScore;
      const T = getT();
      const accept = delta > 0 || (T > T_min && Math.random() < Math.exp(delta / T));

      if (accept) {
        currentScore = scoreSumUpdate;
      } else {
        state.move(move.key1, move.key2);
      }
    }

    solutions.push(state);
    console.log(`Tried ${counter} moves`);
    const scores = solutions.map((s) => this.getEffectiveScore(s, inventory));
    const bestLocalIndex = scores.indexOf(Math.max(...scores));
    let best = solutions[bestLocalIndex];
    const bestScore = scores[bestLocalIndex];

    if (typeof g !== "undefined" && (g.best === null || this.getEffectiveScore(g.best, inventory) < bestScore)) {
      console.log("Best solution was attempt", bestLocalIndex);
      g.best = best;
    } else if (typeof g !== "undefined" && g.best) {
      best = g.best;
    }
    this.removeUselesMoves(best, inventory);
    this.minimizeSteps(best, inventory);
    return best;
  }

  shuffle(inventory, n = 500) {
    const allSlots = inventory.availableSlotKeys;
    for (let i = 0; i < n; i++) {
      const slotKey = allSlots[Math.floor(Math.random() * allSlots.length)];
      const allKeys = inventory.cogKeys;
      const cogKey = allKeys[Math.floor(Math.random() * allKeys.length)];
      const slot = inventory.get(slotKey);
      const cog = inventory.get(cogKey);

      if (slot.fixed || cog.fixed || cog.position().location === "build") continue;
      inventory.move(slotKey, cogKey);
    }
  }

  removeUselesMoves(inventory, invRef = null) {
    const goal = inventory.score;
    let prevMoved = -1;
    while (prevMoved !== this._movedCount(inventory)) {
      prevMoved = this._movedCount(inventory);
      const cogsToMove = Object.values(inventory.cogs)
        .filter((c) => c.key !== c.initialKey);
      for (let i = 0; i < cogsToMove.length; i++) {
        const cog1 = cogsToMove[i];
        const cog1Key = cog1.key;
        const cog2Key = cog1.initialKey;
        inventory.move(cog1Key, cog2Key);
        const changed = inventory.score;
        if (changed.buildRate === goal.buildRate
          && changed.flaggy === goal.flaggy
          && changed.expBonus === goal.expBonus
          && changed.expBoost === goal.expBoost
          && changed.flagBoost === goal.flagBoost) {
          console.log(`Removed useless move ${cog1Key} to ${cog2Key}`);
          continue;
        }
        inventory.move(cog1Key, cog2Key);
      }
    }
  }
}
