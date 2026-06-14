const express = require("express");
const cors = require("cors");
const path = require("path");

const {
  WorkerManager,
  getDb,
  saveCredentials,
  getCredentials,
  deleteCredentials,
} = require("./deploy-workers-manager");

const app = express();

// Use cors package - this handles everything automatically
app.use(cors({ origin: "*", methods: ["POST", "GET"] }));
app.use(express.json({ limit: "10mb" }));

const db = getDb();

function ensureUserId(req, res, next) {
  const userId = req.body.userId || req.headers["x-user-id"];
  if (!userId) return res.status(400).json({ error: "userId required" });
  req.userId = userId;
  next();
}

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.post("/api/verify-credentials", async (req, res) => {
  const { apiToken, accountId } = req.body;
  if (!apiToken || !accountId) {
    return res.status(400).json({ error: "apiToken and accountId required" });
  }
  try {
    const axios = require("axios");
    const cfRes = await axios.get(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}`,
      { headers: { Authorization: `Bearer ${apiToken}` }, timeout: 10000 },
    );
    const data = cfRes.data;
    if (data.success) {
      res.json({ success: true, account: data.result?.name || accountId, requiredPassed: true });
    } else {
      res.json({ success: false, requiredPassed: false, summary: "Invalid credentials" });
    }
  } catch (err) {
    res.json({ success: false, requiredPassed: false, summary: err?.response?.data?.errors?.[0]?.message || err.message });
  }
});

const WANTED_PERMISSIONS = [
  "Workers Scripts Write", "Workers Scripts Read",
  "Workers Routes Write", "Workers Routes Read",
  "Workers KV Storage Write", "Workers KV Storage Read",
  "Workers R2 Storage Write", "Workers R2 Storage Read",
  "D1 Write", "D1 Read",
  "Workers AI Write", "Workers AI Read",
  "Workers Subdomain",
  "Account Settings Read",
];

async function createWorkerToken(manageApiToken, accountId, userId) {
  const CF_BASE = "https://api.cloudflare.com/client/v4";
  const authHeader = { Authorization: `Bearer ${manageApiToken}` };

  const cfFetch = async (url, opts = {}) => {
    const res = await fetch(url, { ...opts, headers: { ...authHeader, ...(opts.headers || {}) } });
    const text = await res.text();
    try { return JSON.parse(text); } catch { throw new Error(`Cloudflare returned non-JSON (${res.status}): ${text.slice(0, 200)}`); }
  };

  const pgData = await cfFetch(`${CF_BASE}/accounts/${accountId}/tokens/permission_groups`);
  if (!pgData.success) throw new Error("Manage token lacks Account API Tokens:Write permission.");

  const selectedPermissions = [];
  for (const wanted of WANTED_PERMISSIONS) {
    const found = (pgData.result || []).find((p) => p.name === wanted);
    if (found) selectedPermissions.push({ id: found.id, name: found.name });
  }
  if (selectedPermissions.length === 0) throw new Error("No valid permissions found in account.");

  const safeId = userId.toLowerCase().replace(/[^a-z0-9]/g, "").substring(0, 15);
  const tokenName = `moapp-worker-token-${safeId}`;

  const tokensData = await cfFetch(`${CF_BASE}/accounts/${accountId}/tokens`);
  let existingToken = null;
  if (tokensData.success) existingToken = (tokensData.result || []).find((t) => t.name === tokenName);

  if (existingToken) {
    const creds = getCredentials(db, userId);
    if (creds && creds.apiToken) return { apiTokenManager: manageApiToken, apiToken: creds.apiToken, accountId, tokenName, existing: true };
    await cfFetch(`${CF_BASE}/accounts/${accountId}/tokens/${existingToken.id}`, { method: "DELETE" });
  }

  const createData = await cfFetch(`${CF_BASE}/accounts/${accountId}/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: tokenName,
      policies: [{ effect: "allow", permission_groups: selectedPermissions, resources: { [`com.cloudflare.api.account.${accountId}`]: "*" } }],
    }),
  });
  if (!createData.success) throw new Error(`Cloudflare rejected token creation: ${JSON.stringify(createData.errors)}`);
  if (!createData.result?.value) throw new Error("Token created but value not returned.");

  return { apiTokenManager: manageApiToken, apiToken: createData.result.value, accountId, tokenName, existing: false };
}

