import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { writeProgress, startHeartbeat } from "../section-worker";

const TMP = "/tmp/assembly-test-liveness-" + Date.now();

describe("heartbeat liveness annotations", () => {
  beforeEach(() => {
    mkdirSync(resolve(TMP, "queues"), { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("live child has child_live:true and low silent_s", async () => {
    // Keep ref fresh by updating it every 20ms to simulate an active child process
    const ref = { ms: Date.now() };
    const keepAlive = setInterval(() => { ref.ms = Date.now(); }, 20);
    const stop = startHeartbeat(TMP, "test-station", "wp-001.json", Date.now(), ref, { interval_ms: 100 });

    await new Promise(r => setTimeout(r, 250));
    clearInterval(keepAlive);
    stop();

    const logPath = resolve(TMP, "queues", "activity.jsonl");
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.event).toBe("station_heartbeat");
    expect(entry.child_live).toBe(true);
    expect(entry.silent_s).toBeLessThanOrEqual(2);
    expect(entry.last_activity_ts).toBeDefined();
  });

  it("silent child has child_live:false and climbing silent_s", async () => {
    const ref = { ms: Date.now() - 60000 }; // 1 minute ago
    const stop = startHeartbeat(TMP, "test-station", "wp-002.json", Date.now(), ref, { interval_ms: 100 });

    await new Promise(r => setTimeout(r, 250));
    stop();

    const logPath = resolve(TMP, "queues", "activity.jsonl");
    const lines = readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.child_live).toBe(false);
    expect(entry.silent_s).toBeGreaterThanOrEqual(59);
  });

  it("emit_when_silent:false suppresses entries during silence", async () => {
    const ref = { ms: Date.now() - 120000 }; // 2 minutes ago
    const stop = startHeartbeat(TMP, "test-station", "wp-003.json", Date.now(), ref, {
      interval_ms: 100,
      emit_when_silent: false,
    });

    await new Promise(r => setTimeout(r, 350));
    stop();

    const logPath = resolve(TMP, "queues", "activity.jsonl");
    if (existsSync(logPath)) {
      const content = readFileSync(logPath, "utf-8").trim();
      // Should be empty — all heartbeats suppressed because child is silent
      expect(content).toBe("");
    }
    // If file doesn't exist at all, that's also correct (no writes happened)
  });

  it("emit_when_silent:true (default) emits during silence", async () => {
    const ref = { ms: Date.now() - 120000 }; // 2 minutes ago
    const stop = startHeartbeat(TMP, "test-station", "wp-004.json", Date.now(), ref, {
      interval_ms: 100,
      emit_when_silent: true,
    });

    await new Promise(r => setTimeout(r, 250));
    stop();

    const logPath = resolve(TMP, "queues", "activity.jsonl");
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.child_live).toBe(false);
  });

  it("custom interval_ms changes child_live threshold", async () => {
    // With interval_ms=50ms and activity 200ms ago, child should be "not live"
    const ref = { ms: Date.now() - 200 };
    const stop = startHeartbeat(TMP, "test-station", "wp-005.json", Date.now(), ref, {
      interval_ms: 50,
    });

    await new Promise(r => setTimeout(r, 150));
    stop();

    const logPath = resolve(TMP, "queues", "activity.jsonl");
    const lines = readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const entry = JSON.parse(lines[0]);
    // 200ms > 50ms interval, so child is not live
    expect(entry.child_live).toBe(false);
  });
});

describe("writeProgress updates lastActivityRef", () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("updates lastActivityRef.ms to current time", () => {
    const progressPath = resolve(TMP, "test.progress.jsonl");
    const ref = { ms: Date.now() - 60000 };
    const before = Date.now();
    writeProgress(progressPath, Date.now(), ref, "llm", "running", "test");
    expect(ref.ms).toBeGreaterThanOrEqual(before);
  });
});
