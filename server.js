const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

// =====================================================
// ====== CẤU HÌNH ======
// =====================================================
const CONFIG = {
  server: {
    port: process.env.PORT || 3000,
    host: "0.0.0.0"
  },
  api: {
    url: "https://bu-jobs-o5ma.onrender.com"
  },
  bot: {
    pollInterval: 5 * 1000,  // 5 giây
    timeout: 10000,
    retries: 3,
    baseUrl: "http://163.223.9.144/boss/"
  },
  logging: {
    file: "boss_log.json"
  },
  allowedIPs: [
    "123.16.180.177",
    "2001:4860:7:412::1"
  ]
};

// =====================================================
// ====== DANH SÁCH BOSS ======
// =====================================================
const BOSS_LIST = [
  "Berry",
  "DoughKing",
  "CakePrince",
  "RipIndra",
  "CursedCaptain",
  "Darkbeard",
  "Fullmoon",
  "CastleRaid",
  "NearMoon",
  "Mirage",
  "PrehistoricIsland",
  "Fruits",
  "SoulReaper",
  "Elite",
  "SwordLegendary",
  "HakiLegendary",
  "TyrantOfTheSkies",
  "KitsuneIsland"
];

const BOTS = BOSS_LIST.map((boss, index) => ({
  id: boss.toLowerCase() + "_boss",
  name: boss + " Bot",
  url: CONFIG.bot.baseUrl + boss,
  bossType: boss.toLowerCase(),
  enabled: true,
  order: index + 1,
  interval: null
}));

// =====================================================
// ====== NIGHTHUB DECODER (giữ nguyên để xử lý dữ liệu) ======
// =====================================================
const NIGHTHUB_MAP = {
  "KP7": "-", "Nbi": "0", "KpR": "1", "pSp": "2", "Spb": "3",
  "bGb": "4", "Aop": "5", "Vpb": "6", "KpS": "7", "8bi": "8",
  "Fpb": "9", "bi3": "a", "GbA": "b", "7bA": "c", "wbI": "d",
  "ba3": "e", "kbi": "f"
};

function decodeNightHub(encoded) {
  if (!encoded || typeof encoded !== 'string') return null;
  let s = encoded.trim();
  if (s.startsWith("NIGHTHUB|")) s = s.slice(9);
  if (!s.includes('3p')) {
    const tokens = s.split(/[\s,|]+/).filter(t => t.length > 0);
    return tokens.map(t => NIGHTHUB_MAP[t] !== undefined ? NIGHTHUB_MAP[t] : "?").join("");
  }
  const tokens = s.split('3p');
  const result = [];
  for (let i = 1; i < tokens.length; i += 2) {
    const token = tokens[i].trim();
    result.push(NIGHTHUB_MAP[token] !== undefined ? NIGHTHUB_MAP[token] : "?");
  }
  return result.length > 0 ? result.join("") : null;
}

// =====================================================
// ====== IP ALLOWLIST (chỉ dùng cho dashboard) ======
// =====================================================
function isIPAllowed(ip) {
  const cleanIP = ip.split(':')[0];
  return CONFIG.allowedIPs.includes(cleanIP);
}

function getClientIP(req) {
  const clientIP = req.socket.remoteAddress ||
                   req.connection.remoteAddress ||
                   req.headers['x-forwarded-for'] ||
                   'unknown';
  let realIP = clientIP;
  if (clientIP.includes(',')) realIP = clientIP.split(',')[0].trim();
  if (realIP.startsWith('::ffff:')) realIP = realIP.substring(7);
  return realIP;
}

// =====================================================
// ====== LOGGING & STATS ======
// =====================================================
const LOG_FILE = path.join(__dirname, CONFIG.logging.file);
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

let stats = {
  totalFetches: 0,
  totalPushed: 0,
  totalErrors: 0,
  lastUpdate: null,
  botStats: {},
  bossData: []
};

BOTS.forEach(bot => {
  stats.botStats[bot.id] = {
    name: bot.name,
    fetches: 0,
    successes: 0,
    errors: 0,
    lastFetch: null,
    lastData: []
  };
});

