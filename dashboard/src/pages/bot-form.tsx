import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { ChevronsUpDown, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TTS_PROVIDERS, CUSTOM_VOICE_ID } from "@/lib/voice-catalog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChannelPanel } from "@/components/channel-panel";
import { McpServerEditor } from "@/components/mcp-server-editor";
import * as api from "@/lib/api";
import type { BotConfig, CreateBotInput, MaskedKeys, SkillInfo } from "@/lib/types";

const ALL_TIMEZONES = Intl.supportedValuesOf("timeZone");

const MODELS_BY_PROVIDER: Record<string, { value: string; label: string }[]> = {
  openai: [
    { value: "gpt-5.4", label: "GPT-5.4" },
    { value: "gpt-5.2", label: "GPT-5.2" },
    { value: "gpt-5", label: "GPT-5" },
  ],
  anthropic: [
    { value: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ],
  google: [
    { value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (Preview)" },
    { value: "gemini-3-flash-preview", label: "Gemini 3 Flash (Preview)" },
    { value: "gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite (Preview)" },
  ],
  deepseek: [
    { value: "deepseek-chat", label: "DeepSeek V3.2" },
    { value: "deepseek-reasoner", label: "DeepSeek R1" },
  ],
  moonshot: [
    { value: "kimi-k2.5", label: "Kimi K2.5" },
    { value: "kimi-k2-thinking", label: "Kimi K2 Thinking" },
  ],
  xai: [
    { value: "grok-4.1", label: "Grok 4.1" },
    { value: "grok-4.1-fast", label: "Grok 4.1 Fast" },
  ],
};

const IMAGE_MODELS_BY_PROVIDER: Record<string, { value: string; label: string }[]> = {
  openai: [
    { value: "gpt-image-1.5", label: "GPT Image 1.5" },
    { value: "gpt-image-1-mini", label: "GPT Image 1 Mini" },
  ],
  xai: [
    { value: "grok-imagine-image", label: "Grok Imagine Image" },
    { value: "grok-imagine-image-pro", label: "Grok Imagine Image Pro" },
  ],
  google: [
    { value: "gemini-3.1-flash-image-preview", label: "Gemini 3.1 Flash Image (Preview)" },
    { value: "gemini-3-pro-image-preview", label: "Gemini 3 Pro Image (Preview)" },
  ],
};

const DEFAULT_FORM: CreateBotInput = {
  name: "",
  soul: "",
  agents: "",
  user: "",
  tools: "",
  identity: "",
  provider: "openai",
  model: MODELS_BY_PROVIDER["openai"][0].value,
  baseUrl: "",
  avatarUrl: "",
  enabledSkills: [],
  maxIterations: 10,
  memoryWindow: 50,
  imageProvider: undefined,
  imageModel: undefined,
  timezone: undefined,
  mcpServers: {},
  allowedSenderIds: [],
  sttEnabled: false,
  voiceMode: "off" as "off" | "always" | "mirror",
  ttsProvider: "fish" as "elevenlabs" | "fish",
  ttsVoice: "",
  ttsModel: "s2-pro",
};

const BOOTSTRAP_FIELDS: {
  key: keyof CreateBotInput;
  label: string;
  placeholder: string;
}[] = [
  { key: "identity", label: "Identity", placeholder: "Custom identity definition (optional)" },
  { key: "soul", label: "Soul", placeholder: "Personality, values, communication style" },
  { key: "agents", label: "Agent Instructions", placeholder: "Guidelines for agent behavior" },
  { key: "user", label: "User Info", placeholder: "User preferences, timezone, language" },
  { key: "tools", label: "Tools", placeholder: "Custom tool usage instructions (optional)" },
];

export function BotFormPage() {
  const { botId } = useParams();
  const navigate = useNavigate();
  const isEdit = !!botId;

  const [form, setForm] = useState<CreateBotInput>({ ...DEFAULT_FORM });
  const [bot, setBot] = useState<BotConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [maskedKeys, setMaskedKeys] = useState<MaskedKeys | null>(null);
  const [availableSkills, setAvailableSkills] = useState<SkillInfo[]>([]);
  const [newSenderId, setNewSenderId] = useState("");

  useEffect(() => {
    api.getKeys().then(setMaskedKeys).catch(() => {});
    api.listSkills().then(setAvailableSkills).catch(() => {});
  }, []);

  useEffect(() => {
    if (!botId) return;
    setLoading(true);
    api
      .getBot(botId)
      .then((b) => {
        setBot(b);
        setForm({
          name: b.name,
          soul: b.soul,
          agents: b.agents,
          user: b.user,
          tools: b.tools,
          identity: b.identity,
          provider: b.provider,
          model: b.model,
          baseUrl: b.baseUrl ?? "",
          avatarUrl: b.avatarUrl ?? "",
          imageProvider: b.imageProvider,
          imageModel: b.imageModel,
          enabledSkills: b.enabledSkills,
          maxIterations: b.maxIterations,
          memoryWindow: b.memoryWindow,
          timezone: b.timezone,
          mcpServers: b.mcpServers,
          allowedSenderIds: b.allowedSenderIds ?? [],
          sttEnabled: b.sttEnabled ?? false,
          voiceMode: (b.voiceMode ?? "off") as "off" | "always" | "mirror",
          ttsProvider: (b.ttsProvider ?? "fish") as "elevenlabs" | "fish",
          ...(() => {
            const p = (b.ttsProvider ?? "fish") as "elevenlabs" | "fish";
            const cfg = TTS_PROVIDERS[p];
            const voiceInPreset = cfg.voices.some(v => v.id === b.ttsVoice);
            const keepCustomVoice = cfg.allowCustomVoice && b.ttsVoice && !voiceInPreset;
            return {
              ttsVoice: voiceInPreset || keepCustomVoice ? b.ttsVoice! : cfg.defaultVoice,
              ttsModel: cfg.models.some(m => m.id === b.ttsModel) ? b.ttsModel! : cfg.defaultModel,
            };
          })(),
        });
      })
      .catch((e) =>
        setError(e instanceof api.ApiError ? e.message : "Failed to load bot"),
      )
      .finally(() => setLoading(false));
  }, [botId]);

  function updateField<K extends keyof CreateBotInput>(
    key: K,
    value: CreateBotInput[K],
  ) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function toggleSkill(skillName: string) {
    const current = form.enabledSkills ?? [];
    const next = current.includes(skillName)
      ? current.filter((s) => s !== skillName)
      : [...current, skillName];
    updateField("enabledSkills", next);
  }

  function handleProviderChange(provider: CreateBotInput["provider"]) {
    updateField("provider", provider);
    const models = MODELS_BY_PROVIDER[provider];
    if (models && models.length > 0) {
      updateField("model", models[0].value);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");

    const payload: CreateBotInput = {
      ...form,
      baseUrl: form.baseUrl || undefined,
      avatarUrl: form.avatarUrl || undefined,
      imageProvider: form.imageProvider || undefined,
      imageModel: form.imageProvider ? form.imageModel : undefined,
      allowedSenderIds: form.allowedSenderIds ?? [],
      sttEnabled: form.sttEnabled ?? false,
      voiceMode: form.voiceMode ?? "off",
      ttsProvider: form.ttsProvider ?? "fish",
      ttsVoice: form.ttsVoice === CUSTOM_VOICE_ID ? "" : form.ttsVoice,
      ttsModel: form.ttsModel,
    };

    try {
      if (isEdit && botId) {
        const updated = await api.updateBot(botId, payload);
        setBot(updated);
      } else {
        await api.createBot(payload);
        navigate("/");
      }
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : "Failed to save bot");
    } finally {
      setSaving(false);
    }
  }

  async function reloadBot() {
    if (!botId) return;
    const b = await api.getBot(botId);
    setBot(b);
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }

  function keyStatus(providerKey: string | undefined): "configured" | "missing" | "unknown" {
    if (!maskedKeys) return "unknown";
    const val = (maskedKeys as unknown as Record<string, string | null>)[providerKey ?? ""];
    return val ? "configured" : "missing";
  }

  const models = MODELS_BY_PROVIDER[form.provider ?? "openai"] ?? [];
  const imageModels = form.imageProvider ? (IMAGE_MODELS_BY_PROVIDER[form.imageProvider] ?? []) : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">
          {isEdit ? "Edit Bot" : "Create Bot"}
        </h1>
        <Button variant="outline" onClick={() => navigate("/")}>
          Back
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Basic Info */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Basic Info</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={form.name}
                onChange={(e) => updateField("name", e.target.value)}
                required
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label>Provider</Label>
                  {maskedKeys && (
                    keyStatus(form.provider) === "configured"
                      ? <span className="text-xs text-green-600">Key configured</span>
                      : <span className="text-xs text-amber-600">Key not set</span>
                  )}
                </div>
                <Select
                  value={form.provider}
                  onValueChange={(v) =>
                    handleProviderChange(v as CreateBotInput["provider"])
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">OpenAI</SelectItem>
                    <SelectItem value="anthropic">Anthropic</SelectItem>
                    <SelectItem value="google">Google</SelectItem>
                    <SelectItem value="deepseek">DeepSeek</SelectItem>
                    <SelectItem value="moonshot">Moonshot</SelectItem>
                    <SelectItem value="xai">xAI</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Model</Label>
                <Select
                  key={form.provider}
                  value={form.model}
                  onValueChange={(v) => updateField("model", v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a model" />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="baseUrl">Base URL (optional)</Label>
              <Input
                id="baseUrl"
                value={form.baseUrl ?? ""}
                onChange={(e) => updateField("baseUrl", e.target.value)}
                placeholder="For OpenAI-compatible providers"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="avatarUrl">Avatar URL (optional)</Label>
              <Input
                id="avatarUrl"
                value={form.avatarUrl ?? ""}
                onChange={(e) => updateField("avatarUrl", e.target.value)}
                placeholder="Avatar image URL for group chat identity"
              />
            </div>
          </CardContent>
        </Card>

        {/* Persona & Instructions */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Persona & Instructions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {BOOTSTRAP_FIELDS.map(({ key, label, placeholder }) => (
              <div key={key} className="space-y-2">
                <Label htmlFor={key}>{label}</Label>
                <Textarea
                  id={key}
                  value={(form[key] as string) ?? ""}
                  onChange={(e) => updateField(key, e.target.value)}
                  rows={3}
                  placeholder={placeholder}
                />
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Skills */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Skills</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {availableSkills
              .filter((s) => s.available && (!s.adminOnly || (isEdit && bot?.botType === "admin")))
              .map((skill) => {
                const isAdminAuto = skill.adminOnly && isEdit && bot?.botType === "admin";
                return (
                  <label
                    key={skill.name}
                    className={`flex items-start gap-2 ${isAdminAuto ? "opacity-70" : "cursor-pointer"}`}
                  >
                    <input
                      type="checkbox"
                      checked={isAdminAuto || (form.enabledSkills?.includes(skill.name) ?? false)}
                      onChange={() => !isAdminAuto && toggleSkill(skill.name)}
                      disabled={isAdminAuto}
                      className="h-4 w-4 shrink-0 rounded border-input mt-0.5"
                    />
                    <div className="grid grid-cols-[auto_1fr] items-baseline gap-x-1.5">
                      <span className="text-sm whitespace-nowrap">
                        {skill.emoji ? `${skill.emoji} ` : skill.source === "installed" ? "📦 " : ""}
                        {skill.name.replace(/^custom\//, "")}
                      </span>
                      <span className="text-xs text-muted-foreground flex">
                        <span className="shrink-0">—&nbsp;</span>
                        <span>{skill.description}{isAdminAuto ? " (auto)" : ""}</span>
                      </span>
                    </div>
                  </label>
                );
              })}
            {availableSkills.length === 0 && (
              <p className="text-xs text-muted-foreground">Loading skills...</p>
            )}
          </CardContent>
        </Card>

        {/* Voice */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Voice</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                id="sttEnabled"
                checked={form.sttEnabled ?? false}
                onChange={(e) => updateField("sttEnabled", e.target.checked)}
                className="h-4 w-4 rounded border-input"
              />
              <Label htmlFor="sttEnabled">Speech-to-Text</Label>
              <span className="text-xs text-muted-foreground">
                Auto-transcribe incoming voice messages
              </span>
            </div>

            <div className="space-y-2 pt-4 mt-2 border-t">
              <Label>Voice Response</Label>
              <Select
                value={form.voiceMode ?? "off"}
                onValueChange={(v) => updateField("voiceMode", v as "off" | "always" | "mirror")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">Off</SelectItem>
                  <SelectItem value="always">Always</SelectItem>
                  <SelectItem value="mirror">Mirror (reply with voice when user sends voice)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {(() => {
              if ((form.voiceMode ?? "off") === "off") return null;
              const currentProvider = (form.ttsProvider ?? "fish") as "elevenlabs" | "fish";
              const providerCfg = TTS_PROVIDERS[currentProvider];
              const femaleVoices = providerCfg.voices.filter(v => v.gender === "female");
              const maleVoices = providerCfg.voices.filter(v => v.gender === "male");
              const ttsKeyName = providerCfg.keyName;
              const currentVoice = form.ttsVoice ?? providerCfg.defaultVoice;
              const isPresetVoice = providerCfg.voices.some(v => v.id === currentVoice);
              const showCustomInput = providerCfg.allowCustomVoice && !isPresetVoice;

              return (
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Provider</Label>
                    <Select
                      value={currentProvider}
                      onValueChange={(v) => {
                        const provider = v as "elevenlabs" | "fish";
                        const cfg = TTS_PROVIDERS[provider];
                        setForm((prev) => ({
                          ...prev,
                          ttsProvider: provider,
                          ttsVoice: cfg.defaultVoice,
                          ttsModel: cfg.defaultModel,
                        }));
                      }}
                    >
                      <SelectTrigger className="h-8 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(TTS_PROVIDERS).map(([key, cfg]) => (
                          <SelectItem key={key} value={key}>{cfg.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs">Voice</Label>
                    <Select
                      key={`voice-${currentProvider}-${showCustomInput}`}
                      value={showCustomInput ? CUSTOM_VOICE_ID : currentVoice}
                      onValueChange={(v) => {
                        if (v === CUSTOM_VOICE_ID) {
                          updateField("ttsVoice", CUSTOM_VOICE_ID);
                        } else {
                          updateField("ttsVoice", v);
                        }
                      }}
                    >
                      <SelectTrigger className="h-8 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectLabel>Female</SelectLabel>
                          {femaleVoices.map((v) => (
                            <SelectItem key={v.id} value={v.id}>{v.label}</SelectItem>
                          ))}
                        </SelectGroup>
                        <SelectGroup>
                          <SelectLabel>Male</SelectLabel>
                          {maleVoices.map((v) => (
                            <SelectItem key={v.id} value={v.id}>{v.label}</SelectItem>
                          ))}
                        </SelectGroup>
                        {providerCfg.allowCustomVoice && (
                          <>
                            <SelectSeparator />
                            <SelectItem value={CUSTOM_VOICE_ID}>
                              <span className="text-primary font-medium">Custom voice ID</span>
                            </SelectItem>
                          </>
                        )}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs">Model</Label>
                    <Select
                      key={`model-${currentProvider}`}
                      value={form.ttsModel ?? providerCfg.defaultModel}
                      onValueChange={(v) => updateField("ttsModel", v)}
                    >
                      <SelectTrigger className="h-8 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {providerCfg.models.map((m) => (
                          <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {showCustomInput && (
                    <div className="sm:col-span-2 flex gap-2 items-center">
                      <Input
                        value={currentVoice === CUSTOM_VOICE_ID ? "" : currentVoice}
                        onChange={(e) => updateField("ttsVoice", e.target.value || CUSTOM_VOICE_ID)}
                        placeholder="Paste voice model ID"
                        className="h-8 text-sm"
                      />
                      {providerCfg.voiceLibraryUrl && (
                        <a
                          href={providerCfg.voiceLibraryUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary hover:underline whitespace-nowrap"
                        >
                          Browse &rarr;
                        </a>
                      )}
                    </div>
                  )}

                  <div className="sm:col-span-3">
                    {maskedKeys && (
                      keyStatus(ttsKeyName) === "configured"
                        ? <span className="text-xs text-green-600">{providerCfg.label} key configured</span>
                        : <span className="text-xs text-amber-600">{providerCfg.label} key not set</span>
                    )}
                  </div>
                </div>
              );
            })()}
          </CardContent>
        </Card>

        {/* Advanced */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Advanced</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label>Image Provider</Label>
                  {form.imageProvider && maskedKeys && (
                    keyStatus(form.imageProvider) === "configured"
                      ? <span className="text-xs text-green-600">Key configured</span>
                      : <span className="text-xs text-amber-600">Key not set</span>
                  )}
                </div>
                <Select
                  value={form.imageProvider ?? "none"}
                  onValueChange={(v) => {
                    const ip = v === "none" ? undefined : v as "openai" | "xai" | "google";
                    updateField("imageProvider", ip);
                    if (ip) {
                      const models = IMAGE_MODELS_BY_PROVIDER[ip];
                      updateField("imageModel", models?.[0]?.value);
                    } else {
                      updateField("imageModel", undefined);
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="openai">OpenAI</SelectItem>
                    <SelectItem value="xai">xAI</SelectItem>
                    <SelectItem value="google">Google</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {form.imageProvider && (
                <div className="space-y-2">
                  <Label>Image Model</Label>
                  <Select
                    key={form.imageProvider}
                    value={form.imageModel ?? ""}
                    onValueChange={(v) => updateField("imageModel", v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select a model" />
                    </SelectTrigger>
                    <SelectContent>
                      {imageModels.map((m) => (
                        <SelectItem key={m.value} value={m.value}>
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="maxIterations">Max Iterations</Label>
                <Input
                  id="maxIterations"
                  type="number"
                  value={form.maxIterations}
                  onChange={(e) =>
                    updateField("maxIterations", Number(e.target.value))
                  }
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="memoryWindow">Memory Window</Label>
                <Input
                  id="memoryWindow"
                  type="number"
                  value={form.memoryWindow}
                  onChange={(e) =>
                    updateField("memoryWindow", Number(e.target.value))
                  }
                />
              </div>

              <div className="space-y-2">
                <Label>Timezone</Label>
                <TimezoneCombobox
                  value={form.timezone}
                  onSelect={(tz) => updateField("timezone", tz)}
                  onClear={() => updateField("timezone", undefined)}
                />
              </div>
            </div>

            {isEdit && bot?.botType === "admin" && (
              <div className="space-y-2 pt-2 border-t">
                <Label>Allowed Sender IDs</Label>
                <p className="text-xs text-muted-foreground">
                  Channel-native user IDs (e.g., Telegram user ID) allowed to chat with this admin bot via external channels. Leave empty to block all external messages.
                </p>
                <div className="flex flex-wrap gap-2">
                  {(form.allowedSenderIds ?? []).map((id) => (
                    <span
                      key={id}
                      className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-3 py-1 text-sm text-blue-800"
                    >
                      {id}
                      <button
                        type="button"
                        onClick={() => {
                          const updated = (form.allowedSenderIds ?? []).filter(x => x !== id);
                          updateField("allowedSenderIds", updated);
                        }}
                        className="ml-1 text-blue-600 hover:text-blue-900"
                      >
                        &times;
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Input
                    placeholder="Enter sender ID and press Enter or click Add"
                    value={newSenderId}
                    onChange={(e) => setNewSenderId(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        const value = newSenderId.trim();
                        if (value && !(form.allowedSenderIds ?? []).includes(value)) {
                          updateField("allowedSenderIds", [...(form.allowedSenderIds ?? []), value]);
                          setNewSenderId("");
                        }
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const value = newSenderId.trim();
                      if (value && !(form.allowedSenderIds ?? []).includes(value)) {
                        updateField("allowedSenderIds", [...(form.allowedSenderIds ?? []), value]);
                        setNewSenderId("");
                      }
                    }}
                  >
                    Add
                  </Button>
                </div>
              </div>
            )}

          </CardContent>
        </Card>

        {/* MCP Servers */}
        <McpServerEditor
          servers={form.mcpServers ?? {}}
          onChange={(s) => updateField("mcpServers", s)}
        />

        <Button type="submit" disabled={saving}>
          {saving ? "Saving..." : isEdit ? "Update Bot" : "Create Bot"}
        </Button>
      </form>

      {isEdit && bot && (
        <ChannelPanel
          channels={bot.channels}
          onBind={async (channel, token, webhookUrl) => {
            await api.bindChannel(bot.botId, channel, token, webhookUrl);
            await reloadBot();
          }}
          onUnbind={async (channel) => {
            await api.unbindChannel(bot.botId, channel);
            await reloadBot();
          }}
        />
      )}
    </div>
  );
}

/* ---------- Timezone Combobox ---------- */

function TimezoneCombobox({
  value,
  onSelect,
  onClear,
}: {
  value: string | undefined;
  onSelect: (tz: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    if (!search) return ALL_TIMEZONES;
    const q = search.toLowerCase();
    return ALL_TIMEZONES.filter((tz) => tz.toLowerCase().includes(q));
  }, [search]);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setSearch("");
          setTimeout(() => inputRef.current?.focus(), 0);
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
        >
          <span className={value ? "" : "text-muted-foreground"}>
            {value ?? "Select timezone..."}
          </span>
          <div className="flex items-center gap-1">
            {value && (
              <button
                type="button"
                aria-label="Clear timezone"
                className="rounded-sm p-0.5 hover:bg-accent"
                onClick={(e) => {
                  e.stopPropagation();
                  onClear();
                }}
              >
                <X className="size-3.5" />
              </button>
            )}
            <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
          </div>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <div className="p-2">
          <Input
            ref={inputRef}
            placeholder="Search timezone..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="max-h-60 overflow-y-auto px-1 pb-1">
          {filtered.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No timezone found.
            </p>
          )}
          {filtered.map((tz) => (
            <button
              key={tz}
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent cursor-pointer"
              onClick={() => {
                onSelect(tz);
                setOpen(false);
              }}
            >
              <Check
                className={`size-4 shrink-0 ${value === tz ? "opacity-100" : "opacity-0"}`}
              />
              {tz}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ---------- Voice Preview Button ---------- */

function VoicePreviewButton({ voice }: { voice: string }) {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  function handleClick() {
    if (playing && audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setPlaying(false);
      return;
    }

    const audio = new Audio(`/voice-samples/${voice}.mp3`);
    audioRef.current = audio;
    audio.onended = () => setPlaying(false);
    audio.onerror = () => setPlaying(false);
    audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={handleClick}>
      {playing ? "Stop" : "Preview"}
    </Button>
  );
}
