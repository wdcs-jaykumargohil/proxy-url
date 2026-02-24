const WebSocket = require("ws");
const readline = require("readline");

// ------------------------------
// CLI Arguments
// ------------------------------
const args = process.argv.slice(2);

// Format: node ws_proxy.js <port> <url>
const LOCAL_PORT = args[0] && args[0] !== "null" ? Number(args[0]) : 6001;
const UPSTREAM_URL = args[1] && args[1] !== "null" ? args[1] : null;
const ERROR_STATUS_CODE = args[2] && Number(args[2]) > 0 ? Number(args[2]) : 500;
const ERROR_RESPONSE_MESSAGE =
  args[3] && String(args[3]).trim()
    ? String(args[3])
    : "Service unavailable (simulated)";
const MAX_MESSAGES_PER_SECOND =
  args[4] && Number(args[4]) > 0 ? Number(args[4]) : 3;

if (!UPSTREAM_URL) {
  console.error("Please provide an upstream websocket URL.");
  console.log("Example:");
  console.log("node ws_proxy.js 4001 wss://rpc.example.com/ws");
  process.exit(1);
}

console.log("⚙️ Using PORT:", LOCAL_PORT);
console.log("⚙️ Using Upstream URL:", UPSTREAM_URL);
console.log("⚙️ Simulated status code:", ERROR_STATUS_CODE);
console.log("⚙️ Simulated error message:", ERROR_RESPONSE_MESSAGE);
console.log("⚙️ Max throughput (messages/sec):", MAX_MESSAGES_PER_SECOND);

// ------------------------------
let upstream = null;
let clients = new Set();
let allowConnections = true;
let windowStartMs = Date.now();
let messageCountInWindow = 0;

function isRateLimited() {
  const now = Date.now();
  if (now - windowStartMs >= 1000) {
    windowStartMs = now;
    messageCountInWindow = 0;
  }
  messageCountInWindow += 1;
  return messageCountInWindow > MAX_MESSAGES_PER_SECOND;
}

// LOCAL WS SERVER
const wss = new WebSocket.Server({ port: LOCAL_PORT });
console.log(`WS Proxy: ws://localhost:${LOCAL_PORT}`);
console.log("Commands: (b) break all | (f) fix | (q) quit\n");

// When a client connects
wss.on("connection", (client, req) => {
  if (!allowConnections) {
    console.log(`❌ Incoming connection rejected (DOWN): ${ERROR_RESPONSE_MESSAGE}`);
    client.close(1013, ERROR_RESPONSE_MESSAGE.slice(0, 120));
    return;
  }

  console.log("Client connected");
  clients.add(client);

  client.on("close", () => {
    clients.delete(client);
    console.log("Client disconnected");
  });

  client.on("message", (msg) => {
    if (isRateLimited()) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(
          JSON.stringify({
            error: `Rate limit exceeded: max ${MAX_MESSAGES_PER_SECOND} messages/second`,
            code: 429,
          }),
        );
      }
      return;
    }

    if (upstream && upstream.readyState === WebSocket.OPEN) {
      upstream.send(msg);
    }
  });
});

// Connect upstream
function connectUpstream() {
  if (upstream) return;

  console.log("Connecting upstream RPC...");
  upstream = new WebSocket(UPSTREAM_URL);

  upstream.on("open", () => console.log("🟢 Upstream RPC connected"));

  upstream.on("message", (msg) => {
    for (const c of clients) {
      if (c.readyState === WebSocket.OPEN) c.send(msg);
    }
  });

  upstream.on("close", () => {
    console.log("🔴 Upstream RPC closed");
    upstream = null;
  });

  upstream.on("error", () => {
    console.log("⚠️ Upstream RPC error");
    upstream = null;
  });
}

// FULL BREAK
function breakEverything() {
  console.log(`\n🔴 FULL BREAK (${ERROR_STATUS_CODE}): ${ERROR_RESPONSE_MESSAGE}\n`);

  allowConnections = false;

  if (upstream) {
    upstream.close();
    upstream = null;
  }

  for (const c of clients) c.close();
  clients.clear();
}

// FIX: reconnect
function fixEverything() {
  console.log("\n🟢 FIX: Allow new connections + reconnect RPC\n");

  allowConnections = true;
  connectUpstream();
}

// Commands
readline
  .createInterface({ input: process.stdin, output: process.stdout })
  .on("line", (cmd) => {
    cmd = cmd.trim();
    if (cmd === "b") breakEverything();
    if (cmd === "f") fixEverything();
    if (cmd === "q") process.exit(0);
  });

connectUpstream();

/* 
node ws_proxy.js
node ws_proxy.js 7000
node ws_proxy.js null wss://myserver/myws
node ws_proxy.js 5005 wss://another-chain.com/ws
*/
