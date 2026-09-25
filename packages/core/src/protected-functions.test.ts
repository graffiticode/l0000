import { describe, test, expect, beforeEach } from "vitest";
import { parser } from "@graffiticode/parser";
import { Compiler, Checker, Transformer, Renderer, lexicon } from "@graffiticode/l0000";

// A toy language with one protected write and one protected read.
const lex = {
  ...lexicon,
  "save-it": { tk: 1, name: "SAVE_IT", cls: "function", length: 1, arity: 1 },
  "peek-it": { tk: 1, name: "PEEK_IT", cls: "function", length: 1, arity: 1 },
  "edit-it": { tk: 1, name: "EDIT_IT", cls: "function", length: 1, arity: 1 },
};
const protectedFunctions = {
  SAVE_IT: { fn: "save-it", kind: "write" as const },
  PEEK_IT: { fn: "peek-it", kind: "read" as const },
  // Like Author API signing: authority beyond an ordinary render.
  EDIT_IT: { fn: "edit-it", kind: "sign" as const, modes: ["author" as const] },
};

let calls: { fn: string; arg: any }[];
let transformerRuns: number;

class ToyTransformer extends Transformer {
  PROG(node, options, resume) {
    transformerRuns++;
    super.PROG(node, options, resume);
  }
  SAVE_IT(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      calls.push({ fn: "save-it", arg: v0 });
      resume([].concat(e0), { saved: v0 });
    });
  }
  EDIT_IT(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      calls.push({ fn: "edit-it", arg: v0 });
      resume([].concat(e0), { edited: v0 });
    });
  }
  PEEK_IT(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      calls.push({ fn: "peek-it", arg: v0 });
      resume([].concat(e0), { peeked: v0 });
    });
  }
}

function policyAllowing(allowed: string[]) {
  const policy = {
    requests: [] as any[],
    async getSnapshot(args) {
      policy.requests.push(args);
      return { allowed };
    },
  };
  return policy;
}

async function run(src: string, { mode = "save", allowed = [], policy = undefined, connectionId = "conn-1" }: any = {}) {
  const code = await parser.parse(0, src, lex);
  const compiler = new Compiler({
    langID: "9999",
    version: "v0",
    Checker,
    Transformer: ToyTransformer,
    Renderer,
    protectedFunctions,
    policy: policy ?? policyAllowing(allowed),
  });
  return new Promise<{ err: any[]; val: any }>((resolve) =>
    compiler.compile(code, {}, {}, (err, val) => resolve({ err: err ?? [], val }), {
      uid: "u1",
      connectionId,
      mode,
    }),
  );
}

beforeEach(() => {
  calls = [];
  transformerRuns = 0;
});

// Every placement a protected call can take in source.
const PLACEMENTS = [
  ["direct", "save-it 1.."],
  ["parenthesized", "(save-it 1).."],
  ["if branch", "if true then save-it 1 else 2.."],
  ["untaken branch", "if false then save-it 1 else 2.."],
  ["map lambda", "map (<x: save-it x>) [1 2].."],
  ["reduce lambda", "reduce (<x acc: save-it x>) 0 [1 2].."],
  ["let binding / first-class", "let f = save-it..f 1.."],
];

describe("save mode", () => {
  test.each(PLACEMENTS)("ungranted protected call (%s) is refused before transformation", async (_, src) => {
    const { err } = await run(src, { mode: "save", allowed: [] });
    expect(err.length).toBeGreaterThan(0);
    expect(err[0].message).toMatch(/save-it is not permitted/);
    expect(transformerRuns).toBe(0);
    expect(calls).toEqual([]);
  });

  test("a granted write runs", async () => {
    const { err, val } = await run("save-it 1..", { mode: "save", allowed: ["save-it"] });
    expect(err).toEqual([]);
    expect(val).toEqual({ saved: 1 });
    expect(calls).toEqual([{ fn: "save-it", arg: 1 }]);
  });

  test("a granted write inside a lambda runs once per element", async () => {
    const { err } = await run("map (<x: save-it x>) [1 2]..", { mode: "save", allowed: ["save-it"] });
    expect(err).toEqual([]);
    expect(calls.map((c) => c.arg)).toEqual([1, 2]);
  });

  test("one ungranted call refuses the whole program, even after granted ones", async () => {
    const { err } = await run("[peek-it 1 save-it 2]..", { mode: "save", allowed: ["peek-it"] });
    expect(err.map((e) => e.message)).toEqual(["save-it is not permitted through the selected connection."]);
    expect(transformerRuns).toBe(0);
    expect(calls).toEqual([]);
  });

  test("the error points at the call", async () => {
    const { err } = await run("[1 save-it 2]..", { mode: "save" });
    expect(err[0].message).toMatch(/save-it is not permitted/);
    expect(err[0].from).toBeGreaterThan(0);
    expect(err[0].to).toBeGreaterThan(err[0].from);
  });
});

