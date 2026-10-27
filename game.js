/* Spelregels en spelverloop van Toepen (2 t/m 4 spelers), browserversie.
 *
 * Draait op de telefoon van de host. Zelfde regels als game.py (de pc-versie):
 * de host is de baas, gasten sturen alleen acties en krijgen per speler een
 * gefilterde spelstand terug.
 */
(function (root) {
  'use strict';

  const RANKS = ['J', 'Q', 'K', 'A', '7', '8', '9', '10']; // laag -> hoog
  const SUITS = ['S', 'H', 'C', 'D'];
  const FULL_DECK = SUITS.flatMap(s => RANKS.map(r => r + s));
  const SUIT_NAMES = { S: 'schoppen', H: 'harten', C: 'klaveren', D: 'ruiten' };
  const BOT_NAMES = ['Robin', 'Sebastian', 'Martijn'];
  const LEVELS = ['makkelijk', 'gemiddeld', 'moeilijk', 'god'];
  const FACES = ['J', 'Q', 'K', 'A'];
  const THEMES = ['cafe', 'nacht'];
  const REACTIONS = ['🍺', '👏', '😏', '😱', '😂', '🔥'];
  const AVATAR_COUNT = 24;

  // Instellingen van de slimme bots, afgesteld met simulaties (zie README).
  const BOT_STRATEGY = {
    // Moeilijk past zich aan: leest de toeps van wie vaak eerlijk toept en blufft meer
    // tegen spelers die snel passen.
    moeilijk: { samples: 150, adapt: true, toep: 0.6, bluff: 0.25, read: 0.15, noise: 0.1, deathCaution: 0.55, double: 0.8, blind: 0.03, blindAmount: 2, blindRoom: 6 },
    // God ziet alle kaarten: geen gokwerk, en bluft alleen als hij weet dat het lukt.
    god: { samples: 200, toep: 0.55, bluff: 0, read: 0, noise: 0, deathCaution: 0.55, double: 0.8, blind: 0, blindAmount: 2, blindRoom: 6 },
  };
  const LOOKS = {
    back: ['rood', 'blauw', 'oranje', 'ruit', 'goud', 'sterren', 'regenboog', 'smaragd', 'holo', 'vlam', 'kosmos', 'koning'],
    ring: ['geen', 'ijs', 'goud', 'vuur', 'neon', 'regenboog', 'bliksem', 'kroon', 'diamant'],
  };
  const MAX_BLINDS = 2;        // per speler per potje
  const BLIND_AMOUNTS = [2, 3, 4];
  const BLIND_FOLD = 1;        // strafpunt als je bij blind meteen weggaat, zonder te kijken
  const SEEN_FOLD = 2;         // strafpunten als je na 'gezien' weggaat

  const ROUND_PAUSE = 10;      // seconden tussen rondes
  const BLIND_TIME = 10;       // seconden om te kiezen of je blind speelt
  const BUY_IN_PAUSE = 30;     // seconden om te beslissen of je je inkoopt
  const TRICK_PAUSE = 1.4;     // seconden dat een volle slag blijft liggen
  const LAST_TRICK_PAUSE = 1.8;

  const rankOf = c => c.slice(0, -1);
  const suitOf = c => c.slice(-1);
  const valOf = c => RANKS.indexOf(rankOf(c));
  const choice = a => a[Math.floor(Math.random() * a.length)];
  const minBy = (a, f) => a.reduce((best, x) => (f(x) < f(best) ? x : best));
  const pointsText = n => `${n} strafpunt${n === 1 ? '' : 'en'}`;

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function isWas(hand) {
    // Was: vier plaatjes/azen, of drie plaatjes/azen plus een 7.
    const faces = hand.filter(c => FACES.includes(rankOf(c))).length;
    const sevens = hand.filter(c => rankOf(c) === '7').length;
    return hand.length === 4 && (faces === 4 || (faces === 3 && sevens === 1));
  }

  class GameError extends Error {
    constructor(message) { super(message); this.name = 'GameError'; }
  }
  const fail = message => { throw new GameError(message); };

  // ---------- uitspelen (voor de slimme bots) ----------

  function legalFrom(hand, trick) {
    if (!trick.length) return [...hand];
    const lead = suitOf(trick[0][1]);
    const follow = hand.filter(c => suitOf(c) === lead);
    return follow.length ? follow : [...hand];
  }

  function winnerOf(trick, folded) {
    const cands = trick.filter(t => !folded.has(t[0]));
    let lead = suitOf(trick[0][1]);
    let follow = cands.filter(t => suitOf(t[1]) === lead);
    if (!follow.length) {
      lead = suitOf(cands[0][1]);
      follow = cands.filter(t => suitOf(t[1]) === lead);
    }
    return follow.reduce((b, t) => (valOf(t[1]) > valOf(b[1]) ? t : b))[0];
  }

  // Speel de ronde snel uit met een simpele strategie; geeft de winnaar terug.
  function rollout(hands, trick, turn, active, folded, trickNo, total, first) {
    const h = {};
    for (const s in hands) h[s] = [...hands[s]];
    trick = [...trick];
    for (;;) {
      const hand = h[turn];
      let card;
      if (first !== undefined) {
        card = first;
        first = undefined;
      } else {
        const legal = legalFrom(hand, trick);
        card = legal.length === 1 || Math.random() >= 0.25 ? minBy(legal, valOf) : choice(legal);
      }
      hand.splice(hand.indexOf(card), 1);
      trick.push([turn, card]);
      const played = new Set(trick.map(t => t[0]));
      if ([...active].every(s => played.has(s))) {
        const w = winnerOf(trick, folded);
        if (trickNo >= total) return w;
        trickNo++;
        trick = [];
        turn = w;
      } else {
        for (let i = 1; i <= 4; i++) {
          const s = (turn + i) % 4;
          if (active.has(s) && !played.has(s)) { turn = s; break; }
        }
      }
    }
  }

  function newPlayer(id, name, bot, seat) {
    const p = { id, name, bot, seat, level: 'gemiddeld', points: 0, dead: false, blindsUsed: 0, wins: 0, stats: newStats(), look: { back: 'rood', ring: 'geen' } };
    resetRound(p);
    return p;
  }

  // Statistieken per potje, voor het eindscherm.
  function newStats() {
    return { rounds: 0, toeps: 0, toepWins: 0, folds: 0, blinds: 0, bigPot: 0, faced: 0, toepFolds: 0 };
  }

  function resetRound(p) {
    p.hand = [];
    p.folded = false;
    p.foldPenalty = 0;
    p.extra = 0;              // +1 als je "gezien" meegaat bij blind
    p.blindDecision = null;   // 0 = kijken, 2-4 = blind
    p.blindResp = null;       // 'blind' | 'seen' | 'mee' | 'weg'
    p.washDecision = null;
    p.passCard = null;
    p.doubleUsed = false;
    p.received = null;
    p.toeped = false;         // heeft deze ronde getoept (voor de statistieken)
  }

  // Alles wat nodig is om een spel na een herlaadactie van de host te hervatten.
  const STATE_KEYS = ['seats', 'settings', 'logs', 'logSeq', 'botSeq', 'gamesPlayed', 'phase', 'round', 'stake',
    'trick', 'trickNo', 'tricksTotal', 'turn', 'leader', 'lastToeper', 'toep', 'blind', 'scherp', 'final',
    'washCheck', 'washQueue', 'result', 'trickWinner', 'winner', 'nextRoundAt', 'deck', 'roundPlayed', 'voids',
    'tricks', 'prevTricks', 'buyIn', 'buyIns', 'anyDied', 'blindDeadline'];

  class Table {
    constructor({ onChange = () => {}, isConnected = () => true, delay = 1, hostPid = null } = {}) {
      this.onChange = onChange;
      this.isConnected = isConnected;
      this.delay = delay;
      this.hostPid = hostPid; // alleen de host mag de stijl kiezen
      this.seats = [null, null, null, null];
      this.settings = {
        mode: 'klassiek',
        maxPoints: 15,
        theme: 'cafe',
        rules: { was: true, pass: true, double: true, boer: true, comeback: true },
      };
      this.logs = [];
      this.logSeq = 0;
      this.botSeq = 0;
      this.gamesPlayed = 0;
      this.reactions = [];
      this.reactSeq = 0;
      this.phaseGen = 0;
      this.botPending = false;
      this.toLobby();
    }

    // ---------- hulpjes ----------

    get rules() { return this.settings.mode === 'kroeg' ? this.settings.rules : {}; }
    // Spelvorm 'finale': één ronde met 8 kaarten, geen strafpunten.
    get finaleMode() { return this.settings.mode === 'finale'; }
    // Puntental waarop je 'op scherp' staat (14 bij af op 15).
    get edge() { return this.settings.maxPoints - 1; }

    byPid(pid) { return this.seats.find(p => p && p.id === pid) || null; }
    seated() { return this.seats.filter(Boolean); }
    alive() { return this.seated().filter(p => !p.dead); }
    active() { return this.alive().filter(p => !p.folded); }

    nextSeat(from, pred) {
      for (let i = 1; i <= 4; i++) {
        const s = (from + i) % 4, p = this.seats[s];
        if (p && pred(p)) return s;
      }
      return -1;
    }

    // Bezette stoelen met de klok mee, vanaf `start`.
    orderFrom(start) {
      return [0, 1, 2, 3].map(i => (start + i) % 4).filter(s => this.seats[s]);
    }

    log(text, kind = '', extra = {}) {
      this.logSeq++;
      this.logs.push({ id: this.logSeq, text, kind, ...extra });
      this.logs = this.logs.slice(-60);
    }

    changed() {
      this.onChange();
      this.scheduleBots();
    }

    // Voer fn later uit, tenzij de fase intussen veranderd is.
    after(seconds, fn) {
      const gen = ++this.phaseGen;
      setTimeout(() => {
        if (gen !== this.phaseGen) return;
        fn();
        this.changed();
      }, seconds * 1000 * this.delay);
    }

    cancelAfter() { this.phaseGen++; }

    lobbyOnly() {
      if (this.phase !== 'lobby') fail('Dat kan alleen in de lobby.');
    }

    // ---------- opslaan / hervatten ----------

    serialize() {
      const out = {};
      for (const k of STATE_KEYS) out[k] = this[k];
      return JSON.stringify(out);
    }

    restore(json) {
      Object.assign(this, JSON.parse(json));
      for (const p of this.seated()) if (!p.stats) p.stats = newStats(); // opgeslagen door een oudere versie
      if (!THEMES.includes(this.settings.theme)) this.settings.theme = 'cafe'; // stijl die niet meer bestaat
      for (const p of this.seated()) if (!p.look) p.look = { back: 'rood', ring: 'geen' };
      // Lopende pauzes opnieuw starten.
      if (this.phase === 'trickEnd') this.after(TRICK_PAUSE, () => this.finishTrick());
      if (this.phase === 'blind') {
        this.after(Math.max(1, ((this.blindDeadline || 0) - Date.now()) / 1000 / this.delay), () => this.blindTimeout());
      }
      if (this.phase === 'roundEnd') {
        const left = Math.max(1, (this.nextRoundAt - Date.now()) / 1000 / this.delay);
        if (this.buyIn) this.after(left, () => this.doBuyIn(this.seats[this.buyIn.seat], false));
        else this.after(left, () => this.startRound());
      }
    }

    // ---------- acties ----------

    handle(pid, msg) {
      const t = msg.type;
      if (t === 'join') {
        this.join(pid, msg.name);
      } else {
        const p = this.byPid(pid);
        if (!p) fail('Je zit niet aan tafel.');
        switch (t) {
          case 'leave': this.leave(p); break;
          case 'addBot': this.addBot(); break;
          case 'removeBot': this.removeBot(msg.seat); break;
          case 'botLevel': this.cycleBotLevel(msg.seat); break;
          case 'settings': this.setSettings(msg); break;
          case 'theme': this.setTheme(pid, msg.theme); break;
          case 'react': this.react(p, msg.emoji); break;
          case 'look': this.setLook(p, msg); break;
          case 'expert': p.expert = !!msg.on; break;
          case 'start': this.start(); break;
          case 'blind': this.doBlind(p, msg.amount || 0); break;
          case 'blindResp': this.doBlindResp(p, msg.choice); break;
          case 'scherp': this.doScherp(p, !!msg.go); break;
          case 'wash': this.doWash(p, !!msg.claim); break;
          case 'washResponse': this.doWashResponse(p, !!msg.check); break;
          case 'pass': this.doPass(p, msg.card); break;
          case 'toep': this.doToep(p, msg.amount === 2 ? 2 : 1); break;
          case 'toepResponse': this.doToepResponse(p, !!msg.go); break;
          case 'play': this.doPlay(p, msg.card); break;
          case 'buyIn': this.doBuyIn(p, !!msg.yes); break;
          case 'next':
            if (this.phase !== 'roundEnd') fail('De ronde is nog bezig.');
            if (this.buyIn) fail(`Even wachten: ${this.seats[this.buyIn.seat].name} mag zich nog inkopen.`);
            this.startRound();
            break;
          case 'lobby':
            if (this.phase === 'lobby') fail('Je zit al in de lobby.');
            this.toLobby();
            this.log(`${p.name} heeft het spel gestopt`);
            break;
          case 'rematch':
            if (this.phase !== 'gameEnd') fail('Het spel is nog bezig.');
            this.toLobby();
            this.start();
            break;
          default: fail('Onbekende actie.');
        }
      }
      this.changed();
    }

    // ---------- lobby ----------

    toLobby() {
      this.cancelAfter();
      Object.assign(this, {
        phase: 'lobby', round: 0, stake: 1, trick: [], trickNo: 0, tricksTotal: 4, turn: -1, leader: -1,
        lastToeper: -1, toep: null, blind: null, scherp: null, final: false, washCheck: null, washQueue: [],
        result: null, trickWinner: -1, winner: -1, nextRoundAt: 0, deck: [], roundPlayed: [], voids: {},
        tricks: [], prevTricks: [], buyIn: null, buyIns: 0, anyDied: false,
      });
      for (const p of this.seated()) {
        p.points = 0;
        p.dead = false;
        p.blindsUsed = 0;
        resetRound(p);
      }
    }

    join(pid, name) {
      name = String(name || '').trim().slice(0, 14);
      if (!name) fail('Vul je naam in.');
      const p = this.byPid(pid);
      if (p) { p.name = name; return; }
      if (this.phase !== 'lobby') fail('Er is al een spel bezig. Je kunt meekijken.');
      const s = this.seats.indexOf(null);
      if (s < 0) fail('De tafel is vol.');
      this.seats[s] = newPlayer(pid, name, false, s);
      this.log(`${name} schuift aan`, 'quiet');
    }

    leave(p) {
      this.lobbyOnly();
      this.seats[p.seat] = null;
      this.log(`${p.name} staat op`, 'quiet');
    }

    addBot() {
      this.lobbyOnly();
      const s = this.seats.indexOf(null);
      if (s < 0) fail('De tafel is vol.');
      const used = new Set(this.seated().map(p => p.name));
      const name = BOT_NAMES.find(n => !used.has(n)) || 'Bot';
      this.botSeq++;
      this.seats[s] = newPlayer(`bot-${this.botSeq}`, name, true, s);
    }

    botAt(seat) {
      seat = Number(seat);
      const p = this.seats[seat];
      if (!(seat >= 0 && seat < 4) || !p || !p.bot) fail('Daar zit geen bot.');
      return p;
    }

    removeBot(seat) {
      this.lobbyOnly();
      this.seats[this.botAt(seat).seat] = null;
    }

    cycleBotLevel(seat) {
      this.lobbyOnly();
      const b = this.botAt(seat);
      b.level = LEVELS[(LEVELS.indexOf(b.level) + 1) % LEVELS.length];
    }

    setSettings(m) {
      this.lobbyOnly();
      const s = this.settings;
      if (['klassiek', 'kroeg', 'finale'].includes(m.mode)) s.mode = m.mode;
      if (m.maxPoints === 10 || m.maxPoints === 15) s.maxPoints = m.maxPoints;
      if (m.rule in s.rules) s.rules[m.rule] = !s.rules[m.rule];
    }

    // Uiterlijk uit de shop dat de anderen ook zien. Wat je bezit, houdt elke
    // telefoon zelf bij; hier wordt alleen gecontroleerd dat het een bestaand item is.
    setLook(p, m) {
      if (LOOKS.back.includes(m.back)) p.look.back = m.back;
      if (LOOKS.ring.includes(m.ring)) p.look.ring = m.ring;
      if (Number.isInteger(m.avatar) && m.avatar >= 1 && m.avatar <= AVATAR_COUNT) p.look.avatar = m.avatar;
    }

    // Expert-hulp: rekent voor deze speler uit wat slim is, met alleen wat hij zelf
    // kan weten (net als de bot Moeilijk, dus zonder in andermans kaarten te kijken).
    adviceFor(p) {
      if (!p.expert || p.dead || p.folded) return null;
      const t = this.toep, sc = this.scherp;
      const key = [this.round, this.phase, this.trickNo, this.trick.length, this.turn, t ? t.pending.join() : '', this.stake].join('|');
      if (p.adviceKey === key) return p.advice;
      const me = { ...p, level: 'moeilijk' };
      let advice = null;
      if (this.phase === 'play' && this.turn === p.seat) {
        const [card, chance] = this.botBestCard(me, 250);
        advice = { type: 'play', card, chance, toep: this.canToep(p) && chance > 0.6 };
      } else if (this.phase === 'toep' && t.pending[0] === p.seat) {
        const prev = t.prev + p.extra, next = prev + t.amount, chance = this.botWinChance(me, 250);
        advice = { type: 'toep', chance, go: chance > 1 - prev / next || p.points + prev >= this.settings.maxPoints };
      } else if (this.phase === 'scherp' && sc.pending.includes(p.seat)) {
        const chance = this.botWinChance(me, 250);
        advice = { type: 'scherp', chance, go: chance > 0.5 };
      }
      p.adviceKey = key;
      p.advice = advice;
      return advice;
    }

    // Snelle reactie (emoji) die even bij je naam verschijnt.
    react(p, emoji) {
      if (!REACTIONS.includes(emoji)) fail('Onbekende reactie.');
      const now = Date.now();
      if (now - (p.lastReact || 0) < 1200) fail('Rustig aan met reageren.');
      p.lastReact = now;
      this.reactSeq++;
      this.reactions.push({ id: this.reactSeq, seat: p.seat, emoji });
      this.reactions = this.reactions.slice(-12);
    }

    // Stijl van het spel voor iedereen; mag ook tijdens het spel.
    setTheme(pid, theme) {
      if (this.hostPid && pid !== this.hostPid) fail('Alleen de host kan de stijl kiezen.');
      if (!THEMES.includes(theme)) fail('Onbekende stijl.');
      this.settings.theme = theme;
    }

    start() {
      this.lobbyOnly();
      if (this.seated().length < 2) fail('Er zijn minstens 2 spelers nodig.');
      for (const p of this.seated()) {
        p.points = 0;
        p.dead = false;
        p.blindsUsed = 0;
        p.stats = newStats();
      }
      this.round = 0;
      this.buyIn = null;
      this.buyIns = 0;
      this.anyDied = false;
      this.leader = choice(this.seated()).seat;
      this.log('Het spel begint!', 'quiet');
      this.startRound();
    }

    // ---------- ronde ----------

    startRound() {
      this.cancelAfter();
      this.round++;
      Object.assign(this, {
        deck: shuffle([...FULL_DECK]), stake: 1, trick: [], trickNo: 1, turn: -1, lastToeper: -1,
        toep: null, blind: null, scherp: null, washCheck: null, washQueue: [], result: null,
        trickWinner: -1, roundPlayed: [], voids: { 0: [], 1: [], 2: [], 3: [] },
        prevTricks: this.tricks || [], tricks: [],
      });

      const alive = this.alive();
      const onEdge = alive.filter(p => p.points === this.edge);
      // Finale: alle overgebleven spelers staan op scherp -> 8 kaarten elk.
      // In de spelvorm 'finale' is elke (enige) ronde zo'n finale.
      this.final = this.finaleMode || (alive.length >= 2 && onEdge.length === alive.length);
      this.tricksTotal = this.final ? 8 : 4;
      for (const p of this.seated()) {
        resetRound(p);
        if (!p.dead) p.hand = this.deck.splice(0, this.tricksTotal);
      }
      if (this.seats[this.leader].dead) this.leader = this.nextSeat(this.leader, q => !q.dead);
      // Wie op 14 staat, mag altijd beginnen (de eerste met de klok mee als het er meer zijn).
      if (onEdge.length && !this.final) {
        this.leader = this.orderFrom(this.leader).find(s => !this.seats[s].dead && this.seats[s].points === this.edge);
      }
      this.log(`Ronde ${this.round}: ${this.seats[this.leader].name} komt uit`, 'quiet');

      if (this.finaleMode) {
        this.log('Finale! 8 kaarten elk, de laatste slag beslist.', 'final');
        this.beginPlay();
        return;
      }
      if (this.final) {
        this.log(`Finale! Iedereen staat op ${this.edge}: 8 kaarten, de laatste slag beslist.`, 'final');
        this.beginPlay();
        return;
      }
      if (onEdge.length) {
        // Wie op scherp staat, moet genomen worden: mee = 2, weg = 1.
        this.stake = 2;
        this.scherp = {
          seats: onEdge.map(p => p.seat),
          pending: this.orderFrom(this.leader).filter(s => !this.seats[s].dead && this.seats[s].points !== this.edge),
          resp: {},
        };
        this.log(`${onEdge.map(p => p.name).join(' en ')} staat op ${this.edge} en moet genomen worden!`, 'scherp');
        this.phase = 'scherp';
        return;
      }
      // Normale ronde: eerst mag iedereen (zonder te kijken) blind spelen.
      for (const p of alive) if (p.blindsUsed >= MAX_BLINDS || this.blindMax(p) < 2 || !this.isBlindLeader(p)) p.blindDecision = 0;
      if (alive.every(p => p.blindDecision !== null)) this.afterBets();
      else {
        this.phase = 'blind';
        this.blindDeadline = Date.now() + BLIND_TIME * 1000 * this.delay;
        this.after(BLIND_TIME, () => this.blindTimeout());
      }
    }

    // ----- blind -----

    // Te lang getwijfeld over blind: dan kijk je gewoon.
    blindTimeout() {
      if (this.phase !== 'blind') return;
      for (const p of this.alive().filter(q => q.blindDecision === null)) {
        this.log(`${p.name} koos niet op tijd en kijkt`, 'quiet');
        if (this.phase === 'blind') this.doBlind(p, 0);
      }
    }

    // Alleen wie in zijn eentje de meeste punten heeft, mag blind spelen.
    // Staan er twee of meer gelijk bovenaan, dan kan niemand blind.
    isBlindLeader(p) {
      const alive = this.alive();
      const top = Math.max(...alive.map(q => q.points));
      return p.points === top && alive.filter(q => q.points === top).length === 1;
    }

    // Hoogste blind die nog kan: je kunt nooit boven de 15 eindigen.
    blindMax(p) { return Math.min(4, this.settings.maxPoints - p.points); }

    doBlind(p, amount) {
      if (this.phase !== 'blind') fail('Het moment voor blind is voorbij.');
      if (p.dead) fail('Je bent af.');
      if (p.blindDecision !== null) fail('Je hebt al gekozen.');
      if (amount) {
        if (!BLIND_AMOUNTS.includes(amount)) fail('Blind kan voor 2, 3 of 4 punten.');
        if (p.blindsUsed >= MAX_BLINDS) fail(`Je hebt al ${MAX_BLINDS}× blind gespeeld dit potje.`);
        if (!this.isBlindLeader(p)) fail('Alleen wie in zijn eentje de meeste punten heeft, mag blind spelen.');
        if (amount > this.blindMax(p)) fail(`Op ${p.points} punten kun je hooguit blind voor ${this.blindMax(p)}.`);
        p.blindsUsed++;
        p.stats.blinds++;
        p.blindDecision = amount;
        this.stake = amount;
        // Blind telt als een toep: pas weer toepen nadat iemand anders heeft getoept.
        this.lastToeper = p.seat;
        this.blind = {
          by: p.seat, amount, resp: {},
          pending: this.orderFrom(p.seat).filter(s => s !== p.seat && !this.seats[s].dead),
        };
        this.phase = 'blindResp';
        this.log(`${p.name} speelt blind voor ${amount}!`, 'blind', { amount });
        return;
      }
      p.blindDecision = 0;
      if (this.alive().every(q => q.blindDecision !== null)) this.afterBets();
    }

    doBlindResp(p, choiceName) {
      const b = this.blind;
      if (this.phase !== 'blindResp' || !b.pending.includes(p.seat)) fail('Er valt niets te kiezen.');
      if (b.pending[0] !== p.seat) fail(`Eerst kiest ${this.seats[b.pending[0]].name}.`);
      const r = p.blindResp, n = b.amount;
      if (choiceName === 'seen' && r === null) {
        p.blindResp = 'seen';
        b.resp[p.seat] = 'seen';
        return;
      }
      if (choiceName === 'weg' && r === null) {
        p.blindResp = 'weg';
        p.folded = true;
        p.foldPenalty = BLIND_FOLD; // zonder kijken weg kost 1
        p.stats.folds++;
        this.log(`${p.name} gaat weg zonder te kijken (${pointsText(BLIND_FOLD)})`, 'fold');
      } else if (choiceName === 'blind' && r === null) {
        p.blindResp = 'blind';
        this.log(`${p.name} gaat blind mee`, 'quiet');
      } else if (choiceName === 'mee' && r === 'seen') {
        p.blindResp = 'mee';
        p.extra = 1;
        this.log(`${p.name} gaat gezien mee voor ${n + 1}`, 'quiet');
      } else if (choiceName === 'weg' && r === 'seen') {
        p.blindResp = 'weg';
        p.folded = true;
        p.foldPenalty = SEEN_FOLD; // gezien weggaan kost altijd 2
        p.stats.folds++;
        this.log(`${p.name} gaat gezien weg (${pointsText(SEEN_FOLD)})`, 'fold');
      } else {
        fail('Dat kan nu niet.');
      }
      b.resp[p.seat] = p.blindResp;
      b.pending.splice(b.pending.indexOf(p.seat), 1);
      if (!b.pending.length) {
        const act = this.active();
        if (act.length === 1) return this.endRound(act[0].seat, true);
        this.afterBets();
      }
    }

    // ----- op scherp -----

    doScherp(p, go) {
      const sc = this.scherp;
      if (this.phase !== 'scherp' || !sc.pending.includes(p.seat)) fail('Er valt niets te kiezen.');
      sc.pending.splice(sc.pending.indexOf(p.seat), 1);
      sc.resp[p.seat] = go;
      if (go) {
        this.log(`${p.name} gaat mee`, 'quiet');
      } else {
        p.folded = true;
        p.foldPenalty = 1;
        p.stats.folds++;
        this.log(`${p.name} gaat weg (1 strafpunt)`, 'fold');
      }
      if (!sc.pending.length) {
        const act = this.active();
        if (act.length === 1) return this.endRound(act[0].seat, true);
        this.afterBets();
      }
    }

    afterBets() {
      if (this.rules.was && !this.blind && !this.scherp && !this.final) this.phase = 'wash';
      else this.afterWash();
    }

    // ----- was (kroegregel) -----
    // Iedereen kiest eerst (claimen of spelen), daarna worden claims
    // een voor een behandeld en mogen de anderen controleren.

    doWash(p, claim) {
      if (this.phase !== 'wash') fail('Het moment voor een was is voorbij.');
      if (p.dead) fail('Je bent af.');
      if (p.washDecision !== null) fail('Je hebt al gekozen.');
      p.washDecision = claim;
      if (this.alive().every(q => q.washDecision !== null)) {
        this.washQueue = this.orderFrom(this.leader).filter(s => !this.seats[s].dead && this.seats[s].washDecision);
        this.nextWash();
      }
    }

    nextWash() {
      while (this.washQueue.length) {
        const s = this.washQueue.shift();
        const c = this.seats[s];
        if (c.dead) continue;
        this.phase = 'washCheck';
        this.washCheck = { seat: s, pending: this.alive().filter(q => q.seat !== s).map(q => q.seat), checker: -1 };
        this.log(`${c.name} claimt een was!`, 'was');
        return;
      }
      this.washCheck = null;
      this.afterWash();
    }

    doWashResponse(p, check) {
      const wc = this.washCheck;
      if (this.phase !== 'washCheck' || !wc.pending.includes(p.seat)) fail('Er valt niets te controleren.');
      wc.pending.splice(wc.pending.indexOf(p.seat), 1);
      if (check) wc.checker = p.seat;
      if (check || !wc.pending.length) this.resolveWash();
    }

    resolveWash() {
      const wc = this.washCheck;
      const c = this.seats[wc.seat];
      if (wc.checker < 0) {
        c.hand = this.deck.splice(0, 4);
        this.log(`Niemand controleert. ${c.name} krijgt nieuwe kaarten.`);
      } else {
        const k = this.seats[wc.checker];
        const shown = [...c.hand];
        if (isWas(c.hand)) {
          k.points++;
          c.hand = this.deck.splice(0, 4);
          this.log(`${k.name} controleert ${c.name}: echte was! Strafpunt voor ${k.name}.`, 'reveal', { cards: shown });
        } else {
          c.points++;
          this.log(`${k.name} controleert ${c.name}: gebluft! Strafpunt voor ${c.name}.`, 'reveal', { cards: shown });
        }
        this.checkDeaths();
        if (this.alive().length <= 1) return this.endGame();
      }
      this.nextWash();
    }

    afterWash() {
      if (this.rules.pass && !this.final) this.phase = 'pass';
      else this.beginPlay();
    }

    doPass(p, card) {
      if (this.phase !== 'pass' || p.dead) fail('Nu valt er niets door te geven.');
      if (p.passCard !== null) fail('Je hebt al een kaart gekozen.');
      if (!p.hand.includes(card)) fail('Die kaart heb je niet.');
      p.passCard = card;
      const alive = this.alive();
      if (alive.every(q => q.passCard !== null)) {
        for (const q of alive) q.hand.splice(q.hand.indexOf(q.passCard), 1);
        for (const q of alive) {
          const target = this.seats[this.nextSeat(q.seat, x => !x.dead)];
          target.hand.push(q.passCard);
          target.received = q.passCard;
        }
        this.log('Iedereen heeft een kaart doorgegeven.', 'quiet');
        this.beginPlay();
      }
    }

    beginPlay() {
      if (this.seats[this.leader].dead) this.leader = this.nextSeat(this.leader, q => !q.dead);
      this.phase = 'play';
      this.turn = this.leader;
      if (this.seats[this.turn].folded) { // weggegaan bij blind/scherp: volgende komt uit
        this.turn = this.nextSeat(this.turn, q => !q.dead && !q.folded);
      }
      this.trick = [];
      this.trickNo = 1;
    }

    // ---------- spelen ----------

    trickPairs() { return this.trick.map(t => [t.seat, t.card]); }

    legalCards(p) {
      if (this.phase !== 'play' || this.turn !== p.seat) return [];
      return legalFrom(p.hand, this.trickPairs());
    }

    played(seat) { return this.trick.some(t => t.seat === seat); }

    trickComplete() { return this.active().every(q => this.played(q.seat)); }

    doPlay(p, card) {
      if (this.phase !== 'play' || this.turn !== p.seat) fail('Je bent niet aan de beurt.');
      if (!p.hand.includes(card)) fail('Die kaart heb je niet.');
      if (!this.legalCards(p).includes(card)) fail(`Je moet ${SUIT_NAMES[suitOf(this.trick[0].card)]} bekennen.`);
      if (this.trick.length && suitOf(card) !== suitOf(this.trick[0].card)) {
        const lead = suitOf(this.trick[0].card);
        if (!this.voids[p.seat].includes(lead)) this.voids[p.seat].push(lead);
      }
      p.hand.splice(p.hand.indexOf(card), 1);
      this.trick.push({ seat: p.seat, card });
      this.roundPlayed.push(card);
      if (this.trickComplete()) {
        this.resolveTrick();
      } else {
        this.turn = this.nextSeat(this.turn, q => !q.dead && !q.folded && !this.played(q.seat));
      }
    }

    trickWinnerSeat() {
      // Kaarten van spelers die tijdens de slag gepast hebben tellen niet mee.
      const folded = new Set(this.seated().filter(q => q.folded).map(q => q.seat));
      return winnerOf(this.trickPairs(), folded);
    }

    resolveTrick() {
      this.trickWinner = this.trickWinnerSeat();
      // Bewaren om terug te kijken, zoals je in de kroeg de opgegooide kaarten ziet liggen.
      this.tricks.push({ no: this.trickNo, cards: [...this.trick], winner: this.trickWinner });
      this.phase = 'trickEnd';
      const last = this.trickNo >= this.tricksTotal;
      this.after(last ? LAST_TRICK_PAUSE : TRICK_PAUSE, () => this.finishTrick());
    }

    finishTrick() {
      const w = this.trickWinner;
      if (this.trickNo >= this.tricksTotal) {
        this.endRound(w, false);
      } else {
        this.trickNo++;
        this.trick = [];
        this.trickWinner = -1;
        this.turn = w;
        this.phase = 'play';
      }
    }

    // ---------- toepen ----------

    // Reden waarom p niet mag toepen vanwege 'op scherp' of de finale, anders null.
    toepBlocked(p) {
      if (this.final) return 'In de finale wordt niet getoept.';
      if (p.points >= this.edge) return `Op ${this.edge} punten mag je niet toepen.`;
      // Je kunt niet boven de 15 eindigen, dus tegen iemand op 14 heeft toepen geen zin.
      // Staat er nog iemand anders niet op 14, dan kun je wel tegen die toepen.
      const others = this.active().filter(q => q !== p);
      if (others.length && others.every(q => q.points >= this.edge)) {
        return `${others.map(q => q.name).join(' en ')} ${others.length > 1 ? 'staan' : 'staat'} op ${this.edge}: daar kun je niet tegen toepen.`;
      }
      return null;
    }

    canToep(p) {
      return this.phase === 'play' && this.turn === p.seat && !p.folded && this.lastToeper !== p.seat
        && this.active().length >= 2 && !this.toepBlocked(p);
    }

    doToep(p, amount) {
      if (this.phase !== 'play' || this.turn !== p.seat) fail('Je kunt alleen toepen als je aan de beurt bent.');
      const blocked = this.toepBlocked(p);
      if (blocked) fail(blocked);
      if (this.lastToeper === p.seat) fail('Je toepte als laatste. Eerst moet iemand anders toepen.');
      if (this.active().length < 2) fail('Er is niemand meer om tegen te toepen.');
      if (amount === 2) {
        if (!this.rules.double) fail('Dubbel toepen staat uit.');
        if (p.doubleUsed) fail('Je hebt deze ronde al dubbel getoept.');
        p.doubleUsed = true;
      }
      const prev = this.stake;
      this.stake += amount;
      this.lastToeper = p.seat;
      p.toeped = true;
      p.stats.toeps++;
      const others = this.orderFrom(p.seat).filter(s => s !== p.seat && !this.seats[s].dead && !this.seats[s].folded);
      this.toep = {
        by: p.seat, amount, prev, responses: {},
        pending: others.filter(s => this.seats[s].points < this.edge),
      };
      this.phase = 'toep';
      this.log(`${p.name} ${amount === 2 ? 'toept dubbel' : 'toept'}! Inzet ${prev} → ${this.stake}`, 'toep', { seat: p.seat, amount });
      // Wie op 14 staat, gaat automatisch mee (en eindigt hooguit op 15).
      for (const s of others.filter(s => this.seats[s].points >= this.edge)) {
        this.toep.responses[s] = true;
        this.log(`${this.seats[s].name} staat op ${this.edge} en gaat automatisch mee`, 'quiet');
      }
    }

    doToepResponse(p, go) {
      const t = this.toep;
      if (this.phase !== 'toep' || !t.pending.includes(p.seat)) fail('Er is geen toep om op te reageren.');
      if (t.pending[0] !== p.seat) fail(`Eerst kiest ${this.seats[t.pending[0]].name}.`);
      t.pending.splice(t.pending.indexOf(p.seat), 1);
      t.responses[p.seat] = go;
      p.stats.faced = (p.stats.faced || 0) + 1;
      if (!go) p.stats.toepFolds = (p.stats.toepFolds || 0) + 1;
      if (go) {
        this.log(`${p.name} gaat mee`, 'quiet');
      } else {
        p.folded = true;
        p.foldPenalty = t.prev + p.extra;
        p.stats.folds++;
        this.log(`${p.name} past (${pointsText(p.foldPenalty)})`, 'fold');
      }
      if (!t.pending.length) {
        this.toep = null;
        const act = this.active();
        if (act.length === 1) return this.endRound(act[0].seat, true);
        this.phase = 'play';
      }
    }

    // ---------- einde ----------

    endRound(w, byFold) {
      this.cancelAfter();
      const winner = this.seats[w];
      winner.stats.rounds++;
      if (winner.toeped) winner.stats.toepWins++;
      if (this.finaleMode) {
        // Geen strafpunten: wie de laatste slag wint, wint het potje.
        this.result = { winner: w, final: true, lines: [] };
        return this.endGame(w);
      }
      const lastTrick = byFold ? null : this.trick.find(t => t.seat === w);
      const boer = !!this.rules.boer && !!lastTrick && rankOf(lastTrick.card) === 'J';
      const lines = [];
      for (const p of this.alive()) {
        if (p.seat === w) continue;
        let pen, note;
        if (p.folded) {
          pen = p.foldPenalty;
          note = 'weg';
        } else {
          pen = this.stake + p.extra;
          note = '';
          if (boer) { pen++; note = 'boerenslag'; }
        }
        pen = Math.min(pen, this.settings.maxPoints - p.points); // nooit boven de 15
        p.points += pen;
        lines.push({ seat: p.seat, pen, note });
      }
      // Grootste pot: alle strafpunten die de anderen deze ronde kregen.
      winner.stats.bigPot = Math.max(winner.stats.bigPot, lines.reduce((sum, l) => sum + l.pen, 0));
      const comeback = !!this.rules.comeback && winner.points === this.edge;
      if (comeback) winner.points--;
      lines.push({ seat: w, pen: comeback ? -1 : 0, note: comeback ? 'comeback' : 'winnaar' });
      this.result = {
        winner: w, stake: this.stake, byFold, boer, comeback, final: this.final,
        blind: this.blind ? this.blind.amount : 0, lines,
      };
      const what = this.final ? 'de finale' : `ronde ${this.round}`;
      this.log(`${winner.name} wint ${what}${byFold ? ' (de rest ging weg)' : ''}`, 'round');
      const firstDeath = !this.anyDied;
      const died = this.checkDeaths();
      // De volgende ronde begint de speler links van de winnaar.
      this.leader = this.nextSeat(w, q => !q.dead);
      this.buyIn = firstDeath ? this.buyInOffer(died) : null;
      if (this.buyIn) {
        const p = this.seats[this.buyIn.seat];
        this.log(`${p.name} mag zich inkopen op ${pointsText(this.buyIn.points)}`, 'quiet');
        this.phase = 'roundEnd';
        this.nextRoundAt = Date.now() + BUY_IN_PAUSE * 1000 * this.delay;
        this.after(BUY_IN_PAUSE, () => this.doBuyIn(p, false));
        return;
      }
      this.continueAfterRound();
    }

    continueAfterRound() {
      if (this.alive().length <= 1) return this.endGame();
      this.phase = 'roundEnd';
      this.nextRoundAt = Date.now() + ROUND_PAUSE * 1000 * this.delay;
      this.after(ROUND_PAUSE, () => this.startRound());
    }

    // Inkopen: wie als eerste af is, mag direct terugkomen op de stand van de
    // hoogste speler. Niet als er nog iemand anders op het randje staat, en niet
    // als er tegelijk meerdere spelers af gingen. Bots kopen zich niet in.
    buyInOffer(died) {
      if (this.finaleMode || died.length !== 1 || died[0].bot) return null;
      const alive = this.alive();
      if (!alive.length || alive.some(q => q.points === this.edge)) return null;
      return { seat: died[0].seat, points: Math.max(...alive.map(q => q.points)) };
    }

    doBuyIn(p, yes) {
      const b = this.buyIn;
      if (this.phase !== 'roundEnd' || !b || b.seat !== p.seat) fail('Inkopen kan nu niet.');
      this.cancelAfter();
      this.buyIn = null;
      if (yes) {
        p.dead = false;
        p.points = b.points;
        this.buyIns++;
        this.log(`${p.name} koopt zich in en staat op ${pointsText(b.points)}`, 'round');
        if (this.result) this.leader = this.nextSeat(this.result.winner, q => !q.dead);
      }
      this.continueAfterRound();
    }

    checkDeaths() {
      const died = [];
      for (const p of this.alive()) {
        if (p.points >= this.settings.maxPoints) {
          p.dead = true;
          this.anyDied = true;
          died.push(p);
          p.hand = [];
          this.log(`${p.name} is af!`, 'dead');
        }
      }
      return died;
    }

    endGame(winnerSeat) {
      this.cancelAfter();
      this.phase = 'gameEnd';
      if (winnerSeat === undefined) {
        const alive = this.alive();
        winnerSeat = alive.length ? alive[0].seat : -1;
      }
      this.winner = winnerSeat;
      this.gamesPlayed++;
      if (winnerSeat >= 0) {
        const winner = this.seats[winnerSeat];
        winner.wins++;
        this.log(`${winner.name} wint het spel!`, 'game');
      }
    }

    // ---------- bots ----------

    needsAction(p) {
      if (!p || p.dead) return false;
      switch (this.phase) {
        case 'blind': return p.blindDecision === null;
        case 'blindResp': return this.blind.pending[0] === p.seat; // om de beurt, met de klok mee
        case 'scherp': return this.scherp.pending.includes(p.seat);
        case 'wash': return p.washDecision === null;
        case 'washCheck': return this.washCheck.pending.includes(p.seat);
        case 'pass': return p.passCard === null;
        case 'toep': return this.toep.pending[0] === p.seat; // om de beurt, met de klok mee
        case 'play': return this.turn === p.seat;
        default: return false;
      }
    }

    scheduleBots() {
      if (this.botPending) return;
      if (!this.seated().some(p => p.bot && this.needsAction(p))) return;
      this.botPending = true;
      setTimeout(() => {
        this.botPending = false;
        const bot = this.seated().find(p => p.bot && this.needsAction(p));
        if (bot) {
          try {
            this.botAct(bot);
          } catch (e) {
            if (!(e instanceof GameError)) throw e;
            console.warn('Bot-fout:', e.message);
          }
        }
        this.changed();
      }, (700 + Math.random() * 700) * this.delay);
    }

    // Makkelijk: speelt willekeurig. Gemiddeld: vuistregels op basis van de eigen hand.
    // Moeilijk: rekent kansen uit door de ronde vaak uit te spelen met gegokte kaarten
    // van de anderen (alleen wat hij echt kan weten). God: doet hetzelfde, maar kijkt
    // stiekem in ieders kaarten.

    botStrength(p) {
      if (!p.hand.length) return 0;
      const vals = p.hand.map(valOf);
      return Math.max(...vals) + 0.7 * vals.filter(v => v >= 5).length;
    }

    botSamples(p, n) {
      const active = this.active().map(q => q.seat);
      if (p.level === 'god') {
        const real = {};
        for (const s of active) real[s] = [...this.seats[s].hand];
        return Array(n).fill(real);
      }
      const unseen = FULL_DECK.filter(c => !p.hand.includes(c) && !this.roundPlayed.includes(c));
      const others = active.filter(s => s !== p.seat).sort((a, b) => this.voids[b].length - this.voids[a].length);
      const out = [];
      for (let i = 0; i < n; i++) {
        for (let attempt = 0; attempt < 12; attempt++) {
          const pool = shuffle([...unseen]);
          const hands = { [p.seat]: [...p.hand] };
          let ok = true;
          for (const s of others) {
            const need = this.seats[s].hand.length;
            const voids = attempt < 11 ? this.voids[s] : [];
            const pick = pool.filter(c => !voids.includes(suitOf(c))).slice(0, need);
            if (pick.length < need) { ok = false; break; }
            for (const c of pick) pool.splice(pool.indexOf(c), 1);
            hands[s] = pick;
          }
          if (ok) { out.push(hands); break; }
        }
      }
      return out;
    }

    simState() {
      const active = new Set(this.active().map(q => q.seat));
      const folded = new Set(this.seated().filter(q => q.folded || q.dead).map(q => q.seat));
      let turn = this.phase === 'play' || this.phase === 'toep' ? this.turn : this.leader;
      if (!active.has(turn)) turn = this.nextSeat(turn, q => active.has(q.seat));
      return { active, folded, turn, trick: this.trickPairs() };
    }

    // Kans dat p de ronde wint als iedereen die nu nog meedoet blijft zitten.
    botWinChance(p, n) {
      const { active, folded, turn, trick } = this.simState();
      if (!active.has(p.seat)) return 0;
      if (active.size === 1) return 1;
      const samples = this.botSamples(p, n);
      let wins = 0;
      for (const h of samples) {
        if (rollout(h, trick, turn, active, folded, this.trickNo, this.tricksTotal) === p.seat) wins++;
      }
      return wins / Math.max(1, samples.length);
    }

    botBestCard(p, n) {
      const { active, folded, trick } = this.simState();
      const legal = this.legalCards(p);
      const samples = this.botSamples(p, n);
      const score = {};
      for (const c of legal) {
        score[c] = 0;
        for (const h of samples) {
          if (rollout(h, trick, p.seat, active, folded, this.trickNo, this.tricksTotal, c) === p.seat) score[c]++;
        }
      }
      // Kaarten die binnen de meetruis even goed scoren, gelden als even goed. Speel dan
      // de laagste: hoge kaarten bewaar je voor de laatste slag, de enige die telt.
      const ns = Math.max(1, samples.length);
      const top = Math.max(...legal.map(c => score[c]));
      const q = top / ns;
      const margin = Math.max(1, 1.5 * Math.sqrt(ns * q * (1 - q)));
      const near = legal.filter(c => score[c] >= top - margin);
      const best = near.reduce((lo, c) => (valOf(c) < valOf(lo) ? c : lo));
      return [best, score[best] / ns];
    }

    // Strategie van de slimme bots (Moeilijk en God). De getallen zijn met
    // simulaties afgesteld; p.strat kan ze in een simulatie overschrijven.
    strat(p) { return p.strat || BOT_STRATEGY[p.level] || BOT_STRATEGY.moeilijk; }

    botSampleCount(p) { return this.strat(p).samples; }

    // Meegaan (verlies kost `next`) of weggaan (kost zeker `prev`)?
    botGo(p, prev, next) {
      const mx = this.settings.maxPoints;
      if (p.points + prev >= mx) return true; // weggaan is ook af
      if (p.level === 'makkelijk') return Math.random() < 0.55;
      if (p.level === 'gemiddeld') {
        const s = this.botStrength(p);
        if (p.points + next >= mx) return s >= 7.5;
        return s >= 6 + (next - 2) * 0.5 || Math.random() < 0.15;
      }
      const S = this.strat(p);
      let w = this.botWinChance(p, this.botSampleCount(p));
      // Wie toept heeft vaak een goede hand (maar kan ook bluffen): iets voorzichtiger.
      if (this.phase === 'toep' && p.level !== 'god') w *= 1 - this.readFactor(p, this.seats[this.toep.by]);
      let need = 1 - prev / next;
      if (p.points + next >= mx) need = Math.max(need, S.deathCaution);
      need += (Math.random() - 0.5) * S.noise;
      return w > need;
    }

    // Hoe voorzichtig je wordt van een toep van q. Een adaptieve bot kijkt hoe vaak q
    // zijn toeps echt wint: eerlijke toepers neem je serieus, bluffers minder.
    readFactor(p, q) {
      const S = this.strat(p);
      if (!S.adapt || !q || !q.stats) return S.read;
      const honest = (q.stats.toepWins + 1.3) / (q.stats.toeps + 2); // begint rond 65%
      return Math.min(0.45, Math.max(0, (honest - 0.4) * 1.2));
    }

    // Hoe vaak je blufft. Een adaptieve bot blufft meer als de anderen snel passen.
    bluffRate(p) {
      const S = this.strat(p);
      if (!S.adapt) return S.bluff;
      const others = this.active().filter(q => q !== p && q.stats);
      if (!others.length) return 0;
      const fold = others.reduce((sum, q) => sum + (q.stats.toepFolds + 0.5) / (q.stats.faced + 2), 0) / others.length;
      return Math.min(0.5, Math.max(0, (fold - 0.15) * S.bluff * 4));
    }

    // Toepen met een goede hand, of bluffen met een slechte.
    botWantsToep(p, w) {
      const S = this.strat(p);
      if (w > S.toep) return true;
      if (p.level === 'god') return this.godBluffWorks(p);
      return Math.random() < this.bluffRate(p) * (1 - w);
    }

    // God ziet alle kaarten en weet dus of de anderen passen als hij toept.
    godBluffWorks(p) {
      const others = this.active().filter(q => q !== p);
      return others.length > 0 && others.every(q => {
        const prev = this.stake + q.extra, next = prev + 1;
        if (q.points + prev >= this.settings.maxPoints) return false; // die gaat toch mee
        const asThem = { ...q, level: 'moeilijk' }; // zoals zij hun eigen kansen zien
        return this.botWinChance(asThem, 40) < 1 - prev / next - 0.08;
      });
    }

    botBlindAmount(p) {
      if (p.blindsUsed >= MAX_BLINDS) return 0;
      const room = this.settings.maxPoints - p.points;
      if (p.level === 'god') {
        const w = this.botWinChance(p, 80);
        return w > 0.85 ? 4 : w > 0.72 ? 3 : w > 0.6 ? 2 : 0;
      }
      if (p.level === 'moeilijk') {
        const S = this.strat(p);
        return room > S.blindRoom && Math.random() < S.blind ? S.blindAmount : 0;
      }
      const chance = { makkelijk: 0.06, gemiddeld: 0.03 }[p.level];
      if (room > 6 && Math.random() < chance) return p.level === 'makkelijk' ? choice(BLIND_AMOUNTS) : 2;
      return 0;
    }

    botBlindResp(p) {
      const n = this.blind.amount;
      if (p.blindResp === 'seen') return this.botGo(p, SEEN_FOLD, n + 1) ? 'mee' : 'weg';
      const mx = this.settings.maxPoints;
      if (p.points + BLIND_FOLD >= mx) return 'blind'; // weg is toch af
      if (p.level === 'god') {
        const w = this.botWinChance(p, 80);
        return w > 0.2 ? 'blind' : w > 1 - SEEN_FOLD / (n + 1) - 0.05 ? 'seen' : 'weg';
      }
      if (p.level === 'makkelijk') return choice(['blind', 'seen', 'weg']);
      // Zonder te kijken is je kans ongeveer 1 op het aantal spelers: bij een hoog
      // bedrag tegen veel spelers is meteen weg (1 punt) vaak het goedkoopst.
      const cheapFold = n >= 3 && this.active().length >= 3;
      if (p.points + SEEN_FOLD >= mx) return cheapFold ? 'weg' : 'blind';
      if (p.level === 'gemiddeld') return Math.random() < 0.3 ? 'blind' : cheapFold && Math.random() < 0.4 ? 'weg' : 'seen';
      return cheapFold && n >= 4 ? 'weg' : 'seen';
    }

    botAct(p) {
      const lvl = p.level;
      switch (this.phase) {
        case 'blind': {
          const amount = Math.min(this.botBlindAmount(p), this.blindMax(p));
          return this.doBlind(p, amount >= 2 ? amount : 0);
        }
        case 'blindResp': return this.doBlindResp(p, this.botBlindResp(p));
        case 'scherp': return this.doScherp(p, this.botGo(p, 1, 2));
        case 'wash': return this.doWash(p, isWas(p.hand) && lvl !== 'makkelijk');
        case 'washCheck': {
          const claimer = this.seats[this.washCheck.seat];
          return this.doWashResponse(p, lvl === 'god' ? !isWas(claimer.hand) : Math.random() < 0.15);
        }
        case 'pass': return this.doPass(p, lvl === 'makkelijk' ? choice(p.hand) : minBy(p.hand, valOf));
        case 'toep': {
          const prev = this.toep.prev + p.extra;
          return this.doToepResponse(p, this.botGo(p, prev, prev + this.toep.amount));
        }
        case 'play': break;
        default: return undefined;
      }
      const doubleOk = !!this.rules.double && !p.doubleUsed;
      if (lvl === 'makkelijk') {
        if (this.canToep(p) && this.stake < 5 && Math.random() < 0.04) return this.doToep(p, 1);
        return this.doPlay(p, choice(this.legalCards(p)));
      }
      if (lvl === 'gemiddeld') {
        if (this.canToep(p) && this.stake < 5) {
          const s = this.botStrength(p);
          if ((s >= 7.5 && this.trickNo >= 2 && Math.random() < 0.45) || Math.random() < 0.05) {
            return this.doToep(p, doubleOk && s >= 8.5 ? 2 : 1);
          }
        }
        // Laagste kaart spelen, de hoge bewaren voor de laatste slag.
        return this.doPlay(p, minBy(this.legalCards(p), valOf));
      }
      const [card, w] = this.botBestCard(p, this.botSampleCount(p));
      if (this.canToep(p) && this.stake < 6 && this.botWantsToep(p, w)) {
        return this.doToep(p, doubleOk && w > this.strat(p).double ? 2 : 1);
      }
      return this.doPlay(p, card);
    }

    // ---------- weergave ----------

    playerView(p) {
      if (!p) return null;
      return {
        seat: p.seat, name: p.name, bot: p.bot, level: p.bot ? p.level : null,
        points: p.points, wins: p.wins, stats: p.stats, look: p.look, dead: p.dead, folded: p.folded, cards: p.hand.length, extra: p.extra,
        online: p.bot || this.isConnected(p.id), acting: this.needsAction(p),
      };
    }

    view(pid, extra) {
      const me = this.byPid(pid);
      const ph = this.phase;
      const v = {
        phase: ph, round: this.round, stake: this.stake, trickNo: this.trickNo,
        tricksTotal: this.tricksTotal, final: this.final, edge: this.edge,
        turn: this.turn, leader: this.leader, lastToeper: this.lastToeper,
        settings: this.settings, me: me ? me.seat : null, maxBlinds: MAX_BLINDS, gamesPlayed: this.gamesPlayed,
        isHost: !!me && (!this.hostPid || me.id === this.hostPid),
        players: this.seats.map(p => this.playerView(p)),
        trick: this.trick, trickWinner: this.trickWinner,
        tricks: this.tricks || [], prevTricks: this.prevTricks || [],
        buyIn: this.buyIn || null, buyIns: this.buyIns || 0,
        toep: this.toep, blind: this.blind, scherp: this.scherp,
        washCheck: this.washCheck ? { seat: this.washCheck.seat, pending: this.washCheck.pending } : null,
        result: this.result,
        nextRoundIn: ph === 'roundEnd' ? Math.max(0, this.nextRoundAt - Date.now()) : 0,
        blindIn: ph === 'blind' ? Math.max(0, (this.blindDeadline || 0) - Date.now()) : 0,
        winner: this.winner, log: this.logs.slice(-20), reactions: this.reactions,
      };
      if (me) {
        // Bij blind kijkt niemand: de kaarten blijven dicht tot je 'gezien' kiest.
        const hidden = ph === 'blind' || (ph === 'blindResp' && !['seen', 'mee', 'weg'].includes(me.blindResp));
        const canToep = this.canToep(me);
        const passSeat = ph === 'pass' && !me.dead ? this.nextSeat(me.seat, q => !q.dead) : -1;
        Object.assign(v, {
          hand: hidden ? [] : [...me.hand], handHidden: hidden, handCount: me.hand.length,
          legal: this.legalCards(me), canToep,
          toepBlocked: ph === 'play' && this.turn === me.seat ? this.toepBlocked(me) : null,
          canDouble: canToep && !!this.rules.double && !me.doubleUsed,
          myExtra: me.extra, blindsLeft: MAX_BLINDS - me.blindsUsed,
          myExpert: !!me.expert, advice: this.adviceFor(me),
          blindDecision: me.blindDecision, blindResp: me.blindResp, blindMax: this.blindMax(me),
          washDecision: me.washDecision, passCard: me.passCard, received: me.received,
          isWas: ph === 'wash' && isWas(me.hand),
          passTarget: passSeat >= 0 ? this.seats[passSeat].name : null,
        });
      }
      return extra ? Object.assign(v, extra) : v;
    }
  }

  root.Toepen = { Table, GameError, LEVELS, MAX_BLINDS, THEMES, REACTIONS, BOT_STRATEGY };
})(typeof window !== 'undefined' ? window : globalThis);
