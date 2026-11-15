'use strict';

// ============================================================================
//  ТОЧКА ВХОДА
//  Связывает UI, сервис комнаты и хост-контроллер.
// ============================================================================

import { FIREBASE_READY } from '../firebase-config.js';
import { createFirebaseBackend, createLocalBackend, FIREBASE_VERSION } from './net/firebase-backend.js';
import { paths } from './net/backend.js';
import { RoomService, isCodeFree } from './net/room-service.js';
import { HostController } from './net/host-controller.js';
import { generateRoomCode, normalizeCode, toArray } from './utils.js';
import {
    $, showScreen, toast, queueToast, setConnectionPill, initModalHandlers, closeAllModals, setButtonBusy
} from './ui/dom.js';
import { initHome, prefillJoin, fillLobbyScenarioSelect } from './ui/home.js';
import { initLobby, renderLobby, resetLobbyForm } from './ui/lobby.js';
import { initGameUI, renderGame } from './ui/game.js';

const ROOM_KEY_PREFIX = 'shelter.room.';
const LAST_ROOM_KEY = 'shelter.lastRoom';

const app = {
    backend: null,
    uid: null,
    mode: null,
    code: null,
    service: null,
    host: null,
    meta: null,
    members: {},
    presence: {},
    state: null,
    hand: null,
    unsubs: [],
    enteredAt: 0,
    lastRendered: null,
    lobbyCount: 0,
    leaving: false,
    expectMemberRemoval: false,
    hostLockRelease: null,
    lastLogId: null,
    logStartedAt: null,

    async sendCommand(type, payload = {}) {
        if (!this.service) throw new Error('Нет активной комнаты.');
        await this.service.sendCommand(type, payload);
    },

    buildInviteLink() {
        if (!this.code) return '';
        const url = new URL(location.href);
        url.search = '';
        url.hash = '';
        const params = new URLSearchParams();
        params.set('room', this.code);
        if (this.mode === 'local') params.set('local', '1');
        url.search = params.toString();
        return url.toString();
    },

    async leaveRoom() {
        await leaveRoom();
    }
};

// ---------------------------------------------------------------------------
//  Запуск
// ---------------------------------------------------------------------------

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}

async function boot() {
    initModalHandlers();
    initHome({
        onCreate: createRoomFlow,
        onJoin: joinRoomFlow
    });
    fillLobbyScenarioSelect();
    initLobby({
        onStart: startGameFlow,
        onLeave: () => leaveRoom(),
        onKick: kickPlayer,
        getPlayerCount: () => app.lobbyCount,
        getCode: () => app.code,
        getInviteLink: () => app.buildInviteLink()
    });
    initGameUI(app);

    $('retryConnectBtn').addEventListener('click', retryConnect);
    $('localModeBtn').addEventListener('click', () => enterLocalMode());

    const params = new URLSearchParams(location.search);
    const forceLocal = params.get('local') === '1';

    if (forceLocal) {
        await connect('local');
        return;
    }

    if (FIREBASE_READY) {
        await connect('firebase');
    } else {
        showSetup('Конфигурация Firebase ещё не заполнена. Это ожидаемо при первом запуске.');
    }
}

function showSetup(message) {
    showScreen('setupScreen');
    const error = $('setupError');
    if (error) error.textContent = message || '';
    const pill = $('connectionPill');
    if (pill) pill.hidden = true;
}

async function retryConnect() {
    if (!FIREBASE_READY) {
        toast('Сначала заполните firebase-config.js (apiKey, projectId, databaseURL), затем обновите страницу.', 'error', 6000);
        return;
    }
    await connect('firebase');
}

