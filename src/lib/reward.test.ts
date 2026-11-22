import { afterEach, describe, expect, it, vi } from "vitest";
import { failure, success } from "./action-result";
import { ACHIEVEMENT_EVENT, CHECK_BEAT_MS, reward } from "./reward";

/** A window with just what reward() touches; returns the events it dispatched. */
function stubWindow({ reducedMotion = false } = {}) {
  const events: CustomEvent<string[]>[] = [];
  vi.stubGlobal("window", {
    dispatchEvent: (event: Event) => {
      events.push(event as CustomEvent<string[]>);
      return true;
    },
    matchMedia: (query: string) => ({ matches: reducedMotion && query.includes("reduce") }),
  });
  return events;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reward", () => {
  it("lands the check, announces the achievements and holds one beat", async () => {
    const events = stubWindow();
    const button = { done: vi.fn() };
    const wait = vi.fn(async () => {});

    await reward(success("Mission completed.", ["First Mission"]), button, wait);

    expect(button.done).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(CHECK_BEAT_MS);
    expect(events.map((event) => [event.type, event.detail])).toEqual([[ACHIEVEMENT_EVENT, ["First Mission"]]]);
  });

  it("plays nothing for an action that failed", async () => {
    const events = stubWindow();
    const button = { done: vi.fn() };
    const wait = vi.fn(async () => {});

    await reward(failure("Mission not found."), button, wait);

    expect(button.done).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("skips the beat when the user asks for reduced motion", async () => {
    stubWindow({ reducedMotion: true });
    const button = { done: vi.fn() };
    const wait = vi.fn(async () => {});

    await reward(success("Logged."), button, wait);

    expect(button.done).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it("still announces achievements while the animated button has not loaded", async () => {
    const events = stubWindow();
    const wait = vi.fn(async () => {});

    await reward(success("Logged.", ["Seven Day Streak"]), null, wait);

    expect(events.map((event) => event.detail)).toEqual([["Seven Day Streak"]]);
    expect(wait).not.toHaveBeenCalled();
  });

  it("never turns a saved action into an error when an effect throws", async () => {
    stubWindow();
    const button = {
      done: () => {
        throw new Error("canvas unavailable");
      },
    };

    await expect(reward(success("Mission completed."), button, async () => {})).resolves.toBeUndefined();
  });
});
