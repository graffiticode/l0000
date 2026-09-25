// SPDX-License-Identifier: MIT
//
// ExecContext is the per-invocation authorization context: who is compiling, in
// what mode, through which connection, and (later) the policy snapshot and
// clients used to reach the credential broker.
//
// Two invariants make it a security boundary rather than a convenience:
//
// 1. It never lives in `options`/`config`. Programs read and write `options`
//    through GET_VAR/SET_VAR, so anything placed there is program-visible and
//    program-writable.
// 2. It belongs to one invocation, never to a Compiler. Language servers reuse a
//    singleton Compiler across concurrent requests (L0176 exports one), so state
//    on the Compiler would mix users. Each compile() allocates a fresh context and
//    binds it to that invocation's Checker and Transformer instances, which are
//    themselves created per compile.

import { randomUUID } from "crypto";

export type ExecMode = "save" | "read" | "render" | "verify" | "corpus";

const EXEC_MODES: readonly ExecMode[] = ["save", "read", "render", "verify", "corpus"];

export interface ExecIdentity {
  uid?: string | null;
  connectionId?: string | null;
  mode?: ExecMode;
}

export class ExecContext {
  readonly uid: string | null;
  readonly connectionId: string | null;
  readonly mode: ExecMode;
  readonly invocationId: string;
  #snapshot: unknown = undefined;

  constructor(identity: ExecIdentity = {}) {
    this.uid = typeof identity.uid === "string" && identity.uid ? identity.uid : null;
    this.connectionId =
      typeof identity.connectionId === "string" && identity.connectionId ? identity.connectionId : null;
    // Least privilege by default: only an authenticated entry point that means to
    // save may say so. An unknown mode is a caller bug, not a request to save.
    this.mode = identity.mode && EXEC_MODES.includes(identity.mode) ? identity.mode : "read";
    this.invocationId = randomUUID();
    Object.freeze(this);
  }

  // The policy snapshot is fetched once per compile and is immutable for the
  // rest of that compile.
  get snapshot(): unknown {
    return this.#snapshot;
  }

  setSnapshot(snapshot: unknown): void {
    if (this.#snapshot !== undefined) {
      throw new Error("ExecContext snapshot is already set for this invocation");
    }
    this.#snapshot = snapshot;
  }
}

// Keyed by the per-compile Checker/Transformer instance. A WeakMap (rather than
// a property) keeps the context off the visitor's own keys, so AST dispatch by
// node tag (`this[node.tag]`) can never reach it.
const contexts = new WeakMap<object, ExecContext>();

export function bindExecContext(visitor: object, ctx: ExecContext): void {
  if (contexts.has(visitor)) {
    throw new Error("ExecContext is already bound to this visitor");
  }
  contexts.set(visitor, ctx);
}

export function execContextOf(visitor: object): ExecContext | undefined {
  return contexts.get(visitor);
}
