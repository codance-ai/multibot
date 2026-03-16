import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
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
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/confirm-dialog";
import * as api from "@/lib/api";
import type { BotConfig } from "@/lib/types";

const CHANNELS = [
  { value: "telegram", label: "Telegram" },
  { value: "discord", label: "Discord" },
  { value: "slack", label: "Slack" },
];

export function BotListPage() {
  const navigate = useNavigate();
  const [bots, setBots] = useState<BotConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<BotConfig | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [bindTarget, setBindTarget] = useState<BotConfig | null>(null);
  const [channelName, setChannelName] = useState("");
  const [channelToken, setChannelToken] = useState("");
  const [binding, setBinding] = useState(false);
  const [bindError, setBindError] = useState("");

  async function loadBots() {
    setLoading(true);
    setError("");
    try {
      setBots(await api.listBots());
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : "Failed to load bots");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadBots();
  }, []);

  function openBindDialog(bot: BotConfig) {
    setBindTarget(bot);
    setChannelName("");
    setChannelToken("");
    setBindError("");
  }

  async function handleBind() {
    if (!bindTarget || !channelName.trim() || !channelToken.trim()) return;
    setBinding(true);
    setBindError("");
    try {
      await api.bindChannel(bindTarget.botId, channelName.trim(), channelToken.trim());
      setBindTarget(null);
      await loadBots();
    } catch (e) {
      setBindError(e instanceof api.ApiError ? e.message : "Failed to bind channel");
    } finally {
      setBinding(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteBot(deleteTarget.botId);
      setDeleteTarget(null);
      await loadBots();
    } catch (e) {
      setError(
        e instanceof api.ApiError ? e.message : "Failed to delete bot",
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Bots</h1>
        <Button onClick={() => navigate("/bots/new")}>Create Bot</Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : bots.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-md border border-dashed py-12">
          <p className="mb-4 text-sm text-muted-foreground">
            No bots yet. Create one to get started.
          </p>
          <Button onClick={() => navigate("/bots/new")}>Create Bot</Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {bots.map((bot) => (
            <Card key={bot.botId}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center text-base">
                  <span className="truncate">{bot.name}</span>
                  {bot.botType === "admin" && (
                    <Badge className="ml-2 shrink-0 bg-amber-100 text-amber-800 hover:bg-amber-100">
                      Admin
                    </Badge>
                  )}
                </CardTitle>
                <p className="text-sm text-muted-foreground">
                  {bot.provider} / <span className="font-mono">{bot.model}</span>
                </p>
              </CardHeader>
              <CardContent className="pb-2">
                <div className="flex flex-wrap gap-1">
                  {Object.keys(bot.channels).map((ch) => (
                    <Badge key={ch} variant="secondary">
                      {ch}
                    </Badge>
                  ))}
                  {Object.keys(bot.channels).length === 0 && (
                    <span className="text-xs text-muted-foreground">No channels</span>
                  )}
                </div>
              </CardContent>
              <CardFooter className="gap-2">
                <Button variant="ghost" size="sm" asChild>
                  <Link to={`/bots/${bot.botId}`}>Edit</Link>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openBindDialog(bot)}
                >
                  Bind
                </Button>
                {bot.botType !== "admin" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDeleteTarget(bot)}
                  >
                    Delete
                  </Button>
                )}
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!bindTarget} onOpenChange={(open) => !open && setBindTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Bind Channel — {bindTarget?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {bindError && (
              <p className="text-sm text-destructive">{bindError}</p>
            )}
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
              <Label htmlFor="bind-token">Token</Label>
              <Input
                id="bind-token"
                placeholder="Channel token"
                value={channelToken}
                onChange={(e) => setChannelToken(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBindTarget(null)}>
              Cancel
            </Button>
            <Button onClick={handleBind} disabled={binding}>
              {binding ? "Binding..." : "Bind"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete Bot"
        description={`Are you sure you want to delete "${deleteTarget?.name}"? This will unbind all channels and cannot be undone.`}
        onConfirm={handleDelete}
        loading={deleting}
      />
    </div>
  );
}
