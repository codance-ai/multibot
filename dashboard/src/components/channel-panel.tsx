import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const CHANNELS = [
  { value: "telegram", label: "Telegram" },
  { value: "discord", label: "Discord" },
  { value: "slack", label: "Slack" },
];

interface ChannelPanelProps {
  channels: Record<string, { token: string; webhookUrl?: string }>;
  onBind: (channel: string, token: string, webhookUrl?: string) => Promise<void>;
  onUnbind: (channel: string) => Promise<void>;
}

function maskToken(token: string): string {
  if (token.length <= 8) return "****";
  return token.slice(0, 4) + "****" + token.slice(-4);
}

export function ChannelPanel({ channels, onBind, onUnbind }: ChannelPanelProps) {
  const [bindOpen, setBindOpen] = useState(false);
  const [channelName, setChannelName] = useState("");
  const [token, setToken] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleBind() {
    if (!channelName.trim() || !token.trim()) return;
    setLoading(true);
    setError("");
    try {
      await onBind(
        channelName.trim(),
        token.trim(),
        webhookUrl.trim() || undefined,
      );
      setBindOpen(false);
      setChannelName("");
      setToken("");
      setWebhookUrl("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to bind channel");
    } finally {
      setLoading(false);
    }
  }

  async function handleUnbind(channel: string) {
    setLoading(true);
    try {
      await onUnbind(channel);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to unbind channel");
    } finally {
      setLoading(false);
    }
  }

  const entries = Object.entries(channels);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Channels</CardTitle>
        <Button size="sm" onClick={() => setBindOpen(true)}>
          Bind Channel
        </Button>
      </CardHeader>
      <CardContent>
        {error && (
          <p className="mb-3 text-sm text-destructive">{error}</p>
        )}
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No channels bound.</p>
        ) : (
          <div className="space-y-2">
            {entries.map(([channel, cfg]) => (
              <div
                key={channel}
                className="flex items-center justify-between rounded-md border px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{channel}</Badge>
                  <span className="text-xs text-muted-foreground font-mono">
                    {maskToken(cfg.token)}
                  </span>
                  {cfg.webhookUrl && (
                    <span className="text-xs text-muted-foreground">
                      (webhook)
                    </span>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleUnbind(channel)}
                  disabled={loading}
                >
                  Unbind
                </Button>
              </div>
            ))}
          </div>
        )}

        <Dialog open={bindOpen} onOpenChange={(open) => !open && setBindOpen(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Bind Channel</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Channel</Label>
                <Select value={channelName} onValueChange={setChannelName}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a channel" />
                  </SelectTrigger>
                  <SelectContent>
                    {CHANNELS.map((ch) => (
                      <SelectItem key={ch.value} value={ch.value}>
                        {ch.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="channel-token">Token</Label>
                <Input
                  id="channel-token"
                  placeholder="Channel token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </div>
              {channelName === "discord" && (
                <div className="space-y-2">
                  <Label htmlFor="channel-webhook-url">
                    Webhook URL (optional)
                  </Label>
                  <Input
                    id="channel-webhook-url"
                    placeholder="Discord webhook URL for per-bot identity"
                    value={webhookUrl}
                    onChange={(e) => setWebhookUrl(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Create a webhook in your Discord channel settings to enable
                    per-bot avatars and usernames in group chat.
                  </p>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setBindOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleBind} disabled={loading}>
                {loading ? "Binding..." : "Bind"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