describe("non-save modes", () => {
  test.each(["read", "render", "verify", "corpus"])("a write in %s mode yields the sentinel and never runs", async (mode) => {
    const { err, val } = await run("save-it 1..", { mode, allowed: ["save-it"] });
    expect(err).toEqual([]);
    expect(val).toEqual({ skipped: "write-disabled", fn: "save-it" });
    expect(calls).toEqual([]);
  });

  test.each(PLACEMENTS)("a write (%s) never runs in read mode", async (_, src) => {
    const { err } = await run(src, { mode: "read", allowed: [] });
    expect(err).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("a disabled write does not evaluate its arguments", async () => {
    const { err, val } = await run("save-it (peek-it 1)..", { mode: "read", allowed: ["peek-it"] });
    expect(err).toEqual([]);
    expect(val).toEqual({ skipped: "write-disabled", fn: "save-it" });
    expect(calls).toEqual([]);
  });

  test("a write never consults policy in read mode", async () => {
    const policy = policyAllowing(["save-it"]);
    await run("save-it 1..", { mode: "read", policy });
    expect(policy.requests).toEqual([]);
  });

  test("an ungranted read is still refused", async () => {
    const { err } = await run("peek-it 1..", { mode: "read", allowed: [] });
    expect(err[0].message).toMatch(/peek-it is not permitted/);
    expect(transformerRuns).toBe(0);
  });

  test("a granted read runs", async () => {
    const { err, val } = await run("peek-it 1..", { mode: "read", allowed: ["peek-it"] });
    expect(err).toEqual([]);
    expect(val).toEqual({ peeked: 1 });
  });

  test("an unspecified mode is read", async () => {
    const code = await parser.parse(0, "save-it 1..", lex);
    const compiler = new Compiler({
      langID: "9999",
      Checker,
      Transformer: ToyTransformer,
      Renderer,
      protectedFunctions,
      policy: policyAllowing(["save-it"]),
    });
    const val = await new Promise((resolve) => compiler.compile(code, {}, {}, (_e, v) => resolve(v), { uid: "u1", connectionId: "c" }));
    expect(val).toEqual({ skipped: "write-disabled", fn: "save-it" });
    expect(calls).toEqual([]);
  });
});

describe("policy snapshot", () => {
  test("is fetched once per compile with the protected functions it needs", async () => {
    const policy = policyAllowing(["peek-it"]);
    await run("[peek-it 1 peek-it 2 map (<x: peek-it x>) [3]]..", { mode: "read", policy });
    expect(policy.requests).toHaveLength(1);
    expect(policy.requests[0].fns).toEqual(["peek-it"]);
    expect(policy.requests[0].langID).toBe("9999");
    expect(policy.requests[0].exec.uid).toBe("u1");
    expect(policy.requests[0].exec.connectionId).toBe("conn-1");
  });

  test("is not fetched for a program with no protected calls", async () => {
    const policy = policyAllowing([]);
    const { err, val } = await run("add 1 2..", { policy });
    expect(err).toEqual([]);
    expect(val).toBe(3);
    expect(policy.requests).toEqual([]);
  });

  test("fails closed when the policy fetch fails", async () => {
    const policy = {
      async getSnapshot() {
        throw new Error("down");
      },
    };
    const { err } = await run("peek-it 1..", { mode: "read", policy });
    expect(err[0].message).toMatch(/unavailable/);
    expect(transformerRuns).toBe(0);
  });

  test("without a selected connection nothing is allowed and policy is not asked", async () => {
    const policy = policyAllowing(["peek-it"]);
    const { err } = await run("peek-it 1..", { mode: "read", policy, connectionId: null });
    expect(err[0].message).toMatch(/requires a connection/);
    expect(policy.requests).toEqual([]);
  });

  test("a malformed snapshot allows nothing", async () => {
    const policy = {
      async getSnapshot() {
        return { allowed: "peek-it" } as any;
      },
    };
    const { err } = await run("peek-it 1..", { mode: "read", policy });
    expect(err[0].message).toMatch(/not permitted/);
  });
});

describe("malformed snapshots allow nothing", () => {
  test.each([
    ["a valid name next to a non-string", { allowed: ["peek-it", 123] }],
    ["a valid name next to an empty string", { allowed: ["peek-it", ""] }],
    ["allowed as an object", { allowed: { 0: "peek-it" } }],
    ["no allowed field", {}],
    ["an array response", ["peek-it"]],
    ["null", null],
  ])("%s", async (_, response) => {
    const policy = {
      async getSnapshot() {
        return response as any;
      },
    };
    const { err } = await run("peek-it 1..", { mode: "read", policy });
    expect(err[0].message).toMatch(/peek-it is not permitted/);
    expect(transformerRuns).toBe(0);
  });
});

describe("implicit protected functions", () => {
  async function runImplicit(src, { implicit, allowed = [], mode = "read" }: any) {
    const code = await parser.parse(0, src, lex);
    const policy = policyAllowing(allowed);
    const compiler = new Compiler({
      langID: "9999",
      Checker,
      Transformer: ToyTransformer,
      Renderer,
      protectedFunctions,
      implicitProtectedFunctions: implicit,
      policy,
    });
    const result = await new Promise<{ err: any[]; val: any }>((resolve) =>
      compiler.compile(code, {}, {}, (err, val) => resolve({ err: err ?? [], val }), { uid: "u1", connectionId: "c", mode }),
    );
    return { ...result, policy };
  }

  test("are required even when no protected call appears in the source", async () => {
    const { err, policy } = await runImplicit("add 1 2..", { implicit: [{ fn: "peek-it", kind: "sign" }] });
    expect(err[0].message).toMatch(/peek-it is not permitted/);
    expect(err[0].from).toBe(-1);
    expect(policy.requests[0].fns).toEqual(["peek-it"]);
    expect(transformerRuns).toBe(0);
  });

  test("run when granted", async () => {
    const { err, val } = await runImplicit("add 1 2..", { implicit: [{ fn: "peek-it", kind: "sign" }], allowed: ["peek-it"] });
    expect(err).toEqual([]);
    expect(val).toBe(3);
  });

  test("share one snapshot with explicit calls", async () => {
    const { err, policy } = await runImplicit("save-it 1..", {
      implicit: [{ fn: "peek-it", kind: "sign" }],
      allowed: ["peek-it", "save-it"],
      mode: "save",
    });
    expect(err).toEqual([]);
    expect(policy.requests).toHaveLength(1);
    expect(policy.requests[0].fns.sort()).toEqual(["peek-it", "save-it"]);
  });

  test("cannot be writes", async () => {
    const { err } = await runImplicit("add 1 2..", { implicit: [{ fn: "save-it", kind: "write" }], allowed: ["save-it"], mode: "save" });
    expect(err[0].message).toMatch(/cannot be a write/);
    expect(transformerRuns).toBe(0);
  });
});

describe("mode-restricted functions", () => {
  test.each(["save", "read", "render", "verify", "corpus"])("are disabled in %s mode without consulting policy", async (mode) => {
    // The nested read is still admitted (the scan is conservative); the
    // disabled function is never asked about and its argument never runs.
    const policy = policyAllowing(["edit-it", "peek-it"]);
    const { err, val } = await run("edit-it (peek-it 1)..", { mode, policy });
    expect(err).toEqual([]);
    expect(val).toEqual({ skipped: "mode-disabled", fn: "edit-it" });
    expect(calls).toEqual([]);
    expect(policy.requests.map((r) => r.fns)).toEqual([["peek-it"]]);
  });

  test("run in their mode when granted", async () => {
    const { err, val } = await run("edit-it 1..", { mode: "author", allowed: ["edit-it"] });
    expect(err).toEqual([]);
    expect(val).toEqual({ edited: 1 });
  });

  test("are refused in their mode without a grant", async () => {
    const { err } = await run("edit-it 1..", { mode: "author", allowed: [] });
    expect(err[0].message).toMatch(/edit-it is not permitted/);
    expect(transformerRuns).toBe(0);
  });

  test("writes are disabled in author mode", async () => {
    const { err, val } = await run("save-it 1..", { mode: "author", allowed: ["save-it"] });
    expect(err).toEqual([]);
    expect(val).toEqual({ skipped: "write-disabled", fn: "save-it" });
    expect(calls).toEqual([]);
  });

  test("a write declared runnable outside save mode is a language bug", async () => {
    const code = await parser.parse(0, "save-it 1..", lex);
    const compiler = new Compiler({
      langID: "9999",
      Checker,
      Transformer: ToyTransformer,
      Renderer,
      protectedFunctions: { SAVE_IT: { fn: "save-it", kind: "write", modes: ["save", "read"] } },
      policy: policyAllowing(["save-it"]),
    });
    const { err } = await new Promise<any>((resolve) =>
      compiler.compile(code, {}, {}, (e, v) => resolve({ err: e ?? [], val: v }), { uid: "u1", connectionId: "c", mode: "read" }),
    );
    expect(err[0].message).toMatch(/may only run in save mode/);
    expect(calls).toEqual([]);
  });
});

describe("languages without protected functions", () => {
  test("compile exactly as before", async () => {
    const code = await parser.parse(0, "add 1 2..", lexicon);
    const compiler = new Compiler({ langID: "0", Checker, Transformer, Renderer });
    const val = await new Promise((resolve) => compiler.compile(code, {}, {}, (_e, v) => resolve(v)));
    expect(val).toBe(3);
  });
});
