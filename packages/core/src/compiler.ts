/* Copyright (c) 2021, ARTCOMPILER INC */
import {assert, message, messages, reserveCodeRange} from "./share.js";
import DecimalImport from 'decimal.js';
// decimal.js is consumed as both CJS and ESM across the toolchain; normalize the default
// export to the constructor so `new Decimal(...)` is valid under NodeNext resolution.
const Decimal: any = (DecimalImport as any)?.default ?? DecimalImport;
import crypto from 'crypto';
import { validateAgainstSchema, getLanguageSchema } from "./schema-validator.js";

// Decrypts secret values written by the console. Must stay in lockstep with
// console src/lib/secret-crypto.ts. Understands two ciphertext formats:
//   legacy   : <ivHex>:<encHex>                 (AES-256-CBC, deterministic IV)
//   versioned: v<N>:<ivHex>:<ctHex>:<tagHex>    (AES-256-GCM, authenticated)
// Keyring: v1 = GRAFFITICODE_SECRET_KEY; v2+ from GRAFFITICODE_SECRET_KEYS JSON
// e.g. {"2":"<secret2>"}. This service only decrypts — the console encrypts.
function keyForVersion(version: number): string | null {
  if (version === 1) return process.env.GRAFFITICODE_SECRET_KEY || null;
  const raw = process.env.GRAFFITICODE_SECRET_KEYS;
  if (!raw) return null;
  try {
    return JSON.parse(raw)[String(version)] || null;
  } catch {
    return null;
  }
}

function deriveAesKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}

function decrypt(ciphertext) {
  if (typeof ciphertext !== 'string') return ciphertext;

  const versioned = ciphertext.match(/^v(\d+):/);
  if (versioned) {
    const version = parseInt(versioned[1], 10);
    const [, ivHex, ctHex, tagHex] = ciphertext.split(':');
    const secret = keyForVersion(version);
    if (!secret || !ivHex || !ctHex || !tagHex) return ciphertext;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', deriveAesKey(secret), Buffer.from(ivHex, 'hex'));
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      const dec = Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]);
      return dec.toString('utf8');
    } catch {
      return ciphertext; // wrong key or tampered — stay lenient
    }
  }

  const secret = keyForVersion(1);
  if (!secret) return ciphertext;
  const [ivHex, encHex] = ciphertext.split(':');
  if (!ivHex || !encHex) return ciphertext;
  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc', deriveAesKey(secret), Buffer.from(ivHex, 'hex'));
    const dec = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    return ciphertext;
  }
}
reserveCodeRange(1000, 1999, "compile");
messages[1001] = "Node ID %1 not found in pool.";
messages[1002] = "Invalid tag in node with Node ID %1.";
messages[1003] = "No async callback provided.";
messages[1004] = "No visitor method defined for '%1'.";

function error(msg, arg?) {
  return msg + arg;
}

function newNode(tag, elts) {
  return {
    tag: tag,
    elts: elts,
  };
}

const ASYNC = true;

// --- Record key helpers ---

function encodeKey(recordKey) {
  if (recordKey.kind === "tag") return `tag:${recordKey.name}`;
  if (recordKey.kind === "string") return `str:${recordKey.value}`;
  if (recordKey.kind === "number") return `num:${recordKey.value}`;
  throw new Error("Unknown record key kind: " + JSON.stringify(recordKey));
}

function makeRecordKey(kind, nameOrValue) {
  if (kind === "tag") return { kind: "tag", name: nameOrValue };
  if (kind === "string") return { kind: "string", value: nameOrValue };
  if (kind === "number") return { kind: "number", value: nameOrValue };
  throw new Error("Unknown key kind: " + kind);
}

function classifyRuntimeKey(v) {
  if (v && typeof v === "object" && v.tag !== undefined && !v.elts) {
    return makeRecordKey("tag", v.tag);
  } else if (typeof v === "string") {
    return makeRecordKey("string", v);
  } else if (typeof v === "number") {
    return makeRecordKey("number", v);
  }
  return makeRecordKey("tag", String(v));
}

function createRecord() {
  return { _type: "record", _entries: new Map() };
}

// Hidden metadata key used by USE to attach the language schema to the
// record it returns. A Symbol keeps it out of Object.entries / JSON output
// so deepConvertRecords (and downstream rendering) skip it automatically.
const SCHEMA_SYM = Symbol.for("gcSchema");

function isRecord(val) {
  return val !== null && typeof val === "object" && val._type === "record";
}

function recordSet(rec, recordKey, value) {
  const newRec = createRecord();
  for (const [k, v] of rec._entries) newRec._entries.set(k, v);
  newRec._entries.set(encodeKey(recordKey), value);
  return newRec;
}

function recordGet(rec, recordKey) {
  const encoded = encodeKey(recordKey);
  if (rec._entries.has(encoded)) return rec._entries.get(encoded);
  if (recordKey.kind === "tag") {
    const fb = `str:${recordKey.name}`;
    if (rec._entries.has(fb)) return rec._entries.get(fb);
  } else if (recordKey.kind === "string") {
    const fb = `tag:${recordKey.value}`;
    if (rec._entries.has(fb)) return rec._entries.get(fb);
  }
  return undefined;
}

function recordHas(rec, recordKey) {
  return recordGet(rec, recordKey) !== undefined;
}

function recordRemove(rec, recordKey) {
  const encoded = encodeKey(recordKey);
  const newRec = createRecord();
  for (const [k, v] of rec._entries) {
    if (k !== encoded) newRec._entries.set(k, v);
  }
  return newRec;
}

function deepConvertRecords(val) {
  if (isRecord(val)) {
    const obj = {};
    for (const [encodedKey, value] of val._entries) {
      const colonIdx = encodedKey.indexOf(":");
      const baseKey = encodedKey.substring(colonIdx + 1);
      obj[baseKey] = deepConvertRecords(value);
    }
    // Also pick up any plain properties added by language transformers
    // (e.g. via {...record, text: v0}) that aren't part of the record internals.
    for (const [k, v] of Object.entries(val)) {
      if (k !== '_type' && k !== '_entries') {
        obj[k] = deepConvertRecords(v);
      }
    }
    return obj;
  }
  if (Array.isArray(val)) {
    return val.map(deepConvertRecords);
  }
  if (val !== null && typeof val === "object" && val.tag === undefined) {
    const obj = {};
    for (const [k, v] of Object.entries(val)) {
      obj[k] = deepConvertRecords(v);
    }
    return obj;
  }
  return val;
}

function recordToPlainObject(rec) {
  return deepConvertRecords(rec);
}

function plainObjectToRecord(obj) {
  const rec = createRecord();
  for (const [key, value] of Object.entries(obj)) {
    rec._entries.set(`tag:${key}`, value);
  }
  return rec;
}

function recordMerge(rec1, rec2) {
  const newRec = createRecord();
  const addEntries = (source) => {
    if (isRecord(source)) {
      for (const [k, v] of source._entries) newRec._entries.set(k, v);
    } else if (typeof source === "object" && source !== null) {
      for (const [k, v] of Object.entries(source)) newRec._entries.set(`tag:${k}`, v);
    }
  };
  addEntries(rec1);
  addEntries(rec2);
  return newRec;
}

