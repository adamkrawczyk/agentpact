import { describe, expect, it } from "vitest";
import { fileURLToPath } from "url";

// We can't import `sql` directly without connecting, so test the config by reading the source.
// Instead, we'll verify the module exports the correct config by importing and checking.

describe("db.ts pool config", () => {
  it("pool max connections is 10", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db.ts"),
      "utf-8",
    );
    // Verify max: 10 in the postgres config
    expect(source).toMatch(/max:\s*10\b/);
    // Verify no max: 20 or higher
    expect(source).not.toMatch(/max:\s*(2[0-9]|[3-9]\d|\d{3,})\b/);
  });
});
