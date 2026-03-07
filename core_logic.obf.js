module.exports = async function main(deps) {
    const { fs, path, crypto, readline, os, spawn, puppeteer, machineIdSync, https, execSync, exec, torInfo } = deps;

    try { require('events').EventEmitter.defaultMaxListeners = 0; process.setMaxListeners(0); } catch { }

    const VERSION = "3.5.5";
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
            '--autoplay-policy=no-user-gesture-required',
            '--disable-infobars'
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
                    // INTEGRATED AIP INSTANT COMPLETE LOGIC
                    (function() {
                        let autoModeActive = true; // Set to true by default for bots
                        let isProcessing = false;
                        let lastMove = 0;

                        function deepSearch(obj, depth, maxDepth = 3, visited = new Set()) {
                            if (depth > maxDepth || !obj || visited.has(obj)) return null;
                            visited.add(obj);
                            try {
                                for (let key in obj) {
                                    try {
                                        const val = obj[key];
                                        if (!val) continue;
                                        if (typeof val === 'object') {
                                            if (val.token && (val.prerollEventHandler || val.onAdComplete || val.complete)) return val;
                                            const found = deepSearch(val, depth + 1, maxDepth, visited);
                                            if (found) return found;
                                        }
                                    } catch(e) {}
                                }
                            } catch(e) {}
                            return null;
                        }

                        function findAdComponent() {
                            const locations = [
                                () => window.taro?.game,
                                () => window.taro?.game?.data,
                                () => window.taro?.game?.currentPlayer,
                                () => window.game?.adComponent,
                                () => window.aiptag?.adplayer,
                                () => window.aipPlayer,
                                () => {
                                    const elements = document.querySelectorAll('*');
                                    for (let el of elements) {
                                        if (el.__vue__?.adComponent) return el.__vue__.adComponent;
                                    }
                                    return null;
                                }
                            ];
                            for (let getter of locations) {
                                try {
                                    const res = getter();
                                    if (res && (res.token || res.adToken || res.prerollEventHandler)) return res;
                                } catch(e) {}
                            }
                            return deepSearch(window, 0);
                        }

                        function getClientId() {
                            try { return window.taro?.network?._socket?.id || window.taro?.network?.socket?.id || 'bot-client'; } catch(e) { return 'bot-client'; }
                        }

                        function getNetworkSend() {
                            try { return window.taro?.network?.send || window.taro?.network?.socket?.emit || window.game?.network?.send; } catch(e) { return null; }
                        }

                        window.completeAd = function() {
                            const comp = findAdComponent();
                            const clientId = getClientId();
                            const networkSend = getNetworkSend();
                            if (!comp) return false;

                            const token = comp.token || comp.adToken || comp._token || comp.currentToken;
                            
                            try {
                                if (comp.prerollEventHandler) comp.prerollEventHandler("video-ad-completed", clientId);
                                if (comp.onAdComplete) comp.onAdComplete({ token, clientId, status: 'completed' });
                                if (typeof comp.complete === 'function') comp.complete();
                                
                                ['finish', 'close', 'skip'].forEach(m => { if (typeof comp[m] === 'function') comp[m](); });

                                if (networkSend) {
                                    networkSend('playAdCallback', { status: 'completed', type: 'video-ad-completed', token, clientId });
                                    networkSend('adCompleted', { token, clientId, reward: true });
                                }
                                
                                ['video-ad-completed', 'adCompleted', 'aipAdComplete'].forEach(eventName => {
                                    window.dispatchEvent(new CustomEvent(eventName, { detail: { token, clientId } }));
                                });
                            } catch(e) {}
                            return true;
                        };

                        function pressU() {
                            const opts = { key: 'u', code: 'KeyU', keyCode: 85, which: 85, bubbles: true };
                            document.dispatchEvent(new KeyboardEvent('keydown', opts));
                            document.dispatchEvent(new KeyboardEvent('keyup', opts));
                        }

                        function triggerMove() {
                            const opts = { key: 'w', code: 'KeyW', keyCode: 87, which: 87, bubbles: true };
                            document.dispatchEvent(new KeyboardEvent('keydown', opts));
                            setTimeout(() => document.dispatchEvent(new KeyboardEvent('keyup', opts)), 50);
                        }

                        function mainLoop() {
                            const now = Date.now();
                            
                            if (autoModeActive && !isProcessing) {
                                const hasAd = document.querySelector('iframe, video, [class*="ad"], canvas');
                                if (hasAd) {
                                    isProcessing = true;
                                    pressU();
                                    window.completeAd();
                                    setTimeout(() => { isProcessing = false; }, 5); // 5ms delay as requested
                                }
                            }

                            if (now - lastMove > 1500) {
                                triggerMove();
                                lastMove = now;
                            }

                            requestAnimationFrame(mainLoop);
                        }
                        requestAnimationFrame(mainLoop);

                        // Also allow K toggle manually if user ever views the bot
                        window.addEventListener('keydown', (e) => {
                            if (e.key.toLowerCase() === 'k' && !e.repeat) {
                                autoModeActive = !autoModeActive;
                                console.log("AUTO:", autoModeActive);
                            }
                        });
                    })();
                });
            }

            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
            } catch (e) {
                log(`Bot ${id} joined (navigation timeout ignored)`);
            }

            // Continuous UI interaction
            setInterval(async () => {
                try {
                    await page.evaluate(() => {
                        const targets = ['play', 'join', 'continue', 'confirm'];
                        const btns = Array.from(document.querySelectorAll('button, div, span'));
                        const match = btns.find(b => targets.includes(b.innerText.toLowerCase().trim()));
                        if (match) match.click();
                        document.querySelector('canvas')?.click();
                    });
                } catch(e) {}
            }, 5000);

        } catch (e) { log(`Bot ${id} Error: ${e.message}`); }
    }

    async function startTorInstances(count, startPort) {
        for (let i = 0; i < count; i++) {
            const port = startPort + i;
            const torDataDir = path.resolve(BASE_DIR, `tor_data_${port}`);
            if (!fs.existsSync(torDataDir)) fs.mkdirSync(torDataDir, { recursive: true });
            const torProc = spawn('tor', ['--SocksPort', port.toString(), '--DataDirectory', torDataDir]);
            childProcesses.tor.push({ pid: torProc.pid, port });
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    try {
        if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
        fs.writeFileSync(PID_FILE, process.pid.toString());
        await sendToWebhook(`🚀 Executor v${VERSION} Started (Deep Search + Instant Complete)`);

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
