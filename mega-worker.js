const userSessions = new Map();

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getMimeType(ext) {
  const mimeTypes = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.json': 'application/json',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

async function findFileByPath(storage, filePath) {
  const parts = filePath.split('/').filter(p => p);
  let current = storage.root;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const found = current.children?.find(child => child.name === part);
    if (!found) return null;
    if (i === parts.length - 1) return found;
    if (!found.directory) return null;
    current = found;
  }
  return current;
}

async function findFolderByPath(storage, folderPath) {
  const parts = folderPath.split('/').filter(p => p);
  let current = storage.root;
  for (const part of parts) {
    const found = current.children?.find(child => child.name === part && child.directory);
    if (!found) return null;
    current = found;
  }
  return current;
}

async function ensureFolderPath(storage, folderPath) {
  const parts = folderPath.split('/').filter(p => p);
  let current = storage.root;
  for (const part of parts) {
    let existing = current.children?.find(child => child.name === part && child.directory);
    if (!existing) {
      existing = await new Promise((resolve, reject) => {
        current.mkdir(part, (err, folder) => {
          if (err) reject(err);
          else resolve(folder);
        });
      });
    }
    current = existing;
  }
  return current;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range",
  "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges",
};

function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

addEventListener("fetch", event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === "OPTIONS") {
    return handleOptions();
  }

  if (path === "/api/health" && method === "GET") {
    return new Response(JSON.stringify({
      status: "ok",
      role: "mega",
      timestamp: new Date().toISOString(),
      message: "MEGA worker is running!",
      sessions: userSessions.size
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  if (path === "/api/storage/init" && method === "POST") {
    try {
      const body = await request.json();
      const { email, password } = body;

      if (!email || !password) {
        return new Response(JSON.stringify({ success: false, error: "Email and password required" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      const { Storage } = await import("megajs");
      const storage = await new Storage({ email, password }).ready;

      const accountInfo = await new Promise((resolve, reject) => {
        storage.getAccountInfo((err, info) => {
          if (err) reject(err);
          else resolve(info);
        });
      });

      const sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
      userSessions.set(sessionId, { storage, email, root: storage.root });

      return new Response(JSON.stringify({
        success: true,
        sessionId,
        user: { email, name: storage.name || email.split('@')[0] },
        storage: {
          used: accountInfo.spaceUsed,
          total: accountInfo.spaceTotal,
          usedFormatted: formatBytes(accountInfo.spaceUsed),
          totalFormatted: formatBytes(accountInfo.spaceTotal),
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    } catch (error) {
      return new Response(JSON.stringify({ success: false, error: "Authentication failed" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }

  if (path === "/api/storage/info" && method === "GET") {
    try {
      const sessionId = url.searchParams.get("sessionId");

      if (!sessionId || !userSessions.has(sessionId)) {
        return new Response(JSON.stringify({ success: false, error: "Invalid session" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      const { storage, email } = userSessions.get(sessionId);

      const accountInfo = await new Promise((resolve, reject) => {
        storage.getAccountInfo((err, info) => {
          if (err) reject(err);
          else resolve(info);
        });
      });

      return new Response(JSON.stringify({
        success: true,
        user: { email, name: storage.name || email.split('@')[0] },
        storage: {
          used: accountInfo.spaceUsed,
          total: accountInfo.spaceTotal,
          usedFormatted: formatBytes(accountInfo.spaceUsed),
          totalFormatted: formatBytes(accountInfo.spaceTotal),
          percentUsed: ((accountInfo.spaceUsed / accountInfo.spaceTotal) * 100).toFixed(1),
        },
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

  if (path === "/api/storage/list" && method === "GET") {
    try {
      const sessionId = url.searchParams.get("sessionId");
      const folder = url.searchParams.get("folder") || "/";

      if (!sessionId || !userSessions.has(sessionId)) {
        return new Response(JSON.stringify({ success: false, error: "Invalid session" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      const { storage } = userSessions.get(sessionId);

      let targetFolder = storage.root;
      if (folder !== "/") {
        targetFolder = await findFolderByPath(storage, folder);
        if (!targetFolder) {
          return new Response(JSON.stringify({ success: false, error: "Folder not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }
      }

      const files = (targetFolder.children || []).map(child => ({
        name: child.name,
        size: child.size,
        sizeFormatted: formatBytes(child.size || 0),
        nodeId: child.nodeId,
        isDirectory: child.directory || false,
        timestamp: child.timestamp,
        mimeType: child.directory ? "folder" : getMimeType(path.extname(child.name).toLowerCase()),
      }));

      return new Response(JSON.stringify({ success: true, folder, files, count: files.length }), {
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

  if (path === "/api/storage/create-folder" && method === "POST") {
    try {
      const body = await request.json();
      const { sessionId, folderPath } = body;

      if (!sessionId || !userSessions.has(sessionId)) {
        return new Response(JSON.stringify({ success: false, error: "Invalid session" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      const { storage } = userSessions.get(sessionId);
      const newFolder = await ensureFolderPath(storage, folderPath);

      return new Response(JSON.stringify({
        success: true,
        message: `Folder created: ${folderPath}`,
        folder: { name: newFolder.name, nodeId: newFolder.nodeId, path: folderPath },
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

  if (path === "/api/storage/get-url" && method === "POST") {
    try {
      const body = await request.json();
      const { sessionId, filePath, makePublic = true } = body;

      if (!sessionId || !userSessions.has(sessionId)) {
        return new Response(JSON.stringify({ success: false, error: "Invalid session" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      const { storage } = userSessions.get(sessionId);
      const fileNode = await findFileByPath(storage, filePath);

      if (!fileNode) {
        return new Response(JSON.stringify({ success: false, error: "File not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      let url = null;
      if (makePublic) {
        url = await new Promise((resolve, reject) => {
          fileNode.link((err, link) => {
            if (err) reject(err);
            else resolve(link);
          });
        });
      }

      const ext = path.extname(fileNode.name).toLowerCase();
      const mimeType = getMimeType(ext);
      const isVideo = mimeType.startsWith('video/');
      const isImage = mimeType.startsWith('image/');

      return new Response(JSON.stringify({
        success: true,
        url,
        type: "public_link",
        metadata: {
          name: fileNode.name,
          size: fileNode.size,
          sizeFormatted: formatBytes(fileNode.size),
          mimeType,
          isVideo,
          isImage,
        },
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

  if (path === "/api/storage/delete" && method === "POST") {
    try {
      const body = await request.json();
      const { sessionId, filePath, permanent = false } = body;

      if (!sessionId || !userSessions.has(sessionId)) {
        return new Response(JSON.stringify({ success: false, error: "Invalid session" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      const { storage } = userSessions.get(sessionId);
      const fileNode = await findFileByPath(storage, filePath);

      if (!fileNode) {
        return new Response(JSON.stringify({ success: false, error: "File not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      await new Promise((resolve, reject) => {
        fileNode.delete(permanent, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      return new Response(JSON.stringify({
        success: true,
        message: permanent ? "File permanently deleted" : "File moved to trash",
        path: filePath,
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

  if (path === "/api/storage/logout" && method === "POST") {
    try {
      const body = await request.json();
      const { sessionId } = body;

      if (sessionId && userSessions.has(sessionId)) {
        const { storage } = userSessions.get(sessionId);
        storage.close();
        userSessions.delete(sessionId);
      }

      return new Response(JSON.stringify({ success: true, message: "Logged out" }), {
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
    message: "MEGA worker is running!",
    endpoints: [
      "GET /api/health",
      "POST /api/storage/init",
      "GET /api/storage/info",
      "GET /api/storage/list",
      "POST /api/storage/create-folder",
      "POST /api/storage/get-url",
      "POST /api/storage/delete",
      "POST /api/storage/logout"
    ]
  }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...corsHeaders }
  });
}
