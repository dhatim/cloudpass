"use strict";

const fs = require("fs");
const path = require("path");
const config = require('config');
const cls = require('continuation-local-storage');
const Sequelize = require('sequelize');
const _ = require('lodash');
const Umzug = require('umzug');
const Optional = require('optional-js');
const logger = require('../helpers/loggingHelper').logger;
const AbstractQuery = require('sequelize/lib/dialects/abstract/query').AbstractQuery

const persistenceOptions = _.merge(
    {
        define: {
            updatedAt: 'modifiedAt',
            //add href to all resources
            getterMethods: {
                href() {
                    return this.constructor.getHref(this.id);
                }
            }
        },
        logging: (...args) => {
            const l = logger('sql');
            if (l.levels[l.level] >= l.levels['debug']) {
                const params = args[1].bind;
                const dialect = args[1].sequelize === undefined ? undefined : args[1].sequelize.getDialect();
                l.debug(AbstractQuery.formatBindParameters(args[0], params, dialect)[0]);
            }
        }
    },
    config.get('persistence.options')
);

// disable connection pooling because we are using pgbouncer
// see https://github.com/sequelize/sequelize/issues/10424#issuecomment-520045516
Sequelize.addHook('afterInit', function (sequelize) {
    console.log({dialect:sequelize.getDialect()})
    sequelize.options.handleDisconnects = false;

    // Disable pool completely
    sequelize.connectionManager.pool.destroyAllNow();
    sequelize.connectionManager.pool = null;
    sequelize.connectionManager.getConnection = function getConnection() {
        return this._connect(sequelize.config);
    };
    sequelize.connectionManager.releaseConnection = function releaseConnection(connection) {
        return this._disconnect(connection);
    };
})

const namespace = cls.createNamespace('cloudpass');
Sequelize.useCLS(namespace);
const sequelize = new Sequelize(config.persistence.database, config.persistence.username, config.persistence.password, persistenceOptions);

//convenience method to start a transaction only if none is already started
sequelize.requireTransaction = function (query) {
    return Optional.ofNullable(Sequelize._cls.get('transaction'))
        .map(query)
        .orElseGet(() => this.transaction({isolationLevel: Sequelize.Transaction.ISOLATION_LEVELS.REPEATABLE_READ}, query));
};

//default Model.count is not working with SSACL (see https://github.com/pumpupapp/ssacl/issues/4)
Sequelize.Model.count = function (options) {
    return this.findAll(
        _.defaults(
            {
                attributes: [[sequelize.fn('COUNT', sequelize.fn('DISTINCT', sequelize.col(this.name + '.' + this.primaryKeyAttribute))), 'count']],
                raw: true,
                plain: true
            },
            _.omit(options, ['offset', 'limit', 'order', 'attributes'])
        )
    )
        .get('count')
        .then(parseInt);
};

Sequelize.Model.findAndCountAll = function (options) {
    const self = this;
    return this.sequelize.requireTransaction(function () {
        return sequelize.Promise.join(
            self.count(options),
            self.findAll(options)
        );
    })
        .spread(function (count, rows) {
            return {count: count, rows: rows};
        });
};

//load all models in the folder
fs
    .readdirSync(__dirname)
    .filter(function (file) {
        return fs.statSync(path.join(__dirname, file)).isFile() && file !== "index.js";
    })
    .forEach(function (file) {
        const model = sequelize.import(path.join(__dirname, file));
        exports[model.name] = model;
    });


// set up the associations between models
_(sequelize.models)
    .values()
    .filter(function (m) {
        return m.associate;
    })
    .forEach(function (m) {
        m.associate(sequelize.models);
    });

//post-association hooks
_(sequelize.models)
    .values()
    .filter(function (m) {
        return m.afterAssociate;
    })
    .forEach(function (m) {
        m.afterAssociate(sequelize.models);
    });

exports.migrate = function () {
    return new Umzug({
        storage: 'sequelize',
        storageOptions: {
            sequelize: sequelize,
            modelName: 'completedMigrations'
        },
        migrations: {
            params: [sequelize.getQueryInterface(), Sequelize, sequelize.models],
            pattern: /\.js$/
        }
    })
        .up();
};

exports.useSsacl = function (ssacl, cls) {
    _(sequelize.models)
        .values()
        .filter(_.property('aclAttribute'))
        .forEach(model => {
            ssacl(
                model,
                {
                    cls: cls,
                    read: {attribute: model.aclAttribute},
                    write: {attribute: model.aclAttribute}
                },
                require('sequelize')
            );
        });
};

exports.sequelize = sequelize;