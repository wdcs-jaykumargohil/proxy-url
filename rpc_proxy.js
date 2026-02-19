const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();

// ------------------------
// READ CLI ARGUMENTS
// ------------------------
const PORT = process.argv[2] ? Number(process.argv[2]) : 6000;
const TARGET_URL = process.argv[3];
const ERROR_STATUS_CODE =
  process.argv[4] && Number(process.argv[4]) > 0 ? Number(process.argv[4]) : 500;
const ERROR_RESPONSE_MESSAGE =
  process.argv[5] && process.argv[5].trim()
    ? process.argv[5]
    : "Service unavailable (simulated)";

if (!TARGET_URL) {
  console.error("❌ Please provide a target RPC URL.");
  console.log("Example:");
  console.log("node rpc_proxy.js 5002 https://rpc.example.com");
  process.exit(1);
}

// ------------------------
// Optional: simulate break/fix
// ------------------------
let isBroken = false;

app.use((req, res, next) => {
  if (isBroken) {
    console.log("🔴 Proxy is DOWN");
    return res.status(ERROR_STATUS_CODE).json({ error: ERROR_RESPONSE_MESSAGE });
  }

  console.log("🟢 Forwarding request to RPC");
  // console.log(`📍 Full URL: ${req.protocol}://${req.get("host")}${req.originalUrl}`);
  next();
});

// ------------------------
// RAW STREAMING PROXY
// ------------------------
app.use(
  "/",
  createProxyMiddleware({
    target: TARGET_URL,
    changeOrigin: true,
    secure: false, // allows HTTPS targets without strict SSL issues
    proxyTimeout: 60000, // upstream timeout
    timeout: 60000, // client timeout
    logLevel: "silent", // change to "debug" if needed
    onError(err, req, res) {
      console.error("🔥 Proxy error:", err.message);
      res.status(500).json({ error: "Proxy failure" });
    },
  }),
);

// ------------------------
app.listen(PORT, () => {
  console.log(`🚀 Proxy running at: http://localhost:${PORT}`);
  // console.log(`➡️ Forwarding to: ${TARGET_URL}`);
  console.log(`⚠️ Simulated error status: ${ERROR_STATUS_CODE}`);
  console.log(`⚠️ Simulated error message: ${ERROR_RESPONSE_MESSAGE}`);
  console.log("Commands: (b) break | (f) fix\n");
});

// ------------------------
// CLI Break / Fix Simulation
// ------------------------
process.stdin.on("data", (input) => {
  const cmd = input.toString().trim();

  if (cmd === "b") {
    isBroken = true;
    console.log("🔴 Proxy manually set to DOWN");
  } else if (cmd === "f") {
    isBroken = false;
    console.log("🟢 Proxy manually set to UP");
  }
});

/* 
# TestNet 
node rpc_proxy.js <PORT> <TARGET_URL>

## Example Targets
node rpc_proxy.js 5001 https://rpc.example.com
node rpc_proxy.js 5002 https://rpc-backup.example.com
*/
