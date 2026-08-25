// SPDX-License-Identifier: MIT
//
// View is the SHARED, inherited front-end harness. It manages form state, drives
// compile/getData, reads its inputs from the URL search params, and posts state to the host
// via window.parent.postMessage — so it works both embedded in an iframe and standalone. It
// is parameterized by the language-specific `Form`: child languages import this `View` and
// inject their own `Form` (the only language-specific UX). L0000 ships the base `Form` (JSON),
// so its own embed mounts `<View Form={Form} />`.
//
// Compile/getData responses use the envelope `{ data, errors }`: successful output in `data`,
// compile errors in `errors`. The View stores `data` as the form's data model (so recompiles
// operate on real data, not the envelope) and threads `errors` to the Form alongside it.
//
// ── State ──────────────────────────────────────────────────────────────────────────────────
//
// The data model lives in React state and every `apply` re-renders. It used to live in an
// EXTERNAL mutable store (`createState`) that React did not track, which meant a form seeded
// from the `?data=` search param never appeared at all: the seed mutated the store from an
// effect, nothing re-rendered, and the harness kept showing the empty `<div/>` it had already
// committed. Keep state here, and keep the reducer PURE — it is re-run under StrictMode.
//
// ── The action protocol ────────────────────────────────────────────────────────────────────
//
// `init`      replace the model (a fresh load)
// `compiled`  MERGE the compile result over the model. It must not replace: a compile response
//             carries only what the compiler produced, so replacing discards client-side state
//             (focus, in-progress entries) and re-initializes the whole form on every edit.
// `update`    a user edit; merges, and requests a recompile
// `response`  a learner's answer; merges, and requests a recompile
// `focus`     selection tracking; merges under `focus` and does NOT recompile
//
// `loaded`   the stored model arriving from getData. Merges exactly like `compiled`; it is a
//            separate type only so the harness can tell an EXTERNAL load from the echo of an
//            edit the Form itself just reported (see `formModel` below).
//
// `response` and `focus` were previously unhandled, so they fell to the `default:` branch and
// returned the model UNCHANGED — silently discarding every answer a learner typed into an
// L0166/L0179 spreadsheet and every response an L0175 item collected.
//
// ── formModel: which model the Form is rendered from ───────────────────────────────────────
//
// A CONTROLLED Form (the default, `formModel: "live"`) renders whatever the model currently
// says, so it must see every change — including its own edits coming back.
//
// An UNCONTROLLED Form owns its own editing state and only SEEDS from the model. L0166's
// spreadsheet Form — which L0179 injects — is one: its TableEditor builds a ProseMirror
// document from `interaction.cells` and, whenever that object's IDENTITY changes, rebuilds the
// whole document and puts the caret back in A1. Feeding such a Form its own reported edits
// re-seeds it on every keystroke commit: the grid visibly redraws and the selection jumps.
//
// L0166 never hits this because its state lives in an untracked closure that re-renders
// nothing — the editor is seeded once and left alone. `formModel: "loaded"` makes that
// deliberate rather than accidental: the Form renders from the model as last loaded from
// OUTSIDE it (`init`, `loaded`), while `update`/`response` and the compile results they
// trigger keep updating the live model for postMessage, recompiles, and reporting.
//
// A language whose Form needs different semantics for one of these passes `reduce`. It is
// consulted FIRST and returns `undefined` for anything it does not claim, so a language adds
// cases without restating the generic ones. This exists because L0179 injects L0166's
// spreadsheet Form, whose `update` must merge cell text into `data.interaction.cells` rather
// than onto the top level — a shape that has no business being hardcoded here.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ComponentType, CSSProperties } from "react";
import useSWR from "swr";
import { compile, getData } from "./swr/fetchers";
import "./index.css";

export interface CompileError {
  message: string;
  from?: number;
  to?: number;
}

export interface StateAction {
  type: string;
  args?: any;
}

/**
 * A language's extra reducer cases. Return the next data model to claim an action, or
 * `undefined` to fall through to the generic handling below.
 */
export type LanguageReducer = (data: any, action: StateAction) => any | undefined;

export interface FormProps {
  state: {
    data: any;
    errors: CompileError[];
    apply: (action: StateAction) => void;
  };
}

