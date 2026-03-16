-- multibot D1 schema
-- All tables use CREATE TABLE IF NOT EXISTS for idempotent execution.

-- bots
CREATE TABLE IF NOT EXISTS bots (
  bot_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  soul TEXT DEFAULT '',
  agents TEXT DEFAULT '',
  "user" TEXT DEFAULT '',
  tools TEXT DEFAULT '',
  identity TEXT DEFAULT '',
  base_url TEXT,
  avatar_url TEXT,
  channels TEXT DEFAULT '{}',
  enabled_skills TEXT DEFAULT '[]',
  max_iterations INTEGER DEFAULT 10,
  memory_window INTEGER DEFAULT 50,
  context_window INTEGER DEFAULT 128000,
  timezone TEXT,
  image_provider TEXT,
  image_model TEXT,
  mcp_servers TEXT DEFAULT '{}',
  subagent TEXT,
  bot_type TEXT DEFAULT 'normal',
  allowed_sender_ids TEXT DEFAULT '[]',
  stt_enabled INTEGER DEFAULT 0,
  voice_mode TEXT DEFAULT 'off',
  tts_voice TEXT DEFAULT 'alloy',
  tts_model TEXT DEFAULT 'gpt-4o-mini-tts',
  deleted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- user_keys
CREATE TABLE IF NOT EXISTS user_keys (
  owner_id TEXT PRIMARY KEY,
  openai TEXT, anthropic TEXT, google TEXT,
  deepseek TEXT, moonshot TEXT, brave TEXT, xai TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- groups
CREATE TABLE IF NOT EXISTS groups (
  group_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  bot_ids TEXT NOT NULL,
  note TEXT DEFAULT '',
  orchestrator_provider TEXT DEFAULT 'anthropic',
  orchestrator_model TEXT DEFAULT 'claude-sonnet-4-6',
  channel TEXT, chat_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- channel_tokens
CREATE TABLE IF NOT EXISTS channel_tokens (
  channel TEXT NOT NULL,
  token TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  PRIMARY KEY (channel, token)
);

-- sessions
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  group_id TEXT,
  bot_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- messages
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  attachments TEXT,
  bot_id TEXT,
  tool_calls TEXT,
  request_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- request_trace_index
CREATE TABLE IF NOT EXISTS request_trace_index (
  request_id TEXT PRIMARY KEY,
  parent_request_id TEXT,
  bot_id TEXT,
  log_date TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- consolidation_state
CREATE TABLE IF NOT EXISTS consolidation_state (
  session_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  last_consolidated INTEGER NOT NULL,
  PRIMARY KEY (session_id, bot_id)
);

-- reply_hints
CREATE TABLE IF NOT EXISTS reply_hints (
  channel TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_date INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  reply_to_name TEXT NOT NULL,
  reply_to_text TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (channel, chat_id, message_date, user_id)
);

-- skills (installed via ClawHub or skill-creator, per-bot)
CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  emoji TEXT,
  path TEXT NOT NULL,
  file_count INTEGER DEFAULT 1,
  requires_env TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(bot_id, name)
);

-- skill_secrets (per-owner secret env vars for skills)
CREATE TABLE IF NOT EXISTS skill_secrets (
  owner_id TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  env_vars TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (owner_id, skill_name)
);

-- ─── Indexes ────────────────────────────────────────────────────────────────
-- (PK columns already indexed by SQLite, only add indexes for non-PK lookup patterns)

-- bots: every query filters by owner_id + deleted_at
CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots(owner_id, deleted_at);

-- groups: list by owner
CREATE INDEX IF NOT EXISTS idx_groups_owner ON groups(owner_id);

-- channel_tokens: deletion by bot_id (PK covers channel+token lookups)
CREATE INDEX IF NOT EXISTS idx_channel_tokens_bot ON channel_tokens(bot_id);

-- sessions: lookup by channel+chat_id is the hot path for every incoming message
CREATE INDEX IF NOT EXISTS idx_sessions_lookup ON sessions(channel, chat_id);

-- messages: conversation history retrieval (most frequent query)
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
-- messages: cleanup/deletion by bot
CREATE INDEX IF NOT EXISTS idx_messages_bot ON messages(bot_id);
-- messages: log session listing filtered by date range
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
-- request_trace_index: group chat trace chain lookup
CREATE INDEX IF NOT EXISTS idx_request_trace_index_parent ON request_trace_index(parent_request_id);
-- request_trace_index: bot/day trace lookup
CREATE INDEX IF NOT EXISTS idx_request_trace_index_bot_date ON request_trace_index(bot_id, log_date);

-- reply_hints: periodic cleanup by age
CREATE INDEX IF NOT EXISTS idx_reply_hints_created ON reply_hints(created_at);

-- ─── Sub-Agent Runs ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS subagent_runs (
  run_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  parent_session_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  label TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT,
  spawn_depth INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_subagent_parent ON subagent_runs(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_subagent_bot ON subagent_runs(bot_id, created_at);

-- ─── Memory System (replaces KV_STORE) ─────────────────────────────────────

-- bot_memory: long-term memory per bot (replaces KV memory:{botId}:MEMORY.md)
CREATE TABLE IF NOT EXISTS bot_memory (
  bot_id TEXT PRIMARY KEY,
  content TEXT NOT NULL DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now'))
);

-- memory_history_entries: per-entry history log (replaces KV memory:{botId}:HISTORY.md)
CREATE TABLE IF NOT EXISTS memory_history_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_history_bot_created ON memory_history_entries(bot_id, created_at);
