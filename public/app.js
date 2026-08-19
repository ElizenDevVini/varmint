(function () {
  const S = window.SIM;
  const { MAP, SUB, TICK_MS } = S;
  const TILE = 32; // screen px per tile at zoom 1

  const canvas = document.getElementById('city');
  const ctx = canvas.getContext('2d');
  let dpr = 1;
  function fit() {
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(innerWidth * dpr);
    canvas.height = Math.floor(innerHeight * dpr);
    canvas.style.width = innerWidth + 'px';
    canvas.style.height = innerHeight + 'px';
  }
  addEventListener('resize', fit);
  fit();

  // --- state ---
  let roster = [];
  let clockOffset = 0; // serverNow - Date.now()
  const cam = { x: (MAP.W * SUB) / 2, y: (MAP.H * SUB) / 2, zoom: 1 };
  let follow = false;
  let selected = null;
  let mine = null;
  try { mine = JSON.parse(localStorage.getItem('varmint') || 'null'); } catch {}

  const serverNow = () => Date.now() + clockOffset;
  const nowTick = () => serverNow() / TICK_MS;

  // --- assets (fall back to flat shapes until images exist/load) ---
  const sprites = {};
  for (const sp of ['fly', 'crow', 'cat', 'dog']) {
    const img = new Image();
    img.src = 'assets/' + sp + '.png';
    img.onload = () => (sprites[sp] = img);
  }
  let tilesImg = null;
  {
    const img = new Image();
    img.src = 'assets/tiles.png';
    img.onload = () => (tilesImg = img);
  }
  const TILE_ORDER = ['grass', 'road', 'walk', 'plaza', 'roof', 'stall'];
  const TILE_COLORS = ['#6e7076', '#585a5e', '#8d8b83', '#a89a84', '#6e5f6b', '#b06a4a', '#4e6b45'];
  const SPECIES_COLORS = { fly: '#9fd54a', crow: '#7a86c9', cat: '#d99a4e', dog: '#c9c0ae' };

  // --- SSE ---
  function connect() {
    const es = new EventSource('/api/stream');
    es.addEventListener('snapshot', (e) => {
      const d = JSON.parse(e.data);
      roster = d.agents;
      clockOffset = d.now - Date.now();
      refreshMine();
      renderFeed(true);
    });
    es.addEventListener('agent', (e) => {
      const a = JSON.parse(e.data);
      if (!roster.some((r) => r.id === a.id)) roster.push(a);
      pushFeedLine(`${a.name} (${a.species} brain) arrived in the city`);
    });
    es.addEventListener('time', (e) => {
      clockOffset = Number(e.data) - Date.now();
    });
    es.onerror = () => {
      es.close();
      setTimeout(connect, 3000 + Math.random() * 3000);
    };
  }
  connect();

  function refreshMine() {
    if (mine && !roster.some((r) => r.id === mine.agent.id)) {
      // agent no longer on the server (db reset) — forget the claim
      mine = null;
      localStorage.removeItem('varmint');
    }
    updatePanel();
  }

  // --- interpolated agent state for smooth 60fps ---
  function smoothState(agent, tFloat) {
    const t0 = Math.floor(tFloat);
    const a = S.agentState(agent, t0, roster);
    const b = S.agentState(agent, t0 + 1, roster);
    const u = tFloat - t0;
    return { ...a, x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
  }

  // --- input: pan / zoom / click ---
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (drag.moved) {
      follow = false;
      const k = SUB / (TILE * cam.zoom);
      cam.x = drag.cx - dx * k;
      cam.y = drag.cy - dy * k;
    }
  });
  canvas.addEventListener('pointerup', (e) => {
    if (drag && !drag.moved) clickAt(e.clientX, e.clientY);
    drag = null;
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    cam.zoom = Math.max(0.4, Math.min(4, cam.zoom * (e.deltaY < 0 ? 1.15 : 0.87)));
  }, { passive: false });

  function worldToScreen(wx, wy) {
    const k = (TILE * cam.zoom) / SUB;
    return { x: innerWidth / 2 + (wx - cam.x) * k, y: innerHeight / 2 + (wy - cam.y) * k };
  }
  function clickAt(sx, sy) {
    const t = nowTick();
    let best = null, bd = 24 * 24;
    for (const a of roster) {
      const st = smoothState(a, t);
      const p = worldToScreen(st.x, st.y);
      const d = (p.x - sx) ** 2 + (p.y - sy) ** 2;
      if (d < bd) { bd = d; best = a; }
    }
    selected = best;
    updateCard();
  }

  // --- render loop ---
  function draw() {
    requestAnimationFrame(draw);
    const t = nowTick();
    if (follow && mine) {
      const st = smoothState(roster.find((r) => r.id === mine.agent.id) || mine.agent, t);
      cam.x = st.x; cam.y = st.y;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#1a1d21';
    ctx.fillRect(0, 0, innerWidth, innerHeight);

    const k = (TILE * cam.zoom) / SUB;
    const px = TILE * cam.zoom;
    const x0 = Math.max(0, Math.floor((cam.x - innerWidth / 2 / k) / SUB));
    const x1 = Math.min(MAP.W - 1, Math.ceil((cam.x + innerWidth / 2 / k) / SUB));
    const y0 = Math.max(0, Math.floor((cam.y - innerHeight / 2 / k) / SUB));
    const y1 = Math.min(MAP.H - 1, Math.ceil((cam.y + innerHeight / 2 / k) / SUB));

    for (let ty = y0; ty <= y1; ty++)
      for (let tx = x0; tx <= x1; tx++) {
        const type = MAP.tiles[ty * MAP.W + tx];
        const p = worldToScreen(tx * SUB, ty * SUB);
        if (tilesImg) {
          const ts = tilesImg.height;
          ctx.drawImage(tilesImg, type * ts, 0, ts, ts, p.x, p.y, px + 1, px + 1);
        }
        else {
          ctx.fillStyle = TILE_COLORS[type];
          ctx.fillRect(p.x, p.y, px + 1, px + 1);
        }
      }

    // props: lamps and sunspots
    for (const [lx, ly] of MAP.zones.sunspots) {
      const p = worldToScreen(lx * SUB, ly * SUB);
      ctx.fillStyle = 'rgba(255,220,120,0.18)';
      ctx.fillRect(p.x, p.y, px, px);
    }
    for (const [lx, ly] of MAP.zones.lamps) {
      const p = worldToScreen(lx * SUB + SUB / 2, ly * SUB + SUB / 2);
      ctx.fillStyle = '#2c2f33';
      ctx.fillRect(p.x - px * 0.06, p.y - px * 0.5, px * 0.12, px * 0.5);
      ctx.fillStyle = '#ffd97a';
      ctx.beginPath();
      ctx.arc(p.x, p.y - px * 0.5, px * 0.12, 0, 7);
      ctx.fill();
    }

    // agents, y-sorted
    const states = roster.map((a) => ({ a, st: smoothState(a, t) }));
    states.sort((p, q) => p.st.y - q.st.y);
    for (const { a, st } of states) {
      const p = worldToScreen(st.x, st.y);
      const size = px * 0.9;
      const img = sprites[a.species];
      if (img) {
        const fw = img.height; // square frames in a horizontal strip
        const frame = st.act === 'sleep' ? 2 : st.act === 'action' ? 3 : Math.floor(t * 2) % 2;
        ctx.save();
        ctx.translate(p.x, p.y);
        if (st.dir === 'w') ctx.scale(-1, 1);
        ctx.drawImage(img, frame * fw, 0, fw, fw, -size / 2, -size, size, size);
        ctx.restore();
      } else {
        ctx.fillStyle = SPECIES_COLORS[a.species];
        ctx.beginPath();
        ctx.arc(p.x, p.y - size / 2, size / 2.4, 0, 7);
        ctx.fill();
      }
      if (st.act === 'sleep' && cam.zoom > 0.7) {
        ctx.fillStyle = '#cfd6dd';
        ctx.font = `${Math.max(9, px * 0.3)}px monospace`;
        ctx.fillText('z', p.x + size * 0.4, p.y - size);
      }
      const isMine = mine && a.id === mine.agent.id;
      if (cam.zoom > 0.9 || isMine || selected === a) {
        ctx.font = `${Math.max(10, px * 0.28)}px monospace`;
        ctx.textAlign = 'center';
        ctx.fillStyle = isMine ? '#ffd97a' : 'rgba(230,230,230,0.85)';
        ctx.fillText(a.name, p.x, p.y - size - 3);
        ctx.textAlign = 'left';
      }
    }

    // day/night tint + lamp glow
    const ph = S.dayPhase(Math.floor(t));
    let dark = 0;
    if (ph >= 0.5) dark = Math.min(1, (ph - 0.5) * 12) * 0.55;
    if (ph > 0.96) dark = Math.max(0, 0.55 - (ph - 0.96) * 12);
    if (dark > 0.01) {
      ctx.fillStyle = `rgba(10,14,34,${dark})`;
      ctx.fillRect(0, 0, innerWidth, innerHeight);
      for (const [lx, ly] of MAP.zones.lamps) {
        const p = worldToScreen(lx * SUB + SUB / 2, ly * SUB + SUB / 2);
        const g = ctx.createRadialGradient(p.x, p.y - px * 0.5, 0, p.x, p.y - px * 0.5, px * 2.2);
        g.addColorStop(0, `rgba(255,214,120,${0.35 * dark})`);
        g.addColorStop(1, 'rgba(255,214,120,0)');
        ctx.fillStyle = g;
        ctx.fillRect(p.x - px * 2.2, p.y - px * 2.7, px * 4.4, px * 4.4);
      }
    }
  }
  requestAnimationFrame(draw);

  // --- feed ---
  const feedEl = document.getElementById('feed');
  const extraLines = [];
  function pushFeedLine(text) {
    extraLines.push({ t: nowTick(), text });
    renderFeed(true);
  }
  let lastFeedAt = 0;
  function renderFeed(force) {
    if (!force && Date.now() - lastFeedAt < 3000) return;
    lastFeedAt = Date.now();
    const t = Math.floor(nowTick());
    const events = S.eventsBetween(roster, t - 720, t).concat(extraLines.filter((l) => l.t > t - 720));
    events.sort((a, b) => a.t - b.t);
    feedEl.innerHTML = events.length
      ? events.slice(-12).map((e) => `<div>${esc(e.text)}</div>`).join('')
      : `<div>${S.night(t) ? 'the city sleeps. nothing stirs but the flies.' : 'a quiet moment in varmint city.'}</div>`;
  }
  setInterval(() => renderFeed(false), 3000);
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // --- agent card ---
  const cardEl = document.getElementById('card');
  function updateCard() {
    if (!selected) { cardEl.hidden = true; return; }
    cardEl.hidden = false;
    const st = S.agentState(selected, Math.floor(nowTick()), roster);
    const doing = st.act === 'sleep' ? 'asleep'
      : st.act === 'action' ? (selected.species === 'cat' ? 'pouncing' : 'stashing loot')
      : st.following ? `tailing ${st.following.name}` : 'wandering';
    cardEl.innerHTML = `<b>${esc(selected.name)}</b> — ${selected.species} brain<br>${doing}` +
      `<br><button id="card-follow">watch</button> <button id="card-close">close</button>`;
    document.getElementById('card-close').onclick = () => { selected = null; updateCard(); };
    document.getElementById('card-follow').onclick = () => {
      const a = selected;
      follow = false;
      const iv = setInterval(() => {
        if (!selected || selected !== a) return clearInterval(iv);
        const st2 = smoothState(a, nowTick());
        cam.x = st2.x; cam.y = st2.y;
      }, 50);
    };
  }
  setInterval(() => { if (selected) updateCard(); }, 4000);

  // --- create panel ---
  const panel = document.getElementById('panel');
  let pickedSpecies = null;
  function updatePanel() {
    if (mine) {
      panel.innerHTML = `<b>${esc(mine.agent.name)}</b> — your ${mine.agent.species} brain` +
        ` <button id="btn-follow">${follow ? 'stop watching' : 'watch'}</button>`;
      document.getElementById('btn-follow').onclick = () => { follow = !follow; updatePanel(); };
      return;
    }
    panel.innerHTML = `<div class="pick">` +
      ['fly', 'crow', 'cat', 'dog'].map((sp) =>
        `<button class="sp${pickedSpecies === sp ? ' on' : ''}" data-sp="${sp}">` +
        `<img src="assets/portrait_${sp}.png" onerror="this.style.display='none'" alt="">${sp} brain</button>`
      ).join('') + `</div>` +
      `<input id="agent-name" maxlength="20" placeholder="name your varmint">` +
      `<button id="btn-create">release into the city</button><div id="panel-err"></div>`;
    panel.querySelectorAll('.sp').forEach((b) => (b.onclick = () => { pickedSpecies = b.dataset.sp; updatePanel(); }));
    document.getElementById('btn-create').onclick = create;
  }
  async function create() {
    const name = document.getElementById('agent-name').value.trim();
    const err = document.getElementById('panel-err');
    if (!pickedSpecies) return (err.textContent = 'pick a species');
    if (!name) return (err.textContent = 'give it a name');
    const res = await fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ species: pickedSpecies, name }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return (err.textContent = body.error || 'failed, try again');
    mine = body;
    localStorage.setItem('varmint', JSON.stringify(body));
    if (!roster.some((r) => r.id === body.agent.id)) roster.push(body.agent);
    follow = true;
    updatePanel();
  }
  updatePanel();
})();
