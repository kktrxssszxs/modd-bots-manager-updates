module.exports = async function main(deps) {
    const { fs, path, crypto, readline, os, spawn, puppeteer, machineIdSync, https, execSync, exec, torInfo } = deps;

    try { require('events').EventEmitter.defaultMaxListeners = 0; process.setMaxListeners(0); } catch { }

    const VERSION = "3.5.1";
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
            '--disable-infobars',
            '--window-size=1280,720'
        ];
        if (proxyPort) args.push(`--proxy-server=socks5://127.0.0.1:${proxyPort}`);

        try {
            const browser = await puppeteer.launch({ headless: true, executablePath: chromePath, args });
            childProcesses.puppeteer.push({ id, browser });
            const page = await browser.newPage();
            
            await page.setViewport({ width: 1280, height: 720 });
            await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");

            // Inject logic BEFORE navigation starts
            if (isAutoAd) {
                await page.evaluateOnNewDocument(() => {
                    (function() {
                        const processedTokens = new Set();
                        let lastMove = 0;
                        let lastU = 0;

                        function findAdComponent() {
                            const locations = [
                                () => window.taro?.game,
                                () => window.taro?.game?.data,
                                () => window.taro?.game?.currentPlayer,
                                () => window.game?.adComponent,
                                () => window.game?.adManager,
                                () => window.aiptag?.adplayer,
                                () => window.aipPlayer,
                                () => window.aipAdComponent
                            ];
                            for (let getter of locations) {
                                try {
                                    const res = getter();
                                    if (res && (res.token || res.adToken || res._token || res.prerollEventHandler)) return res;
                                } catch(e) {}
                            }
                            return null;
                        }

                        function getClientId() {
                            try { return window.taro?.network?._socket?.id || window.taro?.network?.socket?.id || 'client-' + Math.random().toString(36).substr(2, 5); } catch(e) { return 'unknown'; }
                        }

                        function triggerKey(key, code, keyCode) {
                            const opts = { key, code, keyCode, which: keyCode, bubbles: true };
                            document.dispatchEvent(new KeyboardEvent('keydown', opts));
                            window.dispatchEvent(new KeyboardEvent('keydown', opts));
                            setTimeout(() => {
                                document.dispatchEvent(new KeyboardEvent('keyup', opts));
                                window.dispatchEvent(new KeyboardEvent('keyup', opts));
                            }, 10);
                        }

                        function completeAd() {
                            const comp = findAdComponent();
                            if (!comp) return;

                            const token = comp.token || comp.adToken || comp._token || comp.currentToken;
                            if (!token || processedTokens.has(token)) return; 

                            processedTokens.add(token);
                            const cid = getClientId();
                            
                            // Aggressive Completion Methods
                            try {
                                if (comp.prerollEventHandler) comp.prerollEventHandler("video-ad-completed", cid);
                                if (comp.onAdComplete) comp.onAdComplete({ token, clientId: cid, status: 'completed' });
                                if (typeof comp.complete === 'function') comp.complete();
                                
                                const net = window.taro?.network?.send || window.game?.network?.send;
                                if (net) {
                                    net('playAdCallback', { status: 'completed', type: 'video-ad-completed', token, clientId: cid });
                                    net('adCompleted', { token, clientId: cid, reward: true });
                                }
                                
                                ['video-ad-completed', 'adCompleted', 'aipAdComplete'].forEach(ev => {
                                    window.dispatchEvent(new CustomEvent(ev, { detail: { token, clientId: cid } }));
                                });
                            } catch(e) {}

                            comp.token = null;
                            console.log("⚡ BYPASSED AD:", token.toString().substring(0,10));
                        }

                        function aggressiveLoop() {
                            const now = Date.now();
                            // Move every 1.5s
                            if (now - lastMove > 1500) {
                                triggerKey('w', 'KeyW', 87);
                                lastMove = now;
                            }
                            // SPAM U every 30ms (Faster)
                            if (now - lastU > 30) {
                                triggerKey('u', 'KeyU', 85);
                                lastU = now;
                            }
                            // Check for Ads
                            completeAd();
                            requestAnimationFrame(aggressiveLoop);
                        }
                        aggressiveLoop();
                    })();
                });
            }

            // Navigation with shorter timeout and looser "Ready" state
            try {
                await page.goto(url, { 
                    waitUntil: 'domcontentloaded', // Don't wait for heavy images/trackers
                    timeout: 45000 
                });
            } catch (navErr) {
                log(`Bot ${id} Notice: Initial navigation timed out, but proceeding with loop.`);
            }

            log(`Bot ${id} initialized.`);

            // Persistent UI Clicker
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

        } catch (e) { log(`Bot ${id} Critical Error: ${e.message}`); }
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
        await sendToWebhook(`🚀 Executor v${VERSION} Ready (Bypass + Spam Mode)`);

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
