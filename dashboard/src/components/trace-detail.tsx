import { useState } from "react";
import { ChevronDown, ChevronRight, AlertTriangle, Eye, EyeOff, MessageSquare, Bot, Wrench, BookOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn, sanitizeMessageText } from "@/lib/utils";
import type { TraceWithEntries, LogEntry, SkillCall } from "@/lib/types";

const KNOWN_FIELDS = new Set([
  "level",
  "msg",
  "ts",
  "requestId",
  "parentRequestId",
  "botId",
  "channel",
  "chatId",
  "sessionId",
]);

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString();
}

function levelColor(level: string) {
  switch (level) {
    case "error":
      return "text-red-500";
    case "warn":
      return "text-yellow-500";
    case "debug":
      return "text-muted-foreground";
    default:
      return "text-foreground";
  }
}

export function WaveViz({ waves }: { waves: unknown }) {
  if (!Array.isArray(waves)) return null;
  return (
    <div className="space-y-1">
      {waves.map((wave: unknown, i: number) => {
        const bots = Array.isArray(wave) ? wave : [];
        return (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className="font-medium text-muted-foreground">
              Wave {i + 1}:
            </span>
            <div className="flex flex-wrap gap-1">
              {bots.map((b: unknown, j: number) => (
                <Badge key={j} variant="outline" className="text-xs">
                  {String(b)}
                </Badge>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Extract highlights from log entries for a summary panel */
function Highlights({ entries, errorMessage }: { entries: LogEntry[]; errorMessage?: string }) {
  const wavesEntry = entries.find((e) => (e as Record<string, unknown>).waves !== undefined);
  const reasoningEntry = entries.find(
    (e) => typeof (e as Record<string, unknown>).reasoning === "string",
  );
  const waves = wavesEntry ? (wavesEntry as Record<string, unknown>).waves : null;
  const reasoning = reasoningEntry
    ? ((reasoningEntry as Record<string, unknown>).reasoning as string)
    : null;

  if (!waves && !reasoning && !errorMessage) return null;

  return (
    <div className="space-y-2 border-b px-3 py-2">
      {errorMessage && (
        <div className="flex items-start gap-2 rounded bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}
      {waves != null && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Wave Groups</p>
          <WaveViz waves={waves} />
        </div>
      )}
      {reasoning && (
        <div>
          <p className="mb-0.5 text-xs font-medium text-muted-foreground">Reasoning</p>
          <p className="whitespace-pre-wrap text-xs">{reasoning}</p>
        </div>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export interface ToolCallDetail {
  toolName: string;
  input: string;
  result: string;
  durationMs?: number;
}

export function ToolCallItem({ tc }: { tc: ToolCallDetail }) {
  const [open, setOpen] = useState(false);

  // Parse input for a short preview
  let inputPreview = "";
  try {
    const parsed = JSON.parse(tc.input);
    const firstVal = Object.values(parsed)[0];
    if (typeof firstVal === "string") {
      inputPreview = firstVal.length > 60 ? firstVal.slice(0, 60) + "..." : firstVal;
    }
  } catch {
    // ignore
  }

  return (
    <div className="border-b border-border/30 last:border-0">
      <div
        className="flex cursor-pointer items-start gap-1.5 py-1"
        onClick={() => setOpen(!open)}
      >
        {open ? (
          <ChevronDown className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <Wrench className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="font-mono font-medium">{tc.toolName}</span>
        {tc.durationMs != null && (
          <span className="font-mono text-muted-foreground">
            {formatDuration(tc.durationMs)}
          </span>
        )}
        {inputPreview && (
          <span className="truncate text-muted-foreground">
            ("{inputPreview}")
          </span>
        )}
      </div>
      {open && (
        <div className="mb-1 ml-7 space-y-1.5">
          <div>
            <span className="font-medium text-muted-foreground">input: </span>
            <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap rounded bg-muted/50 p-1.5 font-mono text-[11px]">
              {formatJson(tc.input)}
            </pre>
          </div>
          {tc.result && (
            <div>
              <span className="font-medium text-muted-foreground">result: </span>
              <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap rounded bg-muted/50 p-1.5 font-mono text-[11px]">
                {tc.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

export function EntryExtra({ entry }: { entry: LogEntry }) {
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (!KNOWN_FIELDS.has(k) && v !== undefined) {
      extra[k] = v;
    }
  }
  if (Object.keys(extra).length === 0) return null;

  const HANDLED = ["waves", "reasoning", "respondents", "userMessage", "shouldContinue", "toolCallDetails", "iteration", "llmDurationMs", "toolsDurationMs"];

  return (
    <div className="mt-1 space-y-1 pl-4 text-xs">
      {(typeof extra.llmDurationMs === "number" || typeof extra.toolsDurationMs === "number") && (
        <div className="flex gap-3">
          {typeof extra.llmDurationMs === "number" && (
            <span className="font-mono text-muted-foreground">
              LLM: {formatDuration(extra.llmDurationMs as number)}
            </span>
          )}
          {typeof extra.toolsDurationMs === "number" && (extra.toolsDurationMs as number) > 0 && (
            <span className="font-mono text-muted-foreground">
              Tools: {formatDuration(extra.toolsDurationMs as number)}
            </span>
          )}
        </div>
      )}
      {Array.isArray(extra.toolCallDetails) && (
        <div>
          {(extra.toolCallDetails as ToolCallDetail[]).map((tc, i) => (
            <ToolCallItem key={i} tc={tc} />
          ))}
        </div>
      )}
      {extra.waves !== undefined && <WaveViz waves={extra.waves} />}
      {typeof extra.reasoning === "string" && (
        <div>
          <span className="font-medium text-muted-foreground">reasoning: </span>
          <span className="whitespace-pre-wrap">{extra.reasoning}</span>
        </div>
      )}
      {extra.respondents !== undefined && (
        <div>
          <span className="font-medium text-muted-foreground">
            respondents:{" "}
          </span>
          <span>{JSON.stringify(extra.respondents)}</span>
        </div>
      )}
      {typeof extra.userMessage === "string" && (
        <div>
          <span className="font-medium text-muted-foreground">
            userMessage:{" "}
          </span>
          <span>{sanitizeMessageText(extra.userMessage as string)}</span>
        </div>
      )}
      {extra.shouldContinue !== undefined && (
        <div>
          <span className="font-medium text-muted-foreground">
            shouldContinue:{" "}
          </span>
          <span>{String(extra.shouldContinue)}</span>
        </div>
      )}
      {Object.entries(extra)
        .filter(([k]) => !HANDLED.includes(k))
        .map(([k, v]) => (
          <div key={k}>
            <span className="font-medium text-muted-foreground">{k}: </span>
            <span className="break-all">
              {typeof v === "string" ? v : JSON.stringify(v)}
            </span>
          </div>
        ))}
    </div>
  );
}

/** Group entries by iteration for structured display */
interface IterationGroup {
  iteration: number | null;
  entries: LogEntry[];
  llmDurationMs?: number;
  toolsDurationMs?: number;
}

export function groupByIteration(
  allEntries: LogEntry[],
  displayEntries: LogEntry[],
): IterationGroup[] {
  // Extract duration summary per iteration from all entries
  const summaryByIter = new Map<number, { llmDurationMs?: number; toolsDurationMs?: number }>();
  for (const e of allEntries) {
    const extra = e as Record<string, unknown>;
    const iter = extra.iteration as number | undefined;
    if (iter != null && e.msg === "LLM response") {
      summaryByIter.set(iter, {
        llmDurationMs: typeof extra.llmDurationMs === "number" ? extra.llmDurationMs as number : undefined,
        toolsDurationMs: typeof extra.toolsDurationMs === "number" ? extra.toolsDurationMs as number : undefined,
      });
    }
  }

  const groups: IterationGroup[] = [];
  let current: IterationGroup | null = null;
  for (const e of displayEntries) {
    const iter = (e as Record<string, unknown>).iteration as number | undefined ?? null;
    if (!current || current.iteration !== iter) {
      const summary: { llmDurationMs?: number; toolsDurationMs?: number } | undefined =
        iter != null ? summaryByIter.get(iter) : undefined;
      current = { iteration: iter, entries: [], ...summary };
      groups.push(current);
    }
    current!.entries.push(e);
  }

  return groups;
}

export function IterationBlock({
  iteration,
  totalIterations,
  entries,
  llmDurationMs,
  toolsDurationMs,
}: {
  iteration: number;
  totalIterations: number;
  entries: LogEntry[];
  llmDurationMs?: number;
  toolsDurationMs?: number;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div>
      <div
        className="flex cursor-pointer items-center gap-2 py-1.5 text-[11px] text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(!open)}
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <span className="font-medium">
          Iteration {iteration} / {totalIterations}
        </span>
        {llmDurationMs != null && (
          <span className="font-mono">
            LLM: {formatDuration(llmDurationMs)}
            {toolsDurationMs != null && toolsDurationMs > 0 && ` · Tools: ${formatDuration(toolsDurationMs)}`}
          </span>
        )}
      </div>
      {open && (
        <div className="border-l-2 border-muted pl-3">
          {entries.map((e, i) => (
            <EntryRow key={i} entry={e} hideInlineDuration />
          ))}
        </div>
      )}
    </div>
  );
}

export function EntryRow({ entry, hideInlineDuration }: { entry: LogEntry; hideInlineDuration?: boolean }) {
  const [open, setOpen] = useState(entry.msg === "Tool calls");
  const hasExtra = Object.keys(entry).some(
    (k) => !KNOWN_FIELDS.has(k) && entry[k] !== undefined,
  );

  // Inline duration summary for LLM response rows (visible without expanding)
  const extra = entry as Record<string, unknown>;
  const llmDuration = !hideInlineDuration && typeof extra.llmDurationMs === "number" ? extra.llmDurationMs as number : undefined;
  const toolsDuration = !hideInlineDuration && typeof extra.toolsDurationMs === "number" && (extra.toolsDurationMs as number) > 0
    ? extra.toolsDurationMs as number : undefined;

  return (
    <div className="border-b border-border/50 py-1 last:border-0">
      <div
        className={cn(
          "flex items-start gap-2 text-xs",
          hasExtra && "cursor-pointer",
        )}
        onClick={() => hasExtra && setOpen(!open)}
      >
        {hasExtra ? (
          open ? (
            <ChevronDown className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="inline-block w-3 shrink-0" />
        )}
        <span className="shrink-0 font-mono text-muted-foreground">
          {formatTime(entry.ts)}
        </span>
        <span
          className={cn(
            "w-10 shrink-0 text-right font-mono uppercase",
            levelColor(entry.level),
          )}
        >
          {entry.level}
        </span>
        <span className="break-all">{entry.msg}</span>
        {llmDuration != null && (
          <span className="shrink-0 font-mono text-muted-foreground">
            LLM: {formatDuration(llmDuration)}
            {toolsDuration != null && ` · Tools: ${formatDuration(toolsDuration)}`}
          </span>
        )}
      </div>
      {open && <EntryExtra entry={entry} />}
    </div>
  );
}

function SkillCallBadge({ skillCall }: { skillCall: SkillCall }) {
  const [open, setOpen] = useState(false);
  const hasErrors = skillCall.tools.some(t => t.isError);
  const label = skillCall.skill || "tool";

  return (
    <div className="relative">
      <Badge
        className={cn(
          "cursor-pointer text-xs gap-1",
          skillCall.skill
            ? "bg-purple-100 text-purple-700 hover:bg-purple-200 dark:bg-purple-900/30 dark:text-purple-300"
            : "",
          hasErrors && "ring-1 ring-red-400",
        )}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      >
        {skillCall.skill ? <BookOpen className="h-3 w-3" /> : <Wrench className="h-3 w-3" />}
        {label} ({skillCall.tools.length})
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </Badge>
      {open && (
        <div className="absolute left-0 top-full z-10 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-md border bg-popover p-2 shadow-md text-xs">
          {skillCall.tools.map((tc, j) => (
            <ToolCallItem key={j} tc={{ toolName: tc.name, input: tc.input, result: tc.result }} />
          ))}
        </div>
      )}
    </div>
  );
}

function SkillCallsDisplay({ skillCalls }: { skillCalls: SkillCall[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {skillCalls.map((sc, i) => (
        <SkillCallBadge key={i} skillCall={sc} />
      ))}
    </div>
  );
}

type NameMap = Record<string, string>;

function resolveBlockName(trace: TraceWithEntries["trace"], nameMap: NameMap): string {
  if (trace.botName) return trace.botName;
  const id = trace.botId;
  if (!id) return "unknown";
  if (id.startsWith("orchestrator:")) {
    const gid = id.replace("orchestrator:", "");
    return nameMap[gid] ? `group:${nameMap[gid]}` : id;
  }
  return nameMap[id] ?? id;
}

function TraceBlock({
  item,
  isChild,
  nameMap,
}: {
  item: TraceWithEntries;
  isChild: boolean;
  nameMap: NameMap;
}) {
  const { trace, entries } = item;
  const isOrchestrator = trace.botId?.startsWith("orchestrator:");
  const displayName = resolveBlockName(trace, nameMap);
  const [showAll, setShowAll] = useState(false);

  const filteredEntries = showAll
    ? entries
    : entries.filter((e) => e.level === "warn" || e.level === "error" || e.msg === "Starting LLM call" || e.msg === "Tool calls" || e.msg === "LLM response");
  const hiddenCount = entries.length - filteredEntries.length;
  const totalIterations = trace.iterations ?? 0;

  return (
    <div
      className={cn(
        "rounded-md border bg-card",
        isOrchestrator && "border-l-2 border-l-purple-500",
        isChild && !isOrchestrator && "ml-4 border-l-2 border-l-muted",
      )}
    >
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-sm">
        <span className={cn("font-medium", isOrchestrator && "text-purple-500")}>
          {displayName}
        </span>
        {trace.channel && <Badge variant="secondary">{trace.channel}</Badge>}
        <span className="text-muted-foreground">{trace.durationMs}ms</span>
        {trace.llmCalls > 0 && (
          <span className="text-muted-foreground">
            {trace.llmCalls} LLM call{trace.llmCalls > 1 ? "s" : ""}
          </span>
        )}
        {(trace.inputTokens > 0 || trace.outputTokens > 0) && (
          <span className="text-muted-foreground">
            {trace.inputTokens + trace.outputTokens} tokens
          </span>
        )}
        {trace.model && (
          <span className="font-mono text-xs text-muted-foreground">
            {trace.model}
          </span>
        )}
        {trace.skillCalls && trace.skillCalls.length > 0 && (
          <SkillCallsDisplay skillCalls={trace.skillCalls} />
        )}
      </div>

      {(trace.userMessage || trace.reply) && (
        <div className="space-y-1 border-b px-3 py-2">
          {trace.userMessage && (
            <div className="flex items-start gap-1.5 text-xs">
              <MessageSquare className="mt-0.5 h-3 w-3 shrink-0 text-blue-500" />
              <span>{sanitizeMessageText(trace.userMessage)}</span>
            </div>
          )}
          {trace.reply && (
            <div className="flex items-start gap-1.5 text-xs">
              <Bot className="mt-0.5 h-3 w-3 shrink-0 text-green-500" />
              <span className="text-muted-foreground">{sanitizeMessageText(trace.reply)}</span>
            </div>
          )}
        </div>
      )}

      <Highlights entries={entries} errorMessage={trace.errorMessage} />

      <div className="px-3 py-1">
        {entries.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">No log entries</p>
        ) : (
          <>
            {totalIterations > 1 ? (
              groupByIteration(entries, filteredEntries).map((group, gi) =>
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
              filteredEntries.map((e, i) => (
                <EntryRow key={`${showAll ? 'all' : 'filtered'}-${i}`} entry={e} />
              ))
            )}
            {hiddenCount > 0 && (
              <div className="py-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs text-muted-foreground"
                  onClick={() => setShowAll(true)}
                >
                  <Eye className="mr-1 h-3 w-3" />
                  Show all ({hiddenCount} hidden)
                </Button>
              </div>
            )}
            {showAll && hiddenCount === 0 && entries.some((e) => e.level === "debug" || e.level === "info") && (
              <div className="py-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs text-muted-foreground"
                  onClick={() => setShowAll(false)}
                >
                  <EyeOff className="mr-1 h-3 w-3" />
                  Show warnings/errors only
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function TraceDetail({ items, nameMap = {} }: { items: TraceWithEntries[]; nameMap?: NameMap }) {
  // Sort: orchestrator first, then by timestamp
  const sorted = [...items].sort((a, b) => {
    const aOrch = a.trace.botId?.startsWith("orchestrator:") ? 0 : 1;
    const bOrch = b.trace.botId?.startsWith("orchestrator:") ? 0 : 1;
    if (aOrch !== bOrch) return aOrch - bOrch;
    const aTs = a.entries[0]?.ts ?? 0;
    const bTs = b.entries[0]?.ts ?? 0;
    return aTs - bTs;
  });

  const hasMultiple = sorted.length > 1;

  return (
    <div className="space-y-3">
      {sorted.map((item, i) => (
        <TraceBlock
          key={i}
          item={item}
          isChild={hasMultiple && !item.trace.botId?.startsWith("orchestrator:")}
          nameMap={nameMap}
        />
      ))}
    </div>
  );
}
