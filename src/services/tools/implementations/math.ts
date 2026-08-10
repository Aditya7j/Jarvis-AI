/**
 * Math tools — safe, deterministic computation. The calculator uses the
 * eval-free expression parser; unit conversion uses the deterministic
 * conversion tables. Neither ever guesses.
 */

import { solveMathProblem } from "@/lib/toolkit/math";
import {
  convertUnit,
  listSupportedUnits,
  parseConversionRequest,
} from "@/lib/toolkit/convert";
import { numberArg, stringArg } from "../args";
import { validateConvertResult, validateMathResult } from "../validators";
import type { Tool } from "../types";

export const calculate: Tool = {
  definition: {
    name: "calculate",
    description:
      "Evaluate a math expression (e.g. '2 + 2', 'sqrt(16) * 3', '15% of 200'). Uses a safe parser, never eval.",
    category: "math",
    runtime: "any",
    parameters: [
      { name: "expression", type: "string", description: "The arithmetic expression to evaluate.", required: true },
    ],
    cacheable: true,
    cacheTtlMs: 60_000,
    timeoutMs: 2_000,
    validate: validateMathResult,
  },
  run: async (args) => {
    const expression = stringArg(args, "expression");
    if (!expression) throw new Error("The 'expression' argument is required.");
    const result = solveMathProblem(expression);
    return {
      expression: result.expression,
      value: result.value,
      formatted: result.formatted,
      reply: result.reply,
    };
  },
};

export const convertUnits: Tool = {
  definition: {
    name: "convert_units",
    description:
      "Convert a value between units (length, mass, temperature, speed, data, time). E.g. 5 km → miles, 32 Celsius → Fahrenheit.",
    category: "unit-conversion",
    runtime: "any",
    parameters: [
      { name: "value", type: "number", description: "The numeric amount to convert.", required: true },
      { name: "from", type: "string", description: "Source unit (e.g. km, kg, celsius).", required: true },
      { name: "to", type: "string", description: "Target unit (e.g. miles, lbs, fahrenheit).", required: true },
    ],
    cacheable: true,
    cacheTtlMs: 60_000,
    timeoutMs: 2_000,
    validate: validateConvertResult,
  },
  run: async (args) => {
    const value = numberArg(args, "value", NaN);
    const from = stringArg(args, "from");
    const to = stringArg(args, "to");
    if (!Number.isFinite(value)) throw new Error("The 'value' argument must be a number.");
    if (!from || !to) throw new Error("Both 'from' and 'to' units are required.");
    return convertUnit(value, from, to);
  },
};

export const parseUnitRequest: Tool = {
  definition: {
    name: "parse_unit_request",
    description:
      "Parse a free-text unit conversion request like 'convert 5 km to miles'. Returns the parsed value, from-unit and to-unit.",
    category: "unit-conversion",
    runtime: "any",
    cacheable: true,
    cacheTtlMs: 60_000,
    timeoutMs: 2_000,
  },
  run: async (args) => {
    const input = stringArg(args, "input");
    if (!input) throw new Error("The 'input' argument is required.");
    const parsed = parseConversionRequest(input);
    if (!parsed) throw new Error(`No unit conversion found in "${input}".`);
    return parsed;
  },
};

export const supportedUnits: Tool = {
  definition: {
    name: "list_supported_units",
    description: "List every unit JARVIS can convert.",
    category: "unit-conversion",
    runtime: "any",
    cacheable: true,
    cacheTtlMs: 300_000,
    timeoutMs: 2_000,
  },
  run: async () => ({ units: listSupportedUnits() }),
};

export const mathTools: Tool[] = [calculate, convertUnits, parseUnitRequest, supportedUnits];
