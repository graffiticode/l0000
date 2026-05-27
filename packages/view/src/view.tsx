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
import type { ComponentType } from "react";
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
    doGetData && accessToken && id ? { accessToken, id } : null,
    getData,
  );
  if (getDataResp.data !== undefined) {
    const env = asEnvelope(getDataResp.data);
    state.apply({ type: "compiled", args: env.data });
    setErrors(env.errors);
    setDoGetData(false);
  }

  const compileResp = useSWR(
    doCompile && accessToken && id ? { accessToken, id, data: state.data } : null,
    compile,
  );
  if (compileResp.data !== undefined) {
    const env = asEnvelope(compileResp.data);
    state.apply({ type: "compiled", args: env.data });
    setErrors(env.errors);
    setDoCompile(false);
  }

  const formState = { data: state.data, errors, apply: state.apply };
  return hasRenderable(state.data, errors) ? <Form state={formState} /> : <div />;
};
