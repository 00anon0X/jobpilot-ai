const fs = require('fs');
const path = require('path');
const pub = path.join(__dirname, '..', 'public');
for (const file of ['index.html','styles.css','app.js','privacy.html','terms.html']) {
  if (!fs.existsSync(path.join(pub, file))) throw new Error(`${file} missing`);
}
if (fs.existsSync(path.join(pub, 'jobpilot-ai-source.zip'))) throw new Error('public source zip should not be exposed');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
for (const needle of ['JobPilot AI','Generate preview','Create account','Privacy','Terms']) {
  if (!html.includes(needle)) throw new Error(`missing ${needle}`);
}
for (const forbidden of ['MadsLorentzen/ai-job-search','github.com/MadsLorentzen','Credits']) {
  if (html.includes(forbidden)) throw new Error(`visible attribution still present: ${forbidden}`);
}
console.log('smoke ok');
