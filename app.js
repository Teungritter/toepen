(() => {
  'use strict';

  const $ = s => document.querySelector(s);
  const SYM = { S: '♠', H: '♥', C: '♣', D: '♦' };
  const SUIT_NAME = { S: 'schoppen', H: 'harten', C: 'klaveren', D: 'ruiten' };
  const RL = { J: 'B', Q: 'V', K: 'H', A: 'A' }; // boer, vrouw, heer, aas
  const ORDER = ['J', 'Q', 'K', 'A', '7', '8', '9', '10'];
  const SUIT_ORDER = ['S', 'H', 'C', 'D'];
  const POS = ['bottom', 'left', 'top', 'right'];
  const LEVEL_NAME = { makkelijk: 'Makkelijk', gemiddeld: 'Gemiddeld', moeilijk: 'Moeilijk', god: 'God' };
  const HOUSE_RULES = [
    { key: 'was', icon: '🧺', name: 'Was', text: 'Vier plaatjes/azen (of drie + een 7)? Claim een was voor nieuwe kaarten. Controleren mag.' },
    { key: 'pass', icon: '🔁', name: 'Doorgeven', text: 'Na het delen geeft iedereen 1 kaart door aan zijn linkerbuur.' },
    { key: 'double', icon: '✌️', name: 'Dubbel toepen', text: 'Eén keer per ronde mag je de inzet met 2 verhogen.' },
    { key: 'boer', icon: '🧑‍🌾', name: 'Boerenslag', text: 'Laatste slag gewonnen met een boer? Verliezers krijgen +1 extra.' },
    { key: 'comeback', icon: '💪', name: 'Comeback', text: 'Win je een ronde terwijl je op scherp staat? Er gaat 1 strafpunt af.' },
  ];

  const rankOf = c => c.slice(0, -1);
  const suitOf = c => c.slice(-1);
  const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const initial = name => esc((name || '?').trim().charAt(0).toUpperCase() || '?');
  const plural = n => `${n} strafpunt${n === 1 ? '' : 'en'}`;

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch (e) { /* privé-modus: dan maar zonder onthouden */ }
    return null;
  }

  let pid = store('toep_pid');
  if (!pid) {
    pid = Math.random().toString(36).slice(2) + Date.now().toString(36);
    store('toep_pid', pid);
  }

  let S = null;              // laatste spelstand van de server
  let selected = null;       // geselecteerde kaart in de hand
  let selectKey = '';
  let blindPick = false;     // stap 2 van blind: bedrag kiezen
  let seenLog = -1;
  let prevNeeds = false;
  let prevStake = 0;
  let overlayKey = '';
  let roundDeadline = 0;
  let splashTimer = 0;
  let qrUrl = '';
  let sending = false;
  const animSeen = new Set();

  // ---------- verbinding ----------
  // De host-telefoon draait game.js zelf; de anderen verbinden rechtstreeks met
  // die telefoon via een kamercode (PeerJS/WebRTC).

  const params = new URLSearchParams(location.search);
  const PEER_PREFIX = 'toepen-tg-';
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const HOST_SAVE_MAX_AGE = 6 * 3600 * 1000;

  function setState(view) {
    S = view;
    $('#conn').hidden = true;
    render();
  }

  const net = { role: null, room: null, peer: null, table: null, conns: new Map(), hostConn: null, reqId: 0, waiting: new Map(), retry: 0 };

  function loadPeerJs() {
    if (window.Peer) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('PeerJS kon niet laden. Heb je internet?'));
      document.head.append(s);
    });
  }

  const newCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  const joinUrl = () => `${location.origin}${location.pathname}?kamer=${net.room}`;

  function hostBroadcast() {
    const extra = { room: net.room, urls: [joinUrl()], host: true };
    for (const c of net.conns.values()) {
      if (c.pid && c.conn.open) c.conn.send({ t: 'state', s: net.table.view(c.pid, { ...extra, host: false }) });
    }
    setState(JSON.parse(JSON.stringify(net.table.view(pid, extra))));
    store('toep_host', JSON.stringify({ room: net.room, state: net.table.serialize(), at: Date.now() }));
  }

  function onGuestData(conn, msg) {
    const c = net.conns.get(conn.connectionId);
    if (!c || !msg) return;
    if (msg.t === 'hello') {
      c.pid = String(msg.pid);
      hostBroadcast();
    } else if (msg.t === 'act' && c.pid) {
      let res = { t: 'ack', id: msg.id, ok: true };
      try {
        net.table.handle(c.pid, msg.a || {});
      } catch (e) {
        if (e.name !== 'GameError') console.error(e);
        res = { t: 'ack', id: msg.id, ok: false, error: e.name === 'GameError' ? e.message : 'Er ging iets mis bij de host.' };
      }
      conn.send(res);
    }
  }

  function hostRoom(name, resume) {
    net.role = 'host';
    net.room = resume ? resume.room : newCode();
    net.table = new window.Toepen.Table({
      onChange: hostBroadcast,
      isConnected: id => id === pid || [...net.conns.values()].some(c => c.pid === id && c.conn.open),
    });
    if (resume) net.table.restore(resume.state);
    store('toep_role', 'host');
    showHome('Kamer openen…');
    const peer = new window.Peer(PEER_PREFIX + net.room);
    net.peer = peer;
    peer.on('open', () => {
      if (!resume) net.table.handle(pid, { type: 'join', name });
      else net.table.changed();
    });
    peer.on('connection', conn => {
      net.conns.set(conn.connectionId, { conn, pid: null });
      conn.on('data', msg => onGuestData(conn, msg));
      conn.on('close', () => { net.conns.delete(conn.connectionId); hostBroadcast(); });
    });
    peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
    peer.on('error', err => {
      if (err.type === 'unavailable-id' && !resume) { // code toevallig bezet: nieuwe kiezen
        peer.destroy();
        hostRoom(name, null);
      } else if (err.type === 'unavailable-id' && (resume.tries || 0) < 10) {
        // Na herladen houdt de server de oude verbinding soms nog even vast.
        peer.destroy();
        setTimeout(() => hostRoom(name, { ...resume, tries: (resume.tries || 0) + 1 }), 2000);
      } else if (err.type !== 'peer-unavailable') {
        toast('Verbindingsfout: ' + (err.type || err.message), 'err');
        if (!S) showHome();
      }
    });
  }

  function joinRoom(code, name) {
    net.role = 'guest';
    net.room = code;
    store('toep_role', 'guest');
    store('toep_room', code);
    showHome(`Verbinden met kamer ${code}…`);
    const peer = new window.Peer();
    net.peer = peer;
    let pendingName = name;
    const connectHost = () => {
      const conn = peer.connect(PEER_PREFIX + code, { reliable: true });
      net.hostConn = conn;
      conn.on('open', () => {
        net.retry = 0;
        conn.send({ t: 'hello', pid });
        if (pendingName) { send('join', { name: pendingName }); pendingName = null; }
      });
      conn.on('data', msg => {
        if (msg.t === 'state') setState(msg.s);
        if (msg.t === 'ack' && net.waiting.has(msg.id)) {
          net.waiting.get(msg.id)(msg);
          net.waiting.delete(msg.id);
        }
      });
      conn.on('close', () => reconnectLater(connectHost));
    };
    net.connectHost = connectHost;
    peer.on('open', connectHost);
    peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
    peer.on('error', err => {
      if (err.type === 'peer-unavailable') {
        if (!S) {
          toast(`Kamer ${code} niet gevonden. Klopt de code en is de host online?`, 'err');
          leaveRoom(false);
        } else {
          reconnectLater(connectHost);
        }
      } else {
        toast('Verbindingsfout: ' + (err.type || err.message), 'err');
      }
    });
  }

  function reconnectLater(fn) {
    if (net.role !== 'guest' || !net.peer || net.peer.destroyed) return;
    $('#conn').hidden = false;
    clearTimeout(net.retryTimer);
    net.retryTimer = setTimeout(fn, Math.min(10000, 1500 * ++net.retry));
  }

  function send(type, data = {}) {
    if (net.role === 'host') {
      try {
        net.table.handle(pid, { type, ...data });
        return Promise.resolve(true);
      } catch (e) {
        if (e.name !== 'GameError') console.error(e);
        toast(e.name === 'GameError' ? e.message : 'Er ging iets mis.', 'err');
        return Promise.resolve(false);
      }
    }
    const conn = net.hostConn;
    if (!conn || !conn.open) {
      toast('Geen verbinding met de host.', 'err');
      return Promise.resolve(false);
    }
    const id = ++net.reqId;
    return new Promise(resolve => {
      const timer = setTimeout(() => { net.waiting.delete(id); toast('De host reageert niet.', 'err'); resolve(false); }, 8000);
      net.waiting.set(id, res => {
        clearTimeout(timer);
        if (!res.ok) toast(res.error, 'err');
        resolve(res.ok);
      });
      conn.send({ t: 'act', id, a: { type, ...data } });
    });
  }

  function leaveRoom(reload = true) {
    store('toep_role', '');
    store('toep_room', '');
    if (net.role === 'host') store('toep_host', '');
    if (reload) {
      location.href = location.pathname;
      return;
    }
    if (net.peer) net.peer.destroy();
    Object.assign(net, { role: null, room: null, peer: null, table: null, hostConn: null });
    net.conns.clear();
    S = null;
    showHome();
  }

  function savedHost() {
    try {
      const h = JSON.parse(store('toep_host') || 'null');
      return h && Date.now() - h.at < HOST_SAVE_MAX_AGE ? h : null;
    } catch (e) { return null; }
  }

  // Startscherm voor de telefoonversie: kamer maken of meedoen.
  function showHome(busy) {
    $('#lobby').hidden = true;
    $('#game').hidden = true;
    $('#home').hidden = false;
    $('#homeBusy').hidden = !busy;
    $('#homeBusy').textContent = busy || '';
    $('#homeForm').hidden = !!busy;
    const resume = savedHost();
    const room = store('toep_room');
    const bits = [];
    if (resume) bits.push(`<button class="btn ghost" type="button" data-act="resumeHost">Kamer ${esc(resume.room)} hervatten (host)</button>`);
    if (store('toep_role') === 'guest' && room) bits.push(`<button class="btn ghost" type="button" data-act="rejoin">Terug naar kamer ${esc(room)}</button>`);
    $('#homeResume').innerHTML = bits.join('');
  }

  async function startP2P(action, extra) {
    const name = $('#homeName').value.trim() || store('toep_name') || '';
    if ((action === 'host' || action === 'join') && !name) {
      toast('Vul eerst je naam in.', 'err');
      $('#homeName').focus();
      return;
    }
    if (name) store('toep_name', name);
    try {
      await loadPeerJs();
    } catch (e) {
      toast(e.message, 'err');
      return;
    }
    requestWakeLock();
    if (action === 'host') hostRoom(name, null);
    else if (action === 'resumeHost') hostRoom(name, savedHost());
    else if (action === 'join') joinRoom(extra, name);
    else if (action === 'rejoin') joinRoom(store('toep_room'), null);
  }

  // Scherm aan houden tijdens het spelen (werkt alleen via https).
  let wakeLock = null;
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) { /* niet ondersteund of geweigerd */ }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (net.role) {
      requestWakeLock();
      if (net.peer && net.peer.disconnected && !net.peer.destroyed) net.peer.reconnect();
      if (net.role === 'guest' && (!net.hostConn || !net.hostConn.open)) reconnectLater(net.connectHost);
    }
  });


  // ---------- bouwstenen ----------

  function cardHTML(c, cls = '', attrs = '') {
    const r = rankOf(c), s = suitOf(c), label = RL[r] || r;
    const center = RL[r] && r !== 'A' ? `<span class="face">${label}<i>${SYM[s]}</i></span>` : SYM[s];
    return `<div class="card s${s} ${cls}" ${attrs} aria-label="${SUIT_NAME[s]} ${label}">` +
      `<div class="ci"><b>${label}</b><i>${SYM[s]}</i></div>` +
      `<div class="cc">${center}</div>` +
      `<div class="ci ci2"><b>${label}</b><i>${SYM[s]}</i></div></div>`;
  }

  function sortHand(hand) {
    return [...hand].sort((a, b) =>
      SUIT_ORDER.indexOf(suitOf(a)) - SUIT_ORDER.indexOf(suitOf(b)) || ORDER.indexOf(rankOf(a)) - ORDER.indexOf(rankOf(b)));
  }

  // Strafpunten als krijtstreepjes per vijftal, lege streepjes laten zien hoe ver je nog kunt.
  function tally(n, max) {
    let html = '';
    for (let g = 0; g < Math.ceil(max / 5); g++) {
      const k = Math.max(0, Math.min(5, n - g * 5));
      let lines = '';
      for (let i = 0; i < 4; i++) lines += `<line class="${i < k ? 'on' : ''}" x1="${5 + i * 6}" y1="4" x2="${5 + i * 6}" y2="20"/>`;
      lines += `<line class="d ${k === 5 ? 'on' : ''}" x1="1" y1="17" x2="27" y2="7"/>`;
      html += `<svg viewBox="0 0 28 24" aria-hidden="true">${lines}</svg>`;
    }
    return `<span class="tally${n >= max - 1 ? ' scherp' : ''}" title="${n} van ${max} strafpunten">${html}</span>`;
  }

  const base = () => (S.me == null ? 0 : S.me);
  const rel = seat => (seat - base() + 4) % 4;
  const hasLives = () => S.settings.mode !== 'finale';
  const lives = (p, extra = '') => (hasLives() ? tally(p.points, S.settings.maxPoints) + extra : '');

  // Waar elke speler aan tafel zit, gezien vanaf jou (onderaan). Met één
  // tegenstander zit die tegenover je, met twee links en rechts.
  function layout() {
    const others = [1, 2, 3].map(r => (base() + r) % 4).filter(s => S.players[s]);
    const spots = others.length === 1 ? ['top'] : others.length === 2 ? ['left', 'right'] : ['left', 'top', 'right'];
    const map = { [base()]: 'bottom' };
    others.forEach((s, i) => { map[s] = spots[i]; });
    return map;
  }
  const nameOf = seat => (S.players[seat] ? S.players[seat].name : '?');
  const meP = () => (S.me == null ? null : S.players[S.me]);

  // ---------- render ----------

  function render() {
    if (!S) return;
    const inGame = S.phase !== 'lobby';
    $('#home').hidden = true;
    $('#lobby').hidden = inGame;
    $('#game').hidden = !inGame;

    const key = `${S.phase}|${S.turn}|${S.trickNo}|${S.round}`;
    if (key !== selectKey) { selected = null; blindPick = false; selectKey = key; }

    if (inGame) renderGame(); else renderLobby();
    renderOverlay();
    renderDrawer();
    handleLogs();
    notify();
  }

  // ----- lobby -----

  function renderLobby() {
    const seated = S.me != null;
    $('#joinForm').hidden = seated;
    const P = S.players;
    const filled = P.filter(Boolean).length;
    const st = S.settings;
    const kroeg = st.mode === 'kroeg';
    const dis = seated ? '' : 'disabled';

    const seats = P.map((p, i) => {
      if (!p) {
        return `<li class="seat empty"><span class="av">+</span><span class="nm">Vrije stoel</span>` +
          (seated ? `<button class="mini" data-act="addBot">+ Bot</button>` : '') + `</li>`;
      }
      const isMe = p.seat === S.me;
      return `<li class="seat ${isMe ? 'me' : ''}"><span class="av">${p.bot ? '🤖' : initial(p.name)}</span>` +
        `<span class="nm">${esc(p.name)}${isMe ? ' <em>(jij)</em>' : ''}</span>` +
        (p.wins ? `<span class="wins" title="Gewonnen potjes">🏆 ${p.wins}</span>` : '') +
        (p.bot
          ? (seated
            ? `<button class="mini lvl lvl-${p.level}" data-act="botLevel" data-seat="${i}" aria-label="Niveau wijzigen">${LEVEL_NAME[p.level]} ▾</button>` +
              `<button class="mini" data-act="removeBot" data-seat="${i}">Weg</button>`
            : `<span class="mini lvl lvl-${p.level}">${LEVEL_NAME[p.level]}</span>`)
          : `<span class="dot ${p.online ? 'on' : ''}" title="${p.online ? 'online' : 'offline'}"></span>`) +
        `</li>`;
    }).join('');

    const finale = st.mode === 'finale';
    let rules;
    if (kroeg) {
      rules = `<ul class="rulelist">${HOUSE_RULES.map(r => `<li><button class="rule" data-act="rule" data-rule="${r.key}" aria-pressed="${!!st.rules[r.key]}" ${dis}>` +
        `<span class="ri">${r.icon}</span><span class="rt"><b>${r.name}</b><span>${r.text}</span></span><span class="switch"></span></button></li>`).join('')}</ul>`;
    } else if (finale) {
      rules = `<p class="note" style="margin:12px 0 0">Eén ronde, 8 kaarten per persoon, niet toepen. Wie de laatste slag wint, wint het potje.</p>`;
    } else {
      rules = `<p class="note" style="margin:12px 0 0">Toepen, meegaan of passen, blind spelen, op scherp en de finale met 8 kaarten. Kroegregels voegt daar extra's aan toe.</p>`;
    }
    const maxRow = finale ? '' : `
        <div class="setting"><span>Af bij</span>
          <div class="seg">
            <button data-act="max" data-max="10" aria-pressed="${st.maxPoints === 10}" ${dis}>10</button>
            <button data-act="max" data-max="15" aria-pressed="${st.maxPoints === 15}" ${dis}>15</button>
          </div>
        </div>`;

    let startLabel = filled === 4 ? 'Start het spel!' : `Start met ${filled} spelers`;
    if (!seated) startLabel = 'Schuif eerst aan';
    else if (filled < 2) startLabel = 'Wachten op een tweede speler';

    $('#lobbyBody').innerHTML = `
      <section class="panel">
        <div class="panel-head"><h2>Aan tafel</h2><span class="count">${filled}/4</span></div>
        <ul class="seats">${seats}</ul>
        ${seated && filled < 4 ? '<p class="note" style="margin:10px 0 0">Spelen kan met 2, 3 of 4. Vul eventueel aan met bots.</p>' : ''}
        ${seated && P.some(p => p && p.bot) ? '<p class="note" style="margin:10px 0 0">Tik op het niveau van een bot om het te wisselen.</p>' : ''}
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Spelvorm</h2><button class="link" data-act="openMenu">Spelregels</button></div>
        <div class="seg">
          <button data-act="mode" data-mode="klassiek" aria-pressed="${st.mode === 'klassiek'}" ${dis}>Klassiek</button>
          <button data-act="mode" data-mode="kroeg" aria-pressed="${kroeg}" ${dis}>Kroeg</button>
          <button data-act="mode" data-mode="finale" aria-pressed="${finale}" ${dis}>Finale</button>
        </div>
        ${maxRow}
        ${rules}
      </section>
      <div class="lobby-actions">
        <button class="btn primary big" data-act="start" ${seated && filled >= 2 ? '' : 'disabled'}>${startLabel}</button>
        ${seated ? '<button class="btn ghost" data-act="leave">Opstaan</button>' : ''}
      </div>`;

    renderInvite();
  }

  function renderInvite() {
    const urls = (S.urls && S.urls.length) ? S.urls : [location.origin];
    const box = $('#inviteUrls');
    const html = (S.room ? `<div class="room-code">Code <b>${esc(S.room)}</b></div>` : '') +
      urls.map(u => `<div class="url">${esc(u)}</div>`).join('');
    if (box.innerHTML !== html) box.innerHTML = html;
    if (qrUrl !== urls[0] && window.QRCode) {
      qrUrl = urls[0];
      $('#qr').innerHTML = '';
      try {
        new window.QRCode($('#qr'), { text: qrUrl, width: 240, height: 240, correctLevel: window.QRCode.CorrectLevel.M });
      } catch (e) { $('#qr').innerHTML = ''; }
    }
  }

  // ----- spel -----

  function renderGame() {
    renderHud();
    const map = layout();
    for (const pos of ['left', 'top', 'right']) {
      const seat = S.players.findIndex((p, s) => p && s !== base() && map[s] === pos);
      $('#opp-' + pos).innerHTML = seat >= 0 ? oppHTML(S.players[seat], pos) : '';
    }
    renderTrick();
    renderPrompt();
    renderMe();
    renderHand();
  }

  function renderHud() {
    let phaseText = '';
    if (S.phase === 'blind' || S.phase === 'blindResp') phaseText = 'Blind?';
    else if (S.phase === 'scherp') phaseText = 'Op scherp!';
    else if (S.phase === 'wash' || S.phase === 'washCheck') phaseText = 'Was?';
    else if (S.phase === 'pass') phaseText = 'Doorgeven';
    else if (S.phase === 'roundEnd') phaseText = 'Einde ronde';
    else if (S.phase === 'gameEnd') phaseText = 'Einde spel';
    else phaseText = `${S.final ? 'Finale · ' : ''}Slag ${Math.min(S.trickNo, S.tricksTotal)} van ${S.tricksTotal}`;
    if (S.blind && S.phase !== 'blindResp' && S.phase !== 'roundEnd') phaseText += ` · blind ${S.blind.amount}`;
    $('#info').innerHTML = `<b>Ronde ${S.round}</b>${phaseText}`;
    const stake = $('#stake');
    stake.innerHTML = `Inzet <b>${S.stake}</b>`;
    stake.hidden = S.final; // in een finale gaat het om alles
    if (prevStake && S.stake > prevStake) {
      stake.classList.remove('bump'); void stake.offsetWidth; stake.classList.add('bump');
    }
    prevStake = S.stake;
  }

  function statusChip(p) {
    const ph = S.phase, s = p.seat;
    if (p.dead) return { t: 'Af', cls: 'grey' };
    if (ph === 'blind') return p.acting ? { t: 'Denkt…', cls: 'wait' } : { t: 'Klaar', cls: 'ok' };
    if (ph === 'blindResp') {
      const r = S.blind.resp[s];
      if (S.blind.by === s) return { t: `Blind ${S.blind.amount}!`, cls: 'hot' };
      if (r === 'blind') return { t: 'Blind mee', cls: 'ok' };
      if (r === 'mee') return { t: 'Gezien mee', cls: 'ok' };
      if (r === 'weg') return { t: 'Weg', cls: 'grey' };
      if (r === 'seen') return { t: 'Kijkt…', cls: 'wait' };
      return { t: 'Denkt…', cls: 'wait' };
    }
    if (ph === 'scherp') {
      if (S.scherp.seats.includes(s)) return { t: 'Op scherp', cls: 'hot' };
      if (S.scherp.resp[s] === true) return { t: 'Mee', cls: 'ok' };
      if (S.scherp.resp[s] === false) return { t: 'Weg', cls: 'grey' };
      return { t: 'Denkt…', cls: 'wait' };
    }
    if (p.folded) return { t: 'Weg', cls: 'grey' };
    if (ph === 'wash') return p.acting ? { t: 'Kijkt…', cls: 'wait' } : { t: 'Klaar', cls: 'ok' };
    if (ph === 'washCheck') {
      if (S.washCheck.seat === s) return { t: 'Was!', cls: 'hot' };
      return p.acting ? { t: 'Denkt…', cls: 'wait' } : null;
    }
    if (ph === 'pass') return p.acting ? { t: 'Kiest…', cls: 'wait' } : { t: 'Klaar', cls: 'ok' };
    if (ph === 'toep') {
      if (S.toep.by === s) return { t: 'Toept!', cls: 'hot' };
      if (S.toep.responses[s] === true) return { t: 'Mee', cls: 'ok' };
      if (p.acting) return { t: 'Denkt…', cls: 'wait' };
    }
    if (ph === 'play' && S.turn === s) return { t: 'Aan zet', cls: 'turn' };
    return null;
  }

  function oppHTML(p, pos) {
    if (!p) return '';
    const chip = statusChip(p);
    const backs = Array.from({ length: p.cards }, () => '<i class="mback"></i>').join('');
    return `<div class="opp ${p.acting ? 'acting' : ''} ${p.folded ? 'folded' : ''} ${p.dead ? 'dead' : ''}">
      <div class="av">${p.bot ? '🤖' : initial(p.name)}${p.online ? '' : '<span class="off" title="Offline">!</span>'}</div>
      <div class="ob">
        <div class="nm">${esc(p.name)}</div>
        ${lives(p)}
        ${pos === 'top' ? '' : `<div class="backs">${backs}</div>`}
        ${chip ? `<div class="chip ${chip.cls}">${chip.t}</div>` : ''}
      </div>
      ${pos === 'top' ? `<div class="backs">${backs}</div>` : ''}
    </div>`;
  }

  function renderTrick() {
    let html = '';
    if (!S.trick.length && (S.phase === 'play' || S.phase === 'toep')) {
      const who = S.turn === S.me ? 'Jij komt uit' : `${esc(nameOf(S.turn))} komt uit`;
      html = `<div class="hint"><div>${S.final ? '<div class="last">FINALE</div>' : ''}<div class="hint-big">Slag ${S.trickNo}/${S.tricksTotal}</div>` +
        (S.trickNo === S.tricksTotal ? '<div class="last">Laatste slag — deze telt!</div>' : '') +
        `<div>${who}</div></div></div>`;
    } else if (!S.trick.length && ['blind', 'blindResp', 'scherp', 'wash', 'washCheck', 'pass'].includes(S.phase)) {
      let sub = `${esc(nameOf(S.leader))} komt straks uit`;
      if (S.phase === 'blind') sub = 'Kaarten liggen nog dicht…';
      if (S.phase === 'blindResp') sub = `${esc(nameOf(S.blind.by))} speelt blind voor ${S.blind.amount}`;
      if (S.phase === 'scherp') sub = `${S.scherp.seats.map(nameOf).map(esc).join(' en ')} moet genomen worden`;
      html = `<div class="hint"><div><div class="hint-big">Ronde ${S.round}</div><div>${sub}</div></div></div>`;
    }
    for (const t of S.trick) {
      const pos = layout()[t.seat] || POS[rel(t.seat)];
      const key = `${S.round}.${S.trickNo}.${t.seat}.${t.card}`;
      const enter = !animSeen.has(key);
      animSeen.add(key);
      const p = S.players[t.seat];
      let cls = '';
      if (S.trickWinner === t.seat) cls = 'win';
      else if (S.trickWinner >= 0 || (p && p.folded)) cls = 'lose';
      html += `<div class="tslot t-${pos} ${cls}">${cardHTML(t.card, enter ? 'enter from-' + pos : '')}</div>`;
    }
    $('#trick').innerHTML = html;
  }

  function promptState() {
    const me = S.me, mp = meP();
    const wait = text => ({ tone: '', html: `<div class="pt"><span class="dots">${text}</span></div>` });
    if (me == null) return { tone: '', html: '<div class="pt">Je kijkt mee 👀 — er is al een spel bezig.</div>' };
    if (mp.dead) return { tone: '', html: '<div class="pt">Je bent af 💀 Kijk lekker mee en bestel een rondje.</div>' };

    const extra = S.myExtra || 0;
    switch (S.phase) {
      case 'blind': {
        if (S.blindDecision !== null) return wait('Wachten tot iedereen gekozen heeft');
        if (blindPick) {
          const btns = [2, 3, 4].map(n => `<button class="btn toep" data-act="blind" data-amount="${n}">${n}</button>`).join('');
          return {
            tone: 'turn',
            html: `<div class="pt">Blind voor hoeveel punten?<small>Nog ${S.blindsLeft}× blind dit potje.</small></div>` +
              `<div class="pb">${btns}<button class="btn ghost" data-act="blindBack">Terug</button></div>`,
          };
        }
        return {
          tone: 'turn',
          html: `<div class="pt">Kijken of blind?<small>Nog niemand heeft zijn kaarten gezien.</small></div>` +
            `<div class="pb"><button class="btn toep" data-act="blindPick">Blind</button>` +
            `<button class="btn primary" data-act="blind" data-amount="0">Kijken</button></div>`,
        };
      }
      case 'blindResp': {
        const b = S.blind, n = b.amount;
        if (b.by === me) return wait(`Je speelt blind voor ${n}. Wat doen de anderen`);
        if (!b.pending.includes(me)) {
          if (S.blindResp === 'blind') return wait(`Je gaat blind mee voor ${n}. Wachten op de anderen`);
          return wait('Wachten op de anderen');
        }
        if (S.blindResp === 'seen') {
          return {
            tone: 'alert',
            html: `<div class="pt">Je hebt gekeken. Mee voor <b>${n + 1}</b> of weg voor ${n}?<small>Weg = ${plural(n)}.</small></div>` +
              `<div class="pb"><button class="btn ghost" data-act="blindResp" data-choice="weg">Weg</button>` +
              `<button class="btn primary" data-act="blindResp" data-choice="mee">Mee (${n + 1})</button></div>`,
          };
        }
        return {
          tone: 'alert',
          html: `<div class="pt"><b>${esc(nameOf(b.by))}</b> speelt blind voor ${n}!` +
            `<small>Blind mee = ${n}. Gezien = je kijkt eerst, dan mee voor ${n + 1} of weg voor ${n}.</small></div>` +
            `<div class="pb"><button class="btn ghost" data-act="blindResp" data-choice="seen">Gezien</button>` +
            `<button class="btn primary" data-act="blindResp" data-choice="blind">Blind mee (${n})</button></div>`,
        };
      }
      case 'scherp': {
        const sc = S.scherp;
        const names = sc.seats.map(nameOf).map(esc).join(' en ');
        if (sc.seats.includes(me)) return wait(`Je staat op ${S.edge}: je moet genomen worden. Wie gaat er mee`);
        if (sc.pending.includes(me)) {
          return {
            tone: 'alert',
            html: `<div class="pt"><b>${names}</b> staat op ${S.edge} en moet genomen worden!<small>Mee = voor 2 punten, weg = 1 strafpunt.</small></div>` +
              `<div class="pb"><button class="btn ghost" data-act="scherp" data-go="0">Weg (1)</button>` +
              `<button class="btn primary" data-act="scherp" data-go="1">Mee (2)</button></div>`,
          };
        }
        return wait('Wachten op de anderen');
      }
      case 'wash':
        if (S.washDecision === null) {
          return {
            tone: 'turn',
            html: `<div class="pt">${S.isWas ? 'Je hebt een <b>was</b>! Nieuwe kaarten?' : 'Bekijk je kaarten.'}` +
              `<small>${S.isWas ? 'Claimen mag, maar iemand kan controleren.' : 'Durf je te bluffen met een was?'}</small></div>` +
              `<div class="pb"><button class="btn ${S.isWas ? 'toep' : 'ghost'}" data-act="wash" data-claim="1">Was!</button>` +
              `<button class="btn ${S.isWas ? 'ghost' : 'primary'}" data-act="wash" data-claim="0">Spelen</button></div>`,
          };
        }
        return wait('Wachten tot iedereen gekeken heeft');
      case 'washCheck': {
        const wc = S.washCheck;
        if (wc.seat === me) return wait('Je claimt een was. Durft iemand te controleren');
        if (wc.pending.includes(me)) {
          return {
            tone: 'alert',
            html: `<div class="pt"><b>${esc(nameOf(wc.seat))}</b> claimt een was!<small>Controleren? Klopt de was, dan krijg jij een strafpunt.</small></div>` +
              `<div class="pb"><button class="btn ghost" data-act="check">Controleer</button><button class="btn primary" data-act="believe">Geloof ik</button></div>`,
          };
        }
        return wait('Wachten op de anderen');
      }
      case 'pass':
        if (S.passCard == null) {
          return {
            tone: 'turn',
            html: `<div class="pt">Kies een kaart voor <b>${esc(S.passTarget || '')}</b><small>Tik een kaart aan en geef hem door.</small></div>` +
              `<div class="pb"><button class="btn primary" data-act="pass" ${selected ? '' : 'disabled'}>Doorgeven</button></div>`,
          };
        }
        return wait('Wachten tot iedereen heeft doorgegeven');
      case 'toep': {
        const t = S.toep;
        if (t.pending.includes(me)) {
          const prev = t.prev + extra, now = S.stake + extra;
          return {
            tone: 'alert',
            html: `<div class="pt"><b>${esc(nameOf(t.by))}</b> toept! Inzet ${prev} → <b>${now}</b>` +
              `<small>Pas je, dan krijg je ${plural(prev)}.</small></div>` +
              `<div class="pb"><button class="btn ghost" data-act="fold">Pas</button><button class="btn primary" data-act="go">Mee!</button></div>`,
          };
        }
        if (t.by === me) return wait('Je toept! Wachten op de anderen');
        if (mp.folded) return wait('Je hebt gepast deze ronde');
        return wait('Wachten op de anderen');
      }
      case 'play': {
        if (mp.folded) return wait('Je hebt gepast. Wachten op de volgende ronde');
        if (S.turn !== me) return wait(`${esc(nameOf(S.turn))} is aan de beurt`);
        let text;
        if (selected) text = 'Tik nog een keer op de kaart om te spelen';
        else if (!S.trick.length) text = 'Jouw beurt — jij komt uit';
        else {
          const lead = suitOf(S.trick[0].card);
          const can = (S.hand || []).some(c => suitOf(c) === lead);
          text = can ? `Jouw beurt — beken ${SYM[lead]} ${SUIT_NAME[lead]}` : `Jouw beurt — geen ${SUIT_NAME[lead]}, gooi iets weg`;
        }
        const sub = S.trickNo === S.tricksTotal ? '<small>Laatste slag — deze telt!</small>'
          : S.final ? '<small>Finale: geen toepen, de laatste slag beslist.</small>'
          : S.toepBlocked ? `<small>${esc(S.toepBlocked)}</small>`
          : S.lastToeper === me ? '<small>Je toepte als laatste, nu even niet.</small>'
          : selected ? '' : '<small>Tik een kaart aan om te spelen.</small>';
        let btns = '';
        const mine = S.stake + extra;
        if (S.canToep) btns += `<button class="btn toep" data-act="toep">Toep! <small>${mine}→${mine + 1}</small></button>`;
        if (S.canDouble) btns += `<button class="btn toep" data-act="toep2">2× <small>${mine}→${mine + 2}</small></button>`;
        return { tone: 'turn', html: `<div class="pt">${text}${sub}</div>${btns ? `<div class="pb">${btns}</div>` : ''}` };
      }
      case 'trickEnd': {
        const w = S.trickWinner === me ? 'Jij wint' : `${esc(nameOf(S.trickWinner))} wint`;
        const end = S.final ? ' — en de finale!' : ' — en de ronde!';
        return { tone: 'info', html: `<div class="pt">${w} de slag${S.trickNo === S.tricksTotal ? end : '.'}</div>` };
      }
      default:
        return { tone: '', html: '<div class="pt"></div>' };
    }
  }

  function renderPrompt() {
    const { tone, html } = promptState();
    const el = $('#prompt');
    const cls = 'prompt' + (tone ? ' ' + tone : '');
    if (el.className !== cls) el.className = cls;
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  function renderMe() {
    const p = meP();
    if (!p) { $('#mebar').innerHTML = ''; return; }
    const chip = ['play', 'toep', 'scherp', 'blindResp'].includes(S.phase) || p.dead || p.folded ? statusChip(p) : null;
    const inPlay = ['play', 'toep', 'trickEnd'].includes(S.phase) && !p.folded && !p.dead;
    $('#mebar').className = 'mebar' + (p.acting ? ' acting' : '');
    $('#mebar').innerHTML = `<span class="av">${initial(p.name)}</span><span class="nm">${esc(p.name)}</span>` +
      (chip ? `<span class="chip ${chip.cls}">${chip.t}</span>` : '') +
      (inPlay && S.myExtra ? `<span class="chip hot">jij: ${S.stake + S.myExtra}</span>` : '') +
      (hasLives() ? `<span class="pts">${lives(p)} ${p.points}/${S.settings.maxPoints}</span>`
        : `<span class="pts">🏆 ${p.wins}</span>`);
  }

  function renderHand() {
    const el = $('#hand');
    const p = meP();
    if (!p) { el.className = 'hand'; el.innerHTML = ''; return; }
    const hand = sortHand(S.hand || []);
    const legal = new Set(S.legal || []);
    const playing = S.phase === 'play' && S.turn === S.me;
    const passing = S.phase === 'pass' && S.passCard == null;
    if (selected && !hand.includes(selected)) selected = null;
    if (S.handHidden) {
      el.className = 'hand';
      el.innerHTML = Array.from({ length: S.handCount }, () => '<div class="card back"></div>').join('');
      return;
    }
    el.className = 'hand' + (playing ? ' playing' : '') + (hand.length > 4 ? ' many' : '');
    if (!hand.length) {
      el.innerHTML = `<div class="empty-hand">${p.dead ? 'Geen kaarten meer — je bent af.' : ''}</div>`;
      return;
    }
    el.innerHTML = hand.map(c => {
      const cls = [];
      if ((playing && legal.has(c)) || passing) cls.push('legal');
      if (selected === c || S.passCard === c) cls.push('sel');
      if (S.received === c && S.trickNo === 1 && S.phase !== 'pass') cls.push('recv');
      return cardHTML(c, cls.join(' '), `data-card="${c}" role="button"`);
    }).join('');
  }

  // ----- overlay -----

  function standingsHTML(result) {
    const max = S.settings.maxPoints;
    const lines = {};
    if (result) for (const l of result.lines) lines[l.seat] = l;
    const rows = S.players.filter(Boolean).map(p => {
      const l = lines[p.seat];
      let delta = '', dcls = '', note = '';
      if (l) {
        if (l.pen > 0) { delta = '+' + l.pen; dcls = 'plus'; }
        else if (l.pen < 0) { delta = '−1'; dcls = 'min'; }
        else delta = '🏆';
        if (l.note === 'weg') note = 'weg';
        else if (l.note === 'boerenslag') note = 'boerenslag +1';
        else if (l.note === 'comeback') note = 'comeback!';
      }
      if (p.dead) note = note ? note + ' · af' : 'af';
      if (!result) note = `🏆 ${p.wins}× gewonnen` + (p.dead ? ' · af' : '');
      const isWin = result ? result.winner === p.seat : S.winner === p.seat;
      return { p, html: `<li class="${isWin ? 'win' : ''} ${p.dead ? 'out' : ''}">` +
        `<span class="av">${p.bot ? '🤖' : initial(p.name)}</span>` +
        `<span class="nm">${esc(p.name)}${p.seat === S.me ? ' (jij)' : ''}${note ? `<small>${note}</small>` : ''}</span>` +
        (hasLives() ? `${tally(p.points, max)}<span class="pts">${p.points}/${max}</span>` : '') +
        (result ? `<span class="delta ${dcls}">${delta}</span>` : '') + `</li>` };
    });
    if (!result) rows.sort((a, b) => (b.p.seat === S.winner) - (a.p.seat === S.winner) || (a.p.dead - b.p.dead) || a.p.points - b.p.points);
    return `<ul class="standings">${rows.map(r => r.html).join('')}</ul>`;
  }

  function renderOverlay() {
    const o = $('#overlay');
    let key = '', html = '';
    if (S.phase === 'roundEnd' && S.result) {
      const r = S.result;
      key = `round-${S.round}`;
      const w = r.winner === S.me ? `Jij wint de ${r.final ? 'finale' : 'ronde'}!` : `${esc(nameOf(r.winner))} wint${r.final ? ' de finale' : ''}!`;
      const bits = [r.byFold ? 'De rest ging weg' : `Inzet ${r.stake}`];
      if (r.blind) bits.push(`blind ${r.blind}`);
      if (r.boer) bits.push('<b>Boerenslag! +1</b>');
      if (r.comeback) bits.push('<b>Comeback! −1</b>');
      html = `<div class="sheet"><div class="kicker">Ronde ${S.round}</div><h2>${w}</h2><p class="sub">${bits.join(' · ')}</p>` +
        standingsHTML(r) +
        `<div class="btns"><button class="btn primary big" data-act="next">Volgende ronde <span id="cd"></span></button></div></div>`;
      if (overlayKey !== key) roundDeadline = Date.now() + S.nextRoundIn;
    } else if (S.phase === 'gameEnd') {
      key = `game-${S.round}`;
      const w = S.winner === S.me ? 'Jij wint het spel!' : `${esc(nameOf(S.winner))} wint het spel!`;
      const seated = S.me != null;
      html = `<div class="sheet"><div class="trophy">🏆</div><h2>${w}</h2><p class="sub">Potje ${S.gamesPlayed}, na ${S.round} ronde${S.round === 1 ? '' : 's'}. Wie geeft er een rondje?</p>` +
        standingsHTML(null) +
        (seated ? `<div class="btns"><button class="btn primary big" data-act="rematch">Nog een potje!</button>` +
          `<button class="btn dark" data-act="toLobby">Naar de lobby</button></div>` : '') + `</div>`;
    }
    if (!key) {
      o.hidden = true;
      o.innerHTML = '';
      overlayKey = '';
      return;
    }
    if (key !== overlayKey) {
      o.innerHTML = html;
      overlayKey = key;
    }
    o.hidden = false;
    tickCountdown();
  }

  function tickCountdown() {
    const el = document.getElementById('cd');
    if (!el) return;
    const s = Math.max(0, Math.ceil((roundDeadline - Date.now()) / 1000));
    el.textContent = `(${s})`;
  }
  setInterval(tickCountdown, 250);

  // ----- menu -----

  function renderDrawer() {
    const logs = (S.log || []).filter(l => l.kind !== 'quiet' || /Ronde|begint/.test(l.text));
    const board = S.players.filter(Boolean).sort((a, b) => b.wins - a.wins);
    $('#winList').innerHTML = S.gamesPlayed
      ? board.map(p => `<li>${esc(p.name)} — ${p.wins}× gewonnen</li>`).join('')
      : '<li>Nog geen potje uitgespeeld.</li>';
    $('#logList').innerHTML = logs.slice(-12).map(l => `<li>${esc(l.text)}</li>`).join('') || '<li>Nog niets gebeurd.</li>';
    const inGame = S.phase !== 'lobby' && S.me != null;
    let actions = inGame ? '<button class="btn dark" data-act="lobby">Spel stoppen → lobby</button>' : '';
    if (net.role) {
      const label = net.role === 'host' ? `Kamer ${esc(net.room)} sluiten` : `Kamer ${esc(net.room)} verlaten`;
      actions += `<button class="btn dark" data-act="leaveRoom">${label}</button>`;
    }
    $('#drawerActions').innerHTML = actions;
  }
  function openMenu() { $('#drawer').classList.add('open'); $('#drawer').setAttribute('aria-hidden', 'false'); }
  function closeMenu() { $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true'); }

  // ---------- meldingen ----------

  function toast(text, kind = '', cards = null) {
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.innerHTML = `<div>${esc(text)}</div>` + (cards ? `<div class="tcards">${cards.map(c => cardHTML(c, 'mini')).join('')}</div>` : '');
    const box = $('#toasts');
    box.append(t);
    while (box.children.length > 3) box.firstChild.remove();
    const life = cards ? 4500 : 2800;
    setTimeout(() => t.classList.add('out'), life);
    setTimeout(() => t.remove(), life + 400);
  }

  function splash(big, small) {
    const el = $('#splash');
    el.innerHTML = `<div class="splash-in"><div class="big">${big}</div><div class="small">${esc(small)}</div></div>`;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(splashTimer);
    splashTimer = setTimeout(() => el.classList.remove('show'), 2000);
  }

  function handleLogs() {
    const logs = S.log || [];
    const last = logs.length ? logs[logs.length - 1].id : 0;
    if (seenLog < 0 || last < seenLog) { seenLog = last; return; } // eerste keer of server herstart
    for (const l of logs) {
      if (l.id <= seenLog) continue;
      seenLog = l.id;
      if (l.kind === 'quiet' || S.phase === 'lobby') continue;
      if (l.kind === 'toep') splash(l.amount === 2 ? 'DUBBEL!' : 'TOEP!', l.text);
      else if (l.kind === 'blind') splash(`BLIND ${l.amount}!`, l.text);
      else if (l.kind === 'final') splash('FINALE!', l.text);
      else if (l.kind === 'scherp') splash('OP SCHERP!', l.text);
      else if ((l.kind === 'round' && S.phase === 'roundEnd') || (l.kind === 'game' && S.phase === 'gameEnd')) continue; // staat al in het overzicht
      else toast(l.text, l.kind, l.cards || null);
    }
  }

  function notify() {
    const p = meP();
    const needs = !!(p && p.acting) && S.phase !== 'wash' && S.phase !== 'blind';
    if (needs && !prevNeeds && navigator.vibrate) {
      try { navigator.vibrate(S.phase === 'toep' || S.phase === 'washCheck' ? [90, 60, 90] : 60); } catch (e) { /* niet ondersteund */ }
    }
    prevNeeds = needs;
    document.title = needs ? '● Jouw beurt — Toepen' : 'Toepen';
  }

  // ---------- invoer ----------

  async function act(type, data) {
    if (sending) return;
    sending = true;
    try { await send(type, data); } finally { sending = false; }
  }

  function onCard(c) {
    if (!S || S.me == null) return;
    if (S.phase === 'pass' && S.passCard == null) {
      selected = selected === c ? null : c;
      render();
      return;
    }
    if (S.phase === 'play' && S.turn === S.me) {
      if (!(S.legal || []).includes(c)) {
        const lead = S.trick.length ? suitOf(S.trick[0].card) : null;
        if (lead) toast(`Je moet ${SUIT_NAME[lead]} bekennen.`, 'err');
        return;
      }
      if (selected === c) {
        selected = null;
        act('play', { card: c });
      } else {
        selected = c;
        render();
      }
    }
  }

  function onAct(name, d) {
    switch (name) {
      case 'blind': return act('blind', { amount: Number(d.amount) });
      case 'blindPick': blindPick = true; return render();
      case 'blindBack': blindPick = false; return render();
      case 'blindResp': return act('blindResp', { choice: d.choice });
      case 'scherp': return act('scherp', { go: d.go === '1' });
      case 'botLevel': return act('botLevel', { seat: Number(d.seat) });
      case 'wash': return act('wash', { claim: d.claim === '1' });
      case 'check': return act('washResponse', { check: true });
      case 'believe': return act('washResponse', { check: false });
      case 'pass':
        if (selected) { const c = selected; selected = null; act('pass', { card: c }); }
        return;
      case 'toep': return act('toep', { amount: 1 });
      case 'toep2': return act('toep', { amount: 2 });
      case 'go': return act('toepResponse', { go: true });
      case 'fold': return act('toepResponse', { go: false });
      case 'next': return act('next');
      case 'rematch': return act('rematch');
      case 'toLobby': return act('lobby');
      case 'lobby':
        if (confirm('Spel stoppen en terug naar de lobby? De stand gaat verloren.')) { closeMenu(); act('lobby'); }
        return;
      case 'addBot': return act('addBot');
      case 'removeBot': return act('removeBot', { seat: Number(d.seat) });
      case 'mode': return act('settings', { mode: d.mode });
      case 'max': return act('settings', { maxPoints: Number(d.max) });
      case 'rule': return act('settings', { rule: d.rule });
      case 'start': return act('start');
      case 'leave': return act('leave');
      case 'openMenu': return openMenu();
      case 'closeMenu': return closeMenu();
      case 'host': return startP2P('host');
      case 'joinCode': {
        const code = $('#homeCode').value.trim().toUpperCase();
        if (!/^[A-Z]{4}$/.test(code)) {
          toast('Een kamercode heeft 4 letters.', 'err');
          $('#homeCode').focus();
          return undefined;
        }
        return startP2P('join', code);
      }
      case 'resumeHost': return startP2P('resumeHost');
      case 'rejoin': return startP2P('rejoin');
      case 'leaveRoom': {
        const q = net.role === 'host'
          ? 'Kamer sluiten? Iedereen raakt de verbinding kwijt.'
          : 'Kamer verlaten?';
        if (confirm(q)) leaveRoom();
        return undefined;
      }
    }
    return undefined;
  }

  document.addEventListener('click', e => {
    const a = e.target.closest('[data-act]');
    if (a) {
      if (a.disabled) return;
      onAct(a.dataset.act, a.dataset);
      return;
    }
    const c = e.target.closest('#hand [data-card]');
    if (c) onCard(c.dataset.card);
  });

  $('#joinForm').addEventListener('submit', e => {
    e.preventDefault();
    const name = $('#nameInput').value.trim();
    if (!name) { $('#nameInput').focus(); return; }
    store('toep_name', name);
    $('#nameInput').blur();
    act('join', { name });
  });

  $('#homeForm').addEventListener('submit', e => {
    e.preventDefault();
    onAct($('#homeCode').value.trim() ? 'joinCode' : 'host', {});
  });
  $('#homeCode').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  });

  $('#nameInput').value = store('toep_name') || '';
  $('#homeName').value = store('toep_name') || '';
  window.addEventListener('load', () => { if (S) renderInvite(); });

  const code = (params.get('kamer') || '').toUpperCase();
  if (code) $('#homeCode').value = code;
  const role = store('toep_role');
  if (role === 'host' && savedHost() && !code) {
    startP2P('resumeHost'); // host herladen: spel gaat gewoon door
  } else if (role === 'guest' && store('toep_room') && (!code || code === store('toep_room'))) {
    startP2P('rejoin');
  } else {
    showHome();
    if (code) $(store('toep_name') ? '#homeJoinBtn' : '#homeName').focus();
  }
})();
