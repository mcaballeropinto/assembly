import { test, expect, describe } from "bun:test";
import { diffKanban, type KanbanState, type KanbanCard } from "../dashboard-data";

function card(id: string, column: string): KanbanCard {
  return {
    id,
    fileName: `${id}.json`,
    title: id,
    state: column === "done" ? "done" : "waiting",
    column,
    enteredColumnAt: null,
  };
}

function state(cols: Record<string, KanbanCard[]>): KanbanState {
  return {
    line: "x",
    sequence: [],
    lastUpdated: "t",
    columns: Object.entries(cols).map(([key, cards]) => ({
      key,
      title: key,
      count: cards.length,
      cards,
    })),
  };
}

describe("diffKanban", () => {
  test("returns empty array when states are identical", () => {
    const s = state({ inbox: [card("a", "inbox")], done: [card("b", "done")] });
    expect(diffKanban(s, s)).toEqual([]);
  });

  test("reports added cards with from=null", () => {
    const prev = state({ inbox: [] });
    const next = state({ inbox: [card("a", "inbox")] });
    expect(diffKanban(prev, next)).toEqual([{ id: "a", from: null, to: "inbox" }]);
  });

  test("reports removed cards with to=null", () => {
    const prev = state({ inbox: [card("a", "inbox")] });
    const next = state({ inbox: [] });
    expect(diffKanban(prev, next)).toEqual([{ id: "a", from: "inbox", to: null }]);
  });

  test("reports moved cards with both from and to", () => {
    const prev = state({ "s:inbox": [card("a", "s:inbox")], "s:processing": [] });
    const next = state({ "s:inbox": [], "s:processing": [card("a", "s:processing")] });
    const moves = diffKanban(prev, next);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toEqual({ id: "a", from: "s:inbox", to: "s:processing" });
  });

  test("omits unchanged cards in a mixed diff", () => {
    const prev = state({
      inbox: [card("a", "inbox"), card("b", "inbox")],
      done: [card("c", "done")],
    });
    const next = state({
      inbox: [card("a", "inbox")],
      processing: [card("b", "processing")],
      done: [card("c", "done"), card("d", "done")],
    });
    const moves = diffKanban(prev, next);
    const byId = new Map(moves.map((m) => [m.id, m]));
    expect(byId.get("a")).toBeUndefined();
    expect(byId.get("c")).toBeUndefined();
    expect(byId.get("b")).toEqual({ id: "b", from: "inbox", to: "processing" });
    expect(byId.get("d")).toEqual({ id: "d", from: null, to: "done" });
    expect(moves).toHaveLength(2);
  });

  test("treats null prev as everything-added", () => {
    const next = state({ inbox: [card("a", "inbox"), card("b", "inbox")] });
    const moves = diffKanban(null, next);
    expect(moves).toHaveLength(2);
    for (const m of moves) {
      expect(m.from).toBeNull();
      expect(m.to).toBe("inbox");
    }
  });

  test("treats empty next as everything-removed", () => {
    const prev = state({ inbox: [card("a", "inbox")], done: [card("b", "done")] });
    const next = state({});
    const moves = diffKanban(prev, next);
    expect(moves).toHaveLength(2);
    for (const m of moves) expect(m.to).toBeNull();
    const froms = moves.map((m) => m.from).sort();
    expect(froms).toEqual(["done", "inbox"]);
  });
});