app.post("/api/create-worker-token", ensureUserId, async (req, res) => {
  const { userId } = req;
  let { manageApiToken, accountId } = req.body;
  if (!manageApiToken || !accountId) return res.status(400).json({ error: "manageApiToken and accountId required" });
  try {
    const result = await createWorkerToken(manageApiToken, accountId, userId);
    saveCredentials(db, userId, result.apiToken, accountId, manageApiToken);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("Create worker token error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/connect", ensureUserId, async (req, res) => {
  let { userId, apiToken, accountId, manageApiToken } = req.body;

  if (manageApiToken && !apiToken) {
    try {
      const tokenResult = await createWorkerToken(manageApiToken, accountId, userId);
      apiToken = tokenResult.apiToken;
    } catch (err) {
      return res.status(500).json({ error: `Token creation failed: ${err.message}` });
    }
  }

  console.log("Connect request:", {
    userId,
    apiToken: apiToken ? "present" : "missing",
    accountId,
  });

  if (!apiToken || !accountId) {
    const creds = getCredentials(db, userId);
    if (creds) {
      apiToken = creds.apiToken;
      accountId = creds.accountId;
      manageApiToken = manageApiToken || creds.manageApiToken;
    }
  }

  if (!apiToken || !accountId) {
    return res.status(400).json({ error: "apiToken and accountId required" });
  }

  const manager = new WorkerManager();
  manager.configure(apiToken, accountId);

  try {
    const isValid = await manager.validateCredentials();
    if (!isValid) {
      return res.status(401).json({ error: "Invalid Cloudflare credentials" });
    }

    saveCredentials(db, userId, apiToken, accountId, manageApiToken);

    let workers = await manager.listWorkers(userId);
    const deployed = workers.filter((w) => w.exists);
    const healthy = workers.filter((w) => w.healthy);

    const expectedCount = manager.WORKER_TYPES.length;
    if (deployed.length < expectedCount || healthy.length < expectedCount) {
      console.log("Redeploying workers...");
      const result = await manager.fixAndRedeploy(userId);
      workers = result.deployed.map((w) => ({
        type: w.type,
        name: w.name,
        url: w.url,
        exists: w.success,
        healthy: w.healthy,
      }));
    }

    const subdomain = await manager.getSubdomain();

    res.json({
      success: true,
      subdomain,
      workers,
      summary: {
        total: workers.length,
        healthy: workers.filter((w) => w.healthy).length,
      },
      ...(manageApiToken ? { apiTokenManager: manageApiToken, apiToken } : {}),
    });
  } catch (error) {
    console.error("Connect error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/fix-redeploy", ensureUserId, async (req, res) => {
  const { userId } = req;
  let { apiToken, accountId } = req.body;

  if (!apiToken || !accountId) {
    const creds = getCredentials(db, userId);
    if (creds) {
      apiToken = creds.apiToken;
      accountId = creds.accountId;
    }
  }

  if (!apiToken || !accountId) {
    return res.status(400).json({ error: "apiToken and accountId required" });
  }

  const manager = new WorkerManager();
  manager.configure(apiToken, accountId);

  try {
    const isValid = await manager.validateCredentials();
    if (!isValid) {
      return res.status(401).json({ error: "Invalid Cloudflare credentials" });
    }

    saveCredentials(db, userId, apiToken, accountId);

    const result = await manager.fixAndRedeploy(userId);
    const subdomain = await manager.getSubdomain();

    res.json({
      success: result.allSuccessful,
      subdomain,
      deployed: result.deployed,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Fix redeploy error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/list-workers", ensureUserId, async (req, res) => {
  const { userId } = req;
  let { apiToken, accountId } = req.body;

  if (!apiToken || !accountId) {
    const creds = getCredentials(db, userId);
    if (creds) {
      apiToken = creds.apiToken;
      accountId = creds.accountId;
    }
  }

  if (!apiToken || !accountId) {
    return res.status(400).json({ error: "apiToken and accountId required" });
  }

  const manager = new WorkerManager();
  manager.configure(apiToken, accountId);

  try {
    const isValid = await manager.validateCredentials();
    if (!isValid) {
      return res.status(401).json({ error: "Invalid Cloudflare credentials" });
    }

    const workers = await manager.listWorkers(userId);
    const subdomain = await manager.getSubdomain();

    res.json({
      success: true,
      subdomain,
      workers,
      summary: {
        total: workers.length,
        deployed: workers.filter((w) => w.exists).length,
        healthy: workers.filter((w) => w.healthy).length,
      },
    });
  } catch (error) {
    console.error("List workers error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/delete-workers", ensureUserId, async (req, res) => {
  const { userId } = req;
  let { apiToken, accountId } = req.body;

  if (!apiToken || !accountId) {
    const creds = getCredentials(db, userId);
    if (creds) {
      apiToken = creds.apiToken;
      accountId = creds.accountId;
    }
  }

  if (!apiToken || !accountId) {
    return res.status(400).json({ error: "apiToken and accountId required" });
  }

  const manager = new WorkerManager();
  manager.configure(apiToken, accountId);

  try {
    const result = await manager.deleteAllWorkers(userId);
    deleteCredentials(db, userId);

    res.json({
      success: true,
      deleted: result,
      message: "Workers deleted and credentials removed",
    });
  } catch (error) {
    console.error("Delete workers error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/list-all-workers", ensureUserId, async (req, res) => {
  const { userId } = req;
  let { apiToken, accountId } = req.body;

  if (!apiToken || !accountId) {
    const creds = getCredentials(db, userId);
    if (creds) {
      apiToken = creds.apiToken;
      accountId = creds.accountId;
    }
  }

  if (!apiToken || !accountId) {
    return res.status(400).json({ error: "apiToken and accountId required" });
  }

  const manager = new WorkerManager();
  manager.configure(apiToken, accountId);

  try {
    const isValid = await manager.validateCredentials();
    if (!isValid) {
      return res.status(401).json({ error: "Invalid Cloudflare credentials" });
    }

    const scripts = await manager.listAllWorkers();
    const subdomain = await manager.getSubdomain();

    const workers = scripts.map((s) => {
      const name = s.id || s.name || "";
      const ownerId = manager.extractUserIdFromWorkerName(name);
      const url = `https://${name}.${subdomain}.workers.dev`;
      return {
        name,
        url,
        created_on: s.created_on,
        modified_on: s.modified_on,
        ownedByCurrentUser: ownerId ? manager.ownsWorker(userId, name) : false,
        ownerId,
      };
    });

    res.json({ success: true, subdomain, workers, total: workers.length });
  } catch (error) {
    console.error("List all workers error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/delete-worker-by-name", ensureUserId, async (req, res) => {
  const { userId } = req;
  let { apiToken, accountId, workerName } = req.body;

  if (!workerName) {
    return res.status(400).json({ error: "workerName required" });
  }

  if (!apiToken || !accountId) {
    const creds = getCredentials(db, userId);
    if (creds) {
      apiToken = creds.apiToken;
      accountId = creds.accountId;
    }
  }

  if (!apiToken || !accountId) {
    return res.status(400).json({ error: "apiToken and accountId required" });
  }

  const manager = new WorkerManager();
  manager.configure(apiToken, accountId);

  try {
    if (!manager.ownsWorker(userId, workerName)) {
      return res.status(403).json({
        success: false,
        error: "You can only delete workers you deployed",
      });
    }

    const deleted = await manager.deleteWorker(workerName);
    res.json({ success: deleted, workerName, deleted });
  } catch (error) {
    console.error("Delete single worker error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/deploy-single-worker", ensureUserId, async (req, res) => {
  const { userId } = req;
  let { apiToken, accountId, workerType } = req.body;

  if (!workerType) {
    return res.status(400).json({ error: "workerType required" });
  }

  if (!apiToken || !accountId) {
    const creds = getCredentials(db, userId);
    if (creds) {
      apiToken = creds.apiToken;
      accountId = creds.accountId;
    }
  }

  if (!apiToken || !accountId) {
    return res.status(400).json({ error: "apiToken and accountId required" });
  }

  const manager = new WorkerManager();
  manager.configure(apiToken, accountId);

  try {
    const isValid = await manager.validateCredentials();
    if (!isValid) {
      return res.status(401).json({ error: "Invalid Cloudflare credentials" });
    }

    const result = await manager.deploySingleWorker(userId, workerType);
    res.json({ success: result.success, worker: result });
  } catch (error) {
    console.error("Deploy single worker error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/deploy-lab-worker", ensureUserId, async (req, res) => {
  const { userId } = req;
  let { apiToken, accountId, projectName, files } = req.body;

  if (!projectName || !files || typeof files !== "object") {
    return res
      .status(400)
      .json({ error: "projectName and files object required" });
  }

  if (!apiToken || !accountId) {
    const creds = getCredentials(db, userId);
    if (creds) {
      apiToken = creds.apiToken;
      accountId = creds.accountId;
    }
  }

  if (!apiToken || !accountId) {
    return res.status(400).json({ error: "apiToken and accountId required" });
  }

  const manager = new WorkerManager();
  manager.configure(apiToken, accountId);

  try {
    const isValid = await manager.validateCredentials();
    if (!isValid) {
      return res.status(401).json({ error: "Invalid Cloudflare credentials" });
    }

    const result = await manager.deployLabWorker(userId, projectName, files);
    res.json({ success: result.success, worker: result });
  } catch (error) {
    console.error("Deploy lab worker error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/delete-lab-worker", ensureUserId, async (req, res) => {
  const { userId } = req;
  let { apiToken, accountId, workerName } = req.body;

  if (!workerName) {
    return res.status(400).json({ error: "workerName required" });
  }

  if (!apiToken || !accountId) {
    const creds = getCredentials(db, userId);
    if (creds) {
      apiToken = creds.apiToken;
      accountId = creds.accountId;
    }
  }

  if (!apiToken || !accountId) {
    return res.status(400).json({ error: "apiToken and accountId required" });
  }

  const manager = new WorkerManager();
  manager.configure(apiToken, accountId);

  try {
    if (!manager.ownsWorker(userId, workerName)) {
      return res.status(403).json({
        success: false,
        error: "You can only delete your own lab workers",
      });
    }

    const deleted = await manager.deleteWorker(workerName);
    res.json({ success: deleted, workerName, deleted });
  } catch (error) {
    console.error("Delete lab worker error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/list-lab-workers", ensureUserId, async (req, res) => {
  const { userId } = req;
  let { apiToken, accountId } = req.body;

  if (!apiToken || !accountId) {
    const creds = getCredentials(db, userId);
    if (creds) {
      apiToken = creds.apiToken;
      accountId = creds.accountId;
    }
  }

  if (!apiToken || !accountId) {
    return res.status(400).json({ error: "apiToken and accountId required" });
  }

  const manager = new WorkerManager();
  manager.configure(apiToken, accountId);

  try {
    const scripts = await manager.listAllWorkers();
    const subdomain = await manager.getSubdomain();

    const labWorkers = scripts
      .filter((s) => {
        const name = s.id || s.name || "";
        return manager.ownsWorker(userId, name) && name.includes("-lab-");
      })
      .map((s) => {
        const name = s.id || s.name || "";
        const projectName = name.split("-lab-").slice(1).join("-lab-") || name;
        return {
          name,
          url: `https://${name}.${subdomain}.workers.dev`,
          projectName,
          created_on: s.created_on,
          modified_on: s.modified_on,
        };
      });

    res.json({ success: true, subdomain, workers: labWorkers });
  } catch (error) {
    console.error("List lab workers error:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = 6060;
app.listen(PORT,"0.0.0.0", () => {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`🚀 Worker Management Server Running`);
  console.log(`${"=".repeat(60)}`);
  console.log(`📡 Port: ${PORT}`);
  console.log(`\n📋 Endpoints:`);
  console.log(`   GET  /api/health`);
  console.log(`   POST /api/verify-credentials`);
  console.log(`   POST /api/create-worker-token`);
  console.log(`   POST /api/connect`);
  console.log(`   POST /api/fix-redeploy`);
  console.log(`   POST /api/list-workers`);
  console.log(`   POST /api/delete-workers`);
  console.log(`   POST /api/list-all-workers`);
  console.log(`   POST /api/delete-worker-by-name`);
  console.log(`   POST /api/deploy-single-worker`);
  console.log(`   POST /api/deploy-lab-worker`);
  console.log(`   POST /api/list-lab-workers`);
  console.log(`   POST /api/delete-lab-worker`);
  console.log(`${"=".repeat(60)}\n`);
});
