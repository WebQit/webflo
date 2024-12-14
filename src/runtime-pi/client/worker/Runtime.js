import '../../util-http.js';
import Observer from '@webqit/observer';
import { _any } from '@webqit/util/arr/index.js';
import { pattern } from '../../util-url.js';
import Workport from './Workport.js';
import _Runtime from '../../Runtime.js';
import xfetch from '../../xfetch.js';
import HttpEvent from '../../HttpEvent.js';
import CookieStorage from './CookieStorage.js';
import WebStorage from './WebStorage.js';

export {
	HttpEvent,
	Observer,
}

export default class Runtime extends _Runtime {

	constructor(cx, applicationInstance) {
		super(cx, applicationInstance);
        // --------------		
		// ONINSTALL
		self.addEventListener('install', evt => {
			if (this.cx.params.skip_waiting) { self.skipWaiting(); }
			// Manage CACHE
			if (this.cx.params.cache_name && (this.cx.params.cache_only_urls || []).length) {
				// Add files to cache
				evt.waitUntil( self.caches.open(this.cx.params.cache_name).then(async cache => {
					if (this.cx.logger) { this.cx.logger.log('[ServiceWorker] Pre-caching resources.'); }
					for (const urls of [ 'cache_first_urls', 'cache_only_urls' ]) {
						const _urls = (this.cx.params[urls] || []).map(c => c.trim()).filter(c => c && !pattern(c, self.origin).isPattern());
						await cache.addAll(_urls);
					}
				}) );
			}
		});

		// -------------
		// ONACTIVATE
		self.addEventListener('activate', evt => {
			evt.waitUntil( new Promise(async resolve => {
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
			}) );
		});

		// ---------------
        Observer.set(this, 'location', {});
        Observer.set(this, 'network', {});

		// -------------
		// ONFETCH
		self.addEventListener('fetch', event => {
			// URL schemes that might arrive here but not supported; e.g.: chrome-extension://
			if (!event.request.url.startsWith('http')) return;
			event.respondWith((async evt => {
				let requestingClient = await self.clients.get(evt.clientId);
				this.workport.setCurrentClient(requestingClient);
				const { url, ...requestInit } = await Request.copy(evt.request);
				// Now, the following is key:
				// The browser likes to use "force-cache" for "navigate" requests, when, e.g: re-entering your site with the back button
				// Problem here, force-cache forces out JSON not HTML as per webflo's design.
				// So, we detect this scenerio and avoid it.
				if (requestInit.cache === 'force-cache'/* && evt.request.mode === 'navigate' - even webflo client init call also comes with that... needs investigation */) {
					requestInit.cache = 'default';
				}
				return this.go(url, requestInit, { event: evt });
			})(event));
		});

		// -------------
		// Workport
		const workport = new Workport();
		Observer.set(this, 'workport', workport);

		// -------------
		// Initialize
		(async () => {
			if (!this.app.init) return;
			const request = this.createRequest('/');
			const httpEvent = new HttpEvent(request, { navigationType: 'init' });
			await this.app.init(httpEvent, ( ...args ) => this.remoteFetch( ...args ));
		})();
		
	}

    createRequest(href, init = {}) {
		const request = new Request(href, init);
		return request;
    }

	async go(url, init = {}, detail = {}) {
		// ------------
        url = typeof url === 'string' ? new URL(url, self.location.origin) : url;
		if (!(init instanceof Request) && !init.referrer) {
			init = { referrer: this.location.href, ...init };
		}
        // ------------
		// The request object
		const request = this.createRequest(url.href, init);
		if (detail.event) { Object.defineProperty(detail.event, 'request', { value: request }); }
		// The navigation event
		const cookieStorage = CookieStorage.create(request);
		const sessionStorage = await WebStorage.create('sessionStorage');
		const localStorage = await WebStorage.create('localStorage');
		const httpEvent = new HttpEvent(request, detail, cookieStorage, sessionStorage, localStorage);
		/* @obsolete
		httpEvent.port.listen(message => {
			if (message.$type === 'handler:hints' && message.session) {
				// TODO: Sync session data from client
				return Promise.resolve();
			}
		});
		*/
		// Response
		let response;
		if (httpEvent.request.url.startsWith(self.origin)/* && httpEvent.request.mode === 'navigate'*/) {
			response = await this.app.handle(httpEvent, ( ...args ) => this.remoteFetch( ...args ));
			if (typeof response === 'undefined') { response = new Response(null, { status: 404 }); }
            else if (!(response instanceof Response)) response = Response.create(response);
			for (const storage of [cookieStorage, sessionStorage, localStorage]) {
				await storage.commit(response);
			}
		} else {
			response = await this.remoteFetch(httpEvent.request);
		}
		const finalResponse = await this.handleResponse(httpEvent, response);
        return finalResponse;
	}

