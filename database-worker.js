const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

function generateId() {
  return crypto.randomUUID();
}

function timestamp() {
  return new Date().toISOString();
}

function sanitizeTable(table) {
  return table.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request, event.env));
});

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === "OPTIONS") {
    return handleOptions();
  }

  if (path === "/api/health" && method === "GET") {
    return new Response(JSON.stringify({
      status: "ok",
      role: "database",
      timestamp: timestamp(),
      message: "D1 Database worker is running!"
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  if (path.match(/^\/api\/db\/[^\/]+$/) && method === "GET") {
    const collection = sanitizeTable(path.split('/').pop());
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const offset = (page - 1) * limit;

    try {
      await ensureTable(env, collection);

      const countResult = await env.DB.prepare(
        `SELECT COUNT(*) as total FROM "${collection}"`
      ).first();

      const results = await env.DB.prepare(
        `SELECT * FROM "${collection}" ORDER BY updatedAt DESC LIMIT ? OFFSET ?`
      ).bind(limit, offset).all();

      return new Response(JSON.stringify({
        success: true,
        collection,
        documents: results.results || [],
        pagination: {
          page,
          limit,
          total: countResult?.total || 0,
          pages: Math.ceil((countResult?.total || 0) / limit)
        },
        timestamp: timestamp()
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    } catch (error) {
      return new Response(JSON.stringify({ success: false, error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }

  if (path.match(/^\/api\/db\/[^\/]+$/) && method === "POST") {
    const collection = sanitizeTable(path.split('/').pop());

    try {
      const body = await request.json();
      const docId = body.id || generateId();
      const now = timestamp();

      await ensureTable(env, collection);

      await env.DB.prepare(
        `INSERT INTO "${collection}" (id, data, createdAt, updatedAt) VALUES (?, ?, ?, ?)`
      ).bind(docId, JSON.stringify(body.data || body), now, now).run();

      return new Response(JSON.stringify({
        success: true,
        id: docId,
        createdAt: now,
        collection
      }), {
        status: 201,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    } catch (error) {
      return new Response(JSON.stringify({ success: false, error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }

  if (path.match(/^\/api\/db\/[^\/]+\/[^\/]+$/) && method === "GET") {
    const parts = path.split('/');
    const collection = sanitizeTable(parts[3]);
    const docId = parts[4];

    try {
      await ensureTable(env, collection);

      const doc = await env.DB.prepare(
        `SELECT * FROM "${collection}" WHERE id = ?`
      ).bind(docId).first();

      if (!doc) {
        return new Response(JSON.stringify({ success: false, error: "Document not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      return new Response(JSON.stringify({
        success: true,
        id: doc.id,
        data: typeof doc.data === 'string' ? JSON.parse(doc.data) : doc.data,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        collection
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    } catch (error) {
      return new Response(JSON.stringify({ success: false, error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }

  if (path.match(/^\/api\/db\/[^\/]+\/[^\/]+$/) && method === "PUT") {
    const parts = path.split('/');
    const collection = sanitizeTable(parts[3]);
    const docId = parts[4];

    try {
      const body = await request.json();
      const now = timestamp();

      await ensureTable(env, collection);

      const existing = await env.DB.prepare(
        `SELECT id FROM "${collection}" WHERE id = ?`
      ).bind(docId).first();

      if (!existing) {
        await env.DB.prepare(
          `INSERT INTO "${collection}" (id, data, createdAt, updatedAt) VALUES (?, ?, ?, ?)`
        ).bind(docId, JSON.stringify(body.data || body), now, now).run();
      } else {
        await env.DB.prepare(
          `UPDATE "${collection}" SET data = ?, updatedAt = ? WHERE id = ?`
        ).bind(JSON.stringify(body.data || body), now, docId).run();
      }

      return new Response(JSON.stringify({
        success: true,
        id: docId,
        updatedAt: now,
        collection
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    } catch (error) {
      return new Response(JSON.stringify({ success: false, error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }

  if (path.match(/^\/api\/db\/[^\/]+\/[^\/]+$/) && method === "DELETE") {
    const parts = path.split('/');
    const collection = sanitizeTable(parts[3]);
    const docId = parts[4];

    try {
      await ensureTable(env, collection);

      const result = await env.DB.prepare(
        `DELETE FROM "${collection}" WHERE id = ?`
      ).bind(docId).run();

      if (result.meta.changes === 0) {
        return new Response(JSON.stringify({ success: false, error: "Document not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      return new Response(JSON.stringify({
        success: true,
        id: docId,
        deleted: true,
        collection
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    } catch (error) {
      return new Response(JSON.stringify({ success: false, error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }

  if (path.match(/^\/api\/db\/[^\/]+\/query$/) && method === "POST") {
    const collection = sanitizeTable(path.split('/')[3]);

    try {
      const { filter, limit = 50, orderBy = 'updatedAt', orderDir = 'DESC' } = await request.json();

      await ensureTable(env, collection);

      let sql = `SELECT * FROM "${collection}"`;
      const params = [];

      if (filter && Object.keys(filter).length > 0) {
        const conditions = [];
        for (const [key, value] of Object.entries(filter)) {
          conditions.push(`json_extract(data, '$.${key}') = ?`);
          params.push(value);
        }
        sql += ` WHERE ${conditions.join(' AND ')}`;
      }

      sql += ` ORDER BY ${orderBy} ${orderDir} LIMIT ?`;
      params.push(limit);

      const results = await env.DB.prepare(sql).bind(...params).all();

      return new Response(JSON.stringify({
        success: true,
        collection,
        documents: results.results || [],
        count: (results.results || []).length,
        timestamp: timestamp()
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    } catch (error) {
      return new Response(JSON.stringify({ success: false, error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }

  if (path.match(/^\/api\/db\/[^\/]+\/batch$/) && method === "POST") {
    const collection = sanitizeTable(path.split('/')[3]);

    try {
      const { documents } = await request.json();
      const now = timestamp();

      await ensureTable(env, collection);

      const results = [];
      for (const doc of documents) {
        const docId = doc.id || generateId();

        await env.DB.prepare(
          `INSERT OR REPLACE INTO "${collection}" (id, data, createdAt, updatedAt) 
           VALUES (?, ?, COALESCE((SELECT createdAt FROM "${collection}" WHERE id = ?), ?), ?)`
        ).bind(docId, JSON.stringify(doc.data || doc), docId, now, now).run();

        results.push({ id: docId, status: 'success' });
      }

      return new Response(JSON.stringify({
        success: true,
        collection,
        results,
        timestamp: timestamp()
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    } catch (error) {
      return new Response(JSON.stringify({ success: false, error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }

  if (path === "/api/db/collections" && method === "GET") {
    try {
      const tables = await env.DB.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
      ).all();

      return new Response(JSON.stringify({
        success: true,
        collections: (tables.results || []).map(t => t.name),
        count: (tables.results || []).length,
        timestamp: timestamp()
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    } catch (error) {
      return new Response(JSON.stringify({ success: false, error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }

  if (path.match(/^\/api\/db\/[^\/]+$/) && method === "DELETE") {
    const collection = sanitizeTable(path.split('/').pop());

    try {
      await env.DB.prepare(`DROP TABLE IF EXISTS "${collection}"`).run();

      return new Response(JSON.stringify({
        success: true,
        collection,
        deleted: true,
        message: `Collection "${collection}" deleted`,
        timestamp: timestamp()
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    } catch (error) {
      return new Response(JSON.stringify({ success: false, error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }

  return new Response(JSON.stringify({
    message: "D1 Database worker is running!",
    endpoints: [
      "GET /api/health",
      "GET /api/db/collections",
      "GET /api/db/:collection",
      "POST /api/db/:collection",
      "GET /api/db/:collection/:id",
      "PUT /api/db/:collection/:id",
      "DELETE /api/db/:collection/:id",
      "POST /api/db/:collection/query",
      "POST /api/db/:collection/batch",
      "DELETE /api/db/:collection"
    ]
  }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...corsHeaders }
  });
}

async function ensureTable(env, tableName) {
  const sql = `
    CREATE TABLE IF NOT EXISTS "${tableName}" (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `;

  try {
    await env.DB.prepare(sql).run();

    await env.DB.prepare(
      `CREATE INDEX IF NOT EXISTS idx_${tableName}_updatedAt ON "${tableName}"(updatedAt)`
    ).run();
  } catch (error) {
    console.error(`Error creating table ${tableName}:`, error);
  }
}
