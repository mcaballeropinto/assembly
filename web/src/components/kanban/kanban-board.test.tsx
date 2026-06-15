import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react-dom/test-utils";
import { createRoot } from "react-dom/client";
import type { KanbanState } from "../../lib/api";
import { KanbanBoard } from "./kanban-board";

try {
  GlobalRegistrator.register();
} catch {
  // Another test file may already have registered happy-dom.
}

function render(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { container, root };
}

const state: KanbanState = {
  line: "demo",
  sequence: ["station-a"],
  lastUpdated: "2026-06-15T12:00:00.000Z",
  stationStatuses: {
    "station-a": { state: "running", label: "Running", icon: "\u25b6", itemCount: 2 },
  },
  columns: [
    { key: "held", title: "Held", count: 0, cards: [] },
    { key: "inbox", title: "Inbox", count: 0, cards: [] },
    {
      key: "station-a:inbox",
      title: "Station inbox",
      station: "station-a",
      lane: "inbox",
      count: 1,
      cards: [
        {
          id: "wp-a",
          fileName: "wp-a.json",
          title: "A card",
          state: "waiting",
          column: "station-a:inbox",
          station: "station-a",
          lane: "inbox",
          enteredColumnAt: null,
        },
      ],
    },
    {
      key: "station-a:processing",
      title: "Processing",
      station: "station-a",
      lane: "processing",
      count: 1,
      cards: [
        {
          id: "wp-b",
          fileName: "wp-b.json",
          title: "B card",
          state: "running",
          column: "station-a:processing",
          station: "station-a",
          lane: "processing",
          enteredColumnAt: null,
        },
      ],
    },
    { key: "station-a:output", title: "Output", station: "station-a", lane: "output", count: 0, cards: [] },
    { key: "done", title: "Done", count: 0, cards: [] },
  ],
};

describe("KanbanBoard", () => {
  test("groups station lanes while preserving card order from props", () => {
    const { container } = render(
      <KanbanBoard
        state={state}
        onOpenCard={() => {}}
        onReleaseAllHeld={() => {}}
      />
    );

    expect(container.textContent).toContain("Held");
    expect(container.textContent).toContain("Inbox");
    expect(container.textContent).toContain("station-a");
    expect(container.textContent).toContain("Done");
    expect(container.textContent?.indexOf("A card")).toBeLessThan(
      container.textContent?.indexOf("B card") ?? -1
    );
    expect(container.querySelectorAll("section").length).toBeGreaterThanOrEqual(4);
  });
});
