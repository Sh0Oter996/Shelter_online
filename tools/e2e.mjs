// Сквозной тест мультиплеера в локальном режиме через Chrome DevTools Protocol.
// Запускает 4 вкладки, создаёт комнату, входит, играет партию до финала.
// Требуется только установленный Chrome. Не часть статического сайта.

import { spawn } from 'node:child_process';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CHROME = process.env.CHROME
    || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.CDP_PORT) || 9333;
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173';
const PROFILE = path.resolve('.chrome-e2e-profile');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class CDP {
    constructor(url) {
        this.url = url;
        this.ws = null;
        this.nextId = 1;
        this.pending = new Map();
        this.handlers = [];
    }

    async connect() {
        this.ws = new WebSocket(this.url);
        await new Promise((resolve, reject) => {
            this.ws.addEventListener('open', resolve, { once: true });
            this.ws.addEventListener('error', reject, { once: true });
        });
        this.ws.addEventListener('message', event => {
            let message;
            try { message = JSON.parse(String(event.data)); } catch { return; }

            if (message.id && this.pending.has(message.id)) {
                const { resolve, reject } = this.pending.get(message.id);
                this.pending.delete(message.id);
                if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
                else resolve(message.result);
                return;
            }

            if (message.method) {
                this.handlers.forEach(handler => {
                    if (handler.method !== message.method) return;
                    if (handler.sessionId && handler.sessionId !== message.sessionId) return;
                    handler.callback(message.params, message.sessionId);
                });
            }
        });
    }

    send(method, params = {}, sessionId) {
        const id = this.nextId++;
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify(payload));
            setTimeout(() => {
                if (!this.pending.has(id)) return;
                this.pending.delete(id);
                reject(new Error(`CDP timeout: ${method}`));
            }, 15000);
        });
    }

    on(method, callback, sessionId) {
        this.handlers.push({ method, callback, sessionId });
    }
}

class Page {
    constructor(cdp, sessionId, name) {
        this.cdp = cdp;
        this.sessionId = sessionId;
        this.name = name;
        this.errors = [];
    }

    send(method, params) {
        return this.cdp.send(method, params, this.sessionId);
    }

    async init() {
        await this.send('Page.enable');
        await this.send('Runtime.enable');
        this.cdp.on('Runtime.exceptionThrown', params => {
            const detail = params.exceptionDetails || {};
            this.errors.push(`exception: ${detail.text || ''} ${detail.exception && detail.exception.description || ''}`);
        }, this.sessionId);
        this.cdp.on('Runtime.consoleAPICalled', params => {
            if (params.type !== 'error') return;
            const text = (params.args || []).map(arg => arg.value ?? arg.description ?? '').join(' ');
            this.errors.push(`console: ${text}`);
        }, this.sessionId);
    }

    async goto(url) {
        await this.send('Page.navigate', { url });
        await this.waitFor(`document.readyState === 'complete'`, 15000);
        await this.waitFor(`!!window.__shelter`, 20000);
    }

    async reload() {
        await this.send('Page.reload', { ignoreCache: true });
        await this.waitFor(`document.readyState === 'complete' && !!window.__shelter`, 20000);
    }

    async eval(expression) {
        const result = await this.send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
            userGesture: true
        });
        if (result.exceptionDetails) {
            const description = result.exceptionDetails.exception && result.exceptionDetails.exception.description;
            throw new Error(`${this.name}: ${description || result.exceptionDetails.text}`);
        }
        return result.result ? result.result.value : undefined;
    }

    async waitFor(expression, timeout = 15000) {
        const started = Date.now();
        while (Date.now() - started < timeout) {
            try {
                if (await this.eval(expression)) return true;
            } catch { /* страница ещё грузится */ }
            await sleep(120);
        }
        throw new Error(`${this.name}: таймаут ожидания: ${expression}`);
    }

    async click(selector) {
        return this.eval(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return false;
            el.click();
            return true;
        })()`);
    }

    async text(selector) {
        return this.eval(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            return el ? el.textContent.trim() : null;
        })()`);
    }

    async screenshot(file) {
        const result = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        await writeFile(file, Buffer.from(result.data, 'base64'));
    }
}

async function waitForJson(url, tries = 80) {
    for (let i = 0; i < tries; i++) {
        try {
            const response = await fetch(url);
            if (response.ok) return response.json();
        } catch { /* chrome ещё стартует */ }
        await sleep(200);
    }
    throw new Error(`Не дождались ${url}`);
}

