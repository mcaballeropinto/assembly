import { test, expect, describe, beforeAll, afterAll } from "bun:test";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

import { readFileSync } from "fs";
import { resolve } from "path";

function loadHarness() {
  const src = readFileSync(resolve(import.meta.dir, "..", "global-dashboard.ts"), "utf-8");
  const after = src.indexOf("${DASHBOARD_CLIENT_JS}");
  const openTag = src.indexOf("<script>", after);
  const bodyStart = src.indexOf(">", openTag) + 1;
  const bodyEnd = src.indexOf("</script>", bodyStart);
  let body = src.slice(bodyStart, bodyEnd);

  const iifeStart = body.indexOf("// Initial load — restore view from URL");
  if (iifeStart > 0) body = body.slice(0, iifeStart);
  body = body.replace(/\\\\/g, "\\");

  (globalThis as any).AssemblyDashboard = {
    buildOverviewDom: () => document.createElement("div"),
    buildDetailDom: () => document.createElement("div"),
    applyMorph: () => true,
    __resetHashes: () => {},
    renderHistoryInner: () => "",
  };
  (globalThis as any).morphdom = (a: any) => a;
  (globalThis as any).fetch = (..._args: any[]) =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({}) });

  return new Function(
    body +
      "\nreturn { " +
      "renderKanbanStationGroup: renderKanbanStationGroup " +
      "};"
  )();
}

let harness: {
  renderKanbanStationGroup: (
    stationName: string,
    lanes: any[],
    freshness: any,
    stationStatuses: any,
    stationMeta: any
  ) => string;
};

beforeAll(() => {
  harness = loadHarness();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe("station description tooltip renderer", () => {
  test("renders accessible description trigger without attaching it to the status dot", () => {
    const html = harness.renderKanbanStationGroup(
      "station-a",
      [{ key: "station-a:inbox", title: "Inbox", count: 0, cards: [] }],
      null,
      { "station-a": { state: "ready", label: "Station ready", icon: "✓" } },
      { "station-a": { description: "Builds the first artifact.", timeout: 123 } }
    );
    document.body.innerHTML = html;

    const trigger = document.querySelector(".station-desc-trigger") as HTMLElement;
    const tooltipId = trigger.getAttribute("aria-describedby");
    const tooltip = document.getElementById(tooltipId!);
    const statusDot = document.querySelector(".station-status-dot") as HTMLElement;

    expect(trigger.getAttribute("tabindex")).toBe("0");
    expect(tooltipId).toBe("station-desc-station-a");
    expect(tooltip?.getAttribute("role")).toBe("tooltip");
    expect(tooltip?.textContent).toContain("Builds the first artifact.");
    expect(tooltip?.textContent).toContain("Timeout: 123s");
    expect(statusDot.getAttribute("tabindex")).toBe("0");
    expect(statusDot.getAttribute("title")).toBe("Station ready");
    expect(statusDot.hasAttribute("aria-describedby")).toBe(false);
  });

  test("does not render an empty tooltip for stations without descriptions", () => {
    const html = harness.renderKanbanStationGroup(
      "station-b",
      [{ key: "station-b:inbox", title: "Inbox", count: 0, cards: [] }],
      null,
      {},
      {}
    );
    document.body.innerHTML = html;

    expect(document.querySelector(".station-desc-trigger")).toBeNull();
    expect(document.querySelector(".station-desc-tooltip")).toBeNull();
    expect(document.querySelector(".station-name")?.hasAttribute("tabindex")).toBe(false);
  });

  test("uses trigger-based selectors so status-dot hover does not open the description", () => {
    const src = readFileSync(resolve(import.meta.dir, "..", "global-dashboard.ts"), "utf-8");

    expect(src).toContain(".station-desc-trigger:hover ~ .station-desc-tooltip");
    expect(src).toContain(".station-desc-trigger:focus ~ .station-desc-tooltip");
    expect(src).not.toContain(".kanban-station-header:hover .station-desc-tooltip");
    expect(src).not.toContain(".kanban-station-header:focus-within .station-desc-tooltip");
  });

  test("renders muted station status dot with keyboard-accessible tooltip text", () => {
    const label = "Muted · not in active sequence · 1 item";
    const html = harness.renderKanbanStationGroup(
      "old-station",
      [{ key: "old-station:processing", title: "processing", count: 1, cards: [] }],
      null,
      { "old-station": { state: "muted", label, icon: "◯", itemCount: 1 } },
      {}
    );
    document.body.innerHTML = html;

    const statusDot = document.querySelector(".station-status-dot") as HTMLElement;
    expect(statusDot.classList.contains("status-muted")).toBe(true);
    expect(statusDot.textContent).toBe("◯");
    expect(statusDot.getAttribute("role")).toBe("img");
    expect(statusDot.getAttribute("tabindex")).toBe("0");
    expect(statusDot.getAttribute("title")).toBe(label);
    expect(statusDot.getAttribute("aria-label")).toBe(label);
  });
});
