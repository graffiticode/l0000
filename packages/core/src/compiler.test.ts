import { describe, test, expect, afterEach } from "vitest";
import { parser } from "@graffiticode/parser";
import {
  Compiler,
  Checker,
  Transformer,
  Renderer,
  lexicon,
  setSchemaFetcher,
  clearSchemaCache,
} from "@graffiticode/l0000";

function compile(src, data = {}) {
  return new Promise(async (resolve, reject) => {
    const code = await parser.parse(0, src, lexicon);
    const compiler = new Compiler({
      langID: "0",
      version: "v0.0.0",
      Checker,
      Transformer,
      Renderer,
    });
    compiler.compile(code, data, {}, (err, val) => {
      if (err && err.length > 0) {
        reject(err);
      } else {
        resolve(val);
      }
    });
  });
}

describe("Record key semantics", () => {

  describe("Record creation", () => {
    test("{x: 10} with tag key produces {x: 10}", async () => {
      const result = await compile('{x: 10}..');
      expect(result).toEqual({ x: 10 });
    });

    test("{'x': 10} with string key produces {x: 10}", async () => {
      const result = await compile("{\"x\": 10}..");
      expect(result).toEqual({ x: 10 });
    });

    test("{0: 30} with number key produces {0: 30}", async () => {
      const result = await compile('{0: 30}..');
      expect(result).toEqual({ "0": 30 });
    });

    test("empty record {} produces {}", async () => {
      const result = await compile('{}..');
      expect(result).toEqual({});
    });

    test("multi-field record", async () => {
      const result = await compile('{x: 1, y: 2, z: 3}..');
      expect(result).toEqual({ x: 1, y: 2, z: 3 });
    });
  });

  describe("GET lookup with fallback", () => {
    test("get (tag x) {x: 10} = 10 (tag exact match)", async () => {
      const result = await compile('get (tag x) {x: 10}..');
      expect(result).toBe(10);
    });

    test("get 'x' {x: 10} = 10 (string-to-tag fallback)", async () => {
      const result = await compile("get \"x\" {x: 10}..");
      expect(result).toBe(10);
    });

    test("get (tag x) {'x': 10} = 10 (tag-to-string fallback)", async () => {
      const result = await compile("get (tag x) {\"x\": 10}..");
      expect(result).toBe(10);
    });

    test("get 'x' {'x': 10} = 10 (string exact match)", async () => {
      const result = await compile("get \"x\" {\"x\": 10}..");
      expect(result).toBe(10);
    });
  });

  describe("Exact-match precedence", () => {
    test("get (tag x) {x: 2, 'x': 10} = 2 (tag exact, no fallback)", async () => {
      const result = await compile("get (tag x) {x: 2, \"x\": 10}..");
      expect(result).toBe(2);
    });

    test("get 'x' {x: 2, 'x': 10} = 10 (string exact match)", async () => {
      const result = await compile("get \"x\" {x: 2, \"x\": 10}..");
      expect(result).toBe(10);
    });
  });

  describe("No number fallback", () => {
    test("get '0' {0: 1} = undefined (no number-string fallback)", async () => {
      const result = await compile("get \"0\" {0: 1}..");
      expect(result).toBeUndefined();
    });

    test("get 0 {0: 1} = 1 (number exact match)", async () => {
      const result = await compile('get 0 {0: 1}..');
      expect(result).toBe(1);
    });
  });

  describe("SET preserves key kind", () => {
    test("set (tag y) 20 {x: 10} adds tag key", async () => {
      const result = await compile('set (tag y) 20 {x: 10}..');
      expect(result).toEqual({ x: 10, y: 20 });
    });

    test("set 'z' 30 {x: 10} adds string key", async () => {
      const result = await compile("set \"z\" 30 {x: 10}..");
      expect(result).toEqual({ x: 10, z: 30 });
    });
  });

  describe("LENGTH on records", () => {
    test("length {x: 1, y: 2} = 2", async () => {
      const result = await compile('length {x: 1, y: 2}..');
      expect(result).toBe(2);
    });

    test("length {} = 0", async () => {
      const result = await compile('length {}..');
      expect(result).toBe(0);
    });
  });

  describe("EQUIV on records", () => {
    test("equiv {x: 1} {x: 1} = true", async () => {
      const result = await compile('equiv {x: 1} {x: 1}..');
      expect(result).toBe(true);
    });

    test("equiv {x: 1} {x: 2} = false", async () => {
      const result = await compile('equiv {x: 1} {x: 2}..');
      expect(result).toBe(false);
    });

    test("equiv {x: 1} {'x': 1} = false (different key kinds)", async () => {
      const result = await compile("equiv {x: 1} {\"x\": 1}..");
      expect(result).toBe(false);
    });
  });
});

