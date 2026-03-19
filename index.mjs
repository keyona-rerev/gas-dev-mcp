// ============================================================
// index.mjs — Google Apps Script Developer MCP (SSE Transport)
// ReRev Labs | Deploy on Railway
// ============================================================
// Environment variables required:
//   GOOGLE_CLIENT_ID      — OAuth client ID from Google Cloud Console
//   GOOGLE_CLIENT_SECRET  — OAuth client secret
//   GOOGLE_REFRESH_TOKEN  — obtained via get-token.mjs (one-time)
// ============================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import fetch from "node-fetch";
import http from "http";

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const PORT          = process.env.PORT || 3000;

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error("FATAL: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN must be set");
  process.exit(1);
}

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type:    "refresh_token",
    }),
  });

  const data = await res.json();
  if (!data.access_token) throw new Error("Token refresh failed: " + JSON.stringify(data));

  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in * 1000);
  return cachedToken;
}

async function api(method, path, body) {
  const token = await getAccessToken();
  const res = await fetch(`https://script.googleapis.com/v1${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  try {
    const json = JSON.parse(text);
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json;
  } catch (e) {
    if (e.message.includes("json.error")) throw e;
    throw new Error(`API error ${res.status}: ${text}`);
  }
}

async function driveApi(method, path, body) {
  const token = await getAccessToken();
  const res = await fetch(`https://www.googleapis.com/drive/v3${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json;
}

const transports = new Map();

function buildServer() {
  const server = new McpServer({ name: "gas-developer", version: "1.0.0" });

  server.tool(
    "gas_list_projects",
    "List all Google Apps Script projects in the connected Google account. Returns scriptId, title, and createTime.",
    { query: z.string().optional().describe("Optional name filter") },
    async (p) => {
      let q = "mimeType='application/vnd.google-apps.script' and trashed=false";
      if (p.query) q += ` and name contains '${p.query.replace(/'/g, "\\'")}'`;
      const data = await driveApi("GET", `/files?q=${encodeURIComponent(q)}&fields=files(id,name,createdTime,modifiedTime)`);
      const projects = (data.files || []).map(f => ({
        scriptId: f.id,
        title: f.name,
        createdTime: f.createdTime,
        modifiedTime: f.modifiedTime,
      }));
      return { content: [{ type: "text", text: JSON.stringify(projects, null, 2) }] };
    }
  );

  server.tool(
    "gas_get_project",
    "Get the full content of a GAS project — all .gs files and HTML files. Returns file names and source code.",
    { scriptId: z.string().describe("The script ID (from gas_list_projects)") },
    async (p) => {
      const data = await api("GET", `/projects/${p.scriptId}/content`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "gas_update_project",
    "Update the files in a GAS project. Pass the complete array of files — any file not included will be deleted. Always include ALL files, not just the ones you changed.",
    {
      scriptId: z.string(),
      files: z.array(z.object({
        name: z.string().describe("File name without extension"),
        type: z.enum(["SERVER_JS", "HTML"]).describe("SERVER_JS for .gs files, HTML for .html files"),
        source: z.string().describe("Full file source code"),
      })).describe("Complete list of all files in the project"),
    },
    async (p) => {
      const existing = await api("GET", `/projects/${p.scriptId}/content`);
      const manifest = (existing.files || []).find(f => f.name === "appsscript");
      const files = (manifest && !p.files.some(f => f.name === "appsscript"))
        ? [manifest, ...p.files]
        : p.files;
      const data = await api("PUT", `/projects/${p.scriptId}/content`, { files });
      return { content: [{ type: "text", text: JSON.stringify({ success: true, scriptId: p.scriptId, fileCount: files.length }, null, 2) }] };
    }
  );

  server.tool(
    "gas_create_project",
    "Create a new Google Apps Script project.",
    {
      title: z.string().describe("Project name"),
      parentId: z.string().optional().describe("Optional Google Drive folder ID to create the project in"),
    },
    async (p) => {
      const body = { title: p.title };
      if (p.parentId) body.parentId = p.parentId;
      const data = await api("POST", "/projects", body);
      return { content: [{ type: "text", text: JSON.stringify({ scriptId: data.scriptId, title: data.title }, null, 2) }] };
    }
  );

  server.tool(
    "gas_list_deployments",
    "List all deployments of a GAS project. Returns deployment IDs, URLs, and versions.",
    { scriptId: z.string() },
    async (p) => {
      const data = await api("GET", `/projects/${p.scriptId}/deployments`);
      return { content: [{ type: "text", text: JSON.stringify(data.deployments || [], null, 2) }] };
    }
  );

  server.tool(
    "gas_create_deployment",
    "Deploy a GAS project as a web app or API executable. Creates a new versioned deployment.",
    {
      scriptId: z.string(),
      description: z.string().optional().describe("Deployment description / version note"),
      manifestFileName: z.string().optional().default("appsscript").describe("Manifest file name, usually 'appsscript'"),
    },
    async (p) => {
      const version = await api("POST", `/projects/${p.scriptId}/versions`, {
        description: p.description || "Deployed via MCP",
      });
      const deployment = await api("POST", `/projects/${p.scriptId}/deployments`, {
        versionNumber: version.versionNumber,
        manifestFileName: p.manifestFileName || "appsscript",
        description: p.description || "Deployed via MCP",
      });
      return { content: [{ type: "text", text: JSON.stringify(deployment, null, 2) }] };
    }
  );

  server.tool(
    "gas_run_function",
    "Execute a function in a deployed GAS project and return the result. The project must be deployed as an API executable.",
    {
      scriptId: z.string(),
      functionName: z.string().describe("Name of the function to run"),
      parameters: z.array(z.any()).optional().describe("Array of parameters to pass to the function"),
      devMode: z.boolean().optional().default(false).describe("If true, runs the latest saved code instead of a deployment"),
    },
    async (p) => {
      const data = await api("POST", `/scripts/${p.scriptId}:run`, {
        function: p.functionName,
        parameters: p.parameters || [],
        devMode: p.devMode || false,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "gas_get_project_metadata",
    "Get metadata for a GAS project including title, scriptId, createTime, and updateTime.",
    { scriptId: z.string() },
    async (p) => {
      const data = await api("GET", `/projects/${p.scriptId}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  return server;
}

const httpServer = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "gas-developer-mcp" }));
    return;
  }

  if (req.method === "GET" && req.url === "/mcp") {
    const server = buildServer();
    const transport = new SSEServerTransport("/messages", res);
    transports.set(transport.sessionId, transport);
    res.on("close", () => transports.delete(transport.sessionId));
    await server.connect(transport);
    return;
  }

  if (req.method === "POST" && req.url.startsWith("/messages")) {
    const url = new URL(req.url, "http://localhost");
    const sessionId = url.searchParams.get("sessionId");
    const transport = transports.get(sessionId);
    if (!transport) { res.writeHead(404); res.end(JSON.stringify({ error: "Session not found" })); return; }
    await transport.handlePostMessage(req, res);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

httpServer.listen(PORT, () => {
  console.log(`GAS Developer MCP (SSE) running on port ${PORT}`);
});
