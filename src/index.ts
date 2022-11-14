import assert = require("assert");

// TODO: add support for Array and Map
type Value = string | number | null | boolean;

interface Literal {
  kind: "literal";
  value: string | number;
}

interface Identifier {
  kind: "id";
  name: string;
}

interface DotField {
  kind: ".";
  select: string;
}

interface Variable {
  kind: "$";
  name: string;
}

interface Symbol {
  kind: "(" | ")" | ":=" | "|" | "," | "=";
}

type Token = Literal | Identifier | DotField | Symbol | Variable;

function unescape(cString: string): string {
  return cString.replace(/\\(.)/g, (_, c) => {
    switch (c) {
      case "a":
        return "a";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "v":
        return "\v";
      case `\\`:
      case "'":
      case `"`:
        return c;
      default:
        throw new Error(`unsupported escape sequence: \\${c}`);
    }
  });
}

assert.strictEqual(unescape("foo"), "foo");
assert.strictEqual(unescape("foo\\tbar"), "foo\tbar");
assert.strictEqual(unescape("foo\\nbar"), "foo\nbar");

// TODO: this is a very naive implementation (for example, it doesn't handle hex or floating point numbers)
const goRegex =
  /\(|\)|:?=|,|\||\$(\w*)|([a-z]\w*)|\B`([^`]*)`\B|\B"((?:[^"\\]|\\.)*)"\B|([+-]?\d+)\b|(\B\.\B|(?:\.[a-z]\w*)+)|\/\*.*\*\/|\s+/gi;

function tokenize(action: string): Token[] {
  let index = 0;
  const tokens: Token[] = [];
  let match: RegExpExecArray | null;
  while ((match = goRegex.exec(action)) !== null) {
    if (match.index !== index) {
      break;
    }
    index += match[0].length;
    const token = match[0];
    if (
      token === "(" ||
      token === ")" ||
      token === ":=" ||
      token === "=" ||
      token === "," ||
      token === "|"
    ) {
      tokens.push({ kind: token });
    } else if (match[1] !== undefined) {
      tokens.push({ kind: "$", name: match[1] });
    } else if (match[2] !== undefined) {
      tokens.push({ kind: "id", name: match[2] });
    } else if (match[3] !== undefined) {
      tokens.push({ kind: "literal", value: match[3] });
    } else if (match[4] !== undefined) {
      tokens.push({ kind: "literal", value: unescape(match[4]) });
    } else if (match[5] !== undefined) {
      tokens.push({ kind: "literal", value: parseFloat(match[5]) });
    } else if (match[6] !== undefined) {
      assert(match[6].startsWith("."));
      tokens.push({ kind: ".", select: match[6].slice(1) });
    }
  }
  if (index !== action.length) {
    throw new Error(`syntax error: ${action.substring(index)} at ${index}`);
  }
  return tokens;
}

type FuncType = (args: Value[]) => Value;
type FuncMap = Map<string, FuncType>;

export function asNumber(value: Value): number {
  assert(typeof value === "number");
  return value;
}

export function asString(value: Value): string {
  assert(typeof value === "string");
  return value;
}

class Scope {
  constructor(
    readonly template: Template,
    public data: any,
    readonly parent?: Scope
  ) {}
  readonly variables = new Map<string, Value>();
  acc: Value | undefined;

  lookup(name: string): Value {
    const value = this.variables.get(name);
    if (value !== undefined) {
      return value;
    }
    if (this.parent !== undefined) {
      return this.parent.lookup(name);
    }
    throw new Error(`undefined variable "\$${name}"`);
  }
}

export class Template {
  constructor(readonly name?: string) {}

  readonly funcs: FuncMap = new Map();

  execute(textTemplate: string, data?: any): string {
    let scope = new Scope(this, data);
    // From https://pkg.go.dev/text/template:
    // "The input text for a template is UTF-8-encoded text in any format. "Actions"--data evaluations or control
    // structures--are delimited by "{{" and "}}"; all text outside actions is copied to the output unchanged."
    return textTemplate.replace(
      /(?:{{|\s*{{-\s)(.+?)(?:}}|\s-}}\s*)/g,
      (_, group) => {
        scope.acc = undefined;
        const tokens = tokenize(group);
        scope = evaluatePipeline(tokens, scope);
        if (tokens.length !== 0) {
          throw new Error(`syntax error: ${tokens[0]?.kind}`);
        }
        return scope.acc === undefined ? "" : sprint(scope.acc);
      }
    );
  }
}

assert.strictEqual(new Template().execute("{{23 -}} < {{- 45}}"), "23<45");

function evaluatePipeline(tokens: Token[], scope: Scope): Scope {
  scope = evaluateArg(tokens, scope)!;
  while (tokens[0]?.kind === "|") {
    tokens.shift();
    scope = evaluateArg(tokens, scope)!;
  }
  return scope;
}

function isEmpty(value: Value): boolean {
  // "The empty values are false, 0, any nil pointer or interface value, and any
  // array, slice, map, or string of length zero."
  return !value; // TODO: support array and map
}

assert(isEmpty(false));
assert(isEmpty(0));
assert(isEmpty(null));
assert(isEmpty(""));
assert(!isEmpty(true));
assert(!isEmpty(42));
assert(!isEmpty("foo"));

function toString(value: Value): string {
  return value === null ? "<nil>" : value.toString();
}

function sprint(...values: Value[]): string {
  return values.reduce((acc: string, value, index) => {
    // "Spaces are added between operands when neither is a string."
    const addSpace =
      typeof values[index - 1] !== "string" || typeof value !== "string";
    return acc + (index && addSpace ? " " : "") + toString(value);
  }, "");
}

assert.strictEqual(sprint(), "");
assert.strictEqual(sprint("foo", "bar"), "foobar");
assert.strictEqual(sprint(1, null, "3"), "1 <nil> 3");

function callBuiltinFunction(fn: string, ...args: Value[]): Value {
  switch (fn) {
    case "eq":
      assert(args.length >= 2);
      return args[0] === args[1];
    case "eq":
      // "For simpler multi-way equality tests, eq (only) accepts two or more arguments and compares the second and
      // subsequent to the first, returning in effect arg1==arg2 || arg1==arg3 || arg1==arg4 ..."
      assert(args.length >= 2);
      return args.reduce((prev, cur) => prev || args[0] == cur, false);
    case "ne":
      assert.strictEqual(args.length, 2);
      return args[0] != args[1];
    case "lt":
      assert.strictEqual(args.length, 2);
      assert(args[0] !== null);
      assert(args[1] !== null);
      return args[0] < args[1];
    case "le":
      assert.strictEqual(args.length, 2);
      assert(args[0] !== null);
      assert(args[1] !== null);
      return args[0] <= args[1];
    case "gt":
      assert.strictEqual(args.length, 2);
      assert(args[0] !== null);
      assert(args[1] !== null);
      return args[0] > args[1];
    case "ge":
      assert.strictEqual(args.length, 2);
      assert(args[0] !== null);
      assert(args[1] !== null);
      return args[0] >= args[1];
    case "and":
      assert(args.length >= 2);
      return args.reduce((prev, cur) => (isEmpty(prev) ? prev : cur));
    case "or":
      assert(args.length >= 2);
      return args.reduce((prev, cur) => (isEmpty(prev) ? cur : prev));
    case "print":
      assert(args.length >= 0);
      return sprint(...args);
    case "println":
      assert(args.length >= 0);
      return sprint(...args) + "\n";
    case "not":
      // "Returns the boolean negation of its single argument."
      assert.strictEqual(args.length, 1);
      return isEmpty(args[0]);
    case "len":
      assert.strictEqual(args.length, 1);
      return asString(args[0]).length; // TODO: support array and map
    case "call":
    case "printf":
    case "if":
    case "else":
    case "range":
    case "block":
    case "define":
    case "template":
    case "break":
    case "continue":
      throw new Error(`not implemented: ${fn}`);
    default:
      throw new Error(`function "${fn}" not defined`);
  }
}

assert.strictEqual(callBuiltinFunction("eq", 1, 1), true);
assert.strictEqual(callBuiltinFunction("eq", 1, 2), false);
assert.strictEqual(callBuiltinFunction("eq", 1, 1, 2), true);
assert.strictEqual(callBuiltinFunction("eq", 1, 2, 3), false);
assert.strictEqual(callBuiltinFunction("ne", 1, 1), false);
assert.strictEqual(callBuiltinFunction("ne", 1, 2), true);
assert.strictEqual(callBuiltinFunction("lt", 1, 2), true);
assert.strictEqual(callBuiltinFunction("lt", 2, 1), false);
assert.strictEqual(callBuiltinFunction("le", 1, 2), true);
assert.strictEqual(callBuiltinFunction("le", 2, 1), false);
assert.strictEqual(callBuiltinFunction("le", 1, 1), true);
assert.strictEqual(callBuiltinFunction("gt", 1, 2), false);
assert.strictEqual(callBuiltinFunction("gt", 2, 1), true);
assert.strictEqual(callBuiltinFunction("ge", 1, 2), false);
assert.strictEqual(callBuiltinFunction("ge", 2, 1), true);
assert.strictEqual(callBuiltinFunction("ge", 1, 1), true);
assert.strictEqual(callBuiltinFunction("and", 1, 2), 2);
assert.strictEqual(callBuiltinFunction("and", 0, 2), 0);
assert.strictEqual(callBuiltinFunction("and", 1, 0), 0);
assert.strictEqual(callBuiltinFunction("and", 0, 0), 0);
assert.strictEqual(callBuiltinFunction("or", 1, 2), 1);
assert.strictEqual(callBuiltinFunction("or", 0, 2), 2);
assert.strictEqual(callBuiltinFunction("or", 1, 0), 1);
assert.strictEqual(callBuiltinFunction("or", 0, 0), 0);
assert.strictEqual(callBuiltinFunction("print", 1, 2, 3), "1 2 3");
assert.strictEqual(callBuiltinFunction("println", 1, 2, 3), "1 2 3\n");
assert.strictEqual(callBuiltinFunction("not", 1), false);
assert.strictEqual(callBuiltinFunction("not", 0), true);
assert.strictEqual(callBuiltinFunction("not", null), true);
assert.strictEqual(callBuiltinFunction("not", false), true);
assert.strictEqual(callBuiltinFunction("not", true), false);
assert.strictEqual(callBuiltinFunction("len", "foo"), 3);

function evaluateArg(tokens: Token[], scope: Scope): Scope | null {
  let token = tokens.shift();
  if (token === undefined) {
    return null;
  }
  switch (token.kind) {
    case "literal":
      scope.acc = token.value;
      return scope;
    case "$":
      switch (tokens[0]?.kind) {
        // @ts-ignore to allow fallthrough
        case "=":
          assert(scope.lookup(token.name) !== undefined);
        case ":=":
          tokens.shift();
          scope = evaluatePipeline(tokens, scope);
          assert(scope.acc !== undefined);
          scope.variables.set(token.name, scope.acc);
          return scope;
        default:
          scope.acc = scope.lookup(token.name);
          return scope;
      }
    case ".":
      let dot = scope.data;
      if (token.select !== "") {
        const attrPath = token.select.split(".");
        for (const attr of attrPath) {
          dot = dot[attr];
        }
      }
      scope.acc = dot;
      return scope;
    case "id":
      switch (token.name) {
        case "nil":
          scope.acc = null;
          return scope;
        case "true":
          scope.acc = true;
          return scope;
        case "false":
          scope.acc = false;
          return scope;
        case "with":
          scope = new Scope(scope.template, scope.acc, scope);
          assert(evaluateArg(tokens, scope));
          scope.data = scope.acc;
          scope.acc = undefined;
          return scope;
        case "end":
          assert(scope.parent !== undefined);
          return scope.parent;
      }
      const acc = scope.acc;
      const args: Value[] = [];
      // FIXME: this is greedy, but Go's parsing is not
      while (evaluateArg(tokens, scope)) {
        assert(scope.acc !== undefined);
        args.push(scope.acc);
      }
      if (acc !== undefined) {
        args.push(acc);
      }
      const userFunc = scope.template.funcs.get(token.name);
      if (userFunc) {
        scope.acc = userFunc(args);
        return scope;
      }
      scope.acc = callBuiltinFunction(token.name, ...args);
      return scope;
    case "(":
      evaluatePipeline(tokens, scope);
      if (tokens.shift()?.kind !== ")") {
        throw new Error("unclosed left paren");
      }
      return scope;
    default:
      tokens.unshift(token);
      return null;
  }
}
