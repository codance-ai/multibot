import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { Layout } from "@/components/layout";
import { BotListPage } from "@/pages/bot-list";
import { BotFormPage } from "@/pages/bot-form";
import { GroupListPage } from "@/pages/group-list";
import { GroupFormPage } from "@/pages/group-form";
import { SettingsPage } from "@/pages/settings";
import { LogsPage } from "@/pages/logs";
import { LoginPage } from "@/pages/login";
import { checkAuth } from "@/lib/api";
import "./index.css";

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <BotListPage /> },
      { path: "bots/new", element: <BotFormPage /> },
      { path: "bots/:botId", element: <BotFormPage /> },
      { path: "groups", element: <GroupListPage /> },
      { path: "groups/new", element: <GroupFormPage /> },
      { path: "groups/:groupId", element: <GroupFormPage /> },
      { path: "logs", element: <LogsPage /> },
      { path: "settings", element: <SettingsPage /> },
    ],
  },
]);

function App() {
  const [state, setState] = useState<"loading" | "login" | "dashboard" | "error">(
    "loading",
  );

  const verify = () => {
    setState("loading");
    checkAuth()
      .then((ok) => setState(ok ? "dashboard" : "login"))
      .catch(() => setState("error"));
  };

  useEffect(verify, []);

  if (state === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-muted border-t-primary" />
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4 text-center">
          <p className="text-muted-foreground">Could not verify your session</p>
          <button
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
            onClick={verify}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (state === "login") {
    return <LoginPage onSuccess={() => setState("dashboard")} />;
  }

  return <RouterProvider router={router} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
