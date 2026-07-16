import { chromium } from 'playwright';
import fs from 'node:fs/promises';

await fs.mkdir('.elitical/dump', { recursive: true });

const browser = await chromium.launch({ headless: false });

const context = await browser.newContext({
  storageState: '.elitical/storage-state.json'
});

const page = await context.newPage();

page.on('response', async (res) => {
  const url = res.url();

  if (!url.includes('/api/1/')) return;
  if (res.status() !== 200) return;

  try {
    const body = await res.text();

    const file =
      '.elitical/dump/' +
      Date.now() +
      '_' +
      url
        .replace(/^https?:\/\/[^/]+\//, '')
        .replace(/[\/?=&:]+/g, '_')
        .replace(/_+/g, '_') +
      '.json';

    await fs.writeFile(file, body);
    console.log('Saved:', file);
  } catch {}
});

await page.goto('https://elitical.sayukth.com/docket', {
  waitUntil: 'domcontentloaded'
});

console.log('');
console.log('===================================');
console.log('WAIT until all dockets are visible.');
console.log('Scroll once.');
console.log('Then press ENTER here.');
console.log('===================================');
console.log('');

await new Promise(resolve => process.stdin.once('data', resolve));

await browser.close();
