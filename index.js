require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const { RSI, CCI } = require('technicalindicators');
const TelegramBot = require('node-telegram-bot-api');

const TWELVE_KEY = process.env.TWELVEDATA_API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PORT = process.env.PORT || 3000;

// Tetapan Parameter
const SYMBOL = 'XAU/USD';
const INTERVAL = '30min'; // Timeframe H1
const RSI_PERIOD = 24;
const CCI_PERIOD = 24;

if (!TWELVE_KEY || !TELEGRAM_TOKEN || !CHAT_ID) {
  console.error('❌ Ralat: Sila pastikan .env diisi sepenuhnya.');
  process.exit(1);
}

const app = express();
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

let latestSignalData = {
  symbol: SYMBOL,
  interval: INTERVAL,
  signal: 'WAITING',
  price: 0,
  rsi: 0,
  cci: 0,
  time: '-',
  updatedAt: '-'
};

// =========================================================================
// FUNKSI SEMAKAN PASARAN (MARKET HOURS)
// =========================================================================
function isMarketOpen() {
  const now = new Date();
  // Tukar waktu ke Timezone Malaysia/Asia/Kuala_Lumpur
  const mytTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" }));
  const day = mytTime.getDay(); // 0 = Ahad, 1 = Isnin, ..., 6 = Sabtu
  const hours = mytTime.getHours();

  // Pasaran Forex/Gold tutup pada hari Sabtu & Ahad
  if (day === 6) return false; // Sabtu (Tutup penuh)
  if (day === 0) return false; // Ahad (Tutup penuh)

  // Isnin awal pagi (sebelum 6.00 AM MYT) biasanya pasaran belum aktif
  if (day === 1 && hours < 6) return false;

  // Jumaat malam/Sabtu awal pagi (selepas 5.00 AM MYT Sabtu) pasaran dah tutup
  if (day === 5 && hours >= 23) {
    // Menghampiri penutupan Jumaat malam
  }

  return true;
}

// =========================================================================
// STARTUP TELEGRAM ALERT
// =========================================================================
function sendStartupAlert() {
  const startupMsg = `🤖 *Bot Signal Trading Diaktifkan!*\n\n` +
                     `📌 *Symbol:* ${SYMBOL}\n` +
                     `⏱️ *Timeframe:* ${INTERVAL}\n` +
                     `📈 *Indicator:* RSI (${RSI_PERIOD}) + CCI (${CCI_PERIOD})\n` +
                     `🟢 *Status:* System Active with Auto Market-Sleep`;

  bot.sendMessage(CHAT_ID, startupMsg, { parse_mode: 'Markdown' })
    .then(() => console.log('✅ Telegram startup alert berjaya dihantar.'))
    .catch((err) => console.error('⚠️ Startup alert gagal dihantar:', err.message));
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/signal', (req, res) => {
  res.json(latestSignalData);
});

async function getCandles() {
  const url = `https://api.twelvedata.com/time_series?symbol=${SYMBOL}&interval=${INTERVAL}&outputsize=200&apikey=${TWELVE_KEY}`;
  const res = await axios.get(url);

  if (!res.data || !res.data.values) {
    throw new Error('TwelveData Error / Tiada Data: ' + JSON.stringify(res.data));
  }

  const reversed = [...res.data.values].reverse();
  return reversed.map(c => ({
    high: parseFloat(c.high),
    low: parseFloat(c.low),
    close: parseFloat(c.close),
    open: parseFloat(c.open),
    time: c.datetime
  }));
}

async function checkSignal() {
  // Semak jika pasaran tutup
  if (!isMarketOpen()) {
    console.log(`😴 [MARKET CLOSED] Pasaran sedang berehat (Hujung Minggu). Semakan diabaikan.`);
    latestSignalData.signal = 'MARKET CLOSED';
    latestSignalData.updatedAt = new Date().toLocaleTimeString();
    return;
  }

  try {
    const candles = await getCandles();
    if (candles.length < Math.max(RSI_PERIOD, CCI_PERIOD) + 10) {
      console.log('⚠️ Data tidak mencukupi untuk mengira RSI dan CCI.');
      return;
    }

    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);

    // Pengiraan RSI (24)
    const rsiValues = RSI.calculate({ period: RSI_PERIOD, values: closes });

    // Pengiraan CCI (24)
    const cciValues = CCI.calculate({
      period: CCI_PERIOD,
      high: highs,
      low: lows,
      close: closes
    });

    const currCandle = candles[candles.length - 1];
    const currRSI = rsiValues[rsiValues.length - 1];
    const currCCI = cciValues[cciValues.length - 1];

    let signal = 'WAITING';

    // Syarat Signal
    if (currRSI > 50 && currCCI > 100) {
      signal = 'BUY';
    } else if (currRSI < 50 && currCCI < -100) {
      signal = 'SELL';
    }

    latestSignalData = {
      symbol: SYMBOL,
      interval: INTERVAL,
      signal: signal,
      price: currCandle.close,
      rsi: currRSI.toFixed(2),
      cci: currCCI.toFixed(2),
      time: currCandle.time,
      updatedAt: new Date().toLocaleTimeString()
    };

    console.log(`[${currCandle.time}] Price: ${currCandle.close} | RSI24: ${currRSI.toFixed(2)} | CCI24: ${currCCI.toFixed(2)} | Status: ${signal}`);

    if (signal === 'BUY' || signal === 'SELL') {
      const emoji = signal === 'BUY' ? '🟢' : '🔴';
      const msg = `🚀 *SIGNAL TRADING RSI(24) + CCI(24)*\n\n` +
                  `📌 *Symbol:* ${SYMBOL} (${INTERVAL})\n` +
                  `🚦 *Signal:* *${signal} ${emoji}*\n` +
                  `💰 *Entry Price:* ${currCandle.close}\n` +
                  `📊 *RSI (24):* ${currRSI.toFixed(2)}\n` +
                  `📈 *CCI (24):* ${currCCI.toFixed(2)}\n` +
                  `🕒 *Masa:* ${currCandle.time}`;

      await bot.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
      console.log(`✅ Signal ${signal} telah dihantar ke Telegram.`);
    }

  } catch (err) {
    console.error('❌ Error checkSignal:', err.message);
  }
}

app.listen(PORT, () => {
  console.log(`🌐 Dashboard sedia di http://localhost:${PORT}`);
  sendStartupAlert();
  checkSignal();
  // Semakan dibuat setiap 30 minit sekali (1800000 ms)
  setInterval(checkSignal, 30 * 60 * 1000);
});
