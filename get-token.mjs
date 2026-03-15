// ============================================================
// get-token.mjs — One-time OAuth flow to get your refresh token
// Run this ONCE locally: node get-token.mjs
// Then copy the refresh token into Railway as GOOGLE_REFRESH_TOKEN
// ============================================================

import http from "http";
import { exec } from "child_process";

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("\nUsage:");
  console.error("  GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node get-token.mjs\n");
  console.error("Or on Windows PowerShell:");
  console.error('  $env:GOOGLE_CLIENT_ID="..."; $env:GOOGLE_CLIENT_SECRET="..."; node get-token.mjs\n');
  process.exit(1);
}

const REDIRECT_URI = "http://localhost:3456/callback";
const SCOPES = [
  "https://www.googleapis.com/auth/script.projects",
  "https://www.googleapis.com/auth/script.deployments",
  "https://www.googleapis.com/auth/drive.readonly",
].join(" ");

const authUrl =
  `https://accounts.google.com/o/oauth2/v2/auth` +
  `?client_id=${CLIENT_ID}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&access_type=offline` +
  `&prompt=consent`;

console.log("\n=== GAS Developer MCP — One-Time Auth ===\n");
console.log("Opening browser to authorize access...");
console.log("If it doesn't open automatically, paste this URL into your browser:\n");
console.log(authUrl);
console.log("\nWaiting for authorization...\n");

const platform = process.platform;
const openCmd = platform === "win32" ? `start "" "${authUrl}"` :
                platform === "darwin" ? `open "${authUrl}"` :
                `xdg-open "${authUrl}"`;
exec(openCmd);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost:3456");
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(400);
    res.end(`<h2>Authorization failed: ${error}</h2>`);
    console.error("Authorization failed:", error);
    server.close();
    return;
  }

  if (!code) {
    res.writeHead(400);
    res.end("<h2>No code received</h2>");
    return;
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri:  REDIRECT_URI,
        grant_type:    "authorization_code",
      }),
    });

    const tokens = await tokenRes.json();

    if (tokens.refresh_token) {
      res.writeHead(200);
      res.end(`
        <h2>✅ Authorization successful!</h2>
        <p>You can close this tab and return to your terminal.</p>
      `);

      console.log("\n✅ SUCCESS! Here is your refresh token:\n");
      console.log("─".repeat(60));
      console.log(tokens.refresh_token);
      console.log("─".repeat(60));
      console.log("\nAdd this to Railway as: GOOGLE_REFRESH_TOKEN\n");
      console.log("Keep it secret — it grants access to your Google account.\n");

    } else {
      res.writeHead(500);
      res.end(`<h2>Failed to get refresh token</h2><pre>${JSON.stringify(tokens, null, 2)}</pre>`);
      console.error("Token response:", tokens);
    }

  } catch (e) {
    res.writeHead(500);
    res.end(`<h2>Error: ${e.message}</h2>`);
    console.error("Error exchanging code:", e);
  }

  server.close();
});

server.listen(3456, () => {});