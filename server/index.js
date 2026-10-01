import express from 'express';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import { Bot, InlineKeyboard } from 'grammy';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const DB_TMP_PATH = DB_PATH + '.tmp';
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {}
}
loadEnv();

const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || 'development';
const WEB_APP_URL = process.env.WEB_APP_URL || `http://localhost:${PORT}`;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_IDS = new Set((process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean));

let db = {
  users: {},
  history: [],
  promo: {},
  jackpots: { main: 500000 },
  blackjackRounds: {},
  minesRounds: {},
  crashRounds: {},
  market: null
};

const CURRENCY_DEFS = {
  USD: { code: 'USD', name: 'US Dollar', symbol: '$' },
  EUR: { code: 'EUR', name: 'Euro', symbol: '€' },
  GBP: { code: 'GBP', name: 'British Pound', symbol: '£' },
  JPY: { code: 'JPY', name: 'Japanese Yen', symbol: '¥' },
  CHF: { code: 'CHF', name: 'Swiss Franc', symbol: '₣' },
  KZT: { code: 'KZT', name: 'Kazakhstani Tenge', symbol: '₸' },
  CAD: { code: 'CAD', name: 'Canadian Dollar', symbol: 'C$' },
  AUD: { code: 'AUD', name: 'Australian Dollar', symbol: 'A$' }
};
const FX_URL = 'https://api.frankfurter.dev/v2/rates?base=USD&quotes=' + Object.keys(CURRENCY_DEFS).filter(c => c !== 'USD').join(',');
const FX_REFRESH_MS = 10 * 60 * 1000;

const GAME_ECONOMY = {
  slots: { rtpLabel: '≈ 88%', note: '1% 20x · 4% 8x · 18% 2x' },
  dice: { numberCount: 6, multiplier: 5.5, rtpLabel: '5,5× на точное число', note: 'Выбор одного числа из 1–6' },
  coinflip: { headsChance: 0.48, tailsChance: 0.48, rtpLabel: '≈ 96%', note: '48% на выбранную сторону' },
  roulette: { rtpLabel: '≈ 97,3%', note: 'Европейская рулетка 0–36' },
  wheel: { rtpLabel: '≈ 69%', note: 'Взвешенные виртуальные сектора' },
  crash: { targetRtp: 0.93, note: 'Виртуальный live-round с ручным cashout' },
  mines: { mineCount: 8, houseFactor: 0.9, note: '20 клеток · ровно 8 мин (40%)' },
  blackjack: { rtpLabel: 'Зависит от решений', note: '52 карты · hit/stand/double' }
};

const GAMES = Object.freeze({
  slots: { min: 100, max: 1000000, label: '🎰 Слоты' },
  dice: { min: 100, max: 1000000, label: '🎲 Dice' },
  coinflip: { min: 100, max: 1000000, label: '🪙 Coinflip' },
  blackjack: { min: 100, max: 1000000, label: '🃏 Blackjack' },
  roulette: { min: 100, max: 1000000, label: '🎡 Roulette' },
  mines: { min: 100, max: 1000000, label: '💣 Mines' },
  crash: { min: 100, max: 1000000, label: '🚀 Crash' },
  wheel: { min: 100, max: 1000000, label: '🎯 Wheel' }
});

function freshDb() { return { users: {}, history: [], promo: {}, jackpots: { main: 500000 }, blackjackRounds: {}, minesRounds: {}, crashRounds: {}, market: null }; }
function persist() {
  const serialized = JSON.stringify(db, null, 2);
  fs.writeFileSync(DB_TMP_PATH, serialized, 'utf8');
  fs.renameSync(DB_TMP_PATH, DB_PATH);
}
function loadDb() {
  try {
    if (!fs.existsSync(DB_PATH)) return;
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid DB');
    db = { ...freshDb(), ...parsed };
    db.users ||= {};
    db.history ||= [];
    db.blackjackRounds ||= {};
    db.minesRounds ||= {};
    db.crashRounds ||= {};
  } catch {
    try { if (fs.existsSync(DB_PATH)) fs.renameSync(DB_PATH, DB_PATH + `.corrupt-${Date.now()}`); } catch {}
    db = freshDb();
    persist();
  }
}
loadDb();
for (const [id, round] of Object.entries(db.blackjackRounds)) {
  if (round?.status === 'playing') {
    const valid = Array.isArray(round.deck) && Array.isArray(round.player) && Array.isArray(round.dealer) && round.deck.length >= 1 && round.player.length >= 2 && round.dealer.length >= 2;
    if (!valid) delete db.blackjackRounds[id];
  }
}

for (const round of Object.values(db.minesRounds)) {
  if (round?.status === 'playing') {
    round.mines = Array.isArray(round.mines) ? [...new Set(round.mines.map(Number).filter(Number.isInteger))].filter(i => i >= 0 && i < 20).sort((a,b)=>a-b) : [];
    round.revealed = Array.isArray(round.revealed) ? [...new Set(round.revealed.map(Number).filter(Number.isInteger))].filter(i => i >= 0 && i < 20).sort((a,b)=>a-b) : [];
  }
}

function randomFloat() { return crypto.randomInt(0, 1_000_000) / 1_000_000; }
function randomInt(min, max) { return crypto.randomInt(min, max + 1); }
function randomId(prefix = '') { return prefix + crypto.randomBytes(5).toString('hex').toUpperCase(); }
function roundMoney(n) { return Math.max(0, Math.round(Number(n) * 100) / 100); }
function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function ensureWallets(user) {
  user.wallets ||= {};
  for (const code of Object.keys(CURRENCY_DEFS)) {
    const current = Number(user.wallets[code]);
    if (!Number.isFinite(current) || current < 0) user.wallets[code] = code === 'USD' ? Number(user.balance || 0) : 0;
  }
  user.wallets.USD = Math.max(0, Number(user.wallets.USD || 0));
  user.balance = user.wallets.USD;
  return user.wallets;
}
function walletBalance(user, currency = 'USD') {
  ensureWallets(user);
  const code = CURRENCY_DEFS[currency] ? currency : 'USD';
  return roundMoney(user.wallets[code] || 0);
}
function addToWallet(user, currency, amount) {
  ensureWallets(user);
  const code = CURRENCY_DEFS[currency] ? currency : 'USD';
  user.wallets[code] = roundMoney(Number(user.wallets[code] || 0) + Number(amount || 0));
  if (user.wallets[code] < 0) user.wallets[code] = 0;
  user.balance = user.wallets.USD;
  return user.wallets[code];
}

