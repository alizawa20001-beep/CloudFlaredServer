const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

class WorkerManager {
  constructor() {
    this.ACCOUNT_ID = null;
    this.API_TOKEN = null;
    this.SUBDOMAIN = null;
    this.WORKER_TYPES = ["socket", "translation", "database", "mega", "r2"];
  }

  configure(apiToken, accountId) {
    this.API_TOKEN = apiToken;
    this.ACCOUNT_ID = accountId;
  }

  async getSubdomain() {
    if (this.SUBDOMAIN) return this.SUBDOMAIN;

    try {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${this.ACCOUNT_ID}/workers/subdomain`,
        { headers: { Authorization: `Bearer ${this.API_TOKEN}`, "Content-Type": "application/json" } },
      );
      const data = await res.json();
      if (data.success && data.result?.subdomain) {
        this.SUBDOMAIN = data.result.subdomain;
        return this.SUBDOMAIN;
      }
      console.warn("getSubdomain: API responded with", JSON.stringify(data).slice(0, 300));
    } catch (e) {
      console.warn("getSubdomain: fetch error", e.message);
    }

    // Fallback: try fetching the subdomain from existing routes
    try {
      const scriptsRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${this.ACCOUNT_ID}/workers/scripts`,
        { headers: { Authorization: `Bearer ${this.API_TOKEN}` } },
      );
      const scripts = await scriptsRes.json();
      if (scripts.success && scripts.result?.length) {
        const first = scripts.result[0].id || scripts.result[0].name;
        const subRes = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${this.ACCOUNT_ID}/workers/scripts/${first}`,
          { headers: { Authorization: `Bearer ${this.API_TOKEN}` } },
        );
        const subData = await subRes.text();
        if (subRes.status === 200) {
          const match = subData.match(/https:\/\/([^.]+)\.([^/]+)\.workers\.dev/);
          if (match) {
            this.SUBDOMAIN = match[2];
            return this.SUBDOMAIN;
          }
        }
        const routesRes = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${this.ACCOUNT_ID}/workers/routes`,
          { headers: { Authorization: `Bearer ${this.API_TOKEN}` } },
        );
        const routes = await routesRes.json();
        if (routes.success && routes.result?.length) {
          for (const r of routes.result) {
            if (r.pattern) {
              const m = r.pattern.match(/https:\/\/([^.]+)\.([^/]+)\.workers\.dev/);
              if (m) { this.SUBDOMAIN = m[2]; return this.SUBDOMAIN; }
            }
          }
        }
      }
    } catch {}

    if (!this.SUBDOMAIN) throw new Error("Could not auto-detect subdomain. Ensure Workers.dev is enabled in your Cloudflare dashboard.");
    return this.SUBDOMAIN;
  }

  async enableProductionUrl(workerName) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${this.ACCOUNT_ID}/workers/scripts/${workerName}/subdomain`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled: true }),
      }
    );
    const result = await response.json();
    return result.success;
  }

  async uploadWorker(workerName, workerCode) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${this.ACCOUNT_ID}/workers/scripts/${workerName}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this.API_TOKEN}`,
          "Content-Type": "application/javascript",
        },
        body: workerCode,
      }
    );
    const result = await response.json();
    return { success: result.success, errors: result.errors };
  }

  async testWorker(url) {
    try {
      const response = await fetch(`${url}/api/health`, {
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) {
        const data = await response.json();
        return { healthy: true, data };
      }
      return { healthy: false, status: response.status };
    } catch (error) {
      return { healthy: false, error: error.message };
    }
  }

  getTypeSuffix(type) {
    const map = { socket: "sock", translation: "trans", database: "db", mega: "mega" };
    return map[type] || type;
  }

  workerName(userId, type) {
    const safeId = userId.toLowerCase().replace(/[^a-z0-9]/g, "").substring(0, 15);
    return `${safeId}-${this.getTypeSuffix(type)}`;
  }

  async workerExists(userId, type) {
    const name = this.workerName(userId, type);
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${this.ACCOUNT_ID}/workers/scripts/${name}`,
      { method: "GET", headers: { Authorization: `Bearer ${this.API_TOKEN}` } }
    );
    return response.status === 200;
  }

  async deployWorker(userId, workerType) {
    const workerName = this.workerName(userId, workerType);
    const workerPath = path.join(__dirname, `${workerType}-worker.js`);

    if (!fs.existsSync(workerPath)) {
      return { success: false, type: workerType, error: "File not found" };
    }

    const workerCode = fs.readFileSync(workerPath, "utf8");
    const uploadResult = await this.uploadWorker(workerName, workerCode);

    if (!uploadResult.success) {
      return { success: false, type: workerType, errors: uploadResult.errors };
    }

    await this.enableProductionUrl(workerName);
    const workerUrl = `https://${workerName}.${this.SUBDOMAIN}.workers.dev`;
    const health = await this.testWorker(workerUrl);

    return {
      success: true,
      type: workerType,
      name: workerName,
      url: workerUrl,
      healthy: health.healthy,
    };
  }

  async deployAllWorkers(userId) {
    await this.getSubdomain();
    const results = [];
    for (const type of this.WORKER_TYPES) {
      const result = await this.deployWorker(userId, type);
      results.push(result);
    }
    return results;
  }

  async deleteWorker(workerName) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${this.ACCOUNT_ID}/workers/scripts/${workerName}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${this.API_TOKEN}` },
      }
    );
    const result = await response.json();
    return result.success;
  }

  async deleteAllWorkers(userId) {
    const results = [];
    for (const type of this.WORKER_TYPES) {
      const name = this.workerName(userId, type);
      const deleted = await this.deleteWorker(name);
      results.push({ type, name, deleted });
    }
    return results;
  }

  async listWorkers(userId) {
    await this.getSubdomain();
    const results = [];
    for (const type of this.WORKER_TYPES) {
      const name = this.workerName(userId, type);
      const url = `https://${name}.${this.SUBDOMAIN}.workers.dev`;
      const exists = await this.workerExists(userId, type);
      let health = { healthy: false };
      if (exists) {
        health = await this.testWorker(url);
      }
      results.push({ type, name, url, exists, healthy: health.healthy });
    }
    return results;
  }

  async listAllWorkers() {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${this.ACCOUNT_ID}/workers/scripts`,
      {
        headers: { Authorization: `Bearer ${this.API_TOKEN}` },
      }
    );
    const result = await response.json();
    return result.success ? (result.result || []) : [];
  }

  ownsWorker(userId, workerName) {
    const safeId = userId.toLowerCase().replace(/[^a-z0-9]/g, "").substring(0, 15);
    return workerName.startsWith(safeId + "-");
  }

  extractUserIdFromWorkerName(workerName) {
    const match = workerName.match(/^([a-z0-9]{1,15})-/);
    return match ? match[1] : null;
  }

  async deploySingleWorker(userId, workerType) {
    if (!this.WORKER_TYPES.includes(workerType)) {
      return { success: false, type: workerType, error: "Unknown worker type" };
    }
    await this.getSubdomain();
    return this.deployWorker(userId, workerType);
  }

  async deployLabWorker(userId, projectName, files) {
    const safeId = userId.toLowerCase().replace(/[^a-z0-9]/g, "").substring(0, 15);
    const safeProject = projectName.toLowerCase().replace(/[^a-z0-9-]/g, "").substring(0, 30) || "project";
    const workerName = `${safeId}-lab-${safeProject}`;

    await this.getSubdomain();

    const templatePath = path.join(__dirname, "lab-worker-template.js");
    let workerCode = fs.readFileSync(templatePath, "utf8");

    const filesJson = JSON.stringify(files);
    workerCode = workerCode.replace('"__FILES_PLACEHOLDER__"', filesJson);

    const uploadResult = await this.uploadWorker(workerName, workerCode);
    if (!uploadResult.success) {
      return { success: false, workerName, errors: uploadResult.errors };
    }

    await this.enableProductionUrl(workerName);
    const workerUrl = `https://${workerName}.${this.SUBDOMAIN}.workers.dev`;

    let healthy = false;
    try {
      const health = await this.testWorker(workerUrl);
      healthy = health.healthy;
    } catch {}

    return { success: true, workerName, url: workerUrl, healthy, projectName };
  }

  async validateCredentials(tokenHint) {
    const token = tokenHint || this.API_TOKEN;
    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${this.ACCOUNT_ID}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  async fixAndRedeploy(userId) {
    const deleteResults = await this.deleteAllWorkers(userId);
    const deployResults = await this.deployAllWorkers(userId);
    const allSuccessful = deployResults.filter((r) => r.success).length === this.WORKER_TYPES.length;
    return { deleted: deleteResults, deployed: deployResults, allSuccessful };
  }
}

