// ============================================================
// index.mjs — Google Apps Script Developer MCP
// ReRev Labs | Deploy on Railway
// Transport: Streamable HTTP (MCP protocol 2025-11-25)
// Migrated from SSE — SSE deprecated by Claude April 2026
// ============================================================
// Environment variables required:
//   GOOGLE_CLIENT_ID      — OAuth client ID from Google Cloud Console
//   GOOGLE_CLIENT_SECRET  — OAuth client secret
//   GOOGLE_REFRESH_TOKEN  — obtained via get-token.mjs (one-time)
// ============================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import fetch from "node-fetch";
import http from "http";
import { randomUUID } from "crypto";

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

// Session store for Streamable HTTP transport
const sessions = new Map();

function buildServer() {
  const server = new McpServer({ name: "gas-developer", version: "2.0.0" });

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
    "Get the full content of a GAS project — all .gs files and HTML files. Returns file names and source code. NOTE: For large projects (8+ files) this response may be truncated. Use gas_list_project_files to see the file list first, then gas_get_file to read individual files.",
    { scriptId: z.string().describe("The script ID (from gas_list_projects)") },
    async (p) => {
      const data = await api("GET", `/projects/${p.scriptId}/content`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "gas_list_project_files",
    "List all files in a GAS project — returns file names and types only, no source code. Use this first to see what files exist, then use gas_get_file to read individual files. Safe to use on any size project.",
    { scriptId: z.string().describe("The script ID of the project") },
    async (p) => {
      const data = await api("GET", `/projects/${p.scriptId}/content`);
      const files = (data.files || []).map(f => ({
        name: f.name,
        type: f.type,
        updateTime: f.updateTime || null,
      }));
      return { content: [{ type: "text", text: JSON.stringify({ scriptId: p.scriptId, files }, null, 2) }] };
    }
  );

  server.tool(
    "gas_get_file",
    "Get the source code of a single named file from a GAS project. Use this instead of gas_get_project for large projects to avoid response truncation.",
    {
      scriptId: z.string().describe("The script ID of the project"),
      filename: z.string().describe("Name of the file without extension (e.g. 'Config', 'Dashboard')"),
    },
    async (p) => {
      const data = await api("GET", `/projects/${p.scriptId}/content`);
      const file = (data.files || []).find(f => f.name === p.filename);
      if (!file) {
        const names = (data.files || []).map(f => f.name).join(", ");
        throw new Error(`File "${p.filename}" not found. Available files: ${names}`);
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            name: file.name,
            type: file.type,
            source: file.source,
            updateTime: file.updateTime || null,
          }, null, 2)
        }]
      };
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
      await api("PUT", `/projects/${p.scriptId}/content`, { files });
      return { content: [{ type: "text", text: JSON.stringify({ success: true, scriptId: p.scriptId, fileCount: files.length }, null, 2) }] };
    }
  );

  server.tool(
    "gas_update_file",
    "Update a single file in a GAS project without needing to pass all files. Fetches the current project server-side, replaces only the target file, and pushes the full updated array back. Use this instead of gas_update_project for large projects to avoid payload size limits.",
    {
      scriptId: z.string().describe("The script ID of the project"),
      filename: z.string().describe("Name of the file to update, without extension (e.g. 'Code', 'Dashboard')"),
      source: z.string().describe("The complete new source code for this file"),
    },
    async (p) => {
      // Step 1: Fetch current project fresh from Google
      const existing = await api("GET", `/projects/${p.scriptId}/content`);
      const currentFiles = existing.files || [];

      // Step 2: Find the target file
      const targetIndex = currentFiles.findIndex(f => f.name === p.filename);
      if (targetIndex === -1) {
        throw new Error(`File "${p.filename}" not found in project. Existing files: ${currentFiles.map(f => f.name).join(", ")}`);
      }

      // Step 3: Swap source for target file only, preserve everything else including manifest
      const updatedFiles = currentFiles.map(f => {
        if (f.name === p.filename) {
          return { name: f.name, type: f.type, source: p.source };
        }
        return f;
      });

      // Step 4: Push full updated array back
      await api("PUT", `/projects/${p.scriptId}/content`, { files: updatedFiles });

      // Step 5: Verify — re-fetch and confirm the file landed
      const verified = await api("GET", `/projects/${p.scriptId}/content`);
      const verifiedFile = (verified.files || []).find(f => f.name === p.filename);
      const landed = verifiedFile && verifiedFile.source === p.source;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            scriptId: p.scriptId,
            filename: p.filename,
            verified: landed,
            totalFiles: updatedFiles.length,
          }, null, 2)
        }]
      };
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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "gas-developer-mcp", transport: "streamable-http" }));
    return;
  }

  // Streamable HTTP transport — single /mcp endpoint handles all methods
  if (req.url === "/mcp" || req.url.startsWith("/mcp?")) {
    const sessionId = req.headers["mcp-session-id"];

    if (req.method === "DELETE") {
      if (sessionId && sessions.has(sessionId)) {
        const { transport } = sessions.get(sessionId);
        await transport.close();
        sessions.delete(sessionId);
      }
      res.writeHead(204); res.end();
      return;
    }

    if (req.method === "GET" || req.method === "POST") {
      let transport;
      let server;

      if (sessionId && sessions.has(sessionId)) {
        ({ transport, server } = sessions.get(sessionId));
      } else {
        const newSessionId = randomUUID();
        server = buildServer();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
          onsessioninitialized: (sid) => {
            sessions.set(sid, { transport, server });
          },
        });
        transport.onclose = () => {
          sessions.delete(newSessionId);
        };
        await server.connect(transport);
      }

      await transport.handleRequest(req, res);
      return;
    }
  }

  res.writeHead(404);
  res.end("Not found");
});

httpServer.listen(PORT, () => {
  console.log(`GAS Developer MCP (Streamable HTTP) running on port ${PORT}`);
});
