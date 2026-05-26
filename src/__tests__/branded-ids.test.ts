import { describe, it, expect } from "bun:test";
import {
  WorkpieceId,
  LineName,
  StationName,
  TaskFileName,
  InvalidTaskFileError,
} from "../ids";

describe("Branded ID types", () => {
  describe("WorkpieceId", () => {
    it("constructs from string", () => {
      const id = WorkpieceId("run_2025-01-01T00-00-00-000Z_001");
      expect(id as string).toBe("run_2025-01-01T00-00-00-000Z_001");
    });

    it("can be used as string", () => {
      const id = WorkpieceId("test-id");
      const interpolated = `Workpiece: ${id}`;
      expect(interpolated).toBe("Workpiece: test-id");
    });
  });

  describe("LineName", () => {
    it("constructs from string", () => {
      const name = LineName("hello-world");
      expect(name as string).toBe("hello-world");
    });
  });

  describe("StationName", () => {
    it("constructs from string", () => {
      const name = StationName("plan");
      expect(name as string).toBe("plan");
    });
  });

  describe("TaskFileName", () => {
    it("accepts valid basename ending in .json", () => {
      const fileName = TaskFileName("task-123.json");
      expect(fileName as string).toBe("task-123.json");
    });

    it("rejects non-basename (contains slash)", () => {
      expect(() => TaskFileName("../task.json")).toThrow(InvalidTaskFileError);
      expect(() => TaskFileName("dir/task.json")).toThrow(InvalidTaskFileError);
      expect(() => TaskFileName("dir\\task.json")).toThrow(InvalidTaskFileError);
    });

    it("rejects non-.json extension", () => {
      expect(() => TaskFileName("task.txt")).toThrow(InvalidTaskFileError);
    });

    it("rejects traversal patterns", () => {
      expect(() => TaskFileName("task..json")).toThrow(InvalidTaskFileError);
    });

    it("accepts valid task filenames", () => {
      expect(TaskFileName("task-1776568940274.json") as string).toBe("task-1776568940274.json");
      expect(TaskFileName("my-task.json") as string).toBe("my-task.json");
      expect(TaskFileName("task_123.json") as string).toBe("task_123.json");
    });
  });

  describe("Type safety (compile-time)", () => {
    it("prevents mixing different branded types", () => {
      // These are compile-time errors:

      // @ts-expect-error - Can't assign LineName to WorkpieceId
      const id: WorkpieceId = LineName("test");

      // @ts-expect-error - Can't assign StationName to LineName
      const line: LineName = StationName("plan");

      // Can't pass plain string where branded type expected
      function takeWorkpieceId(id: WorkpieceId) {}
      // @ts-expect-error - Plain string not assignable to WorkpieceId
      takeWorkpieceId("plain-string");

      // Runtime: this test always passes (the above are compile checks)
      expect(true).toBe(true);
    });

    it("branded types extend string", () => {
      const wpId = WorkpieceId("test-id");
      const line = LineName("test-line");
      const station = StationName("test-station");

      // All branded types can be used where string is expected
      const result: string = wpId;
      expect(result).toBe("test-id");

      // String interpolation works
      expect(`${line}/${station}`).toBe("test-line/test-station");
    });

    it("demonstrates slot-confusion prevention", () => {
      // The original problem: functions that take (lineName, stationName, taskFile)
      // could silently accept arguments in the wrong order with plain strings.

      // Example function that would be vulnerable without branded types:
      function processTask(
        line: LineName,
        station: StationName,
        taskFile: TaskFileName
      ): string {
        return `${line}/${station}/${taskFile}`;
      }

      const line = LineName("my-line");
      const station = StationName("my-station");
      const task = TaskFileName("task.json");

      // This works correctly:
      expect(processTask(line, station, task)).toBe("my-line/my-station/task.json");

      // Without branded types, this would compile but be wrong:
      // processTask(station, line, task) - would compile with plain strings!
      // But with branded types, this is a compile error:
      // @ts-expect-error - Can't pass StationName where LineName expected
      processTask(station, line, task);

      expect(true).toBe(true);
    });
  });
});
