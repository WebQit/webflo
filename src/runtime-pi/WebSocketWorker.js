export class WebSocketWorker extends EventTarget {

    #socket;
    get socket() { return this.#socket; }

    constructor(socket) {
        super();
        this.#socket = socket;
        const messageHandler = async (event) => {
            let message;
            try {
                if (!(message = JSON.parse(event.data)) 
                || !['eventType', 'eventID', 'data'].every((k) => k in message)) {
                    return;
                }
            } catch(e) {
                // throw a better error
            }
            this.dispatchEvent(new SocketEvent(
                this,
                message.eventID,
                message.eventType,
                message.data,
                message.numPorts
            ));
        };
        const openHandler = (e) => {
            this.dispatchEvent(new Event('open'));
        };
        const errorHandler = (e) => {
            this.dispatchEvent(new Event('error'));
        };
        const closeHandler = (e) => {
            this.dispatchEvent(new Event('close'));
            this.#socket.removeEventListener('message', messageHandler);
            this.#socket.removeEventListener('open', openHandler);
            this.#socket.removeEventListener('error', errorHandler);
            this.#socket.removeEventListener('close', closeHandler);
            for (const listenerArgs of this.#listenersRegistry) {
                this.removeEventListener(...listenerArgs);
            }
        };
        this.#socket.addEventListener('message', messageHandler);
        this.#socket.addEventListener('open', openHandler);
        this.#socket.addEventListener('error', errorHandler);
        this.#socket.addEventListener('close', closeHandler);
    }

    #listenersRegistry = new Set;
    addEventListener(...args) {
        this.#listenersRegistry.add(args);
        return super.addEventListener(...args);
    }

    postMessage(data, transferOrOptions = []) {
        if (this.#socket.readyState !== this.#socket.constructor.OPEN) {
            return this.addEventListener('open', () => {
                this.postMessage(...arguments);
            });
        }
        if (Array.isArray(transferOrOptions)) {
            transferOrOptions = { transfer: transferOrOptions };
        }
        const { transfer = [], eventType = 'message', ...options } = transferOrOptions;
        const messagePorts = transfer.filter((t) => t instanceof MessagePort);
        const eventID = (0 | Math.random() * 9e6).toString(36);
        this.#socket.send(JSON.stringify({
            eventID,
            eventType,
            data,
            numPorts: messagePorts.length
        }), options);
        for (let i = 0; i < messagePorts.length; i ++) {
            this.addEventListener(`${eventType}:${eventID}:${i}`, (event) => {
                messagePorts[i].postMessage(event.data, event.ports);
            });
        }
    }

    close(...args) {
        return this.#socket.close(...args);
    }
}

export class SocketEvent extends Event {

    #eventID;
    get eventID() { return this.#eventID; }

    #data;
    get data() { return this.#data; }

    #ports = [];
    get ports() { return this.#ports; }

    #ownerAPI;
    constructor(ownerAPI, eventID, eventType, data, numPorts = 0) {
        super(eventType);
        this.#ownerAPI = ownerAPI;
        this.#eventID = eventID;
        this.#data = data;
        for (let i = 0; i < numPorts; i ++) {
            const channel = new MessageChannel;
            channel.port1.addEventListener('message', (event) => {
                this.#ownerAPI.postMessage(event.data, {
                    eventType: `${eventType}:${eventID}:${i}`,
                    transfer: event.ports
                });
            });
            channel.port1.start();
            this.#ports.push(channel.port2);
        }
    }

    respondWith(data, transferOrOptions = []) {
        if (!this.#ports.length) return false;
        if (this.#ports.length > 1) {
            throw new Error(`Multiple reply ports detected`);
        }
        this.#ports[0].postMessage(data, transferOrOptions);
        return true;
    }
}