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

/** Normalize spoken/written arithmetic into a machine-readable expression. */
export function normalizeExpression(input: string): string {
  let text = input.toLowerCase().trim();
  text = text.replace(/\bwhat(?:'s|\s+is)\s+(?:the\s+)?(?:value\s+of\s+)?/i, "");
  text = text.replace(/[?]/g, "");
  text = text.replace(/,/g, "");
  for (const [word, symbol] of Object.entries(WORD_OPERATORS)) {
    text = text.replace(new RegExp(`\\b${word}\\b`, "gi"), ` ${symbol} `);
  }
  text = text.replace(/\bsquare\s+root\s+of\b/gi, "sqrt(");
  text = text.replace(/\bcube\s+root\s+of\b/gi, "cbrt(");
  text = text.replace(/(sqrt|cbrt|sin|cos|tan|abs|ln|log10|log2|exp)\b\s+/gi, "$1(");
  text = text.replace(/percent\b/gi, "%");
  text = text.replace(/\bx\b/gi, "*");
  text = text.replace(/(\d)\s*%\s*of\s*(\d)/g, "($1/100)*$2");
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
    if (char === "p" || char === "e" || char === "t") {
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
      } else if (char === "%" && /\d/.test(this.input[this.pos + 1] ?? "")) {
        // Modulo between two numbers (e.g. 10 % 3).
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
