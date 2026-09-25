import { describe, test, expect, beforeEach } from "vitest";
import { parser } from "@graffiticode/parser";
import { Compiler, Checker, Transformer, Renderer, lexicon } from "@graffiticode/l0000";

// A toy language with one protected write and one protected read.
const lex = {
  ...lexicon,
  "save-it": { tk: 1, name: "SAVE_IT", cls: "function", length: 1, arity: 1 },
  "peek-it": { tk: 1, name: "PEEK_IT", cls: "function", length: 1, arity: 1 },
};
const protectedFunctions = {
  SAVE_IT: { fn: "save-it", kind: "write" as const },
  PEEK_IT: { fn: "peek-it", kind: "read" as const },
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

describe("languages without protected functions", () => {
  test("compile exactly as before", async () => {
    const code = await parser.parse(0, "add 1 2..", lexicon);
    const compiler = new Compiler({ langID: "0", Checker, Transformer, Renderer });
    const val = await new Promise((resolve) => compiler.compile(code, {}, {}, (_e, v) => resolve(v)));
    expect(val).toBe(3);
  });
});
