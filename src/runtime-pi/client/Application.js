
/**
 * @imports
 */
import Router from './Router.js';
import _Application from '../Application.js';

export default class Application extends _Application {

	// Returns router class
	get Router() {
		return Router;
	}

	/**
     * Handles HTTP events.
     * 
     * @param HttpEvent       httpEvent
     * @param Function        remoteFetch
     * 
     * @return Response
     */
	async handle(httpEvent, remoteFetch) {
		// The app router
        const router = new this.Router(this.cx, httpEvent.url.pathname);
        const handle = async () => {
			// --------
			// ROUTE FOR DATA
			// --------
			return router.route([httpEvent.request.method, 'default'], httpEvent, { ...( document.state?.data || {} ) }, async event => {
				if (event !== httpEvent) {
					// This was nexted()
					if (!event.request.headers.has('Accept')) {
						event.request.headers.set('Accept', 'application/json');
					}
				}
				return remoteFetch(event.request);
			}, remoteFetch);
		};
		// --------
        // PIPE THROUGH MIDDLEWARES
        // --------
		return await (this.cx.middlewares || []).concat(handle).reverse().reduce((next, fn) => {
			return () => fn.call(this.cx, httpEvent, router, next);
		}, null)();
	}

	// Renderer
    async render(httpEvent, response) {
		let data = await response.jsonfy();
		const router = new this.Router(this.cx, httpEvent.url.pathname);
		return router.route('render', httpEvent, data, async (httpEvent, data) => {
			// --------
			if (window.webqit.dom) { await new Promise(res => window.webqit.dom.ready(res)); }
			if (window.webqit && window.webqit.oohtml) {
				const {
					BINDINGS_API: { api: bindingsConfig },
					HTML_MODULES: { api: modulesConfig },
				} = window.webqit.oohtml.configs;
				window.document[ bindingsConfig.bind ]({
					env: 'client',
					state: this.cx.runtime,
					...data
				}, { diff: true });
				const routingContext = window.document.body.querySelector(`[${ window.CSS.escape( modulesConfig.context.attr.contextname ) }="routes"]`) || window.document.body;
				routingContext.setAttribute( modulesConfig.context.attr.importscontext, '/' + `routes/${ httpEvent.url.pathname }`.split('/').map(a => a.trim()).filter(a => a).join('/'));
				await this.scrollIntoView(httpEvent, routingContext);
			} else {
				await this.scrollIntoView(httpEvent);
			}
			return window;
		});
	}

	// Unrender
	async unrender(httpEvent) {
		window.document.bind({ state: this.cx.runtime }, { diff: true });
	}

	// Normalize scroll position
	async scrollIntoView(httpEvent, routingContext) {
		if (!(httpEvent.detail.srcType === 'link')) return;
		await new Promise(res => setTimeout(res, 10));
		let urlTarget;
		if (httpEvent.url.hash && (urlTarget = document.querySelector(httpEvent.url.hash))) {
			urlTarget.scrollIntoView();
		} else if (routingContext || (routingContext = document.body)) {
			routingContext.scrollIntoView();
		}
	}

}

