// @graffiticode/l0000 — the root Graffiticode language and the inheritance contract.
//
// A child language's core extends these classes:
//   import { Checker, Transformer, Compiler } from "@graffiticode/l0000";
//   class MyChecker extends Checker { HELLO(node, options, resume) { ... } }
// and merges its lexicon over `lexicon`.

export { Visitor, Checker, Transformer, Renderer, Compiler } from "./compiler.js";
export { lexicon } from "./lexicon.js";
export {
  validateAgainstSchema,
  getLanguageSchema,
  setSchemaFetcher,
  clearSchemaCache,
} from "./schema-validator.js";
export { assert, message, messages, reserveCodeRange } from "./share.js";

export type {
  Nid,
  ASTNode,
  NodePool,
  CompileError,
  Resume,
  CompileOptions,
  LexiconEntry,
  Lexicon,
  CompilerConfig,
} from "./types.js";
