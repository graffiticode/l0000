// SPDX-License-Identifier: MIT
//
// Admission of protected functions: the checker-side half of delegated API
// permissions. A protected function is one whose evaluation exercises an
// external API through a connection (see docs/graffiticode_capability_policy_spec.md
// in the console repo). The broker enforces authority at the call; this pass
// gives early rejection so the transformer never begins a program it would have
// to abandon halfway, after earlier external calls had already happened.
//
// Coverage comes from scanning EVERY node in the pool by tag, not from walking
// the tree through checker methods. The parser lowers every call of a lexicon
// function — top level, parenthesized, under a branch, inside a lambda, bound by
// `let` — to a node carrying that function's tag, and the transformer only
// dispatches on pool tags. So the scan cannot miss a node the transformer could
// execute, and no language's Checker override can skip it. It is conservative:
// a protected call in dead code is still admitted or refused.

import type { ExecContext } from "./exec-context.js";

export type ProtectedFunctionKind = "read" | "write" | "sign";

export interface ProtectedFunctionSpec {
  // The permission key: the stable function name a grant names.
  fn: string;
  kind: ProtectedFunctionKind;
}

// Keyed by node tag (the lexicon entry's `name`).
export type ProtectedFunctions = Record<string, ProtectedFunctionSpec>;

export interface PolicySnapshot {
  // Function names this invocation may call through its connection.
  allowed: string[];
}

export interface PolicyClient {
  getSnapshot(args: { exec: ExecContext; langID: string; fns: string[] }): Promise<PolicySnapshot>;
}

export interface AdmissionError {
  message: string;
  from: number;
  to: number;
}

function errorAt(message: string, node: any): AdmissionError {
  return { message, from: node?.coord?.from ?? -1, to: node?.coord?.to ?? -1 };
}

export function findProtectedNodes(nodePool: any, protectedFunctions: ProtectedFunctions) {
  const found: { node: any; spec: ProtectedFunctionSpec }[] = [];
  if (!nodePool || !protectedFunctions) {
    return found;
  }
  for (const key of Object.keys(nodePool)) {
    if (key === "root") continue;
    const node = nodePool[key];
    const tag = node?.tag;
    if (typeof tag === "string" && Object.prototype.hasOwnProperty.call(protectedFunctions, tag)) {
      found.push({ node, spec: protectedFunctions[tag] });
    }
  }
  return found;
}

// Decides every protected node before transformation:
// - a write in a non-save invocation is DISABLED: it will evaluate to a
//   sentinel without evaluating its arguments (which could themselves call
//   protected functions), and it will never mint a write token;
// - otherwise, a function missing from the policy snapshot is an error.
// The snapshot is fetched once, only when protected nodes exist, and fails
// closed: no policy client, or a failed fetch, means nothing is allowed.
export async function admitProtectedFunctions({
  nodePool,
  protectedFunctions,
  exec,
  langID,
  policy,
}: {
  nodePool: any;
  protectedFunctions: ProtectedFunctions;
  exec: ExecContext;
  langID: string;
  policy?: PolicyClient;
}): Promise<AdmissionError[]> {
  const found = findProtectedNodes(nodePool, protectedFunctions);
  if (found.length === 0) {
    return [];
  }
  const needsPolicy = found.filter(({ spec }) => !(spec.kind === "write" && exec.mode !== "save"));
  let allowed = new Set<string>();
  if (needsPolicy.length > 0) {
    const fns = [...new Set(needsPolicy.map(({ spec }) => spec.fn))];
    let snapshot: PolicySnapshot = { allowed: [] };
    if (policy && exec.uid && exec.connectionId) {
      try {
        snapshot = await policy.getSnapshot({ exec, langID, fns });
      } catch {
        return [errorAt("Permission check is unavailable; protected functions cannot run.", null)];
      }
    }
    const list = Array.isArray(snapshot?.allowed) ? snapshot.allowed.filter((f) => typeof f === "string") : [];
    exec.setSnapshot(Object.freeze({ allowed: Object.freeze([...list]) }));
    allowed = new Set(list);
  }
  const errors: AdmissionError[] = [];
  for (const { node, spec } of found) {
    if (spec.kind === "write" && exec.mode !== "save") {
      exec.disable(node, spec.fn);
    } else if (!allowed.has(spec.fn)) {
      errors.push(
        errorAt(
          exec.connectionId
            ? `${spec.fn} is not permitted through the selected connection.`
            : `${spec.fn} requires a connection that permits it.`,
          node,
        ),
      );
    }
  }
  return errors;
}
