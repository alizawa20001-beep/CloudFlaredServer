// LAB WORKER — serves user-uploaded static files
// FILES are injected at deploy time as a JSON object mapping filename -> base64 content
addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

const FILES = __FILES_PLACEHOLDER__;

const MIME = {
  html: "text/html;charset=UTF-8",
  htm: "text/html;charset=UTF-8",
  css: "text/css;charset=UTF-8",
  js: "application/javascript;charset=UTF-8",
  mjs: "application/javascript;charset=UTF-8",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  webp: "image/webp",
  txt: "text/plain;charset=UTF-8",
  xml: "text/xml;charset=UTF-8",
  pdf: "application/pdf",
  zip: "application/zip",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  wasm: "application/wasm",
  map: "application/json",
};

async function handleRequest(request) {
  const url = new URL(request.url);
  let path = url.pathname.replace(/^\/+/, "") || "index.html";

  const raw = FILES[path];
  if (raw === undefined) {
    return new Response("Not Found", { status: 404 });
  }

  const ext = path.split(".").pop().toLowerCase();
  const contentType = MIME[ext] || "application/octet-stream";

  try {
    const binary = atob(raw);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new Response(bytes, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return new Response(raw, {
      headers: { "Content-Type": contentType },
    });
  }
}