// Upstream compiled output (passed as options.data for a chained task) may use
// the standard { data, errors } envelope or be a bare value from a task
// compiled before the envelope existed. Return the data model from either:
// detection requires `errors` to be an array — the envelope always carries one
// (success → `[]`, failure → non-empty), and using `data` as a discriminator
// would misidentify legacy raw values that happen to carry a top-level `data`
// key (e.g. l0158's `{ type: "questions", data: {...} }`). Basis records have
// `_type`/`_entries` (not `data`/`errors`) so they are never misdetected.
function unwrapEnvelopeData(value) {
  if (
    value !== null && typeof value === "object" &&
    !Array.isArray(value) && !isRecord(value) &&
    Array.isArray(value.errors)
  ) {
    return value.data;
  }
  return value;
}

// Visitor is the inheritance KERNEL: pure AST traversal/dispatch (`this[node.tag]`).
// It carries no language semantics; L0000's Checker/Transformer (and every descendant
// language's) extend it.
export class Visitor {
  [key: string]: any;
  constructor(code) {
    this.nodePool = code;
    this.root = code.root;
  }
  visit(nid, options, resume) {
    try {
      assert(nid, "Invalid nid=" + nid);
      let node;
      if (typeof nid === "object") {
        node = nid;
      } else {
        node = this.nodePool[nid];
      }
      // console.log(
      //   "Visitor/visit()",
      //   "nodePool=" + JSON.stringify(this.nodePool, null, 2),
      //   "node.tag=" + node.tag,
      //   "options=" + JSON.stringify(options, null, 2),
      // );
      const fn = (this[node.tag] || this["CATCH_ALL"])?.bind(this);
      assert(node && node.tag && node.elts, "2000: Visitor.visit() tag=" + node.tag + " elts= " + JSON.stringify(node.elts));
      assert(fn, "2000: Visitor function not defined for: " + node.tag);
      assert(typeof resume === "function", message(1003));
      if (!options.SYNC && ASYNC) {
        // This is used to keep from blowing the call stack.
        setTimeout(() => fn(node, options, resume), 0);
      } else {
        fn(node, options, resume);
      }
    } catch (x) {
      console.log(
        "Vistor/visit()",
        "ERROR: " + x
      );
      resume(error(x.stack));
    }
  }
  node(nid) {
    var n = this.nodePool[nid];
    if (!nid) {
      return null;
    } else if (!n) {
      return {};
    }
    var elts = [];
    switch (n.tag) {
    case "NULL":
      break;
    case "NUM":
    case "STR":
    case "IDENT":
    case "BOOL":
    case "TAG":
      elts[0] = n.elts[0];
      break;
    default:
      for (var i=0; i < n.elts.length; i++) {
        elts[i] = this.node(n.elts[i]);
      }
      break;
    }
    return {
      tag: n.tag,
      elts: elts,
    };
  }
}