	// Initiates remote fetch and sets the status
	remoteFetch(request, ...args) {
		if (arguments.length > 1) {
			request = this.createRequest(request, ...args);
		}
		const matchUrl = (patterns, url) => _any((patterns || []).map(p => p.trim()).filter(p => p), p => pattern(p, self.origin).test(url));
		const execFetch = () => {
			// cache_only_urls
			if (matchUrl(this.cx.params.cache_only_urls, request.url)) {
				Observer.set(this.network, 'strategy', 'cache-only');
				return this.cacheFetch(request, { networkFallback: false, cacheRefresh: false });
			}
			// network_only_urls
			if (matchUrl(this.cx.params.network_only_urls, request.url)) {
				Observer.set(this.network, 'strategy', 'network-only');
				return this.networkFetch(request, { cacheFallback: false, cacheRefresh: false });
			}
			// cache_first_urls
			if (matchUrl(this.cx.params.cache_first_urls, request.url)) {
				Observer.set(this.network, 'strategy', 'cache-first');
				return this.cacheFetch(request, { networkFallback: true, cacheRefresh: true });
			}
			// network_first_urls
			if (matchUrl(this.cx.params.network_first_urls, request.url) || !this.cx.params.default_fetching_strategy) {
				Observer.set(this.network, 'strategy', 'network-first');
				return this.networkFetch(request, { cacheFallback: true, cacheRefresh: true });
			}
			// Default strategy
			Observer.set(this.network, 'strategy', this.cx.params.default_fetching_strategy);
			switch (this.cx.params.default_fetching_strategy) {
				case 'cache-only': return this.cacheFetch(request, { networkFallback: false, cacheRefresh: false });
				case 'network-only': return this.networkFetch(request, { cacheFallback: false, cacheRefresh: false });
				case 'cache-first': return this.cacheFetch(request, { networkFallback: true, cacheRefresh: true });
				case 'network-first': return this.networkFetch(request, { cacheFallback: true, cacheRefresh: true });
			}
		};
		let response = execFetch(request);
		// This catch() is NOT intended to handle failure of the fetch
		response.catch(e => Observer.set(this.network, 'error', e.message));
		return response;
	}

	// Caching strategy: network_first
	networkFetch(request, params = {}) {
		if (!params.cacheFallback) {
			Observer.set(this.network, 'remote', true);
			return xfetch(request);
		}
		return xfetch(request).then(response => {
			if (params.cacheRefresh) this.refreshCache(request, response);
			Observer.set(this.network, 'remote', true);
			return response;
		}).catch(() => this.getRequestCache(request).then(cache => {
			Observer.set(this.network, 'cache', true);
			return cache.match(request);
		}));
	}

	// Caching strategy: cache_first
	cacheFetch(request, params = {}) {
		return this.getRequestCache(request).then(cache => cache.match(request).then(response => {
			// Nothing cache, use network
			if (!response && params.networkFallback) return this.networkFetch(request, { ...params, cacheFallback: false });
			// Note: fetch, but for refreshing purposes only... not the returned response
			if (response && params.cacheRefresh) this.networkFetch(request, { ...params, justRefreshing: true });
			Observer.set(this.network, 'cache', true);
			return response;
		}));
	}

	// Caches response 
	refreshCache(request, response) {
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
			Observer.set(this.network, 'cacheRefresh', true);
			cache.put(request, responseToCache);
		});
		return response;
	}

	// Returns either the regular cache or a json-specific cache
	getRequestCache(request) {
		let cacheName = request.headers.get('Accept') === 'application/json'
			? this.cx.params.cache_name + '_json' 
			: this.cx.params.cache_name;
		return self.caches.open(cacheName);
	}

	// Handles response object
	handleResponse(e, response) {
		if (!response && response !== 0) { response = new Response(null, { status: 404 }); }
		return response;
	}

}