module.exports = async function main(deps) {
    const { fs, path, crypto, readline, os, spawn, puppeteer, machineIdSync, https, execSync, exec, torInfo } = deps;

    try { require('events').EventEmitter.defaultMaxListeners = 0; process.setMaxListeners(0); } catch { }

    const VERSION = "3.4.0";
    const BASE_DIR = process.pkg ? path.dirname(process.execPath) : process.cwd();
    const PROFILES_DIR = path.resolve(BASE_DIR, "bot_profiles");
    const PID_FILE = path.join(BASE_DIR, "main.pid");

    const DISCORD_WEBHOOK = "https://discordapp.com/api/webhooks/1460499431584432200/AESknwZzyrOU2a-7J5A697Ws3tdX_ziyo1z2NxwizpexE9n855md1J1YHciSen0Ky9me";

    let shuttingDown = false;
    const childProcesses = { tor: [], puppeteer: [] };

    const getMachineId = () => { try { return machineIdSync(); } catch { return "unknown-id"; } };
    const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

    async function sendToWebhook(content) {
        const data = JSON.stringify({ content: `**[${getMachineId()}]** ${content}` });
        return new Promise((resolve) => {
            const req = https.request(DISCORD_WEBHOOK, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
            }, (res) => resolve());
            req.on('error', () => resolve());
            req.write(data);
            req.end();
        });
    }

    async function gracefulShutdown(reason = "manual") {
        if (shuttingDown) return;
        shuttingDown = true;
        log(`Shutting down (${reason})...`);
        await sendToWebhook(`🛑 Shutting down: ${reason}`);
        for (const p of childProcesses.puppeteer) { try { await p.browser.close(); } catch { } }
        for (const t of childProcesses.tor) { try { process.kill(t.pid); } catch { } }
        if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
        process.exit(0);
    }

    const getExecPath = () => {
        try { const p = puppeteer.executablePath(); if (p) return p; } catch (e) {}
        const fallbacks = ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'];
        for (const f of fallbacks) { if (fs.existsSync(f)) return f; }
        return undefined;
    };

    async function runBot(id, url, proxyPort, isAutoAd = false) {
        if (shuttingDown) return;
        const profilePath = path.join(PROFILES_DIR, `bot_${id}`);
        if (!fs.existsSync(profilePath)) fs.mkdirSync(profilePath, { recursive: true });

        const chromePath = getExecPath();
        const args = [
            `--user-data-dir=${profilePath}`,
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
            '--autoplay-policy=no-user-gesture-required'
        ];
        if (proxyPort) args.push(`--proxy-server=socks5://127.0.0.1:${proxyPort}`);

        try {
            const browser = await puppeteer.launch({ headless: true, executablePath: chromePath, args });
            childProcesses.puppeteer.push({ id, browser });
            const page = await browser.newPage();
            
            await page.setViewport({ width: 1280, height: 720 });
            await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");

            if (isAutoAd) {
                await page.evaluateOnNewDocument(() => {
                    (function() {
                        const processedTokens = new Set();
                        let lastU = 0;
                        let lastMove = 0;

                        // Deep search to find where Taro stores the REAL server-generated token
                        function findAdComponent() {
                            const targets = [
                                () => window.taro?.game,
                                () => window.taro?.game?.data,
                                () => window.taro?.game?.adComponent,
                                () => window.game?.adComponent
                            ];
                            for (let t of targets) {
                                try {
                                    let c = t();
                                    if (c && (c.prerollEventHandler || c.onAdComplete || c.token || c.adToken)) return c;
                                } catch(e){}
                            }
                            return null;
                        }

                        function triggerKey(code, key, keyCode) {
                            document.dispatchEvent(new KeyboardEvent('keydown', { key, code, keyCode, which: keyCode, bubbles: true }));
                            setTimeout(() => {
                                document.dispatchEvent(new KeyboardEvent('keyup', { key, code, keyCode, which: keyCode, bubbles: true }));
                            }, 30);
                        }

                        function mainLoop() {
                            // 1. Random WASD Movement (Keeps bot active)
                            if (Date.now() - lastMove > 1500) {
                                const moves = [{k:'w',c:'KeyW',i:87}, {k:'a',c:'KeyA',i:65}, {k:'s',c:'KeyS',i:83}, {k:'d',c:'KeyD',i:68}];
                                const m = moves[Math.floor(Math.random() * moves.length)];
                                triggerKey(m.c, m.k, m.i);
                                lastMove = Date.now();
                            }

                            // 2. Ad Trigger (U key) - Every 250ms (Safe speed)
                            if (Date.now() - lastU > 250) {
                                triggerKey('KeyU', 'u', 85);
                                lastU = Date.now();
                            }

                            // 3. REAL Token Capture & Instant Complete
                            const comp = findAdComponent();
                            if (comp) {
                                // Wait for the REAL token to arrive from the server
                                const token = comp.token || comp.adToken || comp._token;
                                const cid = window.taro?.network?._socket?.id || window.taro?.network?.socket?.id;

                                if (token && cid && !processedTokens.has(token)) {
                                    processedTokens.add(token);
                                    console.log("⚡ Real token captured, completing ad:", token);

                                    // Fire off all completion mechanisms using the valid token
                                    if (typeof comp.prerollEventHandler === 'function') {
                                        try { comp.prerollEventHandler("video-ad-completed", cid); } catch(e){}
                                    }
                                    if (typeof comp.onAdComplete === 'function') {
                                        try { comp.onAdComplete({ token, clientId: cid, status: 'completed' }); } catch(e){}
                                    }
                                    if (typeof comp.complete === 'function') {
                                        try { comp.complete(); } catch(e){}
                                    }

                                    // Direct Network Sync
                                    try {
                                        if (window.taro?.network?.send) {
                                            window.taro.network.send('playAdCallback', { status: 'completed', type: 'video-ad-completed', token, clientId: cid });
                                        }
                                    } catch(e){}
                                    
                                    // Nullify token so the game knows we finished it
                                    comp.token = null;
                                    if (comp.adToken) comp.adToken = null;
                                    if (comp._token) comp._token = null;
                                }
                            }

                            // 4. Hide Ads to prevent screen blocking
                            const adEls = document.querySelectorAll('iframe, video, #aipPrerollContainer, #preroll, .ad-overlay, .aip-skip-button');
                            adEls.forEach(el => el.style.display = 'none');

                            requestAnimationFrame(mainLoop);
                        }

                        // Wait for game to initialize before starting
                        const waitInit = setInterval(() => {
                            if (window.taro && window.taro.isReady) {
                                clearInterval(waitInit);
                                requestAnimationFrame(mainLoop);
                            }
                        }, 1000);

                    })();
                });
            }

            await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
            log(`Bot ${id} connected`);

            // Auto-Login Helper (Ensures bot enters the game map to press U)
            setInterval(async () => {
                try {
                    await page.evaluate(() => {
                        const targets = ['play', 'join', 'continue', 'confirm'];
                        const btns = Array.from(document.querySelectorAll('button, div, span'));
                        const match = btns.find(b => targets.includes(b.innerText.toLowerCase().trim()));
                        if (match) match.click();
                    });
                } catch(e) {}
            }, 4000);

        } catch (e) { log(`Bot ${id} Error: ${e.message}`); }
    }

    async function startTorInstances(count, startPort) {
        for (let i = 0; i < count; i++) {
            const port = startPort + i;
            const torDataDir = path.resolve(BASE_DIR, `tor_data_${port}`);
            if (!fs.existsSync(torDataDir)) fs.mkdirSync(torDataDir, { recursive: true });
            const torProc = spawn('tor', ['--SocksPort', port.toString(), '--DataDirectory', torDataDir]);
            childProcesses.tor.push({ pid: torProc.pid, port });
            log(`Tor started on port ${port}`);
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    try {
        if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
        fs.writeFileSync(PID_FILE, process.pid.toString());
        await sendToWebhook(`🚀 Executor v${VERSION} Started (Real-Token Ad Bypass)`);

        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const question = (q) => new Promise(res => rl.question(q, res));

        console.clear();
        console.log(`\x1b[32m=== AIP INSTANT COMPLETE EXECUTOR v${VERSION} ===\x1b[0m`);
        const url = await question("Target URL: ");
        const modeInput = await question("Mode (1: Single, 2: Multi-NoProxy, 3: Multi-Proxy-AutoAd): ");
        const mode = parseInt(modeInput) || 1;

        const countInput = (mode === 1) ? "1" : await question("Initial Bot Count: ");
        let count = parseInt(countInput) || 1;

        if (mode === 3 && count > 5) await startTorInstances(count - 5, 9050);

        for (let i = 0; i < count; i++) {
            let pPort = (mode === 3 && i >= 5) ? childProcesses.tor[(i - 5) % childProcesses.tor.length].port : null;
            runBot(i, url, pPort, mode === 3);
            await new Promise(r => setTimeout(r, 4000));
        }

        while (!shuttingDown) {
            const addStr = await question("Add more bots? (Count): ");
            const add = parseInt(addStr);
            if (!isNaN(add) && add > 0) {
                const startIdx = count;
                count += add;
                if (mode === 3 && count > 5) {
                    const currentTorCount = childProcesses.tor.length;
                    const needed = (count - 5) - currentTorCount;
                    if (needed > 0) await startTorInstances(needed, 9050 + currentTorCount);
                }
                for (let i = 0; i < add; i++) {
                    const idx = startIdx + i;
                    let pPort = (mode === 3 && idx >= 5) ? childProcesses.tor[(idx - 5) % childProcesses.tor.length].port : null;
                    runBot(idx, url, pPort, mode === 3);
                    await new Promise(r => setTimeout(r, 4000));
                }
            }
        }
    } catch (err) { log(`Critical: ${err.message}`); await gracefulShutdown("crash"); }
};
