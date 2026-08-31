import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/web/**/*.test.ts"],
    // jsdom 环境按需通过 @vitest-environment docblock 启用
    environmentMatchGlobs: [
      ["src/web/render/*.test.ts", "jsdom"],
    ],
  },
});
