const { createServer } = require("http");
const { parse } = require("url");
const next = require("next");
const { Server } = require("socket.io");
const { getRandomWords } = require("./words");

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();

// ─── Game State ──────────────────────────────────────────────
const rooms = new Map();

function createRoom(roomId, hostId, hostName, hostAvatar) {
  return {
    id: roomId,
    players: [
      {
        id: hostId,
        name: hostName,
        avatar: hostAvatar,
        score: 0,
        isHost: true,
        hasGuessed: false,
      },
    ],
    state: "waiting", // waiting | picking | drawing | roundEnd | gameEnd
    currentDrawerIndex: 0,
    currentWord: null,
    wordChoices: [],
    round: 0,
    maxRounds: 3,
    drawTime: 80,
    timer: null,
    timeLeft: 0,
    hints: [],
    hintTimer: null,
    turnOrder: [],
    drawingData: [],
    correctGuessers: 0,
  };
}

function generateRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 6; i++)
    id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function getHintString(word, revealedIndices) {
  return word
    .split("")
    .map((ch, i) => {
      if (ch === " ") return "  ";
      if (revealedIndices.includes(i)) return ch;
      return "_";
    })
    .join(" ");
}

function calculatePoints(timeLeft, drawTime) {
  const ratio = timeLeft / drawTime;
  return Math.round(100 + 400 * ratio);
}

