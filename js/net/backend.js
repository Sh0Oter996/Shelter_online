'use strict';

// ============================================================================
//  Доступ к данным комнаты
//  Все пути собраны в одном месте, чтобы движок и UI не зависели от Firebase.
// ============================================================================

export const paths = {
    room: code => `rooms/${code}`,
    meta: code => `rooms/${code}/meta`,
    members: code => `rooms/${code}/members`,
    member: (code, uid) => `rooms/${code}/members/${uid}`,
    presence: code => `rooms/${code}/presence`,
    presenceOf: (code, uid) => `rooms/${code}/presence/${uid}`,
    state: code => `rooms/${code}/state`,
    hand: (code, uid) => `rooms/${code}/hand/${uid}`,
    hostState: code => `rooms/${code}/hostState`,
    commands: code => `rooms/${code}/commands`,
    command: (code, key) => `rooms/${code}/commands/${key}`,
    error: (code, uid) => `rooms/${code}/errors/${uid}`
};

export function pathGet(tree, path) {
    if (!path) return tree;
    const parts = String(path).split('/').filter(Boolean);
    let current = tree;
    for (const part of parts) {
        if (current == null || typeof current !== 'object') return null;
        current = current[part];
    }
    return current === undefined ? null : current;
}

export function pathSet(tree, path, value) {
    const parts = String(path).split('/').filter(Boolean);
    if (parts.length === 0) return value == null ? {} : value;

    let current = tree;
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (current[part] == null || typeof current[part] !== 'object') current[part] = {};
        current = current[part];
    }

    const last = parts[parts.length - 1];
    if (value == null) delete current[last];
    else current[last] = value;
    return tree;
}

export function isPathAffected(listenerPath, changedPath) {
    const listener = String(listenerPath || '').replace(/^\/+|\/+$/g, '');
    const changed = String(changedPath || '').replace(/^\/+|\/+$/g, '');
    if (!listener || !changed) return true;
    return changed === listener ||
        changed.startsWith(listener + '/') ||
        listener.startsWith(changed + '/');
}