async function connect(mode) {
    showScreen('loadingScreen');
    $('loadingText').textContent = mode === 'local'
        ? 'Готовим локальный режим…'
        : 'Подключаемся к Firebase…';

    try {
        const backend = mode === 'local'
            ? await createLocalBackend()
            : await createFirebaseBackend();

        app.backend = backend;
        app.uid = backend.uid;
        app.mode = mode;

        setConnectionPill(mode, mode === 'local'
            ? '🧪 Локальный режим · вкладки'
            : '☁️ Firebase · онлайн');

        const resumed = await tryResumeRoom(mode);
        if (!resumed) {
            showScreen('homeScreen');
            prefillJoin(new URLSearchParams(location.search).get('room'));
        }
    } catch (error) {
        console.error(error);
        showSetup(friendlyError(error));
    }
}

function friendlyError(error) {
    if (!error) return 'Неизвестная ошибка подключения.';
    if (error.code === 'config/missing') {
        return 'firebase-config.js не заполнен: нужны apiKey, projectId и databaseURL.';
    }
    return error.message || String(error);
}

function enterLocalMode() {
    const url = new URL(location.href);
    url.searchParams.set('local', '1');
    history.replaceState(null, '', url);
    connect('local');
}

// ---------------------------------------------------------------------------
//  Создание и вход
// ---------------------------------------------------------------------------

async function findFreeCode() {
    for (let attempt = 0; attempt < 12; attempt++) {
        const code = generateRoomCode(6);
        try {
            if (await isCodeFree(app.backend, code)) return code;
        } catch { /* конфликт/сеть — пробуем ещё */ }
    }
    throw new Error('Не удалось подобрать свободный код комнаты. Попробуйте ещё раз.');
}

async function createRoomFlow({ name, scenarioId, survivors }) {
    let created = null;
    let lastError = null;

    for (let attempt = 0; attempt < 6 && !created; attempt++) {
        const code = await findFreeCode();
        const service = new RoomService(app.backend, code, app.uid);
        try {
            await service.createRoom({ name, code, scenarioId, survivors });
            created = { code, service };
        } catch (error) {
            lastError = error;
            // Код могли занять между проверкой и записью — пробуем другой.
            if (error.code === 'PERMISSION_DENIED' || /permission_denied/i.test(String(error.message))) continue;
            throw error;
        }
    }

    if (!created) throw lastError || new Error('Не удалось создать комнату. Попробуйте ещё раз.');

    setRoomInUrl(created.code);
    await enterRoom(created.code, {
        hostUid: app.uid,
        status: 'lobby',
        createdAt: Date.now(),
        playerCount: 1,
        scenarioId,
        survivors
    }, { name, joinedAt: Date.now(), isHost: true }, created.service);
    toast(`Комната создана: ${created.code}. Отправьте ссылку друзьям.`, 'success', 5000);
}

async function joinRoomFlow({ name, code }) {
    const cleanCode = normalizeCode(code);
    const service = new RoomService(app.backend, cleanCode, app.uid);
    const result = await service.joinRoom({ name });
    setRoomInUrl(cleanCode);
    await enterRoom(cleanCode, result.meta, result.member, service);
    if (result.resumed) toast('Вы вернулись в комнату.', 'success');
}

async function tryResumeRoom(mode) {
    const params = new URLSearchParams(location.search);
    const urlRoom = normalizeCode(params.get('room') || '');
    let stored = null;
    try { stored = localStorage.getItem(ROOM_KEY_PREFIX + mode); } catch { /* ignore */ }

    const code = urlRoom || stored;
    if (!code || code.length < 4) {
        if (urlRoom) prefillJoin(urlRoom);
        return false;
    }

    try {
        const meta = await app.backend.get(paths.meta(code));
        if (!meta) {
            clearStoredRoom(mode);
            if (urlRoom) {
                toast('Комната не найдена. Возможно, хост её закрыл.', 'error');
                prefillJoin(urlRoom);
            }
            return false;
        }

        const member = await app.backend.get(paths.member(code, app.uid));
        if (!member) {
            if (urlRoom) {
                prefillJoin(urlRoom);
                toast(meta.status === 'lobby'
                    ? 'Вы ещё не в этой комнате. Введите имя и нажмите «Войти».'
                    : 'Игра уже началась, а вас нет в списке участников.', 'error', 6000);
            }
            return false;
        }

        setRoomInUrl(code);
        const service = new RoomService(app.backend, code, app.uid);
        await enterRoom(code, meta, member, service);
        return true;
    } catch (error) {
        console.error('Не удалось восстановить комнату', error);
        toast('Не удалось восстановить прошлую комнату. Войдите заново.', 'error');
        return false;
    }
}

