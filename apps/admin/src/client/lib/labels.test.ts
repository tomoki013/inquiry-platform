import { describe, expect, it } from "vitest";

import { NO_REPLY_ADDRESS, requesterLine } from "./labels";

/**
 * Both halves of "who is this from" are optional, and both are missing often
 * enough to matter: the app forms treat the name as optional and ask for an
 * address only when somebody wants an answer.
 */
describe("requesterLine", () => {
  it("puts the address after the name when there is both", () => {
    expect(requesterLine({ requesterName: "ともきち", requesterEmail: "a@b.co" })).toBe(
      "ともきち <a@b.co>",
    );
  });

  it("says there is nowhere to reply rather than showing empty brackets", () => {
    expect(requesterLine({ requesterName: "ともきち" })).toBe(`ともきち（${NO_REPLY_ADDRESS}）`);
  });

  it("falls back to the address alone, and then to saying there is none", () => {
    expect(requesterLine({ requesterEmail: "a@b.co" })).toBe("a@b.co");
    expect(requesterLine({})).toBe(NO_REPLY_ADDRESS);
  });
});
