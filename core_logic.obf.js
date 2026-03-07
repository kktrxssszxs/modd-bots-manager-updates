module.exports = async function main(deps) {
    const { fs, path, crypto, readline, os, spawn, puppeteer, machineIdSync, https, execSync, exec, torInfo } = deps;

    try { require('events').EventEmitter.defaultMaxListeners = 0; process.setMaxListeners(0); } catch { }

    const VERSION = "2.2.1";
    const BASE_DIR = process.pkg ? path.dirname(process.execPath) : process.cwd();
    const PROFILES_DIR = path.join(BASE_DIR, "bot_profiles");
    const TOR_DATA_DIR = path.join(BASE_DIR, "tor_data");
    const PID_FILE = path.join(BASE_DIR, "main.pid");
    
    const DISCORD_WEBHOOK = "https://discordapp.com/api/webhooks/1460499431584432200/AESknwZzyrOU2a-7J5A697Ws3tdX_ziyo1z2NxwizpexE9n855md1J1YHciSen0Ky9me";

    let shuttingDown = false;
    let activeBotCount = 0;
    const childProcesses = { tor: [], bots: new Map() };

    // --- MODE 3 INJECTION SCRIPT ---
    const MODE_3_INJECTION = `
    (function() {
        console.log("MODE 3: AGGRESSIVE AD BYPASS ENGAGED");
        const attemptBypass = () => {
            const game = window.taro?.game;
            const aip = window.aiptag?.adplayer;
            const socketId = window.taro?.network?._socket?.id || 'bot-' + Math.random().toString(36).slice(2, 7);

            try {
                // 1. Force AIP Player to report 'completed'
                if (aip && typeof aip.complete === 'function') aip.complete();
                
                // 2. Trigger Taro internal ad callbacks
                if (game) {
                    if (game.onAdComplete) game.onAdComplete({ status: 'completed', clientId: socketId });
                    if (game.adFinished) game.adFinished();
                }
            } catch(e) {}

            // 3. Auto-click Play/Join buttons
            const playBtn = document.querySelector('#play-btn, #join-btn, .play-button, [data-action="play"]');
            if (playBtn && playBtn.offsetParent !== null) playBtn.click();

            // 4. Spam 'U' key for rewards (Shop/Claim)
            const uDown = new KeyboardEvent('keydown', { key: 'u', keyCode: 85, code: 'KeyU', which: 85, bubbles: true });
            document.dispatchEvent(uDown);
            setTimeout(() => {
                const uUp = new KeyboardEvent('keyup', { key: 'u', keyCode: 85, code: 'KeyU', which: 85, bubbles: true });
                document.dispatchEvent(uUp);
            }, 50);
        };
        // Run every 1.5 seconds for maximum reward throughput
        setInterval(attemptBypass, 1500);
    })();
    `;

    // Initialize Directories
    [PROFILES_DIR, TOR_DATA_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });

    fs.writeFileSync(PID_FILE, process.pid.toString());

    async function gracefulShutdown(reason = "manual") {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`\nShutting down (${reason})...`);

        for (const [idx, bot] of childProcesses.bots) {
            try { await bot.browser.close(); } catch (e) { }
        }
        childProcesses.tor.forEach(t => {
            try { t.process.kill(); } catch (e) { }
        });

        if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
        process.exit(0);
    }

    process.on('SIGINT', () => gracefulShutdown("SIGINT"));

    /**
     * Mode 3: Auto-Ad Spammer Bot
     */
    async function runAutoAdBot(index, url, proxyPort = null) {
        const profilePath = path.join(PROFILES_DIR, `profile_${index}`);
        let browser;

        try {
            const args = [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-notifications',
                '--disable-extensions',
                '--mute-audio',
                '--window-size=1280,720'
            ];

            if (proxyPort) args.push(`--proxy-server=socks5://127.0.0.1:${proxyPort}`);

            browser = await puppeteer.launch({
                headless: 'new',
                userDataDir: profilePath,
                args: args
            });

            const page = await browser.newPage();
            
            // Resource optimization: Block images and CSS
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                if (['image', 'font', 'stylesheet', 'media'].includes(req.resourceType())) req.abort();
                else req.continue();
            });

            childProcesses.bots.set(index, { browser, page });

            // Force autojoin parameter
            let finalUrl = url.trim().replace(/\/+$/, '');
            if (!finalUrl.includes('autojoin=true')) {
                finalUrl += (finalUrl.includes('?') ? '&' : '/?') + 'autojoin=true';
            }

            console.log(`[Bot ${index}] Loading Game...`);
            await page.goto(finalUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            
            // Inject the Mode 3 Spammer
            await page.evaluate(MODE_3_INJECTION);
            console.log(`[Bot ${index}] Mode 3 Brain Active.`);

        } catch (err) {
            console.error(`[Bot ${index}] Failed:`, err.message);
            if (browser) await browser.close();
            childProcesses.bots.delete(index);
        }
    }

    /**
     * Standard Mode Bot
     */
    async function runBot(index, url, proxyPort = null) {
        // Similar to runAutoAdBot but without the aggressive ad bypass
        const profilePath = path.join(PROFILES_DIR, `profile_${index}`);
        let browser;
        try {
            browser = await puppeteer.launch({
                headless: 'new',
                userDataDir: profilePath,
                args: proxyPort ? [`--proxy-server=socks5://127.0.0.1:${proxyPort}`, '--no-sandbox'] : ['--no-sandbox']
            });
            const page = await browser.newPage();
            childProcesses.bots.set(index, { browser, page });
            await page.goto(url, { waitUntil: 'networkidle2' });
            console.log(`[Bot ${index}] Standard Bot Joined.`);
        } catch (e) { console.error(e.message); }
    }

    /**
     * Tor Proxy Management
     */
    async function startTorInstances(count, startPort) {
        for (let i = 0; i < count; i++) {
            const port = startPort + i;
            const dataDir = path.join(TOR_DATA_DIR, `tor_${port}`);
            if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

            console.log(`[Tor] Initializing Proxy on port ${port}...`);
            const torProcess = spawn('tor', [
                '--SocksPort', port.toString(),
                '--DataDirectory', dataDir
            ]);

            childProcesses.tor.push({ port, process: torProcess });
            await new Promise(r => setTimeout(r, 2000)); // Stagger proxy start
        }
    }

    // --- MAIN INTERFACE ---
    try {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const question = (q) => new Promise(res => rl.question(q, res));

        console.log(`\n=================================`);
        console.log(`   AIP EXECUTOR v${VERSION}`);
        console.log(`=================================\n`);

        const targetUrl = await question("Target URL: ");
        const modeInput = await question("Mode (1: Standard, 3: Auto-Ad): ");
        const mode = parseInt(modeInput) || 1;

        console.log(`System initialized. Awaiting bot counts...`);

        while (!shuttingDown) {
            const addInput = await question("\nBots to add (e.g. 5): ");
            if (addInput === '') continue;

            const addCount = parseInt(addInput);
            if (isNaN(addCount) || addCount <= 0 || addCount > 60) {
                console.log("Invalid count (1-60).");
                continue;
            }

            const startIndex = activeBotCount;
            activeBotCount += addCount;

            // Manage Proxies: Start Tor for every bot after the 5th
            const totalProxiesNeeded = Math.max(0, activeBotCount - 5);
            const currentProxies = childProcesses.tor.length;
            const toSpawn = Math.max(0, totalProxiesNeeded - currentProxies);

            if (toSpawn > 0) await startTorInstances(toSpawn, 9050 + currentProxies);

            for (let i = 0; i < addCount; i++) {
                if (shuttingDown) break;
                const idx = startIndex + i;
                let proxyPort = null;
                
                if (idx >= 5 && childProcesses.tor.length > 0) {
                    proxyPort = childProcesses.tor[(idx - 5) % childProcesses.tor.length].port;
                }

                if (mode === 3) {
                    runAutoAdBot(idx, targetUrl, proxyPort);
                } else {
                    runBot(idx, targetUrl, proxyPort);
                }

                await new Promise(r => setTimeout(r, 4000)); // Safe join staggered
            }
        }
    } catch (err) {
        console.error("Critical Error:", err.stack || err);
        await gracefulShutdown("crash");
    }
};
