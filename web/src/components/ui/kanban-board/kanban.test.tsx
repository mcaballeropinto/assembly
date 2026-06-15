import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react-dom/test-utils";
import { createRoot } from "react-dom/client";
import { KanbanBoardCard, KanbanBoardProvider } from "./kanban";

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

describe("KanbanBoardCard", () => {
  test("disables browser drag start when isDragDisabled is true", () => {
    let started = false;
    const { container } = render(
      <KanbanBoardProvider onDragStart={() => {
        started = true;
      }}>
        <KanbanBoardCard data={{ id: "wp-1.json" }} isDragDisabled={true}>
          Card
        </KanbanBoardCard>
      </KanbanBoardProvider>
    );

    const card = container.querySelector("[data-kanban-card-id='wp-1.json']") as HTMLElement;
    let setDataCalled = false;
    const event = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: {
        setData: () => {
          setDataCalled = true;
        },
      },
    });

    act(() => {
      card.dispatchEvent(event);
    });

    expect(card.getAttribute("draggable")).toBe("false");
    expect(card.getAttribute("aria-disabled")).toBe("true");
    expect(event.defaultPrevented).toBe(true);
    expect(setDataCalled).toBe(false);
    expect(started).toBe(false);
  });
});