export type FormComponent = ComponentType<FormProps>;

/**
 * Which model the Form renders from.
 *
 * `live`   — everything, including the Form's own edits coming back (a controlled Form).
 * `loaded` — only the model as last loaded from outside the Form (an uncontrolled Form that
 *            seeds itself from the model and owns its editing state thereafter).
 */
export type FormModel = "live" | "loaded";

/** Actions that represent a user changing the form, and so warrant a recompile. */
const RECOMPILE_ON = new Set(["update", "response"]);

/**
 * Actions that carry a model from OUTSIDE the Form, and so may re-seed an uncontrolled one.
 * `compiled` is absent deliberately: after the initial load every compile is a response to an
 * edit the Form itself reported, and re-seeding from it is the flash this exists to stop.
 */
const EXTERNAL_LOAD = new Set(["init", "loaded"]);

// Normalize a response into the { data, errors } envelope. Accepts a bare value (treated
// as data with no errors) for backward/forward compatibility.
function asEnvelope(payload: any): { data: any; errors: CompileError[] } {
  if (payload && typeof payload === "object" && Array.isArray(payload.errors)) {
    return { data: payload.data ?? null, errors: payload.errors };
  }
  return { data: payload, errors: [] };
}

function hasRenderable(data: any, errors: CompileError[]): boolean {
  if (errors.length > 0) return true;
  if (data === undefined || data === null) return false;
  if (typeof data === "object" && !Array.isArray(data) && Object.keys(data).length === 0) {
    return false;
  }
  return true;
}

function baseReduce(data: any, { type, args }: StateAction): any {
  switch (type) {
    case "init":
      return { ...args };
    case "compiled":
    case "loaded":
    case "update":
    case "response":
      return { ...data, ...args };
    case "focus":
      return { ...data, focus: args };
    default:
      console.error(`Unimplemented action type: ${type}`);
      return data;
  }
}

interface ViewState {
  data: any;
  /**
   * What the Form is rendered from. Under `formModel: "live"` it is always `data`; under
   * `"loaded"` its IDENTITY only changes on an external load, which is what keeps an
   * uncontrolled Form from re-seeding itself on its own edits.
   */
  renderData: any;
  /** Bumped by each user edit. The compile effect keys off it, never off `data` itself. */
  compileSeq: number;
}

const makeReducer =
  (reduce: LanguageReducer | undefined, formModel: FormModel) =>
  (prev: ViewState, action: StateAction): ViewState => {
    const claimed = reduce ? reduce(prev.data, action) : undefined;
    const data = claimed !== undefined ? claimed : baseReduce(prev.data, action);
    if (data === prev.data || JSON.stringify(data) === JSON.stringify(prev.data)) {
      return prev;
    }
    return {
      data,
      renderData:
        formModel === "live" || EXTERNAL_LOAD.has(action.type) ? data : prev.renderData,
      compileSeq: prev.compileSeq + (RECOMPILE_ON.has(action.type) ? 1 : 0),
    };
  };

