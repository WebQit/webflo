import '../util-http.js';
import { _before, _toTitle } from '@webqit/util/str/index.js';
import CookieStorage from './CookieStorage.js';
import WebStorage from './WebStorage.js';
import HttpEvent from '../HttpEvent.js';
import Workport from './Workport.js';
import xfetch from '../xfetch.js';
import _Runtime from '../Runtime.js';
import { params } from '../util-url.js';
import Url from './Url.js';

const { Observer } = webqit;

export {
	HttpEvent,
	Observer,
}

export default class Runtime extends _Runtime {

	constructor(cx, applicationInstance) {
		super(cx, applicationInstance);
		// -----------------------
		// Initialize location
		Observer.set(this, 'location', new Url(window.location));
		Observer.set(this, 'referrer', new Url(document.referrer));
		Observer.set(this, 'network', {});
		window.addEventListener('online', () => Observer.set(this.network, 'status', 'online'));
		window.addEventListener('offline', () => Observer.set(this.network, 'status', 'offline'));
		this.useNavigationAPI = window.navigation;
		// -----------------------
		// Initialise API
		if (this.useNavigationAPI) {
			this.home = window.navigation.currentEntry;
			this._initNavigationAPI();
		} else { this._initLegacyAPI(); }
		// -----------------------
		// Service Worker && COMM
		if (this.cx.params.service_worker?.filename) {
			const { public_base_url: base, service_worker: { filename, ...serviceWorkerParams }, env } = this.cx.params;
			const workport = new Workport(base + filename, { ...serviceWorkerParams, startMessages: true }, env);
			Observer.set(this, 'workport', workport);
		}
		// -----------------------
		// Initialize and Hydration
		(async () => {
			let shouldHydrate;
			if (this.app.init) {
				const request = this.createRequest(this.location);
				const httpEvent = new HttpEvent(request, { navigationType: 'init' });
				shouldHydrate = await this.app.init(httpEvent, ( ...args ) => this.remoteFetch( ...args ));
			}
			if (shouldHydrate !== false) {
				this.go(this.location, {}, { navigationType: 'startup', navigationOrigins: [], });
			}
		})(); 
	}

	_initLegacyAPI() {
		const updateLocation = (navigationOrigins, newHref) => {
			const scrollContainer = navigationOrigins[2] || window;
			try { window.history.replaceState({
				...(this.currentEntry().getState() || {}),
				scrollPosition: scrollContainer === window ? [] : [ scrollContainer.scrollLeft, scrollContainer.scrollTop, ],
			}, '', window.location.href); } catch(e) {}
			try { window.history.pushState({}, '', newHref); } catch(e) {}
		};
		// -----------------------
		// Capture all link-clicks
		// and fire to this router.
		window.addEventListener('click', e => {
			if (!this._canIntercept(e)) return;
			var anchorEl = e.target.closest('a');
			if (!anchorEl || !anchorEl.href || anchorEl.target || anchorEl.download || !this.isSpaRoute(anchorEl)) return;
			if (this.isHashChange(anchorEl)) {
				Observer.set(this.location, 'href', anchorEl.href);
				return;
			}
			// ---------------
			// Handle now
			e.preventDefault();
			this._abortController?.abort();
			this._abortController = new AbortController();	
			// Note the order of calls below
			const detail = {
				navigationType: 'push',
				navigationOrigins: [ anchorEl, null, anchorEl.closest('[navigation-context]') ],
				destination: this._asEntry(null),
				source: this.currentEntry(), // this
				userInitiated: true,
			};
			updateLocation([ anchorEl ], anchorEl.href); // this
			this.go( 
				Url.copy(anchorEl),
				{ signal: this._abortController.signal, },
				detail,
			); // this
		});
		// -----------------------
		// Capture all form-submit
		// and fire to this router.
		window.addEventListener('submit', e => {
			if (!this._canIntercept(e)) return;
			// ---------------
			// Declare form submission modifyers
			const form = e.target.closest('form'), submitter = e.submitter;
			const submitParams = [ 'action', 'enctype', 'method', 'noValidate', 'target' ].reduce((params, prop) => {
				params[prop] = submitter && submitter.hasAttribute(`form${prop.toLowerCase()}`) ? submitter[`form${_toTitle(prop)}`] : form[prop];
				return params;
			}, {});
			submitParams.method = (submitter && submitter.dataset.formmethod) || form.dataset.method || submitParams.method;
			if (submitParams.target || !this.isSpaRoute(submitParams.action)) return;
			var actionEl = window.document.createElement('a');
			actionEl.href = submitParams.action;
			if (this.isHashChange(anchorEl)) {
				Observer.set(this.location, 'href', anchorEl.href);
				return;
			}
			// ---------------
			// Handle now
			var formData = new FormData(form);
			if ((submitter || {}).name) { formData.set(submitter.name, submitter.value); }
			if (submitParams.method.toUpperCase() === 'GET') {
				var query = {};
				Array.from(formData.entries()).forEach(_entry => {
					params.set(query, _entry[0], _entry[1]);
				});
				actionEl.search = params.stringify(query);
				formData = null;
			}
			e.preventDefault();
			this._abortController?.abort();
			this._abortController = new AbortController();		
			// Note the order of calls below
			const detail = {
				navigationType: 'push',
				navigationOrigins: [ submitter, form, submitter?.closest('[navigation-context]') ],
				destination: this._asEntry(null),
				source: this.currentEntry(), // this
				userInitiated: true,
			};
			updateLocation([ submitter, form ], actionEl.href); // this
			this.go(
				Url.copy(actionEl),
				{
					method: submitParams.method,
					body: formData,
					signal: this._abortController.signal,
				},
				detail,
			); // this
		});
		// -----------------------
		// This event is triggered by
		// either the browser back button,
		// the window.history.back(),
		// the window.history.forward(),
		// or the window.history.go() action.
		window.addEventListener('popstate', e => {
			if (this.isHashChange(location)) {
				Observer.set(this.location, 'href', location.href);
				return;
			}
			// Navigation details
			const detail = {
				navigationType: 'traverse',
				navigationOrigins: [],
				destination: this._asEntry(e.state),
				source: this.currentEntry(),
				userInitiated: true,
			};
			// Traversal?
			// Push
			const url = location.href;
			this.go(url, {}, detail);
		});
	}

