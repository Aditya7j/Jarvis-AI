// Quick test for Bug 2: place-name typo
import { classifyKnowledgeQuery, canonicalPlaceOf } from "./src/lib/toolkit/query-normalize";

console.log("=== Bug 2: Place-name typo tests ===\n");

// Test 1: canonicalPlaceOf with "inida"
const c1 = canonicalPlaceOf("inida");
console.log(`canonicalPlaceOf("inida") = ${c1}`);

// Test 2: classifyKnowledgeQuery with "what is capital of inida"
const r2 = classifyKnowledgeQuery("what is capital of inida");
console.log(`\nclassifyKnowledgeQuery("what is capital of inida"):`);
console.log(`  kind: ${r2.kind}`);
console.log(`  place: ${r2.place}`);
console.log(`  canonicalPlace: ${r2.canonicalPlace}`);

// Test 3: canonicalPlaceOf with "india" (should be null since "india" not in PLACE_ALIASES)
const c3 = canonicalPlaceOf("india");
console.log(`\ncanonicalPlaceOf("india") = ${c3}`);

// Test 4: canonicalPlaceOf with "bharat" 
const c4 = canonicalPlaceOf("bharat");
console.log(`\ncanonicalPlaceOf("bharat") = ${c4}`);

// Test 5: Levenshtein distance from "inida" to all PLACE_ALIASES keys
import { levenshtein } from "./src/lib/toolkit/query-normalize";
const aliases = ["usa", "us", "u.s.", "america", "united states", "united states of america", "uk", "u.k.", "britain", "great britain", "united kingdom", "uae", "u.a.e.", "bharat", "hindustan"];
const key = "inida";
let bestMatch: { key: string; distance: number } | null = null;
for (const k of aliases) {
  const d = levenshtein(key, k);
  if (d <= 1) {
    if (!bestMatch || d < bestMatch.distance) {
      bestMatch = { key: k, distance: d };
    }
  }
}
console.log(`\nFuzzy match for "inida" (edit distance <= 1): ${bestMatch ? `best: "${bestMatch.key}" (dist ${bestMatch.distance})` : "no match"}`);

// Test 6: "who is the pm of inida"
const r6 = classifyKnowledgeQuery("who is the pm of inida");
console.log(`\nclassifyKnowledgeQuery("who is the pm of inida"):`);
console.log(`  kind: ${r6.kind}`);
console.log(`  place: ${r6.place}`);
console.log(`  canonicalPlace: ${r6.canonicalPlace}`);

// Test 7: "what is capital of bharat" (should work - bharat is in PLACE_ALIASES)
const r7 = classifyKnowledgeQuery("what is capital of bharat");
console.log(`\nclassifyKnowledgeQuery("what is capital of bharat"):`);
console.log(`  kind: ${r7.kind}`);
console.log(`  place: ${r7.place}`);
console.log(`  canonicalPlace: ${r7.canonicalPlace}`);

// Test 8: Non-typoed place still works
const r8 = classifyKnowledgeQuery("what is the capital of india?");
console.log(`\nclassifyKnowledgeQuery("what is the capital of india?"):`);
console.log(`  kind: ${r8.kind}`);
console.log(`  place: ${r8.place}`);
console.log(`  canonicalPlace: ${r8.canonicalPlace}`);