function log(message, type = "INFO", botId = null) {
  const timestamp = new Date().toISOString();
  const botTag = botId ? `[${botId}]` : "";
  console.log(`[${timestamp}] [${type}] ${botTag} ${message}`);
}

function saveStats() {
  try {
    fs.writeFileSync(LOG_FILE, JSON.stringify({ ...stats, lastSaved: new Date().toISOString() }, null, 2));
  } catch (error) {
    log(`Lỗi lưu stats: ${error.message}`, "ERROR");
  }
}

function loadStats() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      const data = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
      stats = { ...stats, ...data };
      log(`📂 Đã load stats`, "INFO");
    }
  } catch (error) {
    log(`Lỗi load stats: ${error.message}`, "ERROR");
  }
}

// =====================================================
// ====== FETCH TẤT CẢ BOTS TRONG 1 LẦN ======
// =====================================================
async function fetchAllBotsData() {
  log(`🔄 Bắt đầu fetch tất cả ${BOTS.length} bots...`, "INFO");
  const allBossData = [];
  let successCount = 0;

  for (const bot of BOTS) {
    if (!bot.enabled) continue;
    try {
      const result = await fetchBotDataPromise(bot);
      if (result.data && result.data.length > 0) {
        allBossData.push(...result.data);
        successCount++;
      }
    } catch (error) {
      log(`Lỗi fetch ${bot.id}: ${error.message}`, "ERROR", bot.id);
      stats.botStats[bot.id].errors++;
      stats.totalErrors++;
    }
  }

  // Xoá toàn bộ dữ liệu cũ và thêm mới
  if (allBossData.length > 0) {
    stats.bossData = allBossData;
    stats.totalFetches += successCount;
    stats.lastUpdate = new Date().toISOString();
    saveStats();
    pushToAPI(allBossData);
    log(`✅ Hoàn thành: ${allBossData.length} boss từ ${successCount} bots`, "SUCCESS");
  } else {
    log(`⚠️ Không có dữ liệu mới`, "WARN");
  }
  return { totalBoss: allBossData.length };
}

function fetchBotDataPromise(bot) {
  return new Promise((resolve) => {
    if (!bot.enabled) return resolve({ bot, data: [], error: "Bot disabled" });
    const httpModule = bot.url.startsWith("https") ? https : http;
    const agent = bot.url.startsWith("https") ? httpsAgent : httpAgent;
    const startTime = Date.now();
    log(`🔄 Đang fetch ${bot.name}...`, "INFO", bot.id);

    const req = httpModule.get(bot.url, { agent, timeout: CONFIG.bot.timeout }, (res) => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          const items = json.data || [];
          const results = [];
          for (const item of items) {
            const jobIdEncoded = item.JobId;
            if (!jobIdEncoded) continue;
            const jobId = decodeNightHub(jobIdEncoded);
            if (!jobId) continue;
            let boss = bot.bossType;
            if (boss === "sword" && item.Name && item.Name !== "Unknown") {
              boss = "sword_" + item.Name.toLowerCase();
            }
            results.push({
              jobId: jobId,
              jobIdEncoded: jobIdEncoded,
              boss: boss,
              bossDisplay: bot.name,
              players: item.Players || 0,
              sea: item.Sea || "Unknown",
              name: item.Name || "",
              botId: bot.id,
              timestamp: new Date().toISOString()
            });
          }
          const duration = Date.now() - startTime;
          stats.botStats[bot.id].fetches++;
          stats.botStats[bot.id].successes++;
          stats.botStats[bot.id].lastFetch = new Date().toISOString();
          stats.botStats[bot.id].lastData = results;
          log(`✅ ${bot.name}: ${results.length} boss (${duration}ms)`, "SUCCESS", bot.id);
          resolve({ bot, data: results, error: null, duration });
        } catch (error) {
          const duration = Date.now() - startTime;
          log(`❌ Lỗi parse JSON ${bot.name}: ${error.message}`, "ERROR", bot.id);
          stats.botStats[bot.id].errors++;
          stats.totalErrors++;
          resolve({ bot, data: [], error: error.message });
        }
      });
    });

    req.on("error", (error) => {
      const duration = Date.now() - startTime;
      log(`❌ Lỗi fetch ${bot.name}: ${error.message}`, "ERROR", bot.id);
      stats.botStats[bot.id].errors++;
      stats.totalErrors++;
      resolve({ bot, data: [], error: error.message });
    });

    req.on("timeout", () => {
      req.destroy();
      const duration = Date.now() - startTime;
      log(`⏰ Timeout ${bot.name} (${duration}ms)`, "ERROR", bot.id);
      stats.botStats[bot.id].errors++;
      stats.totalErrors++;
      resolve({ bot, data: [], error: "Timeout" });
    });
  });
}