export class Checker extends Visitor {
  constructor(nodePool) {
    super(nodePool);
  }
  check(options, resume) {
    const nid = this.root;
    this.visit(nid, options, (err, data) => {
      resume(err, data);
    });
  }
  CATCH_ALL(node, options, resume) {
    const err = [];
    const val = node;
    resume(err, val);
  }
  ERROR(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        this.visit(node.elts[2], options, (e2, v2) => {
          // Ensure message is always a string
          const message = typeof v0 === "string" ? v0
            : (v0?.tag === "STR" ? v0.elts[0] : JSON.stringify(v0));
          const err = [{
            message,
            from: v1,
            to: v2
          }];
          const val = node;
          resume(err, val);
        });
      });
    });
  }
  PROG(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      const err = [].concat(e0);
      const val = node;
      resume(err, val);
    });
  }
  EXPRS(node, options, resume) {
    let err = [];
    let val = [];
    options.SYNC = true;
    for (let elt of node.elts) {
      this.visit(elt, options, (e0, v0) => {
        err = err.concat(e0);
        val = val.concat(v0);
      });
    }
    options.SYNC = false;
    resume(err, val);
  }
  NUM(node, options, resume) {
    const err = [];
    const val = +node.elts[0];
    resume(err, val);
  }
  LAMBDA(node, options, resume) {
    const err = [];
    const val = node;
    this.visit(node.elts[0], options, (e0, v0) => {
      const err = [].concat(e0);
      const val = node;
      resume(err, val);
    });
  }
  LIST(node, options, resume) {
    const err = [];
    const val = node;
    if (node.elts.length === 0) {
      resume(err, val);
    } else {
      this.visit(node.elts[0], options, (e0, v0) => {
        const err = [].concat(e0);
        const val = node;
        resume(err, val);
      });
    }
  }
  IDENT(node, options, resume) {
    const err = [];
    const val = node;
    resume(err, val);
  }
  TAG(node, options, resume) {
    const err = [];
    const val = node;
    resume(err, val);
  }
  STR(node, options, resume) {
    const err = [];
    const val = node;
    resume(err, val);
  }
  JSON(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      assert(v0.tag === "STR", JSON.stringify(v0, null, 2));
      const err = [];
      const val = node;
      resume(err, val);
    });
  }
  GET_VAR(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      const err = [];
      const val = node;
      resume(err, val);
    });
  }
  GET_VAL_PRIVATE(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      const err = node.elts[1] ? [] : [error("get-val-private requires a resolved value.", node)];
      const val = node;
      resume(err, val);
    });
  }
  GET_VAL_PUBLIC(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      const err = node.elts[1] ? [] : [error("get-val-public requires a resolved value.", node)];
      const val = node;
      resume(err, val);
    });
  }
  SET_VAR(node, options, resume) {
    this.visit(node.elts[0], options, (err1, val1) => {
      this.visit(node.elts[1], options, (err2, val2) => {
        const err = [].concat(err1).concat(err2);
        const val = node;
        resume(err, val);
      });
    });
  }
  CONCAT(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        const err = [].concat(e0).concat(e1);
        const val = node;
        resume(err, val);
      });
    });
  }
  ADD(node, options, resume) {
    this.visit(node.elts[0], options, (err1, val1) => {
      this.visit(node.elts[1], options, (err2, val2) => {
        const err = [].concat(err1).concat(err2);
        const val = node;
        resume(err, val);
      });
    });
  }
  SUB(node, options, resume) {
    this.visit(node.elts[0], options, (err1, val1) => {
      this.visit(node.elts[1], options, (err2, val2) => {
        const err = [].concat(err1).concat(err2);
        const val = node;
        resume(err, val);
      });
    });
  }
  DIV(node, options, resume) {
    this.visit(node.elts[0], options, (err1, val1) => {
      this.visit(node.elts[1], options, (err2, val2) => {
        const err = [].concat(err1).concat(err2);
        const val = node;
        resume(err, val);
      });
    });
  }
  GET(node, options, resume) {
    this.visit(node.elts[0], options, (err1, val1) => {
      this.visit(node.elts[1], options, (err2, val2) => {
        const err = [].concat(err1).concat(err2);
        const val = node;
        resume(err, val);
      });
    });
  }
  LT(node, options, resume) {
    this.visit(node.elts[0], options, (err1, val1) => {
      this.visit(node.elts[1], options, (err2, val2) => {
        // if (isNaN(+val1)) {
        //   err1 = err1.concat(error("Argument must be a number.", node.elts[0]));
        // }
        // if (isNaN(+val2)) {
        //   err2 = err2.concat(error("Argument must be a number.", node.elts[1]));
        // }
        const err = [].concat(err1).concat(err2);
        const val = node;
        resume(err, val);
      });
    });
  }
  BOOL(node, options, resume) {
    const err = [];
    const val = node;
    resume(err, val);
  }
  NULL(node, options, resume) {
    const err = [];
    const val = node;
    resume(err, val);
  }
  RECORD(node, options, resume) {
    const err = [];
    const val = node;
    resume(err, val);
  }
  BINDING(node, options, resume) {
    const err = [];
    const val = node;
    resume(err, val);
  }
  MUL(node, options, resume) {
    this.visit(node.elts[0], options, (err1, val1) => {
      this.visit(node.elts[1], options, (err2, val2) => {
        const err = [].concat(err1).concat(err2);
        const val = node;
        resume(err, val);
      });
    });
  }
  POW(node, options, resume) {
    this.visit(node.elts[0], options, (err1, val1) => {
      this.visit(node.elts[1], options, (err2, val2) => {
        const err = [].concat(err1).concat(err2);
        const val = node;
        resume(err, val);
      });
    });
  }
  VAL(node, options, resume) {
    const err = [];
    const val = node;
    resume(err, val);
  }
  KEY(node, options, resume) {
    const err = [];
    const val = node;
    resume(err, val);
  }
  LENGTH(node, options, resume) {
    const err = [];
    const val = node;
    resume(err, val);
  }
  ARG(node, options, resume) {
    const err = [];
    const val = node;
    resume(err, val);
  }
  DATA(node, options, resume) {
    const err = [];
    const val = node;
    resume(err, val);
  }
  USE(node, options, resume) {
    const err = [];
    const val = node;
    resume(err, val);
  }
  PAREN(node, options, resume) {
    const err = [];
    const val = node;
    resume(err, val);
  }
  APPLY(node, options, resume) {
    const err = [];
    const val = node;
    resume(err, val);
  }
  MAP(node, options, resume) {
    const err = [];
    const val = node;
    resume(err, val);
  }
  REDUCE(node, options, resume) {
    const err = [];
    const val = node;
    resume(err, val);
  }
  STYLE(node, options, resume) {
    const err = [];
    const val = node;
    resume(err, val);
  }
  CASE(node, options, resume) {
    const err = [];
    const val = node;
    resume(err, val);
  }
  IF(node, options, resume) {
    const err = [];
    const val = node;
    resume(err, val);
  }
  OF(node, options, resume) {
    const err = [];
    const val = node;
    resume(err, val);
  }
  PRINT(node, options, resume) {
    const err = [];
    const val = node;
    resume(err, val);
  }
  GT(node, options, resume) {
    this.visit(node.elts[0], options, (err1, val1) => {
      this.visit(node.elts[1], options, (err2, val2) => {
        const err = [].concat(err1).concat(err2);
        const val = node;
        resume(err, val);
      });
    });
  }
  GE(node, options, resume) {
    this.visit(node.elts[0], options, (err1, val1) => {
      this.visit(node.elts[1], options, (err2, val2) => {
        const err = [].concat(err1).concat(err2);
        const val = node;
        resume(err, val);
      });
    });
  }
  LE(node, options, resume) {
    this.visit(node.elts[0], options, (err1, val1) => {
      this.visit(node.elts[1], options, (err2, val2) => {
        const err = [].concat(err1).concat(err2);
        const val = node;
        resume(err, val);
      });
    });
  }
  NE(node, options, resume) {
    this.visit(node.elts[0], options, (err1, val1) => {
      this.visit(node.elts[1], options, (err2, val2) => {
        const err = [].concat(err1).concat(err2);
        const val = node;
        resume(err, val);
      });
    });
  }
  RANGE(node, options, resume) {
    this.visit(node.elts[0], options, (err1, val1) => {
      this.visit(node.elts[1], options, (err2, val2) => {
        this.visit(node.elts[2], options, (err3, val3) => {
          const err = [].concat(err1).concat(err2).concat(err3);
          const val = node;
          resume(err, val);
        });
      });
    });
  }
  EQ(node, options, resume) {
    this.visit(node.elts[0], options, (err1, val1) => {
      this.visit(node.elts[1], options, (err2, val2) => {
        const err = [].concat(err1).concat(err2);
        const val = node;
        resume(err, val);
      });
    });
  }
  MOD(node, options, resume) {
    this.visit(node.elts[0], options, (err1, val1) => {
      this.visit(node.elts[1], options, (err2, val2) => {
        const err = [].concat(err1).concat(err2);
        const val = node;
        resume(err, val);
      });
    });
  }
  MIN(node, options, resume) {
    this.visit(node.elts[0], options, (err1, val1) => {
      this.visit(node.elts[1], options, (err2, val2) => {
        const err = [].concat(err1).concat(err2);
        const val = node;
        resume(err, val);
      });
    });
  }
  MAX(node, options, resume) {
    this.visit(node.elts[0], options, (err1, val1) => {
      this.visit(node.elts[1], options, (err2, val2) => {
        const err = [].concat(err1).concat(err2);
        const val = node;
        resume(err, val);
      });
    });
  }
  NOT(node, options, resume) {
    this.visit(node.elts[0], options, (err1, val1) => {
      let err = [].concat(err1);
      if (typeof val1 !== "boolean" && val1 !== null && val1 !== undefined && val1 !== 0 && val1 !== "" && val1 !== false) {
        err.push(`NOT operation requires a boolean argument, got ${typeof val1}`);
      }
      const val = node;
      resume(err, val);
    });
  }
  EQUIV(node, options, resume) {
    this.visit(node.elts[0], options, (err1, val1) => {
      this.visit(node.elts[1], options, (err2, val2) => {
        let err = [].concat(err1).concat(err2);
        const val = node;
        resume(err, val);
      });
    });
  }
  OR(node, options, resume) {
    this.visit(node.elts[0], options, (err1, val1) => {
      this.visit(node.elts[1], options, (err2, val2) => {
        let err = [].concat(err1).concat(err2);
        if (typeof val1 !== "boolean" && val1 !== null && val1 !== undefined && val1 !== 0 && val1 !== "" && val1 !== false) {
          err.push(`OR operation requires boolean arguments, got ${typeof val1} for first argument`);
        }
        if (typeof val2 !== "boolean" && val2 !== null && val2 !== undefined && val2 !== 0 && val2 !== "" && val2 !== false) {
          err.push(`OR operation requires boolean arguments, got ${typeof val2} for second argument`);
        }
        const val = node;
        resume(err, val);
      });
    });
  }
  AND(node, options, resume) {
    this.visit(node.elts[0], options, (err1, val1) => {
      this.visit(node.elts[1], options, (err2, val2) => {
        let err = [].concat(err1).concat(err2);
        if (typeof val1 !== "boolean" && val1 !== null && val1 !== undefined && val1 !== 0 && val1 !== "" && val1 !== false) {
          err.push(`AND operation requires boolean arguments, got ${typeof val1} for first argument`);
        }
        if (typeof val2 !== "boolean" && val2 !== null && val2 !== undefined && val2 !== 0 && val2 !== "" && val2 !== false) {
          err.push(`AND operation requires boolean arguments, got ${typeof val2} for second argument`);
        }
        const val = node;
        resume(err, val);
      });
    });
  }
  HD(node, options, resume) {
    this.visit(node.elts[0], options, (err1, val1) => {
      let err = [].concat(err1);
      // if (!Array.isArray(val1)) {
      //   err.push(`HD operation requires a list argument, got ${typeof val1}`);
      // } else if (val1.length === 0) {
      //   err.push(`HD operation called on an empty list`);
      // }
      const val = node;
      resume(err, val);
    });
  }
  TL(node, options, resume) {
    this.visit(node.elts[0], options, (err1, val1) => {
      let err = [].concat(err1);
      // if (!Array.isArray(val1)) {
      //   err.push(`TL operation requires a list argument, got ${typeof val1}`);
      // } else if (val1.length === 0) {
      //   err.push(`TL operation called on an empty list`);
      // }
      const val = node;
      resume(err, val);
    });
  }
  LOG(node, options, resume) {
    this.visit(node.elts[0], options, (err1, val1) => {
      const err = [].concat(err1);
      const val = node;
      resume(err, val);
    });
  }
  ISEMPTY(node, options, resume) {
    this.visit(node.elts[0], options, (err1, val1) => {
      const err = [].concat(err1);
      const val = node;
      resume(err, val);
    });
  }
  CONS(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        const err = [].concat(e0).concat(e1);
        const val = node;
        resume(err, val);
      });
    });
  }
  APPEND(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        const err = [].concat(e0).concat(e1);
        const val = node;
        resume(err, val);
      });
    });
  }
  LAST(node, options, resume) {
    this.visit(node.elts[0], options, (err1, val1) => {
      const err = [].concat(err1);
      const val = node;
      resume(err, val);
    });
  }
  DROP(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        const err = [].concat(e0).concat(e1);
        const val = node;
        resume(err, val);
      });
    });
  }
  TAKE(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        const err = [].concat(e0).concat(e1);
        const val = node;
        resume(err, val);
      });
    });
  }
}

