const express = require("express");
const path = require("path");
const net = require("net");
const os = require("os");
const { spawn } = require("child_process");
const {
  createProxyMiddleware,
  responseInterceptor,
} = require("http-proxy-middleware");

const app = express();
const PORT = process.env.MANAGER_PORT ? Number(process.env.MANAGER_PORT) : 9090;

const MIN_PORT = 1000;
const MAX_PORT = 65535;
const DEFAULT_ERROR_STATUS = 500;
const DEFAULT_ERROR_MESSAGE = "Service unavailable (simulated)";
const DEFAULT_MAX_REQUESTS_PER_SECOND = 15;
const MAX_LOG_ENTRIES = 60;
const LOG_STREAM_HEARTBEAT_MS = 15000;

const simulations = new Map();
const logClients = new Set();
let seq = 1;

const jsonParser = express.json();
app.use((req, res, next) => {
  if (req.path.startsWith("/proxy/")) return next();
  return jsonParser(req, res, next);
});

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const requestedHeaders = req.headers["access-control-request-headers"];
  res.setHeader(
    "Access-Control-Allow-Headers",
    requestedHeaders || "Content-Type, Authorization, X-User-Id",
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD",
  );

  if (req.method === "OPTIONS") return res.sendStatus(204);
  return next();
});

app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders(res, filePath) {
      if (path.basename(filePath) !== "index.html") return;
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    },
  }),
);

function getExposedIp() {
  const interfaces = os.networkInterfaces();
  for (const key of Object.keys(interfaces)) {
    const entries = interfaces[key] || [];
    for (const entry of entries) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "127.0.0.1";
}

function buildEndpoint(sim) {
  const scheme = sim.urlType === "ws" ? "ws" : "http";
  return `${scheme}://${getExposedIp()}:${sim.port}`;
}

function getRequestScheme(req) {
  const forwardedProto = req?.headers?.["x-forwarded-proto"];
  if (forwardedProto) return String(forwardedProto).split(",")[0].trim();
  return req?.protocol || "http";
}

function getRequestHost(req) {
  const forwardedHost = req?.headers?.["x-forwarded-host"];
  if (forwardedHost) return String(forwardedHost).split(",")[0].trim();
  const host = req?.get?.("host");
  if (host) return host;
  return `${getExposedIp()}:${PORT}`;
}

function buildManagerProxyEndpoint(sim, req) {
  const scheme =
    sim.urlType === "ws" && getRequestScheme(req) === "https"
      ? "wss"
      : getRequestScheme(req);
  const host = getRequestHost(req);
  return `${scheme}://${host}/proxy/${sim.port}`;
}

function nowIso() {
  return new Date().toISOString();
}

function isAdminRequest(req) {
  return req.query.role === "admin";
}

function getRequestUserId(req) {
  const userId = req.header("x-user-id") || req.query.user_id;
  if (!userId) return null;
  const normalized = String(userId).trim();
  return normalized || null;
}

function canAccessSimulation(req, sim) {
  if (isAdminRequest(req)) return true;
  const userId = getRequestUserId(req);
  if (!userId) return false;
  return sim.ownerId === userId;
}

function parseRequestedSimulationIds(req) {
  const rawIds = req.query.ids;
  if (!rawIds) return null;
  const values = Array.isArray(rawIds) ? rawIds : [rawIds];
  const ids = new Set();
  for (const value of values) {
    const parts = String(value)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    for (const part of parts) ids.add(part);
  }
  return ids.size ? ids : null;
}

function canClientReceiveLog(client, entry) {
  const hasAccess = client.isAdmin || (client.userId && client.userId === entry.ownerId);
  if (!hasAccess) return false;
  if (!client.requestedIds) return true;
  return client.requestedIds.has(String(entry.id));
}

function broadcastLog(entry) {
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const client of logClients) {
    if (!canClientReceiveLog(client, entry)) continue;
    client.res.write(payload);
  }
}

function appendLog(sim, stream, line) {
  const entry = {
    id: sim.id,
    name: sim.name,
    ownerId: sim.ownerId,
    stream,
    line,
    at: nowIso(),
  };
  sim.logs.push(entry);
  if (sim.logs.length > MAX_LOG_ENTRIES) sim.logs.shift();
  broadcastLog(entry);
}

