import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface McpServer {
  url: string;
  headers: Record<string, string>;
}

interface McpServerEditorProps {
  servers: Record<string, McpServer>;
  onChange: (servers: Record<string, McpServer>) => void;
}

export function McpServerEditor({ servers, onChange }: McpServerEditorProps) {
  const entries = Object.entries(servers);

  function addServer() {
    const name = `server-${entries.length + 1}`;
    onChange({ ...servers, [name]: { url: "", headers: {} } });
  }

  function removeServer(name: string) {
    const next = { ...servers };
    delete next[name];
    onChange(next);
  }

  function updateName(oldName: string, newName: string) {
    if (newName === oldName || !newName.trim()) return;
    const next: Record<string, McpServer> = {};
    for (const [k, v] of Object.entries(servers)) {
      next[k === oldName ? newName.trim() : k] = v;
    }
    onChange(next);
  }

  function updateUrl(name: string, url: string) {
    onChange({ ...servers, [name]: { ...servers[name], url } });
  }

  function updateHeaders(name: string, raw: string) {
    try {
      const headers = JSON.parse(raw);
      if (typeof headers === "object" && headers !== null) {
        onChange({ ...servers, [name]: { ...servers[name], headers } });
      }
    } catch {
      // ignore invalid JSON while typing
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">MCP Servers</CardTitle>
        <Button type="button" size="sm" variant="outline" onClick={addServer}>
          Add Server
        </Button>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No MCP servers configured.</p>
        ) : (
          <div className="space-y-4">
            {entries.map(([name, server]) => (
              <div key={name} className="space-y-2 rounded-md border p-3">
                <div className="flex items-center justify-between">
                  <Label>Name</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeServer(name)}
                  >
                    Remove
                  </Button>
                </div>
                <Input
                  defaultValue={name}
                  onBlur={(e) => updateName(name, e.target.value)}
                />
                <Label>URL</Label>
                <Input
                  value={server.url}
                  onChange={(e) => updateUrl(name, e.target.value)}
                  placeholder="https://mcp-server.example.com/sse"
                />
                <Label>Headers (JSON)</Label>
                <Input
                  defaultValue={JSON.stringify(server.headers)}
                  onBlur={(e) => updateHeaders(name, e.target.value)}
                  placeholder='{"Authorization": "Bearer ..."}'
                />
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
