import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react-dom/test-utils";
import { createRoot } from "react-dom/client";
import type { KanbanCard as ApiKanbanCard } from "../../lib/api";
import { KanbanBoardProvider } from "../ui/kanban-board/kanban";
import { KanbanCard } from "./kanban-card";

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
    root.render(<KanbanBoardProvider>{element}</KanbanBoardProvider>);
  });
  return { container, root };
}

const now = new Date("2026-06-15T12:00:00.000Z").getTime();

function card(overrides: Partial<ApiKanbanCard> = {}): ApiKanbanCard {
  return {
    id: "wp-123",
    fileName: "wp-123.json",
    title: "Draft report",
    preview: "Summarize the current station output",
    state: "retrying",
    column: "writer:processing",
    station: "writer",
    lane: "processing",
    enteredColumnAt: "2026-06-15T11:50:00.000Z",
    stationStartedAt: "2026-06-15T11:58:00.000Z",
    retry: {
      retry_count: 1,
      max_retries: 3,
      in_backoff: false,
      exhausted: false,
    },
    ...overrides,
  };
}

describe("KanbanCard", () => {
  test("renders state icon, title, preview, retry chip, and processing duration", () => {
    const { container } = render(<KanbanCard card={card()} onOpen={() => {}} now={now} />);

    expect(container.textContent).toContain("\u21ba");
    expect(container.textContent).toContain("Draft report");
    expect(container.textContent).toContain("Summarize the current station output");
    expect(container.textContent).toContain("wp-123");
    expect(container.textContent).toContain("1/3");
    expect(container.textContent).toContain("2m in writer");
  });

  test("formats waiting, queued, and done durations", () => {
    const { container } = render(
      <div>
        <KanbanCard
          card={card({
            state: "waiting",
            lane: "inbox",
            column: "writer:inbox",
            stationStartedAt: null,
            enteredColumnAt: "2026-06-15T11:55:00.000Z",
            retry: undefined,
          })}
          onOpen={() => {}}
          now={now}
        />
        <KanbanCard
          card={card({
            state: "held",
            lane: undefined,
            station: undefined,
            column: "held",
            stationStartedAt: null,
            enteredColumnAt: "2026-06-15T11:45:00.000Z",
            retry: undefined,
          })}
          onOpen={() => {}}
          now={now}
        />
        <KanbanCard
          card={card({
            state: "done",
            column: "done",
            lane: undefined,
            station: undefined,
            stationStartedAt: null,
            duration_ms: 65_000,
            retry: undefined,
          })}
          onOpen={() => {}}
          now={now}
        />
      </div>
    );

    expect(container.textContent).toContain("5m waiting");
    expect(container.textContent).toContain("15m queued");
    expect(container.textContent).toContain("1m 5s");
  });

  test("opens the card by file name on click", () => {
    let opened = "";
    const { container } = render(
      <KanbanCard
        card={card({ fileName: "wp-click.json" })}
        onOpen={(fileName) => {
          opened = fileName;
        }}
        now={now}
      />
    );

    act(() => {
      (container.querySelector("[role='button']") as HTMLElement).click();
    });

    expect(opened).toBe("wp-click.json");
  });

  test("renders held and failed actions without opening the card", () => {
    let opened = "";
    let released = "";
    let retried = "";
    let dismissed = "";
    const { container } = render(
      <div>
        <KanbanCard
          card={card({ state: "held", column: "held", fileName: "held.json" })}
          onOpen={(fileName) => {
            opened = fileName;
          }}
          onReleaseHeld={(fileName) => {
            released = fileName;
          }}
          now={now}
        />
        <KanbanCard
          card={card({ state: "failed", column: "error", fileName: "failed.json" })}
          onOpen={(fileName) => {
            opened = fileName;
          }}
          onRetryWorkpiece={(fileName) => {
            retried = fileName;
          }}
          onDismissError={(fileName) => {
            dismissed = fileName;
          }}
          now={now}
        />
      </div>
    );

    act(() => {
      (container.querySelector("[aria-label='Release held.json']") as HTMLElement).click();
      (container.querySelector("[aria-label='Retry failed.json']") as HTMLElement).click();
      (container.querySelector("[aria-label='Dismiss failed.json']") as HTMLElement).click();
    });

    expect(opened).toBe("");
    expect(released).toBe("held.json");
    expect(retried).toBe("failed.json");
    expect(dismissed).toBe("failed.json");
  });
});
