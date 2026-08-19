// Deterministic world sim. Every client computes the same world from
// (roster, epoch time) alone: integer math only, no Math.random, no history.
(function () {
  const TICK_MS = 250;
  const SEG = 24; // ticks per movement segment (6s)
  const SUB = 16; // position subunits per tile
  const CYCLE = 7200; // ticks per day/night cycle (30 min)
  const W = 64, H = 64;

  // int32 hash, exact across JS engines (imul + shifts only)
  function h32(a, b, c) {
    let x = ((a | 0) + Math.imul(b | 0, 0x9e3779b1) + Math.imul(c | 0, 0x85ebca77)) | 0;
    x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d);
    x = Math.imul(x ^ (x >>> 12), 0x297a2d39);
    x ^= x >>> 15;
    return x >>> 0;
  }
  const pick = (arr, n) => arr[n % arr.length];

  // --- map: fixed, derived from constants only ---
  // tile types (indices match the tiles.png strip)
  const T = { PAVE: 0, ROAD: 1, WALK: 2, PLAZA: 3, ROOF: 4, STALL: 5, LAWN: 6 };
  function buildMap() {
    const tiles = new Uint8Array(W * H);
    const isRoad = (x, y) => x % 16 === 8 || y % 16 === 8;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) tiles[y * W + x] = isRoad(x, y) ? T.ROAD : T.PAVE;

    // plaza: center square
    for (let y = 26; y < 38; y++)
      for (let x = 26; x < 38; x++) tiles[y * W + x] = T.PLAZA;

    // blocks: buildings inset inside each 16x16 block, some blocks are parks
    for (let by = 0; by < 4; by++)
      for (let bx = 0; bx < 4; bx++) {
        const park = h32(bx, by, 11) % 4 === 0;
        const x0 = bx * 16 + 10, y0 = by * 16 + 10; // between roads at 8s
        for (let y = y0 + 1; y < y0 + 13 && y < H; y++)
          for (let x = x0 + 1; x < x0 + 13 && x < W; x++) {
            const i = y * W + x;
            if (tiles[i] === T.PAVE) tiles[i] = park ? T.LAWN : T.ROOF;
          }
      }
    // carve plaza back out and give it a sidewalk ring
    for (let y = 24; y < 40; y++)
      for (let x = 24; x < 40; x++) {
        const i = y * W + x;
        if (y >= 26 && y < 38 && x >= 26 && x < 38) tiles[i] = T.PLAZA;
        else if (tiles[i] === T.ROOF) tiles[i] = T.WALK;
      }
    // market stalls: north edge of plaza
    for (let x = 27; x < 37; x += 3) tiles[25 * W + x] = T.STALL;

    // zone tile lists
    const zones = { lamps: [], stalls: [], perches: [], sunspots: [], plaza: [], open: [] };
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const t = tiles[y * W + x];
        if (t === T.PLAZA) zones.plaza.push([x, y]);
        if (t === T.STALL) zones.stalls.push([x, y]);
        if (t === T.ROOF && h32(x, y, 13) % 9 === 0) zones.perches.push([x, y]);
        if (t !== T.ROOF && t !== T.STALL) zones.open.push([x, y]);
        if (t === T.ROAD && x % 16 === 8 && y % 16 === 8) zones.lamps.push([x, y]);
      }
    for (const xy of [[28, 30], [34, 33], [30, 36], [18, 18], [46, 45]]) zones.sunspots.push(xy);
    zones.lamps.push([27, 27], [36, 36]);
    return { W, H, tiles, zones, T };
  }
  const MAP = buildMap();
  const Z = MAP.zones;

  const night = (t) => t % CYCLE >= CYCLE / 2;
  const dayPhase = (t) => (t % CYCLE) / CYCLE;

  function tileCenter([x, y]) {
    return { x: x * SUB + SUB / 2, y: y * SUB + SUB / 2 };
  }
  // spot inside a tile, deterministic per (seed, seg)
  function spotIn(tile, seed, s) {
    const c = tileCenter(tile);
    return {
      x: c.x + ((h32(seed, s, 21) % 11) - 5),
      y: c.y + ((h32(seed, s, 22) % 11) - 5),
    };
  }

  // --- per-species waypoints: P(agent, seg) -> {x, y, act} ---
  // act: 'walk' | 'sleep' | 'action' (species move); no cross-species deps here
  function basePoint(agent, s) {
    const { seed, species } = agent;
    const isNight = night(s * SEG);
    if (species === 'fly') {
      if (h32(seed, s, 1) % 5 === 0) {
        return { ...spotIn(pick(Z.stalls, h32(seed, s - (s % 5), 2)), seed, s - (s % 5)), act: 'sleep' };
      }
      const zone = isNight ? Z.lamps : h32(seed, s, 3) % 10 < 7 ? Z.stalls : Z.plaza;
      return { ...spotIn(pick(zone, h32(seed, s, 4)), seed, s), act: 'walk' };
    }
    if (species === 'crow') {
      const perch = pick(Z.perches, h32(seed, 0, 5));
      const stash = pick(Z.perches, h32(seed, 0, 6) + 1);
      if (isNight) return { ...tileCenter(perch), act: 'sleep' };
      const r = h32(seed, s, 7) % 8;
      if (r === 0) return { ...tileCenter(stash), act: 'action', stash: true };
      if (r <= 2) return { ...tileCenter(perch), act: 'walk' };
      return { ...spotIn(pick(Z.plaza, h32(seed, s, 8)), seed, s), act: 'walk' };
    }
    if (species === 'cat') {
      const home = pick(Z.open, h32(seed, 0, 9));
      if (!isNight && h32(seed, s - (s % 4), 10) % 5 < 3) {
        let best = Z.sunspots[0], bd = 1e9;
        for (const sp of Z.sunspots) {
          const d = Math.abs(sp[0] - home[0]) + Math.abs(sp[1] - home[1]);
          if (d < bd) { bd = d; best = sp; }
        }
        return { ...tileCenter(best), act: 'sleep' };
      }
      const r = isNight ? 8 : 4;
      const tx = Math.max(0, Math.min(W - 1, home[0] + (h32(seed, s, 12) % (2 * r + 1)) - r));
      const ty = Math.max(0, Math.min(H - 1, home[1] + (h32(seed, s, 14) % (2 * r + 1)) - r));
      return { ...spotIn([tx, ty], seed, s), act: 'walk' };
    }
    // dog
    const kennel = pick(Z.plaza, h32(agent.seed, 0, 15));
    if (night(s * SEG)) return { ...tileCenter(kennel), act: 'sleep' };
    return { ...spotIn(pick(Z.plaza, h32(agent.seed, s, 16)), agent.seed, s), act: 'walk' };
  }

  function lerpPos(a, b, u, den) {
    return {
      x: a.x + Math.floor(((b.x - a.x) * u) / den),
      y: a.y + Math.floor(((b.y - a.y) * u) / den),
    };
  }

  // base position: pure function of one agent, no roster context
  function basePos(agent, t) {
    const s = Math.floor(t / SEG);
    const a = basePoint(agent, s);
    const b = basePoint(agent, s + 1);
    let u = t - s * SEG;
    if (agent.species === 'crow') u = Math.min(SEG, u * 3); // flies fast, then perches
    const p = lerpPos(a, b, u, SEG);
    if (agent.species === 'fly' && a.act !== 'sleep') {
      p.x += (h32(agent.seed, t, 17) % 9) - 4;
      p.y += (h32(agent.seed, t, 18) % 9) - 4;
    }
    return { ...p, act: a.act, from: a, to: b };
  }

  // full state with cross-species reactions, evaluated in dependency order:
  // crow/fly/cat base are independent; cat reacts to flies; dog follows others.
  function agentState(agent, t, roster) {
    const s = Math.floor(t / SEG);
    if (agent.species === 'dog' && !night(s * SEG)) {
      const span = Math.floor(s / 8);
      const others = roster.filter((a) => a.species !== 'dog' && a.id !== agent.id);
      if (others.length) {
        const target = pick(others, h32(agent.seed, span, 19));
        const tp = basePos(target, t);
        const bp = basePos(agent, t);
        // 3/4 weight toward the target keeps the path continuous across segments
        const p = {
          x: Math.floor((bp.x + 3 * tp.x) / 4),
          y: Math.floor((bp.y + 3 * tp.y) / 4),
        };
        return { ...p, act: 'walk', following: target, dir: dirOf(bp, tp) };
      }
    }
    const p = basePos(agent, t);
    let act = p.act;
    if (agent.species === 'cat' && act === 'walk') {
      for (const a of roster) {
        if (a.species !== 'fly') continue;
        const fp = basePos(a, t);
        const d = Math.abs(fp.x - p.x) + Math.abs(fp.y - p.y);
        if (d < 2 * SUB) { act = 'action'; break; }
      }
    }
    if (agent.species === 'crow' && p.from.stash && t - s * SEG < 8) act = 'action';
    return { ...p, act, dir: dirOf(p.from, p.to) };
  }

  function dirOf(a, b) {
    return Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? (b.x >= a.x ? 'e' : 'w') : (b.y >= a.y ? 's' : 'n');
  }

  // events derived at segment boundaries; same on every client
  function eventsBetween(roster, t0, t1) {
    const out = [];
    const s0 = Math.ceil(t0 / SEG), s1 = Math.floor(t1 / SEG);
    for (let s = s0; s <= s1; s++) {
      const t = s * SEG;
      for (const a of roster) {
        if (a.species === 'crow') {
          const cur = basePoint(a, s), prev = basePoint(a, s - 1);
          if (cur.stash && !prev.stash) out.push({ t, text: `${a.name} (crow brain) stashed something shiny` });
        }
        if (a.species === 'dog' && !night(t) && s % 8 === 0) {
          const others = roster.filter((o) => o.species !== 'dog' && o.id !== a.id);
          if (others.length) {
            const span = Math.floor(s / 8);
            const tgt = pick(others, h32(a.seed, span, 19));
            const prev = pick(others, h32(a.seed, span - 1, 19));
            if (tgt.id !== prev.id) {
              out.push({ t, text: `${a.name} (dog brain) started tailing ${tgt.name}` });
            }
          }
        }
        if (a.species === 'cat') {
          const p = basePos(a, t);
          if (p.act === 'walk') {
            for (const f of roster) {
              if (f.species !== 'fly') continue;
              const fp = basePos(f, t);
              if (Math.abs(fp.x - p.x) + Math.abs(fp.y - p.y) < 2 * SUB) {
                out.push({ t, text: `${a.name} (cat brain) pounced at ${f.name}` });
                break;
              }
            }
          }
        }
      }
      if (t % CYCLE === CYCLE / 2) out.push({ t, text: 'night falls over varmint city' });
      if (t % CYCLE === 0) out.push({ t, text: 'the sun rises' });
    }
    return out;
  }

  window.SIM = { TICK_MS, SEG, SUB, CYCLE, MAP, night, dayPhase, agentState, basePos, eventsBetween, h32 };
})();
