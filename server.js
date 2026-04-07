// ============================================================
// PizzaNav Backend Server
// Node.js + Express + SQLite (all free, no paid APIs)
// Run: node server.js
// ============================================================

const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const http = require('http');

const app = express();
const PORT = 3000;

// ── Database setup ──────────────────────────────────────────
const db = new Database('./data/pizzanav.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS drivers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    pin TEXT NOT NULL UNIQUE,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT,
    customer_name TEXT,
    address TEXT NOT NULL,
    phone TEXT,
    items TEXT,
    raw_text TEXT,
    status TEXT DEFAULT 'pending',
    driver_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    checked_out_at TEXT,
    delivered_at TEXT,
    FOREIGN KEY (driver_id) REFERENCES drivers(id)
  );

  CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    driver_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    started_at TEXT DEFAULT (datetime('now')),
    ended_at TEXT,
    FOREIGN KEY (driver_id) REFERENCES drivers(id)
  );
`);

// Seed demo drivers if empty
const driverCount = db.prepare('SELECT COUNT(*) as c FROM drivers').get();
if (driverCount.c === 0) {
  const insert = db.prepare('INSERT INTO drivers (name, pin) VALUES (?, ?)');
  insert.run('Jubayer', '1234');
  insert.run('Ahmed', '2222');
  insert.run('Markus', '3333');
  insert.run('Sara', '4444');
  console.log('✅ Demo drivers seeded (PINs: 1234, 2222, 3333, 4444)');
}

// ── Middleware ───────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── SSE: Real-time push to clients ──────────────────────────
let sseClients = [];

function pushEvent(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter(res => {
    try { res.write(msg); return true; }
    catch { return false; }
  });
}

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  res.write(`event: connected\ndata: {}\n\n`);
  sseClients.push(res);
  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
  });
});

// ── AUTH ─────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: 'PIN required' });
  const driver = db.prepare('SELECT * FROM drivers WHERE pin = ? AND active = 1').get(pin);
  if (!driver) return res.status(401).json({ error: 'Invalid PIN' });

  // Start shift if not already today
  const today = new Date().toISOString().split('T')[0];
  const existingShift = db.prepare('SELECT * FROM shifts WHERE driver_id = ? AND date = ?').get(driver.id, today);
  if (!existingShift) {
    db.prepare('INSERT INTO shifts (driver_id, date) VALUES (?, ?)').run(driver.id, today);
  }

  res.json({ success: true, driver: { id: driver.id, name: driver.name } });
});

// ── ORDERS ───────────────────────────────────────────────────

// Get pending orders (waiting to be assigned)
app.get('/api/orders/pending', (req, res) => {
  const orders = db.prepare(`
    SELECT * FROM orders WHERE status = 'pending' ORDER BY created_at DESC
  `).all();
  res.json(orders);
});

// Get orders assigned to a specific driver
app.get('/api/orders/driver/:driverId', (req, res) => {
  const orders = db.prepare(`
    SELECT * FROM orders 
    WHERE driver_id = ? AND status != 'delivered'
    ORDER BY checked_out_at DESC
  `).all(req.params.driverId);
  res.json(orders);
});

// Driver checks out an order (assigns it to themselves)
app.post('/api/orders/:orderId/checkout', (req, res) => {
  const { driverId } = req.body;
  const { orderId } = req.params;

  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND status = ?').get(orderId, 'pending');
  if (!order) return res.status(404).json({ error: 'Order not available' });

  db.prepare(`
    UPDATE orders 
    SET driver_id = ?, status = 'in_delivery', checked_out_at = datetime('now')
    WHERE id = ?
  `).run(driverId, orderId);

  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(driverId);

  pushEvent('order_assigned', { order: updated, driver: { id: driver.id, name: driver.name } });
  res.json({ success: true, order: updated });
});

// Driver marks as delivered
app.post('/api/orders/:orderId/delivered', (req, res) => {
  const { driverId } = req.body;
  const { orderId } = req.params;

  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND driver_id = ?').get(orderId, driverId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  db.prepare(`
    UPDATE orders 
    SET status = 'delivered', delivered_at = datetime('now')
    WHERE id = ?
  `).run(orderId);

  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);

  // Calculate delivery time in minutes
  if (updated.checked_out_at && updated.delivered_at) {
    const mins = Math.round(
      (new Date(updated.delivered_at) - new Date(updated.checked_out_at)) / 60000
    );
    pushEvent('order_delivered', { orderId, driverId, minutes: mins });
  }

  res.json({ success: true, order: updated });
});

// ── PRINT INTERCEPTOR ENDPOINT ───────────────────────────────
// The Windows print watcher script POSTs to this endpoint
app.post('/api/print/new', (req, res) => {
  const { raw_text } = req.body;
  if (!raw_text) return res.status(400).json({ error: 'No text provided' });

  const parsed = parseReceipt(raw_text);

  const result = db.prepare(`
    INSERT INTO orders (order_number, customer_name, address, phone, items, raw_text, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    parsed.order_number,
    parsed.customer_name,
    parsed.address,
    parsed.phone,
    parsed.items,
    raw_text
  );

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(result.lastInsertRowid);
  pushEvent('new_order', order);

  console.log(`📦 New order received: #${parsed.order_number} → ${parsed.address}`);
  res.json({ success: true, order });
});

