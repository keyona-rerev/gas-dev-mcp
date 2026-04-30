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
  const server = new McpServer({ name: "gas-developer", version: "2.1.0" });

  // Session-level instructions — injected into Claude's context at connection time
  server.setInstructions(
    "When working with Google Apps Script projects, always start by calling gas_list_project_files to get the complete file inventory. " +
    "Use gas_get_file for reading individual files and gas_update_file for making changes to a single file. " +
    "Avoid gas_update_project unless you need to rewrite all files at once; if you use it, call gas_list_project_files first and set forceDelete: true only after confirming which files should be removed."
  );

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
    "Get the full content of a GAS project (all files with source). Validates completeness against a metadata preflight — throws a clear error if the Google API returns a truncated response, directing you to use gas_list_project_files + gas_get_file instead.",
    { scriptId: z.string().describe("The script ID (from gas_list_projects)") },
    async (p) => {
      // Preflight: get reliable file count using metadata-only call (tiny payload, never truncated)
      const meta = await api("GET", `/projects/${p.scriptId}/content?fields=files(name,type)`);
      const expectedCount = (meta.files || []).length;

      // Full content fetch
      const full = await api("GET", `/projects/${p.scriptId}/content`);
      const receivedCount = (full.files || []).length;

      if (receivedCount !== expectedCount) {
        throw new Error(
          `Incomplete response: expected ${expectedCount} files but received ${receivedCount}. ` +
          `The project is too large for a single API call. Use 'gas_list_project_files' for the file inventory, then 'gas_get_file' for each file's source.`
        );
      }

      return { content: [{ type: "text", text: JSON.stringify(full, null, 2) }] };
    }
  );

  server.tool(
    "gas_list_project_files",
    "List all files in a GAS project — names and types only, no source code. Always returns the complete file inventory even for very large projects. Use this first before any read or write operation to establish the current file baseline.",
    { scriptId: z.string().describe("The script ID of the project") },
    async (p) => {
      // Use fields param to request metadata only — response is tiny, never truncated by Google API
      const data = await api("GET", `/projects/${p.scriptId}/content?fields=files(name,type)`);
      return { content: [{ type: "text", text: JSON.stringify({ scriptId: p.scriptId, files: data.files || [] }, null, 2) }] };
    }
  );

  server.tool(
    "gas_get_file",
    "Get the source code of a single named file from a GAS project. Always call gas_list_project_files first to confirm the file exists. Use this instead of gas_get_project for large projects.",
    {
      scriptId: z.string().describe("The script ID of the project"),
      filename: z.string().describe("Name of the file without extension (e.g. 'Config', 'Dashboard')"),
    },
    async (p) => {
      // Preflight: reliable file list
      const meta = await api("GET", `/projects/${p.scriptId}/content?fields=files(name,type)`);
      const expectedNames = (meta.files || []).map(f => f.name);

      if (!expectedNames.includes(p.filename)) {
        throw new Error(`File "${p.filename}" not found. Available files: ${expectedNames.join(", ")}`);
      }

      // Full fetch for source — validated against preflight
      const full = await api("GET", `/projects/${p.scriptId}/content`);
      const file = (full.files || []).find(f => f.name === p.filename);

      if (!file) {
        throw new Error(
          `File "${p.filename}" missing from full fetch (Google API may have truncated the response). ` +
          `Expected ${expectedNames.length} files. Try again or report the truncation.`
        );
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
    "⚠️ DESTRUCTIVE. Update ALL files in a GAS project. Any file NOT included will be PERMANENTLY DELETED. You MUST call gas_list_project_files first to see the exact current file list before calling this. To confirm deletion of omitted files, set forceDelete: true. Prefer gas_update_file for single-file changes.",
    {
      scriptId: z.string(),
      files: z.array(z.object({
        name: z.string().describe("File name without extension"),
        type: z.enum(["SERVER_JS", "HTML"]).describe("SERVER_JS for .gs files, HTML for .html files"),
        source: z.string().describe("Full file source code"),
      })).describe("Complete list of all files in the project"),
      forceDelete: z.boolean().optional().default(false)
        .describe("Must be set to true to allow pushing fewer files than the current project has (i.e., to permanently delete files)."),
    },
    async (p) => {
      // Preflight: get current file count using safe metadata-only call
      const meta = await api("GET", `/projects/${p.scriptId}/content?fields=files(name,type)`);
      const existingCount = (meta.files || []).length;
      const incomingCount = p.files.length;

      if (incomingCount < existingCount && !p.forceDelete) {
        throw new Error(
          `⚠️ REFUSED: This push would delete ${existingCount - incomingCount} file(s). ` +
          `Current project has ${existingCount} files; you supplied only ${incomingCount}. ` +
          `Call gas_list_project_files to see what exists, then either include all files or set forceDelete: true to confirm the deletion.`
        );
      }

      // Preserve manifest
      const manifest = (meta.files || []).find(f => f.name === "appsscript");
      const finalFiles = (manifest && !p.files.some(f => f.name === "appsscript"))
        ? [manifest, ...p.files]
        : p.files;

      await api("PUT", `/projects/${p.scriptId}/content`, { files: finalFiles });

      // Verify final state
      const verify = await api("GET", `/projects/${p.scriptId}/content?fields=files(name)`);
      const finalCount = (verify.files || []).length;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            scriptId: p.scriptId,
            fileCount: finalCount,
            deleted: existingCount - finalCount > 0 ? existingCount - finalCount : 0,
          }, null, 2)
        }]
      };
    }
  );

  server.tool(
    "gas_update_file",
    "Safely update a single file in a GAS project without affecting any other files. Preferred workflow: call gas_list_project_files first to confirm the current file list, then gas_get_file to read the file you want to change, then call this tool with the new source.",
    {
      scriptId: z.string().describe("The script ID of the project"),
      filename: z.string().describe("Name of the file to update, without extension (e.g. 'Code', 'Dashboard')"),
      source: z.string().describe("The complete new source code for this file"),
    },
    async (p) => {
      // Step 1: Reliable file list — confirms file exists and gives us expected count
      const meta = await api("GET", `/projects/${p.scriptId}/content?fields=files(name,type)`);
      const expectedNames = (meta.files || []).map(f => f.name);

      if (!expectedNames.includes(p.filename)) {
        throw new Error(`File "${p.filename}" not found. Available files: ${expectedNames.join(", ")}`);
      }

      // Step 2: Full fetch — validated against preflight count
      const full = await api("GET", `/projects/${p.scriptId}/content`);
      if ((full.files || []).length !== expectedNames.length) {
        throw new Error(
          `Project content fetch was incomplete: expected ${expectedNames.length} files but got ${(full.files || []).length}. ` +
          `The Google API truncated the response. Cannot safely write — doing so would delete files. ` +
          `Use gas_get_file to read individual files; report this truncation.`
        );
      }

      const currentFiles = full.files;

      // Step 3: Swap only the target file
      const updatedFiles = currentFiles.map(f =>
        f.name === p.filename
          ? { name: f.name, type: f.type, source: p.source }
          : f
      );

      // Step 4: Push full updated array back
      await api("PUT", `/projects/${p.scriptId}/content`, { files: updatedFiles });

      // Step 5: Verify the file landed
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
            totalFiles: (verified.files || []).length,
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
    res.end(JSON.stringify({ status: "ok", service: "gas-developer-mcp", version: "2.1.0", transport: "streamable-http" }));
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
  console.log(`GAS Developer MCP (Streamable HTTP) v2.1.0 running on port ${PORT}`);
});
