// Abogados Mudos — servidor de juego (Node + Express + Socket.IO)
const express = require('express'), http = require('http'), { Server } = require('socket.io');
const app = express(), srv = http.createServer(app), io = new Server(srv);
app.use(express.static(__dirname + '/public'));
app.get('/host', (q, r) => r.sendFile(__dirname + '/public/host.html'));

const TIME = 15, ROUNDS = 13, ROLES = ['principal', 'investigador', 'perito', 'procurador', 'escribano'];
const PH = r => (r <= 4 ? 1 : r <= 10 ? 2 : 3);           // multiplicador B por fase
const opp = t => (t === 'A' ? 'B' : 'A');
// Objeciones: rol, coste de Evidencia, cooldown (rondas)
const OBJ = {
  protesto:  { role: 'principal',    cost: 3, cd: 4 },
  pista:     { role: 'investigador', cost: 1, cd: 2 },
  dictamen:  { role: 'perito',       cost: 2, cd: 3 },
  apelacion: { role: 'procurador',   cost: 3, cd: 5 },
  tinta:     { role: 'escribano',    cost: 2, cd: 3 },
};
// [categoría, pregunta, opciones, índice correcto]
const Q = [
  ['cultura', '¿Capital de Australia?', ['Sídney', 'Canberra', 'Melbourne', 'Perth'], 1],
  ['ciencia', '¿Cuál es el planeta más grande del sistema solar?', ['Saturno', 'Júpiter', 'Neptuno', 'Tierra'], 1],
  ['cultura', '¿Quién pintó La Gioconda?', ['Miguel Ángel', 'Rafael', 'Leonardo da Vinci', 'Botticelli'], 2],
  ['ciencia', '¿Símbolo químico del oro?', ['Ag', 'Au', 'Go', 'Or'], 1],
  ['derecho', '¿Quién dicta la sentencia en un juicio?', ['El fiscal', 'El juez', 'El escribano', 'El testigo'], 1],
  ['cultura', '¿En qué país está la Torre Eiffel?', ['Italia', 'España', 'Francia', 'Bélgica'], 2],
  ['ciencia', '¿Cuál es el hueso más largo del cuerpo?', ['Húmero', 'Fémur', 'Tibia', 'Radio'], 1],
  ['derecho', '¿Cómo se llama el principio "nadie es culpable hasta que se pruebe"?', ['Cosa juzgada', 'Presunción de inocencia', 'Habeas corpus', 'Dolo'], 1],
  ['ciencia', '¿A cuántos °C hierve el agua a nivel del mar?', ['90', '100', '110', '120'], 1],
  ['cultura', '¿Quién escribió "Cien años de soledad"?', ['Borges', 'García Márquez', 'Cortázar', 'Neruda'], 1],
  ['ciencia', '¿Qué gas es el más abundante en el aire?', ['Oxígeno', 'Nitrógeno', 'CO2', 'Helio'], 1],
  ['cultura', '¿Quién escribió "El Capital"?', ['Karl Marx', 'Hegel', 'Adam Smith', 'Keynes'], 0],
  ['derecho', '¿Cómo se llama la persona acusada en un juicio penal?', ['Demandante', 'Imputado', 'Perito', 'Procurador'], 1],
];
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const rooms = {};
const pub = p => ({ id: p.id, name: p.name, team: p.team, role: p.role, ev: p.ev, streak: p.streak, cd: p.cd });
const sync = r => io.to(r.host).emit('state', { code: r.code, round: r.round, years: r.years, players: Object.values(r.players).map(pub) });

function startRound(r) {
  r.round++; r.q = r.qs[(r.round - 1) % r.qs.length]; r.t0 = Date.now(); r.open = true; r.x2 = { A: false, B: false };
  Object.values(r.players).forEach(p => { p.ans = null; p.tl = 0; p.forced = false; });
  const d = { round: r.round, rounds: ROUNDS, B: PH(r.round), cat: r.q[0], text: r.q[1], opts: r.q[2], time: TIME };
  io.to(r.host).emit('question', d);
  Object.values(r.players).forEach(p => io.to(p.id).emit('question', d));
  clearTimeout(r.timer); r.timer = setTimeout(() => resolve(r), TIME * 1000 + 500);
  sync(r);
}

