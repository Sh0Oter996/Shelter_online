import fs from 'node:fs';

const readme = fs.readFileSync('README.md', 'utf8');
const start = readme.indexOf('```json');
const end = readme.indexOf('```', start + 7);
if (start < 0 || end < 0) throw new Error('JSON block not found in README');
const fromReadme = JSON.parse(readme.slice(start + 7, end));
const fromFile = JSON.parse(fs.readFileSync('database.rules.json', 'utf8'));

if (JSON.stringify(fromReadme) === JSON.stringify(fromFile)) {
    console.log('README rules match database.rules.json');
} else {
    console.log('MISMATCH');
    const a = JSON.stringify(fromReadme, null, 2).split('\n');
    const b = JSON.stringify(fromFile, null, 2).split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) {
            console.log('first diff line', i + 1);
            console.log('README:', a[i]);
            console.log('FILE  :', b[i]);
            break;
        }
    }
    process.exitCode = 1;
}