	_initNavigationAPI() {
		// -----------------------
		// Detect source elements
		let navigationOrigins = [];
		window.addEventListener('click', e => {
			if (!this._canIntercept(e)) return;
			let anchorEl = e.target.closest('a');
			if (!anchorEl || !anchorEl.href || anchorEl.target) return;
			navigationOrigins = [ anchorEl, null, anchorEl.closest('[navigation-context]') ];
		});
		window.addEventListener('submit', e => {
			if (!this._canIntercept(e)) return;
			navigationOrigins = [ e.submitter, e.target.closest('form'), e.target.closest('[navigation-context]') ];
		});
		// -----------------------
		// Handle navigation event which happens after the above
		window.navigation.addEventListener('navigate', e => {
			if (!e.canIntercept || e.downloadRequest !== null) return;
			if (e.hashChange) {
				Observer.set(this.location, 'href', e.destination.url);
				return;
			}
			const { navigationType, destination, signal, formData, info, userInitiated } = e;
			if (formData && navigationOrigins[1]?.hasAttribute('webflo-no-intercept')) return;
			if (formData && (navigationOrigins[0] || {}).name) { formData.set(navigationOrigins[0].name, navigationOrigins[0].value); }
			// Navigation details
			const detail = {
				navigationType,
				navigationOrigins,
				destination,
				source: this.currentEntry(),
				userInitiated,
				info,
			};
			const scrollContainer = navigationOrigins[2] || window;
			this.updateCurrentEntry({ state: {
				...(this.currentEntry().getState() || {}),
				scrollPosition: scrollContainer === window ? [] : [ scrollContainer.scrollLeft, scrollContainer.scrollTop, ],
			} });
			navigationOrigins = [];
			// Traversal?
			// Push
			const url = destination.url;
			const init = {
				method: formData && 'POST' || 'GET',
				body: formData,
				signal
			};
			const nav = this;
			e.intercept({
				scroll: (scrollContainer !== window) && 'manual' || 'after-transition',
				focusReset: (scrollContainer !== window) && 'manual' || 'after-transition',
				async handler() { await nav.go(url, init, detail); },
			});
		});
	}

	_asEntry(state) { return { getState() { return state; } }; }
	_canIntercept(e) { return !(e.metaKey || e.altKey || e.ctrlKey || e.shiftKey); }
	_uniqueId() { return ( 0 | Math.random() * 9e6 ).toString( 36 ); }

	_transitOrigins(origins, state) {
		if (!window.webqit?.oohtml?.configs) return;
		const { BINDINGS_API: { api: bindingsConfig } = {}, } = window.webqit.oohtml.configs;
		origins.forEach(node => { node && (node[bindingsConfig.bindings].loading = state); });
	}

