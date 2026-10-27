import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 4173);
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
};

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url || "/", "http://localhost").pathname);
    let relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
    if (["lc-patterns-30.html", "app.js", "patterns-data.js"].includes(relativePath)) relativePath = `public/${relativePath}`;

    let absolutePath = resolve(root, relativePath);
    if (!absolutePath.startsWith(root + sep) && absolutePath !== resolve(root, "index.html")) {
      response.writeHead(403).end("Forbidden");
      return;
    }

    // Browser module imports omit the .ts extension; resolve those to source files.
    if (!extname(absolutePath)) absolutePath += ".ts";

    const extension = extname(absolutePath);
    let content = await readFile(absolutePath, "utf8");
    if (extension === ".ts") {
      content = stripTypeScriptTypes(content, { mode: "strip", sourceUrl: pathname });
    }

    response.writeHead(200, {
      "Content-Type": contentTypes[extension] || "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(content);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`DSA Animations is running at http://127.0.0.1:${port}`);
});

