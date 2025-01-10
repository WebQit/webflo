import { _any } from '@webqit/util/arr/index.js';
import { _isObject } from '@webqit/util/js/index.js';
import { pattern } from '../../util-url.js';
import { AbstractController } from '../../AbstractController.js';
import { CookieStorage } from './CookieStorage.js';
import { SessionStorage } from './SessionStorage.js';
import { HttpEvent } from '../../HttpEvent.js';
import { HttpUser } from '../../HttpUser.js';
import { Workport } from './Workport.js';
import { Context } from './Context.js';
import { Router } from '../Router.js';
import xfetch from '../../xfetch.js';
import '../../util-http.js';
import { PortMessagingAPI } from '../../PortMessagingAPI.js';
import { ClientPort } from './ClientPort.js';

export class WebfloWorker extends AbstractController {

	static get Context() { return Context; }

	static get Router() { return Router; }

	static get HttpEvent() { return HttpEvent; }

	static get CookieStorage() { return CookieStorage; }

	static get SessionStorage() { return SessionStorage; }

    static get HttpUser() { return HttpUser; }

	static get Workport() { return Workport; }

	static create(cx) {
        return new this(this.Context.create(cx));
    }

	#cx;
	get cx() { return this.#cx; }

	constructor(cx) {
		super();
		if (!(cx instanceof this.constructor.Context)) {
			throw new Error('Argument #1 must be a Webflo Context instance');
		}
		this.#cx = cx;
	}

	initialize() {
		// ONINSTALL
		const installHandler = (event) => {
			if (this.cx.params.skip_waiting) self.skipWaiting();
			// Manage CACHE
			if (this.cx.params.cache_name && (this.cx.params.cache_only_urls || []).length) {
				// Add files to cache
				event.waitUntil(self.caches.open(this.cx.params.cache_name).then(async cache => {
					if (this.cx.logger) { this.cx.logger.log('[ServiceWorker] Pre-caching resources.'); }
					for (const urls of [ 'cache_first_urls', 'cache_only_urls' ]) {
						const _urls = (this.cx.params[urls] || []).map(c => c.trim()).filter(c => c && !pattern(c, self.origin).isPattern());
						await cache.addAll(_urls);
					}
				}));
			}
		};
		// ONACTIVATE
		const activateHandler = (event) => {
			event.waitUntil(new Promise(async resolve => {
				if (this.cx.params.skip_waiting) { await self.clients.claim(); }
				// Manage CACHE
				if (this.cx.params.cache_name) {
					// Clear outdated CACHES
					await self.caches.keys().then(keyList => {
						return Promise.all(keyList.map(key => {
							if (key !== this.cx.params.cache_name && key !== this.cx.params.cache_name + '_json') {
								if (this.cx.logger) { this.cx.logger.log('[ServiceWorker] Removing old cache:', key); }
								return self.caches.delete(key);
							}
						}));
					}) 
				}
				resolve();
			}));
		};
		self.addEventListener('install', installHandler);
		self.addEventListener('activate', activateHandler);
		const uncontrols = this.control();
        return () => {
            self.removeEventListener('install', installHandler);
            self.removeEventListener('activate', activateHandler);
			uncontrols();
        };
	}

	control() {
		// ONFETCH
		const fetchHandler = (event) => {
			// URL schemes that might arrive here but not supported; e.g.: chrome-extension://
			if (!event.request.url.startsWith('http')) return;
			// Handle external requests
			if (!event.request.url.startsWith(self.origin)) {
				return event.respondWith(this.remoteFetch(event.request));
			}
			if (event.request.mode === 'navigate' || event.request.cache === 'force-cache'/* && event.request.mode === 'navigate' - even webflo client init call also comes with that... needs investigation */) {
				// Now, the following is key:
				// The browser likes to use "force-cache" for "navigate" requests, when, e.g: re-entering your site with the back button
				// Problem here, force-cache forces out JSON not HTML as per webflo's design.
				// So, we detect this scenerio and avoid it.
				event.respondWith((async (event) => {
					const { url, ...requestInit } = await Request.copy(event.request);
					requestInit.cache = 'default';
					return await this.navigate(url, requestInit, { event });
				})(event));
			} else {
				event.respondWith(this.navigate(event.request.url, event.request, { event }));
			}
		};
		self.addEventListener('fetch', fetchHandler);
        return () => {
            self.removeEventListener('fetch', fetchHandler);
        };
	}

    createRequest(href, init = {}) {
		return new Request(href, init);
    }

	async navigate(url, init = {}, detail = {}) {
		// Resolve inputs
        const scope = { url, init, detail };
		if (typeof scope.url === 'string') {
			scope.url = new URL(scope.url, self.location.origin);
		}
		scope.response = await new Promise(async (resolveResponse) => {
            scope.handleRespondWith = async (response) => {
				if (scope.finalResponseSeen) {
                    throw new Error('Final response already sent');
                }
                if (scope.initialResponseSeen) {
                    return await this.execPush(scope.clientPort, response);
                }
				response = await this.normalizeResponse(scope.httpEvent, response, true);
                resolveResponse(response);
			};
			// Create and route request
			scope.request = this.createRequest(scope.url, scope.init);
			scope.cookies = this.constructor.CookieStorage.create(scope.request);
			scope.session = this.constructor.SessionStorage.create(scope.request, { secret: this.cx.env.entries.SESSION_KEY });
			const portID = crypto.randomUUID();
			scope.clientPort = new ClientPort(portID);
			scope.user = this.constructor.HttpUser.create(
				scope.request,
				scope.session,
				scope.clientPort
			);
			scope.httpEvent = this.constructor.HttpEvent.create(scope.handleRespondWith, {
                request: scope.request,
                detail: scope.detail,
                cookies: scope.cookies,
                session: scope.session,
                user: scope.user,
                client: scope.clientPort
            });
			// Dispatch for response
			scope.$response = await this.dispatch(scope.httpEvent, {}, async (event) => {
				// Was this nexted()? Tell the next layer we're in JSON mode by default
				if (event !== scope.httpEvent && !event.request.headers.has('Accept')) {
					event.request.headers.set('Accept', 'application/json');
				}
				return await this.remoteFetch(event.request);
			});
			// Final reponse!!!
            scope.finalResponseSeen = true;
            if (scope.initialResponseSeen) {
                // Send via background port
                if (typeof scope.$response !== 'undefined') {
					await this.execPush(scope.clientPort, scope.$response);
                }
                return;
            }
			// Send normally
            // Has background activities?
            if (scope.clientPort.isMessaging()) {
                scope.$response = await this.normalizeResponse(scope.httpEvent, scope.$response, true);
                scope.$response.headers.set('X-Background-Activity', `ch:${scope.clientPort.portID}`);
            } else {
                scope.$response = await this.normalizeResponse(scope.httpEvent, scope.$response);
				scope.clientPort.close();
            }
			resolveResponse(scope.$response);
		});
		scope.initialResponseSeen = true;
		return scope.response;
	}

	async remoteFetch(request, ...args) {
		if (arguments.length > 1) {
			request = this.createRequest(request, ...args);
		}
		const scope = {};
		const matchUrl = (patterns, url) => _any((patterns || []).map(p => p.trim()).filter(p => p), p => pattern(p, self.origin).test(url));
		if (matchUrl(this.cx.params.cache_only_urls, request.url)) {
			scope.strategy = 'cache-only';
			scope.response = this.cacheFetch(request, { networkFallback: false, cacheRefresh: false });
		} else if (matchUrl(this.cx.params.network_only_urls, request.url)) {
			scope.strategy = 'network-only';
			scope.response = this.networkFetch(request, { cacheFallback: false, cacheRefresh: false });
		} else if (matchUrl(this.cx.params.cache_first_urls, request.url)) {
			scope.strategy = 'cache-first';
			scope.response = this.cacheFetch(request, { networkFallback: true, cacheRefresh: true });
		} else if (matchUrl(this.cx.params.network_first_urls, request.url) || !this.cx.params.default_fetching_strategy) {
			scope.strategy = 'network-first';
			scope.response = this.networkFetch(request, { cacheFallback: true, cacheRefresh: true });
		} else {
			scope.strategy = this.cx.params.default_fetching_strategy;
			switch (this.cx.params.default_fetching_strategy) {
				case 'cache-only':
					scope.response = this.cacheFetch(request, { networkFallback: false, cacheRefresh: false });
					break;
				case 'network-only':
					scope.response = this.networkFetch(request, { cacheFallback: false, cacheRefresh: false });
					break;
				case 'cache-first':
					scope.response = this.cacheFetch(request, { networkFallback: true, cacheRefresh: true });
					break;
				case 'network-first':
					scope.response = this.networkFetch(request, { cacheFallback: true, cacheRefresh: true });
					break;
			}
		}
		return await scope.response;
	}

	async networkFetch(request, params = {}) {
		if (!params.cacheFallback) {
			return xfetch(request);
		}
		return xfetch(request).then((response) => {
			if (params.cacheRefresh) this.refreshCache(request, response);
			return response;
		}).catch((e) => this.getRequestCache(request).then(cache => {
			return cache.match(request);
		}));
	}

	async cacheFetch(request, params = {}) {
		return this.getRequestCache(request).then(cache => cache.match(request).then((response) => {
			// Nothing cache, use network
			if (!response && params.networkFallback) return this.networkFetch(request, { ...params, cacheFallback: false });
			// Note: fetch, but for refreshing purposes only... not the returned response
			if (response && params.cacheRefresh) this.networkFetch(request, { ...params, justRefreshing: true });
			return response;
		}));
	}

	async refreshCache(request, response) {
		// Check if we received a valid response
		if (request.method !== 'GET' || !response || response.status !== 200 || (response.type !== 'basic' && response.type !== 'cors')) {
			return response;
		}
		// IMPORTANT: Clone the response. A response is a stream
		// and because we want the browser to consume the response
		// as well as the cache consuming the response, we need
		// to clone it so we have two streams.
		var responseToCache = response.clone();
		this.getRequestCache(request).then(cache => {
			cache.put(request, responseToCache);
		});
		return response;
	}

	async getRequestCache(request) {
		const cacheName = request.headers.get('Accept') === 'application/json'
			? this.cx.params.cache_name + '_json' 
			: this.cx.params.cache_name;
		return self.caches.open(cacheName);
	}
}