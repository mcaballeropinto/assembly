import { resolve } from "path";
import { appendFileSync, mkdirSync } from "fs";
import type { LogEvent, TokenUsage } from "./types";

export class Logger {
  private logPath: string;

  constructor(runDir: string) {
    mkdirSync(runDir, { recursive: true });
    this.logPath = resolve(runDir, "log.jsonl");
  }

  log(event: LogEvent): void {
    const line = JSON.stringify(event) + "\n";
    appendFileSync(this.logPath, line);
  }

  runStart(line: string, task: string): void {
    this.log({ event: "run_start", line, task, ts: now() });
  }

  stationStart(station: string, model: string): void {
    this.log({ event: "station_start", station, model, ts: now() });
  }

  stationEnd(
    station: string,
    status: string,
    tokens: TokenUsage
  ): void {
    this.log({ event: "station_end", station, status, tokens, ts: now() });
  }

  runEnd(
    status: string,
    totalTokens: { in: number; out: number },
    duration: string
  ): void {
    this.log({
      event: "run_end",
      status,
      total_tokens: totalTokens,
      duration,
      ts: now(),
    });
  }
}

function now(): string {
  return new Date().toISOString();
}