function userName(user) {
  const clean = s => String(s || '').replace(/[<>`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return user?.username ? `@${clean(user.username)}` : clean([user?.first_name, user?.last_name].filter(Boolean).join(' ')) || `Игрок ${user?.id ?? ''}`;
}
function getUser(telegramUser) {
  const id = String(telegramUser.id);
  if (!db.users[id]) {
    db.users[id] = {
      id, name: userName(telegramUser), balance: 100000,
      wallets: { USD: 100000, EUR: 0, GBP: 0, JPY: 0, CHF: 0, KZT: 0, CAD: 0, AUD: 0 },
      xp: 0, level: 1, vip: 'BRONZE', games: 0, wins: 0, losses: 0,
      bestWin: 0, streak: 0, dailyClaim: 0, achievements: [], createdAt: Date.now()
    };
    persist();
  } else db.users[id].name = userName(telegramUser);
  ensureWallets(db.users[id]);
  return db.users[id];
}
function addXP(user, amount) {
  user.xp += Math.max(0, Number(amount || 0));
  while (user.xp >= user.level * 1000) { user.xp -= user.level * 1000; user.level += 1; }
  user.vip = user.level >= 25 ? 'GOLD' : user.level >= 10 ? 'SILVER' : 'BRONZE';
}
function recordGame(user, stake, payout, game, meta = {}, currency = 'USD') {
  user.games += 1;
  addXP(user, Math.max(10, Math.floor(stake / 1000)));
  if (payout > stake) { user.wins += 1; user.streak += 1; user.bestWin = Math.max(user.bestWin, payout - stake); }
  else if (payout === stake) user.streak += 1;
  else { user.losses += 1; user.streak = 0; }
  db.history.unshift({ at: Date.now(), userId: user.id, game, currency, stake, payout, meta });
  db.history = db.history.slice(0, 5000);
  persist();
}
function settleReserved(user, stake, payout, game, meta = {}, currency = 'USD') {
  addToWallet(user, currency, payout);
  recordGame(user, stake, payout, game, meta, currency);
  return user;
}

function validStake(game, stake) {
  const cfg = GAMES[game];
  return cfg && Number.isInteger(stake) && stake >= cfg.min && stake <= cfg.max;
}
function requireUser(req) {
  if (NODE_ENV !== 'production' && req.headers['x-demo-user']) return getUser({ id: req.headers['x-demo-user'], first_name: `Demo ${req.headers['x-demo-user']}` });
  const tgUser = validateInitData(req.headers['x-telegram-init-data'], BOT_TOKEN);
  return tgUser ? getUser(tgUser) : null;
}

function validateInitData(initData, botToken, maxAgeSeconds = 86400) {
  if (!initData || !botToken) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    const authDate = Number(params.get('auth_date'));
    if (!hash || !Number.isFinite(authDate)) return null;
    const age = Math.floor(Date.now() / 1000) - authDate;
    if (age < -60 || age > maxAgeSeconds) return null;
    params.delete('hash');
    const dataCheck = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expected = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
    const a = Buffer.from(expected, 'hex'); const b = Buffer.from(hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const user = JSON.parse(params.get('user') || '{}');
    return user?.id ? user : null;
  } catch { return null; }
}

async function refreshMarket(force = false) {
  if (!force && db.market?.fetchedAt && Date.now() - db.market.fetchedAt < FX_REFRESH_MS) return db.market;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(FX_URL, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`FX HTTP ${response.status}`);
    const rows = await response.json();
    const oldRates = db.market?.rates || {};
    const sourceDate = rows[0]?.date || new Date().toISOString().slice(0, 10);
    const rates = { USD: { rate: 1, usdValue: 1, changePct: 0, sourceDate } };
    for (const row of rows) {
      const code = row.quote; const rate = Number(row.rate);
      if (!CURRENCY_DEFS[code] || !Number.isFinite(rate) || rate <= 0) continue;
      const prev = Number(oldRates[code]?.rate || rate);
      rates[code] = { rate, usdValue: 1 / rate, changePct: prev ? ((1 / rate) / (1 / prev) - 1) * 100 : 0, sourceDate: row.date };
    }
    db.market = { base: 'USD', provider: 'Frankfurter', sourceUrl: 'https://api.frankfurter.dev/v2/rates', fetchedAt: Date.now(), sourceDate, rates };
    persist();
  } catch {
    if (!db.market) {
      const fallback = { EUR: .86, GBP: .75, JPY: 148, CHF: .80, KZT: 540, CAD: 1.55, AUD: 1.50 };
      const sourceDate = new Date().toISOString().slice(0, 10);
      const rates = { USD: { rate: 1, usdValue: 1, changePct: 0, sourceDate } };
      for (const [code, rate] of Object.entries(fallback)) rates[code] = { rate, usdValue: 1 / rate, changePct: 0, sourceDate };
      db.market = { base: 'USD', provider: 'Frankfurter (fallback cache)', sourceUrl: 'https://api.frankfurter.dev/v2/rates', fetchedAt: Date.now(), sourceDate, rates };
      persist();
    }
  } finally { clearTimeout(timer); }
  return db.market;
}
function currencyUsdValue(currency, market = db.market) { return currency === 'USD' ? 1 : Number(market?.rates?.[currency]?.usdValue || 0) || null; }
function portfolioUsd(user) { return Object.keys(CURRENCY_DEFS).reduce((sum, code) => sum + walletBalance(user, code) * (currencyUsdValue(code) || 0), 0); }

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: false } });
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use((req,res,next)=>{if(req.path==='/'||req.path==='/app.js'||req.path==='/style.css')res.set('Cache-Control','no-store, no-cache, must-revalidate');next();});
app.use(express.static(path.join(ROOT, 'public')));

const requestLog = new Map();
function rateLimit(key, limit = 120, windowMs = 60000) {
  const now = Date.now(); const row = requestLog.get(key);
  if (!row || now - row.started >= windowMs) { requestLog.set(key, { started: now, count: 1 }); return true; }
  row.count += 1; return row.count <= limit;
}
app.use((req, res, next) => {
  const key = `${req.ip}:${req.path}`;
  if (!rateLimit(key)) return res.status(429).json({ error: 'Слишком много запросов. Повторите немного позже.' });
  next();
});

app.get('/health', (_, res) => res.json({ ok: true, time: new Date().toISOString(), version: '1.2.0' }));
app.get('/api/config', (_, res) => res.json({ currency: '$', games: Object.keys(GAMES), currencies: CURRENCY_DEFS, economy: GAME_ECONOMY }));
app.post('/api/auth', (req, res) => {
  const tgUser = NODE_ENV !== 'production' && req.body?.demoId ? { id: String(req.body.demoId), first_name: `Demo ${req.body.demoId}` } : validateInitData(req.headers['x-telegram-init-data'], BOT_TOKEN);
  if (!tgUser) return res.status(401).json({ error: 'Telegram авторизация не прошла' });
  const user = getUser(tgUser); res.json({ user, telegram: { id: String(tgUser.id), name: userName(tgUser) } });
});

function makeDeck() {
  const suits = [{ key: 'hearts', symbol: '♥', color: 'red' }, { key: 'diamonds', symbol: '♦', color: 'red' }, { key: 'clubs', symbol: '♣', color: 'black' }, { key: 'spades', symbol: '♠', color: 'black' }];
  const ranks = [['A', 11], ['2', 2], ['3', 3], ['4', 4], ['5', 5], ['6', 6], ['7', 7], ['8', 8], ['9', 9], ['10', 10], ['J', 10], ['Q', 10], ['K', 10]];
  const deck = [];
  for (const suit of suits) for (const [rank, value] of ranks) deck.push({ rank, value, suit: suit.key, symbol: suit.symbol, color: suit.color });
  for (let i = deck.length - 1; i > 0; i--) { const j = randomInt(0, i); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  return deck;
}
function handValue(cards) { let total = cards.reduce((s, c) => s + c.value, 0), aces = cards.filter(c => c.rank === 'A').length; while (total > 21 && aces-- > 0) total -= 10; return total; }
function blackjackPublic(round, revealDealer = false) {
  return { id: round.id, status: round.status, currency: round.currency, stake: round.stake, player: round.player, dealer: revealDealer ? round.dealer : [round.dealer[0], { hidden: true }], playerValue: handValue(round.player), dealerValue: revealDealer ? handValue(round.dealer) : null, revealDealer };
}
function resolveBlackjackOutcome(round) {
  while (handValue(round.dealer) < 17) round.dealer.push(round.deck.pop());
  const pv = handValue(round.player), dv = handValue(round.dealer);
  if (pv > 21) return ['bust', 0];
  if (dv > 21 || pv > dv) return ['win', round.stake * 2];
  if (pv === dv) return ['push', round.stake];
  return ['lose', 0];
}
function finishBlackjack(user, round, outcome, payout) {
  round.status = 'finished';
  delete db.blackjackRounds[user.id];
  settleReserved(user, round.stake, payout, 'blackjack', { player: round.player, dealer: round.dealer, outcome }, round.currency);
  return { user, round: blackjackPublic(round, true), outcome, payout };
}
function getActiveBlackjack(user) { const round = db.blackjackRounds[user.id]; return round?.status === 'playing' ? round : null; }

app.get('/api/blackjack/status', (req, res) => {
  try {
    const user = requireUser(req); if (!user) return res.status(401).json({ error: 'Нет авторизации' });
    const round = getActiveBlackjack(user);
    res.json({ active: !!round, user, round: round ? blackjackPublic(round, false) : null });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/blackjack/start', (req, res) => {
  try {
    const user = requireUser(req); if (!user) return res.status(401).json({ error: 'Нет авторизации' });
    if (getActiveBlackjack(user)) return res.status(400).json({ error: 'У вас уже идёт раздача' });
    const currency = CURRENCY_DEFS[String(req.body?.currency || 'USD')] ? String(req.body.currency) : 'USD';
    const stake = Number(req.body?.stake);
    if (!validStake('blackjack', stake)) return res.status(400).json({ error: 'Некорректная ставка' });
    if (stake > walletBalance(user, currency)) return res.status(400).json({ error: `Недостаточно виртуальных ${CURRENCY_DEFS[currency].symbol}` });
    const deck = makeDeck(); const round = { id: randomId('BJ-'), userId: user.id, currency, stake, deck, player: [deck.pop(), deck.pop()], dealer: [deck.pop(), deck.pop()], status: 'playing', createdAt: Date.now() };
    addToWallet(user, currency, -stake); db.blackjackRounds[user.id] = round; persist();
    if (handValue(round.player) === 21) return res.json(finishBlackjack(user, round, 'blackjack', Math.floor(stake * 2.5)));
    res.json({ user, round: blackjackPublic(round, false), outcome: null, payout: 0 });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/blackjack/hit', (req, res) => {
  try {
    const user = requireUser(req); if (!user) return res.status(401).json({ error: 'Нет авторизации' });
    const round = getActiveBlackjack(user); if (!round) return res.status(400).json({ error: 'Активной раздачи нет' });
    round.player.push(round.deck.pop());
    const value = handValue(round.player);
    if (value > 21) return res.json(finishBlackjack(user, round, 'bust', 0));
    if (value === 21) {
      const [outcome, payout] = resolveBlackjackOutcome(round);
      return res.json(finishBlackjack(user, round, outcome, payout));
    }
    persist(); res.json({ user, round: blackjackPublic(round, false), outcome: null, payout: 0 });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/blackjack/stand', (req, res) => {
  try {
    const user = requireUser(req); if (!user) return res.status(401).json({ error: 'Нет авторизации' });
    const round = getActiveBlackjack(user); if (!round) return res.status(400).json({ error: 'Активной раздачи нет' });
    const [outcome, payout] = resolveBlackjackOutcome(round); res.json(finishBlackjack(user, round, outcome, payout));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/blackjack/double', (req, res) => {
  try {
    const user = requireUser(req); if (!user) return res.status(401).json({ error: 'Нет авторизации' });
    const round = getActiveBlackjack(user); if (!round) return res.status(400).json({ error: 'Активной раздачи нет' });
    if (round.player.length !== 2) return res.status(400).json({ error: 'Удвоение доступно только после первых двух карт' });
    if (round.stake * 2 > GAMES.blackjack.max) return res.status(400).json({ error: 'Ставка после удвоения превышает лимит' });
    if (round.stake > walletBalance(user, round.currency)) return res.status(400).json({ error: 'Недостаточно средств для удвоения' });
    addToWallet(user, round.currency, -round.stake); round.stake *= 2; round.player.push(round.deck.pop());
    const value = handValue(round.player); if (value > 21) return res.json(finishBlackjack(user, round, 'bust', 0));
    const [outcome, payout] = resolveBlackjackOutcome(round); res.json(finishBlackjack(user, round, outcome, payout));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

function slotsRound(stake) {
  const r = randomFloat(); const symbols = ['7️⃣', '🍒', '🍋', '💎', '⭐'];
  let reels, multiplier;
  if (r < 0.01) { reels = ['7️⃣', '7️⃣', '7️⃣']; multiplier = 20; }
  else if (r < 0.05) { const s = symbols[randomInt(1, symbols.length - 1)]; reels = [s, s, s]; multiplier = 8; }
  else if (r < 0.23) { const s = symbols[randomInt(0, symbols.length - 1)]; let other = symbols[randomInt(0, symbols.length - 1)]; while (other === s) other = symbols[randomInt(0, symbols.length - 1)]; const pos = randomInt(0, 2); reels = [other, other, other]; reels[pos] = s; reels[(pos + 1) % 3] = s; multiplier = 2; }
  else { const shuffled = [...symbols].sort(() => randomFloat() - .5); reels = shuffled.slice(0, 3); multiplier = 0; }
  return { reels, payout: Math.floor(stake * multiplier), multiplier };
}
function validateRouletteBet(bet) {
  if (!bet || typeof bet !== 'object') throw new Error('Выберите ставку рулетки');
  const type = String(bet.type || ''); const value = String(bet.value ?? '').toLowerCase();
  if (type === 'number') { const n = Number(value); if (!Number.isInteger(n) || n < 0 || n > 36) throw new Error('Число должно быть от 0 до 36'); return { type, value: String(n) }; }
  if (type === 'color' && !['red', 'black', 'green'].includes(value)) throw new Error('Цвет: red, black или green');
  if (type === 'parity' && !['even', 'odd'].includes(value)) throw new Error('Чётность: even или odd');
  if (!['color', 'parity'].includes(type)) throw new Error('Некорректный тип ставки');
  return { type, value };
}

function playInstantGame(user, game, stake, currency, body) {
  let payout = 0, meta = {};
  if (game === 'slots') {
    const r = slotsRound(stake); payout = r.payout; meta = { reels: r.reels, multiplier: r.multiplier };
  } else if (game === 'dice') {
    const target = Number(body?.target); if (!Number.isInteger(target) || target < 1 || target > 6) throw new Error('Выберите число от 1 до 6');
    const n = randomInt(1, 6); const win = n === target; payout = win ? Math.floor(stake * GAME_ECONOMY.dice.multiplier) : 0; meta = { n, target, win, multiplier: win ? GAME_ECONOMY.dice.multiplier : 0 };
  } else if (game === 'coinflip') {
    const requested = body?.side === 'tails' ? 'tails' : body?.side === 'heads' ? 'heads' : (() => { throw new Error('Выберите сторону монеты'); })();
    const win = randomFloat() < (requested === 'heads' ? GAME_ECONOMY.coinflip.headsChance : GAME_ECONOMY.coinflip.tailsChance);
    const side = win ? requested : requested === 'heads' ? 'tails' : 'heads'; payout = win ? stake * 2 : 0; meta = { side, requested, win };
  } else if (game === 'roulette') {
    const bet = validateRouletteBet(body?.bet); const n = randomInt(0, 36); const red = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]); const color = n === 0 ? 'green' : red.has(n) ? 'red' : 'black';
    let multiplier = 0; if (bet.type === 'number' && Number(bet.value) === n) multiplier = 36; if (bet.type === 'color' && bet.value === color) multiplier = color === 'green' ? 36 : 2; if (bet.type === 'parity' && n !== 0 && bet.value === (n % 2 === 0 ? 'even' : 'odd')) multiplier = 2;
    payout = stake * multiplier; meta = { n, color, bet, multiplier };
  } else if (game === 'wheel') {
    const sectors = [{ multiplier: 0, weight: 34 }, { multiplier: 0.5, weight: 22 }, { multiplier: 1, weight: 20 }, { multiplier: 1.5, weight: 12 }, { multiplier: 2, weight: 7 }, { multiplier: 3, weight: 4 }, { multiplier: 5, weight: 0.8 }, { multiplier: 10, weight: 0.2 }];
    let roll = randomFloat() * 100, picked = sectors[0]; for (const sector of sectors) { roll -= sector.weight; if (roll <= 0) { picked = sector; break; } }
    payout = Math.floor(stake * picked.multiplier); meta = { multiplier: picked.multiplier, sector: sectors.indexOf(picked), sectors };
  } else if (game === 'blackjack') {
    throw new Error('Для Blackjack используйте экран раздачи');
  } else if (game === 'mines' || game === 'crash') {
    throw new Error('Для этой игры используйте интерактивный раунд');
  }
  return { payout, meta };
}

app.post('/api/play', (req, res) => {
  try {
    const user = requireUser(req); if (!user) return res.status(401).json({ error: 'Нет авторизации' });
    const game = String(req.body?.game || ''); const currency = CURRENCY_DEFS[String(req.body?.currency || 'USD')] ? String(req.body.currency) : 'USD'; const stake = Number(req.body?.stake);
    if (!validStake(game, stake)) return res.status(400).json({ error: 'Некорректная игра или ставка' });
    if (stake > walletBalance(user, currency)) return res.status(400).json({ error: `Недостаточно виртуальных ${CURRENCY_DEFS[currency].symbol}` });
    const { payout, meta } = playInstantGame(user, game, stake, currency, req.body); addToWallet(user, currency, -stake + payout); recordGame(user, stake, payout, game, meta, currency);
    res.json({ user, game, currency, stake, payout, meta, economy: GAME_ECONOMY[game] });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

function mineMultiplier(revealedSafeCount) {
  if (revealedSafeCount <= 0) return 1;
  let probability = 1;
  for (let i = 0; i < revealedSafeCount; i++) probability *= (12 - i) / (20 - i);
  return roundMoney(GAME_ECONOMY.mines.houseFactor / probability);
}
function shuffledMineIndexes() {
  const values = Array.from({ length: 20 }, (_, i) => i);
  for (let i = values.length - 1; i > 0; i--) { const j = randomInt(0, i); [values[i], values[j]] = [values[j], values[i]]; }
  return values.slice(0, GAME_ECONOMY.mines.mineCount).sort((a, b) => a - b);
}
function minesPublic(round, revealAll = false) {
  const safeCount = round.revealed.length;
  const multiplier = mineMultiplier(safeCount);
  return { id: round.id, status: round.status, currency: round.currency, stake: round.stake, mineCount: GAME_ECONOMY.mines.mineCount, totalCells: 20, revealed: [...round.revealed].sort((a,b)=>a-b), multiplier, currentPayout: Math.floor(round.stake * multiplier), mines: revealAll ? [...round.mines] : undefined, result: round.result || null };
}
function finishMines(user, round, payout, resultCode) {
  round.status = 'finished'; round.result = resultCode; delete db.minesRounds[user.id]; settleReserved(user, round.stake, payout, 'mines', { revealed: [...round.revealed], result: resultCode, mines: [...round.mines].sort((a,b)=>a-b) }, round.currency); return { user, round: minesPublic(round, true), payout };
}
app.get('/api/mines/status', (req, res) => {
  try { const user=requireUser(req); if(!user)return res.status(401).json({error:'Нет авторизации'}); const round=db.minesRounds[user.id]; res.json({active:!!(round&&round.status==='playing'), round:round&&round.status==='playing'?minesPublic(round,false):null}); } catch(e){res.status(400).json({error:e.message});}
});

app.post('/api/mines/start', (req, res) => {
  try {
    const user = requireUser(req); if (!user) return res.status(401).json({ error: 'Нет авторизации' });
    if (db.minesRounds[user.id]?.status === 'playing') return res.status(400).json({ error: 'У вас уже идёт Mines-раунд' });
    const currency = CURRENCY_DEFS[String(req.body?.currency || 'USD')] ? String(req.body.currency) : 'USD'; const stake = Number(req.body?.stake);
    if (!validStake('mines', stake)) return res.status(400).json({ error: 'Некорректная ставка' }); if (stake > walletBalance(user, currency)) return res.status(400).json({ error: `Недостаточно виртуальных ${CURRENCY_DEFS[currency].symbol}` });
    const round = { id: randomId('MN-'), userId: user.id, currency, stake, mines: shuffledMineIndexes(), revealed: [], status: 'playing', createdAt: Date.now(), result: null };
    addToWallet(user, currency, -stake); db.minesRounds[user.id] = round; persist(); res.json({ user, round: minesPublic(round, false) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/mines/reveal', (req, res) => {
  try {
    const user = requireUser(req); if (!user) return res.status(401).json({ error: 'Нет авторизации' }); const round = db.minesRounds[user.id]; if (!round || round.status !== 'playing') return res.status(400).json({ error: 'Активного Mines-раунда нет' });
    const index = Number(req.body?.index); if (!Number.isInteger(index) || index < 0 || index >= 20) return res.status(400).json({ error: 'Некорректная клетка' }); if (round.revealed.includes(index)) return res.status(400).json({ error: 'Клетка уже открыта' });
    round.revealed.push(index);
    if (round.mines.includes(index)) return res.json(finishMines(user, round, 0, 'mine'));
    persist(); const safeCount = round.revealed.length; if (safeCount === 12) return res.json(finishMines(user, round, Math.floor(round.stake * mineMultiplier(safeCount)), 'all-safe'));
    res.json({ user, round: minesPublic(round, false), payout: 0, safe: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/mines/cashout', (req, res) => {
  try {
    const user = requireUser(req); if (!user) return res.status(401).json({ error: 'Нет авторизации' }); const round = db.minesRounds[user.id]; if (!round || round.status !== 'playing') return res.status(400).json({ error: 'Активного Mines-раунда нет' }); if (round.revealed.length < 1) return res.status(400).json({ error: 'Сначала откройте хотя бы одну безопасную клетку' });
    return res.json(finishMines(user, round, Math.floor(round.stake * mineMultiplier(round.revealed.length)), 'cashout'));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

function crashPoint() { return Math.max(1.01, Number((1 + (-Math.log(Math.max(1e-9, randomFloat())) * 1.65)).toFixed(2))); }
function crashDurationMs(crash) { return Math.min(20000, Math.max(900, 2500 + (crash - 1) * 2800)); }
function crashMultiplierAt(round, now = Date.now()) { const p = clamp((now - round.startedAt) / round.durationMs, 0, 1); return roundMoney(1 + (round.crash - 1) * p); }
function crashPublic(round, now = Date.now()) { return { id: round.id, status: round.status, currency: round.currency, stake: round.stake, startedAt: round.startedAt, crashAt: round.crashAt, durationMs: round.durationMs, crash: round.status === 'crashed' ? round.crash : undefined, currentMultiplier: crashMultiplierAt(round, now), autoCashout: round.autoCashout || null, payout: round.payout || 0, result: round.result || null }; }
function settleCrashRound(user, round, payout, resultCode, currentMultiplier) { round.status = resultCode === 'crashed' ? 'crashed' : 'cashed-out'; round.payout = payout; round.result = resultCode; delete db.crashRounds[user.id]; settleReserved(user, round.stake, payout, 'crash', { crash: round.crash, currentMultiplier, autoCashout: round.autoCashout || null, result: resultCode }, round.currency); return { user, round: crashPublic(round), payout, multiplier: currentMultiplier }; }
app.get('/api/crash/status', (req, res) => {
  try { const user=requireUser(req); if(!user)return res.status(401).json({error:'Нет авторизации'}); const round=db.crashRounds[user.id]; if(!round||round.status!=='active')return res.json({active:false,round:null}); if(Date.now()>=round.crashAt)return res.json({active:true,round:crashPublic(round,Date.now())}); res.json({active:true,round:crashPublic(round,Date.now())}); } catch(e){res.status(400).json({error:e.message});}
});

app.post('/api/crash/start', (req, res) => {
  try {
    const user = requireUser(req); if (!user) return res.status(401).json({ error: 'Нет авторизации' });
    const existing = db.crashRounds[user.id]; if (existing?.status === 'active') {
      if (Date.now() >= existing.crashAt) settleCrashRound(user, existing, 0, 'crashed', existing.crash);
      else return res.status(400).json({ error: 'У вас уже идёт Crash-раунд' });
    }
    const currency = CURRENCY_DEFS[String(req.body?.currency || 'USD')] ? String(req.body.currency) : 'USD'; const stake = Number(req.body?.stake); if (!validStake('crash', stake)) return res.status(400).json({ error: 'Некорректная ставка' }); if (stake > walletBalance(user, currency)) return res.status(400).json({ error: `Недостаточно виртуальных ${CURRENCY_DEFS[currency].symbol}` });
    const autoCashout = null;
    const crash = crashPoint(); const durationMs = crashDurationMs(crash); const startedAt = Date.now(); const round = { id: randomId('CR-'), userId: user.id, currency, stake, crash, durationMs, startedAt, crashAt: startedAt + durationMs, autoCashout, status: 'active', payout: 0, result: null };
    addToWallet(user, currency, -stake); db.crashRounds[user.id] = round; persist(); res.json({ user, round: crashPublic(round, startedAt) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/crash/cashout', (req, res) => {
  try {
    const user = requireUser(req); if (!user) return res.status(401).json({ error: 'Нет авторизации' }); const round = db.crashRounds[user.id]; if (!round || round.status !== 'active') return res.status(400).json({ error: 'Активного Crash-раунда нет' });
    const now = Date.now(); if (now >= round.crashAt) return res.json(settleCrashRound(user, round, 0, 'crashed', round.crash));
    const multiplier = crashMultiplierAt(round, now); if (multiplier >= round.crash) return res.json(settleCrashRound(user, round, 0, 'crashed', round.crash));
    const payout = Math.floor(round.stake * multiplier); return res.json(settleCrashRound(user, round, payout, 'cashout', multiplier));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/crash/expire', (req, res) => {
  try {
    const user = requireUser(req); if (!user) return res.status(401).json({ error: 'Нет авторизации' }); const round = db.crashRounds[user.id]; if (!round || round.status !== 'active') return res.status(400).json({ error: 'Активного Crash-раунда нет' }); if (Date.now() < round.crashAt) return res.status(400).json({ error: 'Crash ещё не наступил' }); return res.json(settleCrashRound(user, round, 0, 'crashed', round.crash));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/bonus', (req, res) => { const user = requireUser(req); if (!user) return res.status(401).json({ error: 'Нет авторизации' }); const now = Date.now(); if (now - Number(user.dailyClaim || 0) < 86400000) return res.status(400).json({ error: 'Бонус уже получен сегодня' }); user.dailyClaim = now; addToWallet(user, 'USD', 25000); addXP(user, 100); persist(); res.json({ user, amount: 25000, currency: 'USD' }); });
app.get('/api/market', async (_, res) => { try { const market = await refreshMarket(false); const currencies = Object.values(CURRENCY_DEFS).map(c => ({ ...c, priceUsd: currencyUsdValue(c.code, market), ...(market.rates[c.code] || {}) })); res.json({ market, currencies }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/exchange', async (req, res) => { try { const user = requireUser(req); if (!user) return res.status(401).json({ error: 'Нет авторизации' }); const from = CURRENCY_DEFS[String(req.body?.from || 'USD')] ? String(req.body.from) : 'USD'; const to = CURRENCY_DEFS[String(req.body?.to || 'EUR')] ? String(req.body.to) : 'EUR'; const amount = Number(req.body?.amount); if (from === to) throw new Error('Выберите разные валюты'); if (!Number.isFinite(amount) || amount <= 0) throw new Error('Некорректная сумма'); const market = await refreshMarket(false); const fromUsd = currencyUsdValue(from, market), toUsd = currencyUsdValue(to, market); if (!(fromUsd && toUsd)) throw new Error('Курс временно недоступен'); if (amount > walletBalance(user, from)) throw new Error(`Недостаточно ${CURRENCY_DEFS[from].symbol}`); const fee = 0.005; const received = roundMoney((amount * fromUsd * (1 - fee)) / toUsd); addToWallet(user, from, -amount); addToWallet(user, to, received); persist(); res.json({ user, from, to, amount, received, fee, market }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get('/api/history', (req, res) => {
  try { const user=requireUser(req); if(!user)return res.status(401).json({error:'Нет авторизации'}); const rows=db.history.filter(x=>String(x.userId)===String(user.id)).slice(0,30); res.json(rows); } catch(e){res.status(400).json({error:e.message});}
});
app.get('/api/top', async (_, res) => { await refreshMarket(false); const top = Object.values(db.users).sort((a,b) => portfolioUsd(b) - portfolioUsd(a)).slice(0,25); res.json(top.map((u,i) => ({ place:i+1, name:u.name, balance:roundMoney(portfolioUsd(u)), level:u.level }))); });

const rooms = new Map();
function roomView(room) { return { code: room.code, hostId: room.hostId, game: room.game, players: [...room.players.values()].map(p => ({ id:p.id, name:p.name, ready:p.ready })), state: { status: room.state.status, bets: Object.fromEntries(Object.entries(room.state.bets).map(([id,b]) => [id,{ stake:b.stake, currency:b.currency, choice:b.choice, name:b.name }])), result: room.state.result } }; }
function createRoom(hostUser, game = 'roulette') { if (!['dice','coinflip','roulette','blackjack'].includes(game)) throw new Error('Эта игра недоступна для комнат'); const code=randomId('NC-'); const room={code,hostId:hostUser.id,game,players:new Map(),sockets:new Map(),state:{status:'lobby',bets:{},result:null}}; room.players.set(hostUser.id,{id:hostUser.id,name:hostUser.name,ready:false}); rooms.set(code,room); return room; }
function roomChoiceValid(game, choice) {
  if (game === 'coinflip' && !['heads','tails'].includes(choice)) throw new Error('Выберите сторону монеты');
  if (game === 'dice' && !['high','low'].includes(choice)) throw new Error('Выберите high или low');
  if (game === 'roulette') validateRouletteBet(String(choice).includes(':') ? (() => { const [type,...v]=String(choice).split(':'); return {type,value:v.join(':')}; })() : null);
}
function roomPlaceBet(room, user, stake, choice) {
  if (!Number.isInteger(stake) || stake < GAMES[room.game].min || stake > GAMES[room.game].max) throw new Error('Некорректная ставка'); roomChoiceValid(room.game, choice);
  const previous=room.state.bets[user.id]; if(previous) addToWallet(user,'USD',previous.stake); if(stake>walletBalance(user,'USD')) throw new Error('Недостаточно виртуальных $'); addToWallet(user,'USD',-stake); room.state.bets[user.id]={stake,currency:'USD',choice,name:user.name};
}
function refundRoomBets(room) { for(const [id,b] of Object.entries(room.state.bets)){const u=db.users[id];if(u)addToWallet(u,'USD',b.stake);} room.state.bets={}; }
function resolveRoomRound(room) {
  const entries=Object.entries(room.state.bets); if(entries.length<2) throw new Error('Нужно минимум 2 ставки игроков'); const bettors=entries.filter(([id])=>room.players.get(id)?.ready); if(bettors.length!==entries.length) throw new Error('Все игроки со ставками должны нажать «Готов»');
  const payouts={}; let meta={}; const winners=[];
  if(room.game==='coinflip'){const side=randomFloat()<.5?'heads':'tails';meta={side};for(const [id,b] of entries){payouts[id]=b.choice===side?b.stake*2:0;if(payouts[id]>b.stake)winners.push(b.name);}}
  else if(room.game==='dice'){const n=randomInt(1,100);meta={n};for(const [id,b] of entries){const win=b.choice==='low'?n<=50:n>=51;payouts[id]=win?b.stake*2:0;if(payouts[id]>b.stake)winners.push(b.name);}}
  else if(room.game==='roulette'){const n=randomInt(0,36);const red=new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);const color=n===0?'green':red.has(n)?'red':'black';meta={n,color};for(const [id,b] of entries){const [type,val]=String(b.choice||'').split(':');let mult=0;if(type==='number'&&Number(val)===n)mult=36;if(type==='color'&&val===color)mult=2;if(type==='parity'&&n!==0&&val===(n%2===0?'even':'odd'))mult=2;payouts[id]=b.stake*mult;if(payouts[id]>b.stake)winners.push(b.name);}}
  else if(room.game==='blackjack'){meta={players:{}};for(const [id,b] of entries){const deck=makeDeck();const player=[deck.pop(),deck.pop()];const dealer=[deck.pop(),deck.pop()];const natural=handValue(player)===21&&player.length===2;if(!natural)while(handValue(dealer)<17)dealer.push(deck.pop());const pv=handValue(player),dv=handValue(dealer);payouts[id]=natural?Math.floor(b.stake*2.5):(dv>21||pv>dv)?b.stake*2:(pv===dv?b.stake:0);meta.players[id]={player,dealer};if(payouts[id]>b.stake)winners.push(b.name);}}
  for(const [id,b] of entries){const u=db.users[id];if(!u)continue;const payout=payouts[id]||0;addToWallet(u,'USD',payout);recordGame(u,b.stake,payout,`room:${room.game}`,meta,'USD');}
  room.state={status:'result',bets:{},result:{meta,winners,payouts}};persist();return room.state.result;
}

app.post('/api/rooms', (req,res)=>{try{const user=requireUser(req);if(!user)return res.status(401).json({error:'Нет авторизации'});const room=createRoom(user,String(req.body?.game||'roulette'));res.json(roomView(room));}catch(e){res.status(400).json({error:e.message});}});
app.get('/api/rooms/:code',(req,res)=>{const room=rooms.get(String(req.params.code||'').toUpperCase());if(!room)return res.status(404).json({error:'Комната не найдена'});res.json(roomView(room));});

io.on('connection', socket => {
  socket.on('room:join', ({initData,demoId,code,name},cb)=>{try{const tgUser=NODE_ENV!=='production'&&demoId?{id:String(demoId),first_name:`Demo ${demoId}`} : validateInitData(initData,BOT_TOKEN);if(!tgUser)throw new Error('Авторизация Telegram не прошла');const user=getUser(tgUser);const room=rooms.get(String(code||'').toUpperCase());if(!room)throw new Error('Комната не найдена');if(room.players.size>=8&&!room.players.has(user.id))throw new Error('Комната заполнена');room.players.set(user.id,{id:user.id,name:user.name,ready:room.players.get(user.id)?.ready ?? false});room.sockets.set(socket.id,user.id);socket.data.userId=user.id;socket.data.roomCode=room.code;socket.join(room.code);io.to(room.code).emit('room:update',roomView(room));cb?.({ok:true,room:roomView(room),user});}catch(e){cb?.({error:e.message});}});
  socket.on('room:create',({initData,demoId,game='roulette'},cb)=>{try{const tgUser=NODE_ENV!=='production'&&demoId?{id:String(demoId),first_name:`Demo ${demoId}`} : validateInitData(initData,BOT_TOKEN);if(!tgUser)throw new Error('Авторизация Telegram не прошла');const user=getUser(tgUser);const room=createRoom(user,String(game));room.sockets.set(socket.id,user.id);socket.data.userId=user.id;socket.data.roomCode=room.code;socket.join(room.code);cb?.({ok:true,room:roomView(room),user});}catch(e){cb?.({error:e.message});}});
  socket.on('room:ready',({ready=true},cb)=>{const room=rooms.get(socket.data.roomCode);if(!room)return cb?.({error:'Комната не найдена'});const p=room.players.get(socket.data.userId);if(p)p.ready=!!ready;io.to(room.code).emit('room:update',roomView(room));cb?.({ok:true});});
  socket.on('room:chat',({text:msg},cb)=>{const room=rooms.get(socket.data.roomCode);const p=room?.players.get(socket.data.userId);const text=String(msg||'').replace(/[<>]/g,'').replace(/\s+/g,' ').trim().slice(0,300);if(!room||!p||!text)return cb?.({error:'Пустое сообщение'});io.to(room.code).emit('room:chat',{name:p.name,text,at:Date.now()});cb?.({ok:true});});
  socket.on('room:bet',({stake,choice},cb)=>{try{const room=rooms.get(socket.data.roomCode);if(!room)throw new Error('Комната не найдена');if(room.state.status==='result')room.state={status:'lobby',bets:{},result:null};const u=db.users[socket.data.userId];if(!u)throw new Error('Пользователь не найден');roomPlaceBet(room,u,Number(stake),choice);room.state.status='betting';io.to(room.code).emit('room:update',roomView(room));cb?.({ok:true,user:u});}catch(e){cb?.({error:e.message});}});
  socket.on('room:start',({},cb)=>{try{const room=rooms.get(socket.data.roomCode);if(!room)throw new Error('Комната не найдена');if(room.hostId!==socket.data.userId)throw new Error('Только создатель комнаты может начать раунд');const result=resolveRoomRound(room);io.to(room.code).emit('room:round-result',result);io.to(room.code).emit('room:update',roomView(room));cb?.({ok:true});}catch(e){cb?.({error:e.message});}});
  socket.on('disconnect',()=>{const room=rooms.get(socket.data.roomCode);if(!room)return;const id=socket.data.userId;room.sockets.delete(socket.id);if([...room.sockets.values()].includes(id))return;const bet=room.state.bets[id];if(bet){const u=db.users[id];if(u)addToWallet(u,'USD',bet.stake);delete room.state.bets[id];persist();}room.players.delete(id);if(!room.players.size){refundRoomBets(room);rooms.delete(room.code);}else{if(room.hostId===id)room.hostId=[...room.players.keys()][0];io.to(room.code).emit('room:update',roomView(room));}});
});

app.use('/api', (req,res) => res.status(404).json({ error: 'API маршрут не найден', path: req.path }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (req.path.startsWith('/api')) return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  res.status(500).type('text/plain').send('Internal Server Error');
});

if (BOT_TOKEN) {
  const bot = new Bot(BOT_TOKEN);
  // В личке Telegram разрешает Web App-кнопку.
  // В группах используем обычную URL-кнопку, чтобы избежать BUTTON_TYPE_INVALID.
  const privateCasinoKeyboard = () =>
    new InlineKeyboard().webApp('🎰 Открыть казино', WEB_APP_URL);

  const groupCasinoKeyboard = () =>
    new InlineKeyboard().url('🎰 Открыть казино', WEB_APP_URL);

  // /start работает и в личке, и в группе.
  bot.command('start', async ctx => {
    const chatType = ctx.chat?.type;
    const isGroup = chatType === 'group' || chatType === 'supergroup';

    if (isGroup) {
      await ctx.reply(
        '🎰 NIGHT CASINO\n\nЧтобы открыть казино, нажми кнопку ниже.',
        { reply_markup: groupCasinoKeyboard() }
      );
      return;
    }

    await ctx.reply(
      '🎰 NIGHT CASINO\n\nВиртуальное казино с играми в $. Все средства внутри игры виртуальные.\n\nНажми кнопку ниже.',
      { reply_markup: privateCasinoKeyboard() }
    );
  });

  bot.command('help', ctx => ctx.reply('Игры: Слоты, Dice, Coinflip, Blackjack, Roulette, Mines, Crash и Wheel. Все $ — только виртуальная игровая валюта.'));
  bot.catch(err => { console.error('Telegram bot error:', err.error || err); });
  bot.command('admin', ctx => ADMIN_IDS.has(String(ctx.from.id)) ? ctx.reply(`Админ-доступ подтверждён. Пользователей: ${Object.keys(db.users).length}.`) : ctx.reply('Нет доступа.'));
  bot.api.setChatMenuButton({ menu_button: { type:'web_app', text:'🎰 Казино', web_app:{url:WEB_APP_URL} } }).catch(()=>{});
  bot.start().catch(err => console.error('Bot error', err));
}

server.listen(PORT, () => console.log(`NIGHT CASINO server on http://localhost:${PORT}`));
