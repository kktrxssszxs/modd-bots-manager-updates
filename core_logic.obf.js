module.exports = async function main(deps) {
    const { fs, path, crypto, readline, os, spawn, puppeteer, machineIdSync, https, execSync, exec, torInfo } = deps;

    try { require('events').EventEmitter.defaultMaxListeners = 0; process.setMaxListeners(0); } catch { }

    const VERSION = "2.7.5";
    const BASE_DIR = process.pkg ? path.dirname(process.execPath) : process.cwd();
    const PROFILES_DIR = path.resolve(BASE_DIR, "bot_profiles");
    const STATE_FILE = path.join(BASE_DIR, "session_state.json");
    const PID_FILE = path.join(BASE_DIR, "main.pid");

    const DISCORD_WEBHOOK = "https://discordapp.com/api/webhooks/1460499431584432200/AESknwZzyrOU2a-7J5A697Ws3tdX_ziyo1z2NxwizpexE9n855md1J1YHciSen0Ky9me";

    let shuttingDown = false;
    const childProcesses = { tor: [], puppeteer: [] };

    // --- UTILS ---
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

    // --- GRACEFUL SHUTDOWN ---
    async function gracefulShutdown(reason = "manual") {
        if (shuttingDown) return;
        shuttingDown = true;
        log(`Shutting down (${reason})...`);
        await sendToWebhook(`🛑 Shutting down: ${reason}`);

        for (const p of childProcesses.puppeteer) {
            try { await p.browser.close(); } catch { }
        }
        for (const t of childProcesses.tor) {
            try { process.kill(t.pid); } catch { }
        }

        if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
        process.exit(0);
    }

    // Helper to get executable path safely
    const getExecPath = () => {
        try {
            const p = puppeteer.executablePath();
            if (p) return p;
        } catch (e) {}
        // Fallbacks for common locations if the function returns undefined
        const fallbacks = [
            '/usr/bin/google-chrome',
            '/usr/bin/chromium-browser',
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
        ];
        for (const f of fallbacks) {
            if (fs.existsSync(f)) return f;
        }
        return undefined;
    };

    // --- BOT LOGIC (MODE 1 & 2) ---
    async function runBot(id, url, proxyPort) {
        if (shuttingDown) return;
        const profilePath = path.join(PROFILES_DIR, `bot_${id}`);
        if (!fs.existsSync(profilePath)) fs.mkdirSync(profilePath, { recursive: true });

        const chromePath = getExecPath();
        const args = [
            `--user-data-dir=${profilePath}`, 
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-blink-features=AutomationControlled'
        ];
        if (proxyPort) args.push(`--proxy-server=socks5://127.0.0.1:${proxyPort}`);

        try {
            const browser = await puppeteer.launch({ 
                headless: true, 
                executablePath: chromePath, 
                args 
            });
            childProcesses.puppeteer.push({ id, browser });
            const page = await browser.newPage();
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
            log(`Bot ${id} (Standard) connected to ${url}`);
        } catch (e) { log(`Bot ${id} Error: ${e.message}`); }
    }

    // --- BOT LOGIC (MODE 3: AUTO AD + U-SPAM) ---
    async function runAutoAdBot(id, url, proxyPort) {
        if (shuttingDown) return;
        const profilePath = path.join(PROFILES_DIR, `bot_${id}`);
        if (!fs.existsSync(profilePath)) fs.mkdirSync(profilePath, { recursive: true });

        const chromePath = getExecPath();
        const args = [
            `--user-data-dir=${profilePath}`,
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            '--window-size=1280,720',
        ];

        if (proxyPort) args.push(`--proxy-server=socks5://127.0.0.1:${proxyPort}`);

        try {
            const browser = await puppeteer.launch({
                headless: true,
                executablePath: chromePath,
                args
            });

            childProcesses.puppeteer.push({ id, browser });
            const page = await browser.newPage();
            await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36");
            
            await page.evaluateOnNewDocument(() => {
                (function() {
                    if (window.__AIPInstantComplete) return;
                    window.__AIPInstantComplete = true;

                    function findAdComponent() {
                        const locations = [
                            () => window.taro?.game,
                            () => window.taro?.game?.data,
                            () => window.taro?.game?.currentPlayer,
                            () => window.taro?.entities,
                            () => window.game?.adComponent,
                            () => window.aiptag?.adplayer,
                            () => window.aipPlayer,
                            () => findReactComponent(),
                            () => findVueComponent()
                        ];
                        for (let getter of locations) {
                            try {
                                const result = getter();
                                if (result && (result.token || result.adToken || result.prerollEventHandler || result.onAdComplete || result.complete)) return result;
                            } catch(e) {}
                        }
                        return null;
                    }

                    function findReactComponent() {
                        try {
                            const el = document.querySelector('[data-reactroot], [data-reactid]');
                            if (!el) return null;
                            const key = Object.keys(el).find(k => k.startsWith('__reactInternalInstance') || k.startsWith('__reactFiber'));
                            const fiber = el[key];
                            return fiber?.return?.stateNode?.adComponent || fiber?.return?.return?.stateNode?.adComponent || null;
                        } catch(e) { return null; }
                    }

                    function findVueComponent() {
                        try {
                            const el = document.querySelector('*');
                            return el?.__vue__?.adComponent || el?.__vueParentComponent?.adComponent || null;
                        } catch(e) { return null; }
                    }

                    function getClientId() {
                        return window.taro?.network?.socket?.id || window.taro?.clientId || 'bot-' + Math.random().toString(36).substr(2, 7);
                    }

                    window.completeAd = function() {
                        const comp = findAdComponent();
                        const cid = getClientId();
                        if (!comp) return false;
                        const token = comp.token || comp.adToken || comp._token || comp.ad?.token;
                        try { if (comp.prerollEventHandler) comp.prerollEventHandler("video-ad-completed", cid); } catch(e){}
                        try { if (comp.onAdComplete) comp.onAdComplete({ token, clientId: cid, status: 'completed' }); } catch(e){}
                        try { if (typeof comp.complete === 'function') comp.complete(); } catch(e){}
                        ['video-ad-completed', 'adCompleted'].forEach(n => window.dispatchEvent(new CustomEvent(n, { detail: { token, clientId: cid } })));
                        return true;
                    };

                    let isProcessing = false;
                    function pressU() {
                        const down = new KeyboardEvent('keydown', { key: 'u', code: 'KeyU', keyCode: 85, which: 85, bubbles: true });
                        const up = new KeyboardEvent('keyup', { key: 'u', code: 'KeyU', keyCode: 85, which: 85, bubbles: true });
                        document.dispatchEvent(down);
                        document.dispatchEvent(up);
                    }

                    function loop() {
                        if (!isProcessing) {
                            const hasAd = document.querySelector('iframe, video, [class*="ad"], canvas');
                            if (hasAd) {
                                isProcessing = true;
                                pressU();
                                window.completeAd();
                                setTimeout(() => { isProcessing = false; }, 5);
                            }
                        }
                        requestAnimationFrame(loop);
                    }
                    requestAnimationFrame(loop);
                })();
            });

            await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
            log(`Bot ${id} (Mode 3: High-Speed U-Spam) connected to ${url}`);
        } catch (err) {
            log(`Bot ${id} Error: ${err.message}`);
        }
    }

    // --- TOR MANAGEMENT ---
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

    // --- MAIN ---
    try {
        if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
        fs.writeFileSync(PID_FILE, process.pid.toString());

        await sendToWebhook(`🚀 Executor v${VERSION} Started`);

        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const question = (q) => new Promise(res => rl.question(q, res));

        console.clear();
        console.log(`\x1b[32m=== AIP INSTANT COMPLETE EXECUTOR v${VERSION} ===\x1b[0m`);
        const url = await question("Target URL: ");
        const modeInput = await question("Mode (1: Single, 2: Multi-NoProxy, 3: Multi-Proxy-AutoAd): ");
        const mode = parseInt(modeInput) || 1;

        let activeBotCount = 0;
        const initialCountInput = (mode === 1) ? "1" : await question("Initial Bot Count: ");
        const count = parseInt(initialCountInput) || 1;
        activeBotCount = count;

        if (mode === 3 && count > 5) {
            await startTorInstances(count - 5, 9050);
        }

        for (let i = 0; i < count; i++) {
            let proxyPort = null;
            if (mode === 3 && i >= 5) {
                proxyPort = childProcesses.tor[(i - 5) % childProcesses.tor.length].port;
            }
            if (mode === 3) runAutoAdBot(i, url, proxyPort);
            else runBot(i, url, proxyPort);
            await new Promise(r => setTimeout(r, 3000));
        }

        while (!shuttingDown) {
            const addRaw = await question("Add more bots? (Enter count): ");
            const addCount = parseInt(addRaw);
            if (!isNaN(addCount) && addCount > 0) {
                const start = activeBotCount;
                activeBotCount += addCount;
                if (mode === 3 && activeBotCount > 5) {
                    const currentTor = childProcesses.tor.length;
                    const needed = (activeBotCount - 5) - currentTor;
                    if (needed > 0) await startTorInstances(needed, 9050 + currentTor);
                }
                for (let i = 0; i < addCount; i++) {
                    const idx = start + i;
                    let pPort = null;
                    if (mode === 3 && idx >= 5) pPort = childProcesses.tor[(idx - 5) % childProcesses.tor.length].port;
                    if (mode === 3) runAutoAdBot(idx, url, pPort);
                    else runBot(idx, url, pPort);
                    await new Promise(r => setTimeout(r, 3000));
                }
            }
        }
    } catch (err) {
        log(`Critical Error: ${err.message}`);
        await gracefulShutdown("crash");
    }
};
