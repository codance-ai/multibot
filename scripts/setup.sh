#!/usr/bin/env bash
set -euo pipefail

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[SKIP]${NC} $*"; }
fail()  { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

WRANGLER_TOML="wrangler.toml"
WRANGLER_TEMPLATE="wrangler.toml.template"

# ─── Generate wrangler.toml from template ────────────────────────────────────
if [ ! -f "$WRANGLER_TOML" ]; then
  if [ -f "$WRANGLER_TEMPLATE" ]; then
    cp "$WRANGLER_TEMPLATE" "$WRANGLER_TOML"
    info "Created $WRANGLER_TOML from template."
  else
    fail "$WRANGLER_TEMPLATE not found. Are you in the project root?"
  fi
else
  info "$WRANGLER_TOML already exists, using it as-is."
fi

# ─── Prerequisites ───────────────────────────────────────────────────────────
echo ""
echo "========================================="
echo "  multibot setup"
echo "========================================="
echo ""

info "Checking prerequisites..."

if ! command -v node >/dev/null 2>&1; then
  echo ""
  fail "Node.js is not installed. Install Node.js 18+:
    macOS:   brew install node
    Linux:   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
    Any OS:  https://nodejs.org/en/download"
fi
if ! command -v npm >/dev/null 2>&1; then
  fail "npm is not installed. It should come with Node.js — reinstall Node.js from https://nodejs.org"
fi

# Install dependencies first so wrangler is available as local dep
info "Installing dependencies..."
npm install --silent
ok "Root dependencies installed."

(cd dashboard && npm install --silent)
ok "Dashboard dependencies installed."

# Check wrangler login — auto-login if needed
WHOAMI_OUTPUT=$(npx wrangler whoami 2>&1) || true
if ! echo "$WHOAMI_OUTPUT" | grep -q "Account ID"; then
  info "Not logged in to Cloudflare. Opening browser for login..."
  npx wrangler login || fail "Cloudflare login failed. Run manually: npx wrangler login"
  WHOAMI_OUTPUT=$(npx wrangler whoami 2>&1) || true
  if ! echo "$WHOAMI_OUTPUT" | grep -q "Account ID"; then
    fail "Still not logged in after login attempt. Run: npx wrangler login"
  fi
fi

# Auto-detect email and account ID from wrangler whoami
DETECTED_EMAIL=$(echo "$WHOAMI_OUTPUT" | grep -oE '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' | head -1)
DETECTED_ACCOUNT_ID=$(echo "$WHOAMI_OUTPUT" | grep -oE '[0-9a-f]{32}' | head -1)

if [ -n "$DETECTED_EMAIL" ]; then
  ok "Detected email: $DETECTED_EMAIL"
fi
if [ -n "$DETECTED_ACCOUNT_ID" ]; then
  ok "Detected account ID: $DETECTED_ACCOUNT_ID"
fi

# Auto-detect workers.dev subdomain via CF API
DETECTED_SUBDOMAIN=""
if [ -n "$DETECTED_ACCOUNT_ID" ]; then
  # Find wrangler OAuth token (macOS vs Linux config paths)
  WRANGLER_CONFIG=""
  for p in "$HOME/Library/Preferences/.wrangler/config/default.toml" \
           "$HOME/.config/.wrangler/config/default.toml" \
           "${XDG_CONFIG_HOME:+$XDG_CONFIG_HOME/.wrangler/config/default.toml}"; do
    if [ -f "$p" ]; then
      WRANGLER_CONFIG="$p"
      break
    fi
  done

  if [ -n "$WRANGLER_CONFIG" ]; then
    OAUTH_TOKEN=$(grep 'oauth_token' "$WRANGLER_CONFIG" | head -1 | sed 's/.*= "//' | sed 's/".*//')
    if [ -n "$OAUTH_TOKEN" ]; then
      SUBDOMAIN_RESP=$(curl -sf "https://api.cloudflare.com/client/v4/accounts/${DETECTED_ACCOUNT_ID}/workers/subdomain" \
        -H "Authorization: Bearer ${OAUTH_TOKEN}" 2>/dev/null) || true
      DETECTED_SUBDOMAIN=$(echo "$SUBDOMAIN_RESP" | grep -o '"subdomain":"[^"]*"' | sed 's/"subdomain":"//;s/"//' | head -1)
      # Also try the pretty-printed JSON format
      if [ -z "$DETECTED_SUBDOMAIN" ]; then
        DETECTED_SUBDOMAIN=$(echo "$SUBDOMAIN_RESP" | grep '"subdomain"' | sed 's/.*: *"//;s/".*//' | head -1)
      fi
      if [ -n "$DETECTED_SUBDOMAIN" ]; then
        ok "Detected workers.dev subdomain: $DETECTED_SUBDOMAIN"
      fi
    fi
  fi
fi

ok "All prerequisites met."

echo ""
warn "multibot requires a Cloudflare Workers Paid plan (\$5/mo) for Durable Objects and Cron Triggers."
warn "Upgrade at: https://dash.cloudflare.com → Workers & Pages → Plans"

# ─── Helper: parse ID from wrangler CLI output ──────────────────────────────
# wrangler d1 create outputs:  "database_id = \"<uuid>\""
# wrangler kv namespace create outputs:  "id = \"<hex>\""
parse_id() {
  grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32}' | head -1
}