// ── SIMULATE ORDER (for prototype demo) ─────────────────────
app.post('/api/simulate/order', (req, res) => {
  const sampleOrders = [
    {
      order_number: `DOM-${Math.floor(1000 + Math.random() * 9000)}`,
      customer_name: 'Thomas Müller',
      address: 'Bahnhofstraße 12, 33102 Paderborn',
      phone: '0176-12345678',
      items: 'Pizza Margherita x1, Cola 0.5L x2'
    },
    {
      order_number: `DOM-${Math.floor(1000 + Math.random() * 9000)}`,
      customer_name: 'Anna Schmidt',
      address: 'Westernstraße 44, 33098 Paderborn',
      phone: '0151-98765432',
      items: 'BBQ Chicken Pizza x2, Garlic Bread x1'
    },
    {
      order_number: `DOM-${Math.floor(1000 + Math.random() * 9000)}`,
      customer_name: 'Kemal Yıldız',
      address: 'Detmolder Str. 8, 33100 Paderborn',
      phone: '0162-55544433',
      items: 'Veggie Supreme x1, Cheesy Bites x1'
    },
    {
      order_number: `DOM-${Math.floor(1000 + Math.random() * 9000)}`,
      customer_name: 'Lars Jensen',
      address: 'Heierswall 3, 33102 Paderborn',
      phone: '0170-33322211',
      items: 'Pepperoni Passion x1, Tiramisu x2'
    }
  ];

  const sample = sampleOrders[Math.floor(Math.random() * sampleOrders.length)];

  const result = db.prepare(`
    INSERT INTO orders (order_number, customer_name, address, phone, items, raw_text, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    sample.order_number,
    sample.customer_name,
    sample.address,
    sample.phone,
    sample.items,
    `DOMINO'S PIZZA\n${sample.order_number}\n${sample.customer_name}\n${sample.address}\n${sample.phone}\n${sample.items}`
  );

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(result.lastInsertRowid);
  pushEvent('new_order', order);

  console.log(`🧪 Simulated order: #${sample.order_number}`);
  res.json({ success: true, order });
});

// ── STATS ────────────────────────────────────────────────────
app.get('/api/stats/:driverId', (req, res) => {
  const id = req.params.driverId;
  const today = new Date().toISOString().split('T')[0];

  const todayDeliveries = db.prepare(`
    SELECT * FROM orders 
    WHERE driver_id = ? AND status = 'delivered' AND date(delivered_at) = ?
  `).all(id, today);

  const allDeliveries = db.prepare(`
    SELECT * FROM orders WHERE driver_id = ? AND status = 'delivered'
  `).all(id);

  // Calculate avg delivery time
  const times = allDeliveries
    .filter(o => o.checked_out_at && o.delivered_at)
    .map(o => Math.round((new Date(o.delivered_at) - new Date(o.checked_out_at)) / 60000));

  const avgTime = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null;
  const bestTime = times.length ? Math.min(...times) : null;

  // This week
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const weekDeliveries = db.prepare(`
    SELECT * FROM orders 
    WHERE driver_id = ? AND status = 'delivered' AND date(delivered_at) >= ?
  `).all(id, weekAgo);

  res.json({
    today: {
      count: todayDeliveries.length,
      deliveries: todayDeliveries
    },
    week: {
      count: weekDeliveries.length
    },
    all_time: {
      count: allDeliveries.length,
      avg_time_minutes: avgTime,
      best_time_minutes: bestTime
    }
  });
});

