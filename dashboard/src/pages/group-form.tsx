import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import * as api from "@/lib/api";
import type { BotConfig, GroupConfig, GroupResponse, CreateGroupInput } from "@/lib/types";

const ORCHESTRATOR_MODELS: Record<string, { value: string; label: string }[]> = {
  openai: [
    { value: "gpt-5", label: "GPT-5" },
    { value: "gpt-5.2", label: "GPT-5.2" },
  ],
  anthropic: [
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ],
  google: [
    { value: "gemini-3-flash-preview", label: "Gemini 3 Flash (Preview)" },
    { value: "gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite (Preview)" },
  ],
};

const ORCHESTRATOR_DEFAULT_MODEL: Record<string, string> = {
  openai: "gpt-5",
  anthropic: "claude-haiku-4-5-20251001",
  google: "gemini-3-flash-preview",
};

const CHANNEL_GUIDES: Record<string, string> = {
  telegram: "Add the following bots to your Telegram group to start chatting.",
  discord: "Invite the following bots to your Discord server.",
  slack: "Add the following bots to your Slack channel.",
};

export function GroupFormPage() {
  const { groupId } = useParams();
  const navigate = useNavigate();
  const isEdit = !!groupId;

  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [orchestratorProvider, setOrchestratorProvider] = useState<"openai" | "anthropic" | "google">("anthropic");
  const [orchestratorModel, setOrchestratorModel] = useState("claude-sonnet-4-6");
  const [selectedBotIds, setSelectedBotIds] = useState<string[]>([]);
  const [bots, setBots] = useState<BotConfig[]>([]);
  const [, setGroup] = useState<GroupConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [showGuide, setShowGuide] = useState(false);

  useEffect(() => {
    api.listBots().then(setBots).catch(() => {});

    if (!groupId) return;
    setLoading(true);
    api
      .getGroup(groupId)
      .then((g) => {
        setGroup(g);
        setName(g.name);
        setNote(g.note ?? "");
        const provider = g.orchestratorProvider ?? "anthropic";
        setOrchestratorProvider(provider);
        const modelValid = (ORCHESTRATOR_MODELS[provider] ?? []).some(m => m.value === g.orchestratorModel);
        setOrchestratorModel(modelValid ? g.orchestratorModel! : ORCHESTRATOR_DEFAULT_MODEL[provider] ?? "claude-sonnet-4-6");
        setSelectedBotIds(g.botIds);
        if (g.warnings && g.warnings.length > 0) {
          setWarnings(g.warnings);
        }
      })
      .catch((e) =>
        setError(e instanceof api.ApiError ? e.message : "Failed to load group"),
      )
      .finally(() => setLoading(false));
  }, [groupId]);

  function handleOrchestratorProviderChange(provider: "openai" | "anthropic" | "google") {
    setOrchestratorProvider(provider);
    setOrchestratorModel(ORCHESTRATOR_DEFAULT_MODEL[provider] ?? "claude-sonnet-4-6");
  }

  function toggleBot(botId: string) {
    setSelectedBotIds((prev) =>
      prev.includes(botId)
        ? prev.filter((id) => id !== botId)
        : [...prev, botId],
    );
  }

  function handleResponse(resp: GroupResponse) {
    setGroup(resp);
    if (resp.warnings && resp.warnings.length > 0) {
      setWarnings(resp.warnings);
    }
    setShowGuide(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const botIds = selectedBotIds.filter((id) => {
      const bot = bots.find((b) => b.botId === id);
      return bot?.botType !== "admin";
    });
    if (botIds.length < 2) {
      setError("A group needs at least 2 bots.");
      return;
    }
    setSaving(true);
    setError("");
    setWarnings([]);
    setShowGuide(false);

    try {
      if (isEdit && groupId) {
        const resp = await api.updateGroup(groupId, {
          name,
          botIds,
          note,
          orchestratorProvider,
          orchestratorModel,
        });
        handleResponse(resp);
      } else {
        const input: CreateGroupInput = {
          name,
          botIds,
          note,
          orchestratorProvider,
          orchestratorModel,
        };
        const resp = await api.createGroup(input);
        handleResponse(resp);
        navigate(`/groups/${resp.groupId}`, { replace: true });
      }
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : "Failed to save group");
    } finally {
      setSaving(false);
    }
  }

  // Derive channel info from selected bots
  const selectedBots = bots.filter((b) => selectedBotIds.includes(b.botId));
  const channelToBots = new Map<string, BotConfig[]>();
  for (const bot of selectedBots) {
    for (const ch of Object.keys(bot.channels)) {
      const list = channelToBots.get(ch) ?? [];
      list.push(bot);
      channelToBots.set(ch, list);
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">
          {isEdit ? "Edit Group" : "Create Group"}
        </h1>
        <Button variant="outline" onClick={() => navigate("/groups")}>
          Back
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {warnings.map((w, i) => (
        <p key={i} className="text-sm text-yellow-600 dark:text-yellow-400">
          {w}
        </p>
      ))}

      <form onSubmit={handleSubmit} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Group Info</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="group-name">Name</Label>
              <Input
                id="group-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Investment Debate"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="group-note">Note</Label>
              <Input
                id="group-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. Ryan is their boyfriend, a programmer working from home"
              />
              <p className="text-xs text-muted-foreground">
                Extra context for bots in this group chat.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Orchestrator Provider</Label>
                <Select
                  value={orchestratorProvider}
                  onValueChange={handleOrchestratorProviderChange}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="anthropic">Anthropic</SelectItem>
                    <SelectItem value="openai">OpenAI</SelectItem>
                    <SelectItem value="google">Google</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Orchestrator Model</Label>
                <Select
                  key={orchestratorProvider}
                  value={orchestratorModel}
                  onValueChange={setOrchestratorModel}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(ORCHESTRATOR_MODELS[orchestratorProvider] ?? []).map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  The model used to orchestrate group chat dispatch decisions.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Members</CardTitle>
          </CardHeader>
          <CardContent>
            {bots.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No bots available. Create some bots first.
              </p>
            ) : (
              <div className="space-y-2">
                {bots.filter((bot) => bot.botType !== "admin").map((bot) => (
                  <label
                    key={bot.botId}
                    className="flex items-center gap-2 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selectedBotIds.includes(bot.botId)}
                      onChange={() => toggleBot(bot.botId)}
                      className="h-4 w-4 rounded border-input"
                    />
                    <span className="text-sm font-medium">{bot.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {bot.provider} / {bot.model}
                    </span>
                    <div className="flex gap-1">
                      {Object.keys(bot.channels).map((ch) => (
                        <Badge key={ch} variant="outline" className="text-[10px] px-1 py-0">
                          {ch}
                        </Badge>
                      ))}
                    </div>
                  </label>
                ))}
              </div>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              Select at least 2 bots for the group.
            </p>
          </CardContent>
        </Card>

        <Button type="submit" disabled={saving}>
          {saving ? "Saving..." : isEdit ? "Update Group" : "Create Group"}
        </Button>
      </form>

      {showGuide && channelToBots.size > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Usage Guide</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {[...channelToBots.entries()].map(([ch, chBots]) => (
              <div key={ch}>
                <p className="text-sm font-medium capitalize">{ch}</p>
                <p className="text-xs text-muted-foreground mb-1">
                  {CHANNEL_GUIDES[ch] ?? `Add the following bots to your ${ch} chat.`}
                </p>
                <div className="flex flex-wrap gap-1">
                  {chBots.map((b) => (
                    <Badge key={b.botId} variant="secondary">
                      {b.name}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
