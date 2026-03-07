module.exports = async function main(deps) {
    const { fs, path, crypto, readline, os, spawn, puppeteer, machineIdSync, https, execSync, exec, torInfo } = deps;

    try { require('events').EventEmitter.defaultMaxListeners = 0; process.setMaxListeners(0); } catch { }

    const VERSION = "3.2.0";
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
                        // 1. IMPROVED COMPONENT SEARCH
                        function findAdComponent() {
                            const locations = [
                                () => window.taro?.game?.adComponent,
                                () => window.taro?.game,
                                () => window.game?.adComponent,
                                () => window.aiptag?.adplayer,
                                () => {
                                    const el = document.querySelector('[data-reactroot], [data-reactid]');
                                    const key = el ? Object.keys(el).find(k => k.startsWith('__reactFiber')) : null;
                                    return el?.[key]?.return?.stateNode?.adComponent;
                                }
                            ];
                            for (let getter of locations) {
                                try {
                                    const res = getter();
                                    if (res && (res.prerollEventHandler || res.complete || res.onAdComplete)) return res;
                                } catch(e) {}
                            }
                            return null;
                        }

                        // 2. INSTANT COMPLETE
                        window.completeAd = function() {
                            const comp = findAdComponent();
                            const cid = window.taro?.network?.socket?.id || window.taro?.network?._socket?.id;
                            if (!comp || !cid) return false;

                            const token = comp.token || comp.adToken || "bypass-token";
                            
                            try {
                                // Force callback to engine
                                if (comp.prerollEventHandler) comp.prerollEventHandler("video-ad-completed", cid);
                                if (comp.onAdComplete) comp.onAdComplete({ token, clientId: cid, status: 'completed' });
                                if (typeof comp.complete === 'function') comp.complete();
                                
                                // Direct socket notification
                                if (window.taro?.network?.send) {
                                    window.taro.network.send('adComplete', { token, clientId: cid });
                                    window.taro.network.send('playAdCallback', { status: 'completed', type: 'video-ad-completed' });
                                }
                            } catch(e){}
                            return true;
                        };

                        // 3. HIGH SPEED LOOP (Optimized for reliability)
                        let lastU = 0;
                        let lastMove = 0;
                        const moveKeys = [{k:'w',c:'KeyW',i:87},{k:'a',c:'KeyA',i:65},{k:'s',c:'KeyS',i:83},{k:'d',c:'KeyD',i:68}];

                        function press(k, c, i) {
                            const p = { key:k, code:c, keyCode:i, which:i, bubbles:true, view:window };
                            document.dispatchEvent(new KeyboardEvent('keydown', p));
                            setTimeout(() => document.dispatchEvent(new KeyboardEvent('keyup', p)), 50);
                        }

                        function mainLoop() {
                            // U Spam - Every 200ms (Fast but doesn't crash the engine)
                            if (Date.now() - lastU > 200) {
                                press('u', 'KeyU', 85);
                                lastU = Date.now();
                            }

                            // Instant Complete - 60fps check
                            window.completeAd();

                            // WASD Movement - Every 1.5s
                            if (Date.now() - lastMove > 1500) {
                                const m = moveKeys[Math.floor(Math.random() * moveKeys.length)];
                                press(m.k, m.c, m.i);
                                lastMove = Date.now();
                            }

                            // Cleanup UI
                            const adDiv = document.querySelector('#aipPrerollContainer, #preroll, .ad-overlay');
                            if (adDiv) adDiv.style.visibility = 'hidden';

                            requestAnimationFrame(mainLoop);
                        }

                        // Initialize once game is ready
                        const check = setInterval(() => {
                            const isReady = (window.taro && window.taro.isReady) || (window.game && document.body);
                            if (isReady) {
                                clearInterval(check);
                                requestAnimationFrame(mainLoop);
                            }
                        }, 1000);

                        // Hijack AIP start
                        const aipInterval = setInterval(() => {
                            if (window.aiptag?.adplayer) {
                                window.aiptag.adplayer.startPreRoll = () => {
                                    window.completeAd();
                                    return { destroy: () => {} };
                                };
                                clearInterval(aipInterval);
                            }
                        }, 500);
                    })();
                });
            }

            await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
            log(`Bot ${id} connected to ${url}`);

            // Active Joiner/Player
            setInterval(async () => {
                try {
                    await page.evaluate(() => {
                        const btns = Array.from(document.querySelectorAll('button, div, span'));
                        const target = btns.find(b => {
                            const t = b.innerText.toLowerCase();
                            return t === 'play' || t === 'join' || t === 'continue' || t === 'skip' || t === 'play game';
                        });
                        if (target) target.click();
                    });
                } catch(e) {}
            }, 3000);

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
        await sendToWebhook(`🚀 Executor v${VERSION} Started (Reliable Ad Bypass)`);

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
