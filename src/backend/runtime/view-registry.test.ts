import { describe, expect, test } from "bun:test";
import { ViewRegistry } from "./view-registry.js";

describe("ViewRegistry", () => {
  test("open/close/isOpen for one user and chat", () => {
    const views = new ViewRegistry();
    expect(views.isOpen("u1", "a")).toBe(false);
    expect(views.open("u1", "a")).toBeNull();
    expect(views.isOpen("u1", "a")).toBe(true);
    expect(views.close("u1", "a")).toBe(true);
    expect(views.isOpen("u1", "a")).toBe(false);
  });

  test("open is idempotent and close is idempotent", () => {
    const views = new ViewRegistry();
    views.open("u1", "a");
    expect(views.open("u1", "a")).toBeNull();
    expect(views.isOpen("u1", "a")).toBe(true);
    expect(views.close("u1", "a")).toBe(true);
    expect(views.close("u1", "a")).toBe(false);
  });

  test("opening chat A does not open chat B", () => {
    const views = new ViewRegistry();
    views.open("u1", "a");
    expect(views.isOpen("u1", "b")).toBe(false);
  });

  test("one open chat per user: opening B reports A as displaced and closes it", () => {
    const views = new ViewRegistry();
    views.open("u1", "a");
    expect(views.open("u1", "b")).toBe("a");
    expect(views.isOpen("u1", "a")).toBe(false);
    expect(views.isOpen("u1", "b")).toBe(true);
    expect(views.openChat("u1")).toBe("b");
  });

  test("a stale close for another chat changes nothing", () => {
    const views = new ViewRegistry();
    views.open("u1", "b");
    expect(views.close("u1", "a")).toBe(false);
    expect(views.isOpen("u1", "b")).toBe(true);
  });

  test("users are independent; undefined user maps to the owner key", () => {
    const views = new ViewRegistry();
    views.open("u1", "a");
    views.open("u2", "b");
    expect(views.isOpen("u1", "a")).toBe(true);
    expect(views.isOpen("u2", "b")).toBe(true);
    expect(views.isOpen("u2", "a")).toBe(false);
    views.open(undefined, "c");
    expect(views.isOpen("owner", "c")).toBe(true);
    expect(views.isOpen(undefined, "c")).toBe(true);
  });

  test("empty chat ids never open and never report open", () => {
    const views = new ViewRegistry();
    expect(views.open("u1", "")).toBeNull();
    expect(views.isOpen("u1", "")).toBe(false);
    expect(views.openChat("u1")).toBeNull();
  });

  test("clear forgets everything (restarted backend)", () => {
    const views = new ViewRegistry();
    views.open("u1", "a");
    views.clear();
    expect(views.isOpen("u1", "a")).toBe(false);
  });
});
