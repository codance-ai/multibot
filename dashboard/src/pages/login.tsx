import { useState } from "react";
import { Bot, LogIn, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function LoginPage({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError((body as { error?: string }).error ?? "Login failed");
        return;
      }

      onSuccess();
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-background via-background to-muted px-4">
      <div className="flex w-full max-w-sm flex-col items-center gap-8">
        {/* Logo & branding */}
        <div className="flex flex-col items-center gap-3">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg">
            <Bot className="h-8 w-8" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight">Multibot</h1>
          <p className="text-center text-sm text-muted-foreground">
            Multi-bot platform for building and managing AI assistants
          </p>
        </div>

        {/* Sign in card */}
        <form
          onSubmit={handleSubmit}
          className="flex w-full flex-col gap-4 rounded-xl border bg-card p-6 shadow-sm"
        >
          <Input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
          <Button className="w-full gap-2" size="lg" disabled={loading || !password}>
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <LogIn className="h-4 w-4" />
            )}
            Sign in
          </Button>
        </form>

        <p className="text-xs text-muted-foreground">
          Powered by Cloudflare Workers
        </p>
      </div>
    </div>
  );
}
