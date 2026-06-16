import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  fetchJson,
  fetchWorkpiece,
  isApiError,
} from "../../lib/api";

const root = resolve(import.meta.dir, "../../../..");
const drawerSource = () =>
  readFileSync(
    resolve(root, "web/src/components/drawer/workpiece-drawer.tsx"),
    "utf-8"
  );
const routerSource = () =>
  readFileSync(resolve(root, "web/src/router.tsx"), "utf-8");
const appSource = () => readFileSync(resolve(root, "web/src/app.tsx"), "utf-8");

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("workpiece drawer API helpers", () => {
  test("fetchWorkpiece encodes line and file path segments", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Response.json({
        id: "wp_1",
        line: "assembly dev",
        task: "Sample",
        input: {},
        stations: {},
      });
    }) as typeof fetch;

    const response = await fetchWorkpiece("assembly dev", "sample one.json");

    expect(calls).toEqual([
      "/api/workpiece/assembly%20dev/sample%20one.json",
    ]);
    expect(isApiError(response)).toBe(false);
  });

  test("fetchJson throws parsed backend error messages", async () => {
    globalThis.fetch = (async () =>
      Response.json({ error: "Workpiece not found" }, { status: 404 })) as typeof fetch;

    await expect(fetchJson("/api/workpiece/a/missing.json")).rejects.toThrow(
      "Workpiece not found"
    );
  });

  test("isApiError detects endpoint error envelopes", () => {
    expect(isApiError({ error: "Nope" })).toBe(true);
    expect(
      isApiError({
        id: "wp_1",
        line: "assembly-dev",
        task: "Task",
        input: {},
        stations: {},
      })
    ).toBe(false);
  });
});

describe("workpiece drawer shell contract", () => {
  test("uses right-side shadcn Sheet sizing and tabs", () => {
    const source = drawerSource();

    expect(source).toContain("<Sheet");
    expect(source).toContain('side="right"');
    expect(source).toContain("w-[640px]");
    expect(source).toContain("sm:max-w-[640px]");
    expect(source).toContain('value="stations">Stations');
    expect(source).toContain('value="events">Events');
    expect(source).toContain('value="sidecars">Sidecars');
    expect(source).toContain("p-6 pt-4");
  });

  test("open state and close behavior are tied to wp search param", () => {
    const source = drawerSource();

    expect(source).toContain("useSearch({ strict: false })");
    expect(source).toContain("const open = Boolean(fileName && lineName)");
    expect(source).toContain("delete next.wp");
    expect(source).toContain("replace: true");
    expect(source).toContain('queryKey: ["workpiece", lineName, fileName]');
  });

  test("activity count includes bounded-history metadata when available", () => {
    const source = drawerSource();

    expect(source).toContain("_activityMeta?.note");
    expect(source).toContain("events shown");
  });

  test("root route validates drawer search params", () => {
    const source = routerSource();

    expect(source).toContain("export interface DashboardSearch");
    expect(source).toContain("wp?: string");
    expect(source).toContain("wpline?: string");
    expect(source).toContain("line?: string");
    expect(source).toContain("validateSearch");
  });

  test("app mounts drawer and guards missing line context", () => {
    const source = appSource();

    expect(source).toContain("<WorkpieceDrawer lineName={lineName} />");
    expect(source).toContain("search.wpline");
    expect(source).toContain("search.line");
    expect(source).toContain("missing line");
  });
});