# ─── Helper: replace placeholder in wrangler.toml ───────────────────────────
replace_placeholder() {
  local placeholder="$1"
  local value="$2"
  if grep -q "$placeholder" "$WRANGLER_TOML"; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s|${placeholder}|${value}|g" "$WRANGLER_TOML"
    else
      sed -i "s|${placeholder}|${value}|g" "$WRANGLER_TOML"
    fi
    ok "Replaced $placeholder in $WRANGLER_TOML"
  else
    warn "$placeholder not found in $WRANGLER_TOML (already configured?)"
  fi
}

# ─── 1. Create D1 Database ──────────────────────────────────────────────────
echo ""
info "Creating D1 database..."

if grep -q "__D1_DATABASE_ID__" "$WRANGLER_TOML"; then
  D1_OUTPUT=$(npx wrangler d1 create multibot-db 2>&1) || true
  D1_ID=$(echo "$D1_OUTPUT" | parse_id)

  if [ -n "$D1_ID" ]; then
    replace_placeholder "__D1_DATABASE_ID__" "$D1_ID"
  else
    # Database may already exist — try to list it
    D1_LIST=$(npx wrangler d1 list 2>&1) || true
    D1_ID=$(echo "$D1_LIST" | grep "multibot-db" | parse_id)
    if [ -n "$D1_ID" ]; then
      replace_placeholder "__D1_DATABASE_ID__" "$D1_ID"
      warn "D1 database 'multibot-db' already exists, using existing ID."
    else
      fail "Could not create or find D1 database. Output: $D1_OUTPUT"
    fi
  fi
else
  warn "D1 database already configured."
fi

# Apply D1 schema
info "Applying D1 schema..."
SCHEMA_OUTPUT=$(npx wrangler d1 execute multibot-db --remote --file=scripts/schema.sql 2>&1) && \
  ok "D1 schema applied." || \
  warn "Could not apply D1 schema (${SCHEMA_OUTPUT}). Apply manually: npx wrangler d1 execute multibot-db --remote --file=scripts/schema.sql"

# ─── 2. Create R2 Buckets ────────────────────────────────────────────────────
echo ""
info "Creating R2 buckets..."

R2_OUTPUT=$(npx wrangler r2 bucket create multibot-logs 2>&1) || true
if echo "$R2_OUTPUT" | grep -qi "already exists\|created"; then
  ok "R2 bucket 'multibot-logs' ready."
else
  warn "Could not create R2 bucket 'multibot-logs' (may already exist). Output: $R2_OUTPUT"
fi

R2_ASSETS_OUTPUT=$(npx wrangler r2 bucket create multibot-assets 2>&1) || true
if echo "$R2_ASSETS_OUTPUT" | grep -qi "already exists\|created"; then
  ok "R2 bucket 'multibot-assets' ready."
else
  warn "Could not create R2 bucket 'multibot-assets' (may already exist). Output: $R2_ASSETS_OUTPUT"
fi

# Set lifecycle rules for R2 buckets
npx wrangler r2 bucket lifecycle add multibot-logs expire-90d --expire-days 90 --force 2>/dev/null && \
  ok "R2 lifecycle rule set for logs (90-day expiry)." || \
  warn "Could not set lifecycle rule for logs (may already exist)."

npx wrangler r2 bucket lifecycle add multibot-assets expire-90d --expire-days 90 --force 2>/dev/null && \
  ok "R2 lifecycle rule set for assets (90-day expiry)." || \
  warn "Could not set lifecycle rule for assets (may already exist)."

