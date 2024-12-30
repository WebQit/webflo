import { AbstractStorage } from '../AbstractStorage.js';

export class SessionStorage extends AbstractStorage {

    static create(request, options, runtime) {
        if (!runtime.__sessionStore) Object.defineProperty(runtime, '__sessionStore', { value: new Map });
        const sessionID = request.headers.get('Cookie', true).find((c) => c.name === '__sessid')?.value || `~${(0 | Math.random() * 9e6).toString(36)}`;
        if (runtime.__sessionStore.has(sessionID)) {
            return runtime.__sessionStore.get(sessionID);
        }
        const instance = new this;
        runtime.__sessionStore.set(sessionID, instance);
        instance.#sessid = sessionID;
        return instance;
    }

    #sessid;

    commit(response) {
        if (!this.getAdded().length && !this.getDeleted().length) return;
        return response.headers.append('Set-Cookie', `__sessid=${this.#sessid}; Path=/; expires=Tue, 29 Oct 2026 16:56:32 GMT`);
    }
}