// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname)); // index.html 서빙

// ---- 단일 테이블 상태(5-max) ----
const STATE = {
  players: [], // { id, nick, stack, seat, isDealer }
  board: [],   // community cards
  deck: [],    // 내부 보관
  started: false,
};

const MAX_PLAYERS = 5;
const INITIAL_STACK = 1000;
const RANKS = "23456789TJQKA".split("");
const SUITS = "cdhs".split("");

function freshDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push(r + s);
  return d;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function publicState() {
  // 홀카드 제외하고 브로드캐스트용
  return {
    players: STATE.players.map(p => ({ nick: p.nick, seat: p.seat, stack: p.stack, isDealer: p.isDealer })),
    board: STATE.board,
    started: STATE.started,
  };
}
function seatsUsed() {
  return new Set(STATE.players.map(p => p.seat));
}

io.on("connection", (sock) => {
  // 접속 즉시 현재 상태 보내기
  sock.emit("state", publicState());

  sock.on("join", ({ nick }, cb) => {
    if (!nick || typeof nick !== "string") return cb?.({ error: "닉네임 필요" });
    if (STATE.players.length >= MAX_PLAYERS) return cb?.({ error: "자리가 가득 찼습니다" });

    // 빈 좌석 찾기
    const used = seatsUsed();
    let seat = 0;
    while (used.has(seat) && seat < MAX_PLAYERS) seat++;
    const player = {
      id: sock.id,
      nick: nick.slice(0, 16),
      seat,
      stack: INITIAL_STACK,
      isDealer: STATE.players.length === 0, // 첫 입장자가 딜러
      hole: [],
    };
    STATE.players.push(player);
    io.emit("state", publicState());
    cb?.({ ok: true, seat, stack: player.stack });
  });

  sock.on("startHand", () => {
    if (STATE.players.length < 2) return;
    STATE.board = [];
    STATE.deck = shuffle(freshDeck());
    STATE.started = true;
    // 홀카드 2장 DM
    for (const p of STATE.players) {
      p.hole = [STATE.deck.pop(), STATE.deck.pop()];
      io.to(p.id).emit("hole", p.hole);
    }
    io.emit("state", publicState());
  });

  sock.on("dealFlop", () => {
    if (!STATE.started || STATE.board.length > 0) return;
    STATE.deck.pop(); // burn
    STATE.board.push(STATE.deck.pop(), STATE.deck.pop(), STATE.deck.pop());
    io.emit("state", publicState());
  });

  sock.on("dealTurn", () => {
    if (!STATE.started || STATE.board.length !== 3) return;
    STATE.deck.pop(); // burn
    STATE.board.push(STATE.deck.pop());
    io.emit("state", publicState());
  });

  sock.on("dealRiver", () => {
    if (!STATE.started || STATE.board.length !== 4) return;
    STATE.deck.pop(); // burn
    STATE.board.push(STATE.deck.pop());
    io.emit("state", publicState());
  });

  sock.on("rotateDealer", () => {
    if (STATE.players.length === 0) return;
    // 다음 좌석 순으로 딜러 이동
    const seats = STATE.players.map(p => p.seat).sort((a,b)=>a-b);
    const cur = STATE.players.find(p=>p.isDealer);
    const nextSeat = (() => {
      if (!cur) return seats[0];
      const idx = seats.indexOf(cur.seat);
      return seats[(idx + 1) % seats.length];
    })();
    for (const p of STATE.players) p.isDealer = (p.seat === nextSeat);
    io.emit("state", publicState());
  });

  sock.on("adjustStack", ({ delta }) => {
    // 본인 스택만 ± (안전장치: -500~+500 한 번에 제한)
    if (typeof delta !== "number" || Math.abs(delta) > 500) return;
    const p = STATE.players.find(x => x.id === sock.id);
    if (!p) return;
    p.stack = Math.max(0, p.stack + Math.round(delta));
    io.emit("state", publicState());
  });

  sock.on("chat", (msg) => {
    if (typeof msg !== "string" || msg.length > 120) return;
    const p = STATE.players.find(x => x.id === sock.id);
    io.emit("chat", { from: p?.nick ?? "익명", msg });
  });

  sock.on("disconnect", () => {
    const idx = STATE.players.findIndex(p => p.id === sock.id);
    if (idx >= 0) {
      const wasDealer = STATE.players[idx].isDealer;
      STATE.players.splice(idx, 1);
      // 딜러가 나갔으면 남은 사람 중 최솟값 좌석을 딜러로
      if (wasDealer && STATE.players.length > 0) {
        const minSeat = STATE.players.map(p=>p.seat).sort((a,b)=>a-b)[0];
        for (const p of STATE.players) p.isDealer = (p.seat === minSeat);
      }
      io.emit("state", publicState());
    }
    if (STATE.players.length === 0) {
      // 방 비면 리셋
      STATE.board = [];
      STATE.deck = [];
      STATE.started = false;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("OK on " + PORT));
