import { useEffect, useState } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { Bot, Users, Settings, LogOut, ScrollText, Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import * as api from "@/lib/api";

const NAV_ITEMS = [
  { to: "/", label: "Bots", icon: Bot },
  { to: "/groups", label: "Groups", icon: Users },
  { to: "/logs", label: "Logs", icon: ScrollText },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function Layout() {
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Close sidebar on route change (mobile)
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  // Close sidebar on Escape key
  useEffect(() => {
    if (!sidebarOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSidebarOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [sidebarOpen]);

  function isActive(to: string) {
    if (to === "/") {
      return location.pathname === "/" || location.pathname.startsWith("/bots");
    }
    if (to === "/groups") {
      return location.pathname.startsWith("/groups");
    }
    return location.pathname.startsWith(to);
  }

  return (
    <div className="flex min-h-screen bg-background">
      {/* Mobile top bar */}
      <div className="fixed inset-x-0 top-0 z-30 flex h-14 items-center border-b bg-background px-4 md:hidden">
        <Button
          variant="ghost"
          size="icon"
          className="mr-2"
          aria-label={sidebarOpen ? "Close menu" : "Open menu"}
          aria-expanded={sidebarOpen}
          aria-controls="sidebar-nav"
          onClick={() => setSidebarOpen(!sidebarOpen)}
        >
          {sidebarOpen ? (
            <X className="h-5 w-5" />
          ) : (
            <Menu className="h-5 w-5" />
          )}
        </Button>
        <Link to="/" className="text-lg font-semibold">
          Multibot
        </Link>
      </div>

      {/* Backdrop overlay (mobile only) */}
      {sidebarOpen && (
        <div
          role="presentation"
          aria-hidden="true"
          className="fixed inset-0 z-[35] bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        id="sidebar-nav"
        className={cn(
          "fixed left-0 top-14 bottom-0 z-40 flex w-56 flex-col border-r bg-muted/40 transition-transform duration-200",
          "md:top-0 md:bottom-0 md:translate-x-0 md:z-30",
          sidebarOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="hidden h-14 items-center border-b px-4 md:flex">
          <Link to="/" className="text-lg font-semibold">
            Multibot
          </Link>
        </div>

        <nav className="flex-1 space-y-1 px-2 py-4">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t px-4 py-3">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 text-muted-foreground"
            onClick={() => api.logout()}
          >
            <LogOut className="h-4 w-4" />
            Logout
          </Button>
        </div>
      </aside>

      <main className="ml-0 flex-1 px-4 pt-14 pb-6 md:ml-56 md:px-8 md:pt-6">
        <div className="mx-auto max-w-5xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
