const express = require("express");
const path = require("path");
const net = require("net");
const os = require("os");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.MANAGER_PORT ? Number(process.env.MANAGER_PORT) : 9090;

const MIN_PORT = 1000;
const MAX_PORT = 65535;
const DEFAULT_ERROR_STATUS = 500;
const DEFAULT_ERROR_MESSAGE = "Service unavailable (simulated)";

const simulations = new Map();
const logClients = new Set();
let seq = 1;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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

function broadcastLog(entry) {
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const client of logClients) {
    if (client.isAdmin || (client.userId && client.userId === entry.ownerId)) {
      client.res.write(payload);
    }
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
  if (sim.logs.length > 600) sim.logs.shift();
  broadcastLog(entry);
}

function simulationToJson(sim) {
  return {
    id: sim.id,
    name: sim.name,
    urlType: sim.urlType,
    script: sim.script,
    port: sim.port,
    simulateUrl: sim.simulateUrl,
    errorStatusCode: sim.errorStatusCode,
    errorResponseMessage: sim.errorResponseMessage,
    state: sim.state,
    pid: sim.process ? sim.process.pid : null,
    createdAt: sim.createdAt,
    ownerId: sim.ownerId,
    endpoint: buildEndpoint(sim),
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
    return res.json(all.map(simulationToJson));
  }

  const userId = getRequestUserId(req);
  if (!userId) return res.json([]);

  const filtered = all.filter((sim) => sim.ownerId === userId);
  return res.json(filtered.map(simulationToJson));
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
    state: "starting",
    process: null,
    logs: [],
    ownerId: ownerId || "admin",
    createdAt: nowIso(),
  };

  simulations.set(id, sim);
  startSimulation(sim);

  return res.status(201).json(simulationToJson(sim));
});

app.post("/api/simulations/:id/down", (req, res) => {
  const sim = simulations.get(req.params.id);
  if (!sim) return res.status(404).json({ error: "Simulation not found" });
  if (!canAccessSimulation(req, sim))
    return res.status(403).json({ error: "Forbidden" });

  try {
    sendCommand(sim, "b");
    sim.state = "down";
    // appendLog(sim, "system", "command sent: b (DOWN)");
    return res.json(simulationToJson(sim));
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
    // appendLog(sim, "system", "command sent: f (UP)");
    return res.json(simulationToJson(sim));
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
  res.flushHeaders();

  const backlog = [];
  for (const sim of simulations.values()) {
    if (canAccessSimulation(req, sim)) backlog.push(...sim.logs.slice(-50));
  }

  backlog.sort((a, b) => (a.at > b.at ? 1 : -1));
  for (const entry of backlog) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  const client = {
    res,
    isAdmin: isAdminRequest(req),
    userId: getRequestUserId(req),
  };
  logClients.add(client);
  req.on("close", () => {
    logClients.delete(client);
  });
});

app.listen(PORT, () => {
  console.log(`Simulation manager running at http://localhost:${PORT}`);
});