// ---------------------------------------------------------------------------
//  Вход в комнату и подписки
// ---------------------------------------------------------------------------

async function enterRoom(code, meta, member, service = null) {
    await cleanupRoom({ keepUrl: true, keepMembership: true, silent: true });

    app.code = code;
    app.meta = meta;
    app.members = {};
    app.presence = {};
    app.state = null;
    app.hand = null;
    app.enteredAt = Date.now();
    app.lastRendered = null;
    app.service = service || new RoomService(app.backend, code, app.uid);

    rememberRoom(code);
    resetLobbyForm();
    closeAllModals();

    const onWatchError = error => {
        if (app.code !== code) return;
        console.error('Ошибка подписки', error);
        toast('Нет доступа к данным комнаты. Проверьте Security Rules в Firebase.', 'error', 6000);
    };
    const forThisRoom = callback => value => {
        if (app.code !== code) return;
        callback(value);
    };

    app.unsubs.push(app.service.watchMeta(forThisRoom(onMeta), onWatchError));
    app.unsubs.push(app.service.watchMembers(forThisRoom(onMembers), onWatchError));
    app.unsubs.push(app.service.watchMember(app.uid, forThisRoom(onMyMembership), onWatchError));
    app.unsubs.push(app.service.watchPresence(forThisRoom(onPresence), onWatchError));
    app.unsubs.push(app.service.watchState(forThisRoom(onState), onWatchError));
    app.unsubs.push(app.service.watchHand(app.uid, forThisRoom(onHand), onWatchError));
    app.unsubs.push(app.backend.onValue(
        paths.error(code, app.uid),
        forThisRoom(onCommandError),
        onWatchError
    ));

    // Восстанавливаем presence после перезагрузки страницы: onDisconnect
    // регистрации Firebase живут только в рамках соединения.
    try {
        await app.backend.onDisconnectRemove(paths.presenceOf(code, app.uid));
        await app.service.markPresence(member && member.name);
        app.service.startHeartbeat();
    } catch (error) {
        console.warn('Не удалось отметить присутствие', error);
    }

    const isHost = meta && meta.hostUid === app.uid;
    if (isHost) {
        const hasLock = await acquireHostLock(code);
        if (!hasLock) {
            toast('Хост-режим уже открыт в другой вкладке этого браузера. Эта вкладка будет только смотреть; закройте лишнюю вкладку и обновите страницу.', 'error', 9000);
        } else {
            app.host = new HostController(app.backend, code, app.uid, {
                onError: error => {
                    console.error('Ошибка хоста', error);
                    toast(`Ошибка синхронизации: ${error.message || error}`, 'error', 7000);
                },
                onStateSaved: () => { /* подписка onState сама обновит UI */ }
            });
            try {
                await app.host.start();
            } catch (error) {
                console.error(error);
                toast(`Не удалось запустить хост-режим: ${error.message}`, 'error', 8000);
                app.host = null;
            }
        }
    }

    route(true);
}

// Один браузерный профиль = один анонимный uid. Если хост откроет две
// вкладки, обе попытаются запустить движок и начнут дублировать команды.
// Web Locks оставляет хост-режим только одной вкладке.
async function acquireHostLock(code) {
    if (!navigator.locks || !navigator.locks.request) return true;

    return new Promise(resolve => {
        let settled = false;
        navigator.locks.request(`shelter-host-${code}`, { ifAvailable: true }, async lock => {
            if (!lock) {
                settled = true;
                resolve(false);
                return;
            }
            settled = true;
            resolve(true);
            await new Promise(release => { app.hostLockRelease = release; });
        }).catch(() => {
            if (!settled) resolve(true);
        });
    });
}

