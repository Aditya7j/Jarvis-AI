/**
 * Safe math toolkit. A recursive-descent expression parser with no `eval`,
 * used by the calculator tool so JARVIS can compute verified arithmetic and
 * never executes arbitrary strings.
 */

export interface MathResult {
  expression: string;
  value: number;
  formatted: string;
  /**
   * A complete, ready-to-show sentence for word problems ("The net percentage
   * change is -4% (a 4% decrease).", "x = 27"). Absent for plain expressions.
   */
  reply?: string;
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

const WORD_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};
const WORD_NUMBER_ALT = Object.keys(WORD_NUMBERS).join("|");

/** "seventeen" -> 17, "twenty five" -> 25, "three hundred" -> 300. */
function wordNumberToValue(text: string): number | null {
  let value = 0;
  let current = 0;
  for (const token of text.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (token === "and") continue;
    if (!(token in WORD_NUMBERS)) return null;
    const n = WORD_NUMBERS[token];
    if (n === 100) current = (current === 0 ? 1 : current) * 100;
    else current += n;
  }
  value += current;
  return value;
}

/**
 * Convert word numbers ("seventeen", "fifty") into digits, but ONLY inside an
 * arithmetic phrase where the right side is a digit or a word number too.
 * This keeps "three times yesterday" untouched while turning "five times
 * three" and "seventeen percent of 9300" into arithmetic.
 */
