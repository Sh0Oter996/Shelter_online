'use strict';

// ============================================================================
//  Хост-контроллер
//  Единственный, кто пишет игровое состояние. Слушает очередь команд
//  /rooms/{code}/commands, применяет их движком и публикует:
//    - hostState  (полное состояние, секретно, только хост)
//    - state      (публичная проекция для всех)
//    - hand/{uid} (приватная рука каждого игрока)
// ============================================================================

import { paths } from './backend.js';
import {
    applyCommand,
    buildPublicState,
    buildHand,
    createLobbyState,
    normalizeState
} from '../game/engine.js';
import { toArray } from '../utils.js';

export class HostController {
    constructor(backend, code, uid, handlers = {}) {
        this.backend = backend;
        this.code = code;
        this.uid = uid;
        this.onError = handlers.onError || (() => {});
        this.onStateSaved = handlers.onStateSaved || (() => {});
        this.state = null;
        this.queue = Promise.resolve();
        this.unsubscribeCommands = null;
        this.handUids = new Set();
        this.destroyed = false;
    }

    async start() {
        const saved = await this.backend.get(paths.hostState(this.code));
        const normalized = saved ? normalizeState(saved) : null;

        if (!saved) {
            const meta = await this.backend.get(paths.meta(this.code));
            if (meta && meta.status && meta.status !== 'lobby') {
                throw new Error('Состояние партии не найдено в базе. Возможно, база была очищена или правила запрещают запись hostState.');
            }
        }

        if (normalized && normalized.code === this.code && normalized.hostUid === this.uid) {
            this.state = normalized;
            this.handUids = new Set(normalized.players.map(p => p.uid));
        } else {
            this.state = createLobbyState({ code: this.code, hostUid: this.uid });
        }

        await this.publish();
        this.unsubscribeCommands = this.backend.onChildAdded(
            paths.commands(this.code),
            (command, key) => this.enqueue(command, key),
            error => this.onError(error)
        );
    }

    enqueue(command, key) {
        if (this.destroyed) return;
        this.queue = this.queue
            .then(() => this.process(command, key))
            .catch(error => {
                console.error('Ошибка обработки команды', error);
                this.onError(error);
            });
    }

    async process(command, key) {
        if (this.destroyed) return;

        try {
            if (!command || command.uid == null || !command.type) return;

            const processed = toArray(this.state.processedCommands);
            if (key && processed.includes(key)) {
                // Команда уже применялась: хост перезагрузился до её удаления.
                return;
            }

            const members = await this.backend.get(paths.members(this.code)) || {};
            const result = applyCommand(this.state, command, { members });

            if (result.ok) {
                this.state = normalizeState(result.state);
                if (key) {
                    this.state.processedCommands = [...processed, key].slice(-100);
                }
                this.state.updatedAt = Date.now();
                await this.publish();
                this.onStateSaved(this.state);
            } else {
                console.warn('Команда отклонена:', result.error);
                await this.reportError(command.uid, result.error);
            }
        } catch (error) {
            console.error('Ошибка применения команды', error);
            await this.reportError(command && command.uid, 'Не удалось применить действие. Попробуйте ещё раз.');
        } finally {
            if (key) {
                try { await this.backend.remove(paths.command(this.code, key)); }
                catch (error) { console.warn('Не удалось удалить команду', error); }
            }
        }
    }

    async reportError(uid, text) {
        if (!uid) return;
        try {
            await this.backend.set(paths.error(this.code, uid), {
                text: String(text || 'Действие отклонено.').slice(0, 200),
                at: Date.now()
            });
        } catch (error) {
            console.warn('Не удалось передать ошибку игроку', error);
        }
    }

    async publish() {
        const state = this.state;
        const publicState = buildPublicState(state);
        publicState.updatedAt = Date.now();
        state.updatedAt = publicState.updatedAt;

        const updates = {
            hostState: state,
            state: publicState,
            'meta/status': state.status,
            'meta/updatedAt': publicState.updatedAt
        };

        if (state.scenarioId) updates['meta/scenarioId'] = state.scenarioId;
        if (state.players.length > 0) updates['meta/playerCount'] = state.players.length;

        const nextHands = new Set();
        state.players.forEach(player => {
            updates[`hand/${player.uid}`] = buildHand(state, player.uid);
            nextHands.add(player.uid);
        });

        // При перезапуске убираем руки игроков прошлой партии.
        this.handUids.forEach(uid => {
            if (!nextHands.has(uid)) updates[`hand/${uid}`] = null;
        });
        this.handUids = nextHands;

        await this.backend.update(paths.room(this.code), updates);
    }

    async destroy() {
        this.destroyed = true;
        if (this.unsubscribeCommands) {
            try { this.unsubscribeCommands(); } catch { /* ignore */ }
            this.unsubscribeCommands = null;
        }
        await this.queue.catch(() => {});
    }
}