async function cleanupRoom({ keepUrl = false, keepMembership = false, silent = false } = {}) {
    if (app.leaving) return;
    app.leaving = true;

    try {
        if (app.service) {
            app.service.stopHeartbeat(true);
            await app.service.markOffline();
        }
    } catch { /* ignore */ }

    app.unsubs.forEach(unsubscribe => {
        try { unsubscribe(); } catch { /* ignore */ }
    });
    app.unsubs = [];

    if (app.host) {
        try { await app.host.destroy(); } catch { /* ignore */ }
        app.host = null;
    }
    if (app.hostLockRelease) {
        try { app.hostLockRelease(); } catch { /* ignore */ }
        app.hostLockRelease = null;
    }

    if (app.backend && app.backend.mode === 'local' && app.service && app.code && app.uid) {
        try { app.backend.removeSync(paths.presenceOf(app.code, app.uid)); } catch { /* ignore */ }
    }

    app.service = null;
    app.code = null;
    app.meta = null;
    app.members = {};
    app.presence = {};
    app.state = null;
    app.hand = null;
    app.enteredAt = 0;
    app.lastRendered = null;
    app.lobbyCount = 0;
    app.expectMemberRemoval = false;
    app.lastLogId = null;
    app.logStartedAt = null;

    if (!keepUrl) clearRoomFromUrl();
    if (!silent) closeAllModals();

    app.leaving = false;
}

// ---------------------------------------------------------------------------
//  Обработчики синхронизации
// ---------------------------------------------------------------------------

function onMeta(meta) {
    if (app.leaving || app.expectMemberRemoval) return;
    if (!meta) {
        if (app.code) {
            toast('Хост закрыл комнату.', 'error');
            const mode = app.mode;
            cleanupRoom({ keepMembership: false, silent: true }).then(() => {
                clearStoredRoom(mode);
                showScreen('homeScreen');
            });
        }
        return;
    }

    app.meta = meta;
    route();
}

function onMembers(members) {
    if (app.leaving || app.expectMemberRemoval) return;
    app.members = members || {};
    const count = Object.keys(app.members).length;

    if (count > 0 && !app.members[app.uid] && app.code) {
        toast('Вас удалили из комнаты.', 'error');
        const mode = app.mode;
        cleanupRoom({ keepMembership: true, silent: true }).then(() => {
            clearStoredRoom(mode);
            showScreen('homeScreen');
        });
        return;
    }

    if (app.isHostRoom() && count !== app.lobbyCount) {
        app.service.updateMeta({ playerCount: count }).catch(() => { /* не критично */ });
    }
    app.lobbyCount = count;

    if (app.meta && app.meta.status === 'lobby') {
        renderLobby(app);
    } else {
        renderGame(app);
    }
}

function onPresence(presence) {
    if (app.leaving || app.expectMemberRemoval) return;
    app.presence = presence || {};
    if (app.meta && app.meta.status === 'lobby') renderLobby(app);
    else renderGame(app);
}

function onMyMembership(member) {
    if (app.leaving || app.expectMemberRemoval || !app.code) return;
    if (member) return;

    // Свою запись в members читает только сам игрок, поэтому её удаление —
    // надёжный сигнал, что хоста удалил нас или комната закрыта.
    toast('Вы больше не участник комнаты.', 'error');
    const mode = app.mode;
    cleanupRoom({ keepMembership: true, silent: true }).then(() => {
        clearStoredRoom(mode);
        showScreen('homeScreen');
    });
}

