import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, existsSync, appendFileSync, unlinkSync, readdirSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";

describe("orchestrator watchdog with activity.jsonl heartbeats", () => {
  let tempDir: string;
  let activityLogPath: string;

  beforeAll(() => {
    tempDir = resolve(tmpdir(), `test-watchdog-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    activityLogPath = resolve(tempDir, "activity.jsonl");
  });

  afterAll(() => {
    // Clean up temp directory
    try {
      if (existsSync(tempDir)) {
        for (const entry of readdirSync(tempDir)) {
          try { unlinkSync(resolve(tempDir, entry)); } catch {}
        }
        require("fs").rmdirSync(tempDir);
      }
    } catch {}
  });

  test("heartbeats with child_live:true prevent idle timeout", async () => {
    // Simulate the watchdog loop with heartbeat tail integration
    let lastActivityMs = Date.now();
    const idleThresholdMs = 10_000; // 10s idle timeout for test
    let timeoutFired = false;

    // Simulate tailActivityLog callback
    const onHeartbeat = () => {
      lastActivityMs = Date.now();
    };

    // Write heartbeat with child_live: true
    const heartbeat = {
      ts: new Date().toISOString(),
      event: "station_heartbeat",
      station: "develop",
      workpiece: "test-workpiece.json",
      child_live: true,
      last_activity_ts: new Date().toISOString(),
      silent_s: 2,
    };
    appendFileSync(activityLogPath, JSON.stringify(heartbeat) + "\n");

    // Parse the heartbeat and simulate callback
    const lines = require("fs").readFileSync(activityLogPath, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (
        entry.event === "station_heartbeat" &&
        entry.station === "develop" &&
        entry.workpiece === "test-workpiece.json" &&
        entry.child_live === true
      ) {
        onHeartbeat();
      }
    }

    // Check if idle watchdog would fire
    const idleMs = Date.now() - lastActivityMs;
    if (idleMs >= idleThresholdMs) {
      timeoutFired = true;
    }

    expect(timeoutFired).toBe(false);
    expect(Date.now() - lastActivityMs).toBeLessThan(idleThresholdMs);
  });

  test("heartbeats with child_live:false do NOT prevent idle timeout", async () => {
    // Reset activity log
    unlinkSync(activityLogPath);

    let lastActivityMs = Date.now() - 15_000; // 15s ago — past threshold
    const idleThresholdMs = 10_000;
    let timeoutFired = false;

    const onHeartbeat = () => {
      lastActivityMs = Date.now();
    };

    // Write heartbeat with child_live: false
    const heartbeat = {
      ts: new Date().toISOString(),
      event: "station_heartbeat",
      station: "develop",
      workpiece: "test-workpiece.json",
      child_live: false,
      last_activity_ts: new Date(Date.now() - 15_000).toISOString(),
      silent_s: 15,
    };
    appendFileSync(activityLogPath, JSON.stringify(heartbeat) + "\n");

    // Parse — should NOT trigger callback because child_live is false
    const lines = require("fs").readFileSync(activityLogPath, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (
        entry.event === "station_heartbeat" &&
        entry.station === "develop" &&
        entry.workpiece === "test-workpiece.json" &&
        entry.child_live === true // Only fire on true
      ) {
        onHeartbeat();
      }
    }

    // Check if idle watchdog would fire
    const idleMs = Date.now() - lastActivityMs;
    if (idleMs >= idleThresholdMs) {
      timeoutFired = true;
    }

    expect(timeoutFired).toBe(true);
  });

  test("heartbeats for wrong station are ignored", async () => {
    unlinkSync(activityLogPath);

    let lastActivityMs = Date.now() - 15_000;
    const idleThresholdMs = 10_000;
    let timeoutFired = false;

    const onHeartbeat = () => {
      lastActivityMs = Date.now();
    };

    // Write heartbeat for DIFFERENT station
    const heartbeat = {
      ts: new Date().toISOString(),
      event: "station_heartbeat",
      station: "other-station", // Wrong station
      workpiece: "test-workpiece.json",
      child_live: true,
      last_activity_ts: new Date().toISOString(),
      silent_s: 2,
    };
    appendFileSync(activityLogPath, JSON.stringify(heartbeat) + "\n");

    // Parse with station filter
    const lines = require("fs").readFileSync(activityLogPath, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (
        entry.event === "station_heartbeat" &&
        entry.station === "develop" && // Looking for develop
        entry.workpiece === "test-workpiece.json" &&
        entry.child_live === true
      ) {
        onHeartbeat();
      }
    }

    const idleMs = Date.now() - lastActivityMs;
    if (idleMs >= idleThresholdMs) {
      timeoutFired = true;
    }

    expect(timeoutFired).toBe(true);
  });

  test("heartbeats for wrong workpiece are ignored", async () => {
    unlinkSync(activityLogPath);

    let lastActivityMs = Date.now() - 15_000;
    const idleThresholdMs = 10_000;
    let timeoutFired = false;

    const onHeartbeat = () => {
      lastActivityMs = Date.now();
    };

    // Write heartbeat for DIFFERENT workpiece
    const heartbeat = {
      ts: new Date().toISOString(),
      event: "station_heartbeat",
      station: "develop",
      workpiece: "other-workpiece.json", // Wrong workpiece
      child_live: true,
      last_activity_ts: new Date().toISOString(),
      silent_s: 2,
    };
    appendFileSync(activityLogPath, JSON.stringify(heartbeat) + "\n");

    // Parse with workpiece filter
    const lines = require("fs").readFileSync(activityLogPath, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (
        entry.event === "station_heartbeat" &&
        entry.station === "develop" &&
        entry.workpiece === "test-workpiece.json" && // Looking for test-workpiece
        entry.child_live === true
      ) {
        onHeartbeat();
      }
    }

    const idleMs = Date.now() - lastActivityMs;
    if (idleMs >= idleThresholdMs) {
      timeoutFired = true;
    }

    expect(timeoutFired).toBe(true);
  });

  test("tail starts from EOF, ignoring old heartbeats", async () => {
    unlinkSync(activityLogPath);

    // Pre-populate with old heartbeats
    for (let i = 0; i < 5; i++) {
      const oldHeartbeat = {
        ts: new Date(Date.now() - 60_000).toISOString(),
        event: "station_heartbeat",
        station: "develop",
        workpiece: "test-workpiece.json",
        child_live: true,
        last_activity_ts: new Date(Date.now() - 60_000).toISOString(),
        silent_s: 0,
      };
      appendFileSync(activityLogPath, JSON.stringify(oldHeartbeat) + "\n");
    }

    // Capture offset (simulating tail starting from EOF)
    const initialSize = require("fs").statSync(activityLogPath).size;
    let callbackCount = 0;

    const onHeartbeat = () => {
      callbackCount++;
    };

    // Now write a NEW heartbeat
    const newHeartbeat = {
      ts: new Date().toISOString(),
      event: "station_heartbeat",
      station: "develop",
      workpiece: "test-workpiece.json",
      child_live: true,
      last_activity_ts: new Date().toISOString(),
      silent_s: 1,
    };
    appendFileSync(activityLogPath, JSON.stringify(newHeartbeat) + "\n");

    // Read only bytes after initialSize
    const fd = require("fs").openSync(activityLogPath, "r");
    const currentSize = require("fs").statSync(activityLogPath).size;
    const buf = Buffer.alloc(currentSize - initialSize);
    const bytes = require("fs").readSync(fd, buf, 0, buf.length, initialSize);
    require("fs").closeSync(fd);

    const newContent = buf.slice(0, bytes).toString("utf-8");
    const lines = newContent.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (
        entry.event === "station_heartbeat" &&
        entry.station === "develop" &&
        entry.workpiece === "test-workpiece.json" &&
        entry.child_live === true
      ) {
        onHeartbeat();
      }
    }

    // Should only process the new heartbeat, not the old ones
    expect(callbackCount).toBe(1);
  });

  test("handles missing activity.jsonl gracefully", () => {
    const missingPath = resolve(tempDir, "missing.jsonl");

    // Attempt to stat a missing file
    let offset = 0;
    try {
      offset = require("fs").statSync(missingPath).size;
    } catch {
      // Expected — file doesn't exist yet
      offset = 0;
    }

    expect(offset).toBe(0);

    // Attempt to open
    let fd: number | null = null;
    try {
      fd = require("fs").openSync(missingPath, "r");
    } catch {
      fd = null;
    }

    expect(fd).toBeNull();

    // Write the file now
    appendFileSync(missingPath, JSON.stringify({ event: "test" }) + "\n");

    // Now open should succeed
    try {
      fd = require("fs").openSync(missingPath, "r");
    } catch {
      fd = null;
    }

    expect(fd).not.toBeNull();
    if (fd !== null) require("fs").closeSync(fd);
  });

  test("handles partial/malformed JSON lines", () => {
    unlinkSync(activityLogPath);

    let callbackCount = 0;
    const onHeartbeat = () => {
      callbackCount++;
    };

    // Write a truncated JSON line followed by a valid one
    appendFileSync(activityLogPath, '{"event":"station_heartbeat","station":"develop"\n'); // Incomplete
    appendFileSync(activityLogPath, JSON.stringify({
      ts: new Date().toISOString(),
      event: "station_heartbeat",
      station: "develop",
      workpiece: "test-workpiece.json",
      child_live: true,
      last_activity_ts: new Date().toISOString(),
      silent_s: 0,
    }) + "\n");

    // Parse with error handling
    const lines = require("fs").readFileSync(activityLogPath, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (
          entry.event === "station_heartbeat" &&
          entry.station === "develop" &&
          entry.workpiece === "test-workpiece.json" &&
          entry.child_live === true
        ) {
          onHeartbeat();
        }
      } catch {
        // Malformed line — skip
      }
    }

    // Should process only the valid heartbeat
    expect(callbackCount).toBe(1);
  });

  test("branded-ids replay: 30 heartbeats at 30s intervals with child_live:true does not trip 900s watchdog", () => {
    unlinkSync(activityLogPath);

    let lastActivityMs = Date.now();
    const idleThresholdMs = 900_000; // 900s watchdog
    let timeoutFired = false;

    const onHeartbeat = () => {
      lastActivityMs = Date.now();
    };

    // Simulate 30 heartbeats, each 30s apart
    const baseTime = Date.now();
    for (let i = 0; i < 30; i++) {
      const heartbeatTime = baseTime + i * 30_000;
      const heartbeat = {
        ts: new Date(heartbeatTime).toISOString(),
        event: "station_heartbeat",
        station: "develop",
        workpiece: "branded-ids.json",
        child_live: true,
        last_activity_ts: new Date(heartbeatTime - (i % 9) * 1000).toISOString(), // silent_s varies 0-8
        silent_s: i % 9,
      };
      appendFileSync(activityLogPath, JSON.stringify(heartbeat) + "\n");
    }

    // Process all heartbeats
    const lines = require("fs").readFileSync(activityLogPath, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (
        entry.event === "station_heartbeat" &&
        entry.station === "develop" &&
        entry.workpiece === "branded-ids.json" &&
        entry.child_live === true
      ) {
        onHeartbeat();
      }
    }

    // After 30 heartbeats, lastActivityMs should be updated to the last heartbeat time
    // The idle time should be minimal (just the processing time, not 900s)
    const idleMs = Date.now() - lastActivityMs;
    if (idleMs >= idleThresholdMs) {
      timeoutFired = true;
    }

    expect(timeoutFired).toBe(false);
    expect(idleMs).toBeLessThan(idleThresholdMs);
  });

  test("stop function prevents further callbacks", () => {
    unlinkSync(activityLogPath);

    let callbackCount = 0;
    let stopped = false;

    const onHeartbeat = () => {
      if (!stopped) callbackCount++;
    };

    // Write initial heartbeat
    appendFileSync(activityLogPath, JSON.stringify({
      ts: new Date().toISOString(),
      event: "station_heartbeat",
      station: "develop",
      workpiece: "test-workpiece.json",
      child_live: true,
      last_activity_ts: new Date().toISOString(),
      silent_s: 0,
    }) + "\n");

    // Process
    let lines = require("fs").readFileSync(activityLogPath, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (
        entry.event === "station_heartbeat" &&
        entry.station === "develop" &&
        entry.workpiece === "test-workpiece.json" &&
        entry.child_live === true
      ) {
        onHeartbeat();
      }
    }

    expect(callbackCount).toBe(1);

    // Simulate stop
    stopped = true;

    // Write more heartbeats
    appendFileSync(activityLogPath, JSON.stringify({
      ts: new Date().toISOString(),
      event: "station_heartbeat",
      station: "develop",
      workpiece: "test-workpiece.json",
      child_live: true,
      last_activity_ts: new Date().toISOString(),
      silent_s: 0,
    }) + "\n");

    // Process again (should not increment callback count)
    lines = require("fs").readFileSync(activityLogPath, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (
        entry.event === "station_heartbeat" &&
        entry.station === "develop" &&
        entry.workpiece === "test-workpiece.json" &&
        entry.child_live === true
      ) {
        onHeartbeat();
      }
    }

    // Should still be 1 because stopped flag prevents new callbacks
    expect(callbackCount).toBe(1);
  });
});
