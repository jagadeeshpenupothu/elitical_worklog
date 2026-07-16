import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();

const page = await context.newPage();

await page.goto('https://elitical.sayukth.com');

console.log('\n====================================');
console.log('Login to Elitical.');
console.log('After you reach the HOME page,');
console.log('come back here and press ENTER.');
console.log('====================================\n');

await new Promise(resolve => process.stdin.once('data', resolve));

await context.storageState({
  path: '.elitical/storage-state.json'
});

console.log('✅ New storage-state.json saved.');

await browser.close();
process.exit(0);