function resolve(r) {
  if (!r.open) return; r.open = false; clearTimeout(r.timer);
  const B = PH(r.round), q = r.q, dmg = { A: 0, B: 0 }, all = { A: [], B: [] }, det = {};
  const P = Object.values(r.players);
  P.forEach(p => {
    const ok = p.ans === q[3]; let g = 0; all[p.team].push(ok);
    if (ok) {
      p.streak++; if (p.forced) p.streak = Math.max(p.streak, 5);
      const Ft = 0.5 + p.tl / TIME, Fr = 1 + 0.1 * Math.min(p.streak, 5);
      let M = 1;
      if (p.role === 'principal' && p.streak >= 3) M = 1.25;
      if (p.role === 'perito') M = q[0] === 'ciencia' ? 1.4 : 0.9;
      if (p.role === 'procurador' || p.role === 'escribano') M = 0.9;
      g = Math.min(12, Math.ceil(B * Ft * Fr * M * (r.x2[p.team] ? 2 : 1)));   // FÓRMULA DEL GDD
      p.ev = Math.min(5, p.ev + 1 + (p.streak >= 3 ? 1 : 0) + (p.role === 'investigador' && p.tl >= 10 ? 1 : 0));
      dmg[opp(p.team)] += g;
    } else { p.streak = 0; if (p.ans !== null) dmg[p.team] += 1; }            // falso testimonio
    det[p.id] = { ok, g };
  });
  ['A', 'B'].forEach(t => {
    if (all[t].length > 1 && all[t].every(Boolean)) dmg[opp(t)] += 3;           // Cosa Juzgada
  });
  ['A', 'B'].forEach(t => {                                                     // pasiva del Procurador
    if (dmg[t] >= 4 && P.some(p => p.team === t && p.role === 'procurador')) dmg[t]--;
    r.years[t] = Math.min(100, r.years[t] + dmg[t]);
  });
  io.to(r.host).emit('result', { correct: q[3], dmg, years: r.years, det });
  P.forEach(p => io.to(p.id).emit('result', { correct: q[3], ...det[p.id], me: pub(p), years: r.years, dmg }));
  sync(r);
  r.timer = setTimeout(() => {
    const over = r.years.A >= 100 || r.years.B >= 100 || r.round >= ROUNDS;
    if (!over) return startRound(r);
    const w = r.years.A === r.years.B ? 'EMPATE' : r.years.A < r.years.B ? 'A' : 'B';
    const e = { winner: w, years: r.years, perpetua: r.years.A >= 100 || r.years.B >= 100 };
    io.to(r.host).emit('end', e); P.forEach(p => io.to(p.id).emit('end', e));
  }, 7000);
}

io.on('connection', s => {
  s.on('create', () => {
    let c; do { c = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random() * 24 | 0]).join(''); } while (rooms[c]);
    rooms[c] = { code: c, host: s.id, players: {}, years: { A: 0, B: 0 }, round: 0, qs: shuffle(Q), open: false };
    s.rc = c; s.join(c); s.emit('code', c); sync(rooms[c]);
  });
  s.on('join', ({ code, name }) => {
    const r = rooms[code]; if (!r) return s.emit('err', 'Sala no encontrada');
    if (r.round > 0) return s.emit('err', 'La audiencia ya comenzó');
    const P = Object.values(r.players); if (P.length >= 10) return s.emit('err', 'Sala llena');
    const nA = P.filter(p => p.team === 'A').length, nB = P.length - nA, team = nA <= nB ? 'A' : 'B';
    const role = ROLES[(team === 'A' ? nA : nB) % 5];
    const p = r.players[s.id] = { id: s.id, name: String(name).slice(0, 14), team, role, ev: 0, streak: 0, cd: 0, ans: null, tl: 0 };
    s.rc = code; s.join(code); s.emit('me', pub(p)); sync(r);
  });
  s.on('start', () => { const r = rooms[s.rc]; if (r && r.host === s.id && r.round === 0 && Object.keys(r.players).length) startRound(r); });
  s.on('answer', i => {
    const r = rooms[s.rc], p = r && r.players[s.id]; if (!p || !r.open || p.ans !== null) return;
    p.ans = i; p.tl = Math.max(0, TIME - (Date.now() - r.t0) / 1000);
    s.emit('locked'); io.to(r.host).emit('answered', p.id);
    if (Object.values(r.players).every(x => x.ans !== null)) resolve(r);
  });
  s.on('obj', k => {
    const r = rooms[s.rc], p = r && r.players[s.id], o = OBJ[k];
    if (!p || !o || !r.open || p.role !== o.role || r.round < 3 || p.ev < o.cost || r.round < p.cd) return;
    p.ev -= o.cost; p.cd = r.round + o.cd;
    if (k === 'protesto') r.x2[p.team] = true;
    if (k === 'pista') { const w = [0, 1, 2, 3].filter(i => i !== r.q[3]); s.emit('hide', w[Math.random() * 3 | 0]); }
    if (k === 'dictamen') p.forced = true;
    if (k === 'apelacion') r.years[p.team] = Math.max(0, r.years[p.team] - 8);
    if (k === 'tinta') Object.values(r.players).filter(x => x.team !== p.team).forEach(x => io.to(x.id).emit('ink', 4000));
    io.to(r.host).emit('fx', { k, name: p.name, team: p.team }); s.emit('me', pub(p)); sync(r);
  });
  s.on('disconnect', () => {
    const r = rooms[s.rc]; if (!r) return;
    if (r.host === s.id) { clearTimeout(r.timer); delete rooms[s.rc]; return; }
    if (r.round === 0) { delete r.players[s.id]; sync(r); }
  });
});
srv.listen(process.env.PORT || 3000, () => console.log('Tribunal abierto en http://localhost:3000/host'));
