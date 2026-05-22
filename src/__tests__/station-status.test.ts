import { test, expect, describe } from "bun:test";
import { computeStationStatuses, STATION_BLOCKED_THRESHOLD_MS, type KanbanColumn, type KanbanCard } from "../dashboard-data";

describe("computeStationStatuses", () => {
  const mockCard = (overrides?: Partial<KanbanCard>): KanbanCard => ({
    id: "test-id",
    fileName: "test.json",
    title: "Test Card",
    state: "waiting",
    column: "plan:inbox",
    enteredColumnAt: new Date().toISOString(),
    ...overrides,
  });

  test("constant STATION_BLOCKED_THRESHOLD_MS is 15 minutes", () => {
    expect(STATION_BLOCKED_THRESHOLD_MS).toBe(15 * 60 * 1000);
  });

  test("running state: station with cards in processing lane", () => {
    const columns: KanbanColumn[] = [
      {
        key: "plan:processing",
        title: "processing",
        station: "plan",
        lane: "processing",
        count: 2,
        cards: [
          mockCard({ enteredColumnAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() }),
          mockCard({ enteredColumnAt: new Date().toISOString() }),
        ],
      },
      {
        key: "plan:inbox",
        title: "waiting",
        station: "plan",
        lane: "inbox",
        count: 0,
        cards: [],
      },
      {
        key: "plan:output",
        title: "output",
        station: "plan",
        lane: "output",
        count: 0,
        cards: [],
      },
    ];

    const result = computeStationStatuses(columns, ["plan"], [], "/fake/path");

    expect(result.plan.state).toBe("running");
    expect(result.plan.icon).toBe("▶");
    expect(result.plan.label).toContain("Running");
    expect(result.plan.label).toContain("2 items");
    expect(result.plan.itemCount).toBe(2);
  });

  test("idle state (empty): station with no cards in any lane", () => {
    const columns: KanbanColumn[] = [
      {
        key: "plan:inbox",
        title: "waiting",
        station: "plan",
        lane: "inbox",
        count: 0,
        cards: [],
      },
      {
        key: "plan:processing",
        title: "processing",
        station: "plan",
        lane: "processing",
        count: 0,
        cards: [],
      },
      {
        key: "plan:output",
        title: "output",
        station: "plan",
        lane: "output",
        count: 0,
        cards: [],
      },
    ];

    const result = computeStationStatuses(columns, ["plan"], [], "/fake/path");

    expect(result.plan.state).toBe("idle");
    expect(result.plan.icon).toBe("◯");
    expect(result.plan.label).toBe("Idle · no work");
    expect(result.plan.itemCount).toBe(0);
  });

  test("idle state (items in output): station with cards in output only", () => {
    const columns: KanbanColumn[] = [
      {
        key: "plan:inbox",
        title: "waiting",
        station: "plan",
        lane: "inbox",
        count: 0,
        cards: [],
      },
      {
        key: "plan:processing",
        title: "processing",
        station: "plan",
        lane: "processing",
        count: 0,
        cards: [],
      },
      {
        key: "plan:output",
        title: "output",
        station: "plan",
        lane: "output",
        count: 3,
        cards: [mockCard(), mockCard(), mockCard()],
      },
    ];

    const result = computeStationStatuses(columns, ["plan"], [], "/fake/path");

    expect(result.plan.state).toBe("idle");
    expect(result.plan.icon).toBe("◯");
    expect(result.plan.label).toContain("Idle");
    expect(result.plan.label).toContain("3 items");
    expect(result.plan.itemCount).toBe(3);
  });

  test("blocked state: station with old cards in inbox lane", () => {
    const oldTimestamp = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 min ago
    const columns: KanbanColumn[] = [
      {
        key: "plan:inbox",
        title: "waiting",
        station: "plan",
        lane: "inbox",
        count: 2,
        cards: [
          mockCard({ enteredColumnAt: oldTimestamp }),
          mockCard({ enteredColumnAt: new Date(Date.now() - 16 * 60 * 1000).toISOString() }),
        ],
      },
      {
        key: "plan:processing",
        title: "processing",
        station: "plan",
        lane: "processing",
        count: 0,
        cards: [],
      },
      {
        key: "plan:output",
        title: "output",
        station: "plan",
        lane: "output",
        count: 0,
        cards: [],
      },
    ];

    const result = computeStationStatuses(columns, ["plan"], [], "/fake/path");

    expect(result.plan.state).toBe("blocked");
    expect(result.plan.icon).toBe("!");
    expect(result.plan.label).toContain("Blocked");
    expect(result.plan.label).toContain("2 items waiting");
    expect(result.plan.itemCount).toBe(2);
  });

  test("not blocked (recent inbox): station with fresh cards in inbox lane", () => {
    const recentTimestamp = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
    const columns: KanbanColumn[] = [
      {
        key: "plan:inbox",
        title: "waiting",
        station: "plan",
        lane: "inbox",
        count: 1,
        cards: [mockCard({ enteredColumnAt: recentTimestamp })],
      },
      {
        key: "plan:processing",
        title: "processing",
        station: "plan",
        lane: "processing",
        count: 0,
        cards: [],
      },
      {
        key: "plan:output",
        title: "output",
        station: "plan",
        lane: "output",
        count: 0,
        cards: [],
      },
    ];

    const result = computeStationStatuses(columns, ["plan"], [], "/fake/path");

    expect(result.plan.state).toBe("idle");
    expect(result.plan.label).toContain("Idle");
  });

  test("errored state: error column has cards with failedStation matching this station", () => {
    const errorColumns: KanbanColumn[] = [
      {
        key: "error",
        title: "Error",
        count: 2,
        cards: [
          mockCard({ failedStation: "plan", enteredColumnAt: new Date(Date.now() - 2 * 60 * 1000).toISOString() }),
          mockCard({ failedStation: "plan", enteredColumnAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() }),
        ],
      },
    ];

    const columns: KanbanColumn[] = [
      {
        key: "plan:inbox",
        title: "waiting",
        station: "plan",
        lane: "inbox",
        count: 0,
        cards: [],
      },
      {
        key: "plan:processing",
        title: "processing",
        station: "plan",
        lane: "processing",
        count: 0,
        cards: [],
      },
      {
        key: "plan:output",
        title: "output",
        station: "plan",
        lane: "output",
        count: 0,
        cards: [],
      },
    ];

    const result = computeStationStatuses(columns, ["plan"], errorColumns, "/fake/path");

    expect(result.plan.state).toBe("errored");
    expect(result.plan.icon).toBe("✕");
    expect(result.plan.label).toContain("Errored");
    expect(result.plan.label).toContain("2 errors");
    expect(result.plan.itemCount).toBe(0);
  });

  test("priority: errored overrides running", () => {
    const errorColumns: KanbanColumn[] = [
      {
        key: "error",
        title: "Error",
        count: 1,
        cards: [mockCard({ failedStation: "plan", enteredColumnAt: new Date().toISOString() })],
      },
    ];

    const columns: KanbanColumn[] = [
      {
        key: "plan:inbox",
        title: "waiting",
        station: "plan",
        lane: "inbox",
        count: 0,
        cards: [],
      },
      {
        key: "plan:processing",
        title: "processing",
        station: "plan",
        lane: "processing",
        count: 1,
        cards: [mockCard({ enteredColumnAt: new Date().toISOString() })],
      },
      {
        key: "plan:output",
        title: "output",
        station: "plan",
        lane: "output",
        count: 0,
        cards: [],
      },
    ];

    const result = computeStationStatuses(columns, ["plan"], errorColumns, "/fake/path");

    // Errored should take priority over running
    expect(result.plan.state).toBe("errored");
    expect(result.plan.icon).toBe("✕");
  });

  test("all stations in sequence get a status", () => {
    const columns: KanbanColumn[] = [
      {
        key: "plan:inbox",
        title: "waiting",
        station: "plan",
        lane: "inbox",
        count: 0,
        cards: [],
      },
      {
        key: "plan:processing",
        title: "processing",
        station: "plan",
        lane: "processing",
        count: 1,
        cards: [mockCard()],
      },
      {
        key: "plan:output",
        title: "output",
        station: "plan",
        lane: "output",
        count: 0,
        cards: [],
      },
      {
        key: "code:inbox",
        title: "waiting",
        station: "code",
        lane: "inbox",
        count: 0,
        cards: [],
      },
      {
        key: "code:processing",
        title: "processing",
        station: "code",
        lane: "processing",
        count: 0,
        cards: [],
      },
      {
        key: "code:output",
        title: "output",
        station: "code",
        lane: "output",
        count: 0,
        cards: [],
      },
      {
        key: "review:inbox",
        title: "waiting",
        station: "review",
        lane: "inbox",
        count: 0,
        cards: [],
      },
      {
        key: "review:processing",
        title: "processing",
        station: "review",
        lane: "processing",
        count: 0,
        cards: [],
      },
      {
        key: "review:output",
        title: "output",
        station: "review",
        lane: "output",
        count: 0,
        cards: [],
      },
    ];

    const result = computeStationStatuses(columns, ["plan", "code", "review"], [], "/fake/path");

    expect(Object.keys(result)).toEqual(["plan", "code", "review"]);
    expect(result.plan.state).toBe("running");
    expect(result.code.state).toBe("idle");
    expect(result.review.state).toBe("idle");
  });

  test("label contains item count for running station with multiple items", () => {
    const columns: KanbanColumn[] = [
      {
        key: "plan:processing",
        title: "processing",
        station: "plan",
        lane: "processing",
        count: 3,
        cards: [mockCard(), mockCard(), mockCard()],
      },
      {
        key: "plan:inbox",
        title: "waiting",
        station: "plan",
        lane: "inbox",
        count: 0,
        cards: [],
      },
      {
        key: "plan:output",
        title: "output",
        station: "plan",
        lane: "output",
        count: 0,
        cards: [],
      },
    ];

    const result = computeStationStatuses(columns, ["plan"], [], "/fake/path");

    expect(result.plan.label).toContain("3 items");
  });

  test("label uses singular 'item' for single item", () => {
    const columns: KanbanColumn[] = [
      {
        key: "plan:processing",
        title: "processing",
        station: "plan",
        lane: "processing",
        count: 1,
        cards: [mockCard()],
      },
      {
        key: "plan:inbox",
        title: "waiting",
        station: "plan",
        lane: "inbox",
        count: 0,
        cards: [],
      },
      {
        key: "plan:output",
        title: "output",
        station: "plan",
        lane: "output",
        count: 0,
        cards: [],
      },
    ];

    const result = computeStationStatuses(columns, ["plan"], [], "/fake/path");

    expect(result.plan.label).toContain("1 item");
    expect(result.plan.label).not.toContain("1 items");
  });

  test("handles station with no lanes in columns (never initialized)", () => {
    const columns: KanbanColumn[] = [];
    const result = computeStationStatuses(columns, ["plan"], [], "/fake/path");

    expect(result.plan.state).toBe("idle");
    expect(result.plan.icon).toBe("◯");
    expect(result.plan.label).toBe("Idle · no work");
    expect(result.plan.itemCount).toBe(0);
  });

  test("error attribution: only errors for matching station", () => {
    const errorColumns: KanbanColumn[] = [
      {
        key: "error",
        title: "Error",
        count: 3,
        cards: [
          mockCard({ failedStation: "plan", enteredColumnAt: new Date().toISOString() }),
          mockCard({ failedStation: "code", enteredColumnAt: new Date().toISOString() }),
          mockCard({ failedStation: "plan", enteredColumnAt: new Date().toISOString() }),
        ],
      },
    ];

    const columns: KanbanColumn[] = [
      {
        key: "plan:inbox",
        title: "waiting",
        station: "plan",
        lane: "inbox",
        count: 0,
        cards: [],
      },
      {
        key: "plan:processing",
        title: "processing",
        station: "plan",
        lane: "processing",
        count: 0,
        cards: [],
      },
      {
        key: "plan:output",
        title: "output",
        station: "plan",
        lane: "output",
        count: 0,
        cards: [],
      },
      {
        key: "code:inbox",
        title: "waiting",
        station: "code",
        lane: "inbox",
        count: 0,
        cards: [],
      },
      {
        key: "code:processing",
        title: "processing",
        station: "code",
        lane: "processing",
        count: 0,
        cards: [],
      },
      {
        key: "code:output",
        title: "output",
        station: "code",
        lane: "output",
        count: 0,
        cards: [],
      },
    ];

    const result = computeStationStatuses(columns, ["plan", "code"], errorColumns, "/fake/path");

    expect(result.plan.state).toBe("errored");
    expect(result.plan.label).toContain("2 errors");
    expect(result.code.state).toBe("errored");
    expect(result.code.label).toContain("1 error");
  });
});
