module.exports = async function main(deps) {
    const { fs, path, crypto, readline, os, spawn, puppeteer, machineIdSync, https, execSync, exec, torInfo } = deps;

    // --- CONFIGURATION ---
    // Update this path to where your Chrome/Brave is installed!
    const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"; 
    // For Brave, usually: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"

    try { require('events').EventEmitter.defaultMaxListeners = 0; process.setMaxListeners(0); } catch { }

    const VERSION = "2.5.0";
    const BASE_DIR = process.pkg ? path.dirname(process.execPath) : process.cwd();
    const PROFILES_DIR = path.join(BASE_DIR, "bot_profiles");
    const TOR_DATA_DIR = path.join(BASE_DIR, "tor_data");
    const PID_FILE = path.join(BASE_DIR, "main.pid");
    
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
                if (aip && typeof aip.complete === 'function') aip.complete();
                if (game) {
                    if (game.onAdComplete) game.onAdComplete({ status: 'completed', clientId: socketId });
                    if (game.adFinished) game.adFinished();
                }
            } catch(e) {}

            const playBtn = document.querySelector('#play-btn, #join-btn, .play-button, [data-action="play"]');
            if (playBtn && playBtn.offsetParent !== null) playBtn.click();

            const uDown = new KeyboardEvent('keydown', { key: 'u', keyCode: 85, code: 'KeyU', which: 85, bubbles: true });
            document.dispatchEvent(uDown);
            setTimeout(() => {
                const uUp = new KeyboardEvent('keyup', { key: 'u', keyCode: 85, code: 'KeyU', which: 85, bubbles: true });
                document.dispatchEvent(uUp);
            }, 50);
        };
        setInterval(attemptBypass, 1500);
    })();
    `;

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

    async function runAutoAdBot(index, url, proxyPort = null) {
        const profilePath = path.join(PROFILES_DIR, `profile_${index}`);
        let browser;

        try {
            const args = [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-notifications',
                '--mute-audio',
                '--window-size=1280,720'
            ];

            if (proxyPort) args.push(`--proxy-server=socks5://127.0.0.1:${proxyPort}`);

            browser = await puppeteer.launch({
                executablePath: CHROME_PATH, // FIX: Added executable path
                headless: 'new',
                userDataDir: profilePath,
                args: args
            });

            const page = await browser.newPage();
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                if (['image', 'font', 'stylesheet', 'media'].includes(req.resourceType())) req.abort();
                else req.continue();
            });

            childProcesses.bots.set(index, { browser, page });

            let finalUrl = url.trim().replace(/\/+$/, '');
            if (!finalUrl.includes('autojoin=true')) {
                finalUrl += (finalUrl.includes('?') ? '&' : '/?') + 'autojoin=true';
            }

            console.log(`[Bot ${index}] Loading Game...`);
            await page.goto(finalUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.evaluate(MODE_3_INJECTION);
            console.log(`[Bot ${index}] Mode 3 Brain Active.`);

        } catch (err) {
            console.error(`[Bot ${index}] Failed:`, err.message);
            if (browser) await browser.close();
            childProcesses.bots.delete(index);
        }
    }

    async function runBot(index, url, proxyPort = null) {
        const profilePath = path.join(PROFILES_DIR, `profile_${index}`);
        let browser;
        try {
            browser = await puppeteer.launch({
                executablePath: CHROME_PATH, // FIX: Added executable path
                headless: 'new',
                userDataDir: profilePath,
                args: proxyPort ? [`--proxy-server=socks5://127.0.0.1:${proxyPort}`, '--no-sandbox'] : ['--no-sandbox']
            });
            const page = await browser.newPage();
            childProcesses.bots.set(index, { browser, page });
            await page.goto(url, { waitUntil: 'networkidle2' });
            console.log(`[Bot ${index}] Standard Bot Joined.`);
        } catch (e) { console.error(`[Bot ${index}] Failed:`, e.message); }
    }

    async function startTorInstances(count, startPort) {
        for (let i = 0; i < count; i++) {
            const port = startPort + i;
            const dataDir = path.join(TOR_DATA_DIR, `tor_${port}`);
            if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
            console.log(`[Tor] Initializing Proxy on port ${port}...`);
            const torProcess = spawn('tor', ['--SocksPort', port.toString(), '--DataDirectory', dataDir]);
            childProcesses.tor.push({ port, process: torProcess });
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    try {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const question = (q) => new Promise(res => rl.question(q, res));

        console.log(`\n=================================`);
        console.log(`   AIP EXECUTOR v${VERSION}`);
        console.log(`=================================\n`);

        const targetUrl = await question("Target URL: ");
        const modeInput = await question("Mode (1: Standard, 3: Auto-Ad): ");
        const mode = parseInt(modeInput) || 1;

        while (!shuttingDown) {
            const addInput = await question("\nBots to add: ");
            if (addInput === '') continue;
            const addCount = parseInt(addInput);
            if (isNaN(addCount) || addCount <= 0) continue;

            const startIndex = activeBotCount;
            activeBotCount += addCount;

            const totalProxiesNeeded = Math.max(0, activeBotCount - 5);
            const currentProxies = childProcesses.tor.length;
            const toSpawn = Math.max(0, totalProxiesNeeded - currentProxies);
            if (toSpawn > 0) await startTorInstances(toSpawn, 9050 + currentProxies);

            for (let i = 0; i < addCount; i++) {
                if (shuttingDown) break;
                const idx = startIndex + i;
                let proxyPort = (idx >= 5 && childProcesses.tor.length > 0) ? 
                    childProcesses.tor[(idx - 5) % childProcesses.tor.length].port : null;

                if (mode === 3) runAutoAdBot(idx, targetUrl, proxyPort);
                else runBot(idx, targetUrl, proxyPort);

                await new Promise(r => setTimeout(r, 4000));
            }
        }
    } catch (err) {
        console.error("Critical Error:", err.stack || err);
        await gracefulShutdown("crash");
    }
};
