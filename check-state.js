const fs = require('fs');
const c = fs.readFileSync('src/lib/toolkit/query-normalize.ts', 'utf8');
console.log('fuzzyPlaceOf:', c.includes('fuzzyPlaceOf'));
console.log('canonicalPlaceOf:', c.includes('canonicalPlaceOf'));
console.log('india alias:', c.includes('india: "India"'));
console.log('FACT_LOOKUP_TERMS:', c.includes('FACT_LOOKUP_TERMS'));
console.log('lines:', c.split('\n').length);