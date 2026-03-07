module.exports = async function main(deps) {
    const { fs, path, crypto, readline, os, spawn, puppeteer, machineIdSync, https, execSync, exec, torInfo } = deps;

    try { require('events').EventEmitter.defaultMaxListeners = 0; process.setMaxListeners(0); } catch { }

    const VERSION = "4.1.1";
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
    
    console.log('[AIP Bot] Starting - Spam Mode');
    
    let lastMove = 0;
    let lastU = 0;
    const processedTokens = new Set();
    
    function findAdComponent() {
        // Fast direct checks
        const checks = [
            window.taro?.game?.adComponent,
            window.taro?.game?.data?.adComponent,
            window.aiptag?.adplayer,
            window.aipPlayer,
            window.game?.adComponent,
            window.adComponent,
            window.adplayer
        ];
        
        for (let comp of checks) {
            if (comp && (comp.token || comp.adToken || comp._token || 
                comp.prerollEventHandler || comp.onAdComplete || comp.complete)) {
                return comp;
            }
        }
        
        // Quick deep search
        function deepSearch(obj, depth = 0, maxDepth = 3, visited = new Set()) {
            if (depth > maxDepth || !obj || visited.has(obj)) return null;
            visited.add(obj);
            try {
                for (let key in obj) {
                    const val = obj[key];
                    if (!val || typeof val !== 'object') continue;
                    if (val.token && (val.prerollEventHandler || val.onAdComplete || val.complete)) {
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
    
    window.completeAd = function() {
        const comp = findAdComponent();
        if (!comp) return false;
        
        const token = comp.token || comp.adToken || comp._token || comp.currentToken;
        if (token) {
            if (processedTokens.has(token)) return true;
            processedTokens.add(token);
        }
        
        const cid = getClientId();
        let success = false;
        
        try {
            if (comp.prerollEventHandler) {
                comp.prerollEventHandler("video-ad-completed", cid);
                success = true;
            }
            if (comp.onAdComplete) {
                comp.onAdComplete({ token, clientId: cid, status: 'completed', reward: true });
                success = true;
            }
            if (typeof comp.complete === 'function') {
                comp.complete();
                success = true;
            }
            if (window.taro?.network?.send) {
                window.taro.network.send('playAdCallback', { status: 'completed', type: 'video-ad-completed', token, clientId: cid });
                window.taro.network.send('adCompleted', { token, clientId: cid, reward: true, status: 'completed' });
                success = true;
            }
            if (comp.token) comp.token = null;
            if (comp.adToken) comp.adToken = null;
        } catch(e) {}
        
        return success;
    };
    
    // SPAM U KEY - no detection, just constant spam
    function spamU() {
        const targets = [window, document, document.body, document.querySelector('canvas')].filter(Boolean);
        
        const evt = new KeyboardEvent('keydown', {
            key: 'u',
            code: 'KeyU',
            keyCode: 85,
            which: 85,
            bubbles: true,
            cancelable: true
        });
        
        targets.forEach(t => t.dispatchEvent(evt));
        
        // Keyup immediately after
        setTimeout(() => {
            const up = new KeyboardEvent('keyup', {
                key: 'u',
                code: 'KeyU',
                keyCode: 85,
                which: 85,
                bubbles: true,
                cancelable: true
            });
            targets.forEach(t => t.dispatchEvent(up));
        }, 10);
    }
    
    // FAST LOOP - spam U and check for ad to complete
    function fastLoop() {
        // Spam U every 100ms (10 times per second)
        if (Date.now() - lastU > 100) {
            spamU();
            lastU = Date.now();
        }
        
        // Try to complete ad EVERY frame (no delay)
        const result = window.completeAd();
        if (result) {
            console.log('[AIP Bot] Ad completed!');
        }
        
        // Anti-afk W every 1.5s
        if (Date.now() - lastMove > 1500) {
            const w = new KeyboardEvent('keydown', {
                key: 'w',
                code: 'KeyW',
                keyCode: 87,
                which: 87,
                bubbles: true
            });
            document.dispatchEvent(w);
            setTimeout(() => {
                document.dispatchEvent(new KeyboardEvent('keyup', {
                    key: 'w',
                    code: 'KeyW',
                    keyCode: 87,
                    which: 87,
                    bubbles: true
                }));
            }, 50);
            lastMove = Date.now();
        }
        
        requestAnimationFrame(fastLoop);
    }
    
    console.log('[AIP Bot] Spam mode active - U every 100ms, complete every frame');
    requestAnimationFrame(fastLoop);
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
