import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "raw-md",
      transform(code, id) {
        if (id.endsWith(".md")) {
          return `export default ${JSON.stringify(code)};`;
        }
      },
    },
    {
      name: "raw-server-js",
      transform(code, id) {
        if (id.endsWith(".server.js")) {
          return `export default ${JSON.stringify(code)};`;
        }
      },
    },
    {
      name: "raw-py",
      transform(code, id) {
        if (id.endsWith(".py")) {
          return `export default ${JSON.stringify(code)};`;
        }
      },
    },
  ],
  test: {
    include: ["src/**/*.test.ts"],
  },
});
