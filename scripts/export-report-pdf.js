// Convert docs/exec-report-2026-06-30/REPORT.md → REPORT.pdf
// Run: node scripts/export-report-pdf.js
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const { chromium } = require('playwright');

const REPORT_DIR = path.resolve(__dirname, '..', 'docs', 'exec-report-2026-06-30');
const MD = path.join(REPORT_DIR, 'REPORT.md');
const PDF = path.join(REPORT_DIR, 'REPORT.pdf');

const md = fs.readFileSync(MD, 'utf-8');
const body = marked(md, { breaks: false, gfm: true });

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Mizuhada Report</title>
<style>
  @page { size: A4; margin: 18mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; color: #1f2937; line-height: 1.55; max-width: 800px; margin: 0 auto; font-size: 12pt; }
  h1 { font-size: 22pt; border-bottom: 2px solid #0284c7; padding-bottom: 6px; margin-top: 0; }
  h2 { font-size: 16pt; color: #0284c7; margin-top: 24pt; page-break-after: avoid; }
  h3 { font-size: 13pt; margin-top: 18pt; page-break-after: avoid; }
  h4 { font-size: 12pt; margin-top: 12pt; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 18pt 0; }
  p  { margin: 6pt 0; }
  img { max-width: 100%; height: auto; display: block; margin: 8pt auto; border: 1px solid #e5e7eb; border-radius: 4px; page-break-inside: avoid; }
  table { width: 100%; border-collapse: collapse; margin: 8pt 0; font-size: 10pt; }
  th, td { border: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; }
  th { background: #f3f4f6; font-weight: 600; }
  code { background: #f3f4f6; padding: 1px 4px; border-radius: 3px; font-family: 'Consolas', monospace; font-size: 10pt; }
  pre  { background: #f3f4f6; padding: 10px; border-radius: 4px; overflow-x: auto; }
  strong { color: #111827; }
  ul, ol { margin: 6pt 0; padding-left: 22pt; }
  li { margin: 2pt 0; }
  blockquote { border-left: 3px solid #0284c7; margin: 8pt 0; padding: 4pt 12pt; color: #4b5563; background: #f9fafb; }
  h2 + p, h3 + p { margin-top: 4pt; }
</style></head>
<body>${body}</body></html>`;

(async () => {
  const htmlPath = path.join(REPORT_DIR, 'REPORT.html');
  fs.writeFileSync(htmlPath, html, 'utf-8');

  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto('file:///' + htmlPath.replace(/\\/g, '/'), { waitUntil: 'networkidle' });
    await page.pdf({
      path: PDF,
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', bottom: '18mm', left: '14mm', right: '14mm' },
    });
    console.log('Wrote', PDF);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
