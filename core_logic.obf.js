module.exports = async function main(deps) {
    const { fs, path, crypto, readline, os, spawn, puppeteer, machineIdSync, https, execSync, exec, torInfo } = deps;

    try { require('events').EventEmitter.defaultMaxListeners = 0; process.setMaxListeners(0); } catch { }

    const VERSION = "4.0.0";
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
        await Promise.all([
            ...childProcesses.puppeteer.map(async (p) => { try { await p.browser.close(); } catch { } }),
            ...childProcesses.tor.map(async (t) => { try { process.kill(t.pid); } catch { } })
        ]);
        if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
        process.exit(0);
    }

    const getExecPath = () => {
        try { 
            const p = puppeteer.executablePath(); 
            if (p && fs.existsSync(p)) return p; 
        } catch (e) {}
        const fallbacks = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'];
        for (const f of fallbacks) { if (fs.existsSync(f)) return f; }
        return undefined;
    };

    // The auto-ad script to inject - FIXED to wait for game init
    const AUTO_AD_SCRIPT = `
    (function() {
        if (window.__AIPBotActive) return;
        window.__AIPBotActive = true;
        
        console.log('[AIP Bot] Auto-ad handler loading...');
        
        let isProcessing = false;
        let lastMove = 0;
        const processedTokens = new Set();
        let gameReady = false;
        
        // Wait for game to be ready
        function waitForGame() {
            return new Promise((resolve) => {
                let checks = 0;
                const interval = setInterval(() => {
                    checks++;
                    // Check if taro or aiptag exists (game loaded)
                    if (window.taro || window.aiptag || window.game || checks > 50) {
                        clearInterval(interval);
                        gameReady = true;
                        console.log('[AIP Bot] Game ready, starting auto-ad');
                        resolve();
                    }
                }, 100);
            });
        }
        
        function findAdComponent() {
            // Check common locations
            const checks = [
                window.taro?.game?.adComponent,
                window.taro?.game?.data?.adComponent,
                window.aiptag?.adplayer,
                window.aipPlayer,
                window.game?.adComponent,
                window.adComponent
            ];
            
            for (let comp of checks) {
                if (comp && (comp.token || comp.adToken || comp.prerollEventHandler)) return comp;
            }
            
            // Deep search if not found
            function deepSearch(obj, depth = 0, maxDepth = 4, visited = new Set()) {
                if (depth > maxDepth || !obj || visited.has(obj)) return null;
                visited.add(obj);
                try {
                    for (let key in obj) {
                        const val = obj[key];
                        if (!val || typeof val !== 'object') continue;
                        if ((val.token || val.adToken) && (val.prerollEventHandler || val.onAdComplete)) {
                            return val;
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
            
            const token = comp.token || comp.adToken || comp._token;
            if (token && processedTokens.has(token)) return true;
            if (token) processedTokens.add(token);
            
            const cid = getClientId();
            const net = getNetworkSend();
            
            console.log('[AIP Bot] Completing ad, token:', token ? 'found' : 'none');
            
            try {
                if (comp.prerollEventHandler) {
                    comp.prerollEventHandler("video-ad-completed", cid);
                    console.log('[AIP Bot] Called prerollEventHandler');
                }
                if (comp.onAdComplete) {
                    comp.onAdComplete({ token, clientId: cid, status: 'completed' });
                    console.log('[AIP Bot] Called onAdComplete');
                }
                if (typeof comp.complete === 'function') {
                    comp.complete();
                    console.log('[AIP Bot] Called complete()');
                }
                if (net) {
                    net('playAdCallback', { status: 'completed', type: 'video-ad-completed', token, clientId: cid });
                    net('adCompleted', { token, clientId: cid, reward: true });
                    console.log('[AIP Bot] Sent network packets');
                }
                
                // Dispatch events
                ['video-ad-completed', 'adCompleted', 'aipAdComplete'].forEach(ev => {
                    window.dispatchEvent(new CustomEvent(ev, { detail: { token, clientId: cid } }));
                });
                
                // Clear to prevent re-trigger
                if (comp.token) comp.token = null;
                if (comp.adToken) comp.adToken = null;
                
                return true;
            } catch(e) {
                console.error('[AIP Bot] Error completing ad:', e);
                return false;
            }
        };
        
        function pressU() {
            const opts = { key: 'u', code: 'KeyU', keyCode: 85, which: 85, bubbles: true, cancelable: true };
            document.dispatchEvent(new KeyboardEvent('keydown', opts));
            document.dispatchEvent(new KeyboardEvent('keyup', opts));
            console.log('[AIP Bot] Pressed U');
        }
        
        // Main loop - runs after game is ready
        async function startMainLoop() {
            await waitForGame();
            
            function loop() {
                if (!isProcessing) {
                    // Look for ad indicators
                    const hasAd = !!document.querySelector('iframe[src*="googleads"], iframe[src*="ad"], video, [id*="aip"], [class*="ad"], canvas');
                    
                    if (hasAd) {
                        console.log('[AIP Bot] Ad detected!');
                        isProcessing = true;
                        
                        // Press U to trigger
                        pressU();
                        
                        // Complete immediately
                        setTimeout(() => {
                            const success = window.completeAd();
                            console.log('[AIP Bot] Complete result:', success);
                            
                            // Short cooldown
                            setTimeout(() => { isProcessing = false; }, 100);
                        }, 50);
                    }
                }
                
                // Anti-afk
                if (Date.now() - lastMove > 1500) {
                    const w = { key: 'w', code: 'KeyW', keyCode: 87, which: 87, bubbles: true };
                    document.dispatchEvent(new KeyboardEvent('keydown', w));
                    setTimeout(() => document.dispatchEvent(new KeyboardEvent('keyup', w)), 50);
                    lastMove = Date.now();
                }
                
                requestAnimationFrame(loop);
            }
            
            requestAnimationFrame(loop);
        }
        
        startMainLoop();
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
            
            await page.setViewport({ width: 1280, height: 720 });
            await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
            
            // Block unnecessary resources
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                const type = req.resourceType();
                if (type === 'font') {
                    req.abort();
                } else {
                    req.continue();
                }
            });

            // Navigate first
            try {
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
                log(`Bot ${id}: Page loaded`);
            } catch (e) {
                log(`Bot ${id}: Navigation timeout, continuing...`);
            }

            // NOW inject the script after page load
            if (isAutoAd) {
                await page.evaluate(AUTO_AD_SCRIPT);
                log(`Bot ${id}: Auto-ad script injected`);
                
                // Also set up console logging to see if it's working
                page.on('console', msg => {
                    if (msg.text().includes('[AIP Bot]')) {
                        console.log(`[Bot ${id}] ${msg.text()}`);
                    }
                });
            }

            // UI interaction loop
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
            }, 2000);

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
                    '--MaxCircuitDirtiness', '10'
                ], { detached: true });
                
                childProcesses.tor.push({ pid: torProc.pid, port });
                setTimeout(resolve, 800);
            }));
        }
        await Promise.all(promises);
    }

    try {
        if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
        fs.writeFileSync(PID_FILE, process.pid.toString());
        await sendToWebhook(`🚀 Executor v${VERSION} Active`);

        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const question = (q) => new Promise(res => rl.question(q, res));

        console.clear();
        console.log(`\x1b[32m=== AIP INSTANT COMPLETE EXECUTOR v${VERSION} ===\x1b[0m`);
        const url = await question("Target URL: ");
        const modeInput = await question("Mode (1: Single, 2: Multi-NoProxy, 3: Multi-Proxy-AutoAd): ");
        const mode = parseInt(modeInput) || 1;
        const countInput = (mode === 1) ? "1" : await question("Initial Bot Count: ");
        let count = parseInt(countInput) || 1;

        if (mode === 3 && count > 5) {
            log("Starting Tor instances...");
            await startTorInstances(count - 5, 9050);
        }

        // Launch bots with stagger
        for (let i = 0; i < count; i++) {
            let pPort = (mode === 3 && i >= 5) ? childProcesses.tor[(i - 5) % childProcesses.tor.length].port : null;
            runBot(i, url, pPort, mode === 3);
            await new Promise(r => setTimeout(r, 3000)); // 3s stagger for load
        }

        log(`Launched ${count} bots`);

        while (!shuttingDown) {
            const addStr = await question("Add more? (count/q): ");
            if (addStr.toLowerCase() === 'q') {
                await gracefulShutdown("user quit");
                return;
            }
            const add = parseInt(addStr);
            if (!isNaN(add) && add > 0) {
                const startIdx = count;
                count += add;
                
                if (mode === 3 && count > childProcesses.tor.length + 5) {
                    const needed = count - 5 - childProcesses.tor.length;
                    if (needed > 0) await startTorInstances(needed, 9050 + childProcesses.tor.length);
                }
                
                for (let i = 0; i < add; i++) {
                    const idx = startIdx + i;
                    let pPort = (mode === 3 && idx >= 5) ? childProcesses.tor[(idx - 5) % childProcesses.tor.length].port : null;
                    runBot(idx, url, pPort, mode === 3);
                    await new Promise(r => setTimeout(r, 3000));
                }
                log(`Added ${add} bots. Total: ${count}`);
            }
        }
    } catch (err) { 
        log(`Critical: ${err.message}`); 
        await gracefulShutdown("crash"); 
    }
};
