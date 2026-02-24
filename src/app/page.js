"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import io from "socket.io-client";

let socket;

// ─── AVATAR CONFIG ──────────────────────────────────────────
const AVATARS = [
  "😀",
  "😎",
  "🤠",
  "🥳",
  "😈",
  "👻",
  "🤖",
  "👽",
  "🦊",
  "🐱",
  "🐶",
  "🐸",
  "🦄",
  "🐧",
  "🐼",
  "🦁",
  "🐮",
  "🐷",
];
const COLORS = [
  "#000000",
  "#808080",
  "#C0C0C0",
  "#FFFFFF",
  "#FF0000",
  "#FF6B00",
  "#FFD600",
  "#00C853",
  "#00BCD4",
  "#2196F3",
  "#3F51B5",
  "#9C27B0",
  "#E91E63",
  "#795548",
  "#FF9800",
  "#8BC34A",
  "#00E5FF",
  "#651FFF",
];
const BRUSH_SIZES = [3, 6, 10, 16, 24];

export default function Home() {
  // ─── State ───────────────────────────────────────────────────
  const [screen, setScreen] = useState("lobby"); // lobby | game | gameOver
  const [playerName, setPlayerName] = useState("");
  const [selectedAvatar, setSelectedAvatar] = useState(0);
  const [roomId, setRoomId] = useState("");
  const [joinRoomId, setJoinRoomId] = useState("");
  const [players, setPlayers] = useState([]);
  const [error, setError] = useState("");
  const [isHost, setIsHost] = useState(false);
  const [myId, setMyId] = useState("");

  // Game state
  const [gameState, setGameState] = useState("waiting");
  const [drawerId, setDrawerId] = useState(null);
  const [drawerName, setDrawerName] = useState("");
  const [wordChoices, setWordChoices] = useState([]);
  const [currentHint, setCurrentHint] = useState("");
  const [currentWord, setCurrentWord] = useState("");
  const [timeLeft, setTimeLeft] = useState(0);
  const [drawTime, setDrawTime] = useState(80);
  const [round, setRound] = useState(0);
  const [maxRounds, setMaxRounds] = useState(3);
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [revealedWord, setRevealedWord] = useState("");
  const [finalPlayers, setFinalPlayers] = useState([]);

  // Drawing state
  const [brushColor, setBrushColor] = useState("#000000");
  const [brushSize, setBrushSize] = useState(6);
  const [tool, setTool] = useState("brush"); // brush | eraser | fill
  const [isDrawing, setIsDrawing] = useState(false);

  const canvasRef = useRef(null);
  const chatEndRef = useRef(null);
  const strokeHistory = useRef([]);
  const currentStroke = useRef([]);

  // ─── Socket Setup ────────────────────────────────────────────
  useEffect(() => {
    socket = io({ transports: ["websocket", "polling"] });

    socket.on("connect", () => {
      setMyId(socket.id);
    });

    socket.on("playerJoined", ({ players }) => setPlayers(players));
    socket.on("playerLeft", ({ players }) => setPlayers(players));

    socket.on("gameStarted", ({ round, maxRounds }) => {
      setScreen("game");
      setGameState("playing");
      setRound(round);
      setMaxRounds(maxRounds);
      setMessages([]);
    });

    socket.on("newTurn", ({ drawerId, drawerName, round, maxRounds }) => {
      setDrawerId(drawerId);
      setDrawerName(drawerName);
      setRound(round);
      setMaxRounds(maxRounds);
      setGameState("playing");
      setWordChoices([]);
      setCurrentHint("");
      setRevealedWord("");
      clearCanvas();
      strokeHistory.current = [];
      setMessages((prev) => [
        ...prev,
        { type: "system", message: `🎨 ${drawerName} is drawing now!` },
      ]);
    });

    socket.on("chooseWord", ({ words }) => {
      setWordChoices(words);
      setGameState("picking");
    });

    socket.on("drawingStarted", ({ drawerId, drawerName, hint, drawTime }) => {
      setDrawerId(drawerId);
      setDrawerName(drawerName);
      setCurrentHint(hint);
      setDrawTime(drawTime);
      setGameState("drawing");
      setWordChoices([]);
    });

    socket.on("draw", (data) => drawFromRemote(data));
    socket.on("clearCanvas", () => {
      clearCanvas();
      strokeHistory.current = [];
    });
    socket.on("redrawCanvas", (drawingData) => redrawFromData(drawingData));
    socket.on("fill", (data) => fillFromRemote(data));

    socket.on("hint", ({ hint }) => setCurrentHint(hint));
    socket.on("timerUpdate", ({ timeLeft }) => setTimeLeft(timeLeft));

    socket.on("chatMessage", ({ playerName, message, type }) => {
      setMessages((prev) => [...prev, { playerName, message, type }]);
    });

    socket.on("correctGuess", ({ playerName, playerId, players }) => {
      setPlayers(players);
      setMessages((prev) => [
        ...prev,
        {
          type: "correct-system",
          message: `🎉 ${playerName} guessed the word!`,
        },
      ]);
    });

    socket.on("turnEnd", ({ word, players }) => {
      setRevealedWord(word);
      setPlayers(players);
      setGameState("turnEnd");
      setMessages((prev) => [
        ...prev,
        { type: "system", message: `⏱️ The word was: ${word}` },
      ]);
    });

    socket.on("newRound", ({ round }) => {
      setRound(round);
      setMessages((prev) => [
        ...prev,
        { type: "system", message: `📢 Round ${round} starting!` },
      ]);
    });

    socket.on("gameOver", ({ players }) => {
      setFinalPlayers(players);
      setScreen("gameOver");
      setGameState("gameOver");
    });

    socket.on("gameReset", ({ players }) => {
      setPlayers(players);
      setScreen("lobby");
      setGameState("waiting");
      setRound(0);
      setMessages([]);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  // Auto-fill room code from URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomCode = params.get("room");
    if (roomCode) {
      setJoinRoomId(roomCode.toUpperCase());
    }
  }, []);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ─── Canvas Drawing ──────────────────────────────────────────
  const getCanvasPos = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }, []);

  const startDrawing = useCallback(
    (e) => {
      if (drawerId !== myId) return;
      e.preventDefault();

      if (tool === "fill") {
        const pos = getCanvasPos(e);
        const fillColor = brushColor;
        floodFill(pos.x, pos.y, fillColor);
        socket.emit("fill", { x: pos.x, y: pos.y, color: fillColor });
        return;
      }

      setIsDrawing(true);
      const pos = getCanvasPos(e);
      const ctx = canvasRef.current.getContext("2d");
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y);

      const drawData = {
        type: "start",
        x: pos.x,
        y: pos.y,
        color: tool === "eraser" ? "#FFFFFF" : brushColor,
        size: tool === "eraser" ? brushSize * 2 : brushSize,
      };
      currentStroke.current = [drawData];
      socket.emit("draw", drawData);
    },
    [drawerId, myId, tool, brushColor, brushSize, getCanvasPos],
  );

  const draw = useCallback(
    (e) => {
      if (!isDrawing || drawerId !== myId) return;
      e.preventDefault();
      const pos = getCanvasPos(e);
      const ctx = canvasRef.current.getContext("2d");

      ctx.strokeStyle = tool === "eraser" ? "#FFFFFF" : brushColor;
      ctx.lineWidth = tool === "eraser" ? brushSize * 2 : brushSize;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();

      const drawData = {
        type: "draw",
        x: pos.x,
        y: pos.y,
        color: tool === "eraser" ? "#FFFFFF" : brushColor,
        size: tool === "eraser" ? brushSize * 2 : brushSize,
      };
      currentStroke.current.push(drawData);
      socket.emit("draw", drawData);
    },
    [isDrawing, drawerId, myId, tool, brushColor, brushSize, getCanvasPos],
  );

  const stopDrawing = useCallback(() => {
    if (isDrawing) {
      setIsDrawing(false);
      const ctx = canvasRef.current?.getContext("2d");
      if (ctx) ctx.beginPath();
      if (currentStroke.current.length > 0) {
        strokeHistory.current.push([...currentStroke.current]);
        currentStroke.current = [];
      }
    }
  }, [isDrawing]);

  function drawFromRemote(data) {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    if (data.type === "start") {
      ctx.beginPath();
      ctx.moveTo(data.x, data.y);
    } else {
      ctx.strokeStyle = data.color;
      ctx.lineWidth = data.size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineTo(data.x, data.y);
      ctx.stroke();
    }
  }

  function redrawFromData(drawingData) {
    clearCanvas();
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    drawingData.forEach((data) => {
      if (data.type === "fill") {
        floodFill(data.x, data.y, data.color);
      } else if (data.type === "start") {
        ctx.beginPath();
        ctx.moveTo(data.x, data.y);
      } else {
        ctx.strokeStyle = data.color;
        ctx.lineWidth = data.size;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineTo(data.x, data.y);
        ctx.stroke();
      }
    });
  }

  function clearCanvas() {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);
  }

  function floodFill(startX, startY, fillColor) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    const width = canvas.width;
    const height = canvas.height;

    const sx = Math.round(startX);
    const sy = Math.round(startY);
    const startIdx = (sy * width + sx) * 4;
    const startR = data[startIdx];
    const startG = data[startIdx + 1];
    const startB = data[startIdx + 2];

    // Parse fill color
    const hex = fillColor.replace("#", "");
    const fillR = parseInt(hex.substring(0, 2), 16);
    const fillG = parseInt(hex.substring(2, 4), 16);
    const fillB = parseInt(hex.substring(4, 6), 16);

    if (startR === fillR && startG === fillG && startB === fillB) return;

    const stack = [[sx, sy]];
    const visited = new Set();

    while (stack.length > 0) {
      const [x, y] = stack.pop();
      const idx = (y * width + x) * 4;

      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      if (visited.has(idx)) continue;

      const r = data[idx],
        g = data[idx + 1],
        b = data[idx + 2];
      if (
        Math.abs(r - startR) > 30 ||
        Math.abs(g - startG) > 30 ||
        Math.abs(b - startB) > 30
      )
        continue;

      visited.add(idx);
      data[idx] = fillR;
      data[idx + 1] = fillG;
      data[idx + 2] = fillB;
      data[idx + 3] = 255;

      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }

    ctx.putImageData(imageData, 0, 0);
  }

  function fillFromRemote(data) {
    floodFill(data.x, data.y, data.color);
  }

  // ─── Room Actions ────────────────────────────────────────────
  function handleCreateRoom() {
    if (!playerName.trim()) return setError("Enter your name!");
    socket.emit(
      "createRoom",
      { playerName: playerName.trim(), avatar: AVATARS[selectedAvatar] },
      (res) => {
        if (res.success) {
          setRoomId(res.roomId);
          setPlayers(res.players);
          setIsHost(true);
          setError("");
        } else {
          setError(res.error);
        }
      },
    );
  }

  function handleJoinRoom() {
    if (!playerName.trim()) return setError("Enter your name!");
    if (!joinRoomId.trim()) return setError("Enter a room code!");
    socket.emit(
      "joinRoom",
      {
        roomId: joinRoomId.trim().toUpperCase(),
        playerName: playerName.trim(),
        avatar: AVATARS[selectedAvatar],
      },
      (res) => {
        if (res.success) {
          setRoomId(res.roomId);
          setPlayers(res.players);
          setError("");
        } else {
          setError(res.error);
        }
      },
    );
  }

  function handleStartGame() {
    socket.emit("startGame");
  }

  function handleChooseWord(word) {
    socket.emit("wordChosen", { word });
    setWordChoices([]);
    setCurrentWord(word);
  }

  function handleSendChat(e) {
    e.preventDefault();
    if (!chatInput.trim()) return;
    socket.emit("chatMessage", { message: chatInput.trim() });
    setChatInput("");
  }

  function handleUndo() {
    socket.emit("undoStroke");
    // Also undo locally
    strokeHistory.current.pop();
    clearCanvas();
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) {
      strokeHistory.current.forEach((stroke) => {
        stroke.forEach((data) => {
          if (data.type === "start") {
            ctx.beginPath();
            ctx.moveTo(data.x, data.y);
          } else {
            ctx.strokeStyle = data.color;
            ctx.lineWidth = data.size;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.lineTo(data.x, data.y);
            ctx.stroke();
          }
        });
      });
    }
  }

  function handleClear() {
    clearCanvas();
    strokeHistory.current = [];
    socket.emit("clearCanvas");
  }

  const isDrawer = drawerId === myId;
  const timerPercent = drawTime > 0 ? (timeLeft / drawTime) * 100 : 0;

  // ─── LOBBY SCREEN ────────────────────────────────────────────
  if (screen === "lobby" && !roomId) {
    return (
      <div className="app">
        <div className="lobby-container">
          <div className="logo-section">
            <h1 className="logo">
              <span className="logo-icon">✏️</span>
              Scribble
            </h1>
            <p className="tagline">Draw, Guess & Have Fun!</p>
          </div>

          <div className="lobby-card">
            <div className="input-group">
              <label>Your Name</label>
              <input
                type="text"
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
                placeholder="Enter your name..."
                maxLength={16}
                className="text-input"
              />
            </div>

            <div className="avatar-section">
              <label>Choose Avatar</label>
              <div className="avatar-grid">
                {AVATARS.map((av, i) => (
                  <button
                    key={i}
                    className={`avatar-btn ${i === selectedAvatar ? "selected" : ""}`}
                    onClick={() => setSelectedAvatar(i)}
                  >
                    {av}
                  </button>
                ))}
              </div>
            </div>

            <button className="btn btn-primary" onClick={handleCreateRoom}>
              Create Private Room
            </button>

            <div className="divider">
              <span>OR</span>
            </div>

            <div className="join-section">
              <input
                type="text"
                value={joinRoomId}
                onChange={(e) => setJoinRoomId(e.target.value.toUpperCase())}
                placeholder="Room Code"
                maxLength={6}
                className="text-input room-code-input"
              />
              <button className="btn btn-secondary" onClick={handleJoinRoom}>
                Join Room
              </button>
            </div>

            {error && <div className="error-msg">{error}</div>}
          </div>
        </div>
      </div>
    );
  }

  // ─── WAITING ROOM ────────────────────────────────────────────
  if (screen === "lobby" && roomId) {
    return (
      <div className="app">
        <div className="waiting-container">
          <div className="waiting-card">
            <h2>
              Room: <span className="room-code">{roomId}</span>
            </h2>
            <p className="invite-text">
              Share this code with your friends to join!
            </p>
            <button
              className="btn btn-copy"
              onClick={() => {
                navigator.clipboard.writeText(
                  `${window.location.origin}?room=${roomId}`,
                );
              }}
            >
              📋 Copy Invite Link
            </button>

            <div className="player-list-waiting">
              <h3>Players ({players.length}/12)</h3>
              <div className="player-grid">
                {players.map((p) => (
                  <div key={p.id} className="player-waiting-card">
                    <span className="player-avatar-large">{p.avatar}</span>
                    <span className="player-name-waiting">{p.name}</span>
                    {p.isHost && <span className="host-badge">👑</span>}
                  </div>
                ))}
              </div>
            </div>

            {isHost && (
              <button
                className="btn btn-primary btn-start"
                onClick={handleStartGame}
                disabled={players.length < 2}
              >
                {players.length < 2
                  ? "Need at least 2 players"
                  : `Start Game (${players.length} players)`}
              </button>
            )}
            {!isHost && (
              <p className="waiting-text">Waiting for host to start...</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ─── GAME OVER SCREEN ────────────────────────────────────────
  if (screen === "gameOver") {
    return (
      <div className="app">
        <div className="game-over-container">
          <h1 className="game-over-title">🏆 Game Over!</h1>
          <div className="podium">
            {finalPlayers.slice(0, 3).map((p, i) => (
              <div key={p.id} className={`podium-place place-${i + 1}`}>
                <div className="podium-medal">
                  {i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉"}
                </div>
                <span className="podium-avatar">{p.avatar}</span>
                <span className="podium-name">{p.name}</span>
                <span className="podium-score">{p.score} pts</span>
              </div>
            ))}
          </div>
          <div className="final-scores">
            {finalPlayers.slice(3).map((p, i) => (
              <div key={p.id} className="final-score-row">
                <span>#{i + 4}</span>
                <span>
                  {p.avatar} {p.name}
                </span>
                <span>{p.score} pts</span>
              </div>
            ))}
          </div>
          <p className="return-text">Returning to lobby in a few seconds...</p>
        </div>
      </div>
    );
  }

  // ─── GAME SCREEN ─────────────────────────────────────────────
  return (
    <div className="app">
      {/* Word Choose Overlay */}
      {wordChoices.length > 0 && (
        <div className="overlay">
          <div className="word-choose-card">
            <h2>Choose a word to draw!</h2>
            <div className="word-choices">
              {wordChoices.map((word) => (
                <button
                  key={word}
                  className="btn btn-word"
                  onClick={() => handleChooseWord(word)}
                >
                  {word}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Revealed Word Overlay */}
      {gameState === "turnEnd" && revealedWord && (
        <div className="overlay overlay-transparent">
          <div className="word-reveal-card">
            <p>The word was</p>
            <h2>{revealedWord}</h2>
          </div>
        </div>
      )}

      {/* Top Bar */}
      <div className="game-top-bar">
        <div className="round-info">
          Round {round} / {maxRounds}
        </div>
        <div className="hint-display">
          {isDrawer && gameState === "drawing" ? (
            <span className="your-word">
              Your word: <strong>{currentWord}</strong>
            </span>
          ) : (
            <span className="hint-text">{currentHint || "Waiting..."}</span>
          )}
        </div>
        <div className="timer-container">
          <div
            className="timer-bar"
            style={{
              width: `${timerPercent}%`,
              backgroundColor:
                timeLeft <= 15
                  ? "#ff4444"
                  : timeLeft <= 30
                    ? "#ffaa00"
                    : "#00c853",
            }}
          />
          <span className="timer-text">{timeLeft}s</span>
        </div>
      </div>

      <div className="game-body">
        {/* Player Sidebar */}
        <div className="player-sidebar">
          {[...players]
            .sort((a, b) => b.score - a.score)
            .map((p, i) => (
              <div
                key={p.id}
                className={`player-card ${p.id === drawerId ? "is-drawer" : ""} ${
                  p.hasGuessed ? "has-guessed" : ""
                } ${p.id === myId ? "is-me" : ""}`}
              >
                <span className="player-rank">#{i + 1}</span>
                <span className="player-avatar">{p.avatar}</span>
                <div className="player-info">
                  <span className="player-name">
                    {p.name} {p.id === myId && "(You)"}
                  </span>
                  <span className="player-score">{p.score} pts</span>
                </div>
                {p.id === drawerId && <span className="drawing-icon">🎨</span>}
                {p.hasGuessed && <span className="guessed-icon">✅</span>}
              </div>
            ))}
        </div>

        {/* Canvas Area */}
        <div className="canvas-area">
          <canvas
            ref={canvasRef}
            width={800}
            height={600}
            className="drawing-canvas"
            onMouseDown={startDrawing}
            onMouseMove={draw}
            onMouseUp={stopDrawing}
            onMouseLeave={stopDrawing}
            onTouchStart={startDrawing}
            onTouchMove={draw}
            onTouchEnd={stopDrawing}
          />

          {/* Drawing Tools - only visible to drawer */}
          {isDrawer && gameState === "drawing" && (
            <div className="toolbar">
              <div className="tool-group">
                <button
                  className={`tool-btn ${tool === "brush" ? "active" : ""}`}
                  onClick={() => setTool("brush")}
                  title="Brush"
                >
                  ✏️
                </button>
                <button
                  className={`tool-btn ${tool === "eraser" ? "active" : ""}`}
                  onClick={() => setTool("eraser")}
                  title="Eraser"
                >
                  🧹
                </button>
                <button
                  className={`tool-btn ${tool === "fill" ? "active" : ""}`}
                  onClick={() => setTool("fill")}
                  title="Fill Bucket"
                >
                  🪣
                </button>
                <button className="tool-btn" onClick={handleUndo} title="Undo">
                  ↩️
                </button>
                <button
                  className="tool-btn"
                  onClick={handleClear}
                  title="Clear"
                >
                  🗑️
                </button>
              </div>

              <div className="tool-group sizes">
                {BRUSH_SIZES.map((size) => (
                  <button
                    key={size}
                    className={`size-btn ${brushSize === size ? "active" : ""}`}
                    onClick={() => setBrushSize(size)}
                  >
                    <span
                      className="size-dot"
                      style={{
                        width: Math.min(size, 20),
                        height: Math.min(size, 20),
                      }}
                    />
                  </button>
                ))}
              </div>

              <div className="tool-group colors">
                {COLORS.map((color) => (
                  <button
                    key={color}
                    className={`color-btn ${brushColor === color ? "active" : ""}`}
                    onClick={() => {
                      setBrushColor(color);
                      if (tool === "eraser") setTool("brush");
                    }}
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Chat */}
        <div className="chat-panel">
          <div className="chat-messages">
            {messages.map((msg, i) => (
              <div key={i} className={`chat-msg chat-${msg.type}`}>
                {msg.type === "system" || msg.type === "correct-system" ? (
                  <span className="system-msg">{msg.message}</span>
                ) : (
                  <>
                    <strong>{msg.playerName}:</strong> {msg.message}
                    {msg.type === "close" && (
                      <span className="close-indicator"> (close!)</span>
                    )}
                  </>
                )}
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
          <form className="chat-form" onSubmit={handleSendChat}>
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder={
                isDrawer ? "You are drawing..." : "Type your guess..."
              }
              disabled={isDrawer && gameState === "drawing"}
              className="chat-input"
              autoComplete="off"
            />
            <button
              type="submit"
              className="btn btn-send"
              disabled={isDrawer && gameState === "drawing"}
            >
              ➤
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