async function makePage(browser, name) {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(browser, sessionId, name);
    await page.init();
    return page;
}

async function fill(page, selector, value) {
    await page.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('Нет поля ${selector}');
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    })()`);
}

async function joinFlow(page, name, code) {
    await page.waitFor(`document.querySelector('#homeScreen') && document.querySelector('#homeScreen').classList.contains('active')`);
    await fill(page, '#joinName', name);
    if (code) await fill(page, '#joinCode', code);
    await page.eval(`document.querySelector('#joinForm').requestSubmit()`);
    await page.waitFor(`document.querySelector('#lobbyScreen').classList.contains('active')`, 15000);
}

async function hostState(page) {
    return page.eval(`window.__shelter.app.state`);
}

async function main() {
    await rm(PROFILE, { recursive: true, force: true });
    await mkdir(PROFILE, { recursive: true });
    await mkdir(path.resolve('test-results'), { recursive: true });

    const chrome = spawn(CHROME, [
        '--headless=new',
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${PROFILE}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--window-size=1280,960',
        'about:blank'
    ], { stdio: 'ignore' });

    let browser = null;
    try {
        const info = await waitForJson(`http://127.0.0.1:${PORT}/json/version`);
        browser = new CDP(info.webSocketDebuggerUrl);
        await browser.connect();

        // --- Экран настройки без Firebase ---
        const setupPage = await makePage(browser, 'setup');
        await setupPage.goto(`${BASE}/`);
        await setupPage.waitFor(`document.querySelector('#setupScreen').classList.contains('active')`, 10000);
        const setupTitle = await setupPage.text('#setupScreen h2');
        if (!setupTitle || !setupTitle.includes('Нужно подключить облако')) {
            throw new Error('Не показан экран настройки Firebase');
        }
        console.log('✓ Без firebase-config.js показывается инструкция по настройке');

        // --- Хост ---
        const host = await makePage(browser, 'host');
        await host.goto(`${BASE}/?local=1`);
        await host.waitFor(`document.querySelector('#homeScreen').classList.contains('active')`);
        await host.eval(`window.confirm = () => true; true`);
        await fill(host, '#createName', 'Алиса');
        await host.eval(`document.querySelector('#createForm').requestSubmit()`);
        await host.waitFor(`document.querySelector('#lobbyScreen').classList.contains('active')`, 15000);

        const code = (await host.text('#lobbyCode')).trim();
        console.log(`Комната создана: ${code}`);
        if (!/^\d{6}$/.test(code)) throw new Error(`Неверный код комнаты: ${code}`);

        // --- Проверка восстановления после перезагрузки хоста ---
        await host.reload();
        await host.waitFor(`document.querySelector('#lobbyScreen').classList.contains('active')`, 15000);
        await host.eval(`window.confirm = () => true; true`);
        const codeAfterReload = (await host.text('#lobbyCode')).trim();
        if (codeAfterReload !== code) throw new Error('Хост не восстановил комнату после перезагрузки');
        console.log('✓ Хост восстанавливает комнату после перезагрузки');

        // --- Остальные игроки ---
        const players = [
            { page: host, name: 'Алиса' }
        ];
        for (const name of ['Борис', 'Вера', 'Глеб']) {
            const page = await makePage(browser, name);
            await page.goto(`${BASE}/?local=1&room=${code}`);
            await joinFlow(page, name, code);
            players.push({ page, name });
            console.log(`✓ ${name} вошёл в комнату`);
        }

        await host.waitFor(`window.__shelter.app.members && Object.keys(window.__shelter.app.members).length === 4`);
        await host.screenshot('test-results/lobby-host.png');
        await host.waitFor(`!document.querySelector('#startGameBtn').disabled`);

        // --- Удаление лишнего игрока хостом ---
        const extra = await makePage(browser, 'extra');
        await extra.goto(`${BASE}/?local=1&room=${code}`);
        await joinFlow(extra, 'Дина', code);
        await host.waitFor(`window.__shelter.app.members && Object.keys(window.__shelter.app.members).length === 5`);
        const extraUid = await extra.eval(`window.__shelter.app.uid`);
        await host.eval(`(() => {
            const btn = document.querySelector('[data-kick="${extraUid}"]');
            if (!btn) throw new Error('Нет кнопки удаления игрока');
            btn.click();
            return true;
        })()`);
        await extra.waitFor(`document.querySelector('#homeScreen').classList.contains('active')`, 15000);
        await host.waitFor(`window.__shelter.app.members && Object.keys(window.__shelter.app.members).length === 4`);
        console.log('✓ Хост удаляет лишнего игрока, удалённый возвращается на главный экран');

        // --- Старт ---
        await host.click('#startGameBtn');
        await host.waitFor(`window.__shelter.app.state && window.__shelter.app.state.phase === 'story'`, 15000);
        for (const { page, name } of players) {
            await page.waitFor(`document.querySelector('#gameScreen').classList.contains('active')`, 15000);
            await page.waitFor(`window.__shelter.app.state && window.__shelter.app.state.phase === 'story'`, 15000);
            // В игре есть prompt() для характеристик «Придумай сам». В тесте
            // заменяем его, иначе нативный диалог блокирует CDP.
            await page.eval(`window.prompt = () => 'Тестовое значение'; window.confirm = () => true; true`);
        }
        console.log('✓ Игра началась у всех игроков одновременно');

        // Секреты не должны утекать в публичное состояние.
        const leak = await host.eval(`(() => {
            const s = window.__shelter.app.state;
            return s.players.some(p => p.alive && p.values && p.values.health !== undefined);
        })()`);
        if (leak) throw new Error('Публичное состояние раскрывает здоровье до раскрытия');
        console.log('✓ Скрытые характеристики не попадают в публичное состояние');

        // --- Раунд ---
        await host.click('[data-action="begin"]');
        await host.waitFor(`window.__shelter.app.state.phase === 'reveal'`, 15000);

        let guard = 0;
        let revealedCount = 0;
        let reloadedMidGame = false;
        while (guard++ < 200) {
            const state = await hostState(host);
            if (!state) throw new Error('Нет состояния игры');

            if (!reloadedMidGame && revealedCount >= 8) {
                const player = players[1].page;
                await player.reload();
                await player.waitFor(`document.querySelector('#gameScreen').classList.contains('active')`, 20000);
                await player.waitFor(`!!(window.__shelter.app.state && window.__shelter.app.hand)`, 20000);
                await player.eval(`window.prompt = () => 'Тестовое значение'; window.confirm = () => true; true`);

                await host.reload();
                await host.waitFor(`document.querySelector('#gameScreen').classList.contains('active')`, 20000);
                await host.waitFor(`!!(window.__shelter.app.state && window.__shelter.app.state.phase)`, 20000);
                await host.eval(`window.prompt = () => 'Тестовое значение'; window.confirm = () => true; true`);

                reloadedMidGame = true;
                console.log('✓ Игрок и хост восстанавливают партию после перезагрузки посреди игры');
            }

            if (state.phase === 'ended') break;

            if (state.phase === 'reveal') {
                let acted = false;
                for (const { page } of players) {
                    const isTurn = await page.eval(`!!(window.__shelter.app.hand && window.__shelter.app.hand.isMyTurn)`);
                    if (!isTurn) continue;
                    if (revealedCount === 0) {
                        await page.screenshot('test-results/reveal-player.png');
                    }
                    const before = state.currentUid;
                    const clicked = await page.eval(`(() => {
                        const btn = document.querySelector('[data-action="reveal"]');
                        if (!btn) return false;
                        btn.click();
                        return true;
                    })()`);
                    if (!clicked) throw new Error('У текущего игрока нет кнопки раскрытия');
                    await host.waitFor(`(() => {
                        const s = window.__shelter.app.state;
                        return s && (s.currentUid !== ${JSON.stringify(before)} || s.phase !== 'reveal');
                    })()`, 15000);
                    acted = true;
                    revealedCount++;
                    break;
                }
                if (!acted) {
                    await sleep(150);
                }
                continue;
            }

            if (state.phase === 'vote') {
                let voted = false;
                for (const { page } of players) {
                    const isVote = await page.eval(`!!(window.__shelter.app.hand && window.__shelter.app.hand.isMyVote)`);
                    if (!isVote) continue;
                    const before = state.vote.votedCount;
                    await page.eval(`(() => {
                        const btn = document.querySelector('[data-action="vote"]');
                        if (!btn) throw new Error('Нет кнопки голосования');
                        btn.click();
                        return true;
                    })()`);
                    await host.waitFor(`(() => {
                        const s = window.__shelter.app.state;
                        return s && (s.phase !== 'vote' || s.vote.votedCount > ${before});
                    })()`, 15000);
                    voted = true;
                    break;
                }
                if (!voted) {
                    await sleep(150);
                }
                continue;
            }

            if (state.phase === 'vote-result') {
                await host.waitFor(`!!document.querySelector('[data-action="continue"]')`, 10000);
                await host.click('[data-action="continue"]');
                await host.waitFor(`window.__shelter.app.state.phase !== 'vote-result'`, 15000);
                continue;
            }

            if (state.phase === 'decider') {
                let voted = false;
                for (const { page } of players) {
                    const isDecider = await page.eval(`!!(window.__shelter.app.hand && window.__shelter.app.hand.isDecider)`);
                    if (!isDecider) continue;
                    await page.eval(`document.querySelector('[data-action="decider"]').click()`);
                    await host.waitFor(`window.__shelter.app.state.phase !== 'decider'`, 15000);
                    voted = true;
                    break;
                }
                if (!voted) await sleep(150);
                continue;
            }

            if (state.phase === 'story') {
                await host.click('[data-action="begin"]');
                await host.waitFor(`window.__shelter.app.state.phase !== 'story'`, 15000);
                continue;
            }

            await sleep(150);
        }

        if (guard >= 200) throw new Error('Игра не завершилась за 200 шагов');

        const finalState = await hostState(host);
        if (finalState.phase !== 'ended') throw new Error(`Ожидался финал, получено ${finalState.phase}`);

        const title = await host.text('.end-game-panel h2');
        if (finalState.ending.survivors.length !== finalState.survivorsTarget) {
            throw new Error(`Выживших ${finalState.ending.survivors.length}, а планировалось ${finalState.survivorsTarget}`);
        }
        for (const { page, name } of players) {
            await page.waitFor(`document.querySelector('.end-game-panel') !== null`, 15000);
            const playerTitle = await page.text('.end-game-panel h2');
            if (playerTitle !== title) throw new Error(`${name}: разные финалы (${playerTitle} / ${title})`);
        }
        console.log(`✓ Партия завершена у всех. Финал: ${title}. Раскрытий: ${revealedCount}`);
        console.log(`  Открытых комнат: ${finalState.ending.openedRoomNames.length}, выжило: ${finalState.ending.survivors.length}`);

        await host.screenshot('test-results/final-host.png');

        // --- Перезапуск ---
        await host.click('[data-action="restart"]');
        await host.waitFor(`document.querySelector('#restartModal').classList.contains('open')`);
        await host.click('#confirmRestartBtn');
        for (const { page, name } of players) {
            await page.waitFor(`document.querySelector('#lobbyScreen').classList.contains('active')`, 20000)
                .catch(() => { throw new Error(`${name}: не вернулся в лобби после перезапуска`); });
        }
        console.log('✓ Перезапуск возвращает всех игроков в лобби');

        // --- Выход игрока и закрытие комнаты ---
        const leaver = players[1].page;
        await leaver.click('#leaveLobbyBtn');
        await leaver.waitFor(`document.querySelector('#homeScreen').classList.contains('active')`, 15000);
        await host.waitFor(`window.__shelter.app.members && Object.keys(window.__shelter.app.members).length === 3`, 15000);
        await joinFlow(leaver, 'Борис', code);
        await host.waitFor(`window.__shelter.app.members && Object.keys(window.__shelter.app.members).length === 4`, 15000);

        await host.click('#leaveLobbyBtn');
        for (const { page } of players) {
            await page.waitFor(`document.querySelector('#homeScreen').classList.contains('active')`, 20000);
        }
        console.log('✓ Выход игрока и закрытие комнаты работают');

        // --- Ошибки консоли ---
        const allErrors = [...players.flatMap(p => p.page.errors), ...extra.errors, ...setupPage.errors];
        if (allErrors.length) {
            console.error('Ошибки в браузере:');
            allErrors.forEach(error => console.error(' -', error));
            throw new Error('В консоли браузера есть ошибки');
        }

        console.log('\nE2E-тест мультиплеера пройден.');
    } finally {
        try { if (browser) await browser.send('Browser.close'); } catch { /* ignore */ }
        try { chrome.kill(); } catch { /* ignore */ }
    }
}

main().catch(error => {
    console.error('\nE2E FAILED:', error.message);
    process.exitCode = 1;
});
