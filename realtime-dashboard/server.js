const express = require('express');
const axios = require('axios');
const { MongoClient } = require('mongodb');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const cors = require('cors');
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = 3000;
app.use(cors());

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);
let collection;

async function connectDB() {
  await client.connect();
  const DB_NAME = process.env.DB_NAME;
  const database = client.db(DB_NAME);
  collection = database.collection("dataPoints");
  await collection.createIndex({ timestamp: 1 });
}
connectDB();

function resolveFuzzyTime(keyword) {
  const now = new Date();
  switch (keyword.toLowerCase()) {
    case 'today':
      return new Date(now.setHours(0, 0, 0, 0));
    case 'yesterday':
      return new Date(now.setDate(now.getDate() - 1));
    case 'last week':
      return new Date(now.setDate(now.getDate() - 7));
    case 'last month':
      return new Date(now.setMonth(now.getMonth() - 1));
    default:
      return null;
  }
}

function parseCondition(cond) {
  const mongoFilters = [];
  const normalizeField = field => field.toLowerCase();
  cond = cond.toLowerCase();

  // Handle natural phrasing like "show me coins that dropped below 50 recently"
  if (cond.includes('show me') && cond.includes('dropped below')) {
    const match = cond.match(/dropped below\s+([\d.]+)(?:\s+(\d+)\s*(mins?|minutes?|hours?|days?)\s*ago)?/);
    if (match) {
      const [, value, amountStr, unitRaw] = match;
      let cutoff;

      if (amountStr && unitRaw) {
        const amount = parseInt(amountStr);
        const unit = unitRaw.startsWith('min') ? 60000 :
          unitRaw.startsWith('hour') ? 3600000 :
            unitRaw.startsWith('day') ? 86400000 : null;
        if (unit) {
          cutoff = new Date(Date.now() - amount * unit);
        }
      } else {
        // Default to 1 hour if no time specified
        cutoff = new Date(Date.now() - 60 * 60 * 1000);
      }

      mongoFilters.push({ timestamp: { $gte: cutoff } });

      const coinFields = ['bitcoin', 'ethereum', 'bnb', 'xrp', 'sol'];
      mongoFilters.push({
        $or: coinFields.map(field => ({
          [field]: { $lt: parseFloat(value) }
        }))
      });
    }
  }

  // Handle synonyms for rising prices
if (cond.includes('rose above') || cond.includes('increased above')) {
  const match = cond.match(/(rose above|increased above)\s+([\d.]+)/);
  if (match) {
    const [, , value] = match;
    const coinFields = ['bitcoin', 'ethereum', 'bnb', 'xrp', 'sol'];
    mongoFilters.push({
      $or: coinFields.map(field => ({
        [field]: { $gt: parseFloat(value) }
      }))
    });
  }
}

// Handle synonyms for falling prices
if (cond.includes('fell under') || cond.includes('went below')) {
  const match = cond.match(/(fell under|went below)\s+([\d.]+)/);
  if (match) {
    const [, , value] = match;
    const coinFields = ['bitcoin', 'ethereum', 'bnb', 'xrp', 'sol'];
    mongoFilters.push({
      $or: coinFields.map(field => ({
        [field]: { $lt: parseFloat(value) }
      }))
    });
  }
}

  // Above / Below
  if (cond.includes('above')) {
    const match = cond.match(/(\w+)\s+above\s+([\d.]+)/);
    if (match) {
      const [, field, value] = match;
      mongoFilters.push({ [normalizeField(field)]: { $gt: parseFloat(value) } });
    }
  } else if (cond.includes('below')) {
    const match = cond.match(/(\w+)\s+below\s+([\d.]+)/);
    if (match) {
      const [, field, value] = match;
      mongoFilters.push({ [normalizeField(field)]: { $lt: parseFloat(value) } });
    }
  }

  // Between
  else if (cond.includes('between')) {
    const match = cond.match(/(\w+)\s+between\s+([\d.]+)\s+and\s+([\d.]+)/);
    if (match) {
      const [, field, low, high] = match;
      mongoFilters.push({ [normalizeField(field)]: { $gte: parseFloat(low), $lte: parseFloat(high) } });
    }
  }

  // Timestamp within last X units
  else if (cond.includes('timestamp within last')) {
    const match = cond.match(/timestamp within last (\d+)\s*(minutes?|hours?|days?)/);
    if (match) {
      const [, amountStr, unitRaw] = match;
      const amount = parseInt(amountStr);
      const unit = unitRaw.startsWith('minute') ? 60000 :
        unitRaw.startsWith('hour') ? 3600000 :
          unitRaw.startsWith('day') ? 86400000 : null;

      if (unit) {
        const cutoff = new Date(Date.now() - amount * unit);
        mongoFilters.push({ timestamp: { $gte: cutoff } });
      }
    }
  }

  // Timestamp after fuzzy
  else if (cond.startsWith('timestamp after')) {
    const timeStr = cond.replace(/timestamp after/i, '').replace(/['"]/g, '').trim();
    const fuzzy = resolveFuzzyTime(timeStr);
    const parsedDate = fuzzy || new Date(timeStr);
    if (!isNaN(parsedDate)) {
      mongoFilters.push({ timestamp: { $gte: parsedDate } });
    }
  }

  // Timestamp before fuzzy
  else if (cond.startsWith('timestamp before')) {
    const timeStr = cond.replace(/timestamp before/i, '').replace(/['"]/g, '').trim();
    const fuzzy = resolveFuzzyTime(timeStr);
    const parsedDate = fuzzy || new Date(timeStr);
    if (!isNaN(parsedDate)) {
      mongoFilters.push({ timestamp: { $lte: parsedDate } });
    }
  }

  // Fallback: > or <
  else if (cond.includes('>')) {
    const [field, value] = cond.split('>').map(s => s.trim());
    mongoFilters.push({ [normalizeField(field)]: { $gt: parseFloat(value) } });
  } else if (cond.includes('<')) {
    const [field, value] = cond.split('<').map(s => s.trim());
    mongoFilters.push({ [normalizeField(field)]: { $lt: parseFloat(value) } });
  }

  return mongoFilters;
}

app.get('/api/history', async (req, res) => {
  const filter = req.query.filter || '60m'; // Default to 1 hour

  const timeMap = {
    m: 60000,
    h: 60 * 60000,
    d: 24 * 60 * 60000,
    w: 7 * 24 * 60 * 60000,
    mo: 30 * 24 * 60 * 60000,
  };

  const match = filter.match(/^(\d+)(m|h|d|w|mo)$/);
  let cutoff;

  if (match) {
    const [, amountStr, unit] = match;
    const amount = parseInt(amountStr);
    const multiplier = timeMap[unit];

    if (multiplier) {
      cutoff = new Date(Date.now() - amount * multiplier);
    }
  }

  if (!cutoff) {
    // fallback to 1 hour
    cutoff = new Date(Date.now() - 60 * 60000);
  }

  const docs = await collection.find({ timestamp: { $gte: cutoff } }).sort({ timestamp: 1 }).toArray();
  res.json(docs);
});


app.get('/api/filter', async (req, res) => {
  const query = req.query.query || '';

  try {
    // Split by OR first
    const orGroups = query.split('OR').map(g => g.trim());

    const normalizeField = field => field.toLowerCase();

    const mongoQuery = {
      $or: orGroups.map(group => {
        // Inside each OR group, split by AND
        const andConditions = group.split('AND').map(c => c.trim());
        const mongoAnd = [];

        andConditions.forEach(cond => {
          mongoAnd.push(...parseCondition(cond));
        });

        return mongoAnd.length > 1 ? { $and: mongoAnd } : mongoAnd[0];
      })
    };

    const docs = await collection.find(mongoQuery).sort({ timestamp: -1 }).limit(100).toArray();
    res.json(docs);

  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Malformed query' });
  }
});

const binanceSockets = {
  bitcoin: new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@trade'),
  ethereum: new WebSocket('wss://stream.binance.com:9443/ws/ethusdt@trade'),
  bnb: new WebSocket('wss://stream.binance.com:9443/ws/bnbusdt@trade'),
  xrp: new WebSocket('wss://stream.binance.com:9443/ws/xrpusdt@trade'),
  sol: new WebSocket('wss://stream.binance.com:9443/ws/solusdt@trade')
};

const latestPrices = { bitcoin: null, ethereum: null, bnb: null, xrp: null, sol: null };

for (let key in binanceSockets) {
  binanceSockets[key].on('message', msg => {
    latestPrices[key] = parseFloat(JSON.parse(msg).p);
  });
}

async function emitCombined() {
  if (Object.values(latestPrices).every(v => v)) {
    const dataPoint = {
      timestamp: new Date(),
      bitcoin: latestPrices.bitcoin,
      ethereum: latestPrices.ethereum,
      bnb: latestPrices.bnb,
      xrp: latestPrices.xrp,
      sol: latestPrices.sol
    };

    if (collection) {
      await collection.insertOne(dataPoint);
      io.emit('newData', dataPoint);
    }
  }
}

setInterval(emitCombined, 5000);

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
