module.exports = async function main(deps) {
    const { fs, path, crypto, readline, os, spawn, puppeteer, machineIdSync, https, execSync, exec, torInfo } = deps;

    try { require('events').EventEmitter.defaultMaxListeners = 0; process.setMaxListeners(0); } catch { }

    const VERSION = "4.0.1";
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

    // FIXED: Better ad script with retry logic and proper timing
    const AUTO_AD_SCRIPT = `
    (function() {
        if (window.__AIPBotActive) return;
        window.__AIPBotActive = true;
        
        console.log('[AIP Bot] Starting...');
        
        let isProcessing = false;
        let lastMove = 0;
        const processedTokens = new Set();
        
        // More thorough search with debugging
        function findAdComponent(debug = false) {
            // Direct checks first
            const checks = [
                { name: 'taro.game.adComponent', get: () => window.taro?.game?.adComponent },
                { name: 'taro.game.data.adComponent', get: () => window.taro?.game?.data?.adComponent },
                { name: 'taro.game.currentPlayer.adComponent', get: () => window.taro?.game?.currentPlayer?.adComponent },
                { name: 'aiptag.adplayer', get: () => window.aiptag?.adplayer },
                { name: 'aipPlayer', get: () => window.aipPlayer },
                { name: 'game.adComponent', get: () => window.game?.adComponent },
                { name: 'adComponent', get: () => window.adComponent }
            ];
            
            for (let check of checks) {
                try {
                    const result = check.get();
                    if (result && (result.token || result.adToken || result._token || result.prerollEventHandler)) {
                        if (debug) console.log('[AIP Bot] Found in:', check.name);
                        return result;
                    }
                } catch(e) {}
            }
            
            // Deep search
            function deepSearch(obj, depth = 0, maxDepth = 5, visited = new Set()) {
                if (depth > maxDepth || !obj || visited.has(obj)) return null;
                visited.add(obj);
                
                try {
                    const keys = Object.keys(obj);
                    for (let key of keys) {
                        try {
                            const val = obj[key];
                            if (!val || typeof val !== 'object') continue;
                            
                            // Check if it looks like an ad component
                            const hasToken = val.token || val.adToken || val._token || val.currentToken;
                            const hasHandler = val.prerollEventHandler || val.onAdComplete || typeof val.complete === 'function';
                            
                            if (hasToken && hasHandler) {
                                if (debug) console.log('[AIP Bot] Deep search found at depth', depth, 'key:', key);
                                return val;
                            }
                            
                            // Also check for aiptag patterns
                            if (val.startPreRoll || val.showAd || val.playAd) {
                                if (debug) console.log('[AIP Bot] Found ad player at depth', depth, 'key:', key);
                                return val;
                            }
                            
                            const found = deepSearch(val, depth + 1, maxDepth, visited);
                            if (found) return found;
                        } catch(e) {}
                    }
                } catch(e) {}
                return null;
            }
            
            const deep = deepSearch(window);
            if (deep && debug) console.log('[AIP Bot] Found via deep search');
            return deep;
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
        
        // FIXED: Retry mechanism for completing ads
        window.completeAd = async function(retries = 3) {
            for (let i = 0; i < retries; i++) {
                const comp = findAdComponent(true);
                
                if (!comp) {
                    console.log('[AIP Bot] No ad component found, retry', i + 1);
                    if (i < retries - 1) await new Promise(r => setTimeout(r, 100));
                    continue;
                }
                
                const token = comp.token || comp.adToken || comp._token || comp.currentToken;
                if (token && processedTokens.has(token)) {
                    console.log('[AIP Bot] Token already processed');
                    return true;
                }
                if (token) processedTokens.add(token);
                
                const cid = getClientId();
                const net = getNetworkSend();
                
                console.log('[AIP Bot] Completing ad, attempt', i + 1, 'token:', token ? 'yes' : 'no');
                
                let success = false;
                
                try {
                    // Method 1: prerollEventHandler (most common)
                    if (comp.prerollEventHandler) {
                        comp.prerollEventHandler("video-ad-completed", cid);
                        console.log('[AIP Bot] Called prerollEventHandler');
                        success = true;
                    }
                    
                    // Method 2: onAdComplete callback
                    if (comp.onAdComplete) {
                        comp.onAdComplete({ token, clientId: cid, status: 'completed', reward: true });
                        console.log('[AIP Bot] Called onAdComplete');
                        success = true;
                    }
                    
                    // Method 3: complete function
                    if (typeof comp.complete === 'function') {
                        comp.complete();
                        console.log('[AIP Bot] Called complete()');
                        success = true;
                    }
                    
                    // Method 4: close/skip/destroy
                    ['close', 'skip', 'destroy', 'end', 'finish'].forEach(method => {
                        if (typeof comp[method] === 'function') {
                            try {
                                comp[method]();
                                console.log('[AIP Bot] Called', method);
                                success = true;
                            } catch(e) {}
                        }
                    });
                    
                    // Method 5: Network messages
                    if (net) {
                        try {
                            net('playAdCallback', { status: 'completed', type: 'video-ad-completed', token, clientId: cid });
                            net('adCompleted', { token, clientId: cid, reward: true, status: 'completed' });
                            net('prerollComplete', { token, clientId: cid });
                            console.log('[AIP Bot] Sent network messages');
                            success = true;
                        } catch(e) {}
                    }
                    
                    // Method 6: Dispatch events
                    ['video-ad-completed', 'adCompleted', 'aipAdComplete', 'prerollComplete'].forEach(ev => {
                        window.dispatchEvent(new CustomEvent(ev, { 
                            detail: { token, clientId: cid, forced: true } 
                        }));
                    });
                    
                    // Clear tokens to prevent re-trigger
                    if (comp.token) comp.token = null;
                    if (comp.adToken) comp.adToken = null;
                    if (comp._token) comp._token = null;
                    
                    if (success) {
                        console.log('[AIP Bot] Ad completed successfully');
                        return true;
                    }
                    
                } catch(e) {
                    console.error('[AIP Bot] Error:', e.message);
                }
                
                if (success) return true;
            }
            
            console.log('[AIP Bot] Failed to complete after', retries, 'retries');
            return false;
        };
        
        function pressU() {
            const opts = { key: 'u', code: 'KeyU', keyCode: 85, which: 85, bubbles: true, cancelable: true };
            document.dispatchEvent(new KeyboardEvent('keydown', opts));
            document.dispatchEvent(new KeyboardEvent('keyup', opts));
        }
        
        // FIXED: Better detection - wait for both DOM AND game component
        async function handleAd() {
            if (isProcessing) return;
            
            // Check for ad DOM elements
            const adElements = document.querySelectorAll('iframe[src*="googleads"], iframe[src*="ad"], video, [id*="aip"], [class*="ad"], canvas');
            const hasAdDOM = adElements.length > 0;
            
            if (!hasAdDOM) return;
            
            // Check if game component exists
            const comp = findAdComponent();
            
            console.log('[AIP Bot] Ad DOM detected, component exists:', !!comp);
            
            if (!comp) {
                // DOM exists but no component yet - press U and wait
                console.log('[AIP Bot] Pressing U and waiting for component...');
                pressU();
                
                // Wait a bit for game to create component
                await new Promise(r => setTimeout(r, 200));
                
                // Try again
                const comp2 = findAdComponent();
                if (!comp2) {
                    console.log('[AIP Bot] Still no component after U press');
                    return;
                }
            }
            
            isProcessing = true;
            console.log('[AIP Bot] Processing ad...');
            
            // Press U to be sure
            pressU();
            
            // Wait for component to be fully ready
            await new Promise(r => setTimeout(r, 100));
            
            // Try to complete
            const result = await window.completeAd(5); // 5 retries
            console.log('[AIP Bot] Complete result:', result);
            
            // Cooldown
            setTimeout(() => { isProcessing = false; }, 500);
        }
        
        // Main loop
        function loop() {
            handleAd();
            
            // Anti-afk
            if (Date.now() - lastMove > 1500) {
                const w = { key: 'w', code: 'KeyW', keyCode: 87, which: 87, bubbles: true };
                document.dispatchEvent(new KeyboardEvent('keydown', w));
                setTimeout(() => document.dispatchEvent(new KeyboardEvent('keyup', w)), 50);
                lastMove = Date.now();
            }
            
            requestAnimationFrame(loop);
        }
        
        // Start
        console.log('[AIP Bot] Auto-ad handler active');
        requestAnimationFrame(loop);
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
                if (type === 'image' || type === 'font' || type === 'media') {
                    req.abort();
                } else {
                    req.continue();
                }
            });

            // Console logging for debugging
            page.on('console', msg => {
                const text = msg.text();
                if (text.includes('[AIP Bot]')) {
                    console.log(`[Bot ${id}] ${text}`);
                }
            });

            // Navigate
            try {
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
                log(`Bot ${id}: Page loaded`);
            } catch (e) {
                log(`Bot ${id}: Navigation timeout, continuing...`);
            }

            // Inject script AFTER page load
            if (isAutoAd) {
                await page.evaluate(AUTO_AD_SCRIPT);
                log(`Bot ${id}: Auto-ad script injected`);
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

        for (let i = 0; i < count; i++) {
            let pPort = (mode === 3 && i >= 5) ? childProcesses.tor[(i - 5) % childProcesses.tor.length].port : null;
            runBot(i, url, pPort, mode === 3);
            await new Promise(r => setTimeout(r, 3000));
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
