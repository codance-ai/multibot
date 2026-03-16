import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/confirm-dialog";
import * as api from "@/lib/api";
import type { GroupConfig } from "@/lib/types";

export function GroupListPage() {
  const navigate = useNavigate();
  const [groups, setGroups] = useState<GroupConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<GroupConfig | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function loadGroups() {
    setLoading(true);
    setError("");
    try {
      setGroups(await api.listGroups());
    } catch (e) {
      setError(e instanceof api.ApiError ? e.message : "Failed to load groups");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadGroups();
  }, []);

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteGroup(deleteTarget.groupId);
      setDeleteTarget(null);
      await loadGroups();
    } catch (e) {
      setError(
        e instanceof api.ApiError ? e.message : "Failed to delete group",
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Groups</h1>
        <Button onClick={() => navigate("/groups/new")}>Create Group</Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : groups.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-md border border-dashed py-12">
          <p className="mb-4 text-sm text-muted-foreground">
            No groups yet. Create one to enable multi-bot conversations.
          </p>
          <Button onClick={() => navigate("/groups/new")}>Create Group</Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {groups.map((group) => (
            <Card key={group.groupId}>
              <CardHeader className="pb-2">
                <CardTitle className="truncate text-base">{group.name}</CardTitle>
                <p className="text-sm text-muted-foreground">
                  {group.botIds.length} bot{group.botIds.length !== 1 ? "s" : ""}
                </p>
              </CardHeader>
              <CardContent className="pb-2">
                <div className="flex flex-wrap gap-1">
                  {(group.availableChannels ?? []).map((ch) => (
                    <Badge key={ch} variant="secondary">
                      {ch}
                    </Badge>
                  ))}
                  {(!group.availableChannels || group.availableChannels.length === 0) && (
                    <span className="text-xs text-muted-foreground">
                      No channels — bind channels to member bots first
                    </span>
                  )}
                </div>
              </CardContent>
              <CardFooter className="gap-2">
                <Button variant="ghost" size="sm" asChild>
                  <Link to={`/groups/${group.groupId}`}>Edit</Link>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleteTarget(group)}
                >
                  Delete
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete Group"
        description={`Are you sure you want to delete "${deleteTarget?.name}"? This will unbind all channels and cannot be undone.`}
        onConfirm={handleDelete}
        loading={deleting}
      />
    </div>
  );
}