// ── MANAGER: All drivers overview ───────────────────────────
app.get('/api/manager/overview', (req, res) => {
  const today = new Date().toISOString().split('T')[0];

  const drivers = db.prepare('SELECT * FROM drivers WHERE active = 1').all();
  const result = drivers.map(d => {
    const todayCount = db.prepare(`
      SELECT COUNT(*) as c FROM orders 
      WHERE driver_id = ? AND status = 'delivered' AND date(delivered_at) = ?
    `).get(d.id, today);

    const active = db.prepare(`
      SELECT * FROM orders WHERE driver_id = ? AND status = 'in_delivery'
    `).get(d.id);

    return {
      ...d,
      pin: undefined, // never expose PIN
      today_deliveries: todayCount.c,
      current_order: active || null
    };
  });

  const pending = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'pending'").get();

  res.json({ drivers: result, pending_orders: pending.c });
});

// ── RECEIPT PARSER ───────────────────────────────────────────
function parseReceipt(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);

  let order_number = null;
  let customer_name = null;
  let address = null;
  let phone = null;
  let items = [];

  // Order number
  const orderMatch = text.match(/(?:order|bestellung|nr\.?|#)\s*[:\-]?\s*([A-Z0-9\-]+)/i);
  if (orderMatch) order_number = orderMatch[1];

  // Phone
  const phoneMatch = text.match(/(?:\+49|0)[\d\s\-\/]{9,15}/);
  if (phoneMatch) phone = phoneMatch[0].trim();

  // German address pattern: "Street Number, ZIP City"
  for (let i = 0; i < lines.length - 1; i++) {
    const streetMatch = lines[i].match(/^(.+?)\s+(\d+\s*[a-zA-Z]?)$/);
    const cityMatch = lines[i + 1]?.match(/^(\d{5})\s+(.+)$/);
    if (streetMatch && cityMatch) {
      address = `${lines[i]}, ${lines[i + 1]}`;
      // Customer name is likely just before the address
      if (i > 0 && /^[A-ZÄÖÜ][a-zäöü]/.test(lines[i - 1])) {
        customer_name = lines[i - 1];
      }
      break;
    }
  }

  // Fallback: single line with ZIP
  if (!address) {
    for (const line of lines) {
      if (/\d{5}/.test(line) && /[a-zA-ZäöüÄÖÜ]/.test(line) && line.length > 8) {
        address = line;
        break;
      }
    }
  }

  // Items (lines after address that look like food)
  let capturing = false;
  for (const line of lines) {
    if (/pizza|pasta|cola|bread|salad|wings|garlic|cheesy|tiramisu|chicken/i.test(line)) {
      items.push(line);
      capturing = true;
    }
  }

  return {
    order_number: order_number || `ORD-${Date.now()}`,
    customer_name: customer_name || 'Customer',
    address: address || 'Address not detected',
    phone: phone || null,
    items: items.join(', ') || null
  };
}

// ── START ────────────────────────────────────────────────────
const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║      🍕 PizzaNav Server Running      ║
╠══════════════════════════════════════╣
║  Local:   http://localhost:${PORT}       ║
║  Portal:  http://localhost:${PORT}       ║
║  Manager: http://localhost:${PORT}/manager.html ║
╚══════════════════════════════════════╝

Demo driver PINs:
  Jubayer → 1234
  Ahmed   → 2222
  Markus  → 3333
  Sara    → 4444
  `);
});
