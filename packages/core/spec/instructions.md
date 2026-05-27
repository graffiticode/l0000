<!-- SPDX-License-Identifier: CC-BY-4.0 -->
**Note:** This document trains the dialect-specific code-generation model. It is not a guide for client AI agents. Client agents must not write Graffiticode directly — describe the intended behavior in natural language and let the Graffiticode backend generate the code.

# Core Graffiticode Instructions

This is the core Graffiticode language — a functional language with prefix notation, first-class lambdas, pattern matching, and immutable data.

## Response Requirements

- **IMPORTANT**: Whatever the user request is, the response should always be a complete Graffiticode program terminated with `..`.
- Programs consist of zero or more `let` declarations followed by a single top-level expression, all terminated with `..`.

## Program Structure

```
let name = value..
expression..
```

### Minimal example

```
add 1 2..
```

### With let bindings

```
let double = <x: mul 2 x>..
map (double) [1 2 3]..
```

## Syntax Rules

- **Prefix notation**: Functions are applied by writing the function name followed by its arguments: `add 1 2`
- **Fixed arity**: Every function has a known number of parameters, so applications parse unambiguously without grouping: `add 1 mul 2 3` parses as `add(1, mul(2, 3))`
- **Parentheses defer application**: `map (double) [1 2 3]` passes `double` as a value rather than applying it
- **Program terminator**: Every program ends with `..`
- **Let terminator**: Every `let` binding ends with `..`
- **Comments**: Block comments are enclosed in `/* ... */`

## Data Types

- **Numbers**: `42`, `3.14`, `-1`
- **Strings**: `"hello"`
- **Booleans**: `true`, `false`
- **Lists**: `[1 2 3]`
- **Records**: `{name: "Alice", age: 30}`
- **Tags**: `tag red`, `tag foo`
- **Lambdas**: `<x: add x 1>`, `<x y: add x y>`

## Tags

Tag values are symbolic constants created with the `tag` keyword:

```
let red = tag red..
let blue = tag blue..
```

Tags have value semantics — same name means same tag. Tags can be matched in `case` expressions:

```
let color = tag red..
case color of
  red: "warm"
  blue: "cool"
  _: "other"
end..
```

## Pattern Matching

```
case x of
  0: "zero"
  1: "one"
  _: "other"
end
```

Supports:
- Literal values
- Tag values (matched by identity)
- Tuple destructuring: `(a, b)`
- Record destructuring: `{ name, age }`
- Wildcard `_`

## Record Shorthand

Fields where the value is a variable of the same name can use shorthand:

```
let x = 1..
let y = 2..
{x y z: 3}..
```

This is equivalent to `{x: 1, y: 2, z: 3}`.

## Available Functions

| Function | Signature | Description |
| :------- | :-------- | :---------- |
| `add` | `<number number: number>` | Adds two numbers |
| `and` | `<bool bool: bool>` | Logical AND |
| `append` | `<any list: list>` | Appends an element to the end of a list |
| `apply` | `<function list: any>` | Applies a function to a list of arguments |
| `concat` | `<string\|list string\|list: string\|list>` | Concatenates two strings or two lists |
| `cons` | `<any list: list>` | Prepends an element to a list |
| `data` | `<record: record>` | Returns upstream task data, or the argument if none. Argument may be a record literal (e.g. `data {x: 1}`) or `use "<lang>"` to declare the upstream language |
| `div` | `<number number: number>` | Divides numbers |
| `drop` | `<integer list: list>` | Returns a list with the first n elements removed |
| `eq` | `<number number: bool>` | Numeric equality |
| `equiv` | `<any any: bool>` | Semantic equivalence for any type, including tags |
| `filter` | `<function list: list>` | Keeps items matching predicate |
| `ge` | `<number number: bool>` | Greater than or equal |
| `get` | `<string record: any>` | Retrieves a value from a record by key |
| `get-val-private` | `<string: string>` | Resolves a named variable, encrypted at parse time and decrypted at compile time |
| `get-val-public` | `<string: string>` | Resolves a named variable as plain text |
| `get-var` | `<string: any>` | Gets the value of a named variable |
| `gt` | `<number number: bool>` | Greater than |
| `hd` | `<list: any>` | First item of list |
| `isempty` | `<list: bool>` | Returns true if the list is empty |
| `json` | `<string: any>` | Parses a string as JSON |
| `last` | `<list: any>` | Returns the last element of a list |
| `le` | `<number number: bool>` | Less than or equal |
| `length` | `<list\|string: integer>` | Returns the length of a list or string |
| `log` | `<any: any>` | Logs to console and returns the value |
| `lt` | `<number number: bool>` | Less than |
| `map` | `<function list: list>` | Applies function to each item |
| `max` | `<number number: number>` | Returns the larger of two numbers |
| `min` | `<number number: number>` | Returns the smaller of two numbers |
| `mod` | `<number number: number>` | Remainder of division |
| `mul` | `<number number: number>` | Multiplies numbers |
| `ne` | `<number number: bool>` | Not equal |
| `not` | `<bool: bool>` | Logical NOT |
| `nth` | `<number list: any>` | Nth element of list (0-based) |
| `or` | `<bool bool: bool>` | Logical OR |
| `pow` | `<number number: number>` | Raises first number to the power of second |
| `print` | `<any: record>` | Outputs a value to the form |
| `range` | `<number number number: list>` | Generates a range list (start, end, step) |
| `reduce` | `<function any list: any>` | Combines list using a reducer with initial value |
| `set` | `<string any record: record>` | Returns a new record with a key set to a value |
| `set-var` | `<string any: any>` | Sets a named variable to a value |
| `sub` | `<number number: number>` | Subtracts numbers |
| `take` | `<integer list: list>` | Returns the first n elements of a list |
| `tl` | `<list: list>` | All items except first |
| `use` | `<string: record>` | Inside `data`, declares the upstream language whose output is expected (e.g. `data use "0166"`). Evaluates to `{}` when no upstream is bound |

## Examples

### Arithmetic
```
add 1 mul 2 3..
```

### List operations
```
let nums = [1 2 3 4 5]..
let evens = filter (<x: eq 0 mod x 2>) nums..
reduce (<a b: add a b>) 0 evens..
```

### Record manipulation
```
let person = {name: "Alice", age: 30}..
set "age" 31 person..
```

### Pattern matching with tags
```
let red = tag red..
let blue = tag blue..
let color = red..
case color of
  red: "warm"
  blue: "cool"
  _: "unknown"
end..
```

### Higher-order functions
```
let double = <x: mul 2 x>..
let inc = <x: add x 1>..
map (double) map (inc) [1 2 3]..
```
