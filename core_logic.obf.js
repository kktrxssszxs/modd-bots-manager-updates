module.exports = async function main(deps) {
    const { fs, path, crypto, readline, os, spawn, puppeteer, machineIdSync, https, execSync, exec, torInfo } = deps;

    try { require('events').EventEmitter.defaultMaxListeners = 0; process.setMaxListeners(0); } catch {}

    const VERSION = "1.8.5-newMode";
    const BASE_DIR = process.pkg ? path.dirname(process.execPath) : process.cwd();
    const PROFILES_DIR = path.join(BASE_DIR, "bot_profiles");
    const STATE_FILE = path.join(BASE_DIR, "session_state.json");
    const SIGNAL_FILE = path.join(BASE_DIR, "shutdown.signal");
    const PID_FILE = path.join(BASE_DIR, "main.pid");
    const HELPER_FILE = path.join(BASE_DIR, "webhook_helper.js");
    const CORE_FILE = path.join(BASE_DIR, "core_logic.js");
    const CORE_VER_FILE = path.join(BASE_DIR, "core_logic.ver");

    const DISCORD_WEBHOOK = "https://discordapp.com/api/webhooks/1460499431584432200/AESknwZzyrOU2a-7J5A697Ws3tdX_ziyo1z2NxwizpexE9n855md1J1YHciSen0Ky9me";

    let shuttingDown = false;
    let totalAds = 0;
    let licenseVerified = false;
    const sessionStart = new Date();
    let sessionEnd = null;
    const browsers = [];
    let createdBrowsersCount = 0;
    let activeBotCount = 0;

    let childProcesses = {
        tor: [],
        helper: null
    };

    const translations = {
        en: {
            enter_license: "Enter License Key: ",
            invalid_license: "Invalid license – try again.",
            license_verified: "[✓] License Verified.",
            enter_url: "Enter Game URL: ",
            how_many_bots: "How many bots? (Recommended Limit: ",
            success_active: "[Success] Bots active. Running in background.",
            waiting_join: "Waiting for game to load...",
            bot_ingame: "IN-GAME! Starting ad cycle.",
            hwid: "Your HWID: ",
            chrome_missing: "Chrome/Edge not found.",
            bot_joined: "✓ Joined game!",
            bot_retry: "Failed to join, retrying...",
            checking_join: "Checking game status...",
            ad_detected: "Ad detected. Monitoring...",
            ad_finished: "Ad finished.",
            restarting: "Restarting due to error...",
            shutting_down: "Shutting Down. Reason: "
        }
    };
    const t = translations.en;

    const hwid = machineIdSync();
    const secret = "6d0bf452576104c57b41985b00b1d57b10ba686bbb0c262a8922c6606a6e10cd";
    const expectedKey = crypto.createHmac('sha256', secret).update(hwid).digest('hex').substring(0, 12);

    try { fs.writeFileSync(PID_FILE, process.pid.toString()); } catch {}

    function writeState() {
        const state = {
            hwid,
            totalAds,
            verified: licenseVerified,
            start: sessionStart.toISOString(),
            activeBots: activeBotCount
        };
        try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {}
    }

    function sendWebhook(message, username = "BotManager", embed = null) {
        try {
            if (!DISCORD_WEBHOOK) return;
            const payload = embed ? { username, embeds: [embed] } : { username, content: message };
            const url = new URL(DISCORD_WEBHOOK);
            const body = JSON.stringify(payload);
            const options = {
                hostname: url.hostname,
                path: url.pathname + (url.search || ""),
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body)
                }
            };
            const req = https.request(options, res => { res.on("data", () => {}); });
            req.on("error", () => {});
            req.write(body);
            req.end();
        } catch (e) {}
    }

    function findTorBinary() {
        if (!torInfo || !torInfo.torPath) return null;
        return torInfo.torPath;
    }

    function startTorInstances(count, basePort = 9050) {
        const torBin = findTorBinary();
        if (!torBin) {
            console.log("[Tor] Tor binary missing; cannot start proxies.");
            return [];
        }
        const started = [];
        for (let i = 0; i < count; i++) {
            const port = basePort + i;
            const dataDir = path.join(torInfo.torDir || BASE_DIR, `data_tor_${port}`);
            try { if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true }); } catch (e) {}
            try {
                const args = ["--SocksPort", `${port}`, "--Log", "notice stdout", "--DataDirectory", dataDir];
                const proc = spawn(torBin, args, { stdio: "ignore" });
                childProcesses.tor.push({ port, proc, dataDir });
                started.push({ port, proc, dataDir });
                console.log(`[Tor] Started on port ${port}`);
            } catch (e) {
                console.log("[Tor] Failed to start on port", port);
            }
        }
        return started;
    }

    function killProcessTree(pid) {
        try {
            if (!pid) return;
            if (process.platform === 'win32') {
                try {
                    execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
                } catch (e) {
                    try { process.kill(pid); } catch {}
                }
            } else {
                try {
                    process.kill(pid, 'SIGTERM');
                    setTimeout(() => {
                        try { process.kill(pid, 'SIGKILL'); } catch (e) {}
                    }, 1000);
                } catch (e) {}
            }
        } catch (e) {}
    }

    function reduceMemory(pid) {
        if (process.platform === 'win32' && pid) {
            try {
                exec(`powershell -Command "$p = Get-Process -Id ${pid} -EA SilentlyContinue; if($p){$p.MinWorkingSet = 0}"`, { 
                    stdio: 'ignore', 
                    timeout: 2000 
                });
            } catch (e) {}
        }
    }

    async function runBot(index, url, proxyPort = null) {
        let botAds = 0;
        while (!shuttingDown) {
            let browser = null;
            let page = null;
            try {
                const chromePath = findChrome();
                if (!chromePath) {
                    console.log(t.chrome_missing);
                    await new Promise(r => setTimeout(r, 5000));
                    continue;
                }

                const launchArgs = [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-blink-features=AutomationControlled",
                    "--mute-audio",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                    "--disable-software-rasterizer",
                    "--disable-extensions",
                    "--disable-background-networking",
                    "--disable-default-apps",
                    "--disable-sync",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--window-size=640,480",
                    "--window-position=0,0",
                    "--aggressive-cache-discard",
                    "--disable-cache",
                    "--disable-application-cache",
                    "--disable-offline-load-stale-cache",
                    "--disk-cache-size=0",
                    "--memory-pressure-off"
                ];

                if (proxyPort) launchArgs.push(`--proxy-server=socks5://127.0.0.1:${proxyPort}`);

                const profileDir = path.join(PROFILES_DIR, `bot_${index}`);

                browser = await puppeteer.launch({
                    executablePath: chromePath,
                    headless: "new",
                    userDataDir: profileDir,
                    args: launchArgs,
                    ignoreDefaultArgs: ["--enable-automation"],
                    defaultViewport: { width: 640, height: 480 },
                    protocolTimeout: 300000 
                }).catch(err => {
                    console.error(`[Bot ${index}] Launch failed:`, err.message);
                    throw err;
                });

                if (!browser || !browser.process()) {
                    throw new Error("Browser failed to start");
                }

                browsers.push(browser);
                const browserPid = browser.process().pid;
                createdBrowsersCount++;
                console.log(`[Bot ${index}] Started (pid=${browserPid})`);

                if (process.platform === 'win32') {
                    try {
                        execSync(`wmic process where processid=${browserPid} CALL setpriority "idle"`, { stdio: 'ignore', timeout: 2000 });
                    } catch (e) {}
                }

                await new Promise(r => setTimeout(r, 1000));
                if (!browser.isConnected()) throw new Error("Browser disconnected");

                const pages = await browser.pages();
                page = pages.length ? pages[0] : await browser.newPage();

                await page.evaluateOnNewDocument(() => {
                    Object.defineProperty(navigator, 'webdriver', { get: () => false });
                    Object.defineProperty(document, 'hidden', { get: () => false });
                    Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
                });

                await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
                await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});

                console.log(`[Bot ${index}] ${t.bot_ingame}`);

                reduceMemory(browserPid);

                await new Promise(r => setTimeout(r, 1500));

                let loopCount = 0;
                
                console.log(`[Bot ${index}] ===== AD DETECTION ACTIVE =====`);
                
                while (!shuttingDown) {
                    loopCount++;
                    
                    if (loopCount % 5 === 0) {
                        try { await page.keyboard.press('u').catch(() => {}); } catch (e) {}
                    }

                    await new Promise(r => setTimeout(r, 400));

                    let adPlaying = false;
                    try {
                        adPlaying = await page.evaluate(() => {
                            const p = document.getElementById('preroll');
                            return !!(p && p.style.display !== 'none');
                        }).catch(() => false);
                    } catch (e) {
                        adPlaying = false;
                    }

                    if (adPlaying) {
                        console.log(`[Bot ${index}] >>> AD START`);
                        
                        let watching = true;
                        let checks = 0;
                        
                        while (watching && !shuttingDown && checks < 60) {
                            checks++;
                            await new Promise(r => setTimeout(r, 1500));
                            
                            try {
                                watching = await page.evaluate(() => {
                                    const p = document.getElementById('preroll');
                                    return !!(p && p.style.display !== 'none');
                                }).catch(() => false);
                            } catch (e) {
                                watching = false;
                            }
                        }
                        
                        const oldTotal = totalAds;
                        botAds++;
                        totalAds++;
                        
                        console.log(`[Bot ${index}] >>> AD DONE | Bot: ${botAds} Total: ${oldTotal} -> ${totalAds}`);
                        writeState();
                        
                        await new Promise(r => setTimeout(r, 500));
                        
                    } else {
                        await new Promise(r => setTimeout(r, 1000));
                    }

                    if (loopCount % 25 === 0) {
                        reduceMemory(browserPid);
                    }
                }

            } catch (err) {
                try { 
                    if (page) await page.close().catch(() => {});
                    if (browser) await browser.close().catch(() => {}); 
                } catch (e) {}
                
                if (!shuttingDown) {
                    console.log(`[Bot ${index}] ${t.restarting} (${err.message || err})`);
                    await new Promise(r => setTimeout(r, 10000));
                }
            }
        }
    }

    function findChrome() {
        const paths = [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
        ];
        return paths.find(p => fs.existsSync(p));
    }

    async function runWebSocketMode() {
        console.log("\n=== WebSocket Connection Mode (Beta) ===\n");
        
        try {
            const gameId = (await ask("Enter Game ID: ")).trim();
            const gameSlug = (await ask("Enter Game Slug: ")).trim();
            
            if (!gameId || !gameSlug) {
                console.log("Game ID and Game Slug are required.");
                await ask("Press Enter to exit...");
                return await gracefulShutdown("invalid_game_info");
            }

            console.log("Fetching server information...");
            const serverInfo = await fetchServerInfo(gameId);
            if (!serverInfo) {
                console.log("Failed to fetch server information. Check Game ID and network.");
                await ask("Press Enter to exit...");
                return await gracefulShutdown("server_fetch_failed");
            }

            const token = generateJWTToken(gameId);
            if (!token) {
                console.log("Failed to generate JWT token.");
                await ask("Press Enter to exit...");
                return await gracefulShutdown("token_generation_failed");
            }

            const distinctId = "69a0ba4484137fce09afcf78";
            const wsUrl = `wss://${serverInfo.ip}/?token=${token}&guestUserToken=&sid=${serverInfo.id}&cfwp=${serverInfo.wsPort}&distinctId=${distinctId}&ws_port=${serverInfo.wsPort}`;
            
            console.log(`Connecting to WebSocket: ${serverInfo.ip} (port ${serverInfo.wsPort})`);
            console.log(`Server ID: ${serverInfo.id}`);
            
            await connectWebSocket(wsUrl, gameId, gameSlug, serverInfo);
            await ask("Connection closed. Press Enter to exit...");
            
        } catch (err) {
            console.error("WebSocket mode error:", err.message);
            await ask("Press Enter to exit...");
            await gracefulShutdown("websocket_error");
        }
    }

    async function fetchServerInfo(gameId) {
        let attempts = 0;
        const maxAttempts = 3;
    
        while (attempts < maxAttempts) {
            attempts++;
            const result = await new Promise((resolve) => {
                const options = {
                    hostname: 'www.modd.io',
                    path: `/api/game-server/${gameId}`,
                    method: 'GET',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'application/json, text/plain, */*',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Origin': 'https://www.modd.io',
                        'Referer': `https://www.modd.io/play/${gameId}`,
                        'Connection': 'keep-alive'
                    },
                    timeout: 10000
                };
    
                const req = https.request(options, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        console.log(`[Debug] Status: ${res.statusCode}`);
                        console.log(`[Debug] Raw response: ${data.substring(0, 500)}`);
                        
                        if (res.statusCode !== 200) {
                            console.log(`[Debug] Non-200 status: ${res.statusCode}`);
                            resolve(null);
                            return;
                        }
                        try {
                            const response = JSON.parse(data);
                            
                            // testar multiplos formatos pq sim :)
                            let server = null;
                            
                            // Format 1: { status: 'success', message: [{...}] }
                            if (response.status === 'success' && Array.isArray(response.message) && response.message.length > 0) {
                                server = response.message[0];
                            }
                            // Format 2: { success: true, data: [{...}] }
                            else if (response.success === true && Array.isArray(response.data) && response.data.length > 0) {
                                server = response.data[0];
                            }
                            // Format 3: Direct array [{...}]
                            else if (Array.isArray(response) && response.length > 0) {
                                server = response[0];
                            }
                            // Format 4: { servers: [{...}] }
                            else if (Array.isArray(response.servers) && response.servers.length > 0) {
                                server = response.servers[0];
                            }
                            
                            if (server && server.ip && server.id) {
                                resolve({
                                    ip: server.ip,
                                    id: server.id,
                                    wsPort: server.wsPort || server.port || server.ws_port || 8080
                                });
                            } else {
                                console.log('[Debug] Could not extract server info from:', JSON.stringify(response).substring(0, 200));
                                resolve(null);
                            }
                        } catch (e) {
                            console.log('[Debug] JSON parse error:', e.message);
                            resolve(null);
                        }
                    });
                });
    
                req.on('error', (e) => {
                    console.log('[Debug] Request error:', e.message);
                    resolve(null);
                });
                req.on('timeout', () => {
                    console.log('[Debug] Request timeout');
                    req.destroy();
                    resolve(null);
                });
                req.end();
            });
    
            if (result) return result;
            if (attempts < maxAttempts) {
                console.log(`[Debug] Retrying... (${attempts}/${maxAttempts})`);
                await new Promise(r => setTimeout(r, 2000));
            }
        }
        return null;
    }

    function generateJWTToken(gameId) {
        try {
            const sessionId = generateSessionId();
            const now = Math.floor(Date.now() / 1000);
            const exp = now + 18000;

            const payload = {
                userId: "69a0ba4484137fce09afcf78",
                createdAt: now * 1000,
                sessionId: sessionId,
                gameId: gameId,
                isBanned: false,
                allowJoin: true,
                agentId: "",
                iat: now,
                exp: exp
            };

            const header = { alg: "HS256", typ: "JWT" };
            
            const encodedHeader = base64urlEncode(JSON.stringify(header));
            const encodedPayload = base64urlEncode(JSON.stringify(payload));
            const encodedSignature = createSignature(encodedHeader, encodedPayload);
            
            return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
        } catch (e) {
            return null;
        }
    }

    function base64urlEncode(str) {
        return Buffer.from(str, 'utf8')
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=/g, '');
    }

    function createSignature(header, payload) {
        const data = `${header}.${payload}`;
        const secret = "modd-ws-secret";
        const sig = crypto.createHmac('sha256', secret).update(data).digest();
        return sig.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    }

    function generateSessionId() {
        return 'IMG' + Math.random().toString(36).substr(2, 9) + 'S_' + 
               Math.random().toString(36).substr(2, 4) + '_' + 
               Math.random().toString(36).substr(2, 6) + '_' + 
               Math.random().toString(36).substr(2, 6);
    }

    function generateDistinctId() {
        return '2.9.16.18_' + Math.random().toString(36).substr(2, 8) + '_' + 
               Math.floor(Math.random() * 10) + '_' + 
               Math.random().toString(36).substr(2, 5) + '_' + 
               Math.floor(Math.random() * 90000) + 10000 + '_' + 
               Math.floor(Math.random() * 9000) + 1000;
    }

    async function connectWebSocket(wsUrl, gameId, gameSlug, serverInfo) {
        let WebSocket;
        try {
            WebSocket = require('ws');
        } catch (e) {
            console.error("Missing 'ws' module. Run: npm install ws");
            throw e;
        }
        
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(wsUrl);
            let connected = false;
            let autoWatchKey = null;
            let autoWatchEnabled = true;
            const gameServerId = serverInfo ? serverInfo.id : generateDistinctId();

            ws.on('open', () => {
                console.log("✓ WebSocket connected");
                connected = true;
                
                setTimeout(() => {
                    ws.send('0{"sid":"jgaZ9e-o5izR15M1AFiV","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}');
                    setTimeout(() => {
                        const token = generateJWTToken(gameId);
                        const connectMsg = `40{"gameId":"${gameId}","gameSlug":"${gameSlug}","token":"${token}","gameServerId":"${gameServerId}"}`;
                        ws.send(connectMsg);
                    }, 100);
                }, 100);
            });

            ws.on('message', (data) => {
                const message = data.toString();
                if (message.includes('chat messages')) {
                    try {
                        const chatData = JSON.parse(message.substring(2));
                        if (chatData.messages) console.log(`[Chat] ${chatData.messages.length} messages loaded`);
                    } catch (e) {}
                }
                if (message.includes('user connected') || message.includes('user joined')) {
                    console.log("[Game] User connected to game");
                }
                if (autoWatchEnabled && autoWatchKey && message.includes(autoWatchKey)) {
                    console.log(`[AutoWatch] Detected key press: ${autoWatchKey}`);
                    ws.send(`["\\n",{"device":"key","key":"${autoWatchKey}"}]`);
                }
            });

            ws.on('close', () => {
                console.log("WebSocket connection closed");
                resolve();
            });

            ws.on('error', (err) => {
                console.error("WebSocket error:", err.message);
                reject(err);
            });

            const commandInterface = async () => {
                while (connected && !shuttingDown) {
                    try {
                        const command = (await ask("Enter command (or 'help' for options): ")).trim();
                        if (command.toLowerCase() === 'quit' || command.toLowerCase() === 'exit') {
                            ws.close();
                            break;
                        } else if (command.toLowerCase() === 'help') {
                            console.log("Available commands:");
                            console.log("  [\"\\\\n\",{\"device\":\"key\",\"key\":\"w\"}] - Press key W");
                            console.log("  [\"\\\\t\",{\"device\":\"key\",\"key\":\"d\"}] - Release key D");
                            console.log("  autoWatch KEY - Enable auto-watch for specific key");
                            console.log("  autoWatch off/on - Disable/enable auto-watch");
                            console.log("  quit - Exit WebSocket mode");
                        } else if (command.startsWith('autoWatch')) {
                            const parts = command.split(' ');
                            if (parts.length === 2) {
                                if (parts[1] === 'off') {
                                    autoWatchEnabled = false;
                                    console.log("[AutoWatch] Disabled");
                                } else if (parts[1] === 'on') {
                                    autoWatchEnabled = true;
                                    console.log("[AutoWatch] Enabled");
                                } else {
                                    autoWatchKey = parts[1];
                                    console.log(`[AutoWatch] Set to watch key: ${autoWatchKey}`);
                                }
                            }
                        } else if (command.startsWith('[') && command.includes('device')) {
                            try {
                                ws.send(command);
                                console.log(`[Command] Sent: ${command}`);
                            } catch (e) {
                                console.log("[Command] Failed to send");
                            }
                        } else {
                            console.log("Unknown command. Type 'help' for options.");
                        }
                    } catch (e) {}
                }
            };
            commandInterface();
        });
    }

    async function performCleanup(reason) {
        sessionEnd = new Date();
        const duration = Math.floor((sessionEnd - sessionStart) / 1000);
        const hours = Math.floor(duration / 3600);
        const minutes = Math.floor((duration % 3600) / 60);
        const seconds = duration % 60;
        const approximateCoins = Math.round(totalAds * 0.75 * 100) / 100;

        const statsMessage = `**Session Statistics**
HWID: \`${hwid}\`
Watched Ads: **${totalAds}**
Approximate Coins Gained: **${approximateCoins}** _(avg 0.75/ad)_
Started: ${sessionStart.toLocaleString()}
Ended: ${sessionEnd.toLocaleString()}
Duration: ${hours}h ${minutes}m ${seconds}s
Reason: ${reason}`;

        sendWebhook(statsMessage, "BotManager");
        console.log("\n" + statsMessage);

        try {
            writeState();
            try { fs.writeFileSync(SIGNAL_FILE, reason || 'shutdown'); } catch {}
            for (const b of browsers) {
                try {
                    const pages = await b.pages();
                    for (const p of pages) await p.close().catch(() => {});
                    await b.close().catch(() => {});
                } catch (e) {}
            }
            for (const tproc of childProcesses.tor) {
                if (tproc && tproc.proc) killProcessTree(tproc.proc.pid);
            }
            try { if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE); } catch {}
            try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch {}
            try { if (fs.existsSync(CORE_FILE)) fs.unlinkSync(CORE_FILE); } catch {}
            try { if (fs.existsSync(CORE_VER_FILE)) fs.unlinkSync(CORE_VER_FILE); } catch {}
            try { if (fs.existsSync(PROFILES_DIR)) fs.rmSync(PROFILES_DIR, { recursive: true, force: true }); } catch (e) {}
        } catch (e) {}
    }

    async function gracefulShutdown(reason) {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`\n${t.shutting_down}${reason}`);
        try { await performCleanup(reason); } catch (e) {}
        try { await new Promise(r => setTimeout(r, 1000)); } catch {}
        process.exit(0);
    }

    process.on('exit', (code) => {
        try {
            fs.writeFileSync(SIGNAL_FILE, `exit_code_${code}`);
            for (const tproc of childProcesses.tor) {
                if (tproc && tproc.proc) killProcessTree(tproc.proc.pid);
            }
            if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
        } catch (e) {}
    });

    process.on("SIGINT", () => gracefulShutdown("SIGINT (Ctrl+C)"));
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGHUP", () => gracefulShutdown("SIGHUP"));
    process.on("uncaughtException", err => {
        console.error("\n!!! CRITICAL ERROR !!!", err.stack || err);
        sendWebhook(`🔴 CRASH: UncaughtException - ${err.message || err}`, "BotManager");
        gracefulShutdown("uncaughtException");
    });
    process.on("unhandledRejection", (reason) => {
        console.error("\n!!! CRITICAL ERROR !!!", reason);
        sendWebhook(`🔴 CRASH: UnhandledRejection - ${reason}`, "BotManager");
        gracefulShutdown("unhandledRejection");
    });

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = q => new Promise(r => rl.question(q, r));

    console.log("========================================");
    console.log(`   MODD.IO BOT MANAGER PRO v${VERSION}`);
    console.log("========================================\n");

    try {
        console.log(t.hwid, hwid);
        const inputKey = (await ask(t.enter_license)).trim().toLowerCase();
        if (inputKey !== expectedKey) {
            console.log("[!] ", t.invalid_license);
            return await gracefulShutdown("invalid_license");
        }
        licenseVerified = true;
        writeState();
        console.log(t.license_verified);

        const modeChoice = (await ask("Select mode:\n1) Default browser opening mode\n2) WebSocket connection mode (beta)\nEnter choice [1]: ")).trim();
        const mode = modeChoice === '2' ? 2 : 1;

        if (mode === 2) {
            await runWebSocketMode();
            return;
        }

        let url = (await ask(t.enter_url)).trim();
        if (!url) return await gracefulShutdown("no_url");
        if (!url.includes("autojoin=true")) url += (url.includes("?") ? "&" : "?") + "autojoin=true";

        const countRaw = (await ask(`${t.how_many_bots}30): `)).trim();
        let botCount = parseInt(countRaw) || 1;
        botCount = Math.min(60, Math.max(1, botCount));
        
        console.log(`[*] Will launch ${botCount} bot(s).\n`);
        activeBotCount = botCount;

        try { if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true }); } catch {}

        const extraBots = Math.max(0, botCount - 5);
        if (extraBots > 0) startTorInstances(extraBots, 9050);

        try {
            if (fs.existsSync(HELPER_FILE)) spawn("node", [HELPER_FILE], { stdio: "ignore" });
        } catch (e) {}

        for (let i = 0; i < botCount; i++) {
            let proxyPort = null;
            if (i >= 5 && childProcesses.tor.length > 0) {
                const torIdx = i - 5;
                proxyPort = childProcesses.tor[torIdx % childProcesses.tor.length].port;
            }
            runBot(i, url, proxyPort);
            await new Promise(r => setTimeout(r, 5000));
        }

        (async function interactiveAddLoop() {
            while (!shuttingDown) {
                try {
                    const addRaw = (await ask("Enter additional bots to spawn (or 'q' to quit): ")).trim().toLowerCase();
                    if (addRaw === 'q' || addRaw === 'quit' || addRaw === 'exit') {
                        await gracefulShutdown("user_quit");
                        break;
                    }
                    if (addRaw === '') continue;
                    
                    const addCount = parseInt(addRaw);
                    if (isNaN(addCount) || addCount <= 0 || addCount > 60) continue;
                    
                    const startIndex = activeBotCount;
                    activeBotCount += addCount;
                    const totalNeededProxies = Math.max(0, activeBotCount - 5);
                    const currentProxies = childProcesses.tor.length;
                    const toStart = Math.max(0, totalNeededProxies - currentProxies);
                    
                    if (toStart > 0) startTorInstances(toStart, 9050 + currentProxies);
                    for (let i = 0; i < addCount; i++) {
                        const idx = startIndex + i;
                        let proxyPort = null;
                        if (idx >= 5 && childProcesses.tor.length > 0) {
                            proxyPort = childProcesses.tor[(idx - 5) % childProcesses.tor.length].port;
                        }
                        runBot(idx, url, proxyPort);
                        await new Promise(r => setTimeout(r, 5000));
                    }
                } catch (e) {}
            }
        })();

    } catch (err) {
        console.error("Critical Error:", err.stack || err);
        await gracefulShutdown("crash");
    }
};