function simulationToJson(sim, req) {
  return {
    id: sim.id,
    name: sim.name,
    urlType: sim.urlType,
    script: sim.script,
    port: sim.port,
    simulateUrl: sim.simulateUrl,
    errorStatusCode: sim.errorStatusCode,
    errorResponseMessage: sim.errorResponseMessage,
    maxRequestsPerSecond: sim.maxRequestsPerSecond,
    state: sim.state,
    pid: sim.process ? sim.process.pid : null,
    createdAt: sim.createdAt,
    ownerId: sim.ownerId,
    endpoint: buildManagerProxyEndpoint(sim, req),
    endpointDirect: buildEndpoint(sim),
    logs: sim.logs,
  };
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port)) return null;
  if (port < MIN_PORT || port > MAX_PORT) return null;
  return port;
}

function parseErrorCode(value) {
  if (value === undefined || value === null || value === "")
    return DEFAULT_ERROR_STATUS;
  const code = Number(value);
  if (!Number.isInteger(code) || code <= 0) return null;
  return code;
}

function parseMaxRequestsPerSecond(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_MAX_REQUESTS_PER_SECOND;
  }
  const rate = Number(value);
  if (!Number.isInteger(rate) || rate <= 0) return null;
  return rate;
}

async function isPortFree(port) {
  for (const sim of simulations.values()) {
    if (sim.port === port && sim.state !== "stopped") return false;
  }

  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => resolve(false));

    server.once("listening", () => {
      server.close(() => resolve(true));
    });

    server.listen(port, "0.0.0.0");
  });
}

async function findFreePort(fromPort = MIN_PORT) {
  const start = Math.max(MIN_PORT, Number(fromPort) || MIN_PORT);
  for (let port = start; port <= MAX_PORT; port += 1) {
    // eslint-disable-next-line no-await-in-loop
    const free = await isPortFree(port);
    if (free) return port;
  }
  return null;
}

function startSimulation(sim) {
  const args = [
    sim.script,
    String(sim.port),
    sim.simulateUrl,
    String(sim.errorStatusCode),
    sim.errorResponseMessage,
    String(sim.maxRequestsPerSecond),
  ];

  const child = spawn("node", args, {
    cwd: __dirname,
    stdio: ["pipe", "pipe", "pipe"],
  });

  sim.process = child;
  sim.state = "up";

  appendLog(sim, "system", `started: node ${args.join(" ")}`);

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk) => {
    const lines = chunk.split(/\r?\n/).filter(Boolean);
    for (const line of lines) appendLog(sim, "stdout", line);
  });

  child.stderr.on("data", (chunk) => {
    const lines = chunk.split(/\r?\n/).filter(Boolean);
    for (const line of lines) appendLog(sim, "stderr", line);
  });

  child.on("exit", (code, signal) => {
    sim.state = "stopped";
    sim.process = null;
    appendLog(
      sim,
      "system",
      `exited (code=${code}, signal=${signal || "none"})`,
    );
  });
}

function sendCommand(sim, command) {
  if (!sim.process || sim.process.killed || sim.state === "stopped") {
    throw new Error("Simulation is not running");
  }
  sim.process.stdin.write(`${command}\n`);
}

app.get("/api/simulations", (req, res) => {
  const all = Array.from(simulations.values());
  if (isAdminRequest(req)) {
    return res.json(all.map((sim) => simulationToJson(sim, req)));
  }

  const userId = getRequestUserId(req);
  if (!userId) return res.json([]);

  const filtered = all.filter((sim) => sim.ownerId === userId);
  return res.json(filtered.map((sim) => simulationToJson(sim, req)));
});

