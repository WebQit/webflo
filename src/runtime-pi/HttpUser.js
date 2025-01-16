import { _isObject } from '@webqit/util/js/index.js';
import { WebfloStorage } from './WebfloStorage.js';

export class HttpUser extends WebfloStorage {
    
    static create(request, session, client) {
        return new this(request, session, client);
    }

    #session;
    #client;

    constructor(request, session, client) {
        super(request);
        this.#session = session;
        this.#client = client;
        // Trigger this
        this.#dict;
    }

    get #dict() {
        if (!this.#session.has('user')) {
            this.#session.set('user', {});
        }
        return this.#session.get('user');
    }

    [ Symbol.iterator ]() { return this.entries()[ Symbol.iterator ](); }

    get size() { return Object.keys(this.#dict).length; }

    set(key, value) {
        Reflect.set(this.#dict, key, value);
        return this;
    }

    get(key) {
        return Reflect.get(this.#dict, key);
    }

    has(key) {
        return Reflect.has(this.#dict, key);
    }

    delete(key) {
        return Reflect.deleteProperty(this.#dict, key);
    }

    keys() {
        return Object.keys(this.#dict);
    }

    values() {
        return Object.values(this.#dict);
    }

    entries() {
        return Object.entries(this.#dict);
    }

    clear() {
        for (const key of this.keys()) {
            Reflect.deleteProperty(this.#dict, key);
        }
    }

    forEach(callback) {
        this.entries().forEach(callback);
    }

    json(arg = null) {
        if (!arguments.length || typeof arg === 'boolean') {
            return {...this.#dict};
        }
        if (!_isObject(arg)) {
            throw new Error(`Argument must be a valid JSON object`);
        }
        Object.assign(this.#dict, arg);
    }

    isSignedIn() {
        return this.has('id');
    }

    async signIn(...args) {
        return await this.require(
            ['id'].concat(typeof args[0] === 'string' || Array.isArray(args[0]) ? args.unshift() : []),
            ...args
        );
    }

    async signOut() {
        const handler = this.getHandlers().get('id')?.[1];
        let response;
        if (typeof handler === 'string') {
            response = new Response(null, { status: 302, headers: {
                Location: url
            }});
        }
        if (typeof handler === 'function') {
            response = await handler(this);
        }
        this.clear();
        return response;
    }

    confirm(data, callback, options = {}) {
        return new Promise((resolve) => {
            this.#client.postRequest(
                data,
                (event) => resolve(callback ? callback(event) : event),
                { ...options, messageType: 'confirm' }
            );
        });
    }

    prompt(data, callback, options = {}) {
        return new Promise((resolve) => {
            this.#client.postRequest(
                data,
                (event) => resolve(callback ? callback(event) : event),
                { ...options, messageType: 'prompt' }
            );
        });
    }
}