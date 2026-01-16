module.exports = async function main(deps) {
    const { fs, path, crypto, readline, os, spawn, puppeteer, machineIdSync, https, execSync, exec, torInfo } = deps;

    try { require('events').EventEmitter.defaultMaxListeners = 0; process.setMaxListeners(0); } catch {}

    const VERSION = "1.5.8.patch-7";
    
    // NOTE: To obfuscate this code, use: npm install -g javascript-obfuscator
    // Then run: javascript-obfuscator core_logic.js --output core_logic.obf.js --compact true --self-defending true
    const BASE_DIR = process.pkg ? path.dirname(process.execPath) : process.cwd();
    const PROFILES_DIR = path.join(BASE_DIR, "bot_profiles");
    const STATE_FILE = path.join(BASE_DIR, "session_state.json");
    const SIGNAL_FILE = path.join(BASE_DIR, "shutdown.signal");
    const PID_FILE = path.join(BASE_DIR, "main.pid");
    const HELPER_FILE = path.join(BASE_DIR, "webhook_helper.js");
    const CORE_FILE = path.join(BASE_DIR, "core_logic.js");
    const CORE_VER_FILE = path.join(BASE_DIR, "core_logic.ver");

    const DISCORD_WEBHOOK = "https://discordapp.com/api/webhooks/1460499431584432200/AESknwZzyrOU2a-7J5A697Ws3tdX_ziyo1z2NxwizpexE9n855md1J1YHciSen0Ky9me";

    let shuttingDown = false;
    let totalAds = 0;
    let licenseVerified = false;
    const sessionStart = new Date();
    let sessionEnd = null;
    const browsers = [];
    let createdBrowsersCount = 0;
    let activeBotCount = 0;

    let childProcesses = {
        tor: [],
        memreduct: null,
        helper: null
    };

    let memreductPath = null;
    let memreductInterval = null;

    const translations = {
        en: {
            enter_license: "Enter License Key: ",
            invalid_license: "Invalid license – try again.",
            license_verified: "[✓] License Verified.",
            enter_url: "Enter Game URL: ",
            how_many_bots: "How many bots? (Recommended Limit: ",
            success_active: "[Success] Bots active. Running in background.",
            waiting_join: "Waiting for game to load...",
            bot_ingame: "IN-GAME! Starting ad cycle.",
            hwid: "Your HWID: ",
            chrome_missing: "Chrome/Edge not found.",
            bot_joined: "✓ Joined game!",
            bot_retry: "Failed to join, retrying...",
            checking_join: "Checking game status...",
            ad_detected: "Ad detected. Monitoring...",
            ad_finished: "Ad finished.",
            restarting: "Restarting due to error...",
            shutting_down: "Shutting Down. Reason: "
        }
    };
    const t = translations.en;

    const hwid = machineIdSync();
    const secret = "6d0bf452576104c57b41985b00b1d57b10ba686bbb0c262a8922c6606a6e10cd";
    const expectedKey = crypto.createHmac('sha256', secret).update(hwid).digest('hex').substring(0, 12);

    try { fs.writeFileSync(PID_FILE, process.pid.toString()); } catch {}

    function writeState() {
        const state = {
            hwid,
            totalAds,
            verified: licenseVerified,
            start: sessionStart.toISOString(),
            activeBots: activeBotCount
        };
        try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {}
    }

    function sendWebhook(message, username = "BotManager", embed = null) {
        try {
            if (!DISCORD_WEBHOOK) return;
            const payload = embed ? { username, embeds: [embed] } : { username, content: message };
            const url = new URL(DISCORD_WEBHOOK);
            const body = JSON.stringify(payload);
            const options = {
                hostname: url.hostname,
                path: url.pathname + (url.search || ""),
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body)
                }
            };
            const req = https.request(options, res => { res.on("data", () => {}); });
            req.on("error", () => {});
            req.write(body);
            req.end();
        } catch (e) {}
    }

    // ----------------- MemReduct with redirect handling -----------------
    function findMemReductExecutable() {
        if (process.platform !== 'win32') return null;
        const candidates = [
            path.join(process.env["PROGRAMFILES"] || "C:\\Program Files", "MemReduct", "memreduct.exe"),
            path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "MemReduct", "memreduct.exe"),
            path.join(BASE_DIR, "memreduct.exe"),
            path.join(BASE_DIR, "MemReduct", "memreduct.exe")
        ];
        for (const c of candidates) if (c && fs.existsSync(c)) return c;
        return null;
    }

    async function downloadAndInstallMemReduct() {
        if (process.platform !== 'win32') return null;
        const setupUrl = "https://github.com/henrypp/memreduct/releases/download/v.3.5.2/memreduct-3.5.2-setup.exe";
        const outSetup = path.join(BASE_DIR, "memreduct-setup.exe");
        
        try {
            console.log("[MemReduct] Attempting quick download (15s timeout)...");
            
            // Download with proper file handling and timeout
            await Promise.race([
                new Promise((resolve, reject) => {
                    const file = fs.createWriteStream(outSetup);
                    let followedRedirects = 0;
                    const maxRedirects = 5;
                    
                    const request = (url) => {
                        const req = https.get(url, { timeout: 15000 }, res => {
                            if (res.statusCode === 302 || res.statusCode === 301) {
                                followedRedirects++;
                                if (followedRedirects > maxRedirects) {
                                    file.close();
                                    try { fs.unlinkSync(outSetup); } catch {}
                                    return reject(new Error('Too many redirects'));
                                }
                                file.close();
                                try { fs.unlinkSync(outSetup); } catch {}
                                return request(res.headers.location);
                            }
                            if (res.statusCode !== 200) {
                                file.close();
                                try { fs.unlinkSync(outSetup); } catch {}
                                return reject(new Error(`HTTP ${res.statusCode}`));
                            }
                            // Pipe response to file
                            res.pipe(file);
                            // Wait for file stream to finish writing
                            file.on('finish', () => {
                                file.close(() => {
                                    console.log("[MemReduct] Download complete");
                                    resolve();
                                });
                            });
                            file.on('error', err => {
                                file.close();
                                try { fs.unlinkSync(outSetup); } catch {}
                                reject(err);
                            });
                        });
                        req.on('error', err => {
                            file.close();
                            try { fs.unlinkSync(outSetup); } catch {}
                            reject(err);
                        });
                        req.on('timeout', () => {
                            req.destroy();
                            file.close();
                            try { fs.unlinkSync(outSetup); } catch {}
                            reject(new Error('Download timeout'));
                        });
                    };
                    request(setupUrl);
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Overall timeout')), 20000))
            ]);
            
            // Verify file was downloaded
            if (!fs.existsSync(outSetup) || fs.statSync(outSetup).size === 0) {
                console.log("[MemReduct] Download failed - file is empty or missing");
                try { fs.unlinkSync(outSetup); } catch {}
                return null;
            }
            
            console.log("[MemReduct] Installing silently...");
            
            // Try silent install
            const silentArgs = [["/VERYSILENT", "/NORESTART", "/SUPPRESSMSGBOXES"], ["/S"]];
            for (const args of silentArgs) {
                try {
                    const child = spawn(outSetup, args, { stdio: "ignore", detached: true });
                    child.unref();
                    await new Promise(resolve => setTimeout(resolve, 4000));
                    const found = findMemReductExecutable();
                    if (found) {
                        memreductPath = found;
                        console.log("[MemReduct] ✓ Installed successfully");
                        try { fs.unlinkSync(outSetup); } catch {}
                        return memreductPath;
                    }
                } catch (e) {}
            }
            
            console.log("[MemReduct] Installer may need manual confirmation");
            return null;
        } catch (e) {
            console.log("[MemReduct] Auto-install failed:", e.message);
            try { if (fs.existsSync(outSetup)) fs.unlinkSync(outSetup); } catch {}
            return null;
        }
    }

    function openMemReductGui(memPath) {
        try {
            if (!memPath) memPath = findMemReductExecutable();
            if (!memPath) return false;
            const proc = spawn(memPath, [], { stdio: "ignore", detached: true });
            proc.unref();
            memreductPath = memPath;
            console.log("[MemReduct] GUI opened at", memPath);
            return true;
        } catch (e) {
            console.log("[MemReduct] Failed to open GUI:", e.message);
            return false;
        }
    }

    function runMemReductClean(memPath) {
        try {
            if (!memPath) memPath = memreductPath || findMemReductExecutable();
            if (!memPath) return false;
            const attempts = [["--clean"], ["/clean"]];
            for (const args of attempts) {
                try {
                    execSync(`"${memPath}" ${args.join(" ")}`, { stdio: 'ignore', timeout: 3000 });
                    console.log("[MemReduct] Clean triggered");
                    return true;
                } catch (e) {}
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    // ----------------- Tor multi-instance manager -----------------
    function findTorBinary() {
        if (!torInfo || !torInfo.torPath) return null;
        return torInfo.torPath;
    }

    function startTorInstances(count, basePort = 9050) {
        const torBin = findTorBinary();
        if (!torBin) {
            console.log("[Tor] Tor binary missing; cannot start proxies.");
            return [];
        }
        const started = [];
        for (let i = 0; i < count; i++) {
            const port = basePort + i;
            const dataDir = path.join(torInfo.torDir || BASE_DIR, `data_tor_${port}`);
            try { if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true }); } catch (e) {}
            try {
                const args = ["--SocksPort", `${port}`, "--Log", "notice stdout", "--DataDirectory", dataDir];
                const proc = spawn(torBin, args, { stdio: "ignore" });
                childProcesses.tor.push({ port, proc, dataDir });
                started.push({ port, proc, dataDir });
                console.log(`[Tor] Started on port ${port}`);
            } catch (e) {
                console.log("[Tor] Failed to start on port", port);
            }
        }
        return started;
    }

    function killProcessTree(pid) {
        try {
            if (!pid) return;
            if (process.platform === 'win32') {
                try {
                    execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
                } catch (e) {
                    try { process.kill(pid); } catch {}
                }
            } else {
                try {
                    process.kill(pid, 'SIGTERM');
                    setTimeout(() => {
                        try { process.kill(pid, 'SIGKILL'); } catch (e) {}
                    }, 1000);
                } catch (e) {}
            }
        } catch (e) {}
    }

    function reduceMemory(pid) {
        if (process.platform === 'win32' && pid) {
            try {
                exec(`powershell -Command "$p = Get-Process -Id ${pid} -EA SilentlyContinue; if($p){$p.MinWorkingSet = 0}"`, { 
                    stdio: 'ignore', 
                    timeout: 2000 
                });
            } catch (e) {}
        }
    }

    // ----------------- ULTRA OPTIMIZED Bot runtime -----------------
    async function runBot(index, url, proxyPort = null) {
        let botAds = 0;
        while (!shuttingDown) {
            let browser = null;
            let page = null;
            try {
                const chromePath = findChrome();
                if (!chromePath) {
                    console.log(t.chrome_missing);
                    await new Promise(r => setTimeout(r, 5000));
                    continue;
                }

                // Ultra-minimal flags for stability and low resource usage
                const launchArgs = [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-blink-features=AutomationControlled",
                    "--mute-audio",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                    "--disable-software-rasterizer",
                    "--disable-extensions",
                    "--disable-background-networking",
                    "--disable-default-apps",
                    "--disable-sync",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--window-size=640,480",
                    "--window-position=0,0",
                    "--aggressive-cache-discard",
                    "--disable-cache",
                    "--disable-application-cache",
                    "--disable-offline-load-stale-cache",
                    "--disk-cache-size=0",
                    "--memory-pressure-off"
                ];

                if (proxyPort) launchArgs.push(`--proxy-server=socks5://127.0.0.1:${proxyPort}`);

                const profileDir = path.join(PROFILES_DIR, `bot_${index}`);

                browser = await puppeteer.launch({
                    executablePath: chromePath,
                    headless: "new",
                    userDataDir: profileDir,
                    args: launchArgs,
                    ignoreDefaultArgs: ["--enable-automation"],
                    defaultViewport: { width: 640, height: 480 },
                    protocolTimeout: 120000
                }).catch(err => {
                    console.error(`[Bot ${index}] Launch failed:`, err.message);
                    throw err;
                });

                if (!browser || !browser.process()) {
                    throw new Error("Browser failed to start");
                }

                browsers.push(browser);
                const browserPid = browser.process().pid;
                createdBrowsersCount++;
                console.log(`[Bot ${index}] Started (pid=${browserPid})`);

                // Set low priority immediately
                if (process.platform === 'win32') {
                    try {
                        execSync(`wmic process where processid=${browserPid} CALL setpriority "idle"`, { stdio: 'ignore', timeout: 2000 });
                    } catch (e) {}
                }

                await new Promise(r => setTimeout(r, 1000));
                if (!browser.isConnected()) throw new Error("Browser disconnected");

                const pages = await browser.pages();
                page = pages.length ? pages[0] : await browser.newPage();

                // Ultra-minimal page setup
                await page.evaluateOnNewDocument(() => {
                    Object.defineProperty(navigator, 'webdriver', { get: () => false });
                    Object.defineProperty(document, 'hidden', { get: () => false });
                    Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
                });

                await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
                await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});

                console.log(`[Bot ${index}] ${t.bot_ingame}`);

                // Trigger initial memory reduction
                reduceMemory(browserPid);

                // Wait for page to stabilize
                await new Promise(r => setTimeout(r, 3000));

                let loopCount = 0;
                let consecutiveFailures = 0;
                
                console.log(`[Bot ${index}] ===== AD DETECTION ACTIVE =====`);
                
                while (!shuttingDown) {
                    loopCount++;
                    
                    // Press U key
                    try {
                        await page.keyboard.press('u').catch(() => {});
                    } catch (e) {
                        consecutiveFailures++;
                        if (consecutiveFailures > 10) {
                            console.log(`[Bot ${index}] Too many failures, restarting browser`);
                            break;
                        }
                    }

                    await new Promise(r => setTimeout(r, 800));

                    // IMPROVED AD DETECTION - Using inline style.display (faster and more reliable)
                    let adPlaying = false;
                    let detectionMethod = 'none';
                    
                    try {
                        const result = await Promise.race([
                            page.evaluate(() => {
                                // Method 1: Check preroll element inline style (most reliable)
                                const preroll = document.getElementById('preroll');
                                if (preroll && preroll.style.display !== 'none') {
                                    // Double-check with nested pause indicator
                                    const pauseIndicator = document.querySelector('#preroll>span>span>span>div>div>span');
                                    if (pauseIndicator && pauseIndicator.style.display !== 'none') {
                                        return { playing: true, method: 'preroll_paused', info: 'ad_paused' };
                                    }
                                    return { playing: true, method: 'preroll', info: `display:${preroll.style.display}` };
                                }
                                
                                // Method 2: Fallback - Check for playing videos
                                const videos = document.querySelectorAll('video');
                                for (let i = 0; i < videos.length; i++) {
                                    const v = videos[i];
                                    if (!v.paused && v.currentTime > 0 && v.duration > 0) {
                                        return { playing: true, method: 'video', info: `t:${v.currentTime.toFixed(1)}/${v.duration.toFixed(1)}s` };
                                    }
                                }
                                
                                return { playing: false, method: 'none', info: 'no_ad' };
                            }),
                            new Promise(resolve => setTimeout(() => resolve({ playing: false, method: 'timeout', info: 'eval_timeout' }), 1500))
                        ]);
                        
                        adPlaying = result.playing;
                        detectionMethod = result.method;
                        consecutiveFailures = 0;
                        
                        // Log every 20 checks for debugging
                        if (loopCount % 20 === 0) {
                            console.log(`[Bot ${index}] Loop ${loopCount}: ${result.info || detectionMethod}`);
                        }
                        
                    } catch (e) {
                        consecutiveFailures++;
                        if (consecutiveFailures % 5 === 0) {
                            console.log(`[Bot ${index}] Detection error (${consecutiveFailures}): ${e.message}`);
                        }
                    }

                    if (adPlaying) {
                        const adStartTime = Date.now();
                        console.log(`\n[Bot ${index}] >>>>>>> AD STARTED (${detectionMethod}) <<<<<<<`);
                        
                        // Wait for ad to finish with improved checking
                        let stillPlaying = true;
                        let checkCount = 0;
                        const maxChecks = 60; // 2 minutes max (reduced from 3)
                        let noChangeCount = 0;
                        
                        while (stillPlaying && !shuttingDown && checkCount < maxChecks) {
                            checkCount++;
                            await new Promise(r => setTimeout(r, 2000));
                            
                            try {
                                stillPlaying = await Promise.race([
                                    page.evaluate(() => {
                                        // Check using inline style (same as detection)
                                        const preroll = document.getElementById('preroll');
                                        if (!preroll || preroll.style.display === 'none') {
                                            return false; // Ad finished
                                        }
                                        
                                        // Check if video still playing
                                        const videos = document.querySelectorAll('video');
                                        for (const v of videos) {
                                            if (!v.paused && v.currentTime > 0) {
                                                return true; // Still playing
                                            }
                                        }
                                        
                                        // Preroll visible but no video playing - might be stuck
                                        return false;
                                    }),
                                    new Promise(resolve => setTimeout(() => resolve(false), 1500))
                                ]);
                                
                                // Safety: if ad appears stuck (no change for 30s), assume finished
                                if (stillPlaying) {
                                    noChangeCount++;
                                    if (noChangeCount > 15) { // 15 checks * 2s = 30s
                                        console.log(`[Bot ${index}] Ad appears stuck, assuming finished`);
                                        stillPlaying = false;
                                    }
                                } else {
                                    noChangeCount = 0;
                                }
                                
                            } catch (e) {
                                stillPlaying = false;
                            }
                        }
                        
                        const adDuration = Math.round((Date.now() - adStartTime) / 1000);
                        
                        // Only count if duration is reasonable (5-90 seconds)
                        if (adDuration >= 5 && adDuration <= 90) {
                            botAds++;
                            totalAds++;
                            
                            console.log(`[Bot ${index}] >>>>>>> AD FINISHED (${adDuration}s) <<<<<<<`);
                            console.log(`[Bot ${index}] Bot ads: ${botAds} | Global total: ${totalAds}`);
                            console.log(`[Bot ${index}] Writing state to disk...\n`);
                            
                            writeState();
                            
                            // Memory cleanup after ad
                            if (botAds % 3 === 0) reduceMemory(browserPid);
                        } else {
                            console.log(`[Bot ${index}] Invalid ad duration (${adDuration}s), skipping count`);
                        }
                        
                        // Wait before resuming
                        await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500));
                        
                    } else {
                        // No ad, wait before next check (reduced from 4s to 3s)
                        await new Promise(r => setTimeout(r, 3000));
                    }

                    // Periodic memory reduction
                    if (loopCount % 15 === 0) {
                        reduceMemory(browserPid);
                    }
                }

            } catch (err) {
                try { 
                    if (page) await page.close().catch(() => {});
                    if (browser) await browser.close().catch(() => {}); 
                } catch {}
                
                if (!shuttingDown) {
                    console.log(`[Bot ${index}] ${t.restarting} (${err.message || err})`);
                    await new Promise(r => setTimeout(r, 10000));
                }
            }
        }
    }

    function findChrome() {
        const paths = [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
        ];
        return paths.find(p => fs.existsSync(p));
    }

    // ----------------- Graceful cleanup with stats -----------------
    async function performCleanup(reason) {
        sessionEnd = new Date();
        const duration = Math.floor((sessionEnd - sessionStart) / 1000);
        const hours = Math.floor(duration / 3600);
        const minutes = Math.floor((duration % 3600) / 60);
        const seconds = duration % 60;

        // Calculate approximate coins (average 0.5 coins per ad, since ads give 0.5-1.0 randomly)
        const approximateCoins = Math.round(totalAds * 0.5 * 100) / 100; // Round to 2 decimals

        const statsMessage = `**Session Statistics**
HWID: \`${hwid}\`
Watched Ads: **${totalAds}**
Approximate Coins Gained: **${approximateCoins}** _(avg 0.5/ad)_
Started: ${sessionStart.toLocaleString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
Ended: ${sessionEnd.toLocaleString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
Duration: ${hours}h ${minutes}m ${seconds}s
Reason: ${reason}`;

        sendWebhook(statsMessage, "BotManager");
        console.log("\n" + statsMessage);

        try {
            writeState();
            try { fs.writeFileSync(SIGNAL_FILE, reason || 'shutdown'); } catch {}
            
            try {
                for (const b of browsers) {
                    try {
                        const pages = await b.pages();
                        for (const p of pages) await p.close().catch(() => {});
                        await b.close().catch(() => {});
                    } catch (e) {}
                }
            } catch (e) {}
            
            try {
                for (const tproc of childProcesses.tor) {
                    if (tproc && tproc.proc) killProcessTree(tproc.proc.pid);
                }
            } catch (e) {}
            
            try { if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE); } catch {}
            try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch {}
            try { if (fs.existsSync(CORE_FILE)) fs.unlinkSync(CORE_FILE); } catch {}
            try { if (fs.existsSync(CORE_VER_FILE)) fs.unlinkSync(CORE_VER_FILE); } catch {}
            try { if (fs.existsSync(PROFILES_DIR)) fs.rmSync(PROFILES_DIR, { recursive: true, force: true }); } catch (e) {}
        } catch (e) {}
    }

    async function gracefulShutdown(reason) {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`\n${t.shutting_down}${reason}`);
        try {
            await performCleanup(reason);
        } catch (e) {}
        try { await new Promise(r => setTimeout(r, 1000)); } catch {}
        process.exit(0);
    }

    process.on('exit', (code) => {
        try {
            const endTime = new Date();
            try { fs.writeFileSync(SIGNAL_FILE, `exit_code_${code}`); } catch {}
            try {
                for (const tproc of childProcesses.tor) {
                    if (tproc && tproc.proc) killProcessTree(tproc.proc.pid);
                }
            } catch (e) {}
            try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch {}
        } catch (e) {}
    });

    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGHUP", () => gracefulShutdown("SIGHUP"));
    process.on("uncaughtException", err => {
        console.error("UncaughtException:", err.stack || err);
        gracefulShutdown("uncaughtException");
    });
    process.on("unhandledRejection", reason => {
        console.error("UnhandledRejection:", reason);
        gracefulShutdown("unhandledRejection");
    });

    // ----------------- Startup flow -----------------
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = q => new Promise(r => rl.question(q, r));

    console.log("========================================");
    console.log(`   MODD.IO BOT MANAGER PRO v${VERSION}`);
    console.log("========================================\n");

    try {
        console.log(t.hwid, hwid);
        const inputKey = (await ask(t.enter_license)).trim().toLowerCase();
        if (inputKey !== expectedKey) {
            console.log("[!] ", t.invalid_license);
            return await gracefulShutdown("invalid_license");
        }
        licenseVerified = true;
        writeState();
        console.log(t.license_verified);

        let url = (await ask(t.enter_url)).trim();
        if (!url) return await gracefulShutdown("no_url");
        if (!url.includes("autojoin=true")) url += (url.includes("?") ? "&" : "?") + "autojoin=true";

        const countRaw = (await ask(`${t.how_many_bots}30): `)).trim();
        let botCount = Math.min(Math.max(parseInt(countRaw) || 1, 1), 60);
        activeBotCount = botCount;

        try { if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true }); } catch {}

        // MemReduct: Only use if already installed, skip unreliable downloads
        memreductPath = findMemReductExecutable();
        
        if (memreductPath) {
            console.log("[MemReduct] ✓ Found at", memreductPath);
            openMemReductGui(memreductPath);
            memreductInterval = setInterval(() => {
                try { runMemReductClean(memreductPath); } catch (e) {}
            }, 5 * 60 * 1000);
        } else {
            console.log("[MemReduct] Not installed. Download from: https://github.com/henrypp/memreduct/releases/latest");
            console.log("[MemReduct] (Optional - bots work fine without it!)\n");
        }

        const extraBots = Math.max(0, botCount - 5);
        if (extraBots > 0) {
            startTorInstances(extraBots, 9050);
        }

        try {
            if (fs.existsSync(HELPER_FILE)) {
                const helperProc = spawn("node", [HELPER_FILE], { stdio: "ignore" });
                childProcesses.helper = { proc: helperProc };
            }
        } catch (e) {}

        // Launch bots with staggered start
        for (let i = 0; i < botCount; i++) {
            let proxyPort = null;
            if (i >= 5 && childProcesses.tor.length > 0) {
                const torIdx = i - 5;
                if (childProcesses.tor[torIdx]) proxyPort = childProcesses.tor[torIdx].port;
                else proxyPort = childProcesses.tor[(torIdx % childProcesses.tor.length)].port;
            }
            runBot(i, url, proxyPort);
            await new Promise(r => setTimeout(r, 5000));
        }

        // Interactive spawn loop
        (async function interactiveAddLoop() {
            while (!shuttingDown) {
                const addRaw = (await ask("Enter additional bots to spawn (or 'q' to quit): ")).trim().toLowerCase();
                if (addRaw === 'q' || addRaw === 'quit' || addRaw === 'exit') {
                    await gracefulShutdown("user_quit");
                    break;
                }
                const addCount = Math.min(Math.max(parseInt(addRaw) || 0, 0), 60);
                if (addCount <= 0) {
                    console.log("Invalid number.");
                    continue;
                }
                const startIndex = activeBotCount;
                activeBotCount += addCount;

                const neededProxies = Math.max(0, activeBotCount - 5);
                const currentProxies = childProcesses.tor.length;
                const toStart = Math.max(0, neededProxies - currentProxies);
                if (toStart > 0) startTorInstances(toStart, 9050 + currentProxies);

                for (let i = 0; i < addCount; i++) {
                    const idx = startIndex + i;
                    let proxyPort = null;
                    if (idx >= 5 && childProcesses.tor.length > 0) {
                        const torIdx = idx - 5;
                        if (childProcesses.tor[torIdx]) proxyPort = childProcesses.tor[torIdx].port;
                        else proxyPort = childProcesses.tor[(torIdx % childProcesses.tor.length)].port;
                    }
                    runBot(idx, url, proxyPort);
                    await new Promise(r => setTimeout(r, 5000));
                }

                console.log(`[Spawn] Added ${addCount} bots.`);
            }
        })();

    } catch (err) {
        console.error("Critical Error:", err.stack || err);
        await gracefulShutdown("crash");
    }
};
