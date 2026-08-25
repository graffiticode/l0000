// SPDX-License-Identifier: MIT
/**
 * The View is the SHARED harness every child language inherits, so a state bug here corrupts
 * all of them. These tests assert on the DATA MODEL and on REQUEST COUNTS, not on markup: the
 * reported failures ("the sheet reloads and erases my edits", "it flickers") both settle to
 * plausible-looking markup, so any "is the text on screen" assertion passes right through them.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act, cleanup } from "@testing-library/react";
import { SWRConfig } from "swr";
import React from "react";
import type { FormProps } from "./view";

let renders = 0;
let lastData: any;
let apply!: (a: { type: string; args?: any }) => void;

const CountingForm = ({ state }: FormProps) => {
  renders++;
  lastData = state.data;
  apply = state.apply;
  return <div data-testid="form">{JSON.stringify(state.data)}</div>;
};

/** SWR's cache is module-global; give each test its own so keys can't leak between them. */
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
);

async function loadView() {
  vi.resetModules();
  return (await import("./view")).View;
}

const setSearch = (qs: string) => window.history.replaceState({}, "", `/form${qs}`);
const tick = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

beforeEach(() => { renders = 0; lastData = undefined; setSearch(""); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/**
 * A compile server that behaves like the real one: it returns the FULL form state, derived
 * from the posted data, after a settable delay. `latency` is what exposes the interleaving.
 */
function stubApi({ stored, latency = 0 }: { stored: any; latency?: number }) {
  const compilePosts: any[] = [];
  const fetchSpy = vi.fn(async (url: string, init?: any) => {
    if (String(url).includes("/compile")) {
      const body = JSON.parse(init.body);
      compilePosts.push(body.data);
      const posted = body.data ?? {};
      if (latency) await new Promise((r) => setTimeout(r, latency));
      // The compiled form: stored cells overlaid with whatever the learner has entered.
      return { json: async () => ({ status: "success", data: { ...stored, ...posted } }) };
    }
    return { json: async () => ({ status: "success", data: stored }) };
  });
  vi.stubGlobal("fetch", fetchSpy as any);
  return { fetchSpy, compilePosts };
}

describe("View", () => {
  test("renders data supplied in the `data` search param", async () => {
    // The embed is loaded with ?data=... when there is no stored id (the MCP/preview path).
    // `apply` mutates an external store, so nothing re-renders unless the View makes it.
    setSearch(`?data=${encodeURIComponent(JSON.stringify({ title: "Preview", cells: { A1: "x" } }))}`);
    stubApi({ stored: {} });
    const View = await loadView();

    render(<Wrapper><View Form={CountingForm} /></Wrapper>);

    await waitFor(() => expect(screen.queryByTestId("form")).toBeTruthy());
    expect(lastData).toEqual({ title: "Preview", cells: { A1: "x" } });
  });

  test("an edit made while a compile is in flight is not erased by that compile", async () => {
    // THE REPORTED BUG. Edit A starts a compile. Edit B lands before it returns. The response
    // to A carries the pre-B data model, and applying it wholesale reverts B.
    setSearch("?id=abc123");
    stubApi({ stored: { cells: { A1: "1" } }, latency: 60 });
    const View = await loadView();

    render(<Wrapper><View Form={CountingForm} /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId("form")).toBeTruthy());
    await tick(50);

    await act(async () => { apply({ type: "update", args: { cells: { A1: "2" } } }); });
    await tick(10);
    await act(async () => { apply({ type: "update", args: { cells: { A1: "22" } } }); });
    await tick(300);

    expect(lastData.cells, "the learner's most recent edit was overwritten").toEqual({ A1: "22" });
  });

  test("re-entering a previous value does not replay a cached compile", async () => {
    // SWR keys the compile on the data itself, so returning a cell to a value it already held
    // hits a warm cache entry and applies a STALE compiled model during render.
    setSearch("?id=abc123");
    const { compilePosts } = stubApi({ stored: { cells: { A1: "1" }, n: 0 } });
    const View = await loadView();

    render(<Wrapper><View Form={CountingForm} /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId("form")).toBeTruthy());
    await tick(50);

    for (const v of ["2", "3", "2"]) {
      await act(async () => { apply({ type: "update", args: { cells: { A1: v } } }); });
      await tick(60);
    }

    expect(lastData.cells).toEqual({ A1: "2" });
    expect(compilePosts.length, "an edit was served from cache instead of recompiled").toBe(3);
  });

  test("settles after loading — it does not re-render forever", async () => {
    setSearch("?id=abc123");
    stubApi({ stored: { title: "Sheet" } });
    const View = await loadView();

    render(<Wrapper><View Form={CountingForm} /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId("form")).toBeTruthy());
    const settled = renders;
    await tick(150);

    expect(renders - settled, `re-rendered ${renders - settled} times after settling`).toBe(0);
  });

  test("a learner response is kept, not silently discarded", async () => {
    // `response` used to fall to the reducer's `default:` branch, which returns the model
    // unchanged — every answer typed into an L0166/L0179 sheet or an L0175 item was dropped.
    setSearch("?id=abc123");
    stubApi({ stored: { interaction: { cells: { A1: { text: "1" } } } } });
    const View = await loadView();

    render(<Wrapper><View Form={CountingForm} /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId("form")).toBeTruthy());
    await tick(50);

    await act(async () => { apply({ type: "response", args: { cells: { B3: { text: "60" } } } }); });
    await tick(80);

    expect(lastData.cells, "the learner's response was discarded").toEqual({ B3: { text: "60" } });
  });

  test("focus is tracked and does not trigger a recompile", async () => {
    setSearch("?id=abc123");
    const { compilePosts } = stubApi({ stored: { interaction: { cells: {} } } });
    const View = await loadView();

    render(<Wrapper><View Form={CountingForm} /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId("form")).toBeTruthy());
    await tick(50);

    await act(async () => { apply({ type: "focus", args: { type: "cell", name: "B3" } }); });
    await tick(80);

    expect(lastData.focus).toEqual({ type: "cell", name: "B3" });
    expect(compilePosts.length, "selecting a cell should not recompile").toBe(0);
  });

  test("a compile result MERGES over the model rather than replacing it", async () => {
    // Replacing discards client-side state, which is what made the whole sheet re-initialize
    // on every edit.
    setSearch("?id=abc123");
    stubApi({ stored: { interaction: { cells: {} }, title: "Sheet" } });
    const View = await loadView();

    render(<Wrapper><View Form={CountingForm} /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId("form")).toBeTruthy());
    await tick(50);

    await act(async () => { apply({ type: "focus", args: { type: "cell", name: "B3" } }); });
    await act(async () => { apply({ type: "update", args: { cells: { A1: "9" } } }); });
    await tick(120);

    expect(lastData.title).toBe("Sheet");
    expect(lastData.focus, "client-side focus was wiped by the compile response").toEqual({
      type: "cell",
      name: "B3",
    });
  });

  test("a language `reduce` claims actions and falls through for the rest", async () => {
    // L0179 needs `update` to merge cell text into interaction.cells rather than onto the top
    // level. Anything it does not claim must still get the generic behaviour.
    setSearch("?id=abc123");
    stubApi({ stored: { interaction: { cells: { A1: { text: "1", assess: { points: 2 } } } } } });
    const View = await loadView();

    const spreadsheetReduce = (data: any, { type, args }: { type: string; args?: any }) => {
      if (type !== "update" || !args?.cells || !data?.interaction) return undefined;
      const cells = Object.keys(args.cells).reduce(
        (acc: any, k: string) => ({ ...acc, [k]: { ...acc[k], ...args.cells[k] } }),
        data.interaction.cells || {},
      );
      return { ...data, interaction: { ...data.interaction, cells } };
    };

    render(<Wrapper><View Form={CountingForm} reduce={spreadsheetReduce} /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId("form")).toBeTruthy());
    await tick(50);

    await act(async () => { apply({ type: "update", args: { cells: { A1: { text: "7" } } } }); });
    await tick(120);

    // The claimed action merged INTO interaction.cells, preserving the cell's other props.
    expect(lastData.interaction.cells.A1).toEqual({ text: "7", assess: { points: 2 } });
    expect(lastData.cells, "the edit leaked to the top level").toBeUndefined();

    // An unclaimed action still gets generic handling.
    await act(async () => { apply({ type: "focus", args: { type: "cell", name: "A1" } }); });
    await tick(30);
    expect(lastData.focus).toEqual({ type: "cell", name: "A1" });
  });
});
