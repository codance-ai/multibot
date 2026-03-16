import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Search,
  Loader2,
  Activity,
  Clock,
  MessageSquare,
  Bot,
  Users,
  ArrowUpDown,
  BookOpen,
  Wrench,
  AlertTriangle,
  Eye,
  EyeOff,
  Zap,
  Copy,
  Check,
  ExternalLink,
  GitBranch,
  Timer,
  Volume2,
  Mic,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { WaveViz, EntryRow, ToolCallItem, groupByIteration, IterationBlock } from "@/components/trace-detail";
import type { ToolCallDetail } from "@/components/trace-detail";
import { cn, sanitizeMessageText } from "@/lib/utils";
import * as api from "@/lib/api";
import type {
  SessionSummary,
  D1Message,
  TraceWithEntries,
  LogEntry,
  SubagentRun,
} from "@/lib/types";

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatTime(iso: string) {
  const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDateTime(iso: string) {
  const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  return d.toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function getTzOffsetMinutesForDate(date: string): number {
  // Use noon local time to avoid DST edge cases around midnight.
  return new Date(`${date}T12:00:00`).getTimezoneOffset();
}

/** Bot/group name lookup map: botId -> name */
type NameMap = Record<string, string>;
type ChainInfo = {
  requestId: string;
  parentRequestId?: string;
};

function pickTraceForRequest(
  items: TraceWithEntries[],
  requestId: string,
  botId?: string | null,
): TraceWithEntries | undefined {
  const exact = items.filter((it) => it.trace.requestId === requestId);
  if (exact.length === 0) return items[0];
  if (botId) {
    const byBot = exact.find((it) => it.trace.botId === botId);
    if (byBot) return byBot;
  }
  return exact[0];
}

// -- Components --

function StatsCards({
  sessions,
  messageCount,
}: {
  sessions: SessionSummary[];
  messageCount: number;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Card className="py-3">
        <CardContent className="flex items-center gap-3 px-4">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <div>
            <p className="text-2xl font-semibold">{sessions.length}</p>
            <p className="text-xs text-muted-foreground">Sessions</p>
          </div>
        </CardContent>
      </Card>
      <Card className="py-3">
        <CardContent className="flex items-center gap-3 px-4">
          <MessageSquare className="h-4 w-4 text-muted-foreground" />
          <div>
            <p className="text-2xl font-semibold">{messageCount}</p>
            <p className="text-xs text-muted-foreground">Messages</p>
          </div>
        </CardContent>
      </Card>
      <Card className="py-3">
        <CardContent className="flex items-center gap-3 px-4">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <div>
            <p className="text-2xl font-semibold">
              {sessions.length > 0
                ? Math.round(messageCount / sessions.length)
                : 0}
            </p>
            <p className="text-xs text-muted-foreground">Avg Msgs/Session</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function CopyableRequestId({
  requestId,
  parentRequestId,
}: {
  requestId: string;
  parentRequestId?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const label = parentRequestId
    ? `${parentRequestId.slice(0, 8)} -> ${requestId.slice(0, 8)}`
    : requestId.slice(0, 8);
  const fullValue = parentRequestId
    ? `${parentRequestId} -> ${requestId}`
    : requestId;
  return (
    <span
      className="cursor-pointer rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
      title={fullValue}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(fullValue);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "copied!" : label}
    </span>
  );
}

function hasAudioAttachment(attachments?: Array<{ r2Key: string; mediaType: string }> | null): boolean {
  return attachments?.some(att => att.mediaType.startsWith("audio/")) ?? false;
}

function formatAttachmentLabel(attachments: Array<{ r2Key: string; mediaType: string }>): string {
  let imageCount = 0;
  let audioCount = 0;
  let fileCount = 0;
  for (const att of attachments) {
    if (att.mediaType.startsWith("image/")) {
      imageCount++;
    } else if (att.mediaType.startsWith("audio/")) {
      audioCount++;
    } else {
      fileCount++;
    }
  }
  const parts: string[] = [];
  if (imageCount > 0) parts.push(`${imageCount} image${imageCount > 1 ? "s" : ""}`);
  if (audioCount > 0) parts.push(`${audioCount} audio${audioCount > 1 ? "s" : ""}`);
  if (fileCount > 0) parts.push(`${fileCount} file${fileCount > 1 ? "s" : ""}`);
  return `[attached ${parts.join(", ")}]`;
}

function UserMessageBubble({
  text,
  attachments,
  requestId,
}: {
  text: string;
  attachments?: Array<{ r2Key: string; mediaType: string }> | null;
  requestId?: string | null;
}) {
  const hasText = Boolean(text && text.trim().length > 0);
  const attachmentCount = attachments?.length ?? 0;
  return (
    <div className="flex items-start gap-2.5 py-1">
      <MessageSquare className="mt-1 h-4 w-4 shrink-0 text-blue-500" />
      <div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-blue-600">User</span>
          {hasAudioAttachment(attachments) && (
            <Mic className="h-3 w-3 text-blue-500" />
          )}
          {requestId && <CopyableRequestId requestId={requestId} />}
        </div>
        <div className="mt-0.5 break-words rounded-lg bg-blue-500/10 px-3 py-2 text-sm">
          {hasText ? text : " "}
          {attachmentCount > 0 && (
            <div className={cn("text-muted-foreground", hasText && "mt-1")}>
              {formatAttachmentLabel(attachments!)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BotLogEntries({
  entries,
  errorMessage,
  totalIterations = 0,
}: {
  entries: LogEntry[];
  errorMessage?: string;
  totalIterations?: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const filtered = showAll
    ? entries
    : entries.filter((e) => e.level === "warn" || e.level === "error" || e.msg === "Starting LLM call" || e.msg === "Tool calls" || e.msg === "LLM response");
  const hiddenCount = entries.length - filtered.length;

  return (
    <div>
      {errorMessage && (
        <div className="mb-1 flex items-start gap-2 rounded bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}
      {filtered.length > 0 && (
        <div className="mt-1">
          {totalIterations > 1 ? (
            groupByIteration(entries, filtered).map((group, gi) =>
              group.iteration != null ? (
                <IterationBlock
                  key={`iter-${group.iteration}-${gi}`}
                  iteration={group.iteration}
                  totalIterations={totalIterations}
                  entries={group.entries}
                  llmDurationMs={group.llmDurationMs}
                  toolsDurationMs={group.toolsDurationMs}
                />
              ) : (
                <div key={`ungrouped-${gi}`}>
                  {group.entries.map((e, i) => (
                    <EntryRow key={i} entry={e} />
                  ))}
                </div>
              ),
            )
          ) : (
            filtered.map((e, i) => (
              <EntryRow key={i} entry={e} />
            ))
          )}
        </div>
      )}
      {!showAll && hiddenCount > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs text-muted-foreground"
          onClick={(e) => {
            e.stopPropagation();
            setShowAll(true);
          }}
        >
          <Eye className="mr-1 h-3 w-3" />
          Show all ({hiddenCount} hidden)
        </Button>
      )}
      {showAll && hiddenCount === 0 && entries.some((e) => e.level === "debug" || e.level === "info") && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs text-muted-foreground"
          onClick={(e) => {
            e.stopPropagation();
            setShowAll(false);
          }}
        >
          <EyeOff className="mr-1 h-3 w-3" />
          Show warnings/errors only
        </Button>
      )}
    </div>
  );
}

function OrchestratorDecisionBlock({
  traceItem,
  nameMap,
}: {
  traceItem: TraceWithEntries | null | undefined;
  nameMap: NameMap;
}) {
  const [open, setOpen] = useState(false);

  // Not loaded yet or no trace
  if (traceItem === undefined) {
    return (
      <div className="flex items-center gap-2 py-1 pl-6 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
      </div>
    );
  }
  if (traceItem === null) return null; // no trace found

  const { trace, entries } = traceItem;

  // Extract decisions from log entries
  const decisions = entries
    .filter((e) => !!(e as Record<string, unknown>).reasoning)
    .map((e, index) => {
      const extra = e as Record<string, unknown>;
      return {
        round: typeof extra.round === "number" ? extra.round : index + 1,
        reasoning: String(extra.reasoning),
        waves: extra.waves,
        respondents: extra.respondents,
        shouldContinue: typeof extra.shouldContinue === "boolean" ? extra.shouldContinue : undefined,
        durationMs: typeof extra.orchestratorDurationMs === "number" ? extra.orchestratorDurationMs : undefined,
      };
    });

  if (decisions.length === 0) return null;

  // Build a compact summary: first decision's wave names
  const firstDecision = decisions[0];
  const waveSummary = (() => {
    if (firstDecision.waves && Array.isArray(firstDecision.waves)) {
      return (firstDecision.waves as string[][])
        .map((wave) => wave.map((id) => nameMap[id] || id).join(", "))
        .join(" → ");
    }
    if (firstDecision.respondents && Array.isArray(firstDecision.respondents)) {
      return (firstDecision.respondents as string[])
        .map((id) => nameMap[id] || id)
        .join(", ");
    }
    return null;
  })();

  return (
    <div className="py-1">
      <div
        className="flex cursor-pointer items-start gap-2.5"
        onClick={() => setOpen(!open)}
      >
        <Zap className="mt-1 h-4 w-4 shrink-0 text-purple-500" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-purple-600">
              Orchestrator
            </span>
            {trace.durationMs != null && (
              <span className="text-xs text-muted-foreground">
                {trace.durationMs}ms
              </span>
            )}
            {decisions.length > 1 && (
              <Badge variant="outline" className="h-4 text-[10px]">
                {decisions.length} rounds
              </Badge>
            )}
            <span className="ml-auto">
              {open ? (
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
              )}
            </span>
          </div>
          {!open && waveSummary && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {waveSummary}
            </p>
          )}
          {open && (
            <CopyableDecisionBox decisions={decisions} nameMap={nameMap}>
              {decisions.map((d, i) => (
                <div key={i} className={cn(i > 0 && "border-t border-purple-200/50 pt-2 dark:border-purple-800/30")}>
                  {decisions.length > 1 && (
                    <div className="mb-1 flex items-center gap-2">
                      <span className="font-medium text-purple-600">
                        Round {d.round}
                      </span>
                      {d.durationMs != null && (
                        <span className="text-muted-foreground">{d.durationMs}ms</span>
                      )}
                      {d.shouldContinue !== undefined && (
                        <Badge
                          variant="outline"
                          className={cn(
                            "h-4 text-[10px]",
                            d.shouldContinue
                              ? "border-green-300 text-green-600"
                              : "border-gray-300 text-gray-500",
                          )}
                        >
                          {d.shouldContinue ? "continue" : "stop"}
                        </Badge>
                      )}
                    </div>
                  )}
                  {d.waves != null && <WaveViz waves={d.waves} />}
                  {d.waves == null && d.respondents != null && Array.isArray(d.respondents) && (
                    <div className="flex flex-wrap gap-1">
                      {(d.respondents as string[]).map((r, j) => (
                        <Badge key={j} variant="outline" className="text-xs">
                          {nameMap[r] || r}
                        </Badge>
                      ))}
                    </div>
                  )}
                  <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                    {d.reasoning}
                  </p>
                </div>
              ))}
            </CopyableDecisionBox>
          )}
        </div>
      </div>
    </div>
  );
}

function CopyableDecisionBox({
  decisions,
  nameMap,
  children,
}: {
  decisions: Array<{
    round: number;
    reasoning: string;
    waves: unknown;
    respondents: unknown;
    shouldContinue?: boolean;
    durationMs?: number;
  }>;
  nameMap: NameMap;
  children: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const copyText = () => {
    const text = decisions
      .map((d) => {
        const parts: string[] = [];
        if (decisions.length > 1) parts.push(`Round ${d.round}`);
        if (d.waves && Array.isArray(d.waves)) {
          const waveStr = (d.waves as string[][])
            .map((wave) => wave.map((id) => nameMap[id] || id).join(", "))
            .join(" → ");
          parts.push(`Waves: ${waveStr}`);
        }
        parts.push(d.reasoning);
        return parts.join("\n");
      })
      .join("\n\n");
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="relative mt-1 space-y-2 rounded-md border border-purple-200 bg-purple-50/50 px-3 py-2 text-xs dark:border-purple-900/50 dark:bg-purple-950/20">
      <button
        onClick={(e) => { e.stopPropagation(); copyText(); }}
        className="absolute right-1.5 top-1.5 rounded p-0.5 text-muted-foreground transition-colors hover:bg-purple-200/50 hover:text-foreground dark:hover:bg-purple-800/30"
        title="Copy"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      {children}
    </div>
  );
}

function BotMessageBubble({
  msg,
  botName,
  parentRequestId,
  traceDetail,
  traceLoading,
  expanded,
  onToggle,
  d1ToolCalls,
  orchVoiceSent,
}: {
  msg: D1Message;
  botName: string;
  parentRequestId?: string;
  traceDetail: TraceWithEntries | null | undefined;
  traceLoading: boolean;
  expanded: boolean;
  onToggle: () => void;
  d1ToolCalls?: ToolCallDetail[];
  orchVoiceSent?: boolean;
}) {
  const trace = traceDetail?.trace;
  const voiceSent = trace?.voiceSent || orchVoiceSent;
  const hasText = Boolean(msg.content && msg.content.trim().length > 0);
  const attachmentCount = msg.attachments?.length ?? 0;

  return (
    <div className="py-1">
      <div className="flex items-start gap-2.5">
        <Bot className="mt-1 h-4 w-4 shrink-0 text-green-500" />
        <div className="min-w-0 flex-1">
          <div
            className="flex cursor-pointer items-center gap-2"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            <span className="text-xs font-medium text-green-600">
              {botName}
            </span>
            {trace && (
              <span className="text-xs text-muted-foreground">
                {trace.durationMs}ms
              </span>
            )}
            {voiceSent && (
              <Volume2 className="h-3 w-3 text-blue-500" />
            )}
            {msg.requestId && (
              <CopyableRequestId
                requestId={msg.requestId}
                parentRequestId={parentRequestId}
              />
            )}
            {trace?.status === "error" && (
              <Badge variant="destructive" className="h-4 text-[10px]">
                error
              </Badge>
            )}
            <span className="ml-auto">
              {expanded ? (
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
              )}
            </span>
          </div>

          {(hasText || attachmentCount > 0) && (
            <div className="mt-0.5 break-words rounded-lg bg-green-500/10 px-3 py-2 text-sm">
              {hasText ? sanitizeMessageText(msg.content) : " "}
              {attachmentCount > 0 && (
                <div className={cn("text-muted-foreground", hasText && "mt-1")}>
                  {formatAttachmentLabel(msg.attachments!)}
                </div>
              )}
            </div>
          )}

          {expanded && (
            <div className="mt-2 space-y-1 rounded-md border bg-muted/20 px-3 py-2 text-xs">
              {traceLoading ? (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Loading trace...
                </div>
              ) : traceDetail ? (
                <>
                  <div className="flex flex-wrap gap-3 text-muted-foreground">
                    {trace!.model && (
                      <span className="font-mono">{trace!.model}</span>
                    )}
                    <span>{trace!.durationMs}ms</span>
                    {trace!.llmCalls > 0 && (
                      <span>
                        {trace!.llmCalls} LLM call
                        {trace!.llmCalls > 1 ? "s" : ""}
                      </span>
                    )}
                    {(trace!.inputTokens > 0 || trace!.outputTokens > 0) && (
                      <span>
                        {trace!.inputTokens} in / {trace!.outputTokens} out
                      </span>
                    )}
                  </div>
                  {trace!.skillCalls && trace!.skillCalls.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1">
                      {trace!.skillCalls.map((sc, si) => {
                        const label = sc.skill || "tool";
                        const hasErrors = sc.tools.some((t) => t.isError);
                        return (
                          <Badge
                            key={si}
                            className={cn(
                              "text-xs gap-1",
                              sc.skill
                                ? "bg-purple-100 text-purple-700 hover:bg-purple-100 dark:bg-purple-900/30 dark:text-purple-300"
                                : "",
                              hasErrors && "ring-1 ring-red-400",
                            )}
                          >
                            {sc.skill ? (
                              <BookOpen className="h-3 w-3" />
                            ) : (
                              <Wrench className="h-3 w-3" />
                            )}
                            {label} ({sc.tools.length})
                          </Badge>
                        );
                      })}
                    </div>
                  )}
                  <BotLogEntries
                    entries={traceDetail.entries}
                    errorMessage={trace!.errorMessage}
                    totalIterations={trace!.iterations ?? 0}
                  />
                </>
              ) : (
                <div className="text-muted-foreground">
                  <span className="font-mono">{formatTime(msg.createdAt)}</span>
                  {msg.requestId && (
                    <span className="ml-2">Request: {msg.requestId.slice(0, 8)}...</span>
                  )}
                  {d1ToolCalls && d1ToolCalls.length > 0 && (
                    <div className="mt-2 text-foreground">
                      {d1ToolCalls.map((tc, i) => (
                        <ToolCallItem key={i} tc={tc} />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function parseSubagentMessage(msg: { role: string; content: string | null }): {
  label: string;
  runId: string;
  body: string;
} | null {
  if (msg.role !== "subagent" || !msg.content) return null;
  const match = msg.content.match(/^\[Sub-Agent:\s*(.*?)\s*\|\s*runId:\s*([^\]]+)\]\n?([\s\S]*)$/);
  if (!match) return null;
  return { label: match[1], runId: match[2], body: match[3] ?? "" };
}

function SubagentMessageBubble({
  label,
  runId,
  body,
}: {
  label: string;
  runId: string;
  body: string;
}) {
  return (
    <div className="flex items-start gap-2.5 py-1">
      <GitBranch className="mt-1 h-4 w-4 shrink-0 text-gray-500" />
      <div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-gray-600">Sub-Agent</span>
          <Badge variant="outline" className="h-4 text-[10px]">
            {label}
          </Badge>
          <span className="font-mono text-[10px] text-muted-foreground" title={runId}>
            {runId.slice(0, 8)}
          </span>
        </div>
        {body && (
          <div className="mt-0.5 break-words rounded-lg bg-gray-500/10 px-3 py-2 text-sm">
            {body}
          </div>
        )}
      </div>
    </div>
  );
}

function formatDuration(startIso: string, endIso?: string): string {
  if (!endIso) return "running...";
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Inline child session messages viewer */
function ChildSessionMessages({ sessionId }: { sessionId: string }) {
  const [messages, setMessages] = useState<D1Message[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const msgs = await api.listMessages(sessionId);
        setMessages(msgs);
      } catch {
        setMessages([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [sessionId]);

  if (loading) return <div className="px-4 py-2 text-xs text-muted-foreground">Loading child session...</div>;
  if (!messages || messages.length === 0) return <div className="px-4 py-2 text-xs text-muted-foreground">No messages in child session</div>;

  // Filter: show user task + final assistant reply. Skip empty assistant messages (tool-call-only iterations).
  const displayMessages = messages.filter((msg) => {
    if (msg.role === "user") return true;
    if (msg.role === "assistant" && msg.content && msg.content.trim().length > 0) return true;
    return false;
  });

  if (displayMessages.length === 0) return <div className="px-4 py-2 text-xs text-muted-foreground">No messages in child session</div>;

  return (
    <div className="border-t bg-slate-50/50 px-4 py-2 dark:bg-slate-900/20">
      {displayMessages.map((msg) => (
        <div key={msg.id} className="py-1 text-xs">
          <span className={cn(
            "font-medium",
            msg.role === "user" ? "text-blue-600 dark:text-blue-400" : "text-green-600 dark:text-green-400"
          )}>
            {msg.role === "user" ? "task" : "result"}:
          </span>{" "}
          <span className="text-muted-foreground whitespace-pre-wrap">
            {(msg.content ?? "").slice(0, 800)}{(msg.content ?? "").length > 800 ? "…" : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

function SubagentRunsPanel({
  runs,
  nameMap,
}: {
  runs: SubagentRun[];
  nameMap: NameMap;
}) {
  const [open, setOpen] = useState(false);
  const [expandedChildSessions, setExpandedChildSessions] = useState<Set<string>>(new Set());

  if (runs.length === 0) return null;

  function toggleChildSession(sessionId: string) {
    setExpandedChildSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }

  return (
    <div className="mx-4 my-2 rounded-md border border-gray-200 dark:border-gray-700">
      <div
        className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-muted/50"
        onClick={() => setOpen(!open)}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        <GitBranch className="h-3.5 w-3.5 text-gray-500" />
        <span className="text-xs font-medium">
          Sub-Agent Runs
        </span>
        <Badge variant="outline" className="h-4 text-[10px]">
          {runs.length}
        </Badge>
      </div>

      {open && (
        <div className="divide-y border-t text-xs">
          {runs.map((run) => {
            const botName = nameMap[run.botId] || run.botId.slice(0, 8);
            const isChildExpanded = expandedChildSessions.has(run.childSessionId);
            const statusColors: Record<string, string> = {
              completed: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
              running: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
              error: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
              timeout: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
            };

            return (
              <div key={run.runId}>
                <div className="flex items-center gap-2 px-3 py-2">
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {run.label}
                  </Badge>
                  <span className="min-w-0 truncate text-muted-foreground" title={run.task}>
                    {run.task}
                  </span>
                  <Badge className={cn("ml-auto shrink-0 text-[10px]", statusColors[run.status] ?? "")}>
                    {run.status}
                  </Badge>
                  <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                    <Timer className="h-3 w-3" />
                    {formatDuration(run.createdAt, run.completedAt)}
                  </span>
                  {(run.inputTokens != null || run.outputTokens != null) && (
                    <span className="shrink-0 text-muted-foreground">
                      {run.inputTokens ?? 0} / {run.outputTokens ?? 0} tok
                    </span>
                  )}
                  <span className="shrink-0 text-muted-foreground" title={`Bot: ${botName}`}>
                    ({botName})
                  </span>
                  {run.childSessionId && (
                    <button
                      className={cn(
                        "shrink-0 rounded p-0.5 transition-colors hover:text-foreground",
                        isChildExpanded ? "text-foreground" : "text-muted-foreground"
                      )}
                      title={isChildExpanded ? "Hide child session" : "Show child session"}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleChildSession(run.childSessionId);
                      }}
                    >
                      <ExternalLink className="h-3 w-3" />
                    </button>
                  )}
                </div>
                {isChildExpanded && run.childSessionId && (
                  <ChildSessionMessages sessionId={run.childSessionId} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** A session's messages, loaded on demand */
function SessionMessages({
  sessionId,
  nameMap,
  sortAsc,
  groupId,
}: {
  sessionId: string;
  nameMap: NameMap;
  sortAsc: boolean;
  groupId?: string | null;
}) {
  const [messages, setMessages] = useState<D1Message[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Trace detail cache per requestId
  const [traceCache, setTraceCache] = useState<
    Record<string, TraceWithEntries[] | null>
  >({});
  const [traceLoading, setTraceLoading] = useState<Set<string>>(new Set());
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [chainCache, setChainCache] = useState<Record<string, ChainInfo | null>>({});
  const fetchedChainIds = useRef<Set<string>>(new Set());

  // Sub-agent runs for this session
  const [subagentRuns, setSubagentRuns] = useState<SubagentRun[]>([]);

  // Orchestrator trace cache for group chats (keyed by user message requestId)
  const [orchCache, setOrchCache] = useState<
    Record<string, TraceWithEntries | null>
  >({});
  const fetchedOrchIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [msgs, runs] = await Promise.all([
          api.listMessages(sessionId),
          api.listSubagentRuns(sessionId).catch(() => []),
        ]);
        setMessages(msgs);
        setSubagentRuns(runs);
      } catch (e) {
        setError(e instanceof api.ApiError ? e.message : "Failed to load messages");
      } finally {
        setLoading(false);
      }
    })();
  }, [sessionId]);

  // Auto-load orchestrator traces for group chat user messages
  useEffect(() => {
    if (!groupId || !messages) return;
    let cancelled = false;
    const userRequestIds = messages
      .filter((m) => m.role === "user" && m.requestId)
      .map((m) => m.requestId!);
    if (userRequestIds.length === 0) return;

    for (const rid of userRequestIds) {
      if (fetchedOrchIds.current.has(rid)) continue;
      fetchedOrchIds.current.add(rid);
      // Orchestrator now has its own requestId with parentRequestId = webhook requestId,
      // so query by parentRequestId to find it.
      api
        .getTraceChain(rid)
        .then((items) => {
          if (cancelled) return;
          const orchTrace = items.find((it) =>
            it.trace.botId?.startsWith("orchestrator:"),
          );
          setOrchCache((prev) => ({ ...prev, [rid]: orchTrace ?? null }));
        })
        .catch(() => {
          if (cancelled) return;
          setOrchCache((prev) => ({ ...prev, [rid]: null }));
        });
    }
    return () => { cancelled = true; };
  }, [groupId, messages]);

  // Auto-load parentRequestId for assistant messages so we can render chain labels (parent -> child)
  useEffect(() => {
    if (!messages) return;
    let cancelled = false;

    const userRequestIds = messages
      .filter((m) => m.role === "user" && m.requestId)
      .map((m) => m.requestId!);
    if (userRequestIds.length > 0) {
      setChainCache((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const rid of userRequestIds) {
          if (next[rid] === undefined) {
            next[rid] = { requestId: rid };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }

    for (const m of messages) {
      if (m.role !== "assistant" || !m.requestId) continue;
      const rid = m.requestId;
      if (fetchedChainIds.current.has(rid)) continue;
      fetchedChainIds.current.add(rid);

      api
        .getTraceDetail(rid, m.botId ?? undefined)
        .then((items) => {
          if (cancelled) return;
          const picked = pickTraceForRequest(items, rid, m.botId);
          if (!picked) {
            setChainCache((prev) => ({ ...prev, [rid]: null }));
            return;
          }
          setChainCache((prev) => ({
            ...prev,
            [rid]: {
              requestId: rid,
              ...(picked.trace.parentRequestId && { parentRequestId: picked.trace.parentRequestId }),
            },
          }));
          setTraceCache((prev) => (
            prev[rid] === undefined
              ? { ...prev, [rid]: items }
              : prev
          ));
        })
        .catch(() => {
          if (cancelled) return;
          setChainCache((prev) => ({ ...prev, [rid]: null }));
        });
    }

    return () => {
      cancelled = true;
    };
  }, [messages]);

  // Load orch traces for bot-originated group turns (no user message anchor).
  // Uses chainCache to find assistant messages whose parentRequestId (= coordinator requestId)
  // is not already covered by user-message orch loading.
  // Note: orchCache is intentionally NOT in the dep array — fetchedOrchIds.current is the
  // deduplication guard, and including orchCache would cause O(N²) re-runs.
  useEffect(() => {
    if (!groupId || !messages) return;
    let cancelled = false;

    for (const msg of messages) {
      if (msg.role !== "assistant" || !msg.requestId) continue;
      const chain = chainCache[msg.requestId];
      if (!chain?.parentRequestId) continue;
      const orchKey = chain.parentRequestId;
      // Already loaded (by user-message effect or previous iteration)?
      if (fetchedOrchIds.current.has(orchKey)) continue;
      fetchedOrchIds.current.add(orchKey);

      api.getTraceChain(orchKey).then((items) => {
        if (cancelled) return;
        const orchTrace = items.find((it) => it.trace.botId?.startsWith("orchestrator:"));
        if (orchTrace) {
          setOrchCache((prev) => ({ ...prev, [orchKey]: orchTrace }));
        }
      }).catch((e) => {
        console.warn("[logs] Failed to load orch trace for bot-originated turn:", orchKey, e);
      });
    }

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchedOrchIds.current is the dedup guard, not orchCache
  }, [groupId, messages, chainCache]);

  // Collect D1 tool_calls by requestId for fallback when R2 trace unavailable
  // Must be before early returns to satisfy Rules of Hooks
  const toolCallsByRequestId = useMemo(() => {
    if (!messages) return {};
    const map: Record<string, ToolCallDetail[]> = {};
    for (const m of messages) {
      if (m.role === "assistant" && m.toolCalls && m.requestId) {
        try {
          const tcs = JSON.parse(m.toolCalls) ?? [];
          if (!map[m.requestId]) map[m.requestId] = [];
          for (const tc of tcs) {
            map[m.requestId].push({
              toolName: tc.toolName || "tool",
              input: JSON.stringify(tc.args ?? tc.input ?? {}),
              result: "",
            });
          }
        } catch { /* ignore */ }
      }
    }
    return map;
  }, [messages]);

  // For each request_id, find the last assistant msg with content → skip earlier ones
  const skippedMsgIds = useMemo(() => {
    if (!messages) return new Set<number>();
    const skip = new Set<number>();
    // Group assistant messages with content by requestId
    const byReq: Record<string, Array<{ id: number }>> = {};
    for (const m of messages) {
      if (m.role === "assistant" && m.content && m.requestId) {
        if (!byReq[m.requestId]) byReq[m.requestId] = [];
        byReq[m.requestId].push({ id: m.id });
      }
    }
    // For groups with >1, skip all but the last (highest id)
    for (const group of Object.values(byReq)) {
      if (group.length > 1) {
        group.sort((a, b) => a.id - b.id);
        for (let i = 0; i < group.length - 1; i++) {
          skip.add(group[i].id);
        }
      }
    }
    return skip;
  }, [messages]);

  // Build voiceSent lookup from orchestrator trace botCalls (for group chat)
  const orchVoiceSentMap = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const item of Object.values(orchCache)) {
      if (!item?.trace.botCalls) continue;
      for (const bc of item.trace.botCalls) {
        if (bc.requestId && bc.voiceSent) {
          map[bc.requestId] = true;
        }
      }
    }
    return map;
  }, [orchCache]);

  async function loadTrace(requestId: string, botId?: string | null) {
    if (traceCache[requestId] !== undefined || traceLoading.has(requestId)) return;
    setTraceLoading((prev) => new Set(prev).add(requestId));
    try {
      const result = await api.getTraceDetail(requestId, botId ?? undefined);
      setTraceCache((prev) => ({ ...prev, [requestId]: result }));
      const picked = pickTraceForRequest(result, requestId, botId);
      setChainCache((prev) => ({
        ...prev,
        [requestId]: picked
          ? {
              requestId,
              ...(picked.trace.parentRequestId && { parentRequestId: picked.trace.parentRequestId }),
            }
          : null,
      }));
    } catch {
      setTraceCache((prev) => ({ ...prev, [requestId]: null }));
      setChainCache((prev) => ({ ...prev, [requestId]: null }));
    } finally {
      setTraceLoading((prev) => {
        const next = new Set(prev);
        next.delete(requestId);
        return next;
      });
    }
  }

  function toggleExpand(key: string, requestId?: string | null, botId?: string | null) {
    if (requestId && traceCache[requestId] === undefined) {
      loadTrace(requestId, botId);
    }
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading messages...
      </div>
    );
  }

  if (error) {
    return <p className="px-4 py-4 text-sm text-destructive">{error}</p>;
  }

  if (!messages || messages.length === 0) {
    return (
      <p className="px-4 py-4 text-sm text-muted-foreground">No messages</p>
    );
  }

  const displayMessages = sortAsc ? messages : [...messages].reverse();

  return (
    <div>
      {subagentRuns.length > 0 && (
        <SubagentRunsPanel runs={subagentRuns} nameMap={nameMap} />
      )}
      <div className="divide-y divide-dashed px-4 py-2">
      {displayMessages.map((msg) => {
        // Skip tool-result and tool-call-only messages
        // (tool calls are shown inside BotMessageBubble on expand)
        if (msg.role === "tool") return null;
        if (
          msg.role === "assistant" &&
          !msg.content &&
          (msg.attachments?.length ?? 0) === 0 &&
          msg.toolCalls
        ) return null;
        // Skip intermediate assistant messages (same requestId, not the last one)
        if (skippedMsgIds.has(msg.id)) return null;

        if (msg.role === "subagent") {
          const parsed = parseSubagentMessage(msg);
          if (!parsed) return null;
          return (
            <SubagentMessageBubble
              key={msg.id}
              label={parsed.label}
              runId={parsed.runId}
              body={parsed.body}
            />
          );
        }

        if (msg.role === "user") {
          return (
            <div key={msg.id}>
              <UserMessageBubble
                text={sanitizeMessageText(msg.content)}
                attachments={msg.attachments}
                requestId={msg.requestId}
              />
              {groupId && msg.requestId && (
                <OrchestratorDecisionBlock
                  traceItem={orchCache[msg.requestId]}
                  nameMap={nameMap}
                />
              )}
            </div>
          );
        }

        if (msg.role === "assistant" && (msg.content || (msg.attachments?.length ?? 0) > 0)) {
          const botName = msg.botId
            ? nameMap[msg.botId] || msg.botId.slice(0, 8) + "\u2026"
            : "Assistant";
          const key = `bot:${msg.id}`;
          const cachedTraceItems = msg.requestId ? traceCache[msg.requestId] : undefined;
          const detail = msg.requestId && Array.isArray(cachedTraceItems)
            ? pickTraceForRequest(cachedTraceItems, msg.requestId, msg.botId)
            : undefined;
          const parentRequestId = msg.requestId
            ? chainCache[msg.requestId]?.parentRequestId
            : undefined;

          return (
            <BotMessageBubble
              key={msg.id}
              msg={msg}
              botName={botName}
              parentRequestId={parentRequestId}
              traceDetail={detail}
              d1ToolCalls={msg.requestId ? toolCallsByRequestId[msg.requestId] : undefined}
              traceLoading={msg.requestId ? traceLoading.has(msg.requestId) : false}
              expanded={expandedItems.has(key)}
              onToggle={() => toggleExpand(key, msg.requestId, msg.botId)}
              orchVoiceSent={msg.requestId ? orchVoiceSentMap[msg.requestId] : undefined}
            />
          );
        }

        return null;
      })}
      </div>
    </div>
  );
}

/** Group sessions by chatId for display */
interface ChatGroup {
  chatId: string;
  channel: string;
  groupId: string | null;
  botId: string | null;
  sessions: SessionSummary[];
  totalMessages: number;
  latestAt: string;
  latestMessageId: number;
}

function getChatGroupKeyFromSession(session: SessionSummary): string {
  return session.groupId
    ? `group:${session.groupId}`
    : `${session.channel}:${session.chatId}:${session.botId ?? "unknown"}`;
}

function getChatGroupKey(group: ChatGroup): string {
  return group.groupId
    ? `group:${group.groupId}`
    : `${group.channel}:${group.chatId}:${group.botId ?? "unknown"}`;
}

function compareByRecency(
  aLatestAt: string,
  aLatestMessageId?: number,
  bLatestAt?: string,
  bLatestMessageId?: number,
): number {
  const tsCmp = aLatestAt.localeCompare(bLatestAt ?? "");
  if (tsCmp !== 0) return tsCmp;
  return (aLatestMessageId ?? 0) - (bLatestMessageId ?? 0);
}

function groupSessionsByChatId(sessions: SessionSummary[]): ChatGroup[] {
  const map = new Map<string, ChatGroup>();
  for (const s of sessions) {
    const key = getChatGroupKeyFromSession(s);
    let group = map.get(key);
    if (!group) {
      group = {
        chatId: s.chatId,
        channel: s.channel,
        groupId: s.groupId,
        botId: s.botId ?? null,
        sessions: [],
        totalMessages: 0,
        latestAt: s.latestAt,
        latestMessageId: s.latestMessageId ?? 0,
      };
      map.set(key, group);
    }
    group.sessions.push(s);
    group.totalMessages += s.messageCount;
    if (
      compareByRecency(
        s.latestAt,
        s.latestMessageId,
        group.latestAt,
        group.latestMessageId,
      ) > 0
    ) {
      group.latestAt = s.latestAt;
      group.latestMessageId = s.latestMessageId ?? 0;
    }
  }
  return Array.from(map.values());
}

function ChatGroupSection({
  chatGroup,
  nameMap,
  sortAsc,
  autoExpandedSessionId,
}: {
  chatGroup: ChatGroup;
  nameMap: NameMap;
  sortAsc: boolean;
  autoExpandedSessionId: string | null;
}) {
  const [open, setOpen] = useState(Boolean(autoExpandedSessionId));
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(
    () => new Set(autoExpandedSessionId ? [autoExpandedSessionId] : []),
  );

  const isGroup = chatGroup.groupId != null;
  const hasCronSession = chatGroup.sessions.some((s) => s.sessionId.includes("cron"));
  // Show session headers for groups, cron sessions, or when multiple sessions exist
  const showSessionHeaders = isGroup || hasCronSession || chatGroup.sessions.length > 1;
  const displayName = isGroup
    ? nameMap[chatGroup.groupId!] || chatGroup.groupId!.slice(0, 8) + "\u2026"
    : chatGroup.botId
      ? nameMap[chatGroup.botId] || chatGroup.botId.slice(0, 8) + "\u2026"
      : "Unknown bot";
  const orderedSessions = useMemo(() => {
    const next = [...chatGroup.sessions];
    next.sort((a, b) => {
      const cmp = compareByRecency(
        a.latestAt,
        a.latestMessageId,
        b.latestAt,
        b.latestMessageId,
      );
      return sortAsc ? cmp : -cmp;
    });
    return next;
  }, [chatGroup.sessions, sortAsc]);

  return (
    <div className="rounded-md border">
      <div
        className={cn(
          "flex cursor-pointer items-center gap-2 px-4 py-3 hover:bg-muted/50",
          isGroup && "border-l-2 border-l-purple-500",
        )}
        onClick={() => setOpen(!open)}
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}

        {isGroup ? (
          <Users className="h-4 w-4 shrink-0 text-purple-500" />
        ) : (
          <MessageSquare className="h-4 w-4 shrink-0 text-blue-500" />
        )}

        <span className="font-medium">
          {isGroup ? "Group" : "Private"}
        </span>

        <Badge variant="outline" className="text-xs">
          {chatGroup.channel}
        </Badge>

        <span className="min-w-0 truncate text-sm">{displayName}</span>

        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {chatGroup.totalMessages} msg{chatGroup.totalMessages !== 1 ? "s" : ""}
          {showSessionHeaders &&
            ` · ${chatGroup.sessions.length} session${chatGroup.sessions.length !== 1 ? "s" : ""}`}
        </span>
      </div>

      {open && (
        <div className="border-t">
          {orderedSessions.map((session) => {
            const isExpanded = expandedSessions.has(session.sessionId);
            return (
              <div key={session.sessionId} className="border-b last:border-b-0">
                {showSessionHeaders && (
                  <div
                    className="flex cursor-pointer items-center gap-2 px-4 py-2 text-xs text-muted-foreground hover:bg-muted/30"
                    onClick={() => {
                      setExpandedSessions((prev) => {
                        const next = new Set(prev);
                        if (next.has(session.sessionId))
                          next.delete(session.sessionId);
                        else next.add(session.sessionId);
                        return next;
                      });
                    }}
                  >
                    {isExpanded ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                    <span className="inline-block max-w-[120px] truncate font-mono sm:max-w-none">{session.sessionId}</span>
                    <span>{session.messageCount} messages</span>
                    <span className="ml-auto">
                      {formatDateTime(session.latestAt)}
                    </span>
                  </div>
                )}
                {(isExpanded || !showSessionHeaders) && (
                  <SessionMessages
                    sessionId={session.sessionId}
                    nameMap={nameMap}
                    sortAsc={sortAsc}
                    groupId={chatGroup.groupId}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const CHATS_PER_PAGE = 10;

export function LogsPage() {
  const [date, setDate] = useState(todayStr);
  const [botFilter, setBotFilter] = useState("all");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [autoExpandedSessionId, setAutoExpandedSessionId] = useState<string | null>(null);
  const [autoExpandedGroupKey, setAutoExpandedGroupKey] = useState<string | null>(null);
  const [autoExpandVersion, setAutoExpandVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [visibleChats, setVisibleChats] = useState(CHATS_PER_PAGE);

  const [nameMap, setNameMap] = useState<NameMap>({});
  const [botOptions, setBotOptions] = useState<{ id: string; name: string }[]>(
    [],
  );

  // Load bot and group names on mount
  useEffect(() => {
    (async () => {
      const map: NameMap = {};
      const opts: { id: string; name: string }[] = [];
      try {
        const [bots, groups] = await Promise.all([
          api.listBots().catch(() => []),
          api.listGroups().catch(() => []),
        ]);
        for (const b of bots) {
          map[b.botId] = b.name;
          opts.push({ id: b.botId, name: b.name });
        }
        for (const g of groups) {
          map[g.groupId] = g.name;
          opts.push({ id: `orchestrator:${g.groupId}`, name: `${g.name} (group)` });
        }
      } catch {
        /* ignore */
      }
      setNameMap(map);
      setBotOptions(opts);
    })();
  }, []);

  const [sortAsc, setSortAsc] = useState(false);

  const chatGroups = useMemo(() => {
    const groups = groupSessionsByChatId(sessions);
    groups.sort((a, b) => {
      const cmp = compareByRecency(
        a.latestAt,
        a.latestMessageId,
        b.latestAt,
        b.latestMessageId,
      );
      return sortAsc ? cmp : -cmp;
    });
    return groups;
  }, [sessions, sortAsc]);

  const totalMessages = useMemo(
    () => sessions.reduce((s, sess) => s + sess.messageCount, 0),
    [sessions],
  );

  async function search() {
    setLoading(true);
    setError("");
    setVisibleChats(CHATS_PER_PAGE);
    try {
      const params: Parameters<typeof api.listSessions>[0] = {
        date,
        tzOffsetMinutes: getTzOffsetMinutesForDate(date),
        limit: 200,
      };
      if (botFilter !== "all") params.botId = botFilter;
      const result = await api.listSessions(params);
      const nextSessions = Array.isArray(result) ? result : [];
      setSessions(nextSessions);

      let latestSession: SessionSummary | null = null;
      for (const s of nextSessions) {
        if (
          !latestSession ||
          compareByRecency(
            s.latestAt,
            s.latestMessageId,
            latestSession.latestAt,
            latestSession.latestMessageId,
          ) > 0
        ) {
          latestSession = s;
        }
      }
      setAutoExpandedSessionId(latestSession?.sessionId ?? null);
      setAutoExpandedGroupKey(
        latestSession ? getChatGroupKeyFromSession(latestSession) : null,
      );
      setAutoExpandVersion((v) => v + 1);
    } catch (e) {
      setError(
        e instanceof api.ApiError ? e.message : "Failed to load sessions",
      );
      setSessions([]);
      setAutoExpandedSessionId(null);
      setAutoExpandedGroupKey(null);
      setAutoExpandVersion((v) => v + 1);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const displayedChats = chatGroups.slice(0, visibleChats);
  const hasMore = visibleChats < chatGroups.length;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Logs</h1>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground">
            Date
          </label>
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full sm:w-40"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground">
            Bot
          </label>
          <Select value={botFilter} onValueChange={setBotFilter}>
            <SelectTrigger className="w-full sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Bots</SelectItem>
              {botOptions.map((o) => (
                <SelectItem key={o.id} value={o.id}>
                  {o.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSortAsc((v) => !v)}
        >
          <ArrowUpDown className="mr-1 h-4 w-4" />
          {sortAsc ? "Oldest first" : "Newest first"}
        </Button>

        <Button onClick={search} disabled={loading}>
          {loading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Search className="mr-2 h-4 w-4" />
          )}
          Search
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {!loading && sessions.length > 0 && (
        <StatsCards sessions={sessions} messageCount={totalMessages} />
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading sessions...
        </div>
      ) : chatGroups.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-md border border-dashed py-12">
          <p className="text-sm text-muted-foreground">
            No sessions found for this date.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {displayedChats.map((cg) => (
            // Include version in key so each search refresh resets default expansion.
            <ChatGroupSection
              key={`${getChatGroupKey(cg)}:${autoExpandVersion}`}
              chatGroup={cg}
              nameMap={nameMap}
              sortAsc={sortAsc}
              autoExpandedSessionId={
                getChatGroupKey(cg) === autoExpandedGroupKey
                  ? autoExpandedSessionId
                  : null
              }
            />
          ))}

          {hasMore && (
            <div className="flex justify-center pt-2">
              <Button
                variant="outline"
                onClick={() =>
                  setVisibleChats((v) => v + CHATS_PER_PAGE)
                }
              >
                Load more ({chatGroups.length - visibleChats} remaining)
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
