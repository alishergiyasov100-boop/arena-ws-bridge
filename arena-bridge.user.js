// ==UserScript==
// @name         Arena API Bridge - Standard Edition v3.2.7
// @namespace    http://tampermonkey.net/
// @version      3.2.7
// @description  Bridges Arena to a local API server via WebSocket (Stable Release)
// @author       Your Name
// @match        https://lmarena.ai/*
// @match        https://*.lmarena.ai/*
// @match        https://arena.ai/*
// @match        https://*.arena.ai/*
// @match        https://chat.lmsys.org/*
// @match        https://*.chat.lmsys.org/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=lmarena.ai
// @connect      localhost
// @connect      127.0.0.1
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_addElement
// @run-at       document-end
// @downloadURL https://update.greasyfork.org/scripts/565469/Arena%20API%20Bridge%20-%20Standard%20Edition%20v327.user.js
// @updateURL https://update.greasyfork.org/scripts/565469/Arena%20API%20Bridge%20-%20Standard%20Edition%20v327.meta.js
// ==/UserScript==

(function () {
    'use strict';
    console.log("[API Bridge] 🚀 INJECTED on", location.href, "ts=", Date.now());
    document.title = "🚀 " + document.title;

    // === Anti-throttle: keep this tab/page alive even when in background ===
    // 1. Screen Wake Lock — prevents screen sleep (works on Chromium/Kiwi)
    let wakeLock = null;
    async function ensureWakeLock() {
        try {
            if ('wakeLock' in navigator) {
                wakeLock = await navigator.wakeLock.request('screen');
                wakeLock.addEventListener('release', () => { wakeLock = null; });
                console.log('[API Bridge] 🔒 Screen wake lock acquired');
            }
        } catch (e) { console.warn('[API Bridge] wakeLock fail', e); }
    }
    ensureWakeLock();
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && !wakeLock) ensureWakeLock();
    });
    // 2. Silent audio loop — prevents tab freeze on Chrome/Kiwi when screen off
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        gain.gain.value = 0.0001; // inaudible but not zero
        osc.connect(gain).connect(audioCtx.destination);
        osc.frequency.value = 1;
        osc.start();
        document.addEventListener('click', () => audioCtx.resume(), {once: true});
        // try immediate resume (may need user gesture; fallback to first click)
        audioCtx.resume().catch(()=>{});
        console.log('[API Bridge] 🎵 silent audio loop started (anti-throttle)');
    } catch(e) { console.warn('[API Bridge] silent audio fail', e); }
    // 3. Periodic WS ping every 10s — forces socket activity
    setInterval(() => {
        if (typeof socket !== 'undefined' && socket && socket.readyState === WebSocket.OPEN) {
            try { socket.send(JSON.stringify({request_id: 'ping', data: 'ping'})); } catch(e){}
        }
    }, 10000);
    // === end anti-throttle ===

    // CSP on arena.ai blocks page-side fetch to 127.0.0.1. Use Tampermonkey's
    // GM_xmlhttpRequest which runs in the extension context and bypasses CSP.
    const GMX = (typeof GM_xmlhttpRequest !== 'undefined') ? GM_xmlhttpRequest
              : (typeof GM !== 'undefined' && GM.xmlHttpRequest) ? GM.xmlHttpRequest.bind(GM)
              : null;
    function bridgePost(url, body, contentType) {
        if (GMX) {
            try {
                GMX({
                    method: 'POST',
                    url: url,
                    headers: {'Content-Type': contentType || 'text/plain'},
                    data: typeof body === 'string' ? body : JSON.stringify(body),
                    onload: function(){},
                    onerror: function(){},
                });
                return;
            } catch(e){}
        }
        try { fetch(url, {method:'POST', headers:{'Content-Type': contentType || 'text/plain'}, body: typeof body === 'string' ? body : JSON.stringify(body)}).catch(()=>{}); } catch(e){}
    }
    window.__bridgePost = bridgePost;

    const SERVER_URL = "ws://127.0.0.1:5102/ws";
    let socket;
    let isCaptureModeActive = false;
    let is429Lockdown = false;

    // Session Timer Variables
    const SESSION_TIMEOUT_MS = 35 * 60 * 1000; // 35 minutes
    let sessionTimeoutId = null;

    // ============================================
    // Rate Limiting Configuration
    // ============================================

    const RATE_LIMIT = {
        maxRequests: 3,
        windowMs: 6.5 * 60 * 1000,
        enabled: true,
        countdownInterval: 30,
    };

    const COOLDOWN = {
        minIntervalMs: 60 * 1000,
        enabled: true,
        countdownInterval: 10,
    };

    let requestTimestamps = [];
    let lastRequestTime = 0;

    // ============================================
    // Queue Configuration
    // ============================================

    let queueEnabled = false;
    let QUEUE_DELAY_MS = 2 * 60 * 1000;

    let requestQueue = [];
    let isProcessingQueue = false;
    let queueCountdown = 0;

    // ============================================
    // Countdown tracking
    // ============================================
    let activeCountdowns = {
        cooldown: null,
        rateLimit: null,
    };

    // ============================================
    // Captured reCAPTCHA parameters
    // ============================================
    let capturedSiteKey = null;
    let capturedAction = null;

    function uuidv7() {
        const timestamp = Date.now();
        const timestampHex = timestamp.toString(16).padStart(12, '0');
        const rand_a = Math.floor(Math.random() * 4096);
        const rand_b_1 = Math.floor(Math.random() * 16384);
        const rand_b_2 = Math.floor(Math.random() * 65536);
        const rand_b_3 = Math.floor(Math.random() * 65536);
        const rand_b_4 = Math.floor(Math.random() * 65536);

        return (
            timestampHex.substring(0, 8) + '-' +
            timestampHex.substring(8, 12) + '-' +
            '7' + rand_a.toString(16).padStart(3, '0') + '-' +
            ((rand_b_1 & 0x3fff) | 0x8000).toString(16).padStart(4, '0') + '-' +
            (rand_b_2.toString(16).padStart(4, '0') +
             rand_b_3.toString(16).padStart(4, '0') +
             rand_b_4.toString(16).padStart(4, '0'))
        );
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ============================================
    // Helper: System Status Check
    // ============================================
    function isSystemBusy() {
        if (is429Lockdown) return "429 Lockdown Mode";
        if (activeCountdowns.cooldown !== null) return "Active Cooldown";
        if (activeCountdowns.rateLimit !== null) return "Active Rate Limit Window";
        if (isProcessingQueue) return "Queue Processing";
        if (requestQueue.length > 0) return "Queue Not Empty";
        return false;
    }

    // ============================================
    // Session Timer Logic
    // ============================================
    function resetSessionTimer() {
        if (sessionTimeoutId) {
            clearTimeout(sessionTimeoutId);
        }

        sessionTimeoutId = setTimeout(() => {
            const warningMsg = "⚠️ Session idle for 35m. Arena connection likely stale (TypeErrors imminent). Refresh page or send manual message.";
            console.warn(`[API Bridge] ${warningMsg}`);
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({
                    request_id: "system_warning",
                    data: { warning: warningMsg }
                }));
            }
        }, SESSION_TIMEOUT_MS);
    }

    // ============================================
    // Countdown Functions
    // ============================================

    function startCooldownCountdown() {
        if (activeCountdowns.cooldown) {
            clearInterval(activeCountdowns.cooldown);
        }

        const endTime = lastRequestTime + COOLDOWN.minIntervalMs;

        activeCountdowns.cooldown = setInterval(() => {
            const remaining = Math.ceil((endTime - Date.now()) / 1000);

            if (remaining <= 0) {
                console.log("[API Bridge] ⏱️ Cooldown: Ready");
                clearInterval(activeCountdowns.cooldown);
                activeCountdowns.cooldown = null;
            } else if (remaining % COOLDOWN.countdownInterval === 0) {
                console.log(`[API Bridge] ⏱️ Cooldown: ${remaining}s remaining`);
            }
        }, 1000);
    }

    function startRateLimitCountdown() {
        if (activeCountdowns.rateLimit) {
            clearInterval(activeCountdowns.rateLimit);
        }

        activeCountdowns.rateLimit = setInterval(() => {
            cleanupOldTimestamps();

            if (requestTimestamps.length < RATE_LIMIT.maxRequests) {
                console.log(`[API Bridge] 📊 Rate limit: Ready (${requestTimestamps.length}/${RATE_LIMIT.maxRequests} used)`);
                clearInterval(activeCountdowns.rateLimit);
                activeCountdowns.rateLimit = null;
            } else {
                const oldestTimestamp = Math.min(...requestTimestamps);
                const remaining = Math.ceil((oldestTimestamp + RATE_LIMIT.windowMs - Date.now()) / 1000);

                if (remaining > 0 && remaining % RATE_LIMIT.countdownInterval === 0) {
                    console.log(`[API Bridge] 📊 Rate limit: ${remaining}s until slot available (${requestTimestamps.length}/${RATE_LIMIT.maxRequests} used)`);
                }
            }
        }, 1000);
    }

    function stopAllCountdowns() {
        if (activeCountdowns.cooldown) {
            clearInterval(activeCountdowns.cooldown);
            activeCountdowns.cooldown = null;
        }
        if (activeCountdowns.rateLimit) {
            clearInterval(activeCountdowns.rateLimit);
            activeCountdowns.rateLimit = null;
        }
    }

    // ============================================
    // Window-based Rate Limiting Functions
    // ============================================

    function cleanupOldTimestamps() {
        const now = Date.now();
        const cutoff = now - RATE_LIMIT.windowMs;
        requestTimestamps = requestTimestamps.filter(ts => ts > cutoff);
    }

    function canMakeRequestWindow() {
        if (!RATE_LIMIT.enabled) return true;
        cleanupOldTimestamps();
        return requestTimestamps.length < RATE_LIMIT.maxRequests;
    }

    function getTimeUntilNextSlot() {
        if (!RATE_LIMIT.enabled) return 0;
        cleanupOldTimestamps();

        if (requestTimestamps.length < RATE_LIMIT.maxRequests) {
            return 0;
        }

        const oldestTimestamp = Math.min(...requestTimestamps);
        const timeUntilFree = (oldestTimestamp + RATE_LIMIT.windowMs) - Date.now();

        return Math.max(0, timeUntilFree);
    }

    function getWindowRateLimitStatus() {
        cleanupOldTimestamps();
        const remaining = RATE_LIMIT.maxRequests - requestTimestamps.length;
        const waitTime = getTimeUntilNextSlot();

        return {
            enabled: RATE_LIMIT.enabled,
            used: requestTimestamps.length,
            max: RATE_LIMIT.maxRequests,
            remaining: remaining,
            waitTimeMs: waitTime,
            waitTimeSec: Math.ceil(waitTime / 1000),
        };
    }

    // ============================================
    // Cooldown Rate Limiting Functions
    // ============================================

    function canMakeRequestCooldown() {
        if (!COOLDOWN.enabled) return true;
        const now = Date.now();
        const timeSinceLastRequest = now - lastRequestTime;
        return timeSinceLastRequest >= COOLDOWN.minIntervalMs;
    }

    function getCooldownRemaining() {
        if (!COOLDOWN.enabled) return 0;
        const now = Date.now();
        const timeSinceLastRequest = now - lastRequestTime;
        const remaining = COOLDOWN.minIntervalMs - timeSinceLastRequest;
        return Math.max(0, remaining);
    }

    function getCooldownStatus() {
        const remainingMs = getCooldownRemaining();
        return {
            enabled: COOLDOWN.enabled,
            ready: remainingMs === 0,
            remainingMs: remainingMs,
            remainingSec: Math.ceil(remainingMs / 1000),
            intervalMs: COOLDOWN.minIntervalMs,
            intervalSec: COOLDOWN.minIntervalMs / 1000,
        };
    }

    // ============================================
    // Combined Rate Limit Check
    // ============================================

    function checkRateLimits() {
        if (!canMakeRequestCooldown()) {
            const cooldownStatus = getCooldownStatus();
            return {
                allowed: false,
                reason: 'cooldown',
                waitTimeSec: cooldownStatus.remainingSec,
                waitTimeMs: cooldownStatus.remainingMs,
            };
        }

        if (!canMakeRequestWindow()) {
            const windowStatus = getWindowRateLimitStatus();
            return {
                allowed: false,
                reason: 'window',
                waitTimeSec: windowStatus.waitTimeSec,
                waitTimeMs: windowStatus.waitTimeMs,
                windowStatus: windowStatus,
            };
        }

        return { allowed: true };
    }

    function recordRequest() {
        const now = Date.now();

        if (COOLDOWN.enabled) {
            lastRequestTime = now;
            startCooldownCountdown();
        }

        if (RATE_LIMIT.enabled) {
            cleanupOldTimestamps();
            requestTimestamps.push(now);
            console.log(`[API Bridge] 📊 Rate limit: ${requestTimestamps.length}/${RATE_LIMIT.maxRequests} in window`);
            if (requestTimestamps.length >= RATE_LIMIT.maxRequests) {
                startRateLimitCountdown();
            }
        }
    }

    function rollbackRateLimit() {
        if (RATE_LIMIT.enabled && requestTimestamps.length > 0) {
            requestTimestamps.pop();
            console.log("[API Bridge] ↩️ Error detected: Rate limit count rolled back (Window limit restored, Cooldown remains)");
        }
    }

    // ============================================
    // 429 LOCKDOWN / AUTO-PROTECTION
    // ============================================
    function triggerAutoProtection() {
        if (is429Lockdown) return;

        is429Lockdown = true;
        console.warn("[API Bridge] 🚨 429 DETECTED! Engaging Lockdown Protection Protocols!");
        console.warn("[API Bridge] 🛡️ Queue, Window Limit, and Cooldown are now LOCKED to ON.");

        // Add 30 minute penalty to the window
        RATE_LIMIT.windowMs += (30 * 60 * 1000);
        console.warn(`[API Bridge] 📉 Penalty: Rate limit window increased by 2 minutes (New: ${RATE_LIMIT.windowMs / 1000}s).`);

        window.enableAllLimits();

        // Force fill the rate limit bucket
        const now = Date.now();
        lastRequestTime = now;
        requestTimestamps = new Array(RATE_LIMIT.maxRequests).fill(now);

        startCooldownCountdown();
        startRateLimitCountdown();

        engageLockdownShield();

        // Schedule Release of Lockdown (Unlock UI/Refresh) when rate limit window expires
        console.log(`[API Bridge] ⏳ Lockdown will auto-release in ${RATE_LIMIT.windowMs / 1000} seconds.`);
        setTimeout(releaseLockdown, RATE_LIMIT.windowMs);
    }

    // Prevent Unload Handler
    const preventUnloadHandler = function (e) {
        if (is429Lockdown) {
            e.preventDefault();
            e.returnValue = 'System is in 429 Lockdown. Refreshing now resets protection timers and risks longer bans.';
            return e.returnValue;
        }
    };

    function engageLockdownShield() {
        // Add event listener
        window.addEventListener('beforeunload', preventUnloadHandler);

        // Visual warning overlay
        const overlay = document.createElement('div');
        overlay.id = 'lmarena-lockdown-overlay';
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(20, 0, 0, 0.9); color: #ff4444; z-index: 2147483647;
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            font-family: monospace; text-align: center; pointer-events: none;
            backdrop-filter: blur(5px);
        `;
        overlay.innerHTML = `
            <h1 style="font-size: 48px; margin-bottom: 20px;">🚫 429 LOCKDOWN ACTIVE 🚫</h1>
            <h2 style="color: white; margin-bottom: 40px;">DO NOT REFRESH THE PAGE YOU FILTHY LOCUST~</h2>
            <div style="background: rgba(0,0,0,0.5); padding: 20px; border: 1px solid #ff4444; border-radius: 8px;">
                <p style="font-size: 18px; color: #ffcccc; margin: 5px;">Total Locust Death</p>
                <p style="font-size: 18px; color: #ffcccc; margin: 5px;">Kill locusts. Behead locusts. Roundhouse kick a locust into the concrete. Slam dunk a locust baby into the trashcan. Crucify filthy locusts. Defecate in a locusts food. Launch locusts into the sun. Stir fry locusts in a wok. Toss locusts into active volcanoes. Urinate into a locusts gas tank. Judo throw locusts into a wood chipper. Twist locusts heads off. Report locusts to the IRS. Karate chop locusts in half. Curb stomp pregnant black locusts. Trap locusts in quicksand. Crush locusts in the trash compactor. Liquefy locusts in a vat of acid. Eat locusts. Dissect locusts. Exterminate locusts in the gas chamber. Stomp locust skulls with steel toed boots. Cremate locusts in the oven. Lobotomize locusts. Mandatory abortions for locusts. Grind locust fetuses in the garbage disposal. Drown locusts in fried chicken grease. Vaporize locusts with a ray gun. Kick old locusts down the stairs. Feed locusts to alligators. Slice locusts with a katana.</p>
            </div>
        `;
        document.body.appendChild(overlay);
    }

    function releaseLockdown() {
        if (!is429Lockdown) return;

        is429Lockdown = false;
        console.log("[API Bridge] 🔓 429 Lockdown Lifted! Controls unlocked.");

        // Remove overlay
        const overlay = document.getElementById('lmarena-lockdown-overlay');
        if (overlay) {
            overlay.remove();
        }

        // Remove unload prevention
        window.removeEventListener('beforeunload', preventUnloadHandler);
    }

    // ============================================
    // Queue Functions
    // ============================================

    function getEstimatedWaitTime(position) {
        const baseWait = position * (QUEUE_DELAY_MS / 1000);
        return baseWait + queueCountdown;
    }

    function addToQueue(requestId, payload) {
        const queueItem = {
            requestId: requestId,
            payload: payload,
            addedAt: Date.now(),
        };

        requestQueue.push(queueItem);

        const position = requestQueue.length;
        const estimatedWaitSec = getEstimatedWaitTime(position);

        console.log(`[API Bridge] 📥 Added to queue. Position: ${position}, Est. wait: ${estimatedWaitSec}s`);

        sendToServer(requestId, `QUEUED:${estimatedWaitSec}:${position}`);

        if (!isProcessingQueue) {
            startQueueProcessor();
        }
    }

    async function startQueueProcessor() {
        if (isProcessingQueue) {
            return;
        }

        isProcessingQueue = true;
        console.log("[API Bridge] 🚀 Queue processor started");

        while (requestQueue.length > 0) {
            // STEP 1: Check rate limits FIRST
            const rateLimitCheck = checkRateLimits();

            if (!rateLimitCheck.allowed) {
                const failedItem = requestQueue.shift();
                console.warn(`[API Bridge] ⚠️ Queue blocked by ${rateLimitCheck.reason}. Rejecting request ${failedItem.requestId.substring(0,8)}.`);

                if (rateLimitCheck.reason === 'cooldown') {
                    sendToServer(failedItem.requestId, { error: `SLOW_DOWN:${rateLimitCheck.waitTimeSec}` });
                } else {
                    sendToServer(failedItem.requestId, { error: `RATE_LIMIT_EXCEEDED:${rateLimitCheck.waitTimeSec}` });
                }
                sendToServer(failedItem.requestId, "[DONE]");

                continue;
            }

            // STEP 2: Wait the queue delay
            if (QUEUE_DELAY_MS > 0) {
                console.log(`[API Bridge] ⏳ Queue: Waiting ${QUEUE_DELAY_MS / 1000}s...`);
                queueCountdown = Math.ceil(QUEUE_DELAY_MS / 1000);

                while (queueCountdown > 0) {
                    await sleep(1000);
                    queueCountdown--;

                    if (queueCountdown > 0 && queueCountdown % 30 === 0) {
                        console.log(`[API Bridge] ⏳ Queue: ${queueCountdown}s remaining...`);
                        requestQueue.forEach((item, index) => {
                            const estimatedWaitSec = getEstimatedWaitTime(index + 1);
                            sendToServer(item.requestId, `QUEUED:${estimatedWaitSec}:${index + 1}`);
                        });
                    }
                }
            }

            if (requestQueue.length === 0) {
                break;
            }

            // STEP 3: Process
            const item = requestQueue.shift();
            if (!item) break;

            console.log(`[API Bridge] 🚀 Processing queued request ${item.requestId.substring(0, 8)} (${requestQueue.length} remaining)`);
            sendToServer(item.requestId, `PROCESSING:0`);

            await handleRequest(item.requestId, item.payload);
        }

        isProcessingQueue = false;
        queueCountdown = 0;
        console.log("[API Bridge] ✅ Queue processor finished");
    }

    // ============================================
    // Console Commands
    // ============================================

    window.help = function() {
        const queueState = queueEnabled ? 'ON ' : 'OFF';
        const rateLimitState = RATE_LIMIT.enabled ? 'ON ' : 'OFF';
        const cooldownState = COOLDOWN.enabled ? 'ON ' : 'OFF';
        const lockdownStatus = is429Lockdown ? '🔒 LOCKED (429 HIT)' : '🔓 Unlocked';
        const busyStatus = isSystemBusy() ? `⚠️ BUSY: ${isSystemBusy()}` : '✅ IDLE';

        console.log("╔══════════════════════════════════════════════════════════════╗");
        console.log("║           Arena API Bridge v3.2.7 - Help                     ║");
        console.log("╠══════════════════════════════════════════════════════════════╣");
        console.log("║                                                              ║");
        console.log(`║  STATUS: ${lockdownStatus} | ${busyStatus}${' '.repeat(Math.max(0, 35 - lockdownStatus.length - busyStatus.length))}║`);
        console.log("║                                                              ║");
        console.log("║  CURRENT SETTINGS:                                           ║");
        console.log(`║    📊 Rate Limit: ${RATE_LIMIT.maxRequests} req / ${(RATE_LIMIT.windowMs / 1000 / 60).toFixed(1)} min [${rateLimitState}]                    ║`);
        console.log(`║    ⏱️  Cooldown:   ${COOLDOWN.minIntervalMs / 1000}s between requests [${cooldownState}]                ║`);
        console.log(`║    📥 Queue:      ${queueState} (${QUEUE_DELAY_MS / 1000}s delay)                            ║`);
        console.log("║                                                              ║");
        console.log("╠══════════════════════════════════════════════════════════════╣");
        console.log("║  ADJUSTMENT COMMANDS (Locked when Busy/429):                 ║");
        console.log("║    setQueueDelay(sec)  - Set delay between queued items      ║");
        console.log("║    setCooldown(sec)    - Set cooldown between requests       ║");
        console.log("║    setRateLimit(req, sec) - Set window limit (e.g. 3, 200)   ║");
        console.log("║                                                              ║");
        console.log("╠══════════════════════════════════════════════════════════════╣");
        console.log("║  QUEUE COMMANDS:                                             ║");
        console.log("║    enableQueue()     - Turn queue ON                         ║");
        console.log("║    disableQueue()    - Turn queue OFF                        ║");
        console.log("║    toggleQueue()     - Toggle queue state                    ║");
        console.log("║    queueStatus()     - View queue details                    ║");
        console.log("║    clearQueue()      - Clear all queued requests             ║");
        console.log("║                                                              ║");
        console.log("╠══════════════════════════════════════════════════════════════╣");
        console.log("║  RATE LIMIT COMMANDS:                                        ║");
        console.log("║    enableRateLimit()  - Turn window rate limit ON            ║");
        console.log("║    disableRateLimit() - Turn window rate limit OFF           ║");
        console.log("║    enableCooldown()   - Turn cooldown ON                     ║");
        console.log("║    disableCooldown()  - Turn cooldown OFF                    ║");
        console.log("║    disableAllLimits() - Disable ALL (incl. queue) ⚠️         ║");
        console.log("║    enableAllLimits()  - Enable ALL (incl. queue)             ║");
        console.log("║                                                              ║");
        console.log("╠══════════════════════════════════════════════════════════════╣");
        console.log("║  STATUS COMMANDS:                                            ║");
        console.log("║    rateLimitStatus()  - View rate limit status               ║");
        console.log("║    debugRecaptcha()   - Debug reCAPTCHA state                ║");
        console.log("║                                                              ║");
        console.log("╚══════════════════════════════════════════════════════════════╝");

        return "Type any command above to execute it.";
    };

    // Adjustment Commands
    window.setQueueDelay = function(seconds) {
        const busyReason = isSystemBusy();
        if (busyReason) { console.error(`⛔ Cannot adjust settings: System is ${busyReason}. Wait for idle.`); return; }
        if (!seconds || seconds <= 0) { console.error("❌ Value cannot be 0 or negative. Use disableQueue() instead."); return; }
        QUEUE_DELAY_MS = seconds * 1000;
        console.log(`[API Bridge] ✅ Queue delay set to ${seconds}s`);
    };

    window.setCooldown = function(seconds) {
        const busyReason = isSystemBusy();
        if (busyReason) { console.error(`⛔ Cannot adjust settings: System is ${busyReason}. Wait for idle.`); return; }
        if (!seconds || seconds <= 0) { console.error("❌ Value cannot be 0 or negative. Use disableCooldown() instead."); return; }
        COOLDOWN.minIntervalMs = seconds * 1000;
        console.log(`[API Bridge] ✅ Cooldown set to ${seconds}s`);
    };

    window.setRateLimit = function(requests, seconds) {
        const busyReason = isSystemBusy();
        if (busyReason) { console.error(`⛔ Cannot adjust settings: System is ${busyReason}. Wait for idle.`); return; }
        if (!requests || requests <= 0 || !seconds || seconds <= 0) { console.error("❌ Values cannot be 0 or negative. Use disableRateLimit() instead."); return; }
        RATE_LIMIT.maxRequests = requests;
        RATE_LIMIT.windowMs = seconds * 1000;
        console.log(`[API Bridge] ✅ Rate limit set to ${requests} requests per ${seconds}s`);
    };

    // Queue commands
    window.enableQueue = function() {
        queueEnabled = true;
        console.log("[API Bridge] ✅ Queue ENABLED");
        console.log(`[API Bridge]    All requests will be queued with ${QUEUE_DELAY_MS / 1000}s delay`);
        return { enabled: true };
    };

    window.disableQueue = function() {
        if (is429Lockdown) { console.error("⛔ Action blocked: System is in 429 Lockdown. Refresh to reset."); return; }
        queueEnabled = false;
        console.log("[API Bridge] ❌ Queue DISABLED");
        return { enabled: false };
    };

    window.toggleQueue = function() {
        if (queueEnabled) {
            return window.disableQueue();
        } else {
            return window.enableQueue();
        }
    };

    window.queueStatus = function() {
        console.log("=== Queue Status ===");
        console.log(`Enabled: ${queueEnabled}`);
        console.log(`Queue length: ${requestQueue.length}`);
        console.log(`Processing: ${isProcessingQueue}`);
        console.log(`Delay between requests: ${QUEUE_DELAY_MS / 1000}s`);
        if (queueCountdown > 0) {
            console.log(`Next request in: ${queueCountdown}s`);
        }

        if (requestQueue.length > 0) {
            console.log("\nQueued requests:");
            requestQueue.forEach((item, index) => {
                const waitTime = getEstimatedWaitTime(index + 1);
                console.log(`  ${index + 1}. ${item.requestId.substring(0, 8)}... (est. ${waitTime}s)`);
            });
        }

        return {
            enabled: queueEnabled,
            length: requestQueue.length,
            processing: isProcessingQueue,
            delayMs: QUEUE_DELAY_MS,
            countdown: queueCountdown,
        };
    };

    window.clearQueue = function() {
        const count = requestQueue.length;

        requestQueue.forEach(item => {
            sendToServer(item.requestId, { error: "QUEUE_CLEARED" });
            sendToServer(item.requestId, "[DONE]");
        });

        requestQueue = [];
        console.log(`[API Bridge] 🗑️ Cleared ${count} items from queue`);

        return { cleared: count };
    };

    // Rate limit commands
    window.enableRateLimit = function() {
        RATE_LIMIT.enabled = true;
        console.log("[API Bridge] ✅ Window rate limit ENABLED");
        return { enabled: true };
    };

    window.disableRateLimit = function() {
        if (is429Lockdown) { console.error("⛔ Action blocked: System is in 429 Lockdown. Refresh to reset."); return; }
        RATE_LIMIT.enabled = false;
        if (activeCountdowns.rateLimit) {
            clearInterval(activeCountdowns.rateLimit);
            activeCountdowns.rateLimit = null;
        }
        console.log("[API Bridge] ⚠️  Window rate limit DISABLED");
        return { enabled: false };
    };

    window.enableCooldown = function() {
        COOLDOWN.enabled = true;
        console.log("[API Bridge] ✅ Cooldown ENABLED");
        return { enabled: true };
    };

    window.disableCooldown = function() {
        if (is429Lockdown) { console.error("⛔ Action blocked: System is in 429 Lockdown. Refresh to reset."); return; }
        COOLDOWN.enabled = false;
        if (activeCountdowns.cooldown) {
            clearInterval(activeCountdowns.cooldown);
            activeCountdowns.cooldown = null;
        }
        console.log("[API Bridge] ⚠️  Cooldown DISABLED");
        return { enabled: false };
    };

    window.disableAllLimits = function() {
        if (is429Lockdown) { console.error("⛔ Action blocked: System is in 429 Lockdown. Refresh to reset."); return; }
        RATE_LIMIT.enabled = false;
        COOLDOWN.enabled = false;
        queueEnabled = false;
        stopAllCountdowns();

        console.log("[API Bridge] ⚠️⚠️⚠️ ALL LIMITS DISABLED ⚠️⚠️⚠️");
        return { rateLimitEnabled: false, cooldownEnabled: false, queueEnabled: false };
    };

    window.enableAllLimits = function() {
        RATE_LIMIT.enabled = true;
        COOLDOWN.enabled = true;
        queueEnabled = true;

        console.log("[API Bridge] ✅ ALL LIMITS ENABLED");
        return { rateLimitEnabled: true, cooldownEnabled: true, queueEnabled: true };
    };

    window.rateLimitStatus = function() {
        const windowStatus = getWindowRateLimitStatus();
        const cooldownStatus = getCooldownStatus();

        console.log("=== Rate Limit Status ===");
        if (is429Lockdown) console.log("🔒 SYSTEM LOCKED DOWN (429 Hit)");
        console.log("");
        console.log("Window limit:");
        console.log(`  Enabled: ${RATE_LIMIT.enabled ? '✅ ON' : '❌ OFF'}`);
        if (RATE_LIMIT.enabled) {
            console.log(`  Requests in window: ${windowStatus.used}/${windowStatus.max}`);
            console.log(`  Remaining: ${windowStatus.remaining}`);
            if (windowStatus.waitTimeMs > 0) {
                console.log(`  Next slot in: ${windowStatus.waitTimeSec}s`);
            } else {
                console.log(`  Window: Ready`);
            }
            console.log(`  Window duration: ${RATE_LIMIT.windowMs / 1000}s`);
        }
        console.log("");
        console.log("Cooldown limit:");
        console.log(`  Enabled: ${COOLDOWN.enabled ? '✅ ON' : '❌ OFF'}`);
        if (COOLDOWN.enabled) {
            console.log(`  Min interval: ${COOLDOWN.minIntervalMs / 1000}s`);
            if (cooldownStatus.ready) {
                console.log(`  Cooldown: Ready`);
            } else {
                console.log(`  Cooldown remaining: ${cooldownStatus.remainingSec}s`);
            }
        }
        console.log("");
        console.log("Queue:");
        console.log(`  Enabled: ${queueEnabled ? '✅ ON' : '❌ OFF'}`);
        console.log(`  Items in queue: ${requestQueue.length}`);
        if (queueCountdown > 0) {
            console.log(`  Next processing in: ${queueCountdown}s`);
        }
        console.log("");

        const check = checkRateLimits();
        console.log(`Overall: ${check.allowed ? '✅ Ready' : '❌ Wait ' + check.waitTimeSec + 's (' + check.reason + ')'}`);

        return { windowStatus, cooldownStatus, check, queue: { enabled: queueEnabled, length: requestQueue.length } };
    };

    // ============================================
    // Hook grecaptcha.execute
    // ============================================
    function hookGrecaptcha() {
        const tryHook = () => {
            const captcha = window.grecaptcha?.enterprise || window.grecaptcha;

            if (!captcha || !captcha.execute) {
                return false;
            }

            if (captcha._hooked) {
                return true;
            }

            const originalExecute = captcha.execute.bind(captcha);

            captcha.execute = function(siteKey, options) {
                console.log("[API Bridge] 🔍 Intercepted grecaptcha.execute:");
                console.log("[API Bridge]    Site Key:", siteKey);
                console.log("[API Bridge]    Options:", JSON.stringify(options));

                if (siteKey && typeof siteKey === 'string' && siteKey.length > 10) {
                    capturedSiteKey = siteKey;
                    if (options && options.action) {
                        capturedAction = options.action;
                    }
                    console.log("[API Bridge] ✅ Captured reCAPTCHA params - Key:", siteKey.substring(0, 10) + "..., Action:", capturedAction);
                }

                return originalExecute(siteKey, options);
            };

            captcha._hooked = true;
            console.log("[API Bridge] ✅ Successfully hooked grecaptcha.execute");
            return true;
        };

        if (tryHook()) return;

        let attempts = 0;
        const interval = setInterval(() => {
            attempts++;
            if (tryHook() || attempts > 30) {
                clearInterval(interval);
                if (attempts > 30) {
                    console.warn("[API Bridge] ⚠️ Could not hook grecaptcha after 30 attempts");
                }
            }
        }, 1000);
    }

    hookGrecaptcha();

    // ============================================
    // Hook XMLHttpRequest — arena.ai may use XHR instead of fetch
    // ============================================
    (function hookXHR() {
        const origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
            try {
                const u = String(url || '');
                if (u && isCaptureModeActive && !u.includes('127.0.0.1')) {
                    bridgePost('http://127.0.0.1:5102/debug/log', 'xhr ' + method + ' ' + u.substring(0, 400), 'text/plain');
                }
                // Try to capture session/message IDs from XHR url too
                if (isCaptureModeActive && !window.isApiBridgeRequest) {
                    let m = u.match(/\/nextjs-api\/stream\/retry-evaluation-session-message\/([a-f0-9-]{36})\/messages\/([a-f0-9-]{36})/);
                    if (!m) m = u.match(/\/evaluation[s]?\/([a-f0-9-]{36})\/messages\/([a-f0-9-]{36})/);
                    if (!m) m = u.match(/\/([a-f0-9-]{36})\/messages\/([a-f0-9-]{36})/);
                    if (m) {
                        console.log('[API Bridge] 🎯 XHR captured IDs:', m[1], m[2]);
                        isCaptureModeActive = false;
                        bridgePost('http://127.0.0.1:5102/update', JSON.stringify({sessionId: m[1], messageId: m[2]}), 'application/json');
                    }
                }
            } catch(e){}
            return origOpen.call(this, method, url, ...rest);
        };
    })();

    // ============================================
    // Find reCAPTCHA site key
    // ============================================
    function findRecaptchaSiteKey() {
        if (capturedSiteKey) {
            console.log("[API Bridge] Using captured site key");
            return capturedSiteKey;
        }

        if (window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients) {
            console.log("[API Bridge] Checking ___grecaptcha_cfg.clients...");
            for (const [clientId, client] of Object.entries(window.___grecaptcha_cfg.clients)) {
                console.log("[API Bridge]   Client", clientId, ":", typeof client);
                if (client && typeof client === 'object') {
                    const findKey = (obj, path = '', depth = 0) => {
                        if (!obj || typeof obj !== 'object' || depth > 15) return null;

                        for (const keyName of ['sitekey', 'siteKey', 'key', 'k']) {
                            if (obj[keyName] && typeof obj[keyName] === 'string' && obj[keyName].length > 20) {
                                console.log(`[API Bridge]   Found key at ${path}.${keyName}`);
                                return obj[keyName];
                            }
                        }

                        for (const [k, val] of Object.entries(obj)) {
                            if (typeof val === 'object') {
                                const found = findKey(val, `${path}.${k}`, depth + 1);
                                if (found) return found;
                            }
                        }
                        return null;
                    };
                    const key = findKey(client, `clients.${clientId}`);
                    if (key) return key;
                }
            }
        }

        const scripts = document.querySelectorAll('script[src*="recaptcha"]');
        console.log("[API Bridge] Found", scripts.length, "recaptcha scripts");
        for (const script of scripts) {
            console.log("[API Bridge]   Script src:", script.src);
            const match = script.src.match(/render=([A-Za-z0-9_-]+)/);
            if (match && match[1] !== 'explicit' && match[1].length > 20) {
                console.log("[API Bridge]   Found key in script:", match[1]);
                return match[1];
            }
        }

        const element = document.querySelector('[data-sitekey]');
        if (element) {
            console.log("[API Bridge] Found data-sitekey:", element.getAttribute('data-sitekey'));
            return element.getAttribute('data-sitekey');
        }

        console.warn("[API Bridge] ❌ Could not find reCAPTCHA site key");
        return null;
    }

    // ============================================
    // Get fresh reCAPTCHA token
    // ============================================
    async function ensureGrecaptchaLoaded(siteKey) {
        if (window.grecaptcha?.enterprise?.execute || window.grecaptcha?.execute) return true;
        const candidates = [
            'https://www.google.com/recaptcha/enterprise.js?render=' + encodeURIComponent(siteKey),
            'https://www.google.com/recaptcha/api.js?render=' + encodeURIComponent(siteKey),
        ];
        for (const url of candidates) {
            try {
                // Prefer GM_addElement — runs in extension context, bypasses page CSP
                if (typeof GM_addElement === 'function') {
                    GM_addElement('script', { src: url });
                } else {
                    const s = document.createElement('script');
                    s.src = url;
                    document.head.appendChild(s);
                }
                // wait up to 10s
                for (let i = 0; i < 100; i++) {
                    if (window.grecaptcha?.enterprise?.execute || window.grecaptcha?.execute) return true;
                    await new Promise(r => setTimeout(r, 100));
                }
            } catch(e){}
        }
        return !!(window.grecaptcha?.enterprise?.execute || window.grecaptcha?.execute);
    }

    async function getFreshRecaptchaToken() {
        return new Promise((resolve) => {
            const captcha = window.grecaptcha?.enterprise || window.grecaptcha;

            console.log("[API Bridge] grecaptcha available:", !!captcha);
            console.log("[API Bridge] grecaptcha.enterprise:", !!window.grecaptcha?.enterprise);

            if (typeof captcha === 'undefined' || !captcha.execute) {
                console.warn("[API Bridge] grecaptcha not available, using cached token");
                resolve(window.recaptchaToken || "");
                return;
            }

            const siteKey = findRecaptchaSiteKey();
            const action = capturedAction || 'submit';

            console.log("[API Bridge] Using site key:", siteKey ? siteKey.substring(0, 15) + "..." : "null");
            console.log("[API Bridge] Using action:", action);

            if (!siteKey) {
                console.warn("[API Bridge] No site key, using cached token");
                resolve(window.recaptchaToken || "");
                return;
            }

            const timeoutId = setTimeout(() => {
                console.warn("[API Bridge] reCAPTCHA timeout after 10s");
                resolve(window.recaptchaToken || "");
            }, 10000);

            try {
                captcha.ready(function() {
                    console.log("[API Bridge] grecaptcha is ready, executing...");
                    captcha.execute(siteKey, { action: action })
                        .then(function(token) {
                            clearTimeout(timeoutId);
                            console.log("[API Bridge] ✅ Got fresh token:", token.substring(0, 20) + "...");
                            window.recaptchaToken = token;
                            resolve(token);
                        })
                        .catch(function(error) {
                            clearTimeout(timeoutId);
                            console.error("[API Bridge] ❌ grecaptcha.execute error:", error);
                            resolve(window.recaptchaToken || "");
                        });
                });
            } catch (error) {
                clearTimeout(timeoutId);
                console.error("[API Bridge] ❌ grecaptcha.ready error:", error);
                resolve(window.recaptchaToken || "");
            }
        });
    }

    window.debugRecaptcha = async function() {
        console.log("=== reCAPTCHA Debug Info ===");
        console.log("grecaptcha:", typeof window.grecaptcha);
        console.log("grecaptcha.enterprise:", typeof window.grecaptcha?.enterprise);
        console.log("___grecaptcha_cfg:", window.___grecaptcha_cfg);
        console.log("Captured site key:", capturedSiteKey);
        console.log("Captured action:", capturedAction);
        console.log("Cached token:", window.recaptchaToken ? window.recaptchaToken.substring(0, 30) + "..." : "none");

        const foundKey = findRecaptchaSiteKey();
        console.log("Found site key:", foundKey);

        console.log("\nAttempting to get fresh token...");
        const token = await getFreshRecaptchaToken();
        console.log("Result:", token ? token.substring(0, 30) + "..." : "FAILED");

        return { capturedSiteKey, capturedAction, foundKey, token };
    };

    // ============================================
    // WebSocket Connection
    // ============================================
    function connect() {
        console.log(`[API Bridge] Connecting to ${SERVER_URL}...`);
        socket = new WebSocket(SERVER_URL);

        socket.onopen = () => {
            console.log("[API Bridge] ✅ WebSocket connection established.");
            document.title = "✅ " + document.title;
            resetSessionTimer();
            bridgePost('http://127.0.0.1:5102/debug/log', 'ALIVE main page: ' + location.href + ' UA=' + navigator.userAgent.substring(0,80), 'text/plain');
        };

        socket.onmessage = async (event) => {
            try {
                const message = JSON.parse(event.data);

                if (message.command) {
                    console.log(`[API Bridge] ⬇️ Received command: ${message.command}`);

                    if (message.command === 'refresh' || message.command === 'reconnect') {
                        if (is429Lockdown) {
                            console.warn("[API Bridge] ⛔ Refresh blocked: System is in 429 Lockdown. Refresh page manually to reset if needed.");
                            return;
                        }
                        console.log(`[API Bridge] Received '${message.command}' command, refreshing page...`);
                        location.reload();
                    } else if (message.command === 'activate_id_capture') {
                        console.log("[API Bridge] ✅ ID capture mode activated. Please trigger a 'Retry' action on the page.");
                        isCaptureModeActive = true;
                        document.title = "🎯 " + document.title;
                    } else if (message.command === 'spawn_battle') {
                        const modelAId = message.modelAId;
                        const modelBId = message.modelBId;
                        if (!modelAId || !modelBId) {
                            bridgePost('http://127.0.0.1:5102/debug/log', 'SPAWN_BATTLE missing modelIds', 'text/plain');
                            return;
                        }
                        try {
                            const sessionId = uuidv7();
                            const userMsgId = uuidv7();
                            const modelAMsgId = uuidv7();
                            const modelBMsgId = uuidv7();
                            // Try to get a usable recaptcha v3 token; log every step
                            let recaptchaV3 = '';
                            // Aggressive search for sitekey
                            let foundKey = capturedSiteKey;
                            const hasGR = !!(window.grecaptcha?.enterprise || window.grecaptcha);
                            const hasCfg = !!window.___grecaptcha_cfg;
                            const scriptCount = document.querySelectorAll('script[src*="recaptcha"]').length;
                            try { if (!foundKey) foundKey = findRecaptchaSiteKey(); } catch(e){}
                            bridgePost('http://127.0.0.1:5102/debug/log', 'SPAWN_BATTLE rcap_diag gr='+hasGR+' cfg='+hasCfg+' scripts='+scriptCount+' site='+(foundKey||'NONE').substring(0,15)+' act='+(capturedAction||'NONE'), 'text/plain');
                            // Ensure grecaptcha is actually loaded (arena lazy-loads it)
                            if (foundKey) {
                                const loaded = await ensureGrecaptchaLoaded(foundKey);
                                bridgePost('http://127.0.0.1:5102/debug/log', 'SPAWN_BATTLE grecaptcha_loaded='+loaded, 'text/plain');
                            }
                            try { recaptchaV3 = await getFreshRecaptchaToken(); } catch(e){}
                            bridgePost('http://127.0.0.1:5102/debug/log', 'SPAWN_BATTLE rcap_got len='+(recaptchaV3||'').length+' first20='+(recaptchaV3||'').substring(0,20), 'text/plain');
                            // If captured token is fresh from real arena UI use, prefer it
                            if (!recaptchaV3 && window.recaptchaToken) {
                                recaptchaV3 = window.recaptchaToken;
                                bridgePost('http://127.0.0.1:5102/debug/log', 'SPAWN_BATTLE rcap_using_cached len='+recaptchaV3.length, 'text/plain');
                            }
                            const battleBody = {
                                id: sessionId,
                                mode: "battle",
                                modality: "chat",
                                modelAId, modelBId,
                                userMessageId: userMsgId,
                                modelAMessageId: modelAMsgId,
                                modelBMessageId: modelBMsgId,
                                userMessage: { content: "hi", experimental_attachments: [], metadata: {} },
                                recaptchaV3Token: recaptchaV3,
                                messages: [],
                            };
                            bridgePost('http://127.0.0.1:5102/debug/log', 'SPAWN_BATTLE start sid='+sessionId.substring(0,8), 'text/plain');
                            window.isApiBridgeRequest = true;
                            const r1 = await fetch('/nextjs-api/stream/create-evaluation', {
                                method: 'POST',
                                headers: {'Content-Type':'text/plain;charset=UTF-8', 'Accept':'*/*'},
                                body: JSON.stringify(battleBody),
                                credentials: 'include',
                            });
                            window.isApiBridgeRequest = false;
                            bridgePost('http://127.0.0.1:5102/debug/log', 'SPAWN_BATTLE create=' + r1.status, 'text/plain');
                            if (!r1.ok) {
                                const t = await r1.text();
                                bridgePost('http://127.0.0.1:5102/debug/log', 'SPAWN_BATTLE create_err=' + t.substring(0,200), 'text/plain');
                                return;
                            }
                            // Drain stream so arena registers it completed
                            try {
                                const rd = r1.body.getReader();
                                while (true) {
                                    const { value, done } = await rd.read();
                                    if (done) break;
                                }
                            } catch(e){}
                            // Skip to direct with modelA
                            const newModelAMsgId = uuidv7();
                            const r2 = await fetch('/nextjs-api/stream/skip-direct-battle/' + sessionId, {
                                method: 'POST',
                                headers: {'Content-Type':'application/json'},
                                body: JSON.stringify({
                                    messageAId: modelAMsgId,
                                    messageBId: modelBMsgId,
                                    modelAMessageId: newModelAMsgId,
                                }),
                                credentials: 'include',
                            });
                            bridgePost('http://127.0.0.1:5102/debug/log', 'SPAWN_BATTLE skip=' + r2.status, 'text/plain');
                            if (r2.ok) {
                                bridgePost('http://127.0.0.1:5102/update', JSON.stringify({sessionId, messageId: userMsgId, modelName: message.modelName}), 'application/json');
                                bridgePost('http://127.0.0.1:5102/debug/log', 'SPAWN_BATTLE done captured sid='+sessionId.substring(0,8), 'text/plain');
                            } else {
                                const t = await r2.text();
                                bridgePost('http://127.0.0.1:5102/debug/log', 'SPAWN_BATTLE skip_err=' + t.substring(0,200), 'text/plain');
                            }
                        } catch(e) {
                            bridgePost('http://127.0.0.1:5102/debug/log', 'SPAWN_BATTLE error='+(e.message||e), 'text/plain');
                        }
                        return;
                    } else if (message.command === 'rotate_anon') {
                        console.log("[API Bridge] 🔄 Anonymous rotation requested");
                        bridgePost('http://127.0.0.1:5102/debug/log', 'ROTATE_ANON start', 'text/plain');
                        try {
                            // 1. Inspect current cookies for tracking
                            const before = document.cookie.split(';').map(c => c.trim().split('=')[0]).join(',');
                            bridgePost('http://127.0.0.1:5102/debug/log', 'ROTATE_ANON cookies_before=' + before.substring(0,300), 'text/plain');

                            // 2. Try to wipe arena cookies (httpOnly we can't touch, but try non-http ones)
                            const expire = 'expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
                            for (const c of document.cookie.split(';')) {
                                const name = c.trim().split('=')[0];
                                if (!name) continue;
                                document.cookie = `${name}=; ${expire}`;
                                document.cookie = `${name}=; ${expire}; domain=.arena.ai`;
                                document.cookie = `${name}=; ${expire}; domain=arena.ai`;
                            }
                            const after = document.cookie.split(';').map(c => c.trim().split('=')[0]).join(',');
                            bridgePost('http://127.0.0.1:5102/debug/log', 'ROTATE_ANON cookies_after=' + after.substring(0,300), 'text/plain');

                            // 3. Try sign-up with fresh provisional UUID
                            const provisionalId = uuidv7();
                            const recapToken = await getFreshRecaptchaToken();
                            const resp = await fetch('/nextjs-api/sign-up', {
                                method: 'POST',
                                headers: {'Content-Type':'application/json'},
                                body: JSON.stringify({
                                    recaptchaToken: recapToken,
                                    provisionalUserId: provisionalId
                                }),
                                credentials: 'include'
                            });
                            const body = await resp.text();
                            bridgePost('http://127.0.0.1:5102/debug/log', 'ROTATE_ANON result status=' + resp.status + ' body=' + body.substring(0, 250), 'text/plain');
                            try {
                                const cookies = document.cookie.split(';').filter(c => c.includes('arena-auth-prod-v1'));
                                if (cookies.length) {
                                    bridgePost('http://127.0.0.1:5102/debug/log', 'ROTATE_ANON new_cookie_len=' + cookies.join('').length, 'text/plain');
                                }
                            } catch(e){}
                        } catch(e) {
                            bridgePost('http://127.0.0.1:5102/debug/log', 'ROTATE_ANON error=' + (e.message || e), 'text/plain');
                        }
                        return;
                    } else if (message.command === 'send_page_source') {
                        console.log("[API Bridge] Received send_page_source command, sending...");
                        sendPageSource();
                    } else if (message.command === 'enable_queue') {
                        window.enableQueue();
                    } else if (message.command === 'disable_queue') {
                        window.disableQueue();
                    } else if (message.command === 'queue_status') {
                        const status = window.queueStatus();
                        sendToServer("system", JSON.stringify({ queue_status: status }));
                    } else if (message.command === 'clear_queue') {
                        window.clearQueue();
                    }
                    return;
                }

                const { request_id, payload } = message;

                if (!request_id || !payload) {
                    console.error("[API Bridge] Received invalid message from server:", message);
                    return;
                }

                console.log(`[API Bridge] ⬇️ Received chat request ${request_id.substring(0, 8)}.`);
                bridgePost('http://127.0.0.1:5102/debug/log', 'GOT_REQUEST ' + request_id.substring(0,8) + ' model=' + (payload && payload.target_model_id || '').substring(0,8), 'text/plain');

                if (queueEnabled) {
                    console.log(`[API Bridge] 📥 Queue is ON - adding request to queue`);
                    addToQueue(request_id, payload);
                    return;
                }

                const rateLimitCheck = checkRateLimits();

                if (!rateLimitCheck.allowed) {
                    if (rateLimitCheck.reason === 'cooldown') {
                        console.warn(`[API Bridge] ⚠️ Cooldown active. Wait ${rateLimitCheck.waitTimeSec}s`);

                        sendToServer(request_id, { error: `Slow Down Locust! Wait: ${rateLimitCheck.waitTimeSec}s` });
                        sendToServer(request_id, "[DONE]");
                        return;

                    } else if (rateLimitCheck.reason === 'window') {
                        console.warn(`[API Bridge] ⚠️ Window rate limit hit. Wait ${rateLimitCheck.waitTimeSec}s`);

                        sendToServer(request_id, { error: `You have exceeded the rate limit. Try not swiping too much next time cuckie. Wait: ${rateLimitCheck.waitTimeSec}s` });
                        sendToServer(request_id, "[DONE]");
                        return;
                    }
                }

                await handleRequest(request_id, payload);

            } catch (error) {
                console.error("[API Bridge] Error processing server message:", error);
            }
        };

        socket.onclose = () => {
            console.warn("[API Bridge] 🔌 Connection closed. Reconnecting in 5s...");
            if (document.title.startsWith("✅ ")) {
                document.title = document.title.substring(2);
            }
            setTimeout(connect, 5000);
        };

        socket.onerror = (error) => {
            console.error("[API Bridge] ❌ WebSocket error:", error);
            socket.close();
        };
    }

    // ============================================
    // Request Handler
    // ============================================
    async function handleRequest(requestId, payload) {
        const _dbg = (s) => bridgePost('http://127.0.0.1:5102/debug/log', 'HANDLE '+requestId.substring(0,8)+' '+s, 'text/plain');
        _dbg('start');
        resetSessionTimer(); // Reset inactivity timer on new request

        const { message_templates, target_model_id, session_id, message_id, tools, tool_choice } = payload;
        _dbg('payload sid='+(session_id||'').substring(0,8)+' mid='+(message_id||'').substring(0,8)+' mt='+(message_templates||[]).length);

        if (!session_id || !message_id) {
            const errorMsg = "Session IDs missing. Please run setup again.";
            console.error(`[API Bridge] ${errorMsg}`);
            sendToServer(requestId, { error: errorMsg });
            sendToServer(requestId, "[DONE]");
            return;
        }

        if (!message_templates || message_templates.length === 0) {
            const errorMsg = "No messages to send.";
            console.error(`[API Bridge] ${errorMsg}`);
            sendToServer(requestId, { error: errorMsg });
            sendToServer(requestId, "[DONE]");
            return;
        }

        _dbg('mkurl');
        // arena.ai forbids 'direct' mode on /create-evaluation for new conversations.
        // Use /post-to-evaluation/<session_id> which appends to existing conversation.
        const apiUrl = `/nextjs-api/stream/post-to-evaluation/${session_id}`;
        const evaluationId = session_id; // reuse existing conversation id
        _dbg('mkurl_done url='+apiUrl);

        const newMessages = [];
        let lastMsgId = null;

        for (let i = 0; i < message_templates.length; i++) {
            const template = message_templates[i];
            const currentMsgId = uuidv7();
            const parentIds = lastMsgId ? [lastMsgId] : [];
            const status = template.status || ((i === message_templates.length - 1) ? 'pending' : 'success');
            const modelId = (status === 'pending' && template.role === 'assistant') ? target_model_id : null;

            newMessages.push({
                role: template.role,
                content: template.content,
                id: currentMsgId,
                evaluationId: null,
                evaluationSessionId: session_id,
                parentMessageIds: parentIds,
                experimental_attachments: [],
                failureReason: null,
                metadata: {},
                modelId: modelId,
                participantPosition: template.participantPosition || "a",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                status: status,
            });
            lastMsgId = currentMsgId;
        }

        console.log("[API Bridge] Getting fresh reCAPTCHA token...");
        _dbg('before_token');
        const recaptchaToken = await getFreshRecaptchaToken();
        _dbg('got_token len='+(recaptchaToken||'').length);

        if (!recaptchaToken) {
            console.error("[API Bridge] ❌ No reCAPTCHA token available!");
            console.log("[API Bridge] 💡 TIP: Send a message manually first to capture the token parameters");
        } else {
            console.log("[API Bridge] ✅ Got token:", recaptchaToken.substring(0, 20) + "...");
        }

        const formattedHistory = message_templates.map(msg => {
            const roleLabel = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
            return `${roleLabel}: ${msg.content}`;
        }).join('\n\n');

        const lastUserMsgId = uuidv7();
        const lastAssistantMsgId = uuidv7();

        const lastAssistantMsgIdB = uuidv7();
        const body = {
            id: evaluationId,
            modelAId: target_model_id,
            userMessageId: lastUserMsgId,
            modelAMessageId: lastAssistantMsgId,
            modelBMessageId: lastAssistantMsgIdB,
            userMessage: {
                content: formattedHistory,
                experimental_attachments: [],
                metadata: {},
            },
            modality: "chat",
            recaptchaV3Token: recaptchaToken,
        };
        // arena.ai battle endpoint silently kills stream when tools field present —
        // emulation is done server-side via system-prompt injection, not here.

        console.log("[API Bridge] Sending to LMArena API");
        console.log("[API Bridge] Token length:", recaptchaToken.length);

        window.isApiBridgeRequest = true;
        try {
            _dbg('before_fetch');
            // Anti-rate-limit experiment: spoof IP headers (some CDN/edge proxies trust these)
            const fakeIp = (Math.floor(Math.random()*220)+10) + '.' + (Math.floor(Math.random()*255)) + '.' + (Math.floor(Math.random()*255)) + '.' + (Math.floor(Math.random()*254)+1);
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain;charset=UTF-8',
                    'Accept': '*/*',
                    'X-Forwarded-For': fakeIp,
                    'X-Real-IP': fakeIp,
                    'X-Client-IP': fakeIp,
                    'CF-Connecting-IP': fakeIp,
                },
                body: JSON.stringify(body),
                credentials: 'include'
            });
            _dbg('fetch_status='+response.status);

            if (!response.ok || !response.body) {
                const errorBody = await response.text();
                _dbg('not_ok body='+errorBody.substring(0,150));
                throw new Error(`Response error: ${response.status}. ${errorBody}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { value, done } = await reader.read();
                if (done) {
                    console.log(`[API Bridge] ✅ Request ${requestId.substring(0, 8)} complete`);
                    sendToServer(requestId, "[DONE]");

                    recordRequest();

                    break;
                }
                const chunk = decoder.decode(value);
                sendToServer(requestId, chunk);
            }

        } catch (error) {
            console.error(`[API Bridge] ❌ Error:`, error);

            // Record the attempt (cooldown still applies to prevent spam)
            recordRequest();

            const errMsg = error.message || "";

            // 1. HTTP 429 - Rate Limit
            if (errMsg.includes("429") || errMsg.includes("Too Many Requests")) {
                triggerAutoProtection();
                sendToServer(requestId, { error: `⚠️ AUTOMATIC PROTECTION ENABLED: 429 Detected. System is entering defensive mode. ${errMsg}` });
            }
            // 2. HTTP 500 - Internal Server Error
            else if (errMsg.includes("500") || errMsg.includes("Internal Server Error")) {
                sendToServer(requestId, { error: `⛔ 500 Server Error. Refreshing page...` });
                sendToServer(requestId, "[DONE]");
                setTimeout(() => location.reload(), 1000); // Force refresh
                return;
            }
            // 3. HTTP 403 - reCAPTCHA (Specific validation failure)
            else if (errMsg.includes("403") && errMsg.includes("recaptcha")) {
                rollbackRateLimit(); // New: Rollback quota on captcha fail
                sendToServer(requestId, { error: `🚫 reCAPTCHA Failed. Please send a manual message in browser. ${errMsg}` });
            }
            // 4. HTTP 422 - Content Filter
            else if (errMsg.includes("422")) {
                rollbackRateLimit();
                sendToServer(requestId, { error: `⚠️ 422 Filter Error: Your message was rejected. TIP: Modify your prompt to prevent getting filtered. ${errMsg}` });
            }
            // 5. Generic / TypeErrors / Input Stream / Network
            else {
                rollbackRateLimit();
                sendToServer(requestId, { error: errMsg });
            }

            sendToServer(requestId, "[DONE]");

        } finally {
            window.isApiBridgeRequest = false;
        }
    }

    // ============================================
    // Utility Functions
    // ============================================
    function sendToServer(requestId, data) {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ request_id: requestId, data: data }));
        } else {
            console.error("[API Bridge] Cannot send - not connected");
        }
    }

    // ============================================
    // Network Request Interception
    // ============================================
    const originalFetch = window.fetch;
    window.fetch = function(...args) {
        const urlArg = args[0];
        let urlString = '';

        if (urlArg instanceof Request) {
            urlString = urlArg.url;
        } else if (urlArg instanceof URL) {
            urlString = urlArg.href;
        } else if (typeof urlArg === 'string') {
            urlString = urlArg;
        }

        if (urlString && urlString.includes('/create-evaluation') && !window.isApiBridgeRequest) {
            try {
                // Detected manual action
                resetSessionTimer();

                const options = args[1];
                if (options && options.body) {
                    const body = JSON.parse(options.body);
                    if (body.recaptchaV3Token) {
                        window.recaptchaToken = body.recaptchaV3Token;
                        console.log("[API Bridge] 📥 Captured recaptcha token from real request");
                        console.log("[API Bridge]    Token:", body.recaptchaV3Token.substring(0, 30) + "...");
                    }
                }
            } catch (e) {}
        }

        // DEBUG: log every fetch URL while in capture mode, so we can see what arena.ai actually calls.
        if (urlString && isCaptureModeActive && !window.isApiBridgeRequest && !urlString.includes('127.0.0.1')) {
            try {
                const method = (args[1] && args[1].method) || (urlArg instanceof Request ? urlArg.method : 'GET');
                fetch('http://127.0.0.1:5102/debug/log', {
                    method: 'POST',
                    headers: {'Content-Type':'text/plain'},
                    body: 'fetch ' + method + ' ' + urlString.substring(0, 400),
                }).catch(()=>{});
            } catch(e){}
        }

        if (urlString) {
            // Try multiple regex patterns — arena.ai may have changed endpoint name.
            let match = urlString.match(/\/nextjs-api\/stream\/retry-evaluation-session-message\/([a-f0-9-]+)\/messages\/([a-f0-9-]+)/);
            if (!match) match = urlString.match(/\/evaluation[s]?\/([a-f0-9-]{36})\/messages\/([a-f0-9-]{36})/);
            if (!match) match = urlString.match(/\/([a-f0-9-]{36})\/messages\/([a-f0-9-]{36})/);

            if (match && !window.isApiBridgeRequest && isCaptureModeActive) {
                const sessionId = match[1];
                const messageId = match[2];
                console.log(`[API Bridge] 🎯 Captured IDs in active mode! Sending...`);

                isCaptureModeActive = false;
                if (document.title.startsWith("🎯 ")) {
                    document.title = document.title.substring(2);
                }

                bridgePost('http://127.0.0.1:5102/update', JSON.stringify({ sessionId, messageId }), 'application/json');
                console.log(`[API Bridge] ✅ ID update sent (via bridgePost). Capture mode auto-disabled.`);
            }
        }

        return originalFetch.apply(this, args);
    };

    // ============================================
    // Page Source Sending (tries both endpoints)
    // ============================================
    async function fetchArenaHomeHTML() {
        // Fetch arena.ai root with same cookies; models live in initialModels JSON.
        try {
            const r = await fetch('/', {method: 'GET', credentials: 'include', headers: {'Accept': 'text/html'}});
            if (r.ok) return await r.text();
        } catch(e) { console.warn('[API Bridge] home fetch err', e); }
        return '';
    }

    async function sendPageSource() {
        let htmlContent = document.documentElement.outerHTML;
        // If current page has no initialModels — try the home page.
        if (!/"initialModels"\s*:/.test(htmlContent) && !/\\"initialModels\\"/.test(htmlContent)) {
            console.log("[API Bridge] no initialModels here, fetching arena.ai root...");
            const home = await fetchArenaHomeHTML();
            if (home) htmlContent = home;
        }
        console.log("[API Bridge] page len=" + htmlContent.length + ", extracting models via JSON parse");

        // Try to extract models from in-page state instead of shipping the whole HTML
        // (GM_xhr struggles with >500KB bodies on mobile).
        const models = {};
        const tryAdd = (name, id) => {
            if (typeof name === 'string' && typeof id === 'string' && id.length === 36 && id.includes('-') && name.length > 1 && name.length < 80) {
                models[name] = id;
            }
        };

        // 1. __NEXT_DATA__ blob
        try {
            const el = document.getElementById('__NEXT_DATA__');
            if (el && el.textContent) {
                const data = JSON.parse(el.textContent);
                const walk = (obj) => {
                    if (!obj || typeof obj !== 'object') return;
                    if (Array.isArray(obj)) { obj.forEach(walk); return; }
                    const id = obj.id || obj.modelId;
                    const name = obj.publicName || obj.public_name || obj.name || obj.slug;
                    if (id && name) tryAdd(name, id);
                    for (const v of Object.values(obj)) walk(v);
                };
                walk(data);
            }
        } catch(e) { console.warn('[API Bridge] NEXT_DATA parse err', e); }

        // 2. Scan all <script> JSON blobs
        try {
            for (const s of document.querySelectorAll('script[type="application/json"]')) {
                try {
                    const j = JSON.parse(s.textContent);
                    const walk = (obj) => {
                        if (!obj || typeof obj !== 'object') return;
                        if (Array.isArray(obj)) { obj.forEach(walk); return; }
                        const id = obj.id || obj.modelId;
                        const name = obj.publicName || obj.public_name || obj.name || obj.slug;
                        if (id && name) tryAdd(name, id);
                        for (const v of Object.values(obj)) walk(v);
                    };
                    walk(j);
                } catch(e){}
            }
        } catch(e){}

        // 3a. initialModels JSON blob (used by LMAB upstream — escaped inside HTML).
        try {
            const m = htmlContent.match(/\\"initialModels\\":(\[.*?\]),\\"initialModel[A-Z]Id/s)
                   || htmlContent.match(/"initialModels"\s*:\s*(\[.*?\])\s*,\s*"initialModel[A-Z]Id/s);
            if (m) {
                let raw = m[1];
                // unescape if double-escaped JSON
                if (raw.includes('\\"')) {
                    try { raw = JSON.parse('"' + raw.replace(/^\[/, '').replace(/\]$/, '').replace(/"/g,'\\"') + '"'); } catch(e){}
                    // Simpler: just unescape backslashes
                    raw = raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
                }
                try {
                    const arr = JSON.parse(raw);
                    if (Array.isArray(arr)) {
                        for (const m2 of arr) tryAdd(m2.publicName || m2.name, m2.id);
                        console.log("[API Bridge] initialModels found:", arr.length, "items");
                    }
                } catch(e) { console.warn('[API Bridge] initialModels parse err', e); }
            }
        } catch(e){}

        // 3b. Regex fallback over full HTML — done client-side so we ship only the result.
        try {
            const patterns = [
                /"id"\s*:\s*"([a-f0-9-]{36})"[^}]{0,300}?"publicName"\s*:\s*"([^"]{2,80})"/g,
                /"publicName"\s*:\s*"([^"]{2,80})"[^}]{0,300}?"id"\s*:\s*"([a-f0-9-]{36})"/g,
                /"id"\s*:\s*"([a-f0-9-]{36})"[^}]{0,300}?"name"\s*:\s*"([^"]{2,80})"/g,
                /"name"\s*:\s*"([^"]{2,80})"[^}]{0,300}?"id"\s*:\s*"([a-f0-9-]{36})"/g,
            ];
            for (const pat of patterns) {
                let m;
                while ((m = pat.exec(htmlContent)) !== null) {
                    const a = m[1], b = m[2];
                    if (a.length === 36 && a.includes('-')) tryAdd(b, a);
                    else tryAdd(a, b);
                }
            }
        } catch(e){}

        const count = Object.keys(models).length;
        console.log("[API Bridge] extracted " + count + " models, posting");
        bridgePost('http://127.0.0.1:5102/internal/update_models_json', JSON.stringify(models), 'application/json');
        return;
        // dead code below (kept for diff minimal)
        const endpoints = [
            'http://127.0.0.1:5102/internal/update_available_models',
            'http://127.0.0.1:5102/internal/update_models'
        ];
        let success = false;
        for (const endpoint of endpoints) {
            try {
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'text/html; charset=utf-8'
                    },
                    body: htmlContent
                });

                if (response.ok) {
                    console.log(`[API Bridge] ✅ Page source sent successfully to ${endpoint}`);
                    success = true;
                    break;
                }
            } catch (e) {
                console.log(`[API Bridge] ⚠️ Failed to send to ${endpoint}: ${e.message}`);
            }
        }

        if (!success) {
            console.error("[API Bridge] ❌ Failed to send page source to any endpoint");
        }
    }

    // ============================================
    // Initialization
    // ============================================
    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║           Arena API Bridge v3.2.7 Standard                   ║");
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log("║  Type help() in console for commands and settings.           ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");

    connect();

})();