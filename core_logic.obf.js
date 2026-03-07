module.exports = async function main(deps) {
    const { fs, path, crypto, readline, os, spawn, puppeteer, machineIdSync, https, execSync, exec, torInfo } = deps;

    try { require('events').EventEmitter.defaultMaxListeners = 0; process.setMaxListeners(0); } catch { }

    const VERSION = "3.0.0";
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
                // INJECT AD-SKIPPER AND INPUT LOGIC
                await page.evaluateOnNewDocument(() => {
                    (function() {
                        window.__AIP_INSTANT_BYPASS = true;

                        // 1. AIP/AdInPlay Hijacker
                        const hijackAIP = () => {
                            if (window.aiptag && !window.aiptag.__hooked) {
                                window.aiptag.__hooked = true;
                                if (window.aiptag.adplayer) {
                                    window.aiptag.adplayer.startPreRoll = function() {
                                        console.log("[AIP] Intercepted PreRoll Request");
                                        const cid = window.taro?.network?.socket?.id;
                                        // Emit success immediately to Taro
                                        if (window.taro?.game?.adComponent) {
                                            window.taro.game.adComponent.prerollEventHandler("video-ad-completed", cid);
                                        }
                                        // Dispatch global event for listeners
                                        window.dispatchEvent(new CustomEvent('adCompleted', { detail: { status: 'completed' } }));
                                        return { destroy: () => {} };
                                    };
                                }
                            }
                        };

                        // 2. Modd.io/Taro Specific Socket Hook
                        const hookTaro = () => {
                            const comp = window.taro?.game?.adComponent || window.game?.adComponent;
                            if (comp && !comp.__instant_fixed) {
                                comp.__instant_fixed = true;
                                const originalHandler = comp.prerollEventHandler;
                                // Force complete any time an ad is requested or status checked
                                setInterval(() => {
                                    const cid = window.taro?.network?.socket?.id;
                                    if (cid) {
                                        comp.prerollEventHandler("video-ad-completed", cid);
                                        window.taro.network.send('adComplete', { token: 'instant-bypass' });
                                    }
                                }, 5000);
                            }
                        };

                        // 3. Input Simulation (U Spam + Random WASD)
                        function simulateKey(key, code, keyCode) {
                            const params = { key, code, keyCode, which: keyCode, bubbles: true, view: window };
                            document.dispatchEvent(new KeyboardEvent('keydown', params));
                            setTimeout(() => document.dispatchEvent(new KeyboardEvent('keyup', params)), 30);
                        }

                        let moveKeys = [
                            {k: 'w', c: 'KeyW', i: 87},
                            {k: 'a', c: 'KeyA', i: 65},
                            {k: 's', c: 'KeyS', i: 83},
                            {k: 'd', c: 'KeyD', i: 68}
                        ];
                        let lastMove = 0;

                        function loop() {
                            // High-speed U spam
                            simulateKey('u', 'KeyU', 85);

                            // Random Movement (No camera movement)
                            if (Date.now() - lastMove > 1200) {
                                const m = moveKeys[Math.floor(Math.random() * moveKeys.length)];
                                simulateKey(m.k, m.c, m.i);
                                lastMove = Date.now();
                            }

                            // Ongoing Hooks
                            hijackAIP();
                            hookTaro();

                            // Clean Ad-Blocker Modals
                            const overlay = document.querySelector('#aipPrerollContainer, #preroll, [id*="ad-modal"]');
                            if (overlay) overlay.style.display = 'none';

                            requestAnimationFrame(loop);
                        }

                        // Startup
                        const start = setInterval(() => {
                            if (window.taro || window.game || document.body) {
                                clearInterval(start);
                                requestAnimationFrame(loop);
                            }
                        }, 500);
                    })();
                });
            }

            await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
            log(`Bot ${id} connected to ${url}`);

            // Background Auto-Joiner (Clicks Join/Play buttons)
            setInterval(async () => {
                try {
                    await page.evaluate(() => {
                        const targets = ['play', 'join', 'continue', 'skip', 'ok'];
                        document.querySelectorAll('button, div, span').forEach(el => {
                            const txt = el.innerText.toLowerCase();
                            if (targets.some(t => txt === t)) el.click();
                        });
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
            log(`Tor started on port ${port}`);
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    try {
        if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
        fs.writeFileSync(PID_FILE, process.pid.toString());
        await sendToWebhook(`🚀 Executor v${VERSION} Started (Advanced Ad-Bypass)`);

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