function onState(state) {
    if (app.leaving || app.expectMemberRemoval) return;
    app.state = normalizePublicState(state);
    notifyImportantLogs(app.state);
    route();
}

// Важные события приходят через общий журнал. Показываем всплывающее
// уведомление только для новых записей; при первом подключении и после
// перезапуска партии старые записи не спамят игрока.
function notifyImportantLogs(state) {
    if (!state) return;

    const entries = toArray(state.log);
    const maxId = entries.reduce((max, entry) => Math.max(max, Number(entry.id) || 0), 0);
    const startedAt = state.startedAt || 0;

    if (app.logStartedAt !== startedAt) {
        app.logStartedAt = startedAt;
        app.lastLogId = maxId;
        return;
    }

    if (app.lastLogId == null) {
        app.lastLogId = maxId;
        return;
    }

    const fresh = entries.filter(entry =>
        Number(entry.id) > app.lastLogId &&
        (entry.type === 'room' || entry.type === 'condition')
    );
    app.lastLogId = Math.max(app.lastLogId, maxId);

    fresh.forEach(entry => queueToast(entry.text, 'info', 7000));
}

// Realtime Database может вернуть массив как объект с числовыми ключами
// (например, если пустые элементы были опущены). Приводим публичное
// состояние к предсказуемому виду до рендера.
function normalizePublicState(state) {
    if (!state || typeof state !== 'object') return null;
    const normalized = Object.assign({}, state);
    normalized.players = toArray(state.players);
    normalized.log = toArray(state.log);
    normalized.rooms = toArray(state.rooms);
    normalized.voteRounds = toArray(state.voteRounds);
    normalized.discoveredRoomIds = toArray(state.discoveredRoomIds);
    normalized.openedRoomIds = toArray(state.openedRoomIds);
    if (state.vote) {
        normalized.vote = Object.assign({}, state.vote, {
            tally: toArray(state.vote.tally),
            candidateUids: toArray(state.vote.candidateUids),
            deciderCandidateUids: toArray(state.vote.deciderCandidateUids)
        });
    }
    return normalized;
}

function onHand(hand) {
    if (app.leaving || app.expectMemberRemoval) return;
    app.hand = hand;
    if (app.meta && app.meta.status !== 'lobby') renderGame(app);
}

function onCommandError(payload) {
    if (!payload || !payload.text) return;
    if (app.leaving || app.expectMemberRemoval) return;
    if (Number(payload.at) < app.enteredAt) return;
    toast(payload.text, 'error', 5000);
}

app.isHostRoom = function isHostRoom() {
    return !!(app.meta && app.meta.hostUid === app.uid);
};

// ---------------------------------------------------------------------------
//  Маршрутизация
// ---------------------------------------------------------------------------

function route(force = false) {
    if (!app.meta) return;

    const screen = app.meta.status === 'lobby' ? 'lobbyScreen' : 'gameScreen';
    const changed = app.lastRendered !== screen;

    if (changed || force) {
        showScreen(screen);
        if (changed) closeAllModals();
        app.lastRendered = screen;
    }

    if (screen === 'lobbyScreen') {
        renderLobby(app);
    } else {
        renderGame(app);
    }
}

async function kickPlayer(uid) {
    if (!app.isHostRoom() || !app.meta || app.meta.status !== 'lobby') return;
    const member = app.members && app.members[uid];
    if (!member) return;
    if (!confirm(`Удалить игрока «${member.name}» из комнаты?`)) return;

    try {
        await app.service.removeMember(uid);
        toast(`Игрок ${member.name} удалён из комнаты.`, 'success');
    } catch (error) {
        toast(error.message || 'Не удалось удалить игрока.', 'error');
    }
}