describe("Existing functionality", () => {

  describe("Arithmetic", () => {
    test("add 1 2 = 3", async () => {
      const result = await compile('add 1 2..');
      expect(result).toBe(3);
    });

    test("mul 3 4 = 12", async () => {
      const result = await compile('mul 3 4..');
      expect(result).toBe(12);
    });

    test("sub 10 3 = 7", async () => {
      const result = await compile('sub 10 3..');
      expect(result).toBe(7);
    });

    test("div 10 4 = 2.5", async () => {
      const result = await compile('div 10 4..');
      expect(result).toBe(2.5);
    });
  });

  describe("Strings", () => {
    test("string literal", async () => {
      const result = await compile("\"hello\"..");
      expect(result).toBe("hello");
    });

    test("concat strings", async () => {
      const result = await compile("concat \"hello\" \" world\"..");
      expect(result).toBe("hello world");
    });
  });

  describe("Lists", () => {
    test("list literal", async () => {
      const result = await compile('[1 2 3]..');
      expect(result).toEqual([1, 2, 3]);
    });

    test("hd [1 2 3] = 1", async () => {
      const result = await compile('hd [1 2 3]..');
      expect(result).toBe(1);
    });

    test("tl [1 2 3] = [2, 3]", async () => {
      const result = await compile('tl [1 2 3]..');
      expect(result).toEqual([2, 3]);
    });

    test("length [1 2 3] = 3", async () => {
      const result = await compile('length [1 2 3]..');
      expect(result).toBe(3);
    });

    test("nth 0 [10 20 30] = 10", async () => {
      const result = await compile('nth 0 [10 20 30]..');
      expect(result).toBe(10);
    });

    test("cons 0 [1 2] = [0, 1, 2]", async () => {
      const result = await compile('cons 0 [1 2]..');
      expect(result).toEqual([0, 1, 2]);
    });

    test("map over list", async () => {
      const result = await compile('map (<x: add x 1>) [1 2 3]..');
      expect(result).toEqual([2, 3, 4]);
    });

    test("filter list", async () => {
      const result = await compile('filter (<x: gt x 1>) [1 2 3]..');
      expect(result).toEqual([2, 3]);
    });

    test("reduce list", async () => {
      const result = await compile('reduce (<acc x: add acc x>) 0 [1 2 3]..');
      expect(result).toBe(6);
    });
  });

  describe("Let bindings", () => {
    test("let x = 10.. x..", async () => {
      const result = await compile('let x = 10.. x..');
      expect(result).toBe(10);
    });

    test("let with record", async () => {
      const result = await compile('let r = {x: 1, y: 2}.. get (tag x) r..');
      expect(result).toBe(1);
    });
  });

  describe("Lambdas", () => {
    test("apply lambda", async () => {
      const result = await compile('apply (<x: add x 1>) 10..');
      expect(result).toBe(11);
    });
  });

  describe("Tags", () => {
    test("tag literal", async () => {
      const result = await compile('tag red..');
      expect(result).toEqual({ tag: "red" });
    });

    test("equiv on tags", async () => {
      const result = await compile('equiv (tag red) (tag red)..');
      expect(result).toBe(true);
    });

    test("tag inequality", async () => {
      const result = await compile('equiv (tag red) (tag blue)..');
      expect(result).toBe(false);
    });
  });

  describe("Comparisons", () => {
    test("lt 1 2 = true", async () => {
      const result = await compile('lt 1 2..');
      expect(result).toBe(true);
    });

    test("gt 2 1 = true", async () => {
      const result = await compile('gt 2 1..');
      expect(result).toBe(true);
    });

    test("eq 5 5 = true", async () => {
      const result = await compile('eq 5 5..');
      expect(result).toBe(true);
    });
  });

  describe("Conditionals", () => {
    test("if true then 1 else 2 = 1", async () => {
      const result = await compile('if true then 1 else 2..');
      expect(result).toBe(1);
    });

    test("if false then 1 else 2 = 2", async () => {
      const result = await compile('if false then 1 else 2..');
      expect(result).toBe(2);
    });
  });

  describe("Data", () => {
    test("data with external input", async () => {
      const result = await compile('data {x: 0}..', { x: 42 });
      expect(result).toEqual({ x: 42 });
    });

    test('parser produces DATA(USE(STR)) for data use "0166"', async () => {
      const nodePool = await parser.parse(0, 'data use "0166"..', lexicon);
      const dataNode = Object.values(nodePool).find(
        n => typeof n === "object" && n && n.tag === "DATA"
      );
      expect(dataNode).toBeTruthy();
      const useNode = nodePool[dataNode.elts[0]];
      expect(useNode.tag).toBe("USE");
      const strNode = nodePool[useNode.elts[0]];
      expect(strNode.tag).toBe("STR");
      expect(strNode.elts[0]).toBe("0166");
    });

    describe('use with mocked schema fetcher', () => {
      // The basis USE visitor fetches L<lang>/schema.json at compile time.
      // Tests inject a mock fetcher and clear the in-process cache.
      function mockFetcher(responses) {
        return async (url) => {
          if (url in responses) {
            const body = responses[url];
            if (body === null) {
              return { ok: false, status: 404, json: async () => null };
            }
            return { ok: true, json: async () => body };
          }
          return { ok: false, status: 404, json: async () => null };
        };
      }

      afterEach(() => {
        setSchemaFetcher(typeof fetch === "function" ? fetch : null);
        clearSchemaCache();
      });

      test('successful fetch + conforming upstream passes', async () => {
        const schema = {
          $id: "test-conform",
          type: "object",
          properties: { x: { type: "number" } },
          required: ["x"],
        };
        setSchemaFetcher(mockFetcher({
          "https://api.graffiticode.org/L0166/schema.json": schema,
        }));
        const result = await compile('data use "0166"..', { x: 42 });
        expect(result).toEqual({ x: 42 });
      });

      test('successful fetch + non-conforming upstream fails', async () => {
        const schema = {
          $id: "test-fail",
          type: "object",
          properties: { x: { type: "number" } },
          required: ["x"],
        };
        setSchemaFetcher(mockFetcher({
          "https://api.graffiticode.org/L0166/schema.json": schema,
        }));
        await expect(compile('data use "0166"..', { y: "wrong" }))
          .rejects.toEqual(expect.arrayContaining([
            expect.objectContaining({
              message: expect.stringContaining("upstream data does not match"),
            }),
          ]));
      });

      test('successful fetch + no upstream returns {} (skip validation)', async () => {
        const schema = {
          $id: "test-skip",
          type: "object",
          properties: { x: { type: "number" } },
          required: ["x"],
        };
        setSchemaFetcher(mockFetcher({
          "https://api.graffiticode.org/L0166/schema.json": schema,
        }));
        const result = await compile('data use "0166"..');
        expect(result).toEqual({});
      });

      test('failed schema fetch surfaces as compile error', async () => {
        setSchemaFetcher(mockFetcher({}));  // returns 404 for everything
        await expect(compile('data use "0166"..'))
          .rejects.toEqual(expect.arrayContaining([
            expect.objectContaining({
              message: expect.stringContaining("failed to load L0166/schema.json"),
            }),
          ]));
      });
    });
  });
});
