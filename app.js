(() => {
  'use strict';

  const $ = s => document.querySelector(s);
  const SYM = { S: '♠', H: '♥', C: '♣', D: '♦' };
  const SUIT_NAME = { S: 'schoppen', H: 'harten', C: 'klaveren', D: 'ruiten' };
  const RL = { J: 'B', Q: 'V', K: 'H', A: 'A' }; // boer, vrouw, heer, aas
  const ORDER = ['J', 'Q', 'K', 'A', '7', '8', '9', '10'];
  const SUIT_ORDER = ['S', 'H', 'C', 'D'];
  const POS = ['bottom', 'left', 'top', 'right'];
  const THEMES = [
    { key: 'cafe', name: 'Bruin café', swatch: ['#2a190d', '#1f7a4d', '#fdf7e7', '#ff7a1a'] },
    { key: 'nacht', name: 'Nachtkroeg', swatch: ['#14112b', '#221d47', '#21e6c1', '#ff3c8e'] },
  ];
  const LEVEL_NAME ={ makkelijk: 'Makkelijk', gemiddeld: 'Gemiddeld', moeilijk: 'Moeilijk', god: 'God' };
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
  let moreOpen = false;      // 'Meer instellingen' in de lobby uitgeklapt
  let seenLog = -1;
  let prevNeeds = false;
  let prevStake = 0;
  let overlayKey = '';
  let roundDeadline = 0;
  let blindDeadline = 0;
  let splashTimer = 0;
  let qrUrl = '';
  let sending = false;
  const animSeen = new Map();  // kaart op tafel -> moment dat hij verscheen
  let lastTrickHtml = '';
  let lastHandHtml = '';
  let dealKey = '';
  let dealUntil = 0;
  let seenReact = -1;

  // ---------- verbinding ----------
  // De host-telefoon draait game.js zelf; de anderen verbinden rechtstreeks met
  // die telefoon via een kamercode (PeerJS/WebRTC).

  const params = new URLSearchParams(location.search);
  const PEER_PREFIX = 'toepen-tg-';
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const HOST_SAVE_MAX_AGE = 6 * 3600 * 1000;

  function setState(view) {
    S = view;
    if (S.phase === 'blind') blindDeadline = Date.now() + (S.blindIn || 0);
    $('#conn').hidden = true;
    $('#connText').textContent = 'Verbinding kwijt… opnieuw verbinden';
    render();
  }

  const net = { role: null, room: null, peer: null, table: null, conns: new Map(), hostConn: null, reqId: 0, waiting: new Map(), retry: 0 };

  function loadPeerJs() {
    if (window.Peer) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/peerjs.min.js'; // PeerJS 1.5.4, lokaal meegeleverd
      s.onload = resolve;
      s.onerror = () => reject(new Error('PeerJS kon niet laden. Heb je internet?'));
      document.head.append(s);
    });
  }

  const newCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  const joinUrl = () => `${location.origin}${location.pathname}?kamer=${net.room}`;

  // Hoe elke gast verbonden is: zelfde wifi, direct via internet of via een
  // relay-server (omweg, vaak trager), plus de pingtijd in milliseconden.
  async function linkType(pc) {
    if (!pc || !pc.getStats) return null;
    try {
      const stats = await pc.getStats();
      let pair = null;
      stats.forEach(r => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); });
      if (!pair) stats.forEach(r => { if (!pair && r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) pair = r; });
      if (!pair) return null;
      const types = [stats.get(pair.localCandidateId), stats.get(pair.remoteCandidateId)].map(c => c && c.candidateType);
      if (types.includes('relay')) return 'relay';
      return types.every(t => t === 'host') ? 'lokaal' : 'direct';
    } catch (e) { return null; }
  }

  function linksBySeat() {
    const out = {};
    for (const c of net.conns.values()) {
      const p = c.pid && net.table.byPid(c.pid);
      if (p && c.link) out[p.seat] = c.link;
    }
    return out;
  }

  // Elke 5 seconden: ping naar elke gast en kijken welk soort verbinding het is.
  function measureLinks() {
    for (const c of net.conns.values()) {
      if (!c.pid || !c.conn.open) continue;
      c.conn.send({ t: 'ping', ts: Date.now() });
      linkType(c.conn.peerConnection).then(type => { if (type) c.type = type; });
    }
  }

  function onPong(c, msg) {
    const rtt = Math.max(1, Date.now() - msg.ts);
    const prev = c.link;
    c.link = { type: c.type || 'direct', rtt };
    // Alleen opnieuw versturen als er echt iets veranderd is.
    if (!prev || prev.type !== c.link.type || Math.abs(prev.rtt - rtt) > Math.max(30, prev.rtt * 0.3)) hostBroadcast();
  }

  function hostBroadcast() {
    const extra = { room: net.room, urls: net.solo ? [] : [joinUrl()], host: true, solo: net.solo, links: linksBySeat(),
      hostSeat: (net.table.byPid(pid) || {}).seat };
    for (const c of net.conns.values()) {
      if (c.pid && c.conn.open) c.conn.send({ t: 'state', s: net.table.view(c.pid, { ...extra, host: false }) });
    }
    setState(JSON.parse(JSON.stringify(net.table.view(pid, extra))));
    store('toep_host', JSON.stringify({ room: net.room, solo: net.solo, state: net.table.serialize(), at: Date.now() }));
  }

  function onGuestData(conn, msg) {
    const c = net.conns.get(conn.connectionId);
    if (!c || !msg) return;
    if (msg.t === 'hello') {
      c.pid = String(msg.pid);
      hostBroadcast();
      setTimeout(measureLinks, 1500);
    } else if (msg.t === 'pong') {
      onPong(c, msg);
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

  // Oefenen tegen bots: alles draait op deze telefoon, zonder kamer en zonder internet.
  function soloGame(name, resume) {
    net.role = 'host';
    net.room = null;
    net.solo = resume ? resume.solo : `s${Date.now().toString(36)}`;
    net.table = new window.Toepen.Table({ hostPid: pid, onChange: hostBroadcast, isConnected: id => id === pid });
    if (resume) {
      net.table.restore(resume.state);
      net.table.changed();
    } else {
      net.table.handle(pid, { type: 'join', name });
      for (let i = 0; i < 3; i++) net.table.handle(pid, { type: 'addBot' });
    }
    store('toep_role', 'host');
  }

  function hostRoom(name, resume) {
    if (resume && resume.solo) return soloGame(name, resume);
    net.role = 'host';
    net.solo = null;
    net.room = resume ? resume.room : newCode();
    net.table = new window.Toepen.Table({
      hostPid: pid,
      onChange: hostBroadcast,
      isConnected: id => id === pid || [...net.conns.values()].some(c => c.pid === id && c.conn.open),
    });
    if (resume) net.table.restore(resume.state);
    store('toep_role', 'host');
    showHome('Kamer openen…');
    const peer = new window.Peer(PEER_PREFIX + net.room);
    net.peer = peer;
    clearInterval(net.linkTimer);
    net.linkTimer = setInterval(measureLinks, 5000);
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

  // Lukt verbinden niet binnen 10 seconden, dan opnieuw proberen met een melding.
  const CONNECT_TIMEOUT = 10000;

  function retryNotice(attempt) {
    const text = `Verbinden lukt niet, opnieuw proberen (poging ${attempt})…`;
    if (S) { $('#connText').textContent = text; $('#conn').hidden = false; } else showHome(text, true);
  }

  function joinRoom(code, name, attempt = 1) {
    net.role = 'guest';
    net.room = code;
    store('toep_role', 'guest');
    store('toep_room', code);
    if (attempt > 1) retryNotice(attempt);
    else if (!S) showHome(`Verbinden met kamer ${code}…`);
    const peer = new window.Peer();
    net.peer = peer;
    net.attempt = attempt;
    let pendingName = name;
    // De kamerserver (voor het vinden van de host) reageert niet: alles opnieuw.
    clearTimeout(net.openTimer);
    net.openTimer = setTimeout(() => {
      if (peer.open || peer.destroyed || net.peer !== peer) return;
      peer.destroy();
      joinRoom(code, pendingName, attempt + 1);
    }, CONNECT_TIMEOUT);
    const connectHost = () => {
      if (net.hostConn && !net.hostConn.open) { net.hostConn.abandoned = true; try { net.hostConn.close(); } catch (e) { /* al dicht */ } }
      const conn = peer.connect(PEER_PREFIX + code, { reliable: true });
      net.hostConn = conn;
      // Geen verbinding met de host binnen 10 seconden: opnieuw proberen.
      clearTimeout(net.openTimer);
      net.openTimer = setTimeout(() => {
        if (conn.open || net.hostConn !== conn || peer.destroyed) return;
        net.attempt++;
        retryNotice(net.attempt);
        connectHost();
      }, CONNECT_TIMEOUT);
      conn.on('open', () => {
        clearTimeout(net.openTimer);
        net.attempt = 1;
        net.retry = 0;
        conn.send({ t: 'hello', pid });
        if (pendingName) { send('join', { name: pendingName }); pendingName = null; }
      });
      conn.on('data', msg => {
        if (msg.t === 'state') setState(msg.s);
        if (msg.t === 'ping') conn.send({ t: 'pong', ts: msg.ts });
        if (msg.t === 'ack' && net.waiting.has(msg.id)) {
          net.waiting.get(msg.id)(msg);
          net.waiting.delete(msg.id);
        }
      });
      conn.on('close', () => { if (!conn.abandoned) reconnectLater(connectHost); });
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

  // Verbinden stoppen als het niet lukt of blijft hangen. Je komt terug op het
  // startscherm; een opgeslagen kamer kun je daar later weer oppakken.
  function cancelConnect() {
    clearTimeout(net.retryTimer);
    clearTimeout(net.slowTimer);
    clearTimeout(net.openTimer);
    clearInterval(net.linkTimer);
    if (net.peer) net.peer.destroy();
    store('toep_role', '');
    Object.assign(net, { role: null, room: null, peer: null, table: null, hostConn: null, retry: 0 });
    net.conns.clear();
    net.waiting.clear();
    S = null;
    $('#conn').hidden = true;
    showHome();
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
  function showHome(busy, slow) {
    $('#lobby').hidden = true;
    $('#game').hidden = true;
    $('#home').hidden = false;
    $('#homeBusy').hidden = !busy;
    $('#homeBusy').innerHTML = busy
      ? `<p class="busy-text">${esc(busy)}</p><p class="busy-hint" hidden>Dit duurt lang. Klopt de kamercode en is de host online? Soms helpt een ander netwerk, bijvoorbeeld 4G/5G in plaats van wifi.</p>` +
        '<button class="btn ghost" type="button" data-act="cancelConnect">Stoppen</button>'
      : '';
    clearTimeout(net.slowTimer);
    if (busy) net.slowTimer = setTimeout(() => { const h = $('#homeBusy .busy-hint'); if (h) h.hidden = false; }, slow ? 0 : 12000);
    $('#homeForm').hidden = !!busy;
    const resume = savedHost();
    const room = store('toep_room');
    const bits = [];
    if (resume) bits.push(`<button class="btn ghost" type="button" data-act="resumeHost">${resume.solo ? 'Verder met oefenen' : `Kamer ${esc(resume.room)} hervatten (host)`}</button>`);
    if (store('toep_role') !== 'host' && room) bits.push(`<button class="btn ghost" type="button" data-act="rejoin">Terug naar kamer ${esc(room)}</button>`);
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
    if (action === 'solo') { requestWakeLock(); return soloGame(name || 'Jij', null); }
    const saved = action === 'resumeHost' ? savedHost() : null;
    if (saved && saved.solo) { requestWakeLock(); return soloGame(name, saved); }
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

  // Klassieke kaartfiguren voor boer, vrouw en heer (Byron Knoll, publiek domein).
  const FIGURE_RANKS = ['J', 'Q', 'K'];

  // Avatars: Notionists-gezichten voor spelers (CC0) en Bottts-robots voor bots,
  // allebei via DiceBear en meegeleverd in de map avatars/.
  const AVATAR_COUNT = 24;
  const BOT_AVATARS = ['robin', 'sebastian', 'martijn'];
  function nameAvatar(name) {
    let h = 0;
    for (const ch of (name || '').trim().toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return (h % AVATAR_COUNT) + 1;
  }
  // Je eigen avatar ligt vast op deze telefoon; je kiest een andere in het menu.
  function myAvatar() {
    let n = Number(store('toep_avatar'));
    if (!(n >= 1 && n <= AVATAR_COUNT)) {
      n = nameAvatar(store('toep_name') || pid);
      store('toep_avatar', String(n));
    }
    return n;
  }
  function avatarSrc(p) {
    const name = (p && p.name ? p.name : '').trim().toLowerCase();
    if (p && p.bot) return `avatars/bot-${BOT_AVATARS.includes(name) ? name : 'bot'}.webp`;
    if (S && p && p.seat === S.me) return `avatars/p${myAvatar()}.webp`;
    return `avatars/p${(p && p.look && p.look.avatar) || nameAvatar(name)}.webp`;
  }
  const avatarImg = p => `<img src="${avatarSrc(p)}" alt="">`;

  function cardHTML(c, cls = '', attrs = '') {
    const r = rankOf(c), s = suitOf(c), label = RL[r] || r;
    const center = FIGURE_RANKS.includes(r) ? `<span class="face"><img src="cards/${r}${s}.jpg" alt=""></span>` : SYM[s];
    return `<div class="card s${s}${FIGURE_RANKS.includes(r) ? ' fig' : ''} ${cls}" ${attrs} aria-label="${SUIT_NAME[s]} ${label}">` +
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
    applyTheme(S.settings.theme);
    $('#game').hidden = !inGame;

    const key = `${S.phase}|${S.turn}|${S.trickNo}|${S.round}`;
    if (key !== selectKey) { selected = null; blindPick = false; selectKey = key; }

    if (inGame) renderGame(); else renderLobby();
    renderOverlay();
    renderDrawer();
    renderHistory();
    handleLogs();
    handleReactions();
    syncLook();
    notify();
  }

  // ----- stijl -----

  // De host kiest de stijl; iedereen aan tafel krijgt hem te zien.
  function applyTheme(theme) {
    theme = THEMES.some(t => t.key === theme) ? theme : 'cafe';
    const root = document.documentElement;
    if ((root.dataset.theme || 'cafe') === theme && store('toep_theme') === theme) return;
    if (theme === 'cafe') delete root.dataset.theme;
    else root.dataset.theme = theme;
    store('toep_theme', theme);
    const bg = getComputedStyle(root).getPropertyValue('--wood').trim();
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && bg) meta.content = bg;
  }

  function themePicker() {
    const current = S.settings.theme || 'cafe';
    const dis = S.isHost ? '' : 'disabled';
    return `<div class="themes">${THEMES.map(t =>
      `<button class="theme-opt" data-act="theme" data-key="${t.key}" aria-pressed="${current === t.key}" ${dis}>` +
      `<span class="swatch">${t.swatch.map(c => `<i style="background:${c}"></i>`).join('')}</span><b>${t.name}</b></button>`).join('')}</div>` +
      (S.isHost ? '' : '<p class="note" style="margin:10px 0 0">De host kiest de stijl.</p>');
  }

  // ----- lobby -----

  // Bedragen in euro's, zoals €1 of €2,50.
  const euro = c => (c % 100 === 0 ? `€${c / 100}` : `€${(c / 100).toFixed(2).replace('.', ',')}`);
  const signedEuro = c => (c > 0 ? '+' : c < 0 ? '−' : '') + euro(Math.abs(c));
  const MONEY_OPTS = [0, 100, 250, 500];

  function renderLobby() {
    const seated = S.me != null;
    $('#lobby .invite').hidden = !!S.solo;
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
      return `<li class="seat ${isMe ? 'me' : ''}"><span class="av">${avatarImg(p)}</span>` +
        `<span class="nm">${esc(p.name)}${isMe ? ' <em>(jij)</em>' : ''}</span>` +
        (p.wins ? `<span class="wins" title="Gewonnen potjes">🏆 ${p.wins}</span>` : '') +
        (p.money ? `<span class="cash ${p.money > 0 ? 'up' : 'down'}" title="Saldo (nepgeld)">${signedEuro(p.money)}</span>` : '') +
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
      <section class="panel shop-row">
        <div><b class="coins"><i class="coin"></i>${wallet.coins}</b> muntjes</div>
        <button class="btn primary" data-act="openShop">Shop</button>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Spelvorm</h2><button class="link" data-act="openRules">Spelregels</button></div>
        <div class="seg">
          <button data-act="mode" data-mode="klassiek" aria-pressed="${st.mode === 'klassiek'}" ${dis}>Klassiek</button>
          <button data-act="mode" data-mode="kroeg" aria-pressed="${kroeg}" ${dis}>Kroeg</button>
          <button data-act="mode" data-mode="finale" aria-pressed="${finale}" ${dis}>Finale</button>
        </div>
        ${rules}
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Om geld spelen</h2><span class="count">nepgeld</span></div>
        <div class="seg money-seg">
          ${MONEY_OPTS.map(c => `<button data-act="money" data-cents="${c}" aria-pressed="${(st.money || 0) === c}" ${dis}>${c ? euro(c) : 'Nee'}</button>`).join('')}
          <button data-act="moneyCustom" aria-pressed="${!!st.money && !MONEY_OPTS.includes(st.money)}" ${dis}>${st.money && !MONEY_OPTS.includes(st.money) ? euro(st.money) : 'Eigen'}</button>
        </div>
        <p class="note" style="margin:10px 0 0">${st.money ? `Iedereen legt ${euro(st.money)} in, de winnaar pakt de pot.` : 'Zoals in de kroeg: iedereen legt in en de winnaar pakt de pot.'} Alleen voor de lol, er wordt niet echt betaald.</p>
      </section>
      <details class="panel more" id="moreSettings" ${moreOpen ? 'open' : ''}>
        <summary><h2>Meer instellingen</h2><span class="chev" aria-hidden="true">▾</span></summary>
        ${maxRow}
        <h3 class="sub-h">Stijl</h3>
        ${themePicker()}
      </details>
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
    $('.felt').className = 'felt' + (wallet.equip.felt !== 'groen' ? ` f-${wallet.equip.felt}` : '');
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
      if (S.blind.pending[0] !== s) return { t: 'Wacht', cls: 'grey' };
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
      if (S.toep.pending.includes(s)) return { t: 'Wacht', cls: 'grey' };
    }
    if (ph === 'play' && S.turn === s) return { t: 'Aan zet', cls: 'turn' };
    return null;
  }

  function oppHTML(p, pos) {
    if (!p) return '';
    const chip = statusChip(p);
    const look = p.look || { back: 'rood', ring: 'geen' };
    const backs = Array.from({ length: p.cards }, () => `<i class="mback b-${look.back}"></i>`).join('');
    return `<div class="opp ${p.acting ? 'acting' : ''} ${p.folded ? 'folded' : ''} ${p.dead ? 'dead' : ''}" data-seat="${p.seat}" data-act="throwPick">
      <div class="av r-${look.ring}">${avatarImg(p)}${p.online ? '' : '<span class="off" title="Offline">!</span>'}</div>
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
        (S.trickNo === S.tricksTotal ? '<div class="last">Laatste slag, deze telt!</div>' : '') +
        `<div>${who}</div></div></div>`;
    } else if (!S.trick.length && ['blind', 'blindResp', 'scherp', 'wash', 'washCheck', 'pass'].includes(S.phase)) {
      let sub = `${esc(nameOf(S.leader))} komt straks uit`;
      if (S.phase === 'blind') sub = 'Kaarten liggen nog dicht…';
      if (S.phase === 'blindResp') sub = `${esc(nameOf(S.blind.by))} speelt blind voor ${S.blind.amount}`;
      if (S.phase === 'scherp') sub = `${S.scherp.seats.map(nameOf).map(esc).join(' en ')} moet genomen worden`;
      html = `<div class="hint"><div><div class="hint-big">Ronde ${S.round}</div><div>${sub}</div></div></div>`;
    }
    const now = Date.now();
    for (const t of S.trick) {
      const pos = layout()[t.seat] || POS[rel(t.seat)];
      const key = `${S.round}.${S.trickNo}.${t.seat}.${t.card}`;
      if (!animSeen.has(key)) {
        animSeen.set(key, now);
        play('card');
      }
      const enter = now - animSeen.get(key) < 450;
      const p = S.players[t.seat];
      let cls = '';
      if (S.trickWinner === t.seat) cls = 'win';
      else if (S.trickWinner >= 0 || (p && p.folded)) cls = 'lose';
      html += `<div class="tslot t-${pos} ${cls}">${cardHTML(t.card, enter ? 'enter from-' + pos : '')}</div>`;
    }
    // Na de slag schuiven de kaarten naar de winnaar.
    const el = $('#trick');
    const collectTo = S.phase === 'trickEnd' && S.trickWinner >= 0 ? layout()[S.trickWinner] : null;
    el.classList.toggle('collect', !!collectTo);
    if (collectTo) {
      const [cx, cy] = { bottom: [0, 150], top: [0, -150], left: [-140, 0], right: [140, 0] }[collectTo];
      el.style.setProperty('--cx', cx + 'px');
      el.style.setProperty('--cy', cy + 'px');
    }
    // Alleen opnieuw tekenen als er echt iets veranderd is, anders herstarten de animaties.
    if (html !== lastTrickHtml) {
      el.innerHTML = html;
      lastTrickHtml = html;
    }
  }

  function promptState() {
    const me = S.me, mp = meP();
    const wait = text => ({ tone: '', html: `<div class="pt"><span class="dots">${text}</span></div>` });
    if (me == null) return { tone: '', html: '<div class="pt">Je kijkt mee 👀, er is al een spel bezig.</div>' };
    if (mp.dead) {
      // Bij oefenen hoef je niet minutenlang naar de bots te kijken.
      const ff = net.solo && net.table && net.table.delay >= 1
        ? '<div class="pb"><button class="btn primary" data-act="fastForward">⏩ Snel naar het einde</button></div>' : '';
      return { tone: '', html: '<div class="pt">Je bent af 💀 Kijk lekker mee en bestel een rondje.</div>' + ff };
    }

    const extra = S.myExtra || 0;
    switch (S.phase) {
      case 'blind': {
        if (S.blindDecision !== null) return wait('Wie de meeste punten heeft, kiest of hij blind speelt');
        if (blindPick) {
          const btns = [2, 3, 4].filter(n => n <= (S.blindMax || 4)).map(n => `<button class="btn toep" data-act="blind" data-amount="${n}">${n}</button>`).join('');
          return {
            tone: 'turn',
            html: `<div class="pt">Blind voor hoeveel punten? <span class="bcd"></span><small>Nog ${S.blindsLeft}× blind dit potje.${S.blindMax < 4 ? ` Op ${mp.points} punten kan hooguit ${S.blindMax}.` : ''}</small></div>` +
              `<div class="pb">${btns}<button class="btn ghost" data-act="blindBack">Terug</button></div>`,
          };
        }
        return {
          tone: 'turn',
          html: `<div class="pt">Kijken of blind?<small>Nog niemand heeft zijn kaarten gezien. Kies je niet op tijd, dan kijk je.</small></div>` +
            `<div class="pb"><button class="btn toep" data-act="blindPick">Blind</button>` +
            `<button class="btn primary" data-act="blind" data-amount="0">Kijken <span class="bcd"></span></button></div>`,
        };
      }
      case 'blindResp': {
        const b = S.blind, n = b.amount;
        if (b.by === me) return wait(`Je speelt blind voor ${n}. Wat doen de anderen`);
        if (b.pending.includes(me) && b.pending[0] !== me) return wait(`Eerst kiest ${esc(nameOf(b.pending[0]))}, daarna jij`);
        if (!b.pending.includes(me)) {
          if (S.blindResp === 'blind') return wait(`Je gaat blind mee voor ${n}. Wachten op de anderen`);
          return wait('Wachten op de anderen');
        }
        if (S.blindResp === 'seen') {
          return {
            tone: 'alert',
            html: `<div class="pt">Je hebt gekeken. Mee voor <b>${n + 1}</b> of weg voor 2?<small>Weg = 2 strafpunten.</small></div>` +
              `<div class="pb"><button class="btn ghost" data-act="blindResp" data-choice="weg">Weg (2)</button>` +
              `<button class="btn primary" data-act="blindResp" data-choice="mee">Mee (${n + 1})</button></div>`,
          };
        }
        return {
          tone: 'alert',
          html: `<div class="pt"><b>${esc(nameOf(b.by))}</b> speelt blind voor ${n}!` +
            `<small>Weg = 1 punt, zonder te kijken. Gezien = je kijkt eerst, dan mee voor ${n + 1} of weg voor 2. Blind mee = ${n}.</small></div>` +
            `<div class="pb"><button class="btn ghost" data-act="blindResp" data-choice="weg">Weg (1)</button>` +
            `<button class="btn ghost" data-act="blindResp" data-choice="seen">Gezien</button>` +
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
        if (t.pending[0] === me) {
          const prev = t.prev + extra, now = S.stake + extra;
          return {
            tone: 'alert',
            html: `<div class="pt"><b>${esc(nameOf(t.by))}</b> toept! Inzet ${prev} → <b>${now}</b>` +
              `<small>Pas je, dan krijg je ${plural(prev)}.</small></div>` +
              `<div class="pb"><button class="btn ghost" data-act="fold">Pas</button><button class="btn primary" data-act="go">Mee!</button></div>`,
          };
        }
        if (t.pending.includes(me)) return wait(`Eerst kiest ${esc(nameOf(t.pending[0]))}, daarna jij`);
        if (t.by === me) return wait('Je toept! Wachten op de anderen');
        if (mp.folded) return wait('Je hebt gepast deze ronde');
        return wait('Wachten op de anderen');
      }
      case 'play': {
        if (mp.folded) return wait('Je hebt gepast. Wachten op de volgende ronde');
        if (S.turn !== me) return wait(`${esc(nameOf(S.turn))} is aan de beurt`);
        let text;
        if (selected) text = 'Tik nog een keer op de kaart om te spelen';
        else if (!S.trick.length) text = 'Jouw beurt: jij komt uit';
        else {
          const lead = suitOf(S.trick[0].card);
          const can = (S.hand || []).some(c => suitOf(c) === lead);
          text = can ? `Jouw beurt: beken ${SYM[lead]} ${SUIT_NAME[lead]}` : `Jouw beurt: geen ${SUIT_NAME[lead]}, gooi iets weg`;
        }
        const sub = S.trickNo === S.tricksTotal ? '<small>Laatste slag, deze telt!</small>'
          : S.final ? '<small>Finale: geen toepen, de laatste slag beslist.</small>'
          : S.toepBlocked ? `<small>${esc(S.toepBlocked)}</small>`
          : S.lastToeper === me && S.blind && S.blind.by === me ? '<small>Je speelde blind: weer toepen kan pas als iemand anders heeft getoept.</small>'
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
        const end = S.final ? ' en de finale!' : ' en de ronde!';
        return { tone: 'info', html: `<div class="pt">${w} de slag${S.trickNo === S.tricksTotal ? end : '.'}</div>` };
      }
      default:
        return { tone: '', html: '<div class="pt"></div>' };
    }
  }

  // Tekst van de expert-hulp onder de vraag in de prompt.
  function adviceHTML() {
    const a = S.advice;
    if (!a) return '';
    const pct = `${Math.round(a.chance * 100)}% kans op de ronde`;
    let text;
    if (a.type === 'play') {
      const r = rankOf(a.card), label = (RL[r] || r) + SYM[suitOf(a.card)];
      text = `Speel <b>${label}</b> (${pct})${a.toep ? ' en toep!' : ''}`;
    } else if (a.type === 'toep') {
      text = `${a.go ? '<b>Ga mee</b>' : '<b>Pas</b>'} (${pct})`;
    } else {
      text = `${a.go ? '<b>Ga mee</b>' : '<b>Ga weg</b>'} (${pct})`;
    }
    return `<div class="expert">🎓 Expert: ${text}</div>`;
  }

  function renderPrompt() {
    const { tone, html: base } = promptState();
    const html = base + adviceHTML();
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
    $('#mebar').innerHTML = `<span class="av r-${wallet.equip.ring}">${avatarImg(p)}</span><span class="nm">${esc(p.name)}</span>` +
      (chip ? `<span class="chip ${chip.cls}">${chip.t}</span>` : '') +
      (inPlay && S.myExtra ? `<span class="chip hot">jij: ${S.stake + S.myExtra}</span>` : '') +
      (hasLives() ? `<span class="pts">${lives(p)} ${p.points}/${S.settings.maxPoints}</span>`
        : `<span class="pts">🏆 ${p.wins}</span>`) +
      `<button class="react-btn" data-act="reactMenu" aria-label="Reageren">😀</button>`;
  }

  function renderHand() {
    const el = $('#hand');
    const p = meP();
    if (!p) { el.className = 'hand'; el.innerHTML = ''; lastHandHtml = ''; return; }
    const hand = sortHand(S.hand || []);
    const legal = new Set(S.legal || []);
    const playing = S.phase === 'play' && S.turn === S.me;
    const passing = S.phase === 'pass' && S.passCard == null;
    if (selected && !hand.includes(selected)) selected = null;
    // Nieuwe ronde (of de kaarten gaan open na blind): kaarten worden gedeeld.
    const key = `${S.round}|${S.handHidden}|${S.gamesPlayed}`;
    if (key !== dealKey) {
      dealKey = key;
      dealUntil = Date.now() + 900;
      if (S.handCount) play('deal');
    }
    const deal = Date.now() < dealUntil;
    const dealStyle = i => (deal ? ` style="animation-delay:${i * 70}ms"` : '');
    let html;
    if (S.handHidden) {
      el.className = 'hand';
      html = Array.from({ length: S.handCount }, (_, i) => `<div class="card back b-${wallet.equip.back}${deal ? ' deal' : ''}"${dealStyle(i)}></div>`).join('');
    } else {
      el.className = 'hand' + (playing ? ' playing' : '') + (hand.length > 4 ? ' many' : '');
      html = hand.length ? hand.map((c, i) => {
        const cls = [];
        if ((playing && legal.has(c)) || passing) cls.push('legal');
        if (selected === c || S.passCard === c) cls.push('sel');
        if (S.received === c && S.trickNo === 1 && S.phase !== 'pass') cls.push('recv');
        if (playing && S.advice && S.advice.type === 'play' && S.advice.card === c) cls.push('advice');
        if (deal) cls.push('deal');
        return cardHTML(c, cls.join(' '), `data-card="${c}" role="button"${dealStyle(i)}`);
      }).join('') : `<div class="empty-hand">${p.dead ? 'Geen kaarten meer, je bent af.' : ''}</div>`;
    }
    // Zelfde kaarten? Dan niet opnieuw tekenen, anders begint de deel-animatie opnieuw.
    if (html !== lastHandHtml) {
      el.innerHTML = html;
      lastHandHtml = html;
    }
    if (deal) setTimeout(() => { if (S && Date.now() >= dealUntil) renderHand(); }, dealUntil - Date.now() + 20);
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
      if (!result) note = (p.money ? `${signedEuro(p.money)} · ` : '') + `🏆 ${p.wins}× gewonnen` + (p.dead ? ' · af' : '');
      const isWin = result ? result.winner === p.seat : S.winner === p.seat;
      return { p, html: `<li class="${isWin ? 'win' : ''} ${p.dead ? 'out' : ''}">` +
        `<span class="av">${avatarImg(p)}</span>` +
        `<span class="nm">${esc(p.name)}${p.seat === S.me ? ' (jij)' : ''}${note ? `<small>${note}</small>` : ''}</span>` +
        (hasLives() ? `${tally(p.points, max)}<span class="pts">${p.points}/${max}</span>` : '') +
        (result ? `<span class="delta ${dcls}">${delta}</span>` : '') + `</li>` };
    });
    if (!result) rows.sort((a, b) => (b.p.seat === S.winner) - (a.p.seat === S.winner) || (a.p.dead - b.p.dead) || a.p.points - b.p.points);
    return `<ul class="standings">${rows.map(r => r.html).join('')}</ul>`;
  }

  // Wie als eerste af is, mag zich direct weer inkopen voor muntjes.
  function buyInHTML(b) {
    if (b.seat !== S.me) {
      return `<p class="buyin"><b>${esc(nameOf(b.seat))}</b> is af en mag zich inkopen op ${b.points}. Even wachten <span id="cd"></span></p>`;
    }
    const short = wallet.coins < BUY_IN_COINS;
    return `<div class="buyin mine"><b>Je bent af!</b> Koop je in voor <i class="coin"></i>${BUY_IN_COINS} en speel verder op <b>${b.points}</b> punten.` +
      `<small>${short ? `Je hebt maar ${wallet.coins} muntjes.` : `Je hebt ${wallet.coins} muntjes. De winnaar krijgt ${BUY_IN_BONUS} extra.`}</small></div>` +
      `<div class="btns"><button class="btn primary big" data-act="buyIn" data-yes="1"${short ? ' disabled' : ''}>Inkopen <span id="cd"></span></button>` +
      `<button class="btn dark" data-act="buyIn" data-yes="0">Nee, ik ben af</button></div>`;
  }

  function renderOverlay() {
    const o = $('#overlay');
    let key = '', html = '';
    if (S.phase === 'roundEnd' && S.result) {
      const r = S.result;
      key = `round-${S.round}-${S.buyIn ? S.buyIn.seat : ''}`;
      const w = r.winner === S.me ? `Jij wint de ${r.final ? 'finale' : 'ronde'}!` : `${esc(nameOf(r.winner))} wint${r.final ? ' de finale' : ''}!`;
      const bits = [r.byFold ? 'De rest ging weg' : `Inzet ${r.stake}`];
      if (r.blind) bits.push(`blind ${r.blind}`);
      if (r.boer) bits.push('<b>Boerenslag! +1</b>');
      if (r.comeback) bits.push('<b>Comeback! −1</b>');
      html = `<div class="sheet"><div class="kicker">Ronde ${S.round}</div><h2>${w}</h2><p class="sub">${bits.join(' · ')}</p>` +
        standingsHTML(r) + (S.buyIn ? buyInHTML(S.buyIn) :
        `<div class="btns"><button class="btn primary big" data-act="next">Volgende ronde <span id="cd"></span></button></div>`) + `</div>`;
      if (overlayKey !== key) roundDeadline = Date.now() + S.nextRoundIn;
    } else if (S.phase === 'gameEnd') {
      key = `game-${S.round}`;
      const w = S.winner === S.me ? 'Jij wint het spel!' : `${esc(nameOf(S.winner))} wint het spel!`;
      const seated = S.me != null;
      const award = S.winner === S.me ? awardForGame() : null;
      if (award && award.fresh) { toast(`+${award.amount} muntjes!`, 'coins'); play('coin'); }
      html = `<div class="sheet"><div class="trophy">🏆</div><h2>${w}</h2>` +
        (award ? `<p class="coins-won"><i class="coin"></i>+${award.amount} muntjes <small>(je hebt er nu ${wallet.coins})</small></p>` : '') + `<p class="sub">Potje ${S.gamesPlayed}, na ${S.round} ronde${S.round === 1 ? '' : 's'}. Wie geeft er een rondje?</p>` +
        (S.pot ? `<p class="pot">💶 ${S.winner === S.me ? 'Jij pakt' : `${esc(nameOf(S.winner))} pakt`} de pot: <b>${euro(S.pot)}</b></p>` : '') +
        standingsHTML(null) + statsHTML() +
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
      // Geluid alleen als je zelf meespeelde.
      const winner = S.phase === 'gameEnd' ? S.winner : S.result.winner;
      const played = S.me != null && (S.phase === 'gameEnd' || S.result.lines.some(l => l.seat === S.me));
      if (played) {
        play(winner === S.me ? (S.phase === 'gameEnd' ? 'champion' : 'win') : 'lose');
        if (winner === S.me) celebrate();
        if (winner === S.me) buzz([60, 40, 60, 40, 120]);
      }
    }
    o.hidden = false;
    tickCountdown();
  }

  // Statistieken van het potje, met een paar titels voor de kroeg.
  function statsHTML() {
    const players = S.players.filter(p => p && p.stats);
    if (!players.length || !hasLives()) return ''; // bij Finale (één ronde) zeggen de cijfers niets
    const best = (key, label, icon, unit) => {
      const top = players.reduce((b, p) => (p.stats[key] > (b ? b.stats[key] : 0) ? p : b), null);
      return top ? `<li><span>${icon}</span><b>${label}</b> ${esc(top.name)} <small>(${top.stats[key]}${unit})</small></li>` : '';
    };
    const titles = [
      best('toeps', 'Toepkoning', '👑', '× getoept'),
      best('toepWins', 'Lef beloond', '💪', '× toep gewonnen'),
      best('bigPot', 'Grootste pot', '💰', ' punten'),
      best('blinds', 'Durfal', '🙈', '× blind'),
      best('folds', 'Voorzichtig', '🐢', '× weg'),
    ].join('');
    const rows = players.map(p => {
      const s = p.stats;
      return `<tr><td>${esc(p.name)}</td><td>${s.rounds}</td><td>${s.toepWins}/${s.toeps}</td><td>${s.folds}</td><td>${s.blinds}</td></tr>`;
    }).join('');
    return `<div class="stats">${titles ? `<ul class="titles">${titles}</ul>` : ''}` +
      `<table><thead><tr><th></th><th>Rondes</th><th>Toep</th><th>Weg</th><th>Blind</th></tr></thead><tbody>${rows}</tbody></table>` +
      `<p class="stats-note">Toep = gewonnen / keer getoept</p></div>`;
  }

  function tickCountdown() {
    // Aftellen voor de blindkeuze.
    const bs = Math.max(0, Math.ceil((blindDeadline - Date.now()) / 1000));
    for (const b of document.querySelectorAll('.bcd')) b.textContent = `(${bs})`;
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
      ? board.map(p => `<li>${esc(p.name)}: ${p.wins}× gewonnen${p.money ? ` (${signedEuro(p.money)})` : ''}</li>`).join('')
      : '<li>Nog geen potje uitgespeeld.</li>';
    $('#logList').innerHTML = logs.slice(-12).map(l => `<li>${esc(l.text)}</li>`).join('') || '<li>Nog niets gebeurd.</li>';
    const inGame = S.phase !== 'lobby' && S.me != null;
    $('#drawerTheme').innerHTML = themePicker();
    $('#drawerCoins').innerHTML = `<i class="coin"></i>${wallet.coins}`;
    let actions = '';
    if (inGame) actions += '<button class="btn dark" data-act="lobby">Spel stoppen → lobby</button>';
    if (net.role) {
      const label = net.solo ? 'Stoppen met oefenen' : net.role === 'host' ? `Kamer ${esc(net.room)} sluiten` : `Kamer ${esc(net.room)} verlaten`;
      actions += `<button class="btn dark" data-act="leaveRoom">${label}</button>`;
    }
    $('#drawerActions').innerHTML = actions;
    $('#connList').innerHTML = net.role && !net.solo ? connListHTML() : '';
  }

  const LINK_LABEL = { lokaal: 'Zelfde netwerk', direct: 'Direct', relay: 'Via relay (omweg)' };
  function connListHTML() {
    const links = S.links || {};
    const rows = S.players.filter(p => p && !p.bot).map(p => {
      let info;
      if (p.seat === S.hostSeat) info = '<span class="link host">Host</span>';
      else if (!p.online) info = '<span class="link slow">Geen verbinding</span>';
      else if (!links[p.seat]) info = '<span class="link">Meten…</span>';
      else {
        const l = links[p.seat], speed = l.rtt < 120 ? 'good' : l.rtt < 300 ? 'ok' : 'slow';
        info = `<span class="link ${l.type} ${speed}">${LINK_LABEL[l.type] || l.type} · ${l.rtt} ms</span>`;
      }
      return `<li><span>${esc(p.name)}${p.seat === S.me ? ' (jij)' : ''}</span>${info}</li>`;
    });
    return `<div class="menu-sub">Verbindingen</div><ul class="conn-list">${rows.join('')}</ul>`;
  }
  function openMenu() { $('#rulesBox').open = false; $('#drawer').classList.add('open'); $('#drawer').setAttribute('aria-hidden', 'false'); }
  function closeMenu() { $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true'); }

  // ---------- geluid en trillen ----------
  // Alle geluiden worden ter plekke gemaakt (Web Audio), dus geen geluidsbestanden nodig.

  const prefs = { sound: store('toep_sound') !== '0', buzz: store('toep_buzz') !== '0', expert: store('toep_expert') === '1' };
  let audioCtx = null;

  function audio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }
  // Telefoons laten pas geluid toe na een tik; dan zetten we het alvast klaar.
  document.addEventListener('pointerdown', () => { if (prefs.sound) audio(); }, { once: true });

  function tone(ctx, freq, at, dur, type = 'sine', vol = 0.18) {
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  function noise(ctx, at, dur, vol, cutoff) {
    const t = ctx.currentTime + at;
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 2;
    const src = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    src.buffer = buf;
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    gain.gain.value = vol;
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start(t);
  }

  // Klop op de tafel: een doffe dreun met een tikje hout erbij.
  function thump(ctx, at) {
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(55, t + 0.12);
    gain.gain.setValueAtTime(0.5, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.2);
    noise(ctx, at, 0.05, 0.35, 900);
  }

  const SOUNDS = {
    card: ctx => noise(ctx, 0, 0.07, 0.4, 3200),
    deal: ctx => [0, 0.07, 0.14, 0.21].forEach(at => noise(ctx, at, 0.05, 0.25, 2600)),
    knock: ctx => { thump(ctx, 0); thump(ctx, 0.17); },
    turn: ctx => { tone(ctx, 660, 0, 0.12, 'triangle', 0.12); tone(ctx, 880, 0.09, 0.16, 'triangle', 0.1); },
    pop: ctx => tone(ctx, 990, 0, 0.09, 'sine', 0.1),
    coin: ctx => { tone(ctx, 988, 0, 0.08, 'square', 0.06); tone(ctx, 1319, 0.08, 0.25, 'square', 0.06); },
    win: ctx => [523, 659, 784, 1047].forEach((f, i) => tone(ctx, f, i * 0.1, 0.25, 'triangle', 0.15)),
    champion: ctx => [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => tone(ctx, f, i * 0.12, 0.3, 'triangle', 0.15)),
    lose: ctx => { tone(ctx, 392, 0, 0.22, 'sine', 0.12); tone(ctx, 311, 0.2, 0.35, 'sine', 0.12); },
    whoosh: ctx => noise(ctx, 0, 0.35, 0.12, 900),
    splat: ctx => { noise(ctx, 0, 0.12, 0.5, 600); thump(ctx, 0); },
  };

  function play(name) {
    if (!prefs.sound || document.hidden) return;
    const ctx = audio();
    if (!ctx) return;
    try { SOUNDS[name](ctx); } catch (e) { /* geluid is bijzaak */ }
  }

  function buzz(pattern) {
    if (!prefs.buzz || !navigator.vibrate) return;
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return; // pas na de eerste tik
    try { navigator.vibrate(pattern); } catch (e) { /* niet ondersteund */ }
  }

  function renderPrefs() {
    $('#prefSound').setAttribute('aria-pressed', String(prefs.sound));
    $('#prefBuzz').setAttribute('aria-pressed', String(prefs.buzz));
    $('#prefExpert').setAttribute('aria-pressed', String(prefs.expert));
    const mine = myAvatar();
    $('#avatarPick').innerHTML = Array.from({ length: AVATAR_COUNT }, (_, i) =>
      `<button class="av-opt${i + 1 === mine ? ' on' : ''}" data-act="avatar" data-n="${i + 1}" aria-label="Avatar ${i + 1}">` +
      `<img src="avatars/p${i + 1}.webp" alt=""></button>`).join('');
  }

  // ---------- reacties ----------

  const REACTIONS = ['🍺', '👏', '😏', '😱', '😂', '🔥'];

  // Grapjes om naar elkaar te gooien (tik op iemands avatar).
  const THROW_ITEMS = [
    { id: 'tomaat', icon: '🍅', name: 'Tomaat', hit: 'SPLAT!', color: '#e0301e', splat: true },
    { id: 'ei', icon: '🥚', name: 'Ei', hit: 'KRAK!', color: '#ffd84a', splat: true },
    { id: 'bier', icon: '🍺', name: 'Biertje', hit: 'PROOST!', color: '#ffb52e', foam: true },
    { id: 'roos', icon: '🌹', name: 'Roos', hit: '♥', color: '#ff4f7b', hearts: true },
    { id: 'kus', icon: '💋', name: 'Kus', hit: 'MUAH!', color: '#ff3c8e', hearts: true, stamp: true },
    { id: 'ezel', icon: '🐴', name: 'Ezel', hit: 'IIIAA!', color: '#c9955f', stamp: true },
  ];
  const THROW_COOLDOWN = 3000;
  let lastThrowAt = 0;
  let throwTimer = null;

  const avAnchor = seat => (seat === S.me ? $('#mebar .av') : document.querySelector(`.opp[data-seat="${seat}"] .av`));
  function centerOf(el) {
    if (!el) return { x: innerWidth / 2, y: innerHeight - 120 };
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function openThrowTray(seat) {
    const p = S.players[seat];
    if (!p || S.me == null || seat === S.me) return;
    const tray = $('#throwTray');
    const wait = Math.ceil((THROW_COOLDOWN - (Date.now() - lastThrowAt)) / 1000);
    tray.innerHTML = `<div class="tt-head">${wait > 0 ? `Even wachten… ${wait}s` : `Gooi naar <b>${esc(p.name)}</b>`}</div><div class="tt-items">` +
      THROW_ITEMS.map(t => `<button data-act="throw" data-item="${t.id}" data-seat="${seat}" ${wait > 0 ? 'disabled' : ''} aria-label="${t.name}">` +
        `<span>${t.icon}</span><small>${t.name}</small></button>`).join('') + `</div>`;
    tray.hidden = false;
    const a = centerOf(avAnchor(seat));
    const w = tray.offsetWidth, h = tray.offsetHeight;
    tray.style.left = `${Math.min(innerWidth - w - 8, Math.max(8, a.x - w / 2))}px`;
    tray.style.top = `${Math.min(innerHeight - h - 8, Math.max(8, a.y + 34))}px`;
    tray.dataset.seat = seat;
    clearTimeout(throwTimer);
    if (wait > 0) throwTimer = setTimeout(() => { if (!tray.hidden) openThrowTray(seat); }, 1000);
  }

  function throwItem(item, seat) {
    if (Date.now() - lastThrowAt < THROW_COOLDOWN) return openThrowTray(seat);
    lastThrowAt = Date.now();
    $('#throwTray').hidden = true;
    return act('throw', { item, target: Number(seat) });
  }

  // Het ding vliegt in een boog van de gooier naar het doelwit en spat daar uiteen.
  function showThrow(from, to, id) {
    const it = THROW_ITEMS.find(t => t.id === id);
    const target = avAnchor(to);
    if (!it || !target) return;
    const f = centerOf(avAnchor(from)), t = centerOf(target);
    const el = document.createElement('div');
    el.className = 'throwfly';
    el.textContent = it.icon;
    el.style.left = `${f.x}px`;
    el.style.top = `${f.y}px`;
    $('#bubbles').append(el);
    const dx = t.x - f.x, dy = t.y - f.y, lift = -60 - Math.abs(dx) * 0.25;
    play('whoosh');
    const anim = el.animate([
      { transform: 'translate(-50%, -50%) scale(.5) rotate(0deg)' },
      { transform: `translate(calc(-50% + ${dx / 2}px), calc(-50% + ${dy / 2 + lift}px)) scale(1.25) rotate(320deg)`, offset: 0.5 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(1) rotate(640deg)` },
    ], { duration: 700, easing: 'cubic-bezier(.45, 0, .55, 1)', fill: 'forwards' });
    anim.onfinish = () => { el.remove(); impact(t, target, it); };
  }

  function impact(t, target, it) {
    const box = $('#bubbles');
    const add = (cls, css, html = '', life = 1800) => {
      const e = document.createElement('div');
      e.className = cls;
      e.style.cssText = `left:${t.x}px;top:${t.y}px;${css}`;
      e.innerHTML = html;
      box.append(e);
      setTimeout(() => e.remove(), life);
      return e;
    };
    if (it.splat) add('splat', `--c:${it.color}`, '<i></i><i></i><i></i>', 2200);
    if (it.foam) for (let i = 0; i < 10; i++) add('foam', `--dx:${Math.random() * 70 - 35}px;--dy:${-30 - Math.random() * 50}px;animation-delay:${Math.random() * 0.2}s`, '', 1300);
    if (it.hearts) for (let i = 0; i < 7; i++) add('heart', `--dx:${Math.random() * 80 - 40}px;color:${it.color};animation-delay:${i * 0.08}s`, '♥', 1700);
    if (it.stamp) add('stamp-fx', '', it.icon, 2400);
    add('hitword', `color:${it.color};left:${Math.min(innerWidth - 70, Math.max(70, t.x))}px`, it.hit, 1300);
    target.classList.remove('hit');
    void target.offsetWidth;
    target.classList.add('hit');
    setTimeout(() => target.classList.remove('hit'), 700);
    play(it.splat ? 'splat' : 'pop');
    if (target === $('#mebar .av')) buzz(40);
  }

  function handleReactions() {
    const list = S.reactions || [];
    const last = list.length ? list[list.length - 1].id : 0;
    if (seenReact < 0 || last < seenReact) { seenReact = last; return; }
    for (const r of list) {
      if (r.id <= seenReact) continue;
      seenReact = r.id;
      if (S.phase === 'lobby') continue;
      if (r.throw) showThrow(r.seat, r.target, r.throw);
      else showBubble(r.seat, r.emoji);
    }
  }

  // Emoji die even boven iemands avatar opstijgt.
  function showBubble(seat, emoji) {
    const anchor = seat === S.me ? $('#mebar .av') : document.querySelector(`.opp[data-seat="${seat}"] .av`);
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = emoji;
    b.style.left = `${r.left + r.width / 2}px`;
    b.style.top = `${r.top}px`;
    $('#bubbles').append(b);
    setTimeout(() => b.remove(), 2400);
    play('pop');
  }

  function toggleReactTray(show) {
    const tray = $('#reactTray');
    tray.hidden = show === undefined ? !tray.hidden : !show;
    if (!tray.hidden && !tray.children.length) {
      tray.innerHTML = REACTIONS.map(e => `<button data-act="react" data-emoji="${e}" aria-label="Reageer met ${e}">${e}</button>`).join('');
    }
  }

  // ---------- muntjes en shop ----------
  // Zonder account: alles staat op deze telefoon (localStorage).

  // Zeldzaamheid bepaalt de prijs en hoe vet het eruitziet.
  const TIERS = { gewoon: 'Gewoon', zeldzaam: 'Zeldzaam', episch: 'Episch', legendarisch: 'Legendarisch' };
  const SHOP = [
    { cat: 'back', title: 'Kaarten', note: 'Je kaartrug zien de anderen ook.', items: [
      { id: 'rood', name: 'Klassiek rood', price: 0, tier: 'gewoon', desc: 'De vertrouwde kroegkaart.' },
      { id: 'blauw', name: 'Delfts blauw', price: 150, tier: 'gewoon', desc: 'Strak blauw gestreept.' },
      { id: 'oranje', name: 'Oranje', price: 150, tier: 'gewoon', desc: 'Voor de echte supporter.' },
      { id: 'ruit', name: 'Ruitjes', price: 200, tier: 'gewoon', desc: 'Zwart-wit geblokt.' },
      { id: 'goud', name: 'Goud', price: 400, tier: 'zeldzaam', desc: 'Gouden strepen met een glans die over de kaart trekt.' },
      { id: 'sterren', name: 'Sterrenhemel', price: 450, tier: 'zeldzaam', desc: 'Twinkelende sterren op nachtblauw.' },
      { id: 'regenboog', name: 'Regenboog', price: 500, tier: 'zeldzaam', desc: 'Kleuren die blijven stromen.' },
      { id: 'smaragd', name: 'Smaragd', price: 900, tier: 'episch', desc: 'Diepgroen met gouden ruitjes en een glinstering.' },
      { id: 'holo', name: 'Holografisch', price: 1200, tier: 'episch', desc: 'Folie die steeds van kleur verschiet, zoals een zeldzame verzamelkaart.' },
      { id: 'vlam', name: 'Vuurdraak', price: 2500, tier: 'legendarisch', desc: 'Laaiende vlammen en opstijgende vonken.' },
      { id: 'kosmos', name: 'Kosmos', price: 3500, tier: 'legendarisch', desc: 'Een draaiend sterrenstelsel op je kaarten.' },
      { id: 'koning', name: 'Koningskaart', price: 5000, tier: 'legendarisch', desc: 'Massief goud met kroon. Voor de echte kroegkoning.' },
    ] },
    { cat: 'ring', title: 'Randen', note: 'De rand om je avatar zien de anderen ook.', items: [
      { id: 'geen', name: 'Geen', price: 0, tier: 'gewoon', desc: 'Gewoon je gezicht.' },
      { id: 'ijs', name: 'IJs', price: 200, tier: 'gewoon', desc: 'Koel en strak.' },
      { id: 'goud', name: 'Goud', price: 250, tier: 'gewoon', desc: 'Een gouden lijst om je hoofd.' },
      { id: 'vuur', name: 'Vuur', price: 400, tier: 'zeldzaam', desc: 'Een ring van vuur die rond blijft gaan.' },
      { id: 'neon', name: 'Neon', price: 450, tier: 'zeldzaam', desc: 'Roze en blauw, als een kroegreclame.' },
      { id: 'regenboog', name: 'Regenboog', price: 1000, tier: 'episch', desc: 'Alle kleuren, steeds in beweging.' },
      { id: 'bliksem', name: 'Bliksem', price: 1200, tier: 'episch', desc: 'Knetterende stroom rond je avatar.' },
      { id: 'kroon', name: 'Kroon', price: 3000, tier: 'legendarisch', desc: 'Draaiend goud met een kroon erop.' },
      { id: 'diamant', name: 'Diamant', price: 4000, tier: 'legendarisch', desc: 'Schitterend kristal met een fonkelende ster die rondcirkelt.' },
    ] },
    { cat: 'felt', title: 'Tafels', note: 'Je tafelkleed zie alleen jij.', items: [
      { id: 'groen', name: 'Groen laken', price: 0, tier: 'gewoon', desc: 'Het klassieke biljartgroen.' },
      { id: 'blauw', name: 'Blauw laken', price: 150, tier: 'gewoon', desc: 'Rustig blauw.' },
      { id: 'rood', name: 'Rood laken', price: 150, tier: 'gewoon', desc: 'Warm rood.' },
      { id: 'paars', name: 'Paars laken', price: 200, tier: 'gewoon', desc: 'Diep paars.' },
      { id: 'zwart', name: 'Zwart laken', price: 250, tier: 'gewoon', desc: 'Stijlvol zwart.' },
      { id: 'oceaan', name: 'Oceaan', price: 450, tier: 'zeldzaam', desc: 'Zonlicht dat over de bodem van de zee danst.' },
      { id: 'casino', name: 'Casino', price: 500, tier: 'zeldzaam', desc: 'Rood fluweel met een gouden ruitpatroon.' },
      { id: 'sterren', name: 'Sterrennacht', price: 1000, tier: 'episch', desc: 'Spelen onder een twinkelende sterrenhemel.' },
      { id: 'aurora', name: 'Noorderlicht', price: 1200, tier: 'episch', desc: 'Golvend groen en paars licht boven de tafel.' },
      { id: 'deco', name: 'Goudkoorts', price: 3000, tier: 'legendarisch', desc: 'Zwart fluweel met gouden art deco en een gloeiende rand.' },
    ] },
    { cat: 'effect', title: 'Effecten', note: 'Je winst-effect zie alleen jij.', items: [
      { id: 'geen', name: 'Geen', price: 0, tier: 'gewoon', desc: 'Winnen is al feest genoeg.' },
      { id: 'confetti', name: 'Confetti', price: 300, tier: 'gewoon', desc: 'Een regen van gekleurde snippers.' },
      { id: 'vuurwerk', name: 'Vuurwerk', price: 600, tier: 'zeldzaam', desc: 'Knallende pijlen boven de tafel.' },
      { id: 'muntregen', name: 'Muntregen', price: 1200, tier: 'episch', desc: 'Het regent gouden munten.' },
      { id: 'kroning', name: 'Kroning', price: 3000, tier: 'legendarisch', desc: 'Een gouden kroon daalt neer, met stralen, vonken en munten.' },
    ] },
  ];
  const START_COINS = 100;
  const WIN_COINS = 100;     // gewonnen potje met minstens één andere echte speler
  const BOT_WIN_COINS = 25;  // gewonnen van alleen bots
  const BUY_IN_COINS = 50;   // jezelf weer inkopen als je als eerste af bent
  const BUY_IN_BONUS = 25;   // extra voor de winnaar als iemand zich heeft ingekocht

  function loadWallet() {
    let w = null;
    try { w = JSON.parse(store('toep_wallet') || 'null'); } catch (e) { w = null; }
    const base = {
      coins: START_COINS, lastAward: '', lastAmount: 0,
      owned: { back: ['rood'], ring: ['geen'], felt: ['groen'], effect: ['geen'] },
      equip: { back: 'rood', ring: 'geen', felt: 'groen', effect: 'geen' },
    };
    if (!w) return base;
    return { ...base, ...w, owned: { ...base.owned, ...w.owned }, equip: { ...base.equip, ...w.equip } };
  }
  const wallet = loadWallet();
  const saveWallet = () => store('toep_wallet', JSON.stringify(wallet));
  saveWallet();

  // Muntjes voor een gewonnen potje, maar één keer per potje (ook als je herlaadt).
  function awardForGame() {
    const key = `${S.room || S.solo || ''}|${S.gamesPlayed}`;
    if (wallet.lastAward === key) return { amount: wallet.lastAmount, fresh: false };
    const humans = S.players.filter(p => p && !p.bot).length;
    const amount = (humans >= 2 ? WIN_COINS : BOT_WIN_COINS) + (S.buyIns ? BUY_IN_BONUS : 0);
    wallet.coins += amount;
    wallet.lastAward = key;
    wallet.lastAmount = amount;
    saveWallet();
    return { amount, fresh: true };
  }

  // ---------- dagelijkse beloning ----------
  // Elke dag muntjes; hoe langer je reeks, hoe meer (dag 7 en verder: 100).
  const DAILY = [25, 30, 40, 50, 60, 75, 100];
  const dayKey = (d = new Date()) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

  function dailyStatus() {
    const d = wallet.daily || { last: '', streak: 0 };
    const today = dayKey();
    if (d.last === today) return null; // vandaag al opgehaald
    const yesterday = dayKey(new Date(Date.now() - 864e5));
    const streak = d.last === yesterday ? d.streak + 1 : 1;
    return { streak, amount: DAILY[Math.min(streak, DAILY.length) - 1] };
  }

  // Eenmalig cadeau voor iedereen die het spel deze week opent.
  const GIFT = { id: 'bedankt-2026-11', amount: 1000, until: new Date(2026, 10, 6, 23, 59, 59).getTime() };

  function showGift() {
    if (Date.now() > GIFT.until || (wallet.gifts || []).includes(GIFT.id) || !$('#intro').hidden) return false;
    $('#daily').innerHTML = `<div class="sheet daily-sheet gift-sheet"><div class="gift-icon">🎁</div><div class="kicker">Cadeautje</div>` +
      `<h2>Bedankt voor het spelen!</h2><p class="sub">Als bedankje krijg je eenmalig <b>${GIFT.amount.toLocaleString('nl-NL')} muntjes</b>. Tijd om de shop leeg te kopen!</p>` +
      `<div class="btns"><button class="btn primary big" data-act="claimGift">Ophalen: <i class="coin"></i>${GIFT.amount.toLocaleString('nl-NL')}</button></div></div>`;
    $('#daily').hidden = false;
    return true;
  }

  function claimGift() {
    $('#daily').hidden = true;
    if ((wallet.gifts || []).includes(GIFT.id)) return;
    wallet.gifts = [...(wallet.gifts || []), GIFT.id];
    wallet.coins += GIFT.amount;
    saveWallet();
    play('champion');
    toast(`+${GIFT.amount} muntjes!`, 'coins');
    celebrate('muntregen');
    if (S) renderDrawer();
    setTimeout(showDaily, 1200);
  }

  function showDaily() {
    const st = dailyStatus();
    if (!st || !$('#intro').hidden) return;
    const days = DAILY.map((a, i) => {
      const n = i + 1, cls = n < st.streak ? 'done' : n === st.streak ? 'today' : '';
      return `<li class="${cls}"><small>Dag ${n}${n === DAILY.length ? '+' : ''}</small><i class="coin"></i><b>${a}</b></li>`;
    }).join('');
    $('#daily').innerHTML = `<div class="sheet daily-sheet"><div class="kicker">Dagelijkse beloning</div>` +
      `<h2>${st.streak > 1 ? `Dag ${st.streak} op rij!` : wallet.daily ? 'Welkom terug!' : 'Je eerste beloning!'}</h2>` +
      `<p class="sub">Kom elke dag terug voor meer muntjes. Mis je een dag, dan begin je weer bij dag 1.</p>` +
      `<ol class="daily-days">${days}</ol>` +
      `<div class="btns"><button class="btn primary big" data-act="claimDaily">Ophalen: <i class="coin"></i>${st.amount}</button></div></div>`;
    $('#daily').hidden = false;
  }

  function claimDaily() {
    const st = dailyStatus();
    $('#daily').hidden = true;
    if (!st) return;
    wallet.daily = { last: dayKey(), streak: st.streak };
    wallet.coins += st.amount;
    saveWallet();
    play('coin');
    toast(`+${st.amount} muntjes!`, 'coins');
    celebrate('muntregen');
    renderShop();
    if (S) renderDrawer();
  }

  // ---------- uitleg voor nieuwe spelers ----------
  const INTRO = [
    { icon: '🃏', title: 'Toepen in 1 minuut', text: 'Iedereen krijgt 4 kaarten. Je speelt 4 slagen en je moet kleur bekennen. Van laag naar hoog: <b>B V H A 7 8 9 10</b>.' },
    { icon: '🎯', title: 'Alleen de laatste slag telt', text: 'Wie de <b>4e slag</b> wint, wint de ronde. De rest krijgt strafpunten. Bewaar je beste kaart dus voor het laatst!' },
    { icon: '✊', title: 'Toep!', text: 'Denk je dat je wint? <b>Toep</b> en de inzet gaat omhoog. De anderen gaan mee of passen (en krijgen dan de oude inzet als strafpunten). Bluffen mag!' },
    { icon: '💀', title: 'Bij 15 ben je af', text: 'Op 14 sta je <b>op scherp</b>. Wie als laatste overblijft, wint het potje en verdient muntjes voor de shop.' },
  ];
  let introStep = 0;

  function showIntro(step = 0) {
    introStep = step;
    const it = INTRO[step], last = step === INTRO.length - 1;
    const dots = INTRO.map((_, i) => `<i class="${i === step ? 'on' : ''}"></i>`).join('');
    $('#intro').innerHTML = `<div class="sheet intro-sheet"><div class="intro-icon">${it.icon}</div><h2>${it.title}</h2>` +
      `<p class="sub">${it.text}</p><div class="intro-dots">${dots}</div>` +
      `<div class="btns"><button class="btn primary big" data-act="introNext">${last ? 'Spelen!' : 'Volgende'}</button>` +
      (last ? '' : '<button class="link" data-act="introDone">Overslaan</button>') + `</div></div>`;
    $('#intro').hidden = false;
  }

  function introDone() {
    store('toep_intro', '1');
    $('#intro').hidden = true;
    if (!showGift()) showDaily();
  }

  function buy(cat, id) {
    const item = shopItem(cat, id);
    if (!item || wallet.owned[cat].includes(id)) return;
    if (wallet.coins < item.price) {
      toast(`Je hebt nog ${item.price - wallet.coins} muntjes te weinig.`, 'err');
      return;
    }
    wallet.coins -= item.price;
    wallet.owned[cat].push(id);
    wallet.equip[cat] = id;
    saveWallet();
    play('coin');
    toast(`${item.name} gekocht!`);
    afterLookChange();
    unlockFx(item.tier);
  }

  function equip(cat, id) {
    if (!wallet.owned[cat].includes(id)) return;
    wallet.equip[cat] = id;
    saveWallet();
    afterLookChange();
  }

  function afterLookChange() {
    renderShop();
    if (S) render();
  }

  // Wat de anderen van jou zien (kaartrug en rand) naar de tafel sturen.
  let lookPending = false;
  function syncLook() {
    const me = meP();
    if (!me || !me.look || lookPending) return;
    if (S.myExpert !== prefs.expert) {
      lookPending = true;
      send('expert', { on: prefs.expert }).finally(() => { lookPending = false; });
      return;
    }
    if (me.look.back === wallet.equip.back && me.look.ring === wallet.equip.ring && me.look.avatar === myAvatar()) return;
    lookPending = true;
    send('look', { back: wallet.equip.back, ring: wallet.equip.ring, avatar: myAvatar() }).finally(() => { lookPending = false; });
  }

  // Voorbeeld van een item: klein in de shop, groot als je het bekijkt.
  function previewHTML(cat, item, big) {
    if (cat === 'back') return `<div class="card back b-${item.id}" style="--w:${big ? 150 : 58}px"></div>`;
    if (cat === 'ring') {
      const n = big ? 110 : 52;
      return `<span class="av r-${item.id}" style="width:${n}px;height:${n}px;font-size:${big ? 40 : 20}px"><img src="avatars/p${myAvatar()}.webp" alt=""></span>`;
    }
    if (cat === 'felt') return `<div class="felt-swatch f-${item.id}${big ? ' big' : ''}"></div>`;
    const icon = { geen: '·', confetti: '🎉', vuurwerk: '🎆', muntregen: '💰', kroning: '👑' }[item.id];
    return `<span class="fx-icon${big ? ' big' : ''}">${icon}</span>`;
  }

  let shopTab = 'back';
  let shopInspect = null; // { cat, id } van het item dat je groot bekijkt

  function shopItem(cat, id) { return SHOP.find(c => c.cat === cat).items.find(i => i.id === id); }

  function itemState(cat, i) {
    if (wallet.equip[cat] === i.id) return 'used';
    return wallet.owned[cat].includes(i.id) ? 'owned' : 'locked';
  }

  function itemTile(cat, i) {
    const st = itemState(cat, i);
    const foot = st === 'used' ? '<span class="tag-used">✓ In gebruik</span>'
      : st === 'owned' ? '<span class="tag-own">In bezit</span>'
        : `<span class="price${wallet.coins < i.price ? ' short' : ''}"><i class="coin"></i>${i.price}</span>`;
    return `<button class="shop-item t-${i.tier} ${st}" data-act="inspect" data-cat="${cat}" data-id="${i.id}">` +
      `<span class="tier">${TIERS[i.tier]}</span><span class="prev">${previewHTML(cat, i, false)}</span><b>${i.name}</b>${foot}</button>`;
  }

  function inspectHTML() {
    const { cat, id } = shopInspect;
    const i = shopItem(cat, id);
    const st = itemState(cat, i);
    let action;
    if (st === 'used') action = '<button class="btn big" disabled>✓ In gebruik</button>';
    else if (st === 'owned') action = `<button class="btn primary big" data-act="equip" data-cat="${cat}" data-id="${id}">Gebruiken</button>`;
    else if (wallet.coins < i.price) action = `<button class="btn big" disabled><i class="coin"></i>${i.price} · je mist er nog ${i.price - wallet.coins}</button>`;
    else action = `<button class="btn primary big" data-act="buy" data-cat="${cat}" data-id="${id}">Kopen voor <i class="coin"></i>${i.price}</button>`;
    const tryBtn = cat === 'effect' && id !== 'geen' ? `<button class="btn ghost" data-act="tryEffect" data-id="${id}">Probeer</button>` : '';
    return `<div class="inspect t-${i.tier}" data-act="closeInspect"><div class="inspect-card" data-act="noop">` +
      `<button class="iconbtn" data-act="closeInspect" aria-label="Sluiten">✕</button>` +
      `<span class="tier">${TIERS[i.tier]}</span>` +
      `<div class="inspect-stage"><div class="inspect-prev" id="tilt">${previewHTML(cat, i, true)}<i class="glare"></i></div></div>` +
      `<h3>${i.name}</h3><p>${i.desc}</p><div class="inspect-btns">${action}${tryBtn}</div></div></div>`;
  }

  function renderShop() {
    const el = $('#shop');
    if (el.hidden) return;
    const cat = SHOP.find(c => c.cat === shopTab) || SHOP[0];
    const tabs = SHOP.map(c => `<button class="shop-tab${c.cat === cat.cat ? ' on' : ''}" data-act="shopTab" data-cat="${c.cat}">${c.title}</button>`).join('');
    el.innerHTML = `<div class="shop-sheet">` +
      `<div class="shop-top"><h2>Shop</h2><div class="purse"><i class="coin"></i><b>${wallet.coins}</b></div>` +
      `<button class="iconbtn" data-act="closeShop" aria-label="Sluiten">✕</button></div>` +
      `<p class="shop-sub">Win een potje voor <b>${WIN_COINS}</b> muntjes (${BOT_WIN_COINS} als je alleen van bots wint).</p>` +
      `<div class="shop-tabs">${tabs}</div><p class="shop-note">${cat.note}</p>` +
      `<div class="shop-grid">${cat.items.map(i => itemTile(cat.cat, i)).join('')}</div></div>`;
    // Apart van het shopscherm, anders scrolt het grote voorbeeld mee.
    $('#inspect').innerHTML = shopInspect ? inspectHTML() : '';
  }

  // Groot voorbeeld kantelt mee met je vinger, zoals een echte verzamelkaart.
  function tilt(e) {
    const t = document.getElementById('tilt');
    if (!t) return;
    const r = t.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    t.style.transform = `rotateY(${(x - 0.5) * 30}deg) rotateX(${(0.5 - y) * 30}deg)`;
    t.style.setProperty('--gx', `${x * 100}%`);
    t.style.setProperty('--gy', `${y * 100}%`);
  }
  document.addEventListener('pointermove', e => { if (e.target.closest && e.target.closest('.inspect-stage')) tilt(e); });
  document.addEventListener('pointerleave', () => { const t = document.getElementById('tilt'); if (t) t.style.transform = ''; }, true);

  // Ontgrendeld: stempel en vonken in de kleur van de zeldzaamheid.
  function unlockFx(tier) {
    const card = $('#inspect .inspect-card');
    if (card) card.classList.add('unlock');
    const color = { gewoon: '#e8e0cf', zeldzaam: '#3d9bff', episch: '#b45cff', legendarisch: '#ffb43a' }[tier];
    const box = $('#bubbles');
    const n = { gewoon: 18, zeldzaam: 28, episch: 40, legendarisch: 60 }[tier];
    for (let i = 0; i < n; i++) {
      const sp = document.createElement('i');
      const ang = Math.random() * Math.PI * 2, dist = 60 + Math.random() * 140;
      sp.className = 'spark';
      sp.style.cssText = `left:50vw;top:42vh;background:${i % 3 ? color : '#fff'};--dx:${Math.cos(ang) * dist}px;--dy:${Math.sin(ang) * dist}px`;
      box.append(sp);
      setTimeout(() => sp.remove(), 1400);
    }
    setTimeout(() => play(tier === 'legendarisch' ? 'champion' : 'win'), 150);
    if (tier === 'legendarisch') celebrate('muntregen');
  }

  // Gespeelde slagen terugkijken: deze ronde, en de vorige ronde.
  let historyPrev = false;
  function renderHistory() {
    const el = $('#history');
    if (el.hidden || !S) return;
    const cur = S.tricks || [], prev = S.prevTricks || [];
    if (!cur.length && prev.length && !historyPrev && S.phase !== 'roundEnd') historyPrev = true;
    const list = historyPrev ? prev : cur;
    const tabs = `<div class="hist-tabs"><button class="btn mini-btn ${historyPrev ? 'ghost' : 'primary'}" data-act="historyTab" data-prev="0">Deze ronde</button>` +
      `<button class="btn mini-btn ${historyPrev ? 'primary' : 'ghost'}" data-act="historyTab" data-prev="1"${prev.length ? '' : ' disabled'}>Vorige ronde</button></div>`;
    const body = list.length ? [...list].reverse().map(t =>
      `<section class="hist-trick"><h3>Slag ${t.no}<small>${esc(nameOf(t.winner))} pakt hem</small></h3><div class="hist-cards">${
        t.cards.map(x => `<div class="hist-card${x.seat === t.winner ? ' win' : ''}">${cardHTML(x.card)}<span>${esc(nameOf(x.seat))}</span></div>`).join('')}</div></section>`).join('')
      : '<p class="sub">Nog geen slagen gespeeld.</p>';
    el.innerHTML = `<div class="sheet hist-sheet"><div class="hist-head"><h2>Gespeelde slagen</h2>` +
      `<button class="iconbtn" data-act="closeHistory" aria-label="Sluiten">✕</button></div>${tabs}${body}</div>`;
  }

  function openShop() {
    closeMenu();
    shopInspect = null;
    $('#shop').hidden = false;
    renderShop();
  }

  // Feestje bij winst: confetti of vuurwerk (alleen als je dat gekocht hebt).
  function celebrate(kind = wallet.equip.effect) {
    const box = $('#bubbles');
    const colors = ['#ffc84a', '#ff7a1a', '#d2202c', '#21e6c1', '#3d5afe', '#ff3c8e', '#8ee69a'];
    const pick = () => colors[Math.floor(Math.random() * colors.length)];
    if (kind === 'confetti') {
      for (let i = 0; i < 80; i++) {
        const c = document.createElement('i');
        c.className = 'confetti';
        c.style.cssText = `left:${Math.random() * 100}vw;background:${pick()};animation-delay:${Math.random() * 0.6}s;` +
          `animation-duration:${2 + Math.random() * 1.5}s;--rot:${Math.random() * 720 - 360}deg;--drift:${Math.random() * 120 - 60}px`;
        box.append(c);
        setTimeout(() => c.remove(), 4200);
      }
    } else if (kind === 'muntregen' || kind === 'kroning') {
      const n = kind === 'kroning' ? 50 : 70;
      for (let i = 0; i < n; i++) {
        const c = document.createElement('i');
        c.className = 'coin-drop';
        c.style.cssText = `left:${Math.random() * 100}vw;animation-delay:${Math.random() * (kind === 'kroning' ? 1.2 : 0.8)}s,${Math.random()}s;` +
          `animation-duration:${1.8 + Math.random() * 1.4}s,${0.5 + Math.random() * 0.5}s;--drift:${Math.random() * 80 - 40}px`;
        box.append(c);
        setTimeout(() => c.remove(), 4600);
      }
      if (kind === 'kroning') {
        const k = document.createElement('div');
        k.className = 'crowning';
        k.innerHTML = '<i class="rays"></i><span class="crown">👑</span><b>KAMPIOEN!</b>';
        box.append(k);
        setTimeout(() => k.remove(), 3600);
      }
    } else if (kind === 'vuurwerk') {
      for (let b = 0; b < 4; b++) {
        const x = 15 + Math.random() * 70, y = 15 + Math.random() * 40, color = pick();
        setTimeout(() => {
          play('pop');
          for (let i = 0; i < 26; i++) {
            const sp = document.createElement('i');
            const ang = (i / 26) * Math.PI * 2, dist = 70 + Math.random() * 50;
            sp.className = 'spark';
            sp.style.cssText = `left:${x}vw;top:${y}vh;background:${color};--dx:${Math.cos(ang) * dist}px;--dy:${Math.sin(ang) * dist}px`;
            box.append(sp);
            setTimeout(() => sp.remove(), 1400);
          }
        }, b * 450);
      }
    }
  }

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
      if (l.kind === 'toep') {
        splash(l.amount === 2 ? 'DUBBEL!' : 'TOEP!', l.text);
        play('knock');
        buzz([70, 50, 70]);
      } else if (l.kind === 'blind') { splash(`BLIND ${l.amount}!`, l.text); play('knock'); }
      else if (l.kind === 'final') { splash('FINALE!', l.text); play('knock'); }
      else if (l.kind === 'scherp') { splash('OP SCHERP!', l.text); play('knock'); }
      else if ((l.kind === 'round' && S.phase === 'roundEnd') || (l.kind === 'game' && S.phase === 'gameEnd')) continue; // staat al in het overzicht
      else toast(l.text, l.kind, l.cards || null);
    }
  }

  function notify() {
    const p = meP();
    const needs = !!(p && p.acting) && S.phase !== 'wash' && S.phase !== 'blind';
    if (needs && !prevNeeds) {
      buzz(S.phase === 'toep' || S.phase === 'washCheck' ? [90, 60, 90] : 60);
      if (S.phase !== 'toep') play('turn'); // bij een toep klinkt de klop al
    }
    prevNeeds = needs;
    document.title = needs ? '● Jouw beurt · Toepen' : 'Toepen';
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
      case 'theme': return act('theme', { theme: d.key });
      case 'reactMenu': return toggleReactTray();
      case 'react': toggleReactTray(false); return act('react', { emoji: d.emoji });
      case 'throwPick': return openThrowTray(Number(d.seat));
      case 'throw': return throwItem(d.item, d.seat);
      case 'toggleSound':
        prefs.sound = !prefs.sound;
        store('toep_sound', prefs.sound ? '1' : '0');
        renderPrefs();
        return play('pop');
      case 'buyIn':
        if (d.yes !== '1') return act('buyIn', { yes: false });
        if (wallet.coins < BUY_IN_COINS) return toast('Je hebt te weinig muntjes.', 'err');
        return send('buyIn', { yes: true }).then(ok => {
          if (!ok) return;
          wallet.coins -= BUY_IN_COINS;
          saveWallet();
          toast(`Ingekocht! −${BUY_IN_COINS} muntjes`, 'coins');
          play('coin');
        });
      case 'openShop': return openShop();
      case 'openHistory':
        historyPrev = false;
        $('#history').hidden = false;
        return renderHistory();
      case 'historyTab':
        historyPrev = d.prev === '1';
        return renderHistory();
      case 'closeHistory': $('#history').hidden = true; return undefined;
      case 'closeShop':
        $('#shop').hidden = true;
        shopInspect = null;
        $('#inspect').innerHTML = '';
        return undefined;
      case 'buy': return buy(d.cat, d.id);
      case 'equip': return equip(d.cat, d.id);
      case 'tryEffect': return celebrate(d.id);
      case 'shopTab':
        shopTab = d.cat;
        shopInspect = null;
        return renderShop();
      case 'inspect':
        shopInspect = { cat: d.cat, id: d.id };
        play('pop');
        return renderShop();
      case 'closeInspect':
        shopInspect = null;
        return renderShop();
      case 'toggleExpert':
        prefs.expert = !prefs.expert;
        store('toep_expert', prefs.expert ? '1' : '0');
        renderPrefs();
        if (S) syncLook();
        return undefined;
      case 'avatar':
        store('toep_avatar', String(Number(d.n)));
        renderPrefs();
        if (S) { render(); syncLook(); }
        return undefined;
      case 'toggleBuzz':
        prefs.buzz = !prefs.buzz;
        store('toep_buzz', prefs.buzz ? '1' : '0');
        renderPrefs();
        return buzz(80);
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
      case 'rematch': if (net.table) net.table.delay = 1; return act('rematch');
      case 'toLobby': return act('lobby');
      case 'lobby':
        if (confirm('Spel stoppen en terug naar de lobby? De stand gaat verloren.')) { closeMenu(); act('lobby'); }
        return;
      case 'addBot': return act('addBot');
      case 'removeBot': return act('removeBot', { seat: Number(d.seat) });
      case 'mode': return act('settings', { mode: d.mode });
      case 'max': return act('settings', { maxPoints: Number(d.max) });
      case 'rule': return act('settings', { rule: d.rule });
      case 'money': return act('settings', { money: Number(d.cents) });
      case 'moneyCustom': {
        const v = prompt('Eigen inzet in euro (bijv. 0,50 of 10):', S.settings.money ? (S.settings.money / 100).toFixed(2).replace('.', ',') : '');
        if (v === null) return undefined;
        const cents = Math.round(parseFloat(v.replace(',', '.').replace(/[^0-9.]/g, '')) * 100);
        if (!(cents >= 10 && cents <= 10000)) return toast('Kies een bedrag tussen €0,10 en €100.', 'err');
        return act('settings', { money: cents });
      }
      case 'start': if (net.table) net.table.delay = 1; return act('start');
      case 'leave': return act('leave');
      case 'openMenu': return openMenu();
      case 'openRules':
        openMenu();
        $('#rulesBox').open = true; // via de link: meteen uitgeklapt
        return $('#rulesBox').scrollIntoView({ block: 'start' });
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
      case 'solo': return startP2P('solo');
      case 'claimDaily': return claimDaily();
      case 'claimGift': return claimGift();
      case 'fastForward':
        if (net.solo && net.table) {
          const t = net.table;
          t.delay = 0.08;
          // Lopende pauze meteen afbreken, de rest gaat vanaf nu snel.
          if (t.phase === 'trickEnd') { t.cancelAfter(); t.finishTrick(); } else if (t.phase === 'roundEnd' && !t.buyIn) t.startRound();
          t.changed();
        }
        return undefined;
      case 'introNext': return introStep < INTRO.length - 1 ? showIntro(introStep + 1) : introDone();
      case 'introDone': return introDone();
      case 'openIntro': closeMenu(); return showIntro(0);
      case 'rejoin': return startP2P('rejoin');
      case 'cancelConnect': return cancelConnect();
      case 'stopConnect':
        if (confirm('Stoppen met verbinden? Je gaat naar het startscherm en kunt later terug naar de kamer.')) cancelConnect();
        return undefined;
      case 'leaveRoom': {
        const q = net.solo ? 'Stoppen met oefenen?' : net.role === 'host'
          ? 'Kamer sluiten? Iedereen raakt de verbinding kwijt.'
          : 'Kamer verlaten?';
        if (confirm(q)) leaveRoom();
        return undefined;
      }
    }
    return undefined;
  }

  document.addEventListener('click', e => {
    if (!e.target.closest('#reactTray, .react-btn')) $('#reactTray').hidden = true;
    if (!e.target.closest('#throwTray, .opp')) $('#throwTray').hidden = true;
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

  // Uitklapblokken onthouden, want de lobby wordt bij elke update opnieuw getekend.
  document.addEventListener('toggle', e => {
    if (e.target.id === 'moreSettings') moreOpen = e.target.open;
  }, true);

  $('#homeForm').addEventListener('submit', e => {
    e.preventDefault();
    onAct($('#homeCode').value.trim() ? 'joinCode' : 'host', {});
  });
  $('#homeCode').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  });

  // Installeerbaar als app en sneller opstarten (alleen via https, dus niet bij lokaal testen).
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* geen probleem: dan gewoon zonder */ });
  }

  applyTheme(store('toep_theme')); // laatste stijl al tonen op het startscherm
  renderPrefs();
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
  // Nieuw hier? Eerst de uitleg. Daarna (en elke nieuwe dag) de dagelijkse beloning.
  setTimeout(() => { if (!store('toep_intro') && !code) showIntro(0); else if (!showGift()) showDaily(); }, 600);
})();