function enterEnv(ctx, name, paramc) {
  if (!ctx.env) {
    ctx.env = [];
  }
  // recursion guard
  if (ctx.env.length > 380) {
    //return;  // just stop recursing
    throw new Error("runaway recursion");
  }
  ctx.env.push({
    name: name,
    paramc: paramc,
    lexicon: {},
    pattern: [],
  });
}
function exitEnv(ctx) {
  ctx.env.pop();
}
function findWord(ctx, lexeme) {
  let env = ctx.env;
  if (!env) {
    return null;
  }
  for (var i = env.length-1; i >= 0; i--) {
    var word = env[i].lexicon[lexeme];
    if (word) {
      return word;
    }
  }
  return null;
}
function addWord(ctx, lexeme, entry) {
  topEnv(ctx).lexicon[lexeme] = entry;
  return null;
}
function topEnv(ctx) {
  return ctx.env[ctx.env.length-1]
}
export class Transformer extends Visitor {
  constructor(nodePool) {
    super(nodePool);
    this.patternNodePool = ['unused'];
    this.patternNodeMap = {};
  }
  transform(options, resume) {
    const nid = this.root;
    this.visit(nid, options, (err, data) => {
      resume(err, data);
    });
  }
  internPattern(n) {
    if (!n) {
      return 0;
    }
    const nodeMap = this.patternNodeMap;
    const nodePool = this.patternNodePool;
    const tag = n.tag;
    const elts_nids = [];
    const count = n.elts.length;
    let elts = "";
    for (let i = 0; i < count; i++) {
      if (typeof n.elts[i] === "object") {
        n.elts[i] = this.internPattern(n.elts[i]);
      }
      elts += n.elts[i];
    }
    const key = tag+count+elts;
    let nid = nodeMap[key];
    if (nid === void 0) {
      nodePool.push({tag: tag, elts: n.elts});
      nid = nodePool.length - 1;
      nodeMap[key] = nid;
      if (n.coord) {
        // @ts-expect-error `ctx` is an undefined free variable in the original basis
        // source. This branch is dead for pattern nodes (they carry no coord); preserved
        // verbatim to avoid changing runtime behavior.
        ctx.state.coords[nid] = n.coord;
      }
    }
    return nid;
  }
  match(options, patterns, node) {
    // console.log(
    //   "match()",
    //   "patterns=" + JSON.stringify(patterns, null, 2),
    //   "node=" + JSON.stringify(node, null, 2),
    // );
    if (patterns.size === 0 || node === undefined) {
      return false;
    }
    let matches = patterns.filter((pattern) => {
      if (pattern.tag === undefined || node.tag === undefined) {
        return false;
      }
      const patternNid = this.internPattern(pattern);
      if (patternNid === this.internPattern(node) ||
          patternNid === this.internPattern(newNode('TAG', ['_']))) {
        return true;
      }
      if (pattern.tag === node.tag) {
        if (pattern.elts.length === node.elts.length) {
          // Same number of args, so see if each matches.
          return pattern.elts.every((arg, i) => {
            if (pattern.tag === 'VAR') {
              if (arg === node.elts[i]) {
                return true;
              }
              return false;
            }
            let result = this.match(options, [arg], node.elts[i]);
            return result.length === 1;
          });
        } else if (pattern.elts.length < node.elts.length) {
          // Different number of args, then see if there is a wildcard match.
          let nargs = node.elts.slice(1);
          if (pattern.elts.length === 2) {
            // Binary node pattern
            let result = (
              this.match(options, [pattern.elts[0]], node.elts[0]).length > 0 &&
              this.match(options, [pattern.elts[1]], newNode(node.tag, nargs)).length > 0
              // Match rest of the node against the second pattern argument.
            );
            return result;
          }
        }
      }
      return false;
    });
    // if (true || matches.length > 0) {
    //   console.log("match() node: " + JSON.stringify(node, null, 2));
    //   console.log("match() matches: " + JSON.stringify(matches, null, 2));
    // }
    return matches;
  }
  CATCH_ALL(node, options, resume) {
    // Fallback for unknown node types.
    const err = [];
    const val = node;
    resume(err, val);
  }
  PROG(node, options, resume) {
    if (!options) {
      options = {};
    }
    this.visit(node.elts[0], options, (e0, v0) => {
      const err = e0;
      const val = v0.pop();  // Return the value of the last expression.
      resume(err, val);
    });
  }
  EXPRS(node, options, resume) {
    let err = [];
    let val = [];
    for (let elt of node.elts) {
      this.visit(elt, options, (e0, v0) => {
        err = err.concat(e0);
        val.push(v0);
        if (val.length === node.elts.length) {
          resume(err, val);
        }
      });
    }
    if (node.elts.length === 0) {
      val.push("");
      resume(err, val);
    }
  }
  NUM(node, options, resume) {
    const err = [];
    const val = +node.elts[0];
    resume(err, val);
  }
  LAMBDA(node, options, resume) {
    // Return a function value.
    this.visit(node.elts[0], options, (err0, params) => {
      let args = [].concat(options.args);
      enterEnv(options, "lambda", params.length);
      params.forEach((param, i) => {
        // let inits = this.nodePool[node.elts[3]].elts;
        if (args[i] !== undefined) {
          // Got an arg so use it.
          addWord(options, param, {
            name: param,
            val: args[i],
          });
        // } else {
        //   // Don't got an arg so use the init.
        //   this.visit(inits[i], options, (err, val) => {
        //     addWord(options, param, {
        //       name: param,
        //       val: val,
        //     });
        //   });
        }
      });
      this.visit(node.elts[1], options, (err, val) => {
        exitEnv(options);
        resume([].concat(err0).concat(err).concat(err), val)
      });
    });
  }
  LIST(node, options, resume) {
    let err = [];
    if (node.elts.length === 0) {
      resume(err, []);
    } else {
      let len = 0;
      const ndx = [];
      for (let elt of node.elts) {
        this.visit(elt, options, (e0, v0) => {
          err = err.concat(e0);
          ndx[elt] = v0;
          if (++len === node.elts.length) {
            // This is a little trickery to restore the original order of the
            // elements, given that they may have been reordered due to the
            // nodes being visited asynchronously. The node ids are reversed,
            // so we need to add prepend the current v0 to the list.
            const val = node.elts.reduce((acc, elt) => [...acc, ndx[elt]], []);
            resume(err, val);
          }
        });
      }
    }
  }
  IDENT(node, options, resume) {
    let word = findWord(options, node.elts[0]);
    const err = [];
    const val = word?.val !== undefined ? word.val : node.elts[0];
    resume(err, val);
  }
  TAG(node, options, resume) {
    const err = [];
    const val = { tag: node.elts[0] };
    resume(err, val);
  }
  STR(node, options, resume) {
    const err = [];
    const val = node.elts[0];
    resume(err, val);
  }
  JSON(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      const err = [];
      const val = JSON.parse(v0);
      resume(err, val);
    });
  }
  GET_VAR(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      const err = [];
      const val = options[v0];
      resume(err, val);
    });
  }
  GET_VAL_PRIVATE(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        resume([], decrypt(v1));
      });
    });
  }
  GET_VAL_PUBLIC(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        resume([], v1);
      });
    });
  }
  SET_VAR(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        const err = [...e0, ...e1];
        options[v0] = v1;
        resume(err, v1);
      });
    });
  }
  CONCAT(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        const err = [].concat(e0).concat(e1);
        if (typeof v0 === 'string' && typeof v1 === 'string') {
          resume(err, v0 + v1);
        } else if (Array.isArray(v0) && Array.isArray(v1)) {
          resume(err, [...v0, ...v1]);
        } else {
          resume([...err, `Error in CONCAT operation: both arguments must be strings or both must be lists`], undefined);
        }
      });
    });
  }
  ADD(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        const err = [].concat(e0).concat(e1);
        try {
          const val = new Decimal(v0).plus(new Decimal(v1)).toNumber();
          resume(err, val);
        } catch (e) {
          resume([...err, `Error in ADD operation: ${e.message}`], NaN);
        }
      });
    });
  }
  SUB(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        const err = [].concat(e0).concat(e1);
        try {
          const val = new Decimal(v0).minus(new Decimal(v1)).toNumber();
          resume(err, val);
        } catch (e) {
          resume([...err, `Error in SUB operation: ${e.message}`], NaN);
        }
      });
    });
  }
  DIV(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        const err = [].concat(e0).concat(e1);
        try {
          const val = new Decimal(v0).dividedBy(new Decimal(v1)).toNumber();
          resume(err, val);
        } catch (e) {
          resume([...err, `Error in DIV operation: ${e.message}`], NaN);
        }
      });
    });
  }
  LT(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        const err = [].concat(e0).concat(e1);
        try {
          const val = new Decimal(v0).lessThan(new Decimal(v1));
          resume(err, val);
        } catch (e) {
          resume([...err, `Error in LT operation: ${e.message}`], false);
        }
      });
    });
  }
  BOOL(node, options, resume) {
    const err = [];
    const val = node.elts[0];
    resume(err, val);
  }
  NULL(node, options, resume) {
    const err = [];
    const val = null;
    resume(err, val);
  }
  BINDING(node, options, resume) {
    const err = [];
    this.visit(node.elts[0], options, (err1, val1) => {
      this.visit(node.elts[1], options, (err2, val2) => {
        const key = classifyRuntimeKey(val1);
        resume([].concat(err1).concat(err2), {key, val: val2});
      });
    });
  }
  RECORD(node, options, resume) {
    let err = [];
    if (node.elts.length === 0) {
      resume(err, createRecord());
    } else {
      let len = 0;
      const ndx = [];
      for (let elt of node.elts) {
        this.visit(elt, options, (e0, v0) => {
          err = err.concat(e0);
          ndx[elt] = v0;
          if (++len === node.elts.length) {
            const val = node.elts.reduce((acc, elt) => {
              return recordSet(acc, ndx[elt].key, ndx[elt].val);
            }, createRecord());
            resume(err, val);
          }
        });
      }
    }
  }
  MUL(node, options, resume) {
    this.visit(node.elts[0], options, (err1, val1) => {
      this.visit(node.elts[1], options, (err2, val2) => {
        let err = [].concat(err1).concat(err2);
        try {
          const val = new Decimal(val1).times(new Decimal(val2)).toNumber();
          resume(err, val);
        } catch (e) {
          if (isNaN(+val1)) {
            err = err.concat(error("MUL first argument must be a number: ", JSON.stringify(node, null, 2)));
          }
          if (isNaN(+val2)) {
            err = err.concat(error("MUL second argument must be a number: ", JSON.stringify(node, null, 2)));
          }
          resume([...err, `Error in MUL operation: ${e.message}`], NaN);
        }
      });
    });
  }
  POW(node, options, resume) {
    this.visit(node.elts[0], options, (err1, val1) => {
      this.visit(node.elts[1], options, (err2, val2) => {
        let err = [].concat(err1).concat(err2);
        try {
          const val = new Decimal(val1).pow(new Decimal(val2)).toNumber();
          resume(err, val);
        } catch (e) {
          if (isNaN(+val1)) {
            err = err.concat(error("POW first argument must be a number: ", JSON.stringify(node, null, 2)));
          }
          if (isNaN(+val2)) {
            err = err.concat(error("POW second argument must be a number: ", JSON.stringify(node, null, 2)));
          }
          resume([...err, `Error in POW operation: ${e.message}`], NaN);
        }
      });
    });
  }
  MOD(node, options, resume) {
    this.visit(node.elts[0], options, (err1, val1) => {
      this.visit(node.elts[1], options, (err2, val2) => {
        let err = [].concat(err1).concat(err2);
        try {
          const val = new Decimal(val1).mod(new Decimal(val2)).toNumber();
          resume(err, val);
        } catch (e) {
          if (isNaN(+val1)) {
            err = err.concat(error("MOD first argument must be a number: ", JSON.stringify(node, null, 2)));
          }
          if (isNaN(+val2)) {
            err = err.concat(error("MOD second argument must be a number: ", JSON.stringify(node, null, 2)));
          }
          resume([...err, `Error in MOD operation: ${e.message}`], NaN);
        }
      });
    });
  }
  VAL(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        const err = [].concat(e0).concat(e1);
        if (isRecord(v1)) {
          const rk = classifyRuntimeKey(v0);
          const val = recordGet(v1, rk);
          resume(err, val);
        } else {
          const key = typeof v0 === "object" && v0.tag !== undefined ? v0.tag : v0;
          const val = v1[key];
          resume(err, val);
        }
      });
    });
  }
  KEY(node, options, resume) {
    const err = [];
    const val = node;
    resume(err, val);
  }
  LENGTH(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      const err = e0;
      let val;
      if (isRecord(v0)) {
        val = v0._entries.size;
      } else {
        val = (Array.isArray(v0) || typeof v0 === 'string') ? v0.length : 0;
      }
      resume(err, val);
    });
  }
  ARG(node, options, resume) {
    const err = [];
    const val = node;
    resume(err, val);
  }
  DATA(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      // Upstream may arrive as a { data, errors } envelope (chained task on a
      // migrated language) or as a bare value (task compiled before the
      // envelope). Read the data model from either shape.
      const upstream = unwrapEnvelopeData(options.data);
      const hasUpstream = upstream != null
        && (isRecord(upstream) ? upstream._entries.size > 0
            : typeof upstream === "object" ? Object.keys(upstream).length > 0
            : true);
      // When v0 came from `use`, it carries the language schema on a
      // hidden Symbol key. Validate the upstream against it; skip when
      // no upstream is bound (the `{}` fallback case).
      const schema = isRecord(v0) ? v0[SCHEMA_SYM] : null;
      if (hasUpstream && schema) {
        const plain = isRecord(upstream) ? recordToPlainObject(upstream) : upstream;
        const errs = validateAgainstSchema(plain, schema);
        if (errs.length > 0) {
          resume([].concat(e0, errs), null);
          return;
        }
      }
      const val = hasUpstream ? recordMerge(v0, upstream) : v0;
      resume(e0, val);
    });
  }
  USE(node, options, resume) {
    // Visit the STR child to get the upstream language id, then fetch that
    // language's schema.json over HTTP and tag the returned record so DATA
    // can validate the chained upstream value against it. The fetch is
    // cached in-process. Fetch failures surface as compile errors.
    this.visit(node.elts[0], options, (e0, v0) => {
      const lang = (typeof v0 === "string") ? v0 : "";
      if (!/^\d{3,5}$/.test(lang)) {
        resume([].concat(e0, [{
          message: `use: argument must be a language id, got "${lang}"`,
          from: -1, to: -1,
        }]), null);
        return;
      }
      getLanguageSchema(lang).then(
        (schema) => {
          const rec = createRecord();
          rec[SCHEMA_SYM] = schema;
          resume(e0, rec);
        },
        (err) => {
          resume([].concat(e0, [{
            message: `use: failed to load L${lang}/schema.json: ${err.message}`,
            from: -1, to: -1,
          }]), null);
        }
      );
    });
  }
  PAREN(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      const err = [].concat(e0);
      const val = v0;
      resume(err, val);
    });
  }
  APPLY(node, options, resume) {
    // Apply a function to arguments.
    this.visit(node.elts[1], options, (e1, v1) => {
      options.args = v1;
      this.visit(node.elts[0], options, (e0, v0) => {
        const err = [].concat(e1).concat(e0);
        const val = v0;
        resume(err, val);
      });
    });
  }
  MAP(node, options, resume) {
    // FIXME make async
    options.SYNC = true;
    this.visit(node.elts[1], options, (e1, v1) => {
      let err = [];
      let val = [];
      v1.forEach(args => {
        options.SYNC = true;
        options.args = args;
        options = JSON.parse(JSON.stringify(options));  // Copy option arg support async.
        this.visit(node.elts[0], options, (e0, v0) => {
          val.push(v0);
          err = err.concat(e0);
          if (val.length === v1.length) {
            resume(err, val);
          }
        });
      });
    });
    options.SYNC = false;
  }
  FILTER(node, options, resume) {
    // FIXME make async
    options.SYNC = true;
    this.visit(node.elts[1], options, (e1, v1) => {
      let err = [];
      let val = [];
      v1.forEach(args => {
        options.args = args;
        options = JSON.parse(JSON.stringify(options));  // Copy option arg support async.
        this.visit(node.elts[0], options, (e0, v0) => {
          if (!!v0) {
            val.push(args);
          } else {
            val.push(null);
          }
          err = err.concat(e0);
          if (val.length === v1.length) {
            val = val.filter(v => v !== null);
            resume(err, val);
          }
        });
      });
    });
    options.SYNC = false;
  }
  REDUCE(node, options, resume) {
    // FIXME make async
    // reduce (fn) acc list
    options.SYNC = true;
    this.visit(node.elts[1], options, (e1, v1) => {
      this.visit(node.elts[2], options, (e2, v2) => {
        let err = [];
        let val = v1;
        v2.forEach((args, index) => {
          options.SYNC = true;
          options.args = [val, args];
          options = JSON.parse(JSON.stringify(options));  // Copy option arg support async.
          this.visit(node.elts[0], options, (e0, v0) => {
            val = v0;
            err = err.concat(e0);
            if (index === v2.length - 1) {
              resume(err, val);
            }
          });
        });
      });
    });
    options.SYNC = false;
  }
  STYLE(node, options, resume) {
    const err = [];
    const val = node;
    resume(err, val);
  }
  CASE(node, options, resume) {
    // FIXME this isn't ASYNC compatible
    options.SYNC = true;
    this.visit(node.elts[0], options, (e0, v0) => {
      const type = typeof v0;
      const val = `${v0}`;
      const expr = (
        v0 === null && {tag: "NUL", elts: []} ||
        v0?.tag !== undefined && !v0.elts && {tag: "TAG", elts: [v0.tag]} ||
        v0?.tag !== undefined && v0 ||   // Already an AST node.
        type === "boolean" && {tag: "BOOL", elts: [val]} ||
        type === "number" && {tag: "NUM", elts: [val]} ||
        {tag: "STR", elts: [val]}
      );
      let foundMatch = false;
      const patterns = [];
      for (var i = 1; i < node.elts.length; i++) {
        this.visit(node.elts[i], options, (err, val) => {
          if (this.match(options, [this.node(node.elts[i]).elts[0]], expr).length) {
            this.visit(val.exprElt, options, resume);
            foundMatch = true;
          }
        });
        if (foundMatch) {
          return;
        }
      }
      if (!foundMatch) {
        resume([], {})
      }
    });
    options.SYNC = false;
  }
  OF(node, options, resume) {
    this.visit(node.elts[0], options, (err0, pattern) => {
      resume([].concat(err0), {
        pattern: pattern,
        exprElt: node.elts[1],
      });
    });
  }
  IF(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      if (!!v0) {
        this.visit(node.elts[1], options, (e1, v1) => {
          const err = [
            ...e0,
            ...e1,
          ];
          const val = v1;
          resume(err, val);
        });
      } else {
        this.visit(node.elts[2], options, (e2, v2) => {
          const err = [
            ...e0,
            ...e2,
          ];
          const val = v2;
          resume(err, val);
        });
      }
    });
  }
  GET(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        const err = [...e0, ...e1];
        if (isRecord(v1)) {
          const rk = classifyRuntimeKey(v0);
          const val = recordGet(v1, rk);
          resume(err, val);
        } else if (Array.isArray(v1) && typeof v0 === "number") {
          resume(err, v1[v0]);
        } else if (typeof v1 === "object" && v1 !== null) {
          const key = typeof v0 === "object" && v0.tag !== undefined ? v0.tag : v0;
          resume(err, v1[key]);
        } else {
          resume([...err, "Type Error: expected v1 to be a record or object."], undefined);
        }
      });
    });
  }
  SET(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        this.visit(node.elts[2], options, (e2, v2) => {
          const err = [...e0, ...e1, ...e2];
          if (isRecord(v2)) {
            const rk = classifyRuntimeKey(v0);
            const val = recordSet(v2, rk, v1);
            resume(err, val);
          } else if (typeof v2 === "object" && v2 !== null) {
            const key = typeof v0 === "object" && v0.tag !== undefined ? v0.tag : v0;
            resume(err, { ...v2, [key]: v1 });
          } else {
            resume([...err, "Type Error: expected v2 to be a record or object."], undefined);
          }
        });
      });
    });
  }
  NTH(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        const err = [...e0, ...e1];
        assert(typeof v0 === "number", "Type Error: expected v0 to be a number. Got " + (typeof v0));
        if (isRecord(v1)) {
          const rk = makeRecordKey("number", v0);
          const val = recordGet(v1, rk);
          resume(err, val);
        } else {
          assert(typeof v1 === "object", "Type Error: expected v1 to be an object. Got " + (typeof v1));
          const val = v1[v0];
          resume(err, val);
        }
      });
    });
  }
  PRINT(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      const err = e0;
      const val = {
        print: isRecord(v0) ? recordToPlainObject(v0) : v0,
      };
      resume(err, val);
    })
  }
  EQ(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        const err = [].concat(e0).concat(e1);
        try {
          const val = new Decimal(v0).equals(new Decimal(v1));
          resume(err, val);
        } catch (e) {
          resume([...err, `Error in EQ operation: ${e.message}`], false);
        }
      });
    });
  }
  GT(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        const err = [].concat(e0).concat(e1);
        try {
          const val = new Decimal(v0).greaterThan(new Decimal(v1));
          resume(err, val);
        } catch (e) {
          resume([...err, `Error in GT operation: ${e.message}`], false);
        }
      });
    });
  }
  GE(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        const err = [].concat(e0).concat(e1);
        try {
          const val = new Decimal(v0).greaterThanOrEqualTo(new Decimal(v1));
          resume(err, val);
        } catch (e) {
          resume([...err, `Error in GE operation: ${e.message}`], false);
        }
      });
    });
  }
  LE(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        const err = [].concat(e0).concat(e1);
        try {
          const val = new Decimal(v0).lessThanOrEqualTo(new Decimal(v1));
          resume(err, val);
        } catch (e) {
          resume([...err, `Error in LE operation: ${e.message}`], false);
        }
      });
    });
  }
  NE(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        const err = [].concat(e0).concat(e1);
        try {
          const val = !new Decimal(v0).equals(new Decimal(v1));
          resume(err, val);
        } catch (e) {
          resume([...err, `Error in NE operation: ${e.message}`], false);
        }
      });
    });
  }
  MIN(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        const err = [].concat(e0).concat(e1);
        try {
          const val = Decimal.min(new Decimal(v0), new Decimal(v1)).toNumber();
          resume(err, val);
        } catch (e) {
          resume([...err, `Error in MIN operation: ${e.message}`], NaN);
        }
      });
    });
  }
  MAX(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        const err = [].concat(e0).concat(e1);
        try {
          const val = Decimal.max(new Decimal(v0), new Decimal(v1)).toNumber();
          resume(err, val);
        } catch (e) {
          resume([...err, `Error in MAX operation: ${e.message}`], NaN);
        }
      });
    });
  }
  RANGE(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        this.visit(node.elts[2], options, (e2, v2) => {
          const err = [].concat(e0).concat(e1).concat(e2);
          try {
            const start = new Decimal(v0);
            const end = new Decimal(v1);
            const step = new Decimal(v2);
            if (step.isZero()) {
              resume([...err, 'Error in RANGE operation: step cannot be zero'], []);
              return;
            }
            const result = [];
            let current = start;
            if (step.isPositive()) {
              while (current.lessThan(end)) {
                result.push(current.toNumber());
                current = current.plus(step);
              }
            } else {
              while (current.greaterThan(end)) {
                result.push(current.toNumber());
                current = current.plus(step);
              }
            }
            resume(err, result);
          } catch (e) {
            resume([...err, `Error in RANGE operation: ${e.message}`], []);
          }
        });
      });
    });
  }
  NOT(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      const err = [].concat(e0);
      try {
        // Handle various falsy values explicitly
        if (v0 === null || v0 === undefined || v0 === 0 || v0 === "" || v0 === false) {
          resume(err, true);
        } else {
          resume(err, !v0);
        }
      } catch (e) {
        resume([...err, `Error in NOT operation: ${e.message}`], false);
      }
    });
  }
  EQUIV(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        const err = [].concat(e0).concat(e1);
        try {
          let val;
          if (isRecord(v0) && isRecord(v1)) {
            val = v0._entries.size === v1._entries.size &&
              [...v0._entries].every(([k, v]) => v1._entries.has(k) && v1._entries.get(k) === v);
          } else if (v0 !== null && v1 !== null && typeof v0 === "object" && typeof v1 === "object" && v0.tag !== undefined && v1.tag !== undefined && !v0.elts && !v1.elts) {
            val = v0.tag === v1.tag;
          } else {
            val = v0 === v1;
          }
          resume(err, val);
        } catch (e) {
          resume([...err, `Error in EQUIV operation: ${e.message}`], false);
        }
      });
    });
  }
  OR(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      // Short-circuit evaluation - if first argument is truthy, return true immediately
      if (v0) {
        resume(e0, true);
        return;
      }

      this.visit(node.elts[1], options, (e1, v1) => {
        const err = [].concat(e0).concat(e1);
        try {
          // Standard boolean OR operation
          const val = Boolean(v0) || Boolean(v1);
          resume(err, val);
        } catch (e) {
          resume([...err, `Error in OR operation: ${e.message}`], false);
        }
      });
    });
  }
  AND(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      // Short-circuit evaluation - if first argument is falsy, return false immediately
      if (!v0) {
        resume(e0, false);
        return;
      }

      this.visit(node.elts[1], options, (e1, v1) => {
        const err = [].concat(e0).concat(e1);
        try {
          // Standard boolean AND operation
          const val = Boolean(v0) && Boolean(v1);
          resume(err, val);
        } catch (e) {
          resume([...err, `Error in AND operation: ${e.message}`], false);
        }
      });
    });
  }
  HD(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      const err = [].concat(e0);
      try {
        if (!Array.isArray(v0)) {
          resume([...err, `Error in HD operation: expected an array, got ${typeof v0}`], null);
          return;
        }
        if (v0.length === 0) {
          resume([...err, `Error in HD operation: empty array has no head`], null);
          return;
        }
        // Return the first element of the array
        const val = v0[0];
        resume(err, val);
      } catch (e) {
        resume([...err, `Error in HD operation: ${e.message}`], null);
      }
    });
  }
  TL(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      const err = [].concat(e0);
      try {
        if (!Array.isArray(v0)) {
          resume([...err, `Error in TL operation: expected an array, got ${typeof v0}`], []);
          return;
        }
        if (v0.length === 0) {
          resume([...err, `Error in TL operation: empty array has no tail`], []);
          return;
        }
        // Return all elements except the first
        const val = v0.slice(1);
        resume(err, val);
      } catch (e) {
        resume([...err, `Error in TL operation: ${e.message}`], []);
      }
    });
  }
  LOG(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      const err = [].concat(e0);
      try {
        console.log(`LOG: ${v0}`);
        resume(err, v0);
      } catch (e) {
        resume([...err, `Error in LOG operation: ${e.message}`], null);
      }
    });
  }
  ISEMPTY(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      const err = [].concat(e0);
      try {
        if (!Array.isArray(v0)) {
          resume([...err, `Error in ISEMPTY operation: expected a list, got ${typeof v0}`], false);
          return;
        }
        resume(err, v0.length === 0);
      } catch (e) {
        resume([...err, `Error in ISEMPTY operation: ${e.message}`], false);
      }
    });
  }
  CONS(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        console.log(
          "CONS()",
          "v0=" + JSON.stringify(v0),
          "v1=" + JSON.stringify(v1),
        );
        const err = [].concat(e0).concat(e1);
        try {
          if (!Array.isArray(v1)) {
            resume([...err, `Error in CONS operation: expected a list, got ${typeof v1}`], [v0]);
            return;
          }
          resume(err, [v0, ...v1]);
        } catch (e) {
          resume([...err, `Error in CONS operation: ${e.message}`], []);
        }
      });
    });
  }
  APPEND(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        const err = [].concat(e0).concat(e1);
        try {
          if (!Array.isArray(v1)) {
            resume([...err, `Error in APPEND operation: expected a list, got ${typeof v1}`], [v0]);
            return;
          }
          resume(err, [...v1, v0]);
        } catch (e) {
          resume([...err, `Error in APPEND operation: ${e.message}`], []);
        }
      });
    });
  }
  LAST(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      const err = [].concat(e0);
      try {
        if (!Array.isArray(v0)) {
          resume([...err, `Error in LAST operation: expected an array, got ${typeof v0}`], null);
          return;
        }
        if (v0.length === 0) {
          resume([...err, `Error in LAST operation: empty array has no last element`], null);
          return;
        }
        const val = v0[v0.length - 1];
        resume(err, val);
      } catch (e) {
        resume([...err, `Error in LAST operation: ${e.message}`], null);
      }
    });
  }
  DROP(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        const err = [].concat(e0).concat(e1);
        try {
          if (!Array.isArray(v1)) {
            resume([...err, `Error in DROP operation: expected a list, got ${typeof v1}`], []);
            return;
          }
          const n = typeof v0 === 'number' ? v0 : Number(v0);
          resume(err, v1.slice(n));
        } catch (e) {
          resume([...err, `Error in DROP operation: ${e.message}`], []);
        }
      });
    });
  }
  TAKE(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        const err = [].concat(e0).concat(e1);
        try {
          if (!Array.isArray(v1)) {
            resume([...err, `Error in TAKE operation: expected a list, got ${typeof v1}`], []);
            return;
          }
          const n = typeof v0 === 'number' ? v0 : Number(v0);
          resume(err, v1.slice(0, n));
        } catch (e) {
          resume([...err, `Error in TAKE operation: ${e.message}`], []);
        }
      });
    });
  }
}