async function startGameFlow({ scenarioId, survivors, voteMode, voteRounds, voteQuotas, generation }) {
    if (!app.isHostRoom()) {
        toast('Начать игру может только хост.', 'error');
        return;
    }
    if (app.lobbyCount < 4) {
        toast('Нужно минимум 4 игрока.', 'error');
        return;
    }

    const button = $('startGameBtn');
    setButtonBusy(button, true, 'Начинаем…');
    try {
        await app.sendCommand('start', {
            scenarioId,
            survivors,
            voteMode,
            voteRounds,
            voteQuotas,
            generation
        });
    } catch (error) {
        toast(error.message || 'Не удалось начать игру.', 'error');
    } finally {
        setButtonBusy(button, false);
    }
}

// ---------------------------------------------------------------------------
//  Выход
// ---------------------------------------------------------------------------

async function leaveRoom() {
    if (!app.service || !app.meta) {
        showScreen('homeScreen');
        return;
    }

    app.expectMemberRemoval = true;
    const isHost = app.isHostRoom();
    const inLobby = app.meta.status === 'lobby';

    if (inLobby && isHost) {
        if (!confirm('Закрыть комнату для всех игроков?')) {
            app.expectMemberRemoval = false;
            return;
        }
        try {
            await app.service.deleteRoom();
        } catch (error) {
            toast(error.message || 'Не удалось закрыть комнату.', 'error');
            app.expectMemberRemoval = false;
            return;
        }
        await cleanupRoom({ keepMembership: true });
        clearStoredRoom(app.mode);
        showScreen('homeScreen');
        toast('Комната закрыта.', 'success');
        return;
    }

    if (inLobby) {
        if (!confirm('Выйти из комнаты?')) {
            app.expectMemberRemoval = false;
            return;
        }
        try {
            await app.service.leaveLobby();
        } catch { /* ignore */ }
        await cleanupRoom({ keepMembership: true });
        clearStoredRoom(app.mode);
        showScreen('homeScreen');
        return;
    }

    const warning = isHost
        ? 'Выйти из партии? Вы хост — игра остановится, пока вы не вернётесь по ссылке-приглашению.'
        : 'Выйти из партии? Вы сможете вернуться по ссылке-приглашению, ваше место сохранится.';
    if (!confirm(warning)) {
        app.expectMemberRemoval = false;
        return;
    }

    await cleanupRoom({ keepMembership: true });
    clearStoredRoom(app.mode);
    showScreen('homeScreen');
}

// ---------------------------------------------------------------------------
//  URL и localStorage
// ---------------------------------------------------------------------------

function setRoomInUrl(code) {
    const url = new URL(location.href);
    url.searchParams.set('room', code);
    if (app.mode === 'local') url.searchParams.set('local', '1');
    history.replaceState(null, '', url);
}

function clearRoomFromUrl() {
    const url = new URL(location.href);
    url.searchParams.delete('room');
    history.replaceState(null, '', url);
}

function rememberRoom(code) {
    try {
        localStorage.setItem(ROOM_KEY_PREFIX + app.mode, code);
        localStorage.setItem(LAST_ROOM_KEY, code);
    } catch { /* ignore */ }
}

function clearStoredRoom(mode) {
    try {
        localStorage.removeItem(ROOM_KEY_PREFIX + (mode || app.mode));
        localStorage.removeItem(LAST_ROOM_KEY);
    } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
//  Закрытие вкладки: снимаем присутствие
// ---------------------------------------------------------------------------

window.addEventListener('pagehide', () => {
    if (!app.service) return;
    try { app.service.stopHeartbeat(true); } catch { /* ignore */ }
    app.service.markOffline();
});

// При возврате из bfcache или из фона heartbeat мог остановиться.
window.addEventListener('pageshow', event => {
    if (!event.persisted || !app.service) return;
    app.service.markPresence().catch(() => { /* ignore */ });
    app.service.startHeartbeat();
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden || !app.service) return;
    app.service.markPresence().catch(() => { /* ignore */ });
});

// Полезно для отладки в консоли.
window.__shelter = { app, FIREBASE_VERSION, toArray };
