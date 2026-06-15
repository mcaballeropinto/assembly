import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react-dom/test-utils";
import { createRoot } from "react-dom/client";
import type { KanbanColumn as ApiKanbanColumn } from "../../lib/api";
import { KanbanBoardProvider } from "../ui/kanban-board/kanban";
import { KanbanColumn } from "./kanban-column";

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

function column(overrides: Partial<ApiKanbanColumn> = {}): ApiKanbanColumn {
  return {
    key: "inbox",
    title: "Inbox",
    tooltip: "Waiting for a station",
    count: 0,
    cards: [],
    retrying_count: 2,
    exhausted_count: 1,
    ...overrides,
  };
}

describe("KanbanColumn", () => {
  test("renders requested header layout, count, tooltip trigger, scroll body, and empty text", () => {
    const { container } = render(
      <KanbanColumn column={column()} onOpenCard={() => {}} />
    );

    const header = container.querySelector(".flex.items-center.gap-2.px-3.py-2.border-b");
    const body = container.querySelector(".overflow-y-auto");

    expect(header).toBeTruthy();
    expect(body).toBeTruthy();
    expect(container.textContent).toContain("Inbox");
    expect(container.textContent).toContain("0");
    expect(container.textContent).toContain("No items");
    expect(container.querySelector("[aria-label='Inbox info']")).toBeTruthy();
  });

  test("uses held empty text and confirms release all before invoking callback", async () => {
    let released = 0;
    const { container } = render(
      <KanbanColumn
        column={column({ key: "held", title: "Held", count: 2, tooltip: undefined })}
        onOpenCard={() => {}}
        onReleaseAll={() => {
          released += 1;
        }}
      />
    );

    expect(container.textContent).toContain("No held tasks");
    expect(released).toBe(0);

    await act(async () => {
      (container.querySelector("[aria-label='Held column actions']") as HTMLElement).click();
    });
    await act(async () => {
      (
        (document.body.textContent?.includes("Release all") ? document.body : container)
          .querySelectorAll("[role='menuitem']")[0] as HTMLElement
      ).click();
    });

    expect(released).toBe(0);
    expect(document.body.textContent).toContain("Release all held tasks?");

    const dialog = document.body.querySelector("[role='alertdialog']") as HTMLElement;
    const confirm = Array.from(dialog.querySelectorAll("button")).find(
      (button) => button.textContent === "Release all"
    ) as HTMLButtonElement;

    await act(async () => {
      confirm.click();
    });

    expect(released).toBe(1);
  });

  test("passes release, retry, and dismiss callbacks to cards", () => {
    const calls: string[] = [];
    const { container } = render(
      <KanbanColumn
        column={column({
          key: "error",
          title: "Error",
          count: 1,
          cards: [
            {
              id: "wp-failed",
              fileName: "wp-failed.json",
              title: "Failed",
              state: "failed",
              column: "error",
            },
          ],
        })}
        onOpenCard={() => {
          calls.push("open");
        }}
        onRetryWorkpiece={(fileName) => calls.push(`retry:${fileName}`)}
        onDismissError={(fileName) => calls.push(`dismiss:${fileName}`)}
      />
    );

    act(() => {
      (container.querySelector("[aria-label='Retry wp-failed.json']") as HTMLElement).click();
      (container.querySelector("[aria-label='Dismiss wp-failed.json']") as HTMLElement).click();
    });

    expect(calls).toEqual([
      "retry:wp-failed.json",
      "dismiss:wp-failed.json",
    ]);
  });
});