function getDb(dbPath) {
  const db = new Database(dbPath || path.join(__dirname, "streaming_platform.db"));
  db.pragma("foreign_keys = OFF");
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_cloudflare (
      user_id TEXT PRIMARY KEY,
      api_token TEXT NOT NULL,
      account_id TEXT NOT NULL,
      manage_api_token TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  // Migration for older databases without manage_api_token column
  try {
    db.exec("ALTER TABLE user_cloudflare ADD COLUMN manage_api_token TEXT");
  } catch (e) {
    // Column already exists, ignore
  }
  return db;
}

// d1-credentials.js
export async function saveCredentials(userId, apiToken, accountId, manageApiToken) {
  // const { env } = getRequestContext();
  // await env.DB.prepare(`
  //   CREATE TABLE IF NOT EXISTS user_cloudflare (
  //     user_id TEXT PRIMARY KEY,
  //     api_token TEXT,
  //     account_id TEXT,
  //     manage_api_token TEXT,
  //     updated_at INTEGER
  //   )
  // `).run();
  
  // await env.DB.prepare(`
  //   INSERT OR REPLACE INTO user_cloudflare (user_id, api_token, account_id, manage_api_token, updated_at)
  //   VALUES (?, ?, ?, ?, ?)
  // `).bind(userId, apiToken, accountId, manageApiToken, Date.now()).run();
}

function getCredentials(db, userId) {
  // const row = db
  //   .prepare("SELECT api_token, account_id, manage_api_token FROM user_cloudflare WHERE user_id = ?")
  //   .get(userId);
  // if (!row) return null;
  // return {
  //   apiToken: row.api_token,
  //   accountId: row.account_id,
  //   manageApiToken: row.manage_api_token || null,
  // };
}

function deleteCredentials(db, userId) {
  db.prepare("DELETE FROM user_cloudflare WHERE user_id = ?").run(userId);
}

module.exports = {
  WorkerManager,
  getDb,
  saveCredentials,
  getCredentials,
  deleteCredentials,
};
