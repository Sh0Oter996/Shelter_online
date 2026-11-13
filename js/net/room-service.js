'use strict';

// ============================================================================
//  Сервис комнаты: создание, вход, подписки, присутствие и команды.
// ============================================================================

import { paths } from './backend.js';
import { normalizeName, normalizeCode } from '../utils.js';

export class RoomService {
    constructor(backend, code, uid) {
        this.backend = backend;
        this.code = code;
        this.uid = uid;
        this.heartbeatTimer = null;
        this.presenceName = '';
    }

    async createRoom({ name, code, scenarioId = 'random', survivors = 2 }) {
        const cleanName = normalizeName(name, 'Хост');
        const now = Date.now();
        const safeSurvivors = Math.max(1, Math.min(15, parseInt(survivors, 10) || 2));
        const meta = {
            hostUid: this.uid,
            status: 'lobby',
            createdAt: now,
            updatedAt: now,
            playerCount: 1,
            scenarioId: String(scenarioId || 'random').slice(0, 40),
            survivors: safeSurvivors
        };

        await this.backend.set(paths.room(code), {
            meta,
            members: {
                [this.uid]: { name: cleanName, joinedAt: now, isHost: true }
            },
            presence: {
                [this.uid]: { online: true, at: now, name: cleanName }
            }
        });

        this.presenceName = cleanName;
        await this.backend.onDisconnectRemove(paths.presenceOf(code, this.uid));
        this.startHeartbeat();
    }

    async joinRoom({ name }) {
        const cleanName = normalizeName(name, 'Игрок');
        const meta = await this.backend.get(paths.meta(this.code));
        if (!meta) {
            throw new Error('Комната с таким кодом не найдена. Проверьте код и попробуйте снова.');
        }

        const existing = await this.backend.get(paths.member(this.code, this.uid));
        if (existing) {
            this.presenceName = existing.name || cleanName;
            await this.markPresence(this.presenceName);
            return { resumed: true, meta, member: existing };
        }

        if (meta.status !== 'lobby') {
            throw new Error('Игра в этой комнате уже началась. Попросите хоста создать новую комнату.');
        }
        if (Number(meta.playerCount) >= 15) {
            throw new Error('В комнате уже 15 игроков — это максимум.');
        }

        const now = Date.now();
        await this.backend.set(paths.member(this.code, this.uid), {
            name: cleanName,
            joinedAt: now,
            isHost: false
        });
        await this.backend.onDisconnectRemove(paths.presenceOf(this.code, this.uid));
        this.presenceName = cleanName;
        await this.markPresence(cleanName);
        this.startHeartbeat();

        return { resumed: false, meta, member: { name: cleanName, joinedAt: now } };
    }

    async markPresence(name) {
        this.presenceName = name || this.presenceName;
        await this.backend.set(paths.presenceOf(this.code, this.uid), {
            online: true,
            at: Date.now(),
            name: this.presenceName
        });
    }

    startHeartbeat() {
        this.stopHeartbeat(false);
        this.heartbeatTimer = setInterval(() => {
            if (!this.code || !this.uid) return;
            this.markPresence().catch(() => { /* сеть мигнула — попробуем в следующий раз */ });
        }, 20000);
    }

    stopHeartbeat(removePresence = true) {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        if (removePresence && this.backend.mode === 'local' && this.code && this.uid) {
            if (typeof this.backend.removeSync === 'function') {
                this.backend.removeSync(paths.presenceOf(this.code, this.uid));
            }
        }
    }

    watchMeta(callback, onError) {
        return this.backend.onValue(paths.meta(this.code), callback, onError);
    }

    watchMembers(callback, onError) {
        return this.backend.onValue(paths.members(this.code), callback, onError);
    }

    watchMember(uid, callback, onError) {
        return this.backend.onValue(paths.member(this.code, uid), callback, onError);
    }

    watchPresence(callback, onError) {
        return this.backend.onValue(paths.presence(this.code), callback, onError);
    }

    watchState(callback, onError) {
        return this.backend.onValue(paths.state(this.code), callback, onError);
    }

    watchHand(uid, callback, onError) {
        return this.backend.onValue(paths.hand(this.code, uid), callback, onError);
    }

    watchCommands(onCommand, onError) {
        return this.backend.onChildAdded(paths.commands(this.code), onCommand, onError);
    }

    async sendCommand(type, payload = {}) {
        if (!this.code) throw new Error('Комната не выбрана.');
        await this.backend.push(paths.commands(this.code), {
            uid: this.uid,
            type: String(type),
            payload: payload || {},
            at: Date.now()
        });
    }

    async updateMeta(values) {
        await this.backend.update(paths.meta(this.code), values);
    }

    async getMembers() {
        return this.backend.get(paths.members(this.code));
    }

    async removeMember(uid) {
        if (!uid || uid === this.uid) return;
        try { await this.backend.remove(paths.presenceOf(this.code, uid)); } catch { /* ignore */ }
        await this.backend.remove(paths.member(this.code, uid));
    }

    async leaveLobby() {
        this.stopHeartbeat(true);
        try { await this.backend.remove(paths.member(this.code, this.uid)); } catch { /* ignore */ }
        try { await this.backend.remove(paths.presenceOf(this.code, this.uid)); } catch { /* ignore */ }
    }

    async deleteRoom() {
        this.stopHeartbeat(true);
        await this.backend.remove(paths.room(this.code));
    }

    async markOffline() {
        if (this.backend.mode === 'local') {
            if (typeof this.backend.removeSync === 'function') {
                this.backend.removeSync(paths.presenceOf(this.code, this.uid));
            }
            return;
        }
        try {
            await this.backend.remove(paths.presenceOf(this.code, this.uid));
        } catch { /* ignore */ }
    }
}

export async function isCodeFree(backend, code) {
    const meta = await backend.get(paths.meta(normalizeCode(code)));
    return !meta;
}
