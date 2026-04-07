// ============================================================
// PizzaNav — Windows Print Job Watcher
// 
// HOW IT WORKS:
// 1. You install a "Microsoft Print to PDF" or "Generic Text" 
//    virtual printer on the store PC
// 2. The POS sends the print job to BOTH:
//    - Real thermal printer (normal receipt)
//    - Virtual printer (text file saved to a folder)
// 3. This script watches that folder for new files
// 4. When a new file appears, it reads the text and sends
//    it to the PizzaNav server as a new order
//
// SETUP:
// 1. Install Node.js on store PC
// 2. npm install chokidar axios
// 3. node print-watcher.js
// ============================================================

const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ── CONFIG ───────────────────────────────────────────────────
const WATCH_FOLDER = 'C:\\PrintCapture';   // folder where virtual printer saves files
const SERVER_URL = 'http://localhost:3000'; // PizzaNav server URL
const PROCESSED_LOG = './processed.json';  // track already-sent files
// ─────────────────────────────────────────────────────────────

// Load processed files log
let processed = new Set();
if (fs.existsSync(PROCESSED_LOG)) {
  try {
    const data = JSON.parse(fs.readFileSync(PROCESSED_LOG, 'utf8'));
    processed = new Set(data);
  } catch {}
}

function saveProcessed() {
  fs.writeFileSync(PROCESSED_LOG, JSON.stringify([...processed]));
}

console.log(`
╔═══════════════════════════════════════╗
║    🖨️  PizzaNav Print Watcher         ║
╠═══════════════════════════════════════╣
║  Watching: ${WATCH_FOLDER.padEnd(28)}║
║  Server:   ${SERVER_URL.padEnd(28)}║
╚═══════════════════════════════════════╝
`);

// Watch for new .txt or .prn files
const watcher = chokidar.watch(WATCH_FOLDER, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: {
    stabilityThreshold: 500,
    pollInterval: 100
  }
});

watcher.on('add', async (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.txt', '.prn', '.pdf', ''].includes(ext)) return;
  if (processed.has(filePath)) return;

  console.log(`📄 New print job detected: ${path.basename(filePath)}`);

  // Wait a moment for file to finish writing
  await new Promise(r => setTimeout(r, 300));

  try {
    let raw_text = '';

    // Read the file as text
    try {
      raw_text = fs.readFileSync(filePath, 'utf8');
    } catch {
      // Try latin-1 for older printers
      raw_text = fs.readFileSync(filePath, 'latin1');
    }

    // Clean up ESC/POS control characters
    raw_text = raw_text
      .replace(/\x1b\[[0-9;]*[mABCDHfJKlh]/g, '')  // ANSI escapes
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '') // control chars
      .replace(/\x1b./g, '')  // ESC sequences
      .trim();

    if (raw_text.length < 10) {
      console.log('⚠️  File too short, skipping');
      return;
    }

    console.log(`📝 Extracted text (${raw_text.length} chars), sending to server...`);
    console.log('─'.repeat(40));
    console.log(raw_text.substring(0, 200));
    console.log('─'.repeat(40));

    // Send to PizzaNav server
    const response = await axios.post(`${SERVER_URL}/api/print/new`, { raw_text });

    if (response.data.success) {
      const order = response.data.order;
      console.log(`✅ Order created: #${order.order_number} → ${order.address}`);
      processed.add(filePath);
      saveProcessed();
    }

  } catch (err) {
    console.error(`❌ Error processing ${path.basename(filePath)}:`, err.message);
  }
});

watcher.on('error', err => console.error('Watcher error:', err));

console.log('👀 Watching for print jobs... (Press Ctrl+C to stop)\n');

// ── MANUAL TEST ─────────────────────────────────────────────
// Uncomment to test without a printer:
// setTimeout(async () => {
//   const testReceipt = `
//     DOMINO'S PIZZA PADERBORN
//     ========================
//     Order: DOM-9921
//     
//     Kunde / Customer:
//     Max Mustermann
//     Bahnhofstraße 12
//     33102 Paderborn
//     Tel: 0176-12345678
//     
//     BESTELLUNG / ORDER:
//     1x Pizza Margherita       8.99
//     2x Cola 0.5L              3.98
//     ========================
//     TOTAL: 12.97 EUR
//     Danke / Thank you!
//   `;
//   const res = await axios.post(`${SERVER_URL}/api/print/new`, { raw_text: testReceipt });
//   console.log('Test order sent:', res.data.order);
// }, 2000);
