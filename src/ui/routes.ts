import { serveStatic } from "@hono/node-server/serve-static";
import type { Context, Hono } from "hono";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const uiDistRoot = "./ui/dist";
const uiIndexPath = join(process.cwd(), "ui/dist/index.html");

export function registerUiRoutes(app: Hono): void {
  app.use(
    "/app/assets/*",
    serveStatic({
      root: uiDistRoot,
      rewriteRequestPath: (path) => path.replace(/^\/app/, ""),
    }),
  );

  app.get("/app", serveUiIndex);
  app.get("/app/calls/:call_id", serveUiIndex);
}

async function serveUiIndex(c: Context): Promise<Response> {
  try {
    return c.html(await readFile(uiIndexPath, "utf8"));
  } catch {
    return c.html(
      [
        "<!doctype html>",
        '<html lang="en">',
        "<head>",
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        "<title>GKHR Interview Assistant</title>",
        "</head>",
        "<body>",
        "<h1>GKHR Interview Assistant</h1>",
        "<p>The UI bundle has not been built yet. Run <code>npm run build:ui</code>, then reload this page.</p>",
        "</body>",
        "</html>",
      ].join(""),
      503,
    );
  }
}
