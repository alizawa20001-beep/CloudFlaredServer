const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range, Authorization",
  "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, ETag",
};

function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getMimeType(filename) {
  const ext = filename.split('.').pop()?.toLowerCase();
  const mimeTypes = {
    'mp4': 'video/mp4',
    'webm': 'video/webm',
    'mov': 'video/quicktime',
    'avi': 'video/x-msvideo',
    'mkv': 'video/x-matroska',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'mp3': 'audio/mpeg',
    'wav': 'audio/wav',
    'ogg': 'audio/ogg',
    'pdf': 'application/pdf',
    'json': 'application/json',
    'txt': 'text/plain'
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

function generateId() {
  return crypto.randomUUID();
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
      role: "r2-storage",
      timestamp: new Date().toISOString(),
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  if (path === "/api/storage/list" && method === "GET") {
    try {
      const prefix = url.searchParams.get("prefix") || "";
      const limit = parseInt(url.searchParams.get("limit") || "1000");
      const objects = await R2_BUCKET.list({ prefix, limit });
      const files = objects.objects.map(obj => ({
        key: obj.key,
        name: obj.key.split('/').pop(),
        size: obj.size,
        sizeFormatted: formatBytes(obj.size),
        uploaded: obj.uploaded,
        etag: obj.etag,
        storageClass: obj.storageClass,
        httpMetadata: obj.httpMetadata
      }));
      return new Response(JSON.stringify({
        success: true,
        count: files.length,
        files: files,
        truncated: objects.truncated,
        cursor: objects.cursor
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }

  if (path === "/api/storage/upload" && method === "POST") {
    try {
      const formData = await request.formData();
      const file = formData.get("file");
      const key = formData.get("key") || file.name;
      const prefix = formData.get("prefix") || "";
      if (!file) {
        return new Response(JSON.stringify({ error: "No file provided" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
      const fullKey = prefix ? `${prefix}/${key}` : key;
      const fileBuffer = await file.arrayBuffer();
      await R2_BUCKET.put(fullKey, fileBuffer, {
        httpMetadata: {
          contentType: file.type || getMimeType(key),
          contentDisposition: `inline; filename="${key}"`
        },
        customMetadata: {
          uploadedAt: new Date().toISOString(),
          originalName: file.name,
          size: file.size.toString()
        }
      });
      return new Response(JSON.stringify({
        success: true,
        key: fullKey,
        name: key,
        size: file.size,
        sizeFormatted: formatBytes(file.size),
        uploadedAt: new Date().toISOString()
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }

  if (path.startsWith("/api/storage/get/") && method === "GET") {
    try {
      const key = path.replace("/api/storage/get/", "");
      const object = await R2_BUCKET.get(key);
      if (!object) {
        return new Response(JSON.stringify({ error: "File not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
      const headers = {
        "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
        "Content-Length": object.size,
        "ETag": object.httpEtag,
        "Last-Modified": object.uploaded.toUTCString(),
        "Cache-Control": "public, max-age=3600",
        ...corsHeaders
      };
      const range = request.headers.get("Range");
      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : object.size - 1;
        const chunkSize = end - start + 1;
        const chunk = await object.slice(start, end + 1);
        headers["Content-Range"] = `bytes ${start}-${end}/${object.size}`;
        headers["Content-Length"] = chunkSize;
        headers["Accept-Ranges"] = "bytes";
        return new Response(chunk.body, {
          status: 206,
          headers: headers
        });
      }
      return new Response(object.body, {
        status: 200,
        headers: headers
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }

  if (path.startsWith("/api/storage/delete/") && method === "DELETE") {
    try {
      const key = path.replace("/api/storage/delete/", "");
      await R2_BUCKET.delete(key);
      return new Response(JSON.stringify({
        success: true,
        key: key,
        deleted: true
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }

  if (path === "/api/storage/folder" && method === "POST") {
    try {
      const { folderPath, prefix } = await request.json();
      if (!folderPath) {
        return new Response(JSON.stringify({ error: "folderPath required" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
      const fullPath = prefix ? `${prefix}/${folderPath}/` : `${folderPath}/`;
      await R2_BUCKET.put(fullPath, "", {
        httpMetadata: { contentType: "application/x-directory" }
      });
      return new Response(JSON.stringify({
        success: true,
        folder: fullPath,
        created: true
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }

  if (path.startsWith("/api/storage/folder/") && method === "DELETE") {
    try {
      const folderPath = path.replace("/api/storage/folder/", "");
      const list = await R2_BUCKET.list({ prefix: folderPath });
      for (const obj of list.objects) {
        await R2_BUCKET.delete(obj.key);
      }
      return new Response(JSON.stringify({
        success: true,
        folder: folderPath,
        deletedCount: list.objects.length
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }

  if (path === "/api/storage/info" && method === "GET") {
    try {
      const objects = await R2_BUCKET.list({ limit: 1000 });
      let totalSize = 0;
      let fileCount = 0;
      for (const obj of objects.objects) {
        totalSize += obj.size;
        fileCount++;
      }
      return new Response(JSON.stringify({
        success: true,
        storageType: "r2",
        storage: {
          used: totalSize,
          usedFormatted: formatBytes(totalSize),
          fileCount: fileCount
        }
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }

  return new Response(JSON.stringify({
    name: "Cloudflare R2 Storage Worker",
    version: "1.0.0",
    endpoints: {
      "GET /api/health": "Health check",
      "GET /api/storage/list?prefix=&limit=": "List files",
      "POST /api/storage/upload": "Upload file (multipart/form-data)",
      "GET /api/storage/get/:key": "Download/stream file",
      "DELETE /api/storage/delete/:key": "Delete file",
      "POST /api/storage/folder": "Create folder",
      "DELETE /api/storage/folder/:path": "Delete folder and contents",
      "GET /api/storage/info": "Get storage info"
    }
  }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...corsHeaders }
  });
}
