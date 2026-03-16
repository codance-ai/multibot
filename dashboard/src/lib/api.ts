import type {
  BotConfig,
  CreateBotInput,
  UpdateBotInput,
  MaskedKeys,
  UpdateKeysInput,
  GroupConfig,
  GroupResponse,
  CreateGroupInput,
  UpdateGroupInput,
  SkillInfo,
  RequestTrace,
  TraceWithEntries,
  SessionSummary,
  D1Message,
  SubagentRun,
} from "./types";

const BASE_URL = "";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    if (res.status === 401) {
      if (!sessionStorage.getItem("auth_redirect")) {
        sessionStorage.setItem("auth_redirect", "1");
        window.location.reload();
      }
      throw new ApiError(res.status, "Session expired");
    }
    const body = await res.json().catch(() => ({}));
    throw new ApiError(
      res.status,
      (body as { error?: string }).error ?? res.statusText,
    );
  }
  return res.json() as Promise<T>;
}

// -- Bots --

export function listBots(): Promise<BotConfig[]> {
  return request("/api/bots");
}

export function createBot(input: CreateBotInput): Promise<BotConfig> {
  return request("/api/bots", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getBot(botId: string): Promise<BotConfig> {
  return request(`/api/bots/${botId}`);
}

export function updateBot(
  botId: string,
  input: UpdateBotInput,
): Promise<BotConfig> {
  return request(`/api/bots/${botId}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteBot(botId: string): Promise<{ deleted: true }> {
  return request(`/api/bots/${botId}`, { method: "DELETE" });
}

// -- Channels --

export function bindChannel(
  botId: string,
  channel: string,
  token: string,
  webhookUrl?: string,
): Promise<{ status: string }> {
  return request(`/api/bots/${botId}/channels/${channel}`, {
    method: "POST",
    body: JSON.stringify({ token, ...(webhookUrl && { webhookUrl }) }),
  });
}

export function unbindChannel(
  botId: string,
  channel: string,
): Promise<{ unbound: true }> {
  return request(`/api/bots/${botId}/channels/${channel}`, {
    method: "DELETE",
  });
}

// -- Keys --

export function getKeys(): Promise<MaskedKeys> {
  return request("/api/keys");
}

export function updateKeys(input: UpdateKeysInput): Promise<MaskedKeys> {
  return request("/api/keys", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

// -- Groups --

export function listGroups(): Promise<GroupConfig[]> {
  return request("/api/groups");
}

export function createGroup(input: CreateGroupInput): Promise<GroupResponse> {
  return request("/api/groups", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getGroup(groupId: string): Promise<GroupResponse> {
  return request(`/api/groups/${groupId}`);
}

export function updateGroup(
  groupId: string,
  input: UpdateGroupInput,
): Promise<GroupResponse> {
  return request(`/api/groups/${groupId}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteGroup(groupId: string): Promise<{ deleted: true }> {
  return request(`/api/groups/${groupId}`, { method: "DELETE" });
}

// -- Skills --

export function listSkills(): Promise<SkillInfo[]> {
  return request("/api/skills");
}

export function deleteSkill(name: string): Promise<{ deleted: true }> {
  return request(`/api/skills/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

// -- Skill Secrets --

export function getSkillSecrets(): Promise<Record<string, Record<string, string>>> {
  return request("/api/skill-secrets");
}

export function setSkillSecret(
  skillName: string,
  envVars: Record<string, string>,
): Promise<{ ok: true }> {
  return request(`/api/skill-secrets/${encodeURIComponent(skillName)}`, {
    method: "PUT",
    body: JSON.stringify(envVars),
  });
}

export function deleteSkillSecret(
  skillName: string,
): Promise<{ ok: true }> {
  return request(`/api/skill-secrets/${encodeURIComponent(skillName)}`, {
    method: "DELETE",
  });
}

// -- D1-based logs --

export function listSessions(params: {
  date?: string;
  botId?: string;
  tzOffsetMinutes?: number;
  limit?: number;
}): Promise<SessionSummary[]> {
  const qs = new URLSearchParams();
  if (params.date) qs.set("date", params.date);
  if (params.botId) qs.set("botId", params.botId);
  if (typeof params.tzOffsetMinutes === "number") {
    qs.set("tzOffsetMinutes", String(params.tzOffsetMinutes));
  }
  if (params.limit) qs.set("limit", String(params.limit));
  return request(`/api/logs/sessions?${qs}`);
}

export function listMessages(
  sessionId: string,
  limit?: number,
): Promise<D1Message[]> {
  const qs = new URLSearchParams({ sessionId });
  if (limit) qs.set("limit", String(limit));
  return request(`/api/logs/messages?${qs}`);
}

export function listSubagentRuns(sessionId: string): Promise<SubagentRun[]> {
  const qs = new URLSearchParams({ sessionId });
  return request(`/api/logs/subagent-runs?${qs}`);
}

// -- R2 Traces (kept for enrichment) --

export function listTraces(params: {
  botId?: string;
  date?: string;
  status?: "ok" | "error";
  limit?: number;
}): Promise<RequestTrace[]> {
  const qs = new URLSearchParams();
  if (params.botId) qs.set("botId", params.botId);
  if (params.date) qs.set("date", params.date);
  if (params.status) qs.set("status", params.status);
  if (params.limit) qs.set("limit", String(params.limit));
  return request(`/api/logs?${qs}`);
}

export function getTraceDetail(
  requestId: string,
  botId?: string,
): Promise<TraceWithEntries[]> {
  const qs = new URLSearchParams({ requestId });
  if (botId) qs.set("botId", botId);
  return request(`/api/logs?${qs}`);
}

export function getTraceChain(
  parentRequestId: string,
): Promise<TraceWithEntries[]> {
  const qs = new URLSearchParams({ parentRequestId });
  return request(`/api/logs?${qs}`);
}

// -- Auth --

export async function checkAuth(): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/check");
    sessionStorage.removeItem("auth_redirect");
    return res.ok;
  } catch {
    return false;
  }
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" });
  window.location.href = "/";
}
