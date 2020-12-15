"use strict";

const _ = require('lodash');
const BluebirdPromise = require('sequelize').Promise;
const bcrypt = BluebirdPromise.promisifyAll(require('bcryptjs'));
const Optional = require('optional-js');
const Op = require('sequelize').Op;
const addAccountStoreAccessors = require('./helpers/addAccountStoreAccessors');
const ModelDecorator = require('./helpers/ModelDecorator');
const logger = require('../helpers/loggingHelper').logger;

module.exports = function (sequelize, DataTypes) {
    return new ModelDecorator(
        sequelize.define(
            'account',
            {
                id: {
                    primaryKey: true,
                    type: DataTypes.UUID,
                    allowNull: false,
                    defaultValue: DataTypes.UUIDV4
                },
                email: {
                    type: DataTypes.STRING,
                    allowNull: false,
                    lowercase: true,
                    trim: true,
                    validate: {isEmail: true},
                    //transform to lowercase to allow case insensitive logins
                    set: function (val) {
                        this.setDataValue('email', val.toLowerCase());
                    }
                },
                username: {
                    type: DataTypes.STRING,
                    lowercase: true,
                    trim: true,
                    validate: {len: [0, 255]},
                    set: function (val) {
                        this.setDataValue('username', val.toLowerCase());
                    }
                },
                password: {
                    type: DataTypes.STRING(60),
                    allowNull: true,
                    validate: {len: [1, 255]},
                    roles: {passwordHashing: true}
                },
                givenName: {
                    type: DataTypes.STRING,
                    allowNull: false,
                    defaultValue: '',
                    validate: {len: [0, 255]}
                },
                middleName: {
                    type: DataTypes.STRING,
                    allowNull: false,
                    defaultValue: '',
                    validate: {len: [0, 255]}
                },
                surname: {
                    type: DataTypes.STRING,
                    allowNull: false,
                    defaultValue: '',
                    validate: {len: [0, 255]}
                },
                providerData: {
                    type: DataTypes.TEXT,
                    get: function () {
                        return {href: this.href + '/providerData'};
                    },
                    set: function (val) {
                        this.setDataValue('providerData', JSON.stringify(val));
                    },
                    defaultValue: '{"providerId": "cloudpass"}'
                },
                failedLoginAttempts: {
                    type: DataTypes.INTEGER,
                    allowNull: false,
                    defaultValue: 0
                },
                lastLoginAttempt: {
                    type: DataTypes.DATE
                },
                passwordAuthenticationAllowed: {
                    type: DataTypes.BOOLEAN,
                    allowNull: false,
                    defaultValue: true
                },
                status: {
                    type: DataTypes.STRING(10),
                    validate: {isIn: [['ENABLED', 'DISABLED', 'UNVERIFIED']]},
                    allowNull: false,
                    defaultValue: 'ENABLED'
                },
                fullName: {
                    type: DataTypes.VIRTUAL(DataTypes.STRING),
                    get() {
                        return _.compact([this.givenName, this.middleName, this.surname]).join(' ');
                    }
                },
                passwordChanges: {
                    type: DataTypes.VIRTUAL(DataTypes.JSON),
                    get() {
                        return {href: this.href + '/passwordChanges'};
                    }
                },
            },
            {
                indexes: [
                    {
                        unique: true,
                        fields: ['email', 'directoryId']
                    },
                    {
                        unique: true,
                        fields: ['username', 'directoryId']
                    }
                ],
                hooks: {
                    beforeCreate: [
                        validateAndHashPassword,
                        function (instance) {
                            if (!instance.username) {
                                instance.set('username', instance.get('email'));
                            }
                        }
                    ],
                    beforeUpdate: validateAndHashPassword,
                    beforeDestroy: function (instance) {
                        if (instance.emailVerificationTokenId) {
                            return instance.sequelize.models.emailVerificationToken
                                .destroy({where: {id: instance.emailVerificationTokenId}});
                        }
                    },
                    afterCreate: function (instance) {
                        logger('audit').info('created account %s (%s) in directory %s with status %s', instance.email, instance.id, instance.directoryId, instance.status);
                    },
                    afterDestroy: function (instance) {
                        logger('audit').info('deleted account %s (%s)', instance.email, instance.id);
                    }
                }
            }
        )
    )
        .withInstanceMethods({
            verifyPassword: function (password) {
                return Optional.ofNullable(this.get('password', {role: 'passwordHashing'}))
                    .map(hash => bcrypt.compareAsync(password, hash))
                    .orElse(BluebirdPromise.resolve(false));
            },
            getProviderData: function () {
                return _.assign(
                    JSON.parse(this.getDataValue('providerData')),
                    {
                        href: this.href + '/providerData',
                        createdAt: this.createdAt,
                        modifiedAt: this.modifiedAt
                    }
                );
            }
        })
        .withClassMethods({
            associate: function (models) {
                models.account.belongsTo(models.tenant, {onDelete: 'cascade'});
                models.account.belongsTo(models.directory, {onDelete: 'cascade'});
                models.account.belongsTo(models.emailVerificationToken, {onDelete: 'set null'});
                models.account.hasMany(models.groupMembership, {onDelete: 'cascade'});
                models.account.hasMany(models.apiKey, {onDelete: 'cascade'});
                models.account.hasMany(models.factor, {onDelete: 'cascade'});
                models.account.belongsToMany(
                    models.group,
                    {
                        through: models.groupMembership,
                        onDelete: 'cascade'
                    }
                );
            },
            afterAssociate: models => {
                const accountModel = models.account;
                addAccountStoreAccessors(accountModel, models.application);
                addAccountStoreAccessors(accountModel, models.organization);
                accountModel.addFindAndCount(
                    models.accountLink,
                    function (options) {
                        return _.defaults(
                            {
                                where: {
                                    [Op.and]: [
                                        {
                                            [Op.or]: {
                                                leftAccountId: this.id,
                                                rightAccountId: this.id
                                            }
                                        },
                                        _.get(options, 'where')
                                    ]
                                }
                            },
                            options
                        );
                    }
                );
                accountModel.addFindAndCount(
                    accountModel,
                    function (options) {
                        return _.defaults(
                            {
                                where: {
                                    [Op.and]: [{
                                        [Op.or]: _([['left', 'right'], ['right', 'left']])
                                            .map(([idSide, selectedSide]) =>
                                                sequelize.dialect.QueryGenerator.selectQuery(
                                                    models.accountLink.tableName,
                                                    {
                                                        attributes: [`${selectedSide}AccountId`],
                                                        where: {[`${idSide}AccountId`]: this.id}
                                                    }
                                                ).slice(0, -1) // to remove the ';' from the end of the SQL
                                            )
                                            .map(accountIdSubSelect => ({id: {[Op.in]: sequelize.literal(`(${accountIdSubSelect})`)}}))
                                            .value()
                                    },
                                        _.get(options, 'where')
                                    ]
                                }
                            },
                            options
                        );
                    },
                    'linkedAccounts'
                );
            }
        })
        .withSearchableAttributes('id', 'email', 'username', 'givenName', 'middleName', 'surname', 'status')
        .withSettableAttributes('id', 'email', 'username', 'password', 'givenName', 'middleName', 'surname', 'passwordAuthenticationAllowed', 'status', 'customData')
        .withCustomData()
        .end();
};

function validateAndHashPassword(instance) {
    const password = instance.get('password', {role: 'passwordHashing'});
    //nothing to do if the password is already hashed
    if (password && !isModularCryptFormat(password)) {
        //else validate the password against the password policy and hash it
        return instance.getDirectory({include: [instance.sequelize.models.passwordPolicy]})
            .then(function (directory) {
                directory.passwordPolicy.validatePassword(password);
                return null;
            })
            .then(function () {
                return bcrypt.hashAsync(password, 8);
            })
            .then(function (hash) {
                instance.set({'password': hash}, {role: 'passwordHashing'});
                return null;
            });
    }
}

function isModularCryptFormat(string) {
    //this regex tests only for bcrypt MCF
    return /^\$2[axy]?\$\d{2}\$[a-zA-Z0-9./]{53}$/g.test(string);
}