function convertWordNumbers(input: string): string {
  let text = input;
  const pair = (op: string) => (whole: string, a: string, b: string) => {
    const na = wordNumberToValue(a);
    if (na === null) return whole;
    const nbIsDigit = /^\d+$/.test(b.trim());
    const nb = nbIsDigit ? Number(b.replace(/\s+/g, "")) : wordNumberToValue(b);
    if (!nbIsDigit && nb === null) return whole;
    return `${na} ${op} ${nb}`;
  };
  for (const op of ["times", "plus", "minus", "multiplied by", "divided by"]) {
    text = text.replace(new RegExp(`\\b([a-z]+(?:\\s+${WORD_NUMBER_ALT})*)\\s+${op}\\s+([a-z0-9]+(?:\\s+${WORD_NUMBER_ALT})*)\\b`, "i"), pair(op));
  }
  text = text.replace(
    new RegExp(`\\b([a-z]+(?:\\s+${WORD_NUMBER_ALT})*)\\s+percent\\s+of\\s+([a-z0-9]+(?:\\s+${WORD_NUMBER_ALT})*)\\b`, "i"),
    pair("percent of")
  );
  return text;
}

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
    /^(?:solve|evaluate|calculate|compute|work\s+out)\s*[:,-]?\s+/i,
  ];
  for (const frame of COURTESY_FRAMES) {
    text = text.replace(frame, "");
  }
  text = text.replace(/\bwhat(?:'s|s|\s+is|\s+are)\s+(?:the\s+)?(?:value\s+of\s+)?/i, "");
  text = text.replace(/[?]/g, "");
  text = text.replace(/,/g, "");
  text = convertWordNumbers(text);
  text = text.replace(
    /\b(?:kitna\s+(?:hoga|hua|hai)|kya\s+(?:aayega|hoga|hua|hai))\b/gi,
    " "
  );
  text = text.replace(
    /(?:कितना\s+होगा|कितना\s+हुआ|क्या\s+आएगा|क्या\s+होगा|क्या\s+हुआ|क्या\s+है|गणना\s+करो)/gu,
    " "
  );
  // Hinglish "compute" commands ("ginti karo 15*4", "hisab karo 12/3",
  // "calculate karo 2+2", "15*4 batao"). Word-bounded so English words and
  // digits are never touched; the trailing-anchor variants only match at the
  // end of the input. "karo"/"kijiye"/... are also stripped wherever they
  // appear because the courtesy frames above may already have consumed the
  // English verb ("calculate karo 2+2" → "karo 2+2").
  text = text.replace(
    /\b(?:ginti|hisab|hisaab)\s+(?:karke\s+)?(?:karo|kijiye|kare|kar\s+do|kardo|batao|bataiye|nikalo|nikal\s+do)\b/gi,
    " "
  );
  text = text.replace(
    /\b(?:calculate|compute|solve|evaluate)\s+(?:karo|kijiye|kare|kar\s+do|kardo|do)\b/gi,
    " "
  );
  text = text.replace(/\b(?:karo|kijiye|kare|kardo|kar\s+do)\b/gi, " ");
  text = text.replace(/\b(?:batao|bataiye|nikalo|nikal\s+do|kar\s+do|kardo|karo|kijiye)\s*$/gi, " ");
  // Devanagari "compute" commands — must run before the गुना/जोड़/भाग/घटा
  // operator mapping below so "5 गुना करो 3" collapses to "5 गुना 3" first.
  // "करोड़" (crore) is untouched because the alternation matches exactly "करो".
  text = text.replace(
    /(?:गिनती\s+करो|गिनती\s+कीजिए|हिसाब\s+करो|हिसाब\s+निकालो|बताओ|निकालो|करो|कीजिए)/gu,
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
  // Hinglish "144 ka square root" -> "sqrt(144)"
  text = text.replace(
    /\b(-?\d+(?:\.\d+)?)\s+ka\s+(?:square\s+root|sqrt|vargamul|varg\s+mul)\b/gi,
    "sqrt($1)"
  );
  text = text.replace(
    /\b(-?\d+(?:\.\d+)?)\s+ka\s+(?:cube\s+root|cbrt)\b/gi,
    "cbrt($1)"
  );
  // Powers: superscripts, "squared"/"cubed", "square of N"/"cube of N",
  // Hinglish "37 ka square" / "37 ka cube".
  text = text.replace(/²/g, " ^2 ");
  text = text.replace(/³/g, " ^3 ");
  text = text.replace(/\b(-?\d+(?:\.\d+)?)\s+squared\b/gi, "$1 ^2");
  text = text.replace(/\b(-?\d+(?:\.\d+)?)\s+cubed\b/gi, "$1 ^3");
  text = text.replace(/\bsquare\s+of\s+(-?\d+(?:\.\d+)?)\b/gi, "$1 ^2");
  text = text.replace(/\bcube\s+of\s+(-?\d+(?:\.\d+)?)\b/gi, "$1 ^3");
  text = text.replace(/\b(-?\d+(?:\.\d+)?)\s+ka\s+(?:square|varg)\b/gi, "$1 ^2");
  text = text.replace(/\b(-?\d+(?:\.\d+)?)\s+ka\s+cube\b/gi, "$1 ^3");
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

/** A math problem stated in words (percent change / equations / Hinglish). */
export type MathProblem =
  | {
      kind: "percent-change";
      ops: Array<{ dir: "increase" | "decrease"; pct: number }>;
    }
  | { kind: "increase-amount"; dir: "increase" | "decrease"; base: number; pct: number }
  | { kind: "percent-of"; base: number; pct: number }
  | { kind: "equation"; a: number; b: number; c: number };

const PERCENT_OP =
  /\b(?:increased?|decreased?|rose|fell|rises|falls|changed|changes)\s+by\s+(\d+(?:\.\d+)?)\s*%/gi;
const NET_CHANGE_CUE =
  /\b(?:net|overall|total)\s+(?:percentage\s+change|percent\s+change|change|effect|impact)\b/i;
const INCREASE_BASE_EN =
  /\b(?:increased?|decreased?)\s+(-?\d[\d,]*(?:\.\d+)?)\s+by\s+(\d+(?:\.\d+)?)\s*%/i;
const INCREASE_BASE_HI =
  /\b(-?\d[\d,]*(?:\.\d+)?)\s+ko\s+(\d+(?:\.\d+)?)\s*%\s+(?:increase|decrease|badhao|badha\s+do|ghatao|ghata\s+do|kam\s+karo)\b/i;
const INCREASE_BASE_DEVANAGARI =
  /(-?\d[\d,]*)\s+(?:को)\s+(\d+(?:\.\d+)?)\s*%\s+(?:बढ़ाओ|बढ़ा\s+दो|घटाओ|घटा\s+दो|कम\s+करो)/u;
const PERCENT_OF_HI = /\b(-?\d[\d,]*(?:\.\d+)?)\s+ka\s+(\d+(?:\.\d+)?)\s*(?:percent|%)/i;
const PERCENT_OF_DEVANAGARI = /(-?\d[\d,]*)\s+का\s+(\d+(?:\.\d+)?)\s*%/u;
const EQUATION_X_FIRST = /\bx\s*([+-]\s*\d+(?:\.\d+)?)?\s*=\s*(-?\d+(?:\.\d+)?)\b/i;
const EQUATION_RHS = /\bx\s*=\s*(.+)$/i;
const EQUATION_AX_B =
  /\b(-?\d+(?:\.\d+)?)\s*(?:\*)?\s*x\s*([+-]\s*\d+(?:\.\d+)?)?\s*=\s*(-?\d+(?:\.\d+)?)\b/i;
const PRIME_FACTORIZATION =
  /\b(?:prime\s+factorization|prime\s+factorisation|prime\s+factors)\s+of\s+(\d+)\b/i;

/**
 * A question/command cue. A bare statement ("The price increased by 20%") is
 * NOT a math request — only a question or explicit compute command is.
 */
const WORD_PROBLEM_CUE =
  /^(?:increase|decrease)\b|\b(?:what|how\s+much|net|overall|total|find|calculate|compute|solve|result|kya|kitna|karo|kijiye|batao|nikaalo|nikalo)\b/i;

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function fmtPct(value: number): string {
  return formatValue(value) + "%";
}

/**
 * Parse a math problem stated in words. Returns null when the text is not a
 * recognizable problem. Used by the intent classifier and the math tool.
 */
export function parseMathProblem(input: string): MathProblem | null {
  const text = input.trim().replace(/[.?!]+$/, "");

  const incEn = text.match(INCREASE_BASE_EN);
  if (incEn) {
    return {
      kind: "increase-amount",
      dir: /decreas/i.test(incEn[0]) ? "decrease" : "increase",
      base: Number(incEn[1].replace(/,/g, "")),
      pct: Number(incEn[2]),
    };
  }
  const incHi = text.match(INCREASE_BASE_HI);
  if (incHi) {
    return {
      kind: "increase-amount",
      dir: /(?:decrease|ghata|kam)/i.test(incHi[3]) ? "decrease" : "increase",
      base: Number(incHi[1].replace(/,/g, "")),
      pct: Number(incHi[2]),
    };
  }
  const incDe = text.match(INCREASE_BASE_DEVANAGARI);
  if (incDe) {
    return {
      kind: "increase-amount",
      dir: /घट|कम/.test(incDe[3]) ? "decrease" : "increase",
      base: Number(incDe[1].replace(/,/g, "")),
      pct: Number(incDe[2]),
    };
  }
  const pctOfHi = text.match(PERCENT_OF_HI);
  if (pctOfHi) {
    return {
      kind: "percent-of",
      base: Number(pctOfHi[1].replace(/,/g, "")),
      pct: Number(pctOfHi[2]),
    };
  }
  const pctOfDe = text.match(PERCENT_OF_DEVANAGARI);
  if (pctOfDe) {
    return {
      kind: "percent-of",
      base: Number(pctOfDe[1].replace(/,/g, "")),
      pct: Number(pctOfDe[2]),
    };
  }

  const ops: Array<{ dir: "increase" | "decrease"; pct: number }> = [];
  for (const match of text.matchAll(PERCENT_OP)) {
    ops.push({
      dir: /increas|rose|rises/i.test(match[0]) ? "increase" : "decrease",
      pct: Number(match[1]),
    });
  }
  if (ops.length >= 2 && WORD_PROBLEM_CUE.test(text)) {
    return { kind: "percent-change", ops };
  }
  if (ops.length === 1 && NET_CHANGE_CUE.test(text)) {
    return { kind: "percent-change", ops };
  }

  const axShape = text.match(EQUATION_AX_B);
  if (axShape) {
    return {
      kind: "equation",
      a: Number(axShape[1]),
      b: axShape[2] ? Number(axShape[2].replace(/\s+/g, "")) : 0,
      c: Number(axShape[3]),
    };
  }
  const xShape = text.match(EQUATION_X_FIRST);
  if (xShape) {
    return {
      kind: "equation",
      a: 1,
      b: xShape[1] ? Number(xShape[1].replace(/\s+/g, "")) : 0,
      c: Number(xShape[2]),
    };
  }

  return null;
}

/**
 * Solve a math problem, whether it is a plain expression or one stated in
 * words. Throws when the input is not a math problem at all.
 */
export function solveMathProblem(input: string): MathResult {
  const text = input.trim();
  try {
    return evaluateExpression(text);
  } catch {
    // Not a plain expression — try word-problem forms below.
  }

  const pf = text.match(PRIME_FACTORIZATION);
  if (pf) {
    const n = Number(pf[1]);
    const factors = primeFactors(n);
    return {
      expression: text,
      value: n,
      formatted: String(n),
      reply: `The prime factorization of ${n} is ${formatPrimeFactorization(factors)}.`,
    };
  }

  // "x = 15 - 42" / "Find x = 2 + 3 * 4" — x alone on the left, evaluate the RHS.
  const xEquals = text.match(EQUATION_RHS);
  if (xEquals) {
    try {
      const rhs = evaluateExpression(xEquals[1]);
      return {
        expression: text,
        value: rhs.value,
        formatted: rhs.formatted,
        reply: `x = ${rhs.formatted}`,
      };
    } catch {
      // RHS is not a plain expression — fall through to the general solver.
    }
  }

  const problem = parseMathProblem(text);
  if (!problem) throw new Error(`Could not parse a math problem from: "${input}"`);

  if (problem.kind === "percent-change") {
    let multiplier = 1;
    for (const op of problem.ops) {
      multiplier *= op.dir === "increase" ? 1 + op.pct / 100 : 1 - op.pct / 100;
    }
    const netPct = round6((multiplier - 1) * 100);
    const direction = netPct === 0 ? "change" : netPct < 0 ? "decrease" : "increase";
    const magnitude = Math.abs(netPct);
    return {
      expression: text,
      value: netPct,
      formatted: fmtPct(netPct),
      reply:
        direction === "change"
          ? "The net percentage change is 0%."
          : `The net percentage change is ${fmtPct(netPct)} (a ${formatValue(magnitude)}% ${direction}).`,
    };
  }

  if (problem.kind === "increase-amount") {
    const factor = problem.dir === "increase" ? 1 + problem.pct / 100 : 1 - problem.pct / 100;
    const result = round6(problem.base * factor);
    return {
      expression: text,
      value: result,
      formatted: formatValue(result),
      reply: `${problem.base} ${problem.dir === "increase" ? "increased" : "decreased"} by ${problem.pct}% is ${formatValue(result)}.`,
    };
  }

  if (problem.kind === "percent-of") {
    const result = round6((problem.pct / 100) * problem.base);
    return {
      expression: text,
      value: result,
      formatted: formatValue(result),
      reply: `${problem.pct}% of ${problem.base} is ${formatValue(result)}.`,
    };
  }

  const x = round6((problem.c - problem.b) / problem.a);
  return {
    expression: text,
    value: x,
    formatted: formatValue(x),
    reply: `x = ${formatValue(x)}`,
  };
}

/** Prime factors of an integer ≥ 2 (e.g. 2100 -> [2, 2, 3, 5, 5, 7]). */
function primeFactors(n: number): number[] {
  if (!Number.isInteger(n) || n < 2) {
    throw new Error("Prime factorization requires an integer greater than 1");
  }
  const factors: number[] = [];
  let x = n;
  for (let p = 2; p * p <= x; p++) {
    while (x % p === 0) {
      factors.push(p);
      x /= p;
    }
  }
  if (x > 1) factors.push(x);
  return factors;
}

/** Render factors as "2² × 3 × 5² × 7". */
function formatPrimeFactorization(factors: number[]): string {
  const counts = new Map<number, number>();
  for (const factor of factors) {
    counts.set(factor, (counts.get(factor) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([prime, count]) => (count === 1 ? `${prime}` : `${prime}²`))
    .join(" × ");
}
