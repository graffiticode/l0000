// SPDX-License-Identifier: MIT
//
// View is the SHARED, inherited front-end harness. It manages form state, drives
// compile/getData via SWR, reads its inputs from the URL search params, and posts state
// to the host via window.parent.postMessage — so it works both embedded in an iframe and
// standalone. It is parameterized by the language-specific `Form`: child languages import
// this `View` and inject their own `Form` (the only language-specific UX). L0000 ships the
// base `Form` (JSON), so its own embed mounts `<View Form={Form} />`.
//
// Compile/getData responses use the envelope `{ data, errors }`: successful output in
// `data`, compile errors in `errors`. The View stores `data` as the form's data model
// (so recompiles operate on real data, not the envelope) and threads `errors` to the Form
// alongside it.
import { useEffect, useState } from "react";
import type { ComponentType, CSSProperties } from "react";
import useSWR from "swr";
import { createState } from "./state";
import { compile, getData } from "./swr/fetchers";
import "./index.css";

export interface CompileError {
  message: string;
  from?: number;
  to?: number;
}

export interface FormProps {
  state: {
    data: any;
    errors: CompileError[];
    apply: (action: { type: string; args?: any }) => void;
  };
}

export type FormComponent = ComponentType<FormProps>;

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

export const View = ({ Form }: { Form: FormComponent }) => {
  const params = new URLSearchParams(window.location.search);
  const [id] = useState<string | undefined>(params.get("id") ?? undefined);
  const [accessToken] = useState<string | undefined>(params.get("access_token") ?? undefined);
  const [targetOrigin] = useState<string | undefined>(params.get("origin") ?? undefined);
  const [doGetData, setDoGetData] = useState(false);
  const [doCompile, setDoCompile] = useState(false);
  const [errors, setErrors] = useState<CompileError[]>([]);

  const [state] = useState(() =>
    createState<any>({}, (data, { type, args }) => {
      console.log(
        "L0000 View()",
        "type=" + type,
        "args=" + JSON.stringify(args, null, 2),
      );
      switch (type) {
        case "init":
          return args;
        case "compiled":
          // The compiled result is the new data model (may be a scalar, list, or record).
          return args;
        case "update": {
          const merged = { ...data, ...args };
          if (JSON.stringify(merged) !== JSON.stringify(data)) {
            setDoCompile(true);
            if (targetOrigin) {
              window.parent.postMessage({ focus: { type: "update", value: merged } }, targetOrigin);
            }
          }
          return merged;
        }
        default:
          console.error(`Unimplemented action type: ${type}`);
          return data;
      }
    }),
  );

  // Initialize from a `data` search param on first load.
  useEffect(() => {
    const data = params.get("data");
    if (data) {
      state.apply({ type: "init", args: JSON.parse(data) });
    }
  }, []);

  // Announce load to the host.
  useEffect(() => {
    if (targetOrigin) {
      window.parent.postMessage({ type: "onload", data: state.data }, targetOrigin);
    }
  }, []);

  // Fetch stored data when an id is present.
  useEffect(() => {
    if (id) setDoGetData(true);
  }, [id]);

  // Post state to the host whenever it changes.
  useEffect(() => {
    if (targetOrigin) {
      window.parent.postMessage({ type: "data-updated", data: state.data }, targetOrigin);
    }
  }, [JSON.stringify(state.data)]);

  const getDataResp = useSWR(
    doGetData && id ? { accessToken, id } : null,
    getData,
  );
  if (getDataResp.data !== undefined) {
    const env = asEnvelope(getDataResp.data);
    state.apply({ type: "compiled", args: env.data });
    setErrors(env.errors);
    setDoGetData(false);
  }

  const compileResp = useSWR(
    doCompile && id ? { accessToken, id, data: state.data } : null,
    compile,
  );
  if (compileResp.data !== undefined) {
    const env = asEnvelope(compileResp.data);
    state.apply({ type: "compiled", args: env.data });
    setErrors(env.errors);
    setDoCompile(false);
  }

  const formState = { data: state.data, errors, apply: state.apply };

  // Render priority: real content first; otherwise surface why there's none.
  // A getData failure (e.g. a stale/expired token 401ing a public read) used to
  // fall through to a blank `<div/>` with no console output — indistinguishable
  // from "still loading" and impossible to diagnose. Show the error (and a
  // retry) instead. Once data has loaded, a later revalidation error is ignored
  // so the form isn't replaced by an error screen.
  if (hasRenderable(state.data, errors)) {
    return <Form state={formState} />;
  }
  if (getDataResp.error) {
    return (
      <div role="alert" style={MESSAGE_STYLE}>
        <p style={{ margin: 0, fontWeight: 600 }}>Couldn’t load this form.</p>
        <p style={{ margin: "4px 0 12px", color: "#555" }}>
          {String((getDataResp.error as { message?: string })?.message ?? getDataResp.error)}
        </p>
        <button type="button" style={RETRY_STYLE} onClick={() => getDataResp.mutate()}>
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