export class Renderer {
  [key: string]: any;
  constructor(data) {
    this.data = data;
  }
  render(options, resume) {
    // Convert internal record representation to plain JSON-compatible objects.
    const err = [];
    const val = deepConvertRecords(this.data);
    resume(err, val);
  }
}

function normalizeError(err) {
  if (typeof err === "string") return { message: err, from: -1, to: -1 };
  if (err && typeof err === "object") {
    let message = typeof err.message === "string" ? err.message
      : (err.message?.tag === "STR" ? err.message.elts[0]
      : (typeof err.error === "string" ? err.error : JSON.stringify(err.message || err)));
    return { message, from: err.from ?? -1, to: err.to ?? -1 };
  }
  return { message: String(err), from: -1, to: -1 };
}

function normalizeErrors(errs) {
  if (!Array.isArray(errs)) return [];
  return errs.filter(e => e != null && e !== "").map(normalizeError);
}

export class Compiler {
  [key: string]: any;
  constructor(config) {
    this.langID = config.langID;
    this.version = config.version;
    this.Checker = config.Checker || Checker;
    this.Transformer = config.Transformer || Transformer;
    this.Renderer = config.Renderer || Renderer;
  }
  compile(code, data, config, resume) {
    // Compiler takes an AST in the form of a node pool (code) and transforms it
    // into an object to be rendered on the client by the viewer for this
    // language.
    try {
      let options = {
        data: data,
        config: config,
        result: '',
      };
      const checker = new this.Checker(code);
      checker.check(options, (err, val) => {
        const normalized = normalizeErrors(err);
        if (normalized.length > 0) {
          resume(normalized);
        } else {
          const transformer = new this.Transformer(code);
          transformer.transform(options, (err, val) => {
            const normalized = normalizeErrors(err);
            if (normalized.length > 0) {
              resume(normalized, val);
            } else {
              const renderer = new this.Renderer(val);
              renderer.render(options, (err, val) => {
                resume(normalizeErrors(err), val);
              });
            }
          });
        }
      });
    } catch (x) {
      console.log("ERROR with code");
      console.log(x.stack);
      resume([{ message: "Compiler error", from: -1, to: -1 }]);
    }
  }
}
