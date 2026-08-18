const fs = require('fs');
const content = fs.readFileSync('src/lib/toolkit/query-normalize.ts', 'utf8');

// Use esbuild-ish approach - just test the levenshtein logic manually
// Since we can't easily import the TypeScript module, let me compute manually
function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return prev[b.length];
}

const key = 'inida';
const aliases = ['usa', 'us', 'u.s.', 'america', 'united states', 'united states of america', 'uk', 'u.k.', 'britain', 'great britain', 'united kingdom', 'uae', 'u.a.e.', 'bharat', 'hindustan', 'india'];
console.log('Levenshtein distances from "inida":');
for (const k of aliases) {
  const d = levenshtein(key, k);
  console.log(`  "${k}": ${d}`);
}
console.log();
console.log('Distance 1 matches:', aliases.filter(k => levenshtein(key, k) === 1));