// =====================================================
// ====== PUSH TO API ======
// =====================================================
function pushToAPI(bossData, retries = CONFIG.bot.retries) {
  if (!bossData || bossData.length === 0) return;
  const postData = JSON.stringify({
    data: bossData,
    timestamp: new Date().toISOString(),
    total: bossData.length,
    botId: 'all_bots'
  });
  const url = new URL(CONFIG.api.url + "/push");
  const options = {
    hostname: url.hostname,
    path: url.pathname,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(postData)
    },
    agent: url.protocol === "https:" ? httpsAgent : httpAgent,
    timeout: CONFIG.bot.timeout + 5000
  };
  const req = (url.protocol === "https:" ? https : http).request(options, (res) => {
    let body = "";
    res.on("data", chunk => { body += chunk; });
    res.on("end", () => {
      if (res.statusCode === 200 || res.statusCode === 201) {
        log(`✅ Đã push ${bossData.length} boss`, "SUCCESS");
        stats.totalPushed += bossData.length;
        saveStats();
      } else {
        log(`❌ Push thất bại (status: ${res.statusCode})`, "ERROR");
        if (retries > 0) setTimeout(() => pushToAPI(bossData, retries - 1), 2000);
      }
    });
  });
  req.on("error", (error) => {
    log(`❌ Lỗi push API: ${error.message}`, "ERROR");
    if (retries > 0) setTimeout(() => pushToAPI(bossData, retries - 1), 2000);
  });
  req.on("timeout", () => {
    req.destroy();
    log(`⏰ Timeout push API`, "ERROR");
    if (retries > 0) setTimeout(() => pushToAPI(bossData, retries - 1), 2000);
  });
  req.write(postData);
  req.end();
}

// =====================================================
// ====== START SCHEDULER ======
// =====================================================
function startBotScheduler() {
  log(`🚀 Scheduler: fetch tất cả ${BOTS.length} bots mỗi ${CONFIG.bot.pollInterval/1000}s`, "INFO");
  function runAll() {
    fetchAllBotsData().catch(err => log(`Lỗi fetch all: ${err.message}`, "ERROR"));
  }
  setTimeout(runAll, 2000);
  setInterval(runAll, CONFIG.bot.pollInterval);
}

