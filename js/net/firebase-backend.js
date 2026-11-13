'use strict';

// ============================================================================
//  Firebase Realtime Database backend
//  SDK загружается с CDN только когда нужен облачный режим, поэтому локальный
//  режим продолжает работать даже при заблокированном gstatic.com.
// ============================================================================

import { firebaseConfig } from '../../firebase-config.js';
import { pathGet, pathSet, isPathAffected } from './backend.js';

export const FIREBASE_VERSION = '11.0.2';
const CDN = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;

function friendlyAuthError(error) {
    const code = error && error.code ? String(error.code) : '';
    if (code === 'auth/operation-not-allowed') {
        return Object.assign(new Error(
            'Анонимный вход выключен. В Firebase Console откройте Authentication → Sign-in method и включите Anonymous.'
        ), { code });
    }
    if (code === 'auth/invalid-api-key') {
        return Object.assign(new Error('Неверный apiKey в firebase-config.js.'), { code });
    }
    if (code === 'auth/network-request-failed') {
        return Object.assign(new Error('Нет связи с Firebase. Проверьте интернет и настройки проекта.'), { code });
    }
    return error;
}

export async function createFirebaseBackend() {
    if (!firebaseConfig || !firebaseConfig.databaseURL || !firebaseConfig.apiKey) {
        throw Object.assign(new Error('firebase-config.js не заполнен.'), { code: 'config/missing' });
    }

    const [appModule, authModule, databaseModule] = await Promise.all([
        import(`${CDN}/firebase-app.js`),
        import(`${CDN}/firebase-auth.js`),
        import(`${CDN}/firebase-database.js`)
    ]);

    const app = appModule.initializeApp(firebaseConfig);
    const auth = authModule.getAuth(app);
    try { auth.languageCode = 'ru'; } catch { /* не критично */ }

    let user = null;
    try {
        await auth.authStateReady();
        user = auth.currentUser;
        if (!user) {
            const credential = await authModule.signInAnonymously(auth);
            user = credential.user;
        }
    } catch (error) {
        throw friendlyAuthError(error);
    }

    if (!user) throw new Error('Не удалось войти анонимно.');
    const database = databaseModule.getDatabase(app);

    return new FirebaseBackend(databaseModule, database, user.uid);
}

class FirebaseBackend {
    constructor(sdk, database, uid) {
        this.sdk = sdk;
        this.db = database;
        this.uid = uid;
        this.mode = 'firebase';
    }

    async get(path) {
        const snapshot = await this.sdk.get(this.sdk.ref(this.db, path));
        return snapshot.exists() ? snapshot.val() : null;
    }

    async set(path, value) {
        await this.sdk.set(this.sdk.ref(this.db, path), value == null ? null : value);
    }

    async update(path, values) {
        const clean = {};
        Object.keys(values || {}).forEach(key => {
            if (values[key] !== undefined) clean[key] = values[key];
        });
        if (Object.keys(clean).length === 0) return;
        await this.sdk.update(this.sdk.ref(this.db, path), clean);
    }

    async remove(path) {
        await this.sdk.remove(this.sdk.ref(this.db, path));
    }

    async push(path, value) {
        const ref = this.sdk.push(this.sdk.ref(this.db, path), value);
        await ref;
        return ref.key;
    }

    onValue(path, callback, onError) {
        return this.sdk.onValue(
            this.sdk.ref(this.db, path),
            snapshot => callback(snapshot.exists() ? snapshot.val() : null),
            error => { if (onError) onError(error); }
        );
    }

    onChildAdded(path, callback, onError) {
        return this.sdk.onChildAdded(
            this.sdk.ref(this.db, path),
            snapshot => callback(snapshot.val(), snapshot.key),
            error => { if (onError) onError(error); }
        );
    }

    onDisconnectRemove(path) {
        return this.sdk.onDisconnect(this.sdk.ref(this.db, path)).remove();
    }

    serverTimestamp() {
        return this.sdk.serverTimestamp();
    }

    async close() {
        // Соединение закрывать не нужно: Firebase сам управляет сокетом.
    }
}

// ---------------------------------------------------------------------------
//  Локальный backend: несколько вкладок одного браузера.
//  Нужен, чтобы проверить мультиплеер до настройки Firebase.
// ---------------------------------------------------------------------------

const LOCAL_DB_KEY = 'shelter.localdb.v1';
const LOCAL_CHANNEL = 'shelter.localdb.v1';

export async function createLocalBackend() {
    let uid = null;
    try { uid = sessionStorage.getItem('shelter.local.uid'); } catch { /* private mode */ }
    if (!uid) {
        uid = `local-${Math.random().toString(36).slice(2, 10)}`;
        try { sessionStorage.setItem('shelter.local.uid', uid); } catch { /* ignore */ }
    }
    return new LocalBackend(uid);
}

