/**
 * Safe math toolkit. A recursive-descent expression parser with no `eval`,
 * used by the calculator tool so JARVIS can compute verified arithmetic and
 * never executes arbitrary strings.
 */

export interface MathResult {
  expression: string;
  value: number;
  formatted: string;
}

const UNARY_FUNCTIONS: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  ln: Math.log,
  log10: Math.log10,
  log2: Math.log2,
  exp: Math.exp,
};

const BINARY_FUNCTIONS: Record<string, (a: number, b: number) => number> = {
  pow: Math.pow,
  min: Math.min,
  max: Math.max,
};

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
};

const WORD_OPERATORS: Record<string, string> = {
  "divided by": "/",
  "to the power of": "^",
  plus: "+",
  minus: "-",
  times: "*",
  over: "/",
  "multiplied by": "*",
  "modulo": "%",
  "mod": "%",
};

const FUNCTION_CALL =
  /\b(square\s+root|cube\s+root|sqrt|cbrt|sin|cos|tan|abs|ln|log10|log2|exp)\b(?:\s+of)?\s+(-?\d+(?:\.\d+)?)\b/gi;

/** Normalize spoken/written arithmetic into a machine-readable expression. */
export function normalizeExpression(input: string): string {
  let text = input.toLowerCase().trim();
  // Strip polite framing ("i ask you what is sqrt of 16", "can you tell me
  // 2+2") so the arithmetic survives to the parser.
  const COURTESY_FRAMES: RegExp[] = [
    /^hey\s+jarvis\s*,?\s+/i,
    /^i\s+(?:ask|want|would\s+like)\s+you(?:\s+to)?\s+/i,
    /^(?:can|could|would)\s+you\s+(?:please\s+)?(?:tell\s+me\s+|answer\s+|solve\s+|calculate\s+|compute\s+|work\s+out\s+)/i,
    /^please\s+(?:tell\s+me\s+|answer\s+|solve\s+|calculate\s+|compute\s+|work\s+out\s+)/i,
    /^tell\s+me\s+/i,
  ];
  for (const frame of COURTESY_FRAMES) {
    text = text.replace(frame, "");
  }
  text = text.replace(/\bwhat(?:'s|s|\s+is|\s+are)\s+(?:the\s+)?(?:value\s+of\s+)?/i, "");
  text = text.replace(/[?]/g, "");
  text = text.replace(/,/g, "");
  text = text.replace(
    /\b(?:kitna\s+(?:hoga|hua|hai)|kya\s+(?:aayega|hoga|hua|hai))\b/gi,
    " "
  );
  text = text.replace(
    /(?:कितना\s+होगा|कितना\s+हुआ|क्या\s+आएगा|क्या\s+होगा|क्या\s+हुआ|क्या\s+है|गणना\s+करो)/gu,
    " "
  );
  text = text.replace(
    /(\d+)\s*(गुना|जोड़|भाग|घटा)\s*(\d+)/gu,
    (_m, a: string, op: string, b: string) =>
      `${a} ${({ "गुना": "*", "जोड़": "+", "भाग": "/", "घटा": "-" } as Record<string, string>)[op]} ${b}`
  );
  text = text.replace(
    /(\d+)\s*(guna|jod|bhag|ghata)\s*(\d+)/gi,
    (_m, a: string, op: string, b: string) =>
      `${a} ${({ guna: "*", jod: "+", bhag: "/", ghata: "-" } as Record<string, string>)[op.toLowerCase()]} ${b}`
  );
  for (const [word, symbol] of Object.entries(WORD_OPERATORS)) {
    text = text.replace(new RegExp(`\\b${word}\\b`, "gi"), ` ${symbol} `);
  }
  // "divide 20 by 4" -> "20 / 4"
  text = text.replace(
    /\bdivide\s+(-?\d+(?:\.\d+)?)\s+by\s+(-?\d+(?:\.\d+)?)\b/gi,
    "$1 / $2"
  );
  // "square root of 81" / "sqrt 16" / "sin 30" -> "sqrt(81)" / "sqrt(16)" / "sin(30)"
  text = text.replace(FUNCTION_CALL, (_match, fn: string, num: string) => {
    const name = fn.trim().replace(/\s+/g, " ");
    const key = name === "square root" ? "sqrt" : name === "cube root" ? "cbrt" : name;
    return `${key}(${num})`;
  });
  text = text.replace(/percent\b/gi, "%");
  text = text.replace(/×/g, "*");
  text = text.replace(/÷/g, "/");
  text = text.replace(/\bx\b/gi, "*");
  text = text.replace(/([\d.]+)\s*%\s*of\s*([\d.]+)/g, "($1/100)*$2");
  text = text.replace(/(\d)\s+and\s+(\d)/g, "$1 + $2");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

class Parser {
  private pos = 0;
  constructor(private readonly input: string) {}

  private peek(): string {
    while (this.pos < this.input.length && this.input[this.pos] === " ") this.pos++;
    return this.input[this.pos] ?? "";
  }

  private next(): string {
    const char = this.peek();
    this.pos++;
    return char;
  }

  private parsePrimary(): number {
    const char = this.peek();
    if (char === "(") {
      this.next();
      const value = this.parseExpression();
      if (this.next() !== ")") throw new Error("Missing closing parenthesis");
      return value;
    }
    if (/[a-z]/i.test(char)) {
      const ident = this.parseIdentifier();
      const constant = CONSTANTS[ident];
      if (constant === undefined) {
        const unary = UNARY_FUNCTIONS[ident];
        if (unary) {
          this.expect("(");
          const arg = this.parseExpression();
          this.expect(")");
          return unary(arg);
        }
        const binary = BINARY_FUNCTIONS[ident];
        if (binary) {
          this.expect("(");
          const first = this.parseExpression();
          this.expect(",");
          const second = this.parseExpression();
          this.expect(")");
          return binary(first, second);
        }
        throw new Error(`Unknown function or constant: ${ident}`);
      }
      return constant;
    }
    return this.parseNumber();
  }

  private parseIdentifier(): string {
    let ident = "";
    while (/[a-z]/i.test(this.input[this.pos] ?? "")) {
      ident += this.input[this.pos++];
    }
    return ident;
  }

  private parseNumber(): number {
    let raw = "";
    if (this.peek() === "-" || this.peek() === "+") raw += this.next();
    let digits = 0;
    while (/[0-9]/.test(this.peek() ?? "")) {
      raw += this.next();
      digits++;
    }
    if (this.peek() === ".") {
      raw += this.next();
      while (/[0-9]/.test(this.peek() ?? "")) {
        raw += this.next();
        digits++;
      }
    }
    if (digits === 0) throw new Error("Expected a number");
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error("Invalid number");
    return value;
  }

  private parsePostfix(): number {
    let value = this.parsePrimary();
    for (;;) {
      const char = this.peek();
      if (char === "!") {
        this.next();
        value = factorial(value);
      } else if (char === "%") {
        // Percent postfix ("50%" -> 0.5), unless a second operand follows
        // ("10 % 3" is modulo, handled by parseTerm).
        const afterModulo = this.input.slice(this.pos + 1).replace(/^\s+/, "");
        if (/\d/.test(afterModulo[0] ?? "")) break;
        this.next();
        value = value / 100;
      } else {
        break;
      }
    }
    return value;
  }

  private parseUnary(): number {
    const char = this.peek();
    if (char === "-") {
      this.next();
      return -this.parseUnary();
    }
    if (char === "+") {
      this.next();
      return this.parseUnary();
    }
    return this.parsePostfix();
  }

  private parsePower(): number {
    const base = this.parseUnary();
    if (this.peek() === "^") {
      this.next();
      const exponent = this.parsePower();
      return Math.pow(base, exponent);
    }
    return base;
  }

  private parseTerm(): number {
    let value = this.parsePower();
    for (;;) {
      const char = this.peek();
      if (char === "*") {
        this.next();
        value *= this.parsePower();
      } else if (char === "/") {
        this.next();
        const divisor = this.parsePower();
        if (divisor === 0) throw new Error("Division by zero");
        value /= divisor;
      } else if (char === "%") {
        // Modulo between two numbers (e.g. 10 % 3). Skip whitespace when
        // deciding whether a second operand follows.
        const afterModulo = this.input.slice(this.pos + 1).replace(/^\s+/, "");
        if (!/\d/.test(afterModulo[0] ?? "")) break;
        this.next();
        value %= this.parsePower();
      } else {
        break;
      }
    }
    return value;
  }

  private parseExpression(): number {
    let value = this.parseTerm();
    for (;;) {
      const char = this.peek();
      if (char === "+") {
        this.next();
        value += this.parseTerm();
      } else if (char === "-") {
        this.next();
        value -= this.parseTerm();
      } else {
        break;
      }
    }
    return value;
  }

  private expect(char: string): void {
    if (this.next() !== char) {
      throw new Error(`Expected "${char}"`);
    }
  }

  parse(): number {
    if (this.input.length === 0) throw new Error("Empty expression");
    const value = this.parseExpression();
    while (this.pos < this.input.length) {
      if (this.input[this.pos] === " ") this.pos++;
      else throw new Error(`Unexpected character at ${this.pos}: "${this.input[this.pos]}"`);
    }
    if (!Number.isFinite(value)) throw new Error("Result is not finite");
    return value;
  }
}

function factorial(n: number): number {
  if (n < 0 || !Number.isInteger(n)) throw new Error("Factorial requires a non-negative integer");
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

function formatValue(value: number): string {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  if (Number.isInteger(rounded)) return String(rounded);
  const formatted = rounded.toLocaleString("en-US", { maximumFractionDigits: 6 });
  return formatted;
}

/** Evaluate a human expression like "2 + 2" or "sqrt(16) * 3". Throws on error. */
export function evaluateExpression(expression: string): MathResult {
  const normalized = normalizeExpression(expression);
  const value = new Parser(normalized).parse();
  return {
    expression: normalized,
    value,
    formatted: formatValue(value),
  };
}