// ─── Server Setup ────────────────────────────────────────────
app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  });

  const io = new Server(server, {
    cors: { origin: "*" },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  // ─── Socket Events ──────────────────────────────────────────
  io.on("connection", (socket) => {
    console.log(`Player connected: ${socket.id}`);

    // CREATE ROOM
    socket.on("createRoom", ({ playerName, avatar }, callback) => {
      const roomId = generateRoomId();
      const room = createRoom(roomId, socket.id, playerName, avatar);
      rooms.set(roomId, room);
      socket.join(roomId);
      socket.roomId = roomId;
      callback({ success: true, roomId, players: room.players });
      console.log(`Room ${roomId} created by ${playerName}`);
    });

    // JOIN ROOM
    socket.on("joinRoom", ({ roomId, playerName, avatar }, callback) => {
      const room = rooms.get(roomId);
      if (!room) return callback({ success: false, error: "Room not found" });
      if (room.state !== "waiting")
        return callback({ success: false, error: "Game already in progress" });
      if (room.players.length >= 12)
        return callback({ success: false, error: "Room is full" });
      if (room.players.some((p) => p.name === playerName))
        return callback({ success: false, error: "Name already taken" });

      const player = {
        id: socket.id,
        name: playerName,
        avatar,
        score: 0,
        isHost: false,
        hasGuessed: false,
      };
      room.players.push(player);
      socket.join(roomId);
      socket.roomId = roomId;

      io.to(roomId).emit("playerJoined", { players: room.players });
      callback({ success: true, roomId, players: room.players });
      console.log(`${playerName} joined room ${roomId}`);
    });

    // START GAME
    socket.on("startGame", () => {
      const room = rooms.get(socket.roomId);
      if (!room) return;
      const player = room.players.find((p) => p.id === socket.id);
      if (!player || !player.isHost) return;
      if (room.players.length < 2) return;

      room.round = 1;
      room.currentDrawerIndex = 0;
      room.turnOrder = room.players.map((p) => p.id);
      room.players.forEach((p) => (p.score = 0));

      io.to(room.id).emit("gameStarted", {
        round: room.round,
        maxRounds: room.maxRounds,
      });

      startTurn(io, room);
    });

    // WORD CHOSEN
    socket.on("wordChosen", ({ word }) => {
      const room = rooms.get(socket.roomId);
      if (!room || room.state !== "picking") return;

      const drawer = room.players[room.currentDrawerIndex];
      if (drawer.id !== socket.id) return;

      room.currentWord = word;
      room.state = "drawing";
      room.drawingData = [];
      room.correctGuessers = 0;
      room.players.forEach((p) => (p.hasGuessed = false));

      const hintStr = getHintString(word, []);
      room.hints = [];

      io.to(room.id).emit("drawingStarted", {
        drawerId: drawer.id,
        drawerName: drawer.name,
        hint: hintStr,
        wordLength: word.length,
        drawTime: room.drawTime,
      });

      startDrawTimer(io, room);
    });

    // DRAW EVENT
    socket.on("draw", (data) => {
      const room = rooms.get(socket.roomId);
      if (!room || room.state !== "drawing") return;
      room.drawingData.push(data);
      socket.to(socket.roomId).emit("draw", data);
    });

    // CLEAR CANVAS
    socket.on("clearCanvas", () => {
      const room = rooms.get(socket.roomId);
      if (!room) return;
      room.drawingData = [];
      socket.to(socket.roomId).emit("clearCanvas");
    });

    // UNDO STROKE
    socket.on("undoStroke", () => {
      const room = rooms.get(socket.roomId);
      if (!room) return;
      // Remove the last complete stroke from drawingData
      let lastStrokeStart = room.drawingData.length - 1;
      while (
        lastStrokeStart >= 0 &&
        room.drawingData[lastStrokeStart].type !== "start"
      ) {
        lastStrokeStart--;
      }
      if (lastStrokeStart >= 0) {
        room.drawingData = room.drawingData.slice(0, lastStrokeStart);
      }
      io.to(socket.roomId).emit("redrawCanvas", room.drawingData);
    });

    // FILL
    socket.on("fill", (data) => {
      const room = rooms.get(socket.roomId);
      if (!room) return;
      room.drawingData.push({ ...data, type: "fill" });
      socket.to(socket.roomId).emit("fill", data);
    });

    // CHAT / GUESS
    socket.on("chatMessage", ({ message }) => {
      const room = rooms.get(socket.roomId);
      if (!room) return;

      const player = room.players.find((p) => p.id === socket.id);
      if (!player) return;

      // If the player is the drawer, just send as chat (no guessing)
      const drawer = room.players[room.currentDrawerIndex];
      if (drawer && drawer.id === socket.id) {
        io.to(room.id).emit("chatMessage", {
          playerName: player.name,
          message,
          type: "chat",
        });
        return;
      }

      // If already guessed
      if (player.hasGuessed) {
        // Only show to other correct guessers
        room.players.forEach((p) => {
          if (p.hasGuessed || p.id === drawer?.id) {
            io.to(p.id).emit("chatMessage", {
              playerName: player.name,
              message,
              type: "guessed-chat",
            });
          }
        });
        return;
      }

      // Check guess
      if (
        room.state === "drawing" &&
        room.currentWord &&
        message.toLowerCase().trim() === room.currentWord.toLowerCase().trim()
      ) {
        player.hasGuessed = true;
        room.correctGuessers++;

        const points = calculatePoints(room.timeLeft, room.drawTime);
        player.score += points;
        if (drawer) drawer.score += Math.round(points * 0.25);

        io.to(room.id).emit("correctGuess", {
          playerName: player.name,
          playerId: player.id,
          players: room.players,
        });

        io.to(player.id).emit("chatMessage", {
          playerName: player.name,
          message: `You guessed it! +${points} points`,
          type: "correct",
        });

        // Check if everyone guessed
        const nonDrawerPlayers = room.players.filter(
          (p) => p.id !== drawer?.id,
        );
        if (nonDrawerPlayers.every((p) => p.hasGuessed)) {
          endTurn(io, room);
        }
      } else {
        // Close guess detection
        const isClose =
          room.currentWord &&
          isCloseGuess(
            message.toLowerCase().trim(),
            room.currentWord.toLowerCase().trim(),
          );

        io.to(room.id).emit("chatMessage", {
          playerName: player.name,
          message,
          type: isClose ? "close" : "chat",
        });
      }
    });

    // DISCONNECT
    socket.on("disconnect", () => {
      const roomId = socket.roomId;
      if (!roomId) return;

      const room = rooms.get(roomId);
      if (!room) return;

      const playerIndex = room.players.findIndex((p) => p.id === socket.id);
      if (playerIndex === -1) return;

      const wasDrawer =
        room.state === "drawing" &&
        room.players[room.currentDrawerIndex]?.id === socket.id;

      room.players.splice(playerIndex, 1);
      room.turnOrder = room.turnOrder.filter((id) => id !== socket.id);

      if (room.players.length === 0) {
        clearTimers(room);
        rooms.delete(roomId);
        console.log(`Room ${roomId} deleted (empty)`);
        return;
      }

      // Promote new host
      if (!room.players.some((p) => p.isHost)) {
        room.players[0].isHost = true;
      }

      io.to(roomId).emit("playerLeft", { players: room.players });

      if (wasDrawer && room.state === "drawing") {
        clearTimers(room);
        if (room.players.length >= 2) {
          if (room.currentDrawerIndex >= room.players.length) {
            room.currentDrawerIndex = 0;
          }
          nextTurn(io, room);
        } else {
          room.state = "waiting";
          io.to(roomId).emit("gameReset", { players: room.players });
        }
      }

      console.log(`Player disconnected from room ${roomId}`);
    });
  });

  // ─── Game Logic Helpers ────────────────────────────────────

  function startTurn(io, room) {
    room.state = "picking";
    room.wordChoices = getRandomWords(3);
    room.drawingData = [];
    room.currentWord = null;

    const drawer = room.players[room.currentDrawerIndex];
    if (!drawer) return;

    io.to(room.id).emit("newTurn", {
      drawerId: drawer.id,
      drawerName: drawer.name,
      round: room.round,
      maxRounds: room.maxRounds,
    });

    io.to(drawer.id).emit("chooseWord", {
      words: room.wordChoices,
    });

    // Auto-pick timeout (15s)
    room.timer = setTimeout(() => {
      if (room.state === "picking") {
        const word =
          room.wordChoices[Math.floor(Math.random() * room.wordChoices.length)];
        room.currentWord = word;
        room.state = "drawing";
        room.drawingData = [];
        room.correctGuessers = 0;
        room.players.forEach((p) => (p.hasGuessed = false));

        const hintStr = getHintString(word, []);
        room.hints = [];

        io.to(room.id).emit("drawingStarted", {
          drawerId: drawer.id,
          drawerName: drawer.name,
          hint: hintStr,
          wordLength: word.length,
          drawTime: room.drawTime,
        });

        startDrawTimer(io, room);
      }
    }, 15000);
  }

  function startDrawTimer(io, room) {
    room.timeLeft = room.drawTime;
    const wordLetters = room.currentWord
      .split("")
      .map((ch, i) => ({ ch, i }))
      .filter((x) => x.ch !== " ");

    // Calculate hint intervals
    const totalHints = Math.max(1, Math.floor(wordLetters.length * 0.4));
    const hintInterval = Math.floor(room.drawTime / (totalHints + 1));
    let hintsGiven = 0;
    room.hints = [];

    clearInterval(room.hintTimer);

    room.hintTimer = setInterval(() => {
      room.timeLeft--;

      // Give hints at intervals
      if (
        room.timeLeft > 0 &&
        room.timeLeft % hintInterval === 0 &&
        hintsGiven < totalHints
      ) {
        const unrevealed = wordLetters.filter((x) => !room.hints.includes(x.i));
        if (unrevealed.length > 0) {
          const reveal =
            unrevealed[Math.floor(Math.random() * unrevealed.length)];
          room.hints.push(reveal.i);
          hintsGiven++;

          const hintStr = getHintString(room.currentWord, room.hints);
          io.to(room.id).emit("hint", { hint: hintStr });
        }
      }

      io.to(room.id).emit("timerUpdate", { timeLeft: room.timeLeft });

      if (room.timeLeft <= 0) {
        endTurn(io, room);
      }
    }, 1000);
  }

  function endTurn(io, room) {
    clearTimers(room);
    room.state = "roundEnd";

    io.to(room.id).emit("turnEnd", {
      word: room.currentWord,
      players: room.players,
    });

    setTimeout(() => {
      nextTurn(io, room);
    }, 4000);
  }

  function nextTurn(io, room) {
    room.currentDrawerIndex++;

    // Check if round is over
    if (room.currentDrawerIndex >= room.players.length) {
      room.currentDrawerIndex = 0;
      room.round++;

      if (room.round > room.maxRounds) {
        // Game over
        room.state = "gameEnd";
        const sortedPlayers = [...room.players].sort(
          (a, b) => b.score - a.score,
        );
        io.to(room.id).emit("gameOver", { players: sortedPlayers });

        // Reset after 10 seconds
        setTimeout(() => {
          room.state = "waiting";
          room.round = 0;
          room.players.forEach((p) => {
            p.score = 0;
            p.hasGuessed = false;
          });
          io.to(room.id).emit("gameReset", { players: room.players });
        }, 10000);
        return;
      }

      io.to(room.id).emit("newRound", { round: room.round });
    }

    startTurn(io, room);
  }

  function clearTimers(room) {
    if (room.timer) {
      clearTimeout(room.timer);
      room.timer = null;
    }
    if (room.hintTimer) {
      clearInterval(room.hintTimer);
      room.hintTimer = null;
    }
  }

  function isCloseGuess(guess, word) {
    if (guess.length < 2 || word.length < 2) return false;
    const distance = levenshtein(guess, word);
    return distance === 1 || (word.length > 5 && distance === 2);
  }

  function levenshtein(a, b) {
    const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
      Array.from({ length: b.length + 1 }, (_, j) =>
        i === 0 ? j : j === 0 ? i : 0,
      ),
    );
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        matrix[i][j] =
          a[i - 1] === b[j - 1]
            ? matrix[i - 1][j - 1]
            : 1 +
              Math.min(
                matrix[i - 1][j],
                matrix[i][j - 1],
                matrix[i - 1][j - 1],
              );
      }
    }
    return matrix[a.length][b.length];
  }

  // ─── Start Server ────────────────────────────────────────────
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`🎨 Scribble server running on http://localhost:${PORT}`);
  });
});
