const fs = require('fs');
let content = fs.readFileSync('src/lib/toolkit/query-normalize.ts', 'utf8');
console.log('canonicalPlaceOf exported:', content.includes('export function canonicalPlaceOf'));
console.log('fuzzyPlaceOf exported:', content.includes('export function fuzzyPlaceOf'));
console.log('india alias:', content.includes('india: "India"'));
// Check if the file has the right structure
const lines = content.split('\n');
console.log('Total lines:', lines.length);
// Find key functions
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('canonicalPlaceOf') || lines[i].includes('fuzzyPlaceOf') || lines[i].includes('levenshtein')) {
    console.log('Line ' + i + ': ' + lines[i].substring(0, 60));
  }
}