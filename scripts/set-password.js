import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../auth.js';

const configPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json');

function askHidden(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (s) => { if (!muted) rl.output.write(s); };
    rl.question(query, (answer) => {
      rl.output.write('\n');
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

const password = await askHidden('New admin password: ');
if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}
if ((await askHidden('Repeat password: ')) !== password) {
  console.error('Passwords do not match.');
  process.exit(1);
}

const config = JSON.parse(await readFile(configPath, 'utf8'));
config.auth = { passwordHash: await hashPassword(password) };
await writeFile(`${configPath}.tmp`, JSON.stringify(config, null, 2) + '\n');
await rename(`${configPath}.tmp`, configPath);
console.log('Password saved. It takes effect immediately; existing sessions stay logged in until they expire.');
