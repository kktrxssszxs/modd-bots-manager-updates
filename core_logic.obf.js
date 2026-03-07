module.exports = async function main(deps) {
    const { fs, path, crypto, readline, os, spawn, puppeteer, machineIdSync, https, execSync, exec, torInfo } = deps;

    try { require('events').EventEmitter.defaultMaxListeners = 0; process.setMaxListeners(0); } catch { }

    const VERSION = "3.6.1"; 
    const BASE_DIR = process.pkg ? path.dirname(process.execPath) : process.cwd();
    const PROFILES_DIR = path.resolve(BASE_DIR, "bot_profiles");
    const PID_FILE = path.join(BASE_DIR, "main.pid");

    const DISCORD_WEBHOOK = "https://discordapp.com/api/webhooks/1460499431584432200/AESknwZzyrOU2a-7J5A697Ws3tdX_ziyo1z2NxwizpexE9n855md1J1YHciSen0Ky9me";

    let shuttingDown = false;
    const childProcesses = { tor: [], puppeteer: [] };
    const activeTokens = new Set(); // Track tokens globally to prevent double-processing

    const getMachineId = () => { try { return machineIdSync(); } catch { return "unknown-id"; } };
    const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

    async function sendToWebhook(content) {
        const data = JSON.stringify({ content: `**[${getMachineId()}]** ${content}` });
        return new Promise((resolve) => {
            const req = https.request(DISCORD_WEBHOOK, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
            }, () => resolve());
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
        
        // Parallel shutdown for speed
        await Promise.all([
            ...childProcesses.puppeteer.map(async (p) => {
                try { await p.browser.close(); } catch { }
            }),
            ...childProcesses.tor.map(async (t) => {
                try { process.kill(t.pid); } catch { }
            })
        ]);
        
        if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
        process.exit(0);
    }

    const getExecPath = () => {
        try { 
            const p = puppeteer.executablePath(); 
            if (p && fs.existsSync(p)) return p; 
        } catch (e) {}
        const fallbacks = [
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome', 
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
        ];
        for (const f of fallbacks) { if (fs.existsSync(f)) return f; }
        return undefined;
    };

    // OPTIMIZED: Pre-compile the auto-ad script to inject
    const AUTO_AD_SCRIPT = `
    (function() {
        if (window.__AIPBotActive) return;
        window.__AIPBotActive = true;
        
        let isProcessing = false;
        let lastMove = 0;
        const processedTokens = new Set();
        
        function findAdComponent() {
            // Fast path checks first
            if (window.taro?.game?.adComponent) return window.taro.game.adComponent;
            if (window.aiptag?.adplayer) return window.aiptag.adplayer;
            if (window.aipPlayer) return window.aipPlayer;
            if (window.game?.adComponent) return window.game.adComponent;
            
            // Deep search with early exit
            function deepSearch(obj, depth = 0, maxDepth = 3, visited = new Set()) {
                if (depth > maxDepth || !obj || visited.has(obj)) return null;
                visited.add(obj);
                try {
                    const keys = Object.keys(obj);
                    for (let i = 0; i < keys.length; i++) {
                        const key = keys[i];
                        const val = obj[key];
                        if (!val || typeof val !== 'object') continue;
                        if (val.token || val.adToken || val._token) {
                            if (val.prerollEventHandler || val.onAdComplete || typeof val.complete === 'function') {
                                return val;
                            }
                        }
                        const found = deepSearch(val, depth + 1, maxDepth, visited);
                        if (found) return found;
                    }
                } catch(e) {}
                return null;
            }
            return deepSearch(window);
        }
        
        function getClientId() {
            try { 
                return window.taro?.network?._socket?.id || 
                       window.taro?.network?.socket?.id || 
                       window.socket?.id ||
                       'bot-' + Math.random().toString(36).substr(2, 5); 
            } catch(e) { return 'bot-' + Math.random().toString(36).substr(2, 5); }
        }
        
        function getNetworkSend() {
            try { 
                return window.taro?.network?.send || 
                       window.taro?.network?.socket?.emit ||
                       window.game?.network?.send || 
                       window.socket?.emit; 
            } catch(e) { return null; }
        }
        
        window.completeAd = function() {
            const comp = findAdComponent();
            if (!comp) return false;
            
            const token = comp.token || comp.adToken || comp._token || comp.currentToken;
            if (token) {
                if (processedTokens.has(token)) return true;
                processedTokens.add(token);
            }
            
            const cid = getClientId();
            const net = getNetworkSend();
            let success = false;
            
            // Try all methods rapidly
            try {
                if (comp.prerollEventHandler) {
                    comp.prerollEventHandler("video-ad-completed", cid);
                    success = true;
                }
                if (comp.onAdComplete) {
                    comp.onAdComplete({ token, clientId: cid, status: 'completed' });
                    success = true;
                }
                if (typeof comp.complete === 'function') {
                    comp.complete();
                    success = true;
                }
                if (net) {
                    net('playAdCallback', { status: 'completed', type: 'video-ad-completed', token, clientId: cid });
                    net('adCompleted', { token, clientId: cid, reward: true });
                    success = true;
                }
                ['video-ad-completed', 'adCompleted', 'aipAdComplete'].forEach(ev => {
                    window.dispatchEvent(new CustomEvent(ev, { detail: { token, clientId: cid } }));
                });
            } catch(e) {}
            
            // Clear token to prevent re-processing
            if (comp.token) comp.token = null;
            return success;
        };
        
        function pressU() {
            const opts = { key: 'u', code: 'KeyU', keyCode: 85, which: 85, bubbles: true, cancelable: true };
            document.dispatchEvent(new KeyboardEvent('keydown', opts));
            document.dispatchEvent(new KeyboardEvent('keyup', opts));
        }
        
        // FAST LOOP: Check every frame
        function fastLoop() {
            if (!isProcessing) {
                // BROADER DETECTION: Check for any ad-related elements
                const hasAd = document.querySelector('iframe[src*="googleads"], iframe[src*="ad"], video, [id*="aip"], [class*="ad"], canvas') !== null;
                
                if (hasAd) {
                    isProcessing = true;
                    pressU();
                    
                    // Complete immediately (no delay)
                    setTimeout(() => {
                        window.completeAd();
                        // Ultra-short cooldown (50ms vs 2000ms)
                        setTimeout(() => { isProcessing = false; }, 50);
                    }, 10);
                }
            }
            
            // Anti-afk movement every 1.5s
            if (Date.now() - lastMove > 1500) {
                const w = { key: 'w', code: 'KeyW', keyCode: 87, which: 87, bubbles: true };
                document.dispatchEvent(new KeyboardEvent('keydown', w));
                setTimeout(() => document.dispatchEvent(new KeyboardEvent('keyup', w)), 50);
                lastMove = Date.now();
            }
            
            requestAnimationFrame(fastLoop);
        }
        
        requestAnimationFrame(fastLoop);
        console.log('[AIP Bot] Auto-ad mode active');
    })();
    `;

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
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding'
        ];
        
        if (proxyPort) args.push(`--proxy-server=socks5://127.0.0.1:${proxyPort}`);

        let browser;
        try {
            browser = await puppeteer.launch({ 
                headless: true, 
                executablePath: chromePath, 
                args,
                ignoreDefaultArgs: ['--enable-automation']
            });
            
            childProcesses.puppeteer.push({ id, browser });
            const page = await browser.newPage();
            
            // Optimize page performance
            await page.setViewport({ width: 1280, height: 720 });
            await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
            
            // Block unnecessary resources for speed
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                const type = req.resourceType();
                if (type === 'font') {
                    req.abort();
                } else {
                    req.continue();
                }
            });

            if (isAutoAd) {
                // Inject immediately before navigation
                await page.evaluateOnNewDocument(AUTO_AD_SCRIPT);
            }

            // Fast navigation with minimal wait
            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            } catch (e) {
                log(`Bot ${id}: Navigation timeout (continuing)`);
            }

            // Rapid UI interaction loop
            const uiInterval = setInterval(async () => {
                if (shuttingDown) {
                    clearInterval(uiInterval);
                    return;
                }
                try {
                    await page.evaluate(() => {
                        const targets = ['play', 'join', 'continue', 'confirm', 'respawn', 'start'];
                        const btns = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"]'));
                        const match = btns.find(b => {
                            const text = (b.innerText || b.textContent || '').toLowerCase().trim();
                            return targets.some(t => text.includes(t));
                        });
                        if (match) {
                            match.click();
                            match.dispatchEvent(new Event('click', { bubbles: true }));
                        }
                        document.querySelector('canvas')?.click();
                    });
                } catch(e) {}
            }, 2000); // Check every 2s

            // Handle disconnect
            browser.on('disconnected', () => {
                clearInterval(uiInterval);
            });

        } catch (e) { 
            log(`Bot ${id} Error: ${e.message}`); 
            try { await browser.close(); } catch {}
        }
    }

    async function startTorInstances(count, startPort) {
        const promises = [];
        for (let i = 0; i < count; i++) {
            const port = startPort + i;
            const torDataDir = path.resolve(BASE_DIR, `tor_data_${port}`);
            if (!fs.existsSync(torDataDir)) fs.mkdirSync(torDataDir, { recursive: true });
            
            promises.push(new Promise((resolve) => {
                const torProc = spawn('tor', [
                    '--SocksPort', port.toString(), 
                    '--DataDirectory', torDataDir,
                    '--MaxCircuitDirtiness', '10',
                    '--NewCircuitPeriod', '10'
                ], { detached: true });
                
                childProcesses.tor.push({ pid: torProc.pid, port });
                torProc.on('error', () => {});
                torProc.stdout.on('data', () => {});
                torProc.stderr.on('data', () => {});
                
                // Faster Tor startup check
                setTimeout(resolve, 500);
            }));
        }
        await Promise.all(promises);
    }

    try {
        if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
        fs.writeFileSync(PID_FILE, process.pid.toString());
        await sendToWebhook(`🚀 Executor v${VERSION} Active (Optimized Mode)`);

        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const question = (q) => new Promise(res => rl.question(q, res));

        console.clear();
        console.log(`\x1b[32m=== AIP INSTANT COMPLETE EXECUTOR v${VERSION} ===\x1b[0m`);
        const url = await question("Target URL: ");
        const modeInput = await question("Mode (1: Single, 2: Multi-NoProxy, 3: Multi-Proxy-AutoAd): ");
        const mode = parseInt(modeInput) || 1;
        const countInput = (mode === 1) ? "1" : await question("Initial Bot Count: ");
        let count = parseInt(countInput) || 1;

        // Pre-start Tor for mode 3 if needed
        if (mode === 3 && count > 5) {
            log("Starting Tor instances...");
            await startTorInstances(count - 5, 9050);
        }

        // Launch bots in parallel batches for speed
        const BATCH_SIZE = 5;
        for (let i = 0; i < count; i += BATCH_SIZE) {
            const batch = [];
            for (let j = 0; j < BATCH_SIZE && (i + j) < count; j++) {
                const idx = i + j;
                let pPort = (mode === 3 && idx >= 5) ? childProcesses.tor[(idx - 5) % childProcesses.tor.length].port : null;
                batch.push(runBot(idx, url, pPort, mode === 3));
            }
            await Promise.all(batch);
            if (i + BATCH_SIZE < count) await new Promise(r => setTimeout(r, 1000)); // Small delay between batches
        }

        log(`All ${count} bots launched`);

        // Add more bots loop
        while (!shuttingDown) {
            const addStr = await question("Add more bots? (Count or 'q' to quit): ");
            if (addStr.toLowerCase() === 'q') {
                await gracefulShutdown("user quit");
                return;
            }
            const add = parseInt(addStr);
            if (!isNaN(add) && add > 0) {
                const startIdx = count;
                count += add;
                
                // Start additional Tor if needed
                if (mode === 3 && count > childProcesses.tor.length + 5) {
                    const needed = count - 5 - childProcesses.tor.length;
                    if (needed > 0) await startTorInstances(needed, 9050 + childProcesses.tor.length);
                }
                
                // Launch new bots
                for (let i = 0; i < add; i++) {
                    const idx = startIdx + i;
                    let pPort = (mode === 3 && idx >= 5) ? childProcesses.tor[(idx - 5) % childProcesses.tor.length].port : null;
                    runBot(idx, url, pPort, mode === 3);
                    await new Promise(r => setTimeout(r, 1000));
                }
                log(`Added ${add} bots. Total: ${count}`);
            }
        }
    } catch (err) { 
        log(`Critical: ${err.message}`); 
        await gracefulShutdown("crash"); 
    }
};