// =====================================================
// ====== WEB SERVER ======
// =====================================================
const server = http.createServer((req, res) => {
  const url = req.url;
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
  if (req.method === "OPTIONS") {
    res.writeHead(200, corsHeaders);
    res.end();
    return;
  }

  // =====================================================
  // ====== DASHBOARD – CHỈ CHO PHÉP IP ALLOWLIST ======
  // =====================================================
  if (url === "/dashboardbujob" || url === "/dashboardbujob/") {
    const clientIP = getClientIP(req);
    if (!isIPAllowed(clientIP)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("403 Forbidden - Access Denied");
      return;
    }
    // Render dashboard (đã loại bỏ mọi từ khoá decode, nighthub, url fetch)
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🤖 Boss Bot Tracker</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Arial; background: #0a0e1a; color: #e0e0e0; padding: 20px; }
    .container { max-width: 1400px; margin: 0 auto; }
    h1 { color: #00d4ff; font-size: 2.5em; margin-bottom: 5px; }
    .subtitle { color: #8899aa; margin-bottom: 30px; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 15px; margin: 20px 0; }
    .stat-card { background: #141c2b; padding: 20px; border-radius: 10px; border: 1px solid #1e2d42; }
    .stat-card .number { font-size: 2em; color: #00d4ff; font-weight: bold; }
    .stat-card .label { color: #8899aa; margin-top: 5px; }
    .controls { margin: 20px 0; display: flex; gap: 10px; flex-wrap: wrap; }
    .btn { background: #1a2a3a; color: #00d4ff; border: 1px solid #00d4ff44; padding: 10px 25px; border-radius: 8px; cursor: pointer; font-size: 14px; }
    .btn:hover { background: #00d4ff; color: #0a0e1a; }
    .btn.danger { border-color: #ff6b6b44; color: #ff6b6b; }
    .btn.danger:hover { background: #ff6b6b; color: #0a0e1a; }
    .bot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 15px; margin: 20px 0; }
    .bot-card { background: #141c2b; padding: 15px; border-radius: 10px; border-left: 4px solid #00d4ff; }
    .bot-card .name { font-weight: bold; color: #ffd700; }
    .bot-card .status { font-size: 0.9em; }
    .bot-card .status.online { color: #66ff88; }
    .bot-card .status.offline { color: #ff6b6b; }
    .bot-card .detail { color: #8899aa; font-size: 0.85em; margin-top: 3px; }
    .bot-card .interval { color: #ffa94d; font-size: 0.85em; margin-top: 3px; }
    .bot-card .btn-small { margin-top: 8px; padding: 4px 12px; font-size: 12px; background: #1a2a3a; color: #00d4ff; border: 1px solid #00d4ff44; border-radius: 5px; cursor: pointer; }
    .bot-card .btn-small:hover { background: #00d4ff; color: #0a0e1a; }
    .endpoint { background: #0a0e1a; padding: 8px 12px; border-radius: 5px; margin: 3px 0; font-family: monospace; font-size: 13px; }
    .endpoint .highlight { color: #00d4ff; }
    .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #1e2d42; color: #667; font-size: 0.9em; }
    @media (max-width: 600px) { .bot-grid { grid-template-columns: 1fr; } h1 { font-size: 1.8em; } }
  </style>
</head>
<body>
<div class="container">
  <h1>🤖 Boss Bot Tracker</h1>
  <p class="subtitle">${BOTS.length} bots | Fetch tất cả mỗi ${CONFIG.bot.pollInterval/1000}s</p>
  <div class="stats-grid">
    <div class="stat-card"><div class="number">${BOTS.length}</div><div class="label">Tổng bots</div></div>
    <div class="stat-card"><div class="number">${stats.totalFetches}</div><div class="label">Lần fetch</div></div>
    <div class="stat-card"><div class="number">${stats.totalPushed}</div><div class="label">Đã push</div></div>
    <div class="stat-card"><div class="number">${stats.bossData.length}</div><div class="label">Dữ liệu hiện tại</div></div>
  </div>
  <div class="controls">
    <button class="btn" onclick="fetchAll()">🔄 Fetch All Bots</button>
    <button class="btn danger" onclick="clearData()">🗑️ Clear Data</button>
    <span style="color:#667;margin-left:10px;">⏰ Fetch tất cả mỗi ${CONFIG.bot.pollInterval/1000}s</span>
  </div>
  <div style="background:#141c2b;padding:15px;border-radius:10px;margin:20px 0;border:1px solid #1e2d42;">
    <h3 style="color:#00d4ff;margin-bottom:10px;">📡 API Boss</h3>
    <div class="endpoint">GET <span class="highlight">/boss</span> - Tất cả boss</div>
    <div class="endpoint">GET <span class="highlight">/boss/:name</span> - Boss theo tên (VD: /boss/CakePrince)</div>
    <div class="endpoint">GET <span class="highlight">/job/:id</span> - Tìm boss theo JobId</div>
    <div class="endpoint">GET <span class="highlight">/boss-list</span> - Danh sách tất cả boss</div>
  </div>
  <h2>📊 Danh sách Bot</h2>
  <div class="bot-grid" id="botGrid">
    ${BOTS.map(bot => `
      <div class="bot-card" id="bot-${bot.id}">
        <div class="name">#${bot.order} ${bot.name}</div>
        <div class="status ${bot.enabled ? 'online' : 'offline'}">${bot.enabled ? '🟢 Online' : '🔴 Offline'}</div>
        <div class="interval">⏱️ Interval: ${CONFIG.bot.pollInterval/1000}s</div>
        <div class="detail">📥 Fetch: ${stats.botStats[bot.id]?.fetches || 0}</div>
        <div class="detail">✅ Success: ${stats.botStats[bot.id]?.successes || 0}</div>
        <div class="detail">❌ Errors: ${stats.botStats[bot.id]?.errors || 0}</div>
        <button class="btn-small" onclick="fetchBot('${bot.id}')">🔄 Fetch</button>
        <button class="btn-small" onclick="viewBoss('${bot.bossType}')" style="margin-left:5px;">👁️ View</button>
      </div>
    `).join('')}
  </div>
  <div class="footer">
    📂 Log: ${LOG_FILE} | 🕐 Last update: ${stats.lastUpdate || 'Chưa có'}<br>
    ⏱️ Interval: ${CONFIG.bot.pollInterval/1000}s | Tất cả bots fetch cùng lúc
  </div>
</div>
<script>
async function fetchAll() {
  const btn = event.target;
  btn.textContent = '⏳...';
  btn.disabled = true;
  try {
    const res = await fetch('/fetch');
    const data = await res.json();
    alert('✅ Đã fetch tất cả bots!');
    setTimeout(() => location.reload(), 1500);
  } catch(e) { alert('❌ Lỗi: ' + e.message); }
  btn.textContent = '🔄 Fetch All Bots';
  btn.disabled = false;
}
async function fetchBot(botId) {
  const btn = event.target;
  btn.textContent = '⏳';
  btn.disabled = true;
  try {
    const res = await fetch('/fetch/' + botId);
    alert('✅ Đã fetch bot!');
    setTimeout(() => location.reload(), 1500);
  } catch(e) { alert('❌ Lỗi: ' + e.message); }
  btn.textContent = '🔄 Fetch';
  btn.disabled = false;
}
function viewBoss(bossType) {
  window.open('/boss/' + bossType, '_blank');
}
function clearData() {
  if(confirm('Xóa tất cả dữ liệu?')) {
    window.location.href = '/clear';
  }
}
</script>
</body>
</html>
    `);
    return;
  }

  // =====================================================
  // ====== API – TẤT CẢ IP ĐỀU ĐƯỢC PHÉP ======
  // =====================================================
  if (url === "/boss" || url === "/boss/") {
    res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
    const data = stats.bossData.map(item => ({
      JobId: item.jobId,
      Players: item.players,
      Sea: item.sea,
      Name: item.name || item.bossDisplay,
      BotId: item.botId,
      Timestamp: item.timestamp
    }));
    res.end(JSON.stringify({ success: true, data, total: data.length, timestamp: new Date().toISOString() }, null, 2));
    return;
  }

  if (url.startsWith("/boss/") && url !== "/boss/decode" && url !== "/boss/decode/") {
    const bossName = url.split("/")[2];
    const bot = BOTS.find(b => b.bossType.toLowerCase() === bossName.toLowerCase());
    if (!bot) {
      res.writeHead(404, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify({ error: "Boss not found", available: BOSS_LIST }, null, 2));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
    const data = stats.bossData
      .filter(item => item.botId === bot.id)
      .map(item => ({
        JobId: item.jobId,
        Players: item.players,
        Sea: item.sea,
        Name: item.name || item.bossDisplay,
        BotId: item.botId,
        Timestamp: item.timestamp
      }));
    res.end(JSON.stringify({ success: true, boss: bossName, data, total: data.length, timestamp: new Date().toISOString() }, null, 2));
    return;
  }

  if (url.startsWith("/job/")) {
    const jobId = url.split("/")[2];
    if (!jobId) {
      res.writeHead(400, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify({ error: "JobId is required" }, null, 2));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
    const data = stats.bossData.filter(item => item.jobId === jobId);
    res.end(JSON.stringify({ success: true, jobId, data, found: data.length > 0, timestamp: new Date().toISOString() }, null, 2));
    return;
  }

  if (url === "/stats" || url === "/api/stats") {
    res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
    res.end(JSON.stringify({
      ...stats,
      bots: BOTS.map(b => ({ id: b.id, name: b.name, enabled: b.enabled, stats: stats.botStats[b.id], interval: CONFIG.bot.pollInterval / 1000 + 's' })),
      uptime: process.uptime(),
      status: "running",
      totalBots: BOTS.length,
      bossList: BOSS_LIST,
      pollInterval: CONFIG.bot.pollInterval / 1000 + 's'
    }, null, 2));
    return;
  }

  if (url === "/bots") {
    res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
    res.end(JSON.stringify({ bots: BOTS.map(b => ({ ...b, interval: CONFIG.bot.pollInterval / 1000 + 's' })), total: BOTS.length }, null, 2));
    return;
  }

  if (url === "/boss-list") {
    res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
    res.end(JSON.stringify({ bossList: BOSS_LIST, total: BOSS_LIST.length, endpoints: BOSS_LIST.map(boss => `/boss/${boss}`) }, null, 2));
    return;
  }

  if (url === "/fetch" || url === "/api/fetch") {
    res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
    res.end(JSON.stringify({ message: "Đang fetch tất cả bots..." }));
    fetchAllBotsData();
    return;
  }

  if (url.startsWith("/fetch/")) {
    const botId = url.split("/")[2];
    const bot = BOTS.find(b => b.id === botId);
    if (!bot) {
      res.writeHead(404, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify({ error: "Bot not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
    res.end(JSON.stringify({ message: `Đang fetch bot ${bot.name}...` }));
    fetchBotDataPromise(bot).then(result => {
      if (result.data && result.data.length > 0) {
        stats.bossData = stats.bossData.filter(item => item.botId !== bot.id);
        stats.bossData.push(...result.data);
        stats.totalFetches++;
        stats.lastUpdate = new Date().toISOString();
        saveStats();
        pushToAPI(result.data);
      }
    });
    return;
  }

  if (url === "/data" || url === "/api/data") {
    res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
    res.end(JSON.stringify({ total: stats.bossData.length, data: stats.bossData.slice(0, 100), timestamp: new Date().toISOString() }, null, 2));
    return;
  }

  if (url === "/clear") {
    stats.bossData = [];
    stats.totalFetches = 0;
    stats.totalPushed = 0;
    stats.totalErrors = 0;
    BOTS.forEach(bot => {
      stats.botStats[bot.id].fetches = 0;
      stats.botStats[bot.id].successes = 0;
      stats.botStats[bot.id].errors = 0;
      stats.botStats[bot.id].lastData = [];
    });
    saveStats();
    res.writeHead(302, { Location: "/dashboardbujob" });
    res.end();
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("404: Not Found");
});

// =====================================================
// ====== START SERVER ======
// =====================================================
loadStats();
server.listen(CONFIG.server.port, CONFIG.server.host, () => {
  log(`🚀 Server: http://${CONFIG.server.host}:${CONFIG.server.port}`, "INFO");
  log(`📋 API: ${CONFIG.api.url}`, "INFO");
  log(`🤖 Bots: ${BOTS.length}`, "INFO");
  log(`⏰ Interval: ${CONFIG.bot.pollInterval/1000}s (tất cả bots cùng lúc)`, "INFO");
  log(`📡 Dashboard: http://${CONFIG.server.host}:${CONFIG.server.port}/dashboardbujob (chỉ IP được phép)`, "INFO");
  log(`📡 Boss API: http://${CONFIG.server.host}:${CONFIG.server.port}/boss (cho phép tất cả IP)`, "INFO");
  log(`🔒 IP được phép xem dashboard: ${CONFIG.allowedIPs.join(', ')}`, "INFO");
});

startBotScheduler();

process.on('SIGINT', () => { log("🛑 Shutdown...", "WARN"); saveStats(); process.exit(0); });
process.on('SIGTERM', () => { log("🛑 Shutdown...", "WARN"); saveStats(); process.exit(0); });

module.exports = { server, fetchAllBotsData, decodeNightHub, BOTS, BOSS_LIST, stats, startBotScheduler };
