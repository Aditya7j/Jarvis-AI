const fs = require('fs');
let content = fs.readFileSync('src/lib/toolkit/query-normalize.ts', 'utf8');
// Check for { ... } stubs
const lines = content.split('\n');
let count = 0;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim() === '{ ... }') {
    count++;
    console.log('Found { ... } at line ' + i + ': ' + lines[i-1]?.substring(0, 60));
  }
}
console.log('Total { ... } stubs:', count);