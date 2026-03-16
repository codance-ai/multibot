import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import * as api from "@/lib/api";
import type { MaskedKeys, UpdateKeysInput, SkillInfo } from "@/lib/types";

const KEY_LABELS: { key: keyof MaskedKeys; label: string }[] = [
  { key: "openai", label: "OpenAI" },
  { key: "anthropic", label: "Anthropic" },
  { key: "google", label: "Google" },
  { key: "deepseek", label: "DeepSeek" },
  { key: "moonshot", label: "Moonshot" },
  { key: "brave", label: "Brave Search" },
  { key: "xai", label: "xAI" },
  { key: "elevenlabs", label: "ElevenLabs" },
  { key: "fish", label: "Fish Audio" },
];

export function SettingsPage() {
  const [maskedKeys, setMaskedKeys] = useState<MaskedKeys>({
    openai: null,
    anthropic: null,
    google: null,
    deepseek: null,
    moonshot: null,
    brave: null,
    xai: null,
    elevenlabs: null,
    fish: null,
  });
  const [inputs, setInputs] = useState<Record<string, string>>({
    openai: "",
    anthropic: "",
    google: "",
    deepseek: "",
    moonshot: "",
    brave: "",
    xai: "",
    elevenlabs: "",
    fish: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Skills state
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [skillsError, setSkillsError] = useState("");
  const [deletingSkill, setDeletingSkill] = useState<string | null>(null);

  // Skill secrets state
  const [secretInputs, setSecretInputs] = useState<Record<string, Record<string, string>>>({});
  const [secretMasked, setSecretMasked] = useState<Record<string, Record<string, string>>>({});
  const [savingSecret, setSavingSecret] = useState<string | null>(null);
  const [secretSuccess, setSecretSuccess] = useState("");

  useEffect(() => {
    api
      .getKeys()
      .then(setMaskedKeys)
      .catch((e) =>
        setError(e instanceof api.ApiError ? e.message : "Failed to load keys"),
      )
      .finally(() => setLoading(false));

    loadSkills();
    loadSecrets();
  }, []);

  function loadSkills() {
    setSkillsLoading(true);
    setSkillsError("");
    api
      .listSkills()
      .then(setSkills)
      .catch((e) =>
        setSkillsError(
          e instanceof api.ApiError ? e.message : "Failed to load skills",
        ),
      )
      .finally(() => setSkillsLoading(false));
  }

  async function handleDeleteSkill(name: string) {
    setDeletingSkill(name);
    setSkillsError("");
    try {
      await api.deleteSkill(name);
      loadSkills();
    } catch (e) {
      setSkillsError(
        e instanceof api.ApiError ? e.message : "Failed to delete skill",
      );
    } finally {
      setDeletingSkill(null);
    }
  }

  function loadSecrets() {
    api
      .getSkillSecrets()
      .then(setSecretMasked)
      .catch(() => {});
  }

  async function handleSaveSecret(skillName: string, envKey: string) {
    const value = secretInputs[skillName]?.[envKey];
    if (!value) return;
    setSavingSecret(`${skillName}:${envKey}`);
    setSecretSuccess("");
    setSkillsError("");
    try {
      await api.setSkillSecret(skillName, { [envKey]: value });
      setSecretInputs((prev) => ({
        ...prev,
        [skillName]: { ...prev[skillName], [envKey]: "" },
      }));
      loadSkills();
      loadSecrets();
      setSecretSuccess(`${envKey} saved`);
    } catch (e) {
      setSkillsError(
        e instanceof api.ApiError ? e.message : "Failed to save secret",
      );
    } finally {
      setSavingSecret(null);
    }
  }

  async function handleClearSecret(skillName: string, envKey: string) {
    setSavingSecret(`${skillName}:${envKey}`);
    setSecretSuccess("");
    setSkillsError("");
    try {
      await api.setSkillSecret(skillName, { [envKey]: null as unknown as string });
      loadSkills();
      loadSecrets();
      setSecretSuccess(`${envKey} cleared`);
    } catch (e) {
      setSkillsError(
        e instanceof api.ApiError ? e.message : "Failed to clear secret",
      );
    } finally {
      setSavingSecret(null);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError("");
    setSuccess("");

    const update: UpdateKeysInput = {};
    let hasChanges = false;

    for (const { key } of KEY_LABELS) {
      const value = inputs[key];
      if (value) {
        update[key] = value;
        hasChanges = true;
      }
    }

    if (!hasChanges) {
      setError("No changes to save");
      setSaving(false);
      return;
    }

    try {
      const result = await api.updateKeys(update);
      setMaskedKeys(result);
      setInputs((prev) => Object.fromEntries(Object.keys(prev).map((k) => [k, ""])));
      setSuccess("Keys updated successfully");
    } catch (e) {
      setError(
        e instanceof api.ApiError ? e.message : "Failed to update keys",
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleClear(key: keyof MaskedKeys) {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const result = await api.updateKeys({ [key]: null });
      setMaskedKeys(result);
      setSuccess(`${key} key cleared`);
    } catch (e) {
      setError(
        e instanceof api.ApiError ? e.message : "Failed to clear key",
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Settings</h1>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {success && <p className="text-sm text-green-600">{success}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">API Keys</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {KEY_LABELS.map(({ key, label }) => (
            <div key={key} className="flex items-center gap-3">
              <div
                className={`h-2 w-2 shrink-0 rounded-full ${maskedKeys[key] ? "bg-green-500" : "bg-muted-foreground/30"}`}
              />
              <Label htmlFor={key} className="w-28 shrink-0 text-sm">
                {label}
              </Label>
              <Input
                id={key}
                type="password"
                autoComplete="new-password"
                className="h-8 text-sm"
                value={inputs[key]}
                onChange={(e) =>
                  setInputs((prev) => ({ ...prev, [key]: e.target.value }))
                }
                placeholder={maskedKeys[key] ?? "Not set"}
              />
              {maskedKeys[key] && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => handleClear(key)}
                  disabled={saving}
                >
                  Clear
                </Button>
              )}
            </div>
          ))}

          <div className="pt-2">
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Skills</CardTitle>
        </CardHeader>
        <CardContent>
          {secretSuccess && (
            <p className="text-sm text-green-600 mb-3">{secretSuccess}</p>
          )}
          {skillsError && (
            <p className="text-sm text-destructive mb-3">{skillsError}</p>
          )}
          {skillsLoading ? (
            <p className="text-sm text-muted-foreground">Loading skills...</p>
          ) : skills.length === 0 ? (
            <p className="text-sm text-muted-foreground">No skills found.</p>
          ) : (
            <div className="space-y-2">
              {skills.map((skill) => (
                <div
                  key={skill.name}
                  className="flex items-start justify-between gap-3 rounded-lg bg-muted/50 px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {(skill.emoji || skill.source === "installed") && (
                        <span className="text-base">{skill.emoji ?? "📦"}</span>
                      )}
                      <span className="font-medium text-sm">{skill.name.replace(/^custom\//, "")}</span>
                      <Badge
                        variant="outline"
                        className={
                          skill.source === "bundled"
                            ? "text-xs"
                            : "text-xs bg-primary/10 text-primary border-primary/20"
                        }
                      >
                        {skill.source}
                      </Badge>
                      {!skill.available && (
                        <Badge
                          variant="outline"
                          className="text-xs text-muted-foreground"
                        >
                          unavailable
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                      {skill.description}
                    </p>
                    {skill.requiresEnv && skill.requiresEnv.length > 0 && (
                      <div className="mt-2 space-y-1.5">
                        {skill.requiresEnv.map((envKey) => {
                          const configured = skill.envConfigured?.[envKey] ?? false;
                          const masked = secretMasked[skill.name]?.[envKey];
                          const inputValue = secretInputs[skill.name]?.[envKey] ?? "";
                          const isSaving = savingSecret === `${skill.name}:${envKey}`;
                          return (
                            <div key={envKey} className="flex items-center gap-2">
                              <div
                                className={`h-2 w-2 shrink-0 rounded-full ${configured ? "bg-green-500" : "bg-muted-foreground/30"}`}
                              />
                              <Label className="w-40 shrink-0 text-xs font-mono">
                                {envKey}
                              </Label>
                              <Input
                                type="password"
                                autoComplete="new-password"
                                className="h-7 text-xs"
                                value={inputValue}
                                onChange={(e) =>
                                  setSecretInputs((prev) => ({
                                    ...prev,
                                    [skill.name]: {
                                      ...prev[skill.name],
                                      [envKey]: e.target.value,
                                    },
                                  }))
                                }
                                placeholder={masked ?? "Not set"}
                              />
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="shrink-0 h-7 text-xs"
                                onClick={() => handleSaveSecret(skill.name, envKey)}
                                disabled={isSaving || !inputValue}
                              >
                                {isSaving ? "..." : "Save"}
                              </Button>
                              {configured && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="shrink-0 h-7 text-xs text-muted-foreground hover:text-destructive"
                                  onClick={() => handleClearSecret(skill.name, envKey)}
                                  disabled={isSaving}
                                >
                                  Clear
                                </Button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  {skill.source === "installed" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => handleDeleteSkill(skill.name)}
                      disabled={deletingSkill === skill.name}
                    >
                      {deletingSkill === skill.name ? "Deleting..." : "Delete"}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
