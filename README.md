# 🍕 PizzaNav — Driver Portal

> Smart internal portal for Domino's delivery drivers.  
> Built by Jubayer. 100% free. No paid APIs.

---

## What it does

- 📦 **Auto-detects new orders** from the thermal printer
- 🏍️ **Driver checks out** with a 4-digit PIN
- 🗺️ **One-tap Google Maps** navigation (bicycle mode)
- 📞 **One-tap call** to customer
- ⏱️ **Live delivery timer** while on route
- ✅ **Mark as delivered** — time logged automatically
- 📊 **Performance stats** — deliveries today, avg time, best time

---

## Tech Stack (all free)

| Part | Tool |
|---|---|
| Backend | Node.js + Express |
| Database | SQLite (better-sqlite3) |
| Frontend | PWA (HTML/CSS/JS) |
| Real-time | Server-Sent Events (SSE) |
| Print capture | chokidar (file watcher) |

---

## Setup (Store PC)

### 1. Install Node.js
Download from https://nodejs.org (LTS version)

### 2. Clone / download this project
Put the folder somewhere on the PC, e.g. `C:\PizzaNav`

### 3. Install dependencies
```bash
cd C:\PizzaNav
npm install
```

### 4. Start the server
```bash
npm start
```

Server runs at: http://localhost:3000

---

## How drivers use it

1. Open browser on phone → go to `http://[STORE-PC-IP]:3000`
2. Enter 4-digit PIN
3. See pending orders → tap "Take This Order"
4. Tap "Open Maps" → Google Maps opens in bicycle mode
5. Deliver → tap "Mark as Delivered"
6. Check stats in the Stats tab

---

## Manager Dashboard

Open: `http://localhost:3000/manager.html`

- See all pending orders
- See which driver is delivering what
- Simulate incoming orders (for testing)
- Live updates via SSE

---

## Print Interceptor Setup (Phase 2)

This allows orders to appear **automatically** when the POS prints a receipt.

### Step 1: Set up virtual printer on store PC

1. Open **Control Panel → Devices and Printers**
2. Click **Add a printer**
3. Add a **Generic / Text Only** printer
4. Set output path to: `C:\PrintCapture\`
5. Create that folder

### Step 2: Configure POS to print to both printers
- Real thermal printer (as normal)
- Virtual printer (PizzaNav capture)

### Step 3: Start the watcher
```bash
node print-watcher.js
```

Every time the POS prints a receipt, PizzaNav automatically gets the order data.

---

## Demo Driver PINs

| Driver | PIN |
|---|---|
| Jubayer | 1234 |
| Ahmed | 2222 |
| Markus | 3333 |
| Sara | 4444 |

---

## Project Structure

```
pizzanav/
├── server.js           ← Backend (Express + SQLite)
├── print-watcher.js    ← Windows print job watcher
├── package.json
├── data/
│   └── pizzanav.db     ← Auto-created SQLite database
└── public/
    ├── index.html      ← Driver Portal (PWA)
    └── manager.html    ← Manager Dashboard
```



Built with 💙 for making delivery shifts smoother.