app.post("/api/simulations", async (req, res) => {
  const isAdmin = isAdminRequest(req);
  const ownerId = getRequestUserId(req);
  const requestedName = req.body.name ? String(req.body.name).trim() : "";
  const urlType = req.body.url_type;
  const port = parsePort(req.body.port);
  const simulateUrl = req.body.simulate_url
    ? String(req.body.simulate_url).trim()
    : "";
  const errorStatusCode = parseErrorCode(req.body.error_status_code);
  const errorResponseMessage = req.body.error_response_message
    ? String(req.body.error_response_message)
    : DEFAULT_ERROR_MESSAGE;
  const maxRequestsPerSecond = parseMaxRequestsPerSecond(
    req.body.max_requests_per_second ?? req.body.max_throughput_rps,
  );

  if (!["http", "ws"].includes(urlType)) {
    return res.status(400).json({ error: "url_type must be 'http' or 'ws'" });
  }

  if (!port) {
    return res.status(400).json({
      error: `port must be an integer from ${MIN_PORT} to ${MAX_PORT}`,
    });
  }

  if (!simulateUrl) {
    return res.status(400).json({ error: "simulate_url is required" });
  }

  if (!isAdmin && !ownerId) {
    return res.status(400).json({ error: "x-user-id header is required" });
  }

  if (errorStatusCode === null) {
    return res
      .status(400)
      .json({ error: "error_status_code must be an integer greater than 0" });
  }

  if (maxRequestsPerSecond === null) {
    return res.status(400).json({
      error: "max_requests_per_second must be an integer greater than 0",
    });
  }

  const free = await isPortFree(port);
  if (!free) {
    const suggested = await findFreePort(port + 1);
    return res.status(409).json({
      error: `port ${port} is already in use`,
      suggested_port: suggested,
    });
  }

  const script = urlType === "http" ? "rpc_proxy.js" : "ws_proxy.js";
  const nextSeq = seq;
  const id = `sim-${nextSeq}`;
  seq += 1;

  const sim = {
    id,
    name: requestedName || `Simulation-${nextSeq}`,
    urlType,
    script,
    port,
    simulateUrl,
    errorStatusCode,
    errorResponseMessage,
    maxRequestsPerSecond,
    state: "starting",
    process: null,
    logs: [],
    ownerId: ownerId || "admin",
    createdAt: nowIso(),
  };

  simulations.set(id, sim);
  startSimulation(sim);

  return res.status(201).json(simulationToJson(sim, req));
});

app.post("/api/simulations/:id/down", (req, res) => {
  const sim = simulations.get(req.params.id);
  if (!sim) return res.status(404).json({ error: "Simulation not found" });
  if (!canAccessSimulation(req, sim))
    return res.status(403).json({ error: "Forbidden" });

  try {
    sendCommand(sim, "b");
    sim.state = "down";
    appendLog(sim, "system", "command sent: b (DOWN)");
    return res.json(simulationToJson(sim, req));
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }
});

app.post("/api/simulations/:id/up", (req, res) => {
  const sim = simulations.get(req.params.id);
  if (!sim) return res.status(404).json({ error: "Simulation not found" });
  if (!canAccessSimulation(req, sim))
    return res.status(403).json({ error: "Forbidden" });

  try {
    sendCommand(sim, "f");
    sim.state = "up";
    appendLog(sim, "system", "command sent: f (UP)");
    return res.json(simulationToJson(sim, req));
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }
});

app.delete("/api/simulations/:id", (req, res) => {
  const sim = simulations.get(req.params.id);
  if (!sim) return res.status(404).json({ error: "Simulation not found" });
  if (!canAccessSimulation(req, sim))
    return res.status(403).json({ error: "Forbidden" });

  const hadProcess = Boolean(sim.process && !sim.process.killed);
  if (sim.process && !sim.process.killed) {
    sim.process.kill("SIGTERM");
  }

  simulations.delete(sim.id);
  return res.json({
    id: sim.id,
    deleted: true,
    process_termination_requested: hadProcess,
  });
});

app.get("/api/ports/suggest", async (req, res) => {
  const from = parsePort(req.query.from) || MIN_PORT;
  const suggested = await findFreePort(from);
  if (!suggested)
    return res.status(404).json({ error: "No free port available" });

  return res.json({ suggested_port: suggested });
});

app.get("/api/logs/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write("retry: 3000\n\n");

  const requestedIds = parseRequestedSimulationIds(req);
  const backlog = [];
  for (const sim of simulations.values()) {
    if (!canAccessSimulation(req, sim)) continue;
    if (requestedIds && !requestedIds.has(String(sim.id))) continue;
    backlog.push(...sim.logs.slice(-MAX_LOG_ENTRIES));
  }

  backlog.sort((a, b) => (a.at > b.at ? 1 : -1));
  for (const entry of backlog) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  const heartbeatTimer = setInterval(() => {
    res.write(`event: heartbeat\ndata: ${Date.now()}\n\n`);
  }, LOG_STREAM_HEARTBEAT_MS);

  const client = {
    res,
    isAdmin: isAdminRequest(req),
    userId: getRequestUserId(req),
    requestedIds,
  };
  logClients.add(client);
  req.on("close", () => {
    clearInterval(heartbeatTimer);
    logClients.delete(client);
  });
});

function getProxyTarget(req) {
  const requestedPort = Number(req.params.port);
  if (!Number.isInteger(requestedPort)) return null;

  let sim = null;
  for (const candidate of simulations.values()) {
    if (candidate.port === requestedPort) {
      sim = candidate;
      break;
    }
  }
  if (!sim) return null;
  return `http://127.0.0.1:${sim.port}`;
}