# Derive Worker URL for BASE_URL
if grep -q "__BASE_URL__" "$WRANGLER_TOML"; then
  WORKER_NAME=$(grep '^name = ' "$WRANGLER_TOML" | head -1 | sed 's/name = "\(.*\)"/\1/')
  echo ""

  if [ -n "$DETECTED_SUBDOMAIN" ]; then
    SUBDOMAIN="$DETECTED_SUBDOMAIN"
    info "Using detected subdomain: $SUBDOMAIN"
  else
    info "Your Worker URL will be: https://${WORKER_NAME}.<your-subdomain>.workers.dev"
    info "Find your subdomain at: https://dash.cloudflare.com → Workers & Pages → Overview"
    printf "${CYAN}Enter your workers.dev subdomain: ${NC}"
    read SUBDOMAIN
  fi

  if [ -n "$SUBDOMAIN" ]; then
    WORKER_URL="https://${WORKER_NAME}.${SUBDOMAIN}.workers.dev"
    replace_placeholder "__BASE_URL__" "$WORKER_URL"
  else
    warn "No subdomain entered. Set BASE_URL manually in $WRANGLER_TOML (e.g. https://multibot.<your-subdomain>.workers.dev)"
  fi
else
  warn "BASE_URL already configured."
fi

# ─── 3. Set WEBHOOK_SECRET ──────────────────────────────────────────────────
echo ""
info "Setting WEBHOOK_SECRET..."

WEBHOOK_SECRET=$(openssl rand -hex 32)
echo "$WEBHOOK_SECRET" | npx wrangler secret put WEBHOOK_SECRET 2>/dev/null && \
  ok "WEBHOOK_SECRET set." || \
  warn "Could not set WEBHOOK_SECRET. Set it manually: npx wrangler secret put WEBHOOK_SECRET"

# ─── 3b. Dashboard Auth ─────────────────────────────────────────────────────
echo ""
info "Dashboard authentication setup..."

if [ -n "$DETECTED_EMAIL" ]; then
  OWNER_EMAIL="$DETECTED_EMAIL"
  info "Using detected email as owner ID: $OWNER_EMAIL"
else
  printf "${CYAN}Enter your email (used as owner ID): ${NC}"
  read OWNER_EMAIL
fi

if [ -n "$OWNER_EMAIL" ]; then
  replace_placeholder "__OWNER_ID__" "$OWNER_EMAIL"
else
  warn "No email entered. Set OWNER_ID manually in $WRANGLER_TOML"
fi

printf "${CYAN}Enter a password for the dashboard: ${NC}"
read -s DASHBOARD_PWD
echo ""
if [ -n "$DASHBOARD_PWD" ]; then
  echo "$DASHBOARD_PWD" | npx wrangler secret put DASHBOARD_PASSWORD 2>/dev/null && \
    ok "DASHBOARD_PASSWORD set." || \
    warn "Could not set DASHBOARD_PASSWORD. Set it manually: npx wrangler secret put DASHBOARD_PASSWORD"
else
  warn "No password entered. Set it manually: npx wrangler secret put DASHBOARD_PASSWORD"
fi

# ─── 4. Sprites Sandbox Backend ─────────────────────────────────────────────
echo ""
info "Sandbox: multibot uses Fly.io Sprites for persistent bot sandboxes."
info "Get a token at: https://sprites.dev"
echo ""
info "Setting SPRITES_TOKEN..."
printf "${CYAN}Enter your Fly.io Sprites API token: ${NC}"
read SPRITES_TOKEN_VALUE
if [ -z "$SPRITES_TOKEN_VALUE" ]; then
  fail "SPRITES_TOKEN is required. Bot sandbox (shell & file tools) won't work without it. Get a token at: https://sprites.dev"
fi
echo "$SPRITES_TOKEN_VALUE" | npx wrangler secret put SPRITES_TOKEN 2>/dev/null && \
  ok "SPRITES_TOKEN set." || \
  fail "Could not set SPRITES_TOKEN. Set it manually: npx wrangler secret put SPRITES_TOKEN"

# ─── Done ────────────────────────────────────────────────────────────────────
echo ""
echo "========================================="
echo -e "  ${GREEN}Setup complete!${NC}"
echo "========================================="
echo ""
echo "Next steps:"
echo ""
echo "  1. Start locally:"
echo "     npm run dev"
echo ""
echo "  2. Deploy to Cloudflare:"
echo "     npm run deploy"
echo ""
echo "  3. Open the dashboard and:"
echo "     - Add your LLM API key (OpenAI, Anthropic, etc.)"
echo "     - Create a bot"
echo "     - Bind a Telegram/Discord/Slack channel"
echo ""
echo "  4. Dashboard is protected by password auth (set during setup)."
echo "     To change password: npx wrangler secret put DASHBOARD_PASSWORD"
echo ""
