(() => {
  "use strict";

  // ---------- DOM ----------
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");

  const elScore = document.getElementById("score");
  const elLives = document.getElementById("lives");
  const elWave = document.getElementById("wave");

  const overlay = document.getElementById("overlay");
  const btnStart = document.getElementById("btnStart");

  // Touch controls
  const touchControls = document.getElementById("touchControls");
  const btnLeft = document.getElementById("btnLeft");
  const btnRight = document.getElementById("btnRight");
  const btnFire = document.getElementById("btnFire");

  // ---------- Utils ----------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (a, b) => a + Math.random() * (b - a);

  function aabb(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }

  // ---------- Game constants ----------
  const W = canvas.width;
  const H = canvas.height;

  const COLORS = {
    bg1: "#0b1020",
    stars: "rgba(255,255,255,0.65)",
    text: "rgba(233,236,255,0.9)",
    player: "#8affc1",
    invader: "rgba(233,236,255,0.9)",
    invader2: "rgba(233,236,255,0.75)",
    bullet: "rgba(138,255,193,0.95)",
    ebullet: "rgba(255,180,180,0.95)",
    shield: "rgba(233,236,255,0.45)",
    ufo: "rgba(255,255,255,0.9)",
  };

  // ---------- Input ----------
  const keys = new Set();
  let pointerLeft = false;
  let pointerRight = false;
  let pointerFire = false;

  window.addEventListener("keydown", (e) => {
    if (["ArrowLeft", "ArrowRight", " ", "Spacebar", "KeyA", "KeyD", "KeyP", "Enter"].includes(e.code)) {
      e.preventDefault();
    }
    keys.add(e.code);

    if (e.code === "KeyP") togglePause();
    if (e.code === "Enter" && state.gameOver) restart();
  });

  window.addEventListener("keyup", (e) => keys.delete(e.code));

  function bindHold(btn, onDown, onUp) {
    const down = (e) => { e.preventDefault(); onDown(); };
    const up = (e) => { e.preventDefault(); onUp(); };
    btn.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("pointerleave", up);
  }

  bindHold(btnLeft, () => (pointerLeft = true), () => (pointerLeft = false));
  bindHold(btnRight, () => (pointerRight = true), () => (pointerRight = false));
  bindHold(btnFire, () => (pointerFire = true), () => (pointerFire = false));

  // ---------- Entities ----------
  const state = {
    running: false,
    paused: false,
    gameOver: false,
    wave: 1,
    score: 0,
    lives: 3,
    lastTs: 0,
    shake: 0,
  };

  const stars = Array.from({ length: 120 }, () => ({
    x: Math.random() * W,
    y: Math.random() * H,
    s: rand(0.5, 1.8),
    v: rand(12, 44),
  }));

  const player = {
    w: 46,
    h: 18,
    x: W / 2 - 23,
    y: H - 48,
    speed: 310,
    cooldown: 0,
    cooldownMax: 0.28,
    alive: true,
  };

  /** @type {{x:number,y:number,w:number,h:number,vy:number,from:'p'|'e'}[]} */
  const bullets = [];

  /** @type {{x:number,y:number,w:number,h:number,alive:boolean,row:number,col:number}[]} */
  let invaders = [];

  const inv = {
    cols: 11,
    rows: 5,
    w: 34,
    h: 22,
    padX: 18,
    padY: 14,
    ox: 80,
    oy: 90,
    vx: 38, // base horizontal speed (scaled with wave / remaining invaders)
    dir: 1, // 1 right, -1 left
    drop: 20,
    stepTimer: 0,
    stepEvery: 0.55, // seconds per step (lower = faster)
    fireTimer: 0,
    fireEvery: 1.2,
  };

  // Shields are a small grid of pixels you can destroy.
  const shields = [];
  function createShields() {
    shields.length = 0;
    const baseY = H - 150;
    const count = 4;
    const shieldW = 84;
    const shieldH = 52;
    const gap = (W - count * shieldW) / (count + 1);
    for (let i = 0; i < count; i++) {
      const x0 = gap + i * (shieldW + gap);
      const y0 = baseY;

      // 2D boolean grid
      const cell = 4; // px size per cell
      const gw = Math.floor(shieldW / cell);
      const gh = Math.floor(shieldH / cell);

      const grid = Array.from({ length: gh }, (_, y) =>
        Array.from({ length: gw }, (_, x) => {
          // cutouts (classic shape)
          const top = y < 2;
          const sideCut = (x < 2 || x > gw - 3) && y > gh / 2;
          const hole = y > gh - 10 && x > gw / 2 - 3 && x < gw / 2 + 3;
          return !(top || sideCut || hole);
        })
      );

      shields.push({ x: x0, y: y0, cell, gw, gh, grid });
    }
  }

  const ufo = {
    active: false,
    x: -80,
    y: 50,
    w: 56,
    h: 20,
    vx: 140,
    timer: 0,
    nextIn: rand(10, 18),
  };

  // ---------- Build wave ----------
  function buildInvaders() {
    invaders = [];
    const sx = inv.ox;
    const sy = inv.oy;
    for (let r = 0; r < inv.rows; r++) {
      for (let c = 0; c < inv.cols; c++) {
        invaders.push({
          x: sx + c * (inv.w + inv.padX),
          y: sy + r * (inv.h + inv.padY),
          w: inv.w,
          h: inv.h,
          alive: true,
          row: r,
          col: c,
        });
      }
    }
    inv.dir = 1;
    inv.stepTimer = 0;
    inv.fireTimer = 0;

    // Make it a bit tougher/faster each wave
    inv.stepEvery = clamp(0.60 - state.wave * 0.035, 0.22, 0.60);
    inv.fireEvery = clamp(1.25 - state.wave * 0.06, 0.55, 1.25);
  }

  function resetPlayer() {
    player.x = W / 2 - player.w / 2;
    player.y = H - 48;
    player.cooldown = 0;
    player.alive = true;
  }

  function resetBullets() {
    bullets.length = 0;
  }

  function newGame() {
    state.wave = 1;
    state.score = 0;
    state.lives = 3;
    state.gameOver = false;
    state.paused = false;
    updateHud();

    resetPlayer();
    resetBullets();
    createShields();
    buildInvaders();

    ufo.active = false;
    ufo.x = -80;
    ufo.timer = 0;
    ufo.nextIn = rand(10, 18);

    state.shake = 0;
  }

  // ---------- HUD ----------
  function updateHud() {
    elScore.textContent = String(state.score);
    elLives.textContent = String(state.lives);
    elWave.textContent = String(state.wave);
  }

  // ---------- Start / Pause / Restart ----------
  function start() {
    overlay.classList.add("hidden");
    state.running = true;
    state.lastTs = performance.now();
    requestAnimationFrame(loop);
  }

  function togglePause() {
    if (!state.running || state.gameOver) return;
    state.paused = !state.paused;
  }

  function gameOver() {
    state.gameOver = true;
    state.running = false;

    overlay.querySelector("h1").textContent = "Game Over";
    overlay.querySelector(".keys").innerHTML =
      `Score final : <b>${state.score}</b><br/>Appuie sur <b>Entrée</b> pour recommencer.`;
    btnStart.textContent = "Rejouer";
    overlay.classList.remove("hidden");
  }

  function restart() {
    // restore overlay text
    overlay.querySelector("h1").textContent = "Space Invaders";
    overlay.querySelector(".keys").innerHTML =
      `<b>PC</b> : ← → pour bouger, <b>Espace</b> pour tirer, <b>P</b> pause<br /><b>Mobile</b> : boutons à l’écran`;
    btnStart.textContent = "Démarrer";

    newGame();
    start();
  }

  btnStart.addEventListener("click", () => {
    if (!state.running) {
      newGame();
      start();
    } else {
      restart();
    }
  });

  // ---------- Core mechanics ----------
  function playerShoot() {
    if (player.cooldown > 0) return;
    bullets.push({
      x: player.x + player.w / 2 - 2,
      y: player.y - 10,
      w: 4,
      h: 10,
      vy: -520,
      from: "p",
    });
    player.cooldown = player.cooldownMax;
  }

  function invaderShoot() {
    // pick a random alive invader among bottom-most in a column
    const alive = invaders.filter((v) => v.alive);
    if (alive.length === 0) return;

    // build bottom-most per column
    const byCol = new Map();
    for (const v of alive) {
      const cur = byCol.get(v.col);
      if (!cur || v.y > cur.y) byCol.set(v.col, v);
    }
    const shooters = Array.from(byCol.values());
    const shooter = shooters[(Math.random() * shooters.length) | 0];

    bullets.push({
      x: shooter.x + shooter.w / 2 - 2,
      y: shooter.y + shooter.h + 2,
      w: 4,
      h: 10,
      vy: 360 + state.wave * 20,
      from: "e",
    });
  }

  function killInvader(invader) {
    invader.alive = false;
    state.score += 10 + (inv.rows - invader.row) * 2;
    state.shake = 6;
    updateHud();
  }

  function damageShieldAt(x, y) {
    for (const sh of shields) {
      const rx = x - sh.x;
      const ry = y - sh.y;
      if (rx < 0 || ry < 0) continue;
      const gx = Math.floor(rx / sh.cell);
      const gy = Math.floor(ry / sh.cell);
      if (gx >= 0 && gx < sh.gw && gy >= 0 && gy < sh.gh) {
        // carve a small crater
        for (let yy = -1; yy <= 1; yy++) {
          for (let xx = -1; xx <= 1; xx++) {
            const ix = gx + xx;
            const iy = gy + yy;
            if (ix >= 0 && ix < sh.gw && iy >= 0 && iy < sh.gh) {
              sh.grid[iy][ix] = false;
            }
          }
        }
        return true;
      }
    }
    return false;
  }

  function shieldHit(b) {
    // check bullet against shield pixels
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    return damageShieldAt(cx, cy);
  }

  function ufoMaybeSpawn(dt) {
    ufo.timer += dt;
    if (!ufo.active && ufo.timer > ufo.nextIn) {
      ufo.active = true;
      ufo.timer = 0;
      ufo.x = -ufo.w - 10;
      ufo.vx = 130 + state.wave * 10;
    }
  }

  function ufoUpdate(dt) {
    if (!ufo.active) return;
    ufo.x += ufo.vx * dt;
    if (ufo.x > W + ufo.w + 10) {
      ufo.active = false;
      ufo.timer = 0;
      ufo.nextIn = rand(10, 18);
    }
  }

  function ufoHit() {
    ufo.active = false;
    ufo.timer = 0;
    ufo.nextIn = rand(10, 18);
    const bonus = (Math.random() < 0.2) ? 300 : (Math.random() < 0.5 ? 150 : 100);
    state.score += bonus;
    updateHud();
  }

  function nextWave() {
    state.wave += 1;
    updateHud();
    resetBullets();
    resetPlayer();
    createShields();
    buildInvaders();
  }

  // ---------- Update ----------
  function update(dt) {
    if (state.paused) return;

    // stars
    for (const s of stars) {
      s.y += s.v * dt;
      if (s.y > H) { s.y = -2; s.x = Math.random() * W; }
    }

    // player input
    const left = keys.has("ArrowLeft") || keys.has("KeyA") || pointerLeft;
    const right = keys.has("ArrowRight") || keys.has("KeyD") || pointerRight;
    const fire = keys.has("Space") || pointerFire;

    let vx = 0;
    if (left) vx -= player.speed;
    if (right) vx += player.speed;
    player.x = clamp(player.x + vx * dt, 10, W - player.w - 10);

    // cooldown
    player.cooldown = Math.max(0, player.cooldown - dt);

    if (fire) playerShoot();

    // invaders: step movement like classic
    const aliveInv = invaders.filter((v) => v.alive);
    if (aliveInv.length > 0) {
      inv.stepTimer += dt;

      // speed up as invaders die
      const ratio = aliveInv.length / (inv.rows * inv.cols);
      const speedFactor = 1 + (1 - ratio) * 1.6 + (state.wave - 1) * 0.15;

      if (inv.stepTimer >= inv.stepEvery / speedFactor) {
        inv.stepTimer = 0;

        // find bounds
        let minX = Infinity, maxX = -Infinity;
        for (const v of aliveInv) {
          minX = Math.min(minX, v.x);
          maxX = Math.max(maxX, v.x + v.w);
        }

        const step = inv.vx * 0.22 * inv.dir * speedFactor; // per "tick"
        // tentative move
        let willHitEdge = (minX + step < 18) || (maxX + step > W - 18);

        if (willHitEdge) {
          inv.dir *= -1;
          for (const v of aliveInv) v.y += inv.drop;
        } else {
          for (const v of aliveInv) v.x += step;
        }
      }

      // invaders shooting
      inv.fireTimer += dt;
      if (inv.fireTimer >= inv.fireEvery) {
        inv.fireTimer = 0;
        // a bit more bullets later waves
        const shots = Math.random() < clamp(0.25 + state.wave * 0.06, 0.25, 0.65) ? 2 : 1;
        for (let i = 0; i < shots; i++) invaderShoot();
      }

      // lose condition: invaders reach player line
      const lowest = aliveInv.reduce((m, v) => Math.max(m, v.y + v.h), 0);
      if (lowest > player.y - 10) {
        state.lives = 0;
        updateHud();
        gameOver();
        return;
      }
    }

    // UFO
    ufoMaybeSpawn(dt);
    ufoUpdate(dt);

    // bullets update & collisions
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      b.y += b.vy * dt;

      // out
      if (b.y < -30 || b.y > H + 30) {
        bullets.splice(i, 1);
        continue;
      }

      // shield collision
      if (shieldHit(b)) {
        bullets.splice(i, 1);
        continue;
      }

      if (b.from === "p") {
        // hit invaders
        let hit = false;
        for (const v of invaders) {
          if (!v.alive) continue;
          if (aabb(b.x, b.y, b.w, b.h, v.x, v.y, v.w, v.h)) {
            killInvader(v);
            bullets.splice(i, 1);
            hit = true;
            break;
          }
        }
        if (hit) continue;

        // hit UFO
        if (ufo.active && aabb(b.x, b.y, b.w, b.h, ufo.x, ufo.y, ufo.w, ufo.h)) {
          ufoHit();
          bullets.splice(i, 1);
          continue;
        }
      } else {
        // enemy bullet hits player
        if (player.alive && aabb(b.x, b.y, b.w, b.h, player.x, player.y, player.w, player.h)) {
          bullets.splice(i, 1);
          state.lives -= 1;
          updateHud();
          state.shake = 10;

          if (state.lives <= 0) {
            gameOver();
            return;
          } else {
            // brief reset
            resetBullets();
            resetPlayer();
            break;
          }
        }
      }
    }

    // wave cleared
    if (invaders.every((v) => !v.alive)) {
      nextWave();
    }

    // shake decay
    state.shake = Math.max(0, state.shake - dt * 18);
  }

  // ---------- Render ----------
  function drawStars() {
    ctx.fillStyle = COLORS.stars;
    for (const s of stars) {
      ctx.globalAlpha = 0.25 + s.s / 2.2;
      ctx.fillRect(s.x, s.y, s.s, s.s);
    }
    ctx.globalAlpha = 1;
  }

  function drawPlayer() {
    ctx.fillStyle = COLORS.player;
    // simple pixel-ish ship
    const x = player.x, y = player.y;
    ctx.fillRect(x + 18, y, 10, 6);
    ctx.fillRect(x + 10, y + 6, 26, 6);
    ctx.fillRect(x + 4, y + 12, 38, 6);
  }

  function drawInvader(v) {
    ctx.fillStyle = (v.row < 2) ? COLORS.invader : COLORS.invader2;
    // simple body
    ctx.fillRect(v.x + 6, v.y + 4, v.w - 12, v.h - 8);
    // eyes
    ctx.clearRect(v.x + 10, v.y + 9, 5, 4);
    ctx.clearRect(v.x + v.w - 15, v.y + 9, 5, 4);
    // legs
    ctx.fillRect(v.x + 6, v.y + v.h - 6, 8, 6);
    ctx.fillRect(v.x + v.w - 14, v.y + v.h - 6, 8, 6);
  }

  function drawBullets() {
    for (const b of bullets) {
      ctx.fillStyle = (b.from === "p") ? COLORS.bullet : COLORS.ebullet;
      ctx.fillRect(b.x, b.y, b.w, b.h);
    }
  }

  function drawShields() {
    ctx.fillStyle = COLORS.shield;
    for (const sh of shields) {
      for (let y = 0; y < sh.gh; y++) {
        for (let x = 0; x < sh.gw; x++) {
          if (!sh.grid[y][x]) continue;
          ctx.fillRect(sh.x + x * sh.cell, sh.y + y * sh.cell, sh.cell, sh.cell);
        }
      }
    }
  }

  function drawUfo() {
    if (!ufo.active) return;
    ctx.fillStyle = COLORS.ufo;
    ctx.fillRect(ufo.x + 8, ufo.y, ufo.w - 16, 6);
    ctx.fillRect(ufo.x + 2, ufo.y + 6, ufo.w - 4, 10);
    ctx.clearRect(ufo.x + 18, ufo.y + 10, 6, 3);
    ctx.clearRect(ufo.x + ufo.w - 24, ufo.y + 10, 6, 3);
  }

  function drawGround() {
    ctx.fillStyle = "rgba(233,236,255,0.12)";
    ctx.fillRect(0, H - 22, W, 2);
  }

  function drawPaused() {
    if (!state.paused) return;
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = COLORS.text;
    ctx.font = "700 28px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("PAUSE", W / 2, H / 2 - 10);
    ctx.font = "600 14px system-ui, sans-serif";
    ctx.fillText("Appuie sur P pour reprendre", W / 2, H / 2 + 16);
    ctx.textAlign = "left";
  }

  function render() {
    // screen shake
    let ox = 0, oy = 0;
    if (state.shake > 0) {
      ox = (Math.random() * 2 - 1) * state.shake;
      oy = (Math.random() * 2 - 1) * state.shake * 0.6;
    }

    ctx.save();
    ctx.translate(ox, oy);

    // background
    ctx.fillStyle = COLORS.bg1;
    ctx.fillRect(-20, -20, W + 40, H + 40);
    drawStars();

    // entities
    drawShields();
    drawUfo();

    for (const v of invaders) if (v.alive) drawInvader(v);
    drawPlayer();
    drawBullets();
    drawGround();

    ctx.restore();

    drawPaused();
  }

  // ---------- Loop ----------
  function loop(ts) {
    if (!state.running) return;

    const dt = Math.min(0.033, (ts - state.lastTs) / 1000);
    state.lastTs = ts;

    update(dt);
    render();

    requestAnimationFrame(loop);
  }

  // ---------- Small mobile hint ----------
  // Show touch controls only when we likely have touch.
  if (matchMedia("(pointer: coarse)").matches) {
    touchControls.setAttribute("aria-hidden", "false");
  }

  // keep overlay visible until start
})();