class LocalBackend {
    constructor(uid) {
        this.uid = uid;
        this.mode = 'local';
        this.listeners = new Set();
        this.tree = this.readTree();

        try {
            this.channel = new BroadcastChannel(LOCAL_CHANNEL);
            this.channel.onmessage = event => {
                if (!event.data || !event.data.paths) return;
                this.tree = this.readTree();
                this.notify(event.data.paths);
            };
        } catch {
            this.channel = null;
        }

        try {
            window.addEventListener('storage', event => {
                if (event.key !== LOCAL_DB_KEY) return;
                this.tree = this.readTree();
                this.notify(['']);
            });
        } catch { /* ignore */ }
    }

    readTree() {
        try {
            const raw = localStorage.getItem(LOCAL_DB_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch {
            return {};
        }
    }

    writeTree(tree, changedPaths) {
        this.tree = tree;
        try { localStorage.setItem(LOCAL_DB_KEY, JSON.stringify(tree)); } catch (error) {
            console.error('Локальное хранилище переполнено', error);
            throw new Error('Не хватает места в localStorage. Очистите данные сайта и попробуйте снова.');
        }
        if (this.channel) {
            try { this.channel.postMessage({ paths: changedPaths }); } catch { /* ignore */ }
        }
        this.notify(changedPaths);
    }

    notify(changedPaths) {
        const paths = changedPaths && changedPaths.length ? changedPaths : [''];
        this.listeners.forEach(listener => {
            const affected = paths.some(changed => isPathAffected(listener.path, changed));
            if (!affected) return;

            if (listener.type === 'value') {
                try { listener.callback(pathGet(this.tree, listener.path)); }
                catch (error) { console.error('Ошибка обработчика onValue', error); }
                return;
            }

            const children = pathGet(this.tree, listener.path);
            if (!children || typeof children !== 'object') return;
            Object.keys(children).forEach(key => {
                if (listener.seen.has(key)) return;
                listener.seen.add(key);
                const value = children[key];
                if (value == null) return;
                try { listener.callback(value, key); }
                catch (error) { console.error('Ошибка обработчика onChildAdded', error); }
            });
        });
    }

    async get(path) {
        this.tree = this.readTree();
        return pathGet(this.tree, path);
    }

    async set(path, value) {
        const tree = this.readTree();
        pathSet(tree, path, value == null ? null : value);
        this.writeTree(tree, [path]);
    }

    async update(path, values) {
        const tree = this.readTree();
        const changed = [];
        Object.keys(values || {}).forEach(key => {
            if (values[key] === undefined) return;
            const childPath = `${path}/${key}`.replace(/\/+/g, '/');
            pathSet(tree, childPath, values[key] == null ? null : values[key]);
            changed.push(childPath);
        });
        if (changed.length === 0) return;
        this.writeTree(tree, changed);
    }

    async remove(path) {
        const tree = this.readTree();
        pathSet(tree, path, null);
        this.writeTree(tree, [path]);
    }

    async push(path, value) {
        const key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        const tree = this.readTree();
        pathSet(tree, `${path}/${key}`, value);
        this.writeTree(tree, [`${path}/${key}`]);
        return key;
    }

    onValue(path, callback, onError) {
        const listener = { type: 'value', path, callback, onError };
        this.listeners.add(listener);
        queueMicrotask(() => {
            if (!this.listeners.has(listener)) return;
            try { callback(pathGet(this.readTree(), path)); }
            catch (error) { if (onError) onError(error); }
        });
        return () => this.listeners.delete(listener);
    }

    onChildAdded(path, callback) {
        const listener = { type: 'child', path, callback, seen: new Set() };
        this.listeners.add(listener);
        queueMicrotask(() => {
            if (!this.listeners.has(listener)) return;
            const children = pathGet(this.readTree(), path);
            if (!children || typeof children !== 'object') return;
            Object.keys(children).forEach(key => {
                if (listener.seen.has(key)) return;
                listener.seen.add(key);
                if (children[key] != null) callback(children[key], key);
            });
        });
        return () => this.listeners.delete(listener);
    }

    onDisconnectRemove() {
        return Promise.resolve();
    }

    serverTimestamp() {
        return Date.now();
    }

    removeSync(path) {
        try {
            const tree = this.readTree();
            pathSet(tree, path, null);
            localStorage.setItem(LOCAL_DB_KEY, JSON.stringify(tree));
            this.tree = tree;
            if (this.channel) this.channel.postMessage({ paths: [path] });
        } catch { /* ignore */ }
    }

    async close() {
        if (this.channel) {
            try { this.channel.close(); } catch { /* ignore */ }
        }
        this.listeners.clear();
    }
}
