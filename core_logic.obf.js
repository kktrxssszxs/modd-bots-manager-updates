module.exports = async function main(deps) {
    const { fs, path, crypto, readline, os, spawn, puppeteer, machineIdSync, https, execSync, exec, torInfo } = deps;

    try { require('events').EventEmitter.defaultMaxListeners = 0; process.setMaxListeners(0); } catch { }

    const VERSION = "2.8.0";
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
            '--disable-features=IsolateOrigins,site-per-process'
        ];
        if (proxyPort) args.push(`--proxy-server=socks5://127.0.0.1:${proxyPort}`);

        try {
            const browser = await puppeteer.launch({ headless: true, executablePath: chromePath, args });
            childProcesses.puppeteer.push({ id, browser });
            const page = await browser.newPage();
            
            // Set a realistic viewport and User Agent
            await page.setViewport({ width: 1280, height: 720 });
            await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36");

            if (isAutoAd) {
                await page.evaluateOnNewDocument(() => {
                    (function() {
                        window.__AIPInstantComplete = true;

                        // Ad Component Discovery Logic
                        function findAdComponent() {
                            const paths = [
                                () => window.taro?.game,
                                () => window.taro?.game?.data,
                                () => window.game?.adComponent,
                                () => window.aiptag?.adplayer,
                                () => window.aipPlayer,
                                () => {
                                    const el = document.querySelector('[data-reactroot], [data-reactid]');
                                    const key = el ? Object.keys(el).find(k => k.startsWith('__reactFiber')) : null;
                                    return el?.[key]?.return?.stateNode?.adComponent;
                                }
                            ];
                            for (let p of paths) {
                                try { const r = p(); if (r && (r.token || r.prerollEventHandler || r.complete)) return r; } catch(e) {}
                            }
                            return null;
                        }

                        // HIGH-SPEED INTERACTION & AD SKIPPER
                        let processing = false;
                        function autoAction() {
                            if (processing) return;
                            
                            // 1. Force Complete Ads
                            const comp = findAdComponent();
                            if (comp) {
                                processing = true;
                                const cid = window.taro?.network?.socket?.id || 'bot-' + Math.random().toString(36).substr(2, 5);
                                const token = comp.token || comp.adToken || comp._token;
                                
                                try { if (comp.prerollEventHandler) comp.prerollEventHandler("video-ad-completed", cid); } catch(e){}
                                try { if (typeof comp.complete === 'function') comp.complete(); } catch(e){}
                                
                                ['video-ad-completed', 'adCompleted'].forEach(n => window.dispatchEvent(new CustomEvent(n, { detail: { token, clientId: cid } })));
                                setTimeout(() => { processing = false; }, 5);
                            }

                            // 2. Spam U Key (Bot Action)
                            const evt = { key: 'u', code: 'KeyU', keyCode: 85, which: 85, bubbles: true };
                            document.dispatchEvent(new KeyboardEvent('keydown', evt));
                            document.dispatchEvent(new KeyboardEvent('keyup', evt));

                            // 3. Fake User Movement (Triggers Ad Servers)
                            const canvas = document.querySelector('canvas');
                            if (canvas) {
                                const rect = canvas.getBoundingClientRect();
                                const x = rect.left + (Math.random() * rect.width);
                                const y = rect.top + (Math.random() * rect.height);
                                canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
                                if (Math.random() > 0.9) canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true }));
                            }
                        }

                        // Hijack AIP tag to auto-complete immediately
                        const interval = setInterval(() => {
                            if (window.aiptag?.adplayer) {
                                const original = window.aiptag.adplayer.startPreRoll;
                                window.aiptag.adplayer.startPreRoll = function() {
                                    console.log("Ad intercepted - completing...");
                                    setTimeout(() => window.completeAd?.(), 100);
                                    return original ? original.apply(this, arguments) : null;
                                };
                                clearInterval(interval);
                            }
                        }, 1000);

                        function loop() {
                            autoAction();
                            requestAnimationFrame(loop);
                        }
                        requestAnimationFrame(loop);
                    })();
                });
            }

            await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
            log(`Bot ${id} connected to ${url}`);

            // Periodically check if we are stuck on a loading screen or "Click to Play"
            setInterval(async () => {
                try {
                    const playButton = await page.$('button, .play-button, #play-btn');
                    if (playButton) await playButton.click();
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
        await sendToWebhook(`🚀 Executor v${VERSION} Started`);

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
            const add = parseInt(await question("Add more bots? (Count): "));
            if (!isNaN(add) && add > 0) {
                const startIdx = count;
                count += add;
                if (mode === 3 && count > 5) {
                    const needed = (count - 5) - childProcesses.tor.length;
                    if (needed > 0) await startTorInstances(needed, 9050 + childProcesses.tor.length);
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