	_xRedirectCode = 200;

	isHashChange(urlObj) { return _before(this.location.href, '#') === _before(urlObj.href, '#') && (this.location.href.includes('#') || urlObj.href.includes('#')); }

	isSpaRoute(url) {
		url = typeof url === 'string' ? new URL(url, this.location.origin) : url;
		if (url.origin && url.origin !== this.location.origin) return false;
		if (!this.cx.params.routing) return true;
		if (this.cx.params.routing.targets === false/** explicit false means disabled */) return false;
		let b = url.pathname.split('/').filter(s => s);
		const match = a => {
			a = a.split('/').filter(s => s);
			return a.reduce((prev, s, i) => prev && (s === b[i] || [s, b[i]].includes('-')), true);
		};
		return match(this.cx.params.routing.root) && this.cx.params.routing.subroots.reduce((prev, subroot) => {
			return prev && !match(subroot);
		}, true);
	}

	// -----------------------------------------------

    reload(params) {
		if (this.useNavigationAPI) { return window.navigation.reload(params); }
		return window.history.reload();
	}
	
    back() {
		if (this.useNavigationAPI) { return window.navigation.canGoBack && window.navigation.back(); }
		return window.history.back();
	}
	
    forward() {
		if (this.useNavigationAPI) { return window.navigation.canGoForward && window.navigation.forward(); }
		return window.history.forward();
	}
	
    traverseTo(...args) {
		if (this.useNavigationAPI) { return window.navigation.traverseTo(...args); }
		return window.history.go(...args);
	}
	
    entries() {
		if (this.useNavigationAPI) { return window.navigation.entries(); }
		return history;
	}
	
	currentEntry() {
		if (window.navigation) return window.navigation.currentEntry;
		return this._asEntry(history.state);
	}
	
    async updateCurrentEntry(params, url = null) {
		if (this.useNavigationAPI) {
			if (!url || url === window.navigation.currentEntry.url) {
				window.navigation.updateCurrentEntry(params);
			} else { await window.navigation.navigate(url, { ...params, history: 'replace' }).committed; }
			return;
		}
		window.history.replaceState(params.state, '', url);
	}
	
    async push(url, state = {}) {
		if (typeof url === 'string' && url.startsWith('&')) { url = this.location.href.split('#')[0] + (this.location.href.includes('?') ? url : url.replace('&', '?')); }
		url = new URL(url, this.location.href);
		if (this.useNavigationAPI) {
			await window.navigation.navigate(url.href, state).committed;
		} else { window.history.pushState(state, '', url.href); }
		Observer.set(this.location, 'href', url.href);
	}

	createRequest(href, init = {}) {
		return new Request(href, {
			...init,
			headers: {
				'Accept': 'application/json',
				'X-Redirect-Policy': 'manual-when-cross-spa',
				'X-Redirect-Code': this._xRedirectCode,
				'X-Powered-By': '@webqit/webflo',
				...(init.headers || {}),
			},
		});
	}

