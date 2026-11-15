// Sync schedules: the rule subset and when each fires next (the dispatcher is covered by catalog-sync.test.ts).
import { describe, expect, it } from "vitest";
import { DEFAULT_SYNC_RULE, nextRun, parseScheduleRule, scheduleRule } from "../src";

const at = (iso: string) => new Date(iso);

describe("sync schedules", () => {
  it("round-trips the three schedules, and reads anything else as off", () => {
    for (const s of [
      { every: "off" },
      { every: "6h" },
      { every: "day", hour: 2 },
      { every: "day", hour: 23 },
    ] as const) {
      expect(parseScheduleRule(scheduleRule(s))).toEqual(s);
    }
    expect(DEFAULT_SYNC_RULE).toBe("FREQ=DAILY;BYHOUR=2");
    for (const rule of ["FREQ=DAILY;BYHOUR=24", "FREQ=WEEKLY", "nonsense", ""]) {
      expect(parseScheduleRule(rule)).toEqual({ every: "off" });
    }
    expect(() => scheduleRule({ every: "day", hour: 25 })).toThrow();
  });

  it("fires daily at the hour, strictly after now", () => {
    const daily = "FREQ=DAILY;BYHOUR=2";
    expect(nextRun(daily, at("2026-10-10T01:59:00Z"))?.toISOString()).toBe("2026-10-10T02:00:00.000Z");
    expect(nextRun(daily, at("2026-10-10T02:00:00Z"))?.toISOString()).toBe("2026-10-11T02:00:00.000Z");
    expect(nextRun(daily, at("2026-10-10T23:30:00Z"))?.toISOString()).toBe("2026-10-11T02:00:00.000Z");
  });

  it("fires every 6 hours on the UTC quarter-days", () => {
    const six = "FREQ=HOURLY;INTERVAL=6";
    expect(nextRun(six, at("2026-10-10T05:59:00Z"))?.toISOString()).toBe("2026-10-10T06:00:00.000Z");
    expect(nextRun(six, at("2026-10-10T06:00:00Z"))?.toISOString()).toBe("2026-10-10T12:00:00.000Z");
    expect(nextRun(six, at("2026-10-10T22:10:00Z"))?.toISOString()).toBe("2026-10-11T00:00:00.000Z");
    expect(nextRun(null, at("2026-10-10T00:00:00Z"))).toBeNull();
  });
});
