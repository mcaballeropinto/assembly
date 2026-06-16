import { describe, expect, test } from "bun:test";
import { buildWorkerEnv } from "../orchestrator";

describe("buildWorkerEnv", () => {
  test("sets ASSEMBLY_WORKER to the station name", () => {
    const env = buildWorkerEnv("plan", { PATH: "/usr/bin" });
    expect(env.ASSEMBLY_WORKER).toBe("plan");
  });

  test("preserves unrelated parent env values", () => {
    const env = buildWorkerEnv("develop", { PATH: "/bin", HOME: "/tmp/home" });
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/tmp/home");
  });

  test("overrides an existing ASSEMBLY_WORKER marker with the current station", () => {
    const env = buildWorkerEnv("deploy", { ASSEMBLY_WORKER: "plan", PATH: "/bin" });
    expect(env.ASSEMBLY_WORKER).toBe("deploy");
  });
});
