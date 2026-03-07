module.exports = async function main(deps) {
    const { fs, path, crypto, readline, os, spawn, puppeteer, machineIdSync, https, execSync, exec, torInfo } = deps;

    try { require('events').EventEmitter.defaultMaxListeners = 0; process.setMaxListeners(0); } catch { }

    const VERSION = "4.0.8";
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

    // FIXED: Completely rewritten ad script based on working test code
    const AUTO_AD_SCRIPT = `
    (function() {
        if (window.__AIPBotActive) return;
        window.__AIPBotActive = true;
        
        console.log('[AIP Bot] Starting v2...');
        
        let isProcessing = false;
        let lastMove = 0;
        const processedTokens = new Set();
        
        // Exact copy from working test code
        function findAdComponent() {
            const locations = [
                () => window.taro?.game,
                () => window.taro?.game?.data,
                () => window.taro?.game?.currentPlayer,
                () => window.taro?.entities,
                () => window.game?.adComponent,
                () => window.game?.adManager,
                () => window.game?.ads,
                () => window.adManager,
                () => window.ads,
                () => window.adComponent,
                () => window.aiptag?.adplayer,
                () => window.aiptag?.adplayer?.component,
                () => window.aipPlayer,
                () => window.aipAdComponent,
                () => {
                    const el = document.querySelector('*');
                    return el?.__vue__?.adComponent || el?.__vueParentComponent?.adComponent;
                },
                () => window.__adCallbacks,
                () => window.__aipCallbacks,
                () => window.__adComponent
            ];
            
            for (let getter of locations) {
                try {
                    const result = getter();
                    if (result && (result.token || result.adToken || result._token || 
                        result.prerollEventHandler || result.onAdComplete || result.complete)) {
                        console.log('[AIP Bot] Found ad component via:', getter.toString().slice(0, 50));
                        return result;
                    }
                } catch(e) {}
            }
            
            // Deep search as last resort
            return deepSearch(window, 0);
        }
        
        function deepSearch(obj, depth, maxDepth = 3, visited = new Set()) {
            if (depth > maxDepth || !obj || visited.has(obj)) return null;
            visited.add(obj);
            
            try {
                for (let key in obj) {
                    try {
                        const val = obj[key];
                        if (!val) continue;
                        
                        if (typeof val === 'object') {
                            if (val.token && (val.prerollEventHandler || val.onAdComplete || val.complete)) {
                                console.log('[AIP Bot] Deep search found at depth', depth, 'key:', key);
                                return val;
                            }
                            const found = deepSearch(val, depth + 1, maxDepth, visited);
                            if (found) return found;
                        }
                    } catch(e) {}
                }
            } catch(e) {}
            return null;
        }
        
        function getClientId() {
            const locations = [
                () => window.taro?.network?._socket?.id,
                () => window.taro?.network?.socket?.id,
                () => window.taro?.clientId,
                () => window.game?.clientId,
                () => window.clientId,
                () => window.socket?.id,
                () => window.network?.socket?.id
            ];
            
            for (let getter of locations) {
                try {
                    const id = getter();
                    if (id) return id;
                } catch(e) {}
            }
            return 'bot-' + Math.random().toString(36).substr(2, 9);
        }
        
        function getNetworkSend() {
            const locations = [
                () => window.taro?.network?.send,
                () => window.taro?.network?.socket?.emit,
                () => window.game?.network?.send,
                () => window.network?.send,
                () => window.socket?.emit,
                () => window.io?.emit
            ];
            
            for (let getter of locations) {
                try {
                    const fn = getter();
                    if (typeof fn === 'function') return fn;
                } catch(e) {}
            }
            return null;
        }
        
        // FIXED: Complete ad function that actually works
        window.completeAd = function(options = {}) {
            console.log('[AIP Bot] Attempting complete...');
            
            const comp = findAdComponent();
            const clientId = getClientId();
            const networkSend = getNetworkSend();
            
            if (!comp) {
                console.log('[AIP Bot] No ad component found');
                return false;
            }
            
            console.log('[AIP Bot] Component keys:', Object.keys(comp).join(', '));
            
            const token = comp.token || comp.adToken || comp._token || comp.currentToken || 
                         comp.ad?.token || comp.data?.token || options.token;
            
            if (!token) {
                console.log('[AIP Bot] Warning: No token found, trying without');
            } else {
                console.log('[AIP Bot] Token found:', token.toString().substring(0, 40));
                if (processedTokens.has(token)) {
                    console.log('[AIP Bot] Token already processed');
                    return true;
                }
                processedTokens.add(token);
            }
            
            let success = false;
            
            // Method 1: prerollEventHandler
            if (comp.prerollEventHandler) {
                try {
                    comp.prerollEventHandler("video-ad-completed", clientId);
                    console.log('[AIP Bot] Called prerollEventHandler');
                    success = true;
                } catch(e) {
                    console.log('[AIP Bot] prerollEventHandler failed:', e.message);
                }
            }
            
            // Method 2: onAdComplete
            if (comp.onAdComplete) {
                try {
                    comp.onAdComplete({ token, clientId, status: 'completed' });
                    console.log('[AIP Bot] Called onAdComplete');
                    success = true;
                } catch(e) {
                    console.log('[AIP Bot] onAdComplete failed:', e.message);
                }
            }
            
            // Method 3: complete
            if (typeof comp.complete === 'function') {
                try {
                    comp.complete();
                    console.log('[AIP Bot] Called complete()');
                    success = true;
                } catch(e) {
                    console.log('[AIP Bot] complete() failed:', e.message);
                }
            }
            
            // Method 4: finish/close/skip/end/destroy
            ['finish', 'close', 'skip', 'end', 'destroy'].forEach(method => {
                if (typeof comp[method] === 'function') {
                    try {
                        comp[method]();
                        console.log('[AIP Bot] Called', method);
                        success = true;
                    } catch(e) {}
                }
            });
            
            // Method 5: Network
            if (networkSend) {
                try {
                    const messages = [
                        { type: 'playAdCallback', data: { status: 'completed', type: 'video-ad-completed', token, clientId } },
                        { type: 'adCompleted', data: { token, clientId, reward: true } },
                        { type: 'prerollComplete', data: { token, clientId } },
                        { type: 'videoAdCompleted', data: { token, clientId, completed: true } }
                    ];
                    
                    messages.forEach((msg, i) => {
                        try {
                            networkSend(msg.type, msg.data, clientId);
                            console.log('[AIP Bot] Sent network msg:', msg.type);
                            success = true;
                        } catch(e) {}
                    });
                } catch(e) {}
            }
            
            // Method 6: Events
            try {
                const events = [
                    'video-ad-completed', 'adCompleted', 'prerollComplete', 
                    'aipAdComplete', 'adFinished', 'rewardGranted'
                ];
                
                events.forEach(eventName => {
                    window.dispatchEvent(new CustomEvent(eventName, {
                        detail: { token, clientId, forced: true, source: 'AIPBot' }
                    }));
                });
                console.log('[AIP Bot] Dispatched events');
            } catch(e) {}
            
            // Method 7: Click skip buttons
            setTimeout(() => {
                const buttons = document.querySelectorAll(
                    'button[class*="skip"], button[class*="complete"], button[class*="close"], ' +
                    'a[class*="skip"], div[class*="skip"], [id*="skip"], [id*="complete"]'
                );
                buttons.forEach(btn => {
                    if (btn.offsetParent !== null && btn.click) {
                        btn.click();
                        console.log('[AIP Bot] Clicked button');
                    }
                });
            }, 100);
            
            if (success) {
                console.log('[AIP Bot] SUCCESS - Ad completion signals sent');
            } else {
                console.log('[AIP Bot] All methods failed');
            }
            
            return success;
        };
        
        function pressU() {
            const down = new KeyboardEvent('keydown', {
                key: 'u',
                code: 'KeyU',
                keyCode: 85,
                which: 85,
                bubbles: true,
                cancelable: true
            });
            const up = new KeyboardEvent('keyup', {
                key: 'u',
                code: 'KeyU',
                keyCode: 85,
                which: 85,
                bubbles: true,
                cancelable: true
            });
            document.dispatchEvent(down);
            document.dispatchEvent(up);
            console.log('[AIP Bot] Pressed U');
        }
        
        // FIXED: Better ad detection and handling
        let adCheckInterval = null;
        
        function startAdWatch() {
            if (adCheckInterval) return;
            
            adCheckInterval = setInterval(async () => {
                if (isProcessing) return;
                
                // Check for ad DOM
                const hasAd = document.querySelector('iframe[src*="googleads"], iframe[src*="ad"], video, [id*="aip"], [class*="ad"], canvas');
                
                if (hasAd) {
                    console.log('[AIP Bot] Ad DOM detected');
                    isProcessing = true;
                    
                    // Press U multiple times to trigger ad system
                    pressU();
                    await new Promise(r => setTimeout(r, 100));
                    pressU();
                    await new Promise(r => setTimeout(r, 100));
                    
                    // Wait for component to appear
                    let attempts = 0;
                    let success = false;
                    
                    while (attempts < 10 && !success) {
                        await new Promise(r => setTimeout(r, 100));
                        const result = window.completeAd();
                        if (result) {
                            success = true;
                            console.log('[AIP Bot] Ad completed on attempt', attempts + 1);
                        }
                        attempts++;
                    }
                    
                    if (!success) {
                        console.log('[AIP Bot] Failed to complete after', attempts, 'attempts');
                    }
                    
                    // Cooldown before next ad
                    setTimeout(() => {
                        isProcessing = false;
                    }, 1000);
                }
            }, 500); // Check every 500ms
        }
        
        // Anti-afk movement
        function antiAfk() {
            if (Date.now() - lastMove > 1500) {
                const w = new KeyboardEvent('keydown', {
                    key: 'w',
                    code: 'KeyW',
                    keyCode: 87,
                    which: 87,
                    bubbles: true
                });
                const wUp = new KeyboardEvent('keyup', {
                    key: 'w',
                    code: 'KeyW',
                    keyCode: 87,
                    which: 87,
                    bubbles: true
                });
                document.dispatchEvent(w);
                setTimeout(() => document.dispatchEvent(wUp), 50);
                lastMove = Date.now();
            }
            requestAnimationFrame(antiAfk);
        }
        
        // Start both systems
        console.log('[AIP Bot] Systems active');
        startAdWatch();
        requestAnimationFrame(antiAfk);
        
        // Also expose test function
        window.testAdSystem = function() {
            console.log('[AIP Bot] Testing...');
            const comp = findAdComponent();
            console.log('Component found:', !!comp);
            if (comp) {
                console.log('Keys:', Object.keys(comp));
                console.log('Has token:', !!(comp.token || comp.adToken || comp._token));
                console.log('Has prerollEventHandler:', typeof comp.prerollEventHandler === 'function');
                console.log('Client ID:', getClientId());
                console.log('Network send:', !!getNetworkSend());
            }
            return !!comp;
        };
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

            // Console logging
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

            // Inject script
            if (isAutoAd) {
                await page.evaluate(AUTO_AD_SCRIPT);
                log(`Bot ${id}: Auto-ad script injected (Mode 3)`);
                
                // Test the system after a delay
                setTimeout(async () => {
                    try {
                        await page.evaluate(() => {
                            if (window.testAdSystem) window.testAdSystem();
                        });
                    } catch(e) {}
                }, 5000);
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
        
        log(`Selected mode: ${mode} (isAutoAd: ${mode === 3})`);
        
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

        log(`Launched ${count} bots in mode ${mode}`);

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