function getProxyPathPrefix(req) {
  const requestedPort = Number(req.params.port);
  if (!Number.isInteger(requestedPort)) return "";
  return `/proxy/${requestedPort}`;
}

function rewriteLocationHeader(locationValue, req) {
  if (!locationValue) return locationValue;
  const prefix = getProxyPathPrefix(req);
  if (!prefix) return locationValue;
  if (locationValue.startsWith(prefix)) return locationValue;
  if (locationValue.startsWith("http://") || locationValue.startsWith("https://")) {
    return locationValue;
  }
  if (locationValue.startsWith("/")) return `${prefix}${locationValue}`;
  return `${prefix}/${locationValue}`;
}

function rewriteWebsiteBody(content, req) {
  const prefix = getProxyPathPrefix(req);
  if (!prefix) return content;

  let updated = content;
  updated = updated.replace(
    /((?:href|src|action)=["'])\/(?!\/)/gi,
    `$1${prefix}/`,
  );
  updated = updated.replace(
    /(url\(["']?)\/(?!\/)/gi,
    `$1${prefix}/`,
  );
  updated = updated.replace(
    /(fetch\(["'])\/(?!\/)/gi,
    `$1${prefix}/`,
  );
  return updated;
}

function shouldRewriteWebsiteResponse(req) {
  if (req.method !== "GET") return false;
  const accept = String(req.headers.accept || "").toLowerCase();
  if (accept.includes("text/html")) return true;
  const pathname = String(req.path || "").toLowerCase();
  return pathname.endsWith(".css");
}

const simulationStreamProxy = createProxyMiddleware({
  changeOrigin: true,
  secure: false,
  ws: true,
  router: getProxyTarget,
  onProxyRes(proxyRes, req) {
    if (proxyRes.headers.location) {
      proxyRes.headers.location = rewriteLocationHeader(proxyRes.headers.location, req);
    }
  },
  onError(err, req, res) {
    console.error("Proxy route error:", err.message);
    if (res && !res.headersSent) {
      res.status(502).json({ error: "Proxy forwarding failed" });
    }
  },
});

const simulationRewriteProxy = createProxyMiddleware({
  changeOrigin: true,
  secure: false,
  ws: false,
  selfHandleResponse: true,
  router: getProxyTarget,
  onProxyRes: responseInterceptor(async (buffer, proxyRes, req) => {
    if (proxyRes.headers.location) {
      proxyRes.headers.location = rewriteLocationHeader(proxyRes.headers.location, req);
    }

    const contentType = String(proxyRes.headers["content-type"] || "").toLowerCase();
    if (contentType.includes("text/html") || contentType.includes("text/css")) {
      const text = buffer.toString("utf8");
      return rewriteWebsiteBody(text, req);
    }
    return buffer;
  }),
  onError(err, req, res) {
    console.error("Proxy route error:", err.message);
    if (res && !res.headersSent) {
      res.status(502).json({ error: "Proxy forwarding failed" });
    }
  },
});

app.use("/proxy/:port", (req, res, next) => {
  const requestedPort = Number(req.params.port);
  if (!Number.isInteger(requestedPort)) {
    return res.status(400).json({ error: "Invalid simulation port" });
  }

  let sim = null;
  for (const candidate of simulations.values()) {
    if (candidate.port === requestedPort) {
      sim = candidate;
      break;
    }
  }
  if (!sim) return res.status(404).json({ error: "Simulation not found" });
  if (sim.state === "stopped") {
    return res.status(503).json({ error: "Simulation is not running" });
  }
  if (shouldRewriteWebsiteResponse(req)) {
    return simulationRewriteProxy(req, res, next);
  }
  return simulationStreamProxy(req, res, next);
});

const server = app.listen(PORT, () => {
  console.log(`Simulation manager running at http://localhost:${PORT}`);
});

server.on("upgrade", (req, socket, head) => {
  const match = req.url && req.url.match(/^\/proxy\/([^/?#]+)/);
  if (!match) return;

  const requestedPort = Number(match[1]);
  if (!Number.isInteger(requestedPort)) {
    socket.destroy();
    return;
  }

  let sim = null;
  for (const candidate of simulations.values()) {
    if (candidate.port === requestedPort) {
      sim = candidate;
      break;
    }
  }
  if (!sim || sim.state === "stopped") {
    socket.destroy();
    return;
  }

  req.params = { port: String(requestedPort) };
  simulationStreamProxy.upgrade(req, socket, head);
});