export const View = ({
  Form,
  reduce,
  formModel = "live",
}: {
  Form: FormComponent;
  reduce?: LanguageReducer;
  formModel?: FormModel;
}) => {
  const [params] = useState(() => new URLSearchParams(window.location.search));
  const [id] = useState<string | undefined>(params.get("id") ?? undefined);
  const [accessToken] = useState<string | undefined>(params.get("access_token") ?? undefined);
  const [targetOrigin] = useState<string | undefined>(params.get("origin") ?? undefined);
  const [errors, setErrors] = useState<CompileError[]>([]);

  const reducer = useMemo(() => makeReducer(reduce, formModel), [reduce, formModel]);
  const [state, apply] = useReducer(reducer, undefined, () => ({
    data: {},
    renderData: {},
    compileSeq: 0,
  }));
  const { data, renderData, compileSeq } = state;

  // Initialize from a `data` search param on first load.
  useEffect(() => {
    const seed = params.get("data");
    if (seed) apply({ type: "init", args: JSON.parse(seed) });
  }, []);

  // Announce load to the host.
  useEffect(() => {
    if (targetOrigin) {
      window.parent.postMessage({ type: "onload", data }, targetOrigin);
    }
  }, []);

  // Post state to the host whenever it changes.
  useEffect(() => {
    if (targetOrigin) {
      window.parent.postMessage({ type: "data-updated", data }, targetOrigin);
    }
  }, [JSON.stringify(data)]);

  // Fetch stored data when an id is present.
  //
  // Revalidation is off: this is a one-shot load, and a background refetch on window focus
  // would re-apply the STORED model over whatever the learner has since entered — the form
  // silently reverting when you tab away and back.
  const getDataResp = useSWR(id ? { accessToken, id } : null, getData, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
  });

  // Apply the loaded data in an EFFECT. Applying it during render (as this used to) both
  // mutated state mid-render and re-ran on every subsequent render, because the SWR result
  // stays populated — the old code only escaped that loop by flipping its own fetch key to
  // null, which is what let a warm cache entry re-apply a stale model later.
  useEffect(() => {
    if (getDataResp.data === undefined) return;
    const env = asEnvelope(getDataResp.data);
    apply({ type: "loaded", args: env.data });
    setErrors(env.errors);
  }, [getDataResp.data]);

  // Recompile after a user edit.
  //
  // Deliberately NOT SWR: a compile is a mutation, not a cacheable query. Keying it on the
  // data (as this used to) meant returning a cell to a value it already held replayed an
  // OLDER compiled snapshot straight out of the cache, reverting the sheet. A bare request
  // with last-write-wins ordering has no cache to go stale.
  const latestCompile = useRef(0);
  useEffect(() => {
    if (compileSeq === 0 || !id) return;
    const seq = ++latestCompile.current;
    if (targetOrigin) {
      window.parent.postMessage({ focus: { type: "update", value: data } }, targetOrigin);
    }
    let cancelled = false;
    (async () => {
      try {
        const out = await compile({ accessToken, id, data });
        // Drop a response that a newer edit has already superseded, so a slow compile can
        // never overwrite a faster one that started later.
        if (cancelled || seq !== latestCompile.current) return;
        const env = asEnvelope(out);
        apply({ type: "compiled", args: env.data });
        setErrors(env.errors);
      } catch (err: any) {
        if (!cancelled && seq === latestCompile.current) {
          setErrors([{ message: String(err?.message ?? err) }]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compileSeq]);

  // The Form sees `renderData`; everything else here (postMessage, recompiles) uses the live
  // `data`. They are the same object unless the language asked for `formModel: "loaded"`, and
  // the fallback covers the one case where they can disagree about EXISTENCE rather than
  // content: a model that arrived without ever passing through an external load.
  const formData = hasRenderable(renderData, []) ? renderData : data;
  const formState = useMemo(() => ({ data: formData, errors, apply }), [formData, errors]);

  // Render priority: real content first; otherwise surface why there's none.
  // A getData failure (e.g. a stale/expired token 401ing a public read) used to
  // fall through to a blank `<div/>` with no console output — indistinguishable
  // from "still loading" and impossible to diagnose. Show the error (and a
  // retry) instead. Once data has loaded, a later revalidation error is ignored
  // so the form isn't replaced by an error screen.
  const retry = useCallback(() => getDataResp.mutate(), [getDataResp]);

  if (hasRenderable(data, errors)) {
    return <Form state={formState} />;
  }
  if (getDataResp.error) {
    return (
      <div role="alert" style={MESSAGE_STYLE}>
        <p style={{ margin: 0, fontWeight: 600 }}>Couldn’t load this form.</p>
        <p style={{ margin: "4px 0 12px", color: "#555" }}>
          {String((getDataResp.error as { message?: string })?.message ?? getDataResp.error)}
        </p>
        <button type="button" style={RETRY_STYLE} onClick={retry}>
          Retry
        </button>
      </div>
    );
  }
  if (getDataResp.isLoading) {
    return (
      <div role="status" aria-live="polite" style={MESSAGE_STYLE}>
        Loading…
      </div>
    );
  }
  return <div />;
};

const MESSAGE_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  padding: "24px",
  textAlign: "center",
  font: "14px/1.4 system-ui, sans-serif",
};

const RETRY_STYLE: CSSProperties = {
  padding: "6px 14px",
  border: "1px solid #888",
  borderRadius: "4px",
  background: "#fff",
  cursor: "pointer",
};
