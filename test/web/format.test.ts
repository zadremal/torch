// Formatting on the values from the docs/design/ artboards.
import { describe, expect, test } from "bun:test";
import {
  DASH,
  formatBucket,
  formatClock,
  formatCount,
  formatDateTime,
  formatDuration,
  formatMoney,
  formatOffset,
  formatPercent,
  formatTokens,
} from "../../web/src/lib/format.ts";

describe("formatTokens", () => {
  test("millions get two decimals: the Total tokens and Cache read tile", () => {
    expect(formatTokens(2_184_300)).toBe("2.18M");
    expect(formatTokens(1_720_000)).toBe("1.72M");
    expect(formatTokens(4_910_200)).toBe("4.91M");
  });

  test("thousands get one decimal: Token usage and Peak context", () => {
    expect(formatTokens(168_200)).toBe("168.2K");
    expect(formatTokens(109_400)).toBe("109.4K");
    expect(formatTokens(186_700)).toBe("186.7K");
    expect(formatTokens(148_200)).toBe("148.2K");
    expect(formatTokens(41_700)).toBe("41.7K");
    expect(formatTokens(1_200)).toBe("1.2K");
  });

  test("below a thousand as is: prompt tokens", () => {
    expect(formatTokens(412)).toBe("412");
    expect(formatTokens(0)).toBe("0");
  });

  test("billions and digit boundaries", () => {
    expect(formatTokens(402_880_000)).toBe("402.88M");
    expect(formatTokens(1_250_000_000)).toBe("1.25B");
    expect(formatTokens(999_949)).toBe("999.9K");
    expect(formatTokens(999_950)).toBe("1.00M");
  });

  test("an unknown value is a dash", () => {
    expect(formatTokens(null)).toBe(DASH);
  });
});

describe("formatCount", () => {
  test("dashboard counters: below ten thousand an integer with a separator", () => {
    expect(formatCount(186)).toBe("186");
    expect(formatCount(1_792)).toBe("1,792");
    expect(formatCount(9_999)).toBe("9,999");
  });

  test("from ten thousand an abbreviation", () => {
    expect(formatCount(48_210)).toBe("48.2K");
    expect(formatCount(31_402_000)).toBe("31.40M");
  });
});

describe("formatMoney", () => {
  test("session cost and dashboard total", () => {
    expect(formatMoney(18.42)).toBe("$18.42");
    expect(formatMoney(0.61)).toBe("$0.61");
    expect(formatMoney(4.1)).toBe("$4.10");
    expect(formatMoney(3391.7)).toBe("$3,391.70");
  });

  test("an unknown cost is a dash (plan §9.3)", () => {
    expect(formatMoney(null)).toBe("—");
  });
});

describe("formatDuration", () => {
  test("minutes and seconds: Duration and model time on the session overview", () => {
    expect(formatDuration(1_122_000)).toBe("18m 42s");
    expect(formatDuration(668_000)).toBe("11m 08s");
    expect(formatDuration(120_000)).toBe("2m 00s");
    expect(formatDuration(146_000)).toBe("2m 26s");
  });

  test("seconds and milliseconds: call duration in the panel", () => {
    expect(formatDuration(4_200)).toBe("4.2 s");
    expect(formatDuration(18_400)).toBe("18.4 s");
    expect(formatDuration(300)).toBe("300 ms");
    expect(formatDuration(0)).toBe("0 ms");
  });

  test("hours: the Longest sessions leaderboard", () => {
    expect(formatDuration(5_420_000)).toBe("1h 30m");
    expect(formatDuration(3_900_000)).toBe("1h 05m");
  });

  test("unit boundaries do not give \"1000 ms\" and \"60.0 s\"", () => {
    expect(formatDuration(999.6)).toBe("1.0 s");
    expect(formatDuration(59_960)).toBe("1m 00s");
  });

  test("an unknown duration is a dash", () => {
    expect(formatDuration(null)).toBe(DASH);
  });
});

describe("formatOffset", () => {
  test("time since the session start in a panel call row", () => {
    expect(formatOffset(0)).toBe("+0:00");
    expect(formatOffset(372_000)).toBe("+6:12");
    expect(formatOffset(1_008_000)).toBe("+16:48");
  });
});

describe("formatPercent", () => {
  test("context window share and error rate", () => {
    expect(formatPercent(148_200 / 200_000)).toBe("74%");
    expect(formatPercent(7 / 186, 1)).toBe("3.8%");
    expect(formatPercent(null)).toBe(DASH);
  });
});

describe("time in the machine's local time", () => {
  // The constructor with separate fields takes local time: the test does not depend on the time zone.
  const started = new Date(2026, 9, 31, 14, 2, 11).getTime();

  test("formatClock: session start", () => {
    expect(formatClock(started)).toBe("14:02:11");
  });

  test("formatDateTime: the Started column", () => {
    expect(formatDateTime(started)).toBe("Oct 31, 14:02");
    expect(formatDateTime(new Date(2026, 9, 30, 9, 12, 0).getTime())).toBe("Oct 30, 09:12");
  });

  test("formatBucket: dashboard bar label for each bar width", () => {
    expect(formatBucket(new Date(2026, 9, 31, 22, 0, 0).getTime(), "hours")).toBe("22:00");
    expect(formatBucket(new Date(2026, 9, 25).getTime(), "day")).toBe("Oct 25");
    expect(formatBucket(new Date(2025, 10, 1).getTime(), "month")).toBe("Nov 2025");
  });

  test("an unknown time is a dash", () => {
    expect(formatClock(null)).toBe(DASH);
    expect(formatDateTime(null)).toBe(DASH);
  });
});
