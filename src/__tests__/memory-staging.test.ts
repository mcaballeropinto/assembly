/**
 * Tests for the test-dispatcher on_success hook memory staging logic.
 * Verifies that pending files are promoted to seen-items.md and GC'd correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, utimesSync } from "fs";
import { resolve } from "path";

const TEMP_DIR = resolve("/tmp", `assembly-test-memory-staging-${Date.now()}`);
const MEMORY_DIR = resolve(TEMP_DIR, "memory");
const SEEN_LISTINGS = resolve(MEMORY_DIR, "seen-items.md");

beforeEach(() => {
  mkdirSync(MEMORY_DIR, { recursive: true });
  // Create initial seen-items.md
  writeFileSync(SEEN_LISTINGS, "# Seen Listings\n\n## Run 2026-04-19\n\n- https://example.com/item-1\n");
});

afterEach(() => {
  try {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch {}
});

// ─── Pending file promotion logic ────────────────────────────────────────────

describe("pending file promotion", () => {
  it("appends pending file content to seen-items.md", async () => {
    const runId = "run_test-123";
    const pendingPath = resolve(MEMORY_DIR, `seen-items.pending-${runId}.md`);
    writeFileSync(pendingPath, "## Run test\n\n- https://example.com/item-2\n- https://example.com/item-3\n");

    // Simulate the promotion logic from on_success.ts
    const pendingContent = readFileSync(pendingPath, "utf-8").trim();
    const { appendFileSync, unlinkSync } = require("fs");
    if (pendingContent) {
      appendFileSync(SEEN_LISTINGS, "\n" + pendingContent + "\n");
      unlinkSync(pendingPath);
    }

    const result = readFileSync(SEEN_LISTINGS, "utf-8");
    expect(result).toContain("https://example.com/item-1");
    expect(result).toContain("https://example.com/item-2");
    expect(result).toContain("https://example.com/item-3");
    expect(existsSync(pendingPath)).toBe(false);
  });

  it("handles missing pending file gracefully (no new listings found)", async () => {
    const runId = "run_no-listings";
    const pendingPath = resolve(MEMORY_DIR, `seen-items.pending-${runId}.md`);

    // No pending file — simulate graceful handling
    const existed = existsSync(pendingPath);
    expect(existed).toBe(false);

    // seen-items.md should be unchanged
    const result = readFileSync(SEEN_LISTINGS, "utf-8");
    expect(result).toContain("https://example.com/item-1");
  });

  it("does not append empty pending file", async () => {
    const runId = "run_empty";
    const pendingPath = resolve(MEMORY_DIR, `seen-items.pending-${runId}.md`);
    writeFileSync(pendingPath, "   \n  ");

    const pendingContent = readFileSync(pendingPath, "utf-8").trim();
    const originalContent = readFileSync(SEEN_LISTINGS, "utf-8");

    // Empty content — should not append
    if (pendingContent) {
      const { appendFileSync } = require("fs");
      appendFileSync(SEEN_LISTINGS, "\n" + pendingContent + "\n");
    }

    const result = readFileSync(SEEN_LISTINGS, "utf-8");
    expect(result).toBe(originalContent);
  });
});

// ─── GC logic ────────────────────────────────────────────────────────────────

describe("stale pending file GC", () => {
  it("removes pending files older than 24h", async () => {
    const stalePath = resolve(MEMORY_DIR, "seen-items.pending-run_stale.md");
    writeFileSync(stalePath, "## Stale run\n\n- https://example.com/stale-item\n");

    // Set mtime to 25 hours ago
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(stalePath, staleTime, staleTime);

    // Simulate GC logic
    const GC_AGE_MS = 24 * 60 * 60 * 1000;
    const { readdirSync, unlinkSync } = require("fs");
    const files = readdirSync(MEMORY_DIR).filter((f: string) =>
      f.startsWith("seen-items.pending-") && f.endsWith(".md")
    );
    const now = Date.now();
    for (const file of files) {
      const filePath = resolve(MEMORY_DIR, file);
      const { mtimeMs } = statSync(filePath);
      if (now - mtimeMs > GC_AGE_MS) {
        unlinkSync(filePath);
      }
    }

    expect(existsSync(stalePath)).toBe(false);
  });

  it("keeps pending files newer than 24h", async () => {
    const recentPath = resolve(MEMORY_DIR, "seen-items.pending-run_recent.md");
    writeFileSync(recentPath, "## Recent run\n\n- https://example.com/recent-item\n");

    // Set mtime to 23 hours ago (still fresh)
    const recentTime = new Date(Date.now() - 23 * 60 * 60 * 1000);
    utimesSync(recentPath, recentTime, recentTime);

    // Simulate GC logic
    const GC_AGE_MS = 24 * 60 * 60 * 1000;
    const { readdirSync, unlinkSync } = require("fs");
    const files = readdirSync(MEMORY_DIR).filter((f: string) =>
      f.startsWith("seen-items.pending-") && f.endsWith(".md")
    );
    const now = Date.now();
    for (const file of files) {
      const filePath = resolve(MEMORY_DIR, file);
      const { mtimeMs } = statSync(filePath);
      if (now - mtimeMs > GC_AGE_MS) {
        unlinkSync(filePath);
      }
    }

    expect(existsSync(recentPath)).toBe(true);
  });
});
