const fs = require('fs');
let content = fs.readFileSync('src/lib/toolkit/query-normalize.ts', 'utf8');
console.log('Current lines:', content.split('\n').length);

// Check if canonicalPlaceOf and fuzzyPlaceOf are correctly placed
const hasIndiA = content.includes('india: \"India\"');
const hasFuzzy = content.includes('export function fuzzyPlaceOf');
const hasCanonical = content.includes('export function canonicalPlaceOf');
console.log('Has india alias:', hasIndiA);
console.log('Has fuzzyPlaceOf:', hasFuzzy);
console.log('Has canonicalPlaceOf:', hasCanonical);

// Check for the fuzzyPlaceOf function location
const fuzzyIdx = content.indexOf('export function fuzzyPlaceOf');
const canonicalIdx = content.indexOf('export function canonicalPlaceOf');
console.log('fuzzyPlaceOf at index:', fuzzyIdx);
console.log('canonicalPlaceOf at index:', canonicalIdx);

// Check the area around canonicalPlaceOf
if (canonicalIdx >= 0) {
  const snippet = content.substring(canonicalIdx, canonicalIdx + 200);
  console.log('canonicalPlaceOf snippet:', snippet.substring(0, 150));
}

// Check the area around fuzzyPlaceOf
if (fuzzyIdx >= 0) {
  const snippet = content.substring(fuzzyIdx, fuzzyIdx + 200);
  console.log('fuzzyPlaceOf snippet:', snippet.substring(0, 150));
}

// Check for the { ... } stubs
let stubCount = 0;
for (const line of content.split('\n')) {
  if (line.trim() === '{ ... }') stubCount++;
}
console.log('{ ... } stubs count:', stubCount);

// Check for return null placeholders in function signatures
let nullCount = 0;
for (const line of content.split('\n')) {
  if (line.includes('return null')) nullCount++;
}
console.log('return null occurrences:', nullCount);