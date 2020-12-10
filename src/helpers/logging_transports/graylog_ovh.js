"use strict";

const Transport = require('winston-transport');
const tls = require('tls');
const pjson = require('../../../package.json');
const config = require('config');

const MESSAGE_LEVEL = {
    'silly': {value: 7, name: 'debug'},
    'debug': {value: 7, name: 'debug'},
    'verbose': {value: 7, name: 'debug'},
    'data': {value: 7, name: 'debug'},
    'prompt': {value: 6, name: 'info'},
    'input': {value: 6, name: 'info'},
    'info': {value: 6, name: 'info'},
    'help': {value: 5, name: 'notice'},
    'notice': {value: 5, name: 'notice'},
    'warn': {value: 4, name: 'warning'},
    'warning': {value: 4, name: 'warning'},
    'error': {value: 3, name: 'error'},
    'crit': {value: 2, name: 'critical'},
    'alert': {value: 1, name: 'alert'},
    'emerg': {value: 0, name: 'emergency'}
};

class Message {
    constructor(info) {
        let winstonLevel = info.level;
        if (!MESSAGE_LEVEL.hasOwnProperty(winstonLevel)) {
            winstonLevel = 'info';
        }
        const level = MESSAGE_LEVEL[winstonLevel];
        if (level === 'info') {
            console.log({info: info});
        }
        this.level = level.value;
        this.severity = level.name;
        this.logger = info.label;
        this.tags = Object.assign({}, info.tags);
        this.msg = info.message;
        if (info.error) {
            this.stack = info.error.stack || info.error.toString();
        }
    }
}

class GraylogOvhTransport extends Transport {
    constructor(options) {
        super(options);

        const extendedOptions = Object.assign({
            level: 'info',
            silent: false,
            autoReconnect: true,
            graylogHost: 'discover.logs.ovh.com',
            graylogPort: 12202,
            graylogHostname: require('os').hostname(),
            graylogOvhTokenKey: 'X-OVH-TOKEN',
            graylogOvhTokenValue: 'no_value',
            handleExceptions: false,
            version: pjson.version,
            environment: config.environment,
            graylogFacility: 'cloudpass'
        }, options);
        Object.keys(extendedOptions).forEach(key => {
            this[key] = extendedOptions[key];
        });

        // stack of messages to flush when connected
        this.messageStack = [];
    }

    getSocket(callback) {
        callback = (typeof callback === 'function') ? callback : function () {
        };
        if (this.clientReady() || this.connecting) {
            callback();
            return;
        }
        this.connecting = true;
        this.client = tls.connect(this.graylogPort, this.graylogHost, () => {
            delete this.connecting;
            this.messageStack.forEach((message) => {
                this.flushMessage(message);
            });
            this.messageStack = [];
            callback();
        });

        this.client.on('error', (err) => {
            this.client.end();
            console.log('[FATAL LOGGER]', err);
            if (this.autoReconnect) {
                delete this.connecting;
                this.client = null;
            }
        });
    }

    close() {
        console.log('ovh close');
        if (this.client) {
            this.client.end();
        }
    }

    flushMessage(message) {
        if (this.clientReady()) {
            this.client.write(this.getStrMessage(message));
        }
    }

    sendMessage(message) {
        if (this.clientReady()) {
            this.flushMessage(message);
        } else {
            this.messageStack.push(message);
        }
    }

    clientReady() {
        return this.client && this.client.getProtocol && !!this.client.getProtocol() && this.client.authorized;
    }

    getStrMessage(message) {
        const graylogMessage = {
            version: '1.1',
            timestamp: new Date() / 1000.0,
            host: this.graylogHostname,
            facility: this.graylogFacility,
            environment: this.environment,
            _version: this.version,
            level: message.level,
            severity: message.severity,
            logger: message.logger,
            short_message: message.msg,
            full_message: message.msg
        };
        if (this.graylogOvhTokenKey && this.graylogOvhTokenKey.length) {
            graylogMessage[this.graylogOvhTokenKey] = this.graylogOvhTokenValue;
        }
        if (message.stack) {
            graylogMessage.stack = message.stack;
        }
        if (message.tags && Object.keys(message.tags).length > 0) {
            Object.keys(message.tags).forEach(key => {
                if (key !== 'id') {
                    graylogMessage[key] = JSON.stringify(message.tags[key]);
                }
            });
        }
        return JSON.stringify(graylogMessage) + '\u0000';
    }

    log(info, done) {
        if (this.silent) {
            return done(null, true);
        }
        const message = new Message(info);
        this.getSocket(() => {
            this.sendMessage(message);
        });
        done(null, true);
    }
}

GraylogOvhTransport.prototype.name = 'graylog_ovh';
module.exports = GraylogOvhTransport;