    async go(url, init = {}, detail = {}) {
		// ------------
		// Resolve inputs
		// ------------
        url = typeof url === 'string' ? new URL(url, this.location.origin) : url;
		if (!(init instanceof Request) && !init.referrer) { init = { referrer: this.location.href, ...init }; }
        if (!detail.navigationOrigins?.[1]/*form*/ && ![ 'startup', 'rdr' ].includes(detail.navigationType) && (_before(url.href, '#') === _before(init.referrer, '#') && (init.method || 'GET').toUpperCase() === 'GET')) return;
		
        // ------------
		// Pre-request states
		// ------------
        Observer.set(this.network, 'error', null, { diff: true });
        Observer.set(this.network, 'request', { init, detail });
		if (detail.navigationOrigins && detail.navigationType !== 'traverse') {
			this._transitOrigins(detail.navigationOrigins, true);
		}

        // ------------
		// Request
		// ------------
		const request = this.createRequest(url.href, init);
		const cookieStorage = CookieStorage.create();
		const sessionStorage = WebStorage.create('sessionStorage');
		const localStorage = WebStorage.create('localStorage');
		const httpEvent = new HttpEvent(request, detail, cookieStorage, sessionStorage, localStorage);
		let response;
		try {
			// Fire request and obtain response
			response = await this.app.handle(httpEvent, ( ...args ) => this.remoteFetch( ...args ), detail.navigationOrigins?.[2]);
			if (typeof response === 'undefined') { response = new Response(null, { status: 404 }); }
            else if (!(response instanceof Response)) response = Response.create(response);
			for (const storage of [cookieStorage, sessionStorage, localStorage]) {
                storage.commit();
            }
		} catch(e) {
			console.error(e);
			Object.defineProperty(e, 'retry', { value: () => this.go(url, init, detail) })
			Observer.set(this.network, 'error', e);
			response = new Response(e.message, { status: 500 });
		}
		// Handle redirection
		const location = response.headers.get('Location');
		if (location) {
			const xActualRedirectCode = parseInt(response.headers.get('X-Redirect-Code'));
			if (xActualRedirectCode && response.status === this._xRedirectCode) {
				response.meta.status = xActualRedirectCode; // @NOTE 1
			}
			if ([ 302,301 ].includes(response.status)) {
				Observer.set(this.network, 'redirect', location, { diff: true });
				if (this.isSpaRoute(location)) {
					this.go(location, {}, { navigationType: 'rdr', navigationOrigins: [ , , detail.navigationOrigins?.[2] ] });
				} else { window.location = location; }
				return;
			}
		}

		// ------------
		// // Post-request states
		// ------------
		// Reset states
		Observer.set(this.network, 'request', null, { diff: true });
		Observer.set(this.network, 'redirect', null, { diff: true });
		if ([ 404, 500 ].includes(response.status)) {
			Observer.set(this.network, 'error', new Error(response.statusText, { code: response.status }));
		}
		// Update location and render
		const finalUrl = response.url || request.url;
		Observer.set(this.location, 'href', finalUrl);
		Observer.set(this.referrer, 'href', init.referrer);
		// Update DOM
		const update = async () => {
			const extraDetail = (await this.app.render?.(httpEvent, response, detail.navigationOrigins?.[2]), {});
			// Transit origins
			const scrollContainer = detail.navigationOrigins?.[2] || window;
			if (detail.navigationType === 'traverse') {
				const destinationState = detail.destination?.getState() || {};
				// Manual scrolling?
				if (scrollContainer !== window && destinationState.scrollPosition?.length) {
					scrollContainer.scroll(...destinationState.scrollPosition);
					(document.querySelector('[autofocus]') || document.body).focus();
				}
			} else {
				if (detail.navigationOrigins) { this._transitOrigins(detail.navigationOrigins, false); }
				const stateData = { ...(this.currentEntry().getState() || {}), ...extraDetail, redirected: response.redirected, };
				await this.updateCurrentEntry({ state: stateData }, finalUrl);
				// Manual scrolling?
				if (scrollContainer !== window) {
					if (httpEvent.url.hash) {
						document.querySelector(httpEvent.url.hash)?.scrollIntoView();
					} else {
						scrollContainer.scrollTo(0, 0);
					}
					(document.querySelector('[autofocus]') || document.body).focus();
				}
			}
			await new Promise(res => setTimeout(res, 50));
		};
		if (/*!detail.navigationOrigins?.[2] && */document.startViewTransition && detail.navigationType !== 'startup') {
			const synthesizeWhile = window.webqit?.realdom?.synthesizeWhile || ( callback => callback() );
			return synthesizeWhile(async () => {
				const rel = this.referrer.pathname === this.location.pathname ? 'same' : ( `${ this.referrer.pathname }/`.startsWith( `${ this.location.pathname }/` ) ? 'parent' : ( `${ this.location.pathname }/`.startsWith( `${ this.referrer.pathname }/` ) ? 'child' : 'unrelated' ) );
				document.documentElement.setAttribute('view-transition-rel', rel);
				document.documentElement.setAttribute('view-transition-phase', 1);
				const viewTransition = document.startViewTransition( update );
				try { await viewTransition.updateCallbackDone; } catch(e) { console.log(e); }
				document.documentElement.setAttribute('view-transition-phase', 2);
				try { await viewTransition.ready; } catch(e) { console.log(e); }
				document.documentElement.setAttribute('view-transition-phase', 3);
				try { await viewTransition.finished; } catch(e) { console.log(e); }
				document.documentElement.toggleAttribute('view-transition-phase', false);
			});
		}
		return await update();
    }

	async remoteFetch(request, ...args) {
		let href = request;
		if (request instanceof Request) {
			href = request.url;
		} else if (request instanceof URL) {
			href = request.href;
		}
		Observer.set(this.network, 'remote', href, { diff: true });
		let _response = xfetch(request, ...args);
		// Return xResponse
		return _response.then(async response => {
			// Stop loading status
			Observer.set(this.network, 'remote', null, { diff: true });
			return response;
		});
	}

}