// ===================== REQUIRE MODULES =====================
const fs = require('fs');
const path = require('path');
const net = require('net');
const express = require('express');
const archiver = require('archiver');
const fetch = require('node-fetch'); // v2
const { HttpsProxyAgent } = require('https-proxy-agent');
const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder, ActivityType } = require('discord.js');

// ===================== HARD-CODED CONFIG (thay tại đây) =====================
const CFG = {
 TOKEN: process.env.DISCORD_TOKEN,
  CHANNEL_ID: '1405583443819106304',
  AUTO_SEND_MINUTES: 60,         // tự động gửi định kỳ (phút). 0 = tắt
  HTTP_TIMEOUT_MS: 3000,
  TCP_TIMEOUT_MS: 2000,
  CONCURRENCY: 50,
  SPLIT_LINES: 6000,             // tách file khi > n dòng
  ZIP_THRESHOLD: 15000,          // nếu tổng dòng > ngưỡng -> nén zip
  PROGRESS_EVERY_MS: 60_000,
  TEST_TARGET_1: 'https://httpbin.org/ip',
  TEST_TARGET_2: 'https://www.google.com/generate_204',
};

// ===================== SOURCES (HTTP/SOCKS) =====================
const SOURCES = {
  http: [
    'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all',
    'https://www.proxy-list.download/api/v1/get?type=http',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
    'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt',
    'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=3000&country=all&ssl=all&anonymity=all',
    'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=3000&country=all&ssl=all&anonymity=all',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies_anonymous/http.txt',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies_elite/http.txt',
    'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
    'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
    'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt',
    'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt',
    'https://raw.githubusercontent.com/UserR3X/proxy-list/main/online/http.txt',
    'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
    'https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt',
    'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt',
    'https://raw.githubusercontent.com/Anonym0usWork1221/Free-Proxies/main/proxy_list.txt',
    'https://raw.githubusercontent.com/HyperBeats/proxy-list/main/http.txt',
    'https://raw.githubusercontent.com/hookzof/socks5_list/master/http.txt',
    'https://raw.githubusercontent.com/prxchk/proxy-list/main/http.txt',
    'https://raw.githubusercontent.com/mertguvencli/http-proxy-list/main/proxy-list/data.txt',
    'https://raw.githubusercontent.com/officialputuid/KangProxy/KangProxy/http/http.txt',
    'https://raw.githubusercontent.com/zevtyardt/proxy-list/main/http.txt',
    'https://raw.githubusercontent.com/yemixzy/proxy-list/main/proxies/http.txt',
    'https://raw.githubusercontent.com/ALIILAPRO/Proxy/main/http.txt',
    'https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt',
    'https://raw.githubusercontent.com/Zaeem20/FREE_PROXIES_LIST/master/http.txt',
    'https://raw.githubusercontent.com/iw4p/proxy-list/main/http.txt',
    'https://raw.githubusercontent.com/TuanMinPay/live-proxy/main/http.txt',
    'https://raw.githubusercontent.com/hktalent/anonymous-proxy-list/master/http.txt',
    'https://raw.githubusercontent.com/B4RC0DE-TM/proxy-list/main/HTTP.txt',
    'https://raw.githubusercontent.com/saisuiu/uiu/main/free.txt',
  ],
  socks4: [
    'https://www.proxy-list.download/api/v1/get?type=socks4',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt',
  ],
  socks5: [
    'https://www.proxy-list.download/api/v1/get?type=socks5',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
  ],
};

// ===================== KEEP-ALIVE (tùy chọn) =====================
try {
  const app = express();
  app.get('/', (_, res) => res.send('Proxy Bot is running ✅'));
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`🌐 Keep-alive HTTP on :${PORT}`));
} catch (_) {}

// ===================== GLOBAL STATE =====================
let LAST_ALIVE_LIST = []; // cập nhật liên tục khi tìm được proxy sống
let PROGRESS = {
  currentType: '',
  phase: 'idle',
  startedAt: null,
  totalPulled: 0,
  checked: 0,
  alive: 0,
};
let AUTO_TIMER = null;
let DAILY_STATS = { pulls: 0, alive: 0 };

// ===================== UTILS =====================
const ipPortRegex = /(\d{1,3}\.){3}\d{1,3}:\d{2,5}/;

function buildEmbed({ title, desc, fields = [], color = 0x4ea1ff, footer }) {
  const e = new EmbedBuilder().setTitle(title).setDescription(desc).setColor(color);
  if (fields.length) e.addFields(fields);
  if (footer) e.setFooter({ text: footer });
  return e;
}

function uniqIpPorts(list) {
  const set = new Set();
  const out = [];
  for (const line of list) {
    const m = (line || '').match(ipPortRegex);
    if (!m) continue;
    const v = m[0];
    if (!set.has(v)) { set.add(v); out.push(v); }
  }
  return out;
}

function writeTxtOrZip(baseName, data, zipThreshold, splitLines) {
  const files = [];
  if (data.length > zipThreshold) {
    const zipName = `${baseName}.zip`;
    const output = fs.createWriteStream(zipName);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(output);
    let part = 1;
    for (let i = 0; i < data.length; i += splitLines) {
      archive.append(data.slice(i, i + splitLines).join('\n'), { name: `${baseName}_part${part}.txt` });
      part++;
    }
    archive.finalize();
    files.push(zipName);
  } else if (data.length > splitLines) {
    let part = 1;
    for (let i = 0; i < data.length; i += splitLines) {
      const fileName = `${baseName}_part${part}.txt`;
      fs.writeFileSync(fileName, data.slice(i, i + splitLines).join('\n'));
      files.push(fileName);
      part++;
    }
  } else {
    const fileName = `${baseName}.txt`;
    fs.writeFileSync(fileName, data.join('\n'));
    files.push(fileName);
  }
  return files;
}

async function mapLimit(arr, limit, fn) {
  const ret = new Array(arr.length);
  let i = 0;
  async function worker() {
    while (i < arr.length) {
      const idx = i++;
      ret[idx] = await fn(arr[idx], idx);
    }
  }
  await Promise.all(Array(Math.min(limit, arr.length)).fill(0).map(worker));
  return ret;
}

// ===================== FETCH SOURCES =====================
async function pullProxiesOf(type) {
  const urls = SOURCES[type] || [];
  if (!urls.length) return [];
  const all = [];
  await Promise.all(urls.map(async (u) => {
    try {
      const res = await fetch(u, { timeout: 12_000 });
      if (!res.ok) return;
      const text = await res.text();
      all.push(...text.split(/\r?\n/));
    } catch { /* ignore */ }
  }));
  const list = uniqIpPorts(all);
  DAILY_STATS.pulls += list.length;
  return list;
}

// ===================== TESTERS =====================
async function testHttpViaProxy(proxy, timeout, t1, t2) {
  try {
    const agent = new HttpsProxyAgent(`http://${proxy}`);
    const r1 = await fetch(t1, { agent, timeout });
    if (!r1.ok) return false;
    const r2 = await fetch(t2, { agent, timeout });
    return r2.ok;
  } catch { return false; }
}

function testProxyTcp(proxy, timeout) {
  return new Promise((resolve) => {
    const [host, port] = proxy.split(':');
    const socket = net.connect({ host, port: Number(port) });
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; socket.destroy(); resolve(false); } }, timeout);
    socket.on('connect', () => { if (!done) { done = true; clearTimeout(timer); socket.destroy(); resolve(true); } });
    socket.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve(false); } });
  });
}

// ===================== FILTERS =====================
function progressEmbed(extra = '') {
  const elapsed = PROGRESS.startedAt ? Math.round((Date.now() - PROGRESS.startedAt) / 1000) : 0;
  return buildEmbed({
    title: `📡 Tiến trình: ${PROGRESS.currentType.toUpperCase()} (${PROGRESS.phase})`,
    desc: extra || 'Đang xử lý…',
    fields: [
      { name: 'Tổng (pulled)', value: String(PROGRESS.totalPulled), inline: true },
      { name: 'Đã kiểm', value: String(PROGRESS.checked), inline: true },
      { name: 'Alive', value: String(PROGRESS.alive), inline: true },
      { name: 'Thời gian', value: `${elapsed}s`, inline: true },
    ],
  });
}

async function filterAliveHTTP(proxies) {
  PROGRESS.phase = 'testing';
  PROGRESS.startedAt = Date.now();
  PROGRESS.totalPulled = proxies.length;
  PROGRESS.checked = 0;
  PROGRESS.alive = 0;

  const res = await mapLimit(proxies, CFG.CONCURRENCY, async (p) => {
    const ok = await testHttpViaProxy(p, CFG.HTTP_TIMEOUT_MS, CFG.TEST_TARGET_1, CFG.TEST_TARGET_2);
    PROGRESS.checked++;
    if (ok) { PROGRESS.alive++; LAST_ALIVE_LIST.push(p); DAILY_STATS.alive++; return p; }
    return null;
  });

  PROGRESS.phase = 'idle';
  return res.filter(Boolean);
}

async function filterAliveSOCKS(proxies) {
  PROGRESS.phase = 'testing';
  PROGRESS.startedAt = Date.now();
  PROGRESS.totalPulled = proxies.length;
  PROGRESS.checked = 0;
  PROGRESS.alive = 0;

  const res = await mapLimit(proxies, CFG.CONCURRENCY, async (p) => {
    const ok = await testProxyTcp(p, CFG.TCP_TIMEOUT_MS);
    PROGRESS.checked++;
    if (ok) { PROGRESS.alive++; LAST_ALIVE_LIST.push(p); DAILY_STATS.alive++; return p; }
    return null;
  });

  PROGRESS.phase = 'idle';
  return res.filter(Boolean);
}

// ===================== GEO LOOKUP (tiện ích) =====================
async function geoLookup(ip) {
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city,isp,org,query`, { timeout: 8000 });
    if (!res.ok) return null;
    const j = await res.json();
    if (j.status !== 'success') return null;
    return j; // {country, city, isp, org, query...}
  } catch { return null; }
}

// ===================== DISCORD BOT =====================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.user.setPresence({
    activities: [{ type: ActivityType.Streaming, name: 'Tsukuyomi Realm Network🌙' }],
    status: 'online',
  });

  if (CFG.AUTO_SEND_MINUTES > 0) {
    scheduleAutoSend();
  }
});

function scheduleAutoSend() {
  if (AUTO_TIMER) clearInterval(AUTO_TIMER);
  AUTO_TIMER = setInterval(async () => {
    try {
      const ch = await client.channels.fetch(CFG.CHANNEL_ID);
      if (!ch) return;
      const allAlive = LAST_ALIVE_LIST.slice(0); // snapshot
      if (!allAlive.length) return;
      const files = writeTxtOrZip(`auto_alive_${Date.now()}`, allAlive, CFG.ZIP_THRESHOLD, CFG.SPLIT_LINES);
      const atts = files.map(f => new AttachmentBuilder(path.resolve(f)));
      await ch.send({ content: `⏱️ Auto-send: **${allAlive.length}** proxy alive`, files: atts });
    } catch (e) { console.error('Auto-send error:', e.message); }
  }, Math.max(1, CFG.AUTO_SEND_MINUTES) * 60_000);
}

// ===================== COMMAND HANDLER =====================
client.on('messageCreate', async (msg) => {
  if (!msg.content || msg.author.bot) return;
  if (!msg.content.startsWith('!')) return;

  const parts = msg.content.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg1 = parts[1];

  // ---- !proxy sources
  if (cmd === '!proxy' && arg1 === 'sources') {
    const fields = Object.keys(SOURCES).map(k => ({
      name: k.toUpperCase(),
      value: SOURCES[k].map(u => `• ${u.replace(/^https?:\/\//, '')}`).join('\n').slice(0, 1024) || '—',
    }));
    return msg.reply({ embeds: [buildEmbed({ title: '📚 Nguồn Proxy', desc: 'HTTP / SOCKS4 / SOCKS5', fields })] });
  }

  // ---- !proxy config
  if (cmd === '!proxy' && arg1 === 'config') {
    const e = buildEmbed({
      title: '⚙️ Cấu hình',
      desc: [
        `AUTO_SEND_MINUTES: **${CFG.AUTO_SEND_MINUTES}**`,
        `HTTP_TIMEOUT_MS: **${CFG.HTTP_TIMEOUT_MS}**`,
        `TCP_TIMEOUT_MS: **${CFG.TCP_TIMEOUT_MS}**`,
        `CONCURRENCY: **${CFG.CONCURRENCY}**`,
        `SPLIT_LINES: **${CFG.SPLIT_LINES}**`,
        `ZIP_THRESHOLD: **${CFG.ZIP_THRESHOLD}**`,
        `TEST_TARGET_1: ${CFG.TEST_TARGET_1}`,
        `TEST_TARGET_2: ${CFG.TEST_TARGET_2}`,
      ].join('\n'),
    });
    return msg.reply({ embeds: [e] });
  }

  // ---- !progress
  if (cmd === '!progress') {
    if (PROGRESS.phase === 'idle') return msg.reply('✅ Hiện không có tác vụ đang chạy.');
    return msg.reply({ embeds: [progressEmbed('Tiến trình hiện tại.')] });
  }

  // ---- !save
  if (cmd === '!save') {
    if (!LAST_ALIVE_LIST.length) {
      return msg.reply('📂 Chưa có proxy alive nào được lưu gần đây.');
    }
    const ts = new Date().toISOString().replace(/[:T]/g, '-').split('.')[0];
    const fileName = `alive-${ts}.txt`;
    fs.writeFileSync(fileName, LAST_ALIVE_LIST.join('\n'), 'utf8');
    return msg.reply({
      content: `📦 Danh sách proxy alive (${LAST_ALIVE_LIST.length} cái):`,
      files: [path.resolve(fileName)],
    });
  }

  // ---- !stats
  if (cmd === '!stats') {
    const e = buildEmbed({
      title: '📈 Thống kê hôm nay',
      desc: [
        `Pulled: **${DAILY_STATS.pulls}**`,
        `Alive: **${DAILY_STATS.alive}**`,
      ].join('\n'),
    });
    return msg.reply({ embeds: [e] });
  }

  // ---- !geo <ip:port|ip>
  if (cmd === '!geo') {
    const target = (arg1 || '').split(':')[0];
    if (!target) return msg.reply('Dùng: `!geo <ip>` hoặc `!geo <ip:port>`');
    const info = await geoLookup(target);
    if (!info) return msg.reply('❌ Không tra cứu được GeoIP.');
    const e = buildEmbed({
      title: `📍 GeoIP: ${info.query}`,
      desc: `**Country:** ${info.country || '—'}\n**Region:** ${info.regionName || '—'}\n**City:** ${info.city || '—'}\n**ISP:** ${info.isp || '—'}\n**Org:** ${info.org || '—'}`,
    });
    return msg.reply({ embeds: [e] });
  }

  // ---- !proxy raw http|socks4|socks5|all [limit]
  if (cmd === '!proxy' && arg1 === 'raw') {
    const type = (parts[2] || 'http').toLowerCase();
    const limit = Number(parts[3] || 0) || null;
    if (!['http','socks4','socks5','all'].includes(type)) {
      return msg.reply('❌ Dùng: `!proxy raw http|socks4|socks5|all [limit]`');
    }
    await msg.reply(`📦 Đang gộp **${type.toUpperCase()}** (không test)...`);

    let data = [];
    if (type === 'all') {
      const [h, s4, s5] = await Promise.all(['http','socks4','socks5'].map(pullProxiesOf));
      data = uniqIpPorts([...h, ...s4, ...s5]);
    } else {
      data = await pullProxiesOf(type);
    }
    if (limit) data = data.slice(0, limit);
    if (!data.length) return msg.reply('❌ Không có proxy.');

    const files = writeTxtOrZip(`proxy_${type}_raw`, data, CFG.ZIP_THRESHOLD, CFG.SPLIT_LINES);
    const atts  = files.map(f => new AttachmentBuilder(path.resolve(f)));
    const e = buildEmbed({ title: `📦 RAW ${type.toUpperCase()}`, desc: `Tổng: **${data.length}** (chưa test)` });
    return msg.reply({ embeds: [e], files: atts });
  }

  // ---- !proxy [http|socks4|socks5|all] [limit]
  if (cmd === '!proxy' && (!arg1 || ['http','socks4','socks5','all'].includes(arg1.toLowerCase()))) {
    const type = (arg1 || 'http').toLowerCase();
    const limit = Number(parts[2] || 0) || null;

    await msg.reply(`🔎 Đang lấy & test **${type.toUpperCase()}**...`);
    LAST_ALIVE_LIST = []; // reset snapshot mới
    let alive = [];
    let pulledCount = { http: 0, socks4: 0, socks5: 0 };

    const doHTTP = async () => {
      PROGRESS.currentType = 'http';
      PROGRESS.phase = 'pulling';
      const pulled = await pullProxiesOf('http');
      pulledCount.http = pulled.length;
      const live = await filterAliveHTTP(pulled);
      alive.push(...live);
    };

    const doSOCKS = async (kind) => {
      PROGRESS.currentType = kind;
      PROGRESS.phase = 'pulling';
      const pulled = await pullProxiesOf(kind);
      pulledCount[kind] = pulled.length;
      const live = await filterAliveSOCKS(pulled);
      alive.push(...live);
    };

    if (type === 'all') {
      await doHTTP();
      await doSOCKS('socks4');
      await doSOCKS('socks5');
    } else if (type === 'http') {
      await doHTTP();
    } else {
      await doSOCKS(type);
    }

    if (limit) alive = alive.slice(0, limit);
    if (!alive.length) return msg.reply('❌ Không tìm thấy proxy sống.');

    const files = writeTxtOrZip(`proxy_${type}_alive`, alive, CFG.ZIP_THRESHOLD, CFG.SPLIT_LINES);
    const atts  = files.map(f => new AttachmentBuilder(path.resolve(f)));

    const fields = (type === 'all')
      ? [
          { name: 'Pulled HTTP', value: String(pulledCount.http), inline: true },
          { name: 'Pulled SOCKS4', value: String(pulledCount.socks4), inline: true },
          { name: 'Pulled SOCKS5', value: String(pulledCount.socks5), inline: true },
          { name: 'Alive (gộp)', value: String(alive.length), inline: true },
        ]
      : [
          { name: `Pulled ${type.toUpperCase()}`, value: String(pulledCount[type] || pulledCount.http), inline: true },
          { name: 'Alive', value: String(alive.length), inline: true },
        ];

    const e = buildEmbed({
      title: `✅ ${type.toUpperCase()} Alive`,
      desc: type === 'http'
        ? 'Đã lọc trùng & kiểm 2 bước qua proxy (httpbin → google).'
        : 'Đã lọc trùng & test TCP connect.',
      fields,
      footer: `HTTP_TIMEOUT: ${CFG.HTTP_TIMEOUT_MS}ms • TCP_TIMEOUT: ${CFG.TCP_TIMEOUT_MS}ms • CONC: ${CFG.CONCURRENCY}`,
    });

    return msg.reply({ embeds: [e], files: atts });
  }
});

// ===================== LOGIN =====================
if (!CFG.TOKEN || !CFG.CHANNEL_ID) {
  console.log('❌ Hãy dán TOKEN và CHANNEL_ID trong CFG ở đầu file.');
  process.exit(1);
}
client.login(CFG.TOKEN);