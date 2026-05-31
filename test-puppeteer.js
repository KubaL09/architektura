const puppeteer = require('puppeteer');
const fs = require('fs');

async function test() {
  console.log('Launching Puppeteer...');
  const start = Date.now();
  
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    timeout: 30000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox', 
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--no-first-run'
    ]
  });
  
  console.log(`Browser launched in ${Date.now() - start}ms`);
  
  const page = await browser.newPage();
  await page.setContent('<h1>Hello World</h1><p>Test PDF</p>', { 
    waitUntil: 'domcontentloaded',
    timeout: 15000 
  });
  
  console.log(`Content set in ${Date.now() - start}ms`);
  
  const pdfBuffer = await page.pdf({
    format: 'A4',
    printBackground: true,
    timeout: 15000
  });
  
  console.log(`PDF generated in ${Date.now() - start}ms, size: ${pdfBuffer.length} bytes`);
  
  fs.writeFileSync('test-output.pdf', pdfBuffer);
  console.log('PDF written to test-output.pdf');
  
  await browser.close();
  console.log(`Done in ${Date.now() - start}ms`);
}

test().catch(err => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
