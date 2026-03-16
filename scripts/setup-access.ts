#!/usr/bin/env npx tsx
/**
 * Interactive setup script for Cloudflare Access.
 *
 * Usage: npx tsx scripts/setup-access.ts
 *
 * Prerequisites:
 *   - CF API Token with these permissions:
 *     - Account > Access: Organizations, Identity Providers, and Groups > Read
 *     - Account > Access: Apps and Policies > Edit
 *   - wrangler CLI installed and logged in
 *
 * What it does:
 *   1. Fetches account info from CF API
 *   2. Creates a main Access Application (protects workers.dev domain)
 *   3. Creates a webhook bypass Application (/webhook/* path, Bypass policy)
 *   4. Sets CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD as Worker secrets
 */

import * as readline from "node:readline";
import { execSync } from "node:child_process";

const WORKER_NAME = "multibot";

// -- Helpers --

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function cfApi(
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<any> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!data.success) {
    console.error("CF API error:", JSON.stringify(data.errors, null, 2));
    throw new Error(`CF API failed: ${path}`);
  }
  return data.result;
}

// -- Main --

async function main() {
  console.log("\n=== Multibot CF Access Setup ===\n");

  const cfToken = await prompt("CF API Token (needs: Access: Organizations...Read, Access: Apps...Edit, Workers KV Storage: Edit): ");
  if (!cfToken) {
    console.error("Token is required");
    process.exit(1);
  }

  const email = await prompt("Your CF Access login email (will be used as ownerId): ");
  if (!email) {
    console.error("Email is required");
    process.exit(1);
  }

  // 1. Get account info
  console.log("\n[1/5] Fetching account info...");
  const accounts = await cfApi(cfToken, "GET", "/accounts?per_page=1");
  const accountId = accounts[0].id;
  const accountName = accounts[0].name;
  console.log(`  Account: ${accountName} (${accountId})`);

  // 2. Get Zero Trust team domain
  console.log("\n[2/5] Fetching Zero Trust settings...");
  let teamDomain: string;
  try {
    const ztSettings = await cfApi(cfToken, "GET", `/accounts/${accountId}/access/organizations`);
    teamDomain = ztSettings.auth_domain; // e.g., "myteam.cloudflareaccess.com"
    console.log(`  Team domain: ${teamDomain}`);
  } catch {
    console.error("  Could not fetch Zero Trust org. Make sure Zero Trust is enabled for your account.");
    console.error("  Visit: https://one.dash.cloudflare.com/ to set up Zero Trust first.");
    process.exit(1);
  }

  // 3. Create main Access Application
  // Derive worker domain from wrangler.toml BASE_URL or ask user
  console.log("\n[3/5] Creating Access Application for workers.dev...");
  let workerDomain: string;
  try {
    const toml = require("node:fs").readFileSync("wrangler.toml", "utf-8");
    const match = toml.match(/BASE_URL\s*=\s*"https?:\/\/([^"]+)"/);
    if (match && !match[1].includes("__")) {
      workerDomain = match[1];
      console.log(`  Detected domain from wrangler.toml: ${workerDomain}`);
    } else {
      throw new Error("placeholder");
    }
  } catch {
    const inputDomain = await prompt(`Enter your worker domain (e.g. ${WORKER_NAME}.<subdomain>.workers.dev): `);
    if (!inputDomain) {
      console.error("Domain is required");
      process.exit(1);
    }
    workerDomain = inputDomain;
  }

  // Check if app already exists
  const existingApps = await cfApi(cfToken, "GET", `/accounts/${accountId}/access/apps`);
  let mainApp = existingApps.find((a: any) => a.name === "multibot" && a.domain === workerDomain);

  if (mainApp) {
    console.log(`  App already exists (AUD: ${mainApp.aud})`);
  } else {
    mainApp = await cfApi(cfToken, "POST", `/accounts/${accountId}/access/apps`, {
      name: "multibot",
      domain: workerDomain,
      type: "self_hosted",
      session_duration: "24h",
      auto_redirect_to_identity: false,
      allowed_idps: [], // will use default IdPs configured in Zero Trust
    });
    console.log(`  Created app (AUD: ${mainApp.aud})`);

    // Create an Allow policy for the email
    await cfApi(cfToken, "POST", `/accounts/${accountId}/access/apps/${mainApp.id}/policies`, {
      name: "Allow owner",
      decision: "allow",
      include: [{ email: { email } }],
    });
    console.log(`  Created Allow policy for ${email}`);
  }

  // 4. Create webhook bypass Application
  console.log("\n[4/5] Creating webhook bypass Application...");
  let bypassApp = existingApps.find((a: any) => a.name === "multibot-webhook-bypass");

  if (bypassApp) {
    console.log("  Bypass app already exists");
  } else {
    bypassApp = await cfApi(cfToken, "POST", `/accounts/${accountId}/access/apps`, {
      name: "multibot-webhook-bypass",
      domain: `${workerDomain}/webhook`,
      type: "self_hosted",
      session_duration: "24h",
    });
    console.log("  Created bypass app");

    // Create Bypass policy (everyone can access /webhook/*)
    await cfApi(cfToken, "POST", `/accounts/${accountId}/access/apps/${bypassApp.id}/policies`, {
      name: "Bypass webhooks",
      decision: "bypass",
      include: [{ everyone: {} }],
    });
    console.log("  Created Bypass policy (everyone)");
  }

  // 5. Set Worker secrets
  console.log("\n[5/5] Setting Worker secrets...");
  try {
    execSync(`echo "${teamDomain}" | npx wrangler secret put CF_ACCESS_TEAM_DOMAIN --name ${WORKER_NAME}`, {
      stdio: "inherit",
    });
    execSync(`echo "${mainApp.aud}" | npx wrangler secret put CF_ACCESS_AUD --name ${WORKER_NAME}`, {
      stdio: "inherit",
    });
    console.log("  Secrets set successfully");
  } catch (e) {
    console.error("  Failed to set secrets. You can set them manually:");
    console.error(`    wrangler secret put CF_ACCESS_TEAM_DOMAIN  (value: ${teamDomain})`);
    console.error(`    wrangler secret put CF_ACCESS_AUD  (value: ${mainApp.aud})`);
  }

  console.log("\n=== Setup Complete ===");
  console.log(`\nYour worker at https://${workerDomain} is now protected by CF Access.`);
  console.log("Deploy with: npm run deploy");
  console.log("\nOptional cleanup: npx wrangler pages project delete multibot-dashboard");
}

main().catch((e) => {
  console.error("Setup failed:", e);
  process.exit(1);
});
