"use strict";

const BluebirdPromise = require('sequelize').Promise;
const _ = require('lodash');
const controllerHelper = require('../helpers/controllerHelper');
const accountStoreController = require('../helpers/accountStoreController');
const accountHelper = require('../helpers/accountHelper');
const samlHelper = require('../helpers/samlHelper');
const email = require('../../helpers/email');
const models = require('../../models');
const ApiError = require('../../ApiError');
const logger = require('../../helpers/loggingHelper').logger;

const controller = accountStoreController(models.application);

controller.getIdSiteModel = _.partial(controller.getComputedSubResource, 'getIdSiteModel');
controller.getSamlPolicy = _.partial(controller.getComputedSubResource, 'getSamlPolicy');

controller.create = function (req, res) {
    const attributes = _.pick(req.swagger.params.attributes.value, models.application.settableAttributes);
    attributes.tenantId = req.user.tenantId;

    controllerHelper.queryAndExpand(
        () => models.application
            .create(attributes)
            .tap(function (application) {
                //create a directory if requested
                let createDirectory = req.swagger.params.createDirectory.value;
                if (createDirectory) {
                    if (createDirectory === "true") {
                        //TODO pick a name that does not already exist
                        createDirectory = req.swagger.params.attributes.value.name;
                    }

                    return models.directory
                        .create({
                            name: createDirectory,
                            tenantId: req.user.tenantId
                        })
                        .then(function (directory) {
                            return models.accountStoreMapping.create({
                                accountStoreId: directory.id,
                                accountStoreType: 'directory',
                                listIndex: 0,
                                isDefaultAccountStore: true,
                                isDefaultGroupStore: true,
                                applicationId: application.id,
                                tenantId: req.user.tenantId
                            });
                        });
                }
            }),
        req, res, true
    );

};

controller.authenticate = function (req, res) {
    const attempt = req.swagger.params.attempt.value;
    const decodedValue = Buffer.from(attempt.value, 'base64').toString('utf8');
    const delimiterIndex = decodedValue.indexOf(':');
    ApiError.assert(delimiterIndex > 0, ApiError, 400, 400, 'Invalid value');
    const applicationId = req.swagger.params.id.value;
    const login = decodedValue.substring(0, delimiterIndex);
    const password = decodedValue.substring((delimiterIndex + 1));
    res.loginAttempt = true;
    accountHelper.authenticateAccount(
        login,
        password,
        applicationId,
        _.defaultTo(_.get(req.authInfo, 'asnk'), _.get(attempt.accountStore, 'nameKey')),
        _.get(attempt.accountStore, 'href')
    )
        .then(function (account) {
            res.json(expandAccountActionResult(account, req.swagger.params.expand.value));
            logger('audit').info('%s successfully logged in to application %s', login, applicationId, {
                tags: {
                    username: login,
                    application_id: applicationId,
                    action_status: 'login successul',
                    ip: req.headers['x-forwarded-for']
                }
            });
            return null;
        })
        .catch(e => {
            logger('audit').warn('%s failed to log in to application %s (reason: %s)', login, applicationId, e.message, {
                tags: {
                    username: login,
                    application_id: applicationId,
                    action_status: 'login failed',
                    reason: e.message,
                    ip: req.headers['x-forwarded-for']
                }
            });
            req.next(e);
        });
};

controller.createPasswordResetToken = function (req, res) {
    controllerHelper.queryAndExpand(
        () => accountHelper.findCloudAccount(
            req.swagger.params.attributes.value.email,
            req.swagger.params.id.value,
            _.defaultTo(_.get(req.authInfo, 'asnk'), _.get(req.swagger.params.attributes.value.accountStore, 'nameKey')),
            _.get(req.swagger.params.attributes.value.accountStore, 'href')
        )
            .then(function (account) {
                if (!account) {
                    logger('email').error('password reset: email %s not found', req.swagger.params.attributes.value.email);
                    return {};
                } else if (account.status !== 'ENABLED') {
                    logger('email').error('password reset: account %s is not enabled', account.href);
                    return {};
                } else if (!account.passwordAuthenticationAllowed) {
                    logger('email').error('password reset: password authentication not allowed for account %s', account.href);
                    return {};
                }
                return account.getDirectory({
                    include: [{
                        model: models.passwordPolicy,
                        include: [{
                            model: models.emailTemplate,
                            as: 'resetEmailTemplates'
                        }]
                    }]
                })
                    .then(function (directory) {
                        if (directory.passwordPolicy.resetEmailStatus !== 'ENABLED') {
                            logger('email').error('password reset workflow is not enabled on directory %s', directory.href);
                            return {};
                        }

                        //create a new token
                        const tokenExpiryDate = new Date();
                        tokenExpiryDate.setHours(tokenExpiryDate.getHours() + directory.passwordPolicy.resetTokenTtl);

                        return models.passwordResetToken.create({
                            tenantId: req.user.tenantId,
                            applicationId: req.swagger.params.id.value,
                            accountId: account.id,
                            email: account.email,
                            expires: tokenExpiryDate
                        })
                            .tap(function (token) {
                                return email.sendWithToken(
                                    account,
                                    directory,
                                    directory.passwordPolicy.resetEmailTemplates[0],
                                    token,
                                    req.authInfo,
                                    req.user,
                                    {expirationWindow: directory.passwordPolicy.resetTokenTtl}
                                );
                            });
                    });
            }),
        req,
        res
    );
};

function validatePasswordResetToken(token) {
    ApiError.assert(token, ApiError.NOT_FOUND);
    if (token.isExpired()) {
        return token.destroy().then(() => {
            throw new ApiError(400, 400, 'The token has expired');
        });
    }
}

controller.getPasswordResetToken = function (req, res) {
    controllerHelper.queryAndExpand(
        () => models.passwordResetToken.findByPk(
            req.swagger.params.tokenId.value, {
                where: {
                    applicationId: req.swagger.params.id.value
                }
            })
            .tap(validatePasswordResetToken),
        req,
        res
    );
};

controller.consumePasswordResetToken = function (req, res) {
    models.sequelize.transaction(function () {
        //find the token
        return models.passwordResetToken.findByPk(
            req.swagger.params.tokenId.value, {
                where: {
                    applicationId: req.swagger.params.id.value
                },
                include: [{
                    model: models.account,
                    include: [{
                        model: models.directory,
                        include: [{
                            model: models.passwordPolicy
                        }]
                    }]
                }]
            }
        )
            .tap(validatePasswordResetToken)
            .then(function (token) {
                //update the account and delete the token
                return BluebirdPromise.join(
                    token.account.update({
                        password: req.swagger.params.attributes.value.password
                    }),
                    token.destroy()
                )
                    .get(0);
            });
    })
        .then(function (account) {
            //asynchronously send a confirmation email if it is enabled
            if (account.directory.passwordPolicy.resetSuccessEmailStatus === 'ENABLED') {
                account.directory.passwordPolicy
                    .getResetSuccessEmailTemplates({
                        limit: 1
                    })
                    .spread(function (template) {
                        email.send(
                            account,
                            account.directory,
                            template);
                    });
            }
            res.json(expandAccountActionResult(account, req.swagger.params.expand.value));
            return null;
        })
        .catch(req.next);

};

controller.resendVerificationEmail = function (req, res) {
    accountHelper.findCloudAccount(
        req.swagger.params.attributes.value.login,
        req.swagger.params.id.value,
        _.defaultTo(_.get(req.authInfo, 'asnk'), _.get(req.swagger.params.attributes.value.accountStore, 'nameKey')),
        _.get(req.swagger.params.attributes.value.accountStore, 'href')
    )
        .then(function (account) {
            ApiError.assert(account, ApiError.NOT_FOUND);
            if (account.emailVerificationTokenId) {
                return account.getDirectory({
                    include: [{
                        model: models.accountCreationPolicy,
                        include: [{
                            model: models.emailTemplate,
                            as: 'verificationEmailTemplates',
                            separate: true //workaround for https://github.com/sequelize/sequelize/issues/2084
                        }]
                    }]
                })
                    .then(function (directory) {
                        email.send(
                            account,
                            directory,
                            directory.accountCreationPolicy.verificationEmailTemplates[0],
                            account.emailVerificationTokenId);
                        return null;
                    });
            } else {
                return null;
            }
        })
        .then(() => res.status(204).json())
        .catch(req.next);
};

controller.samlIdpRedirect = function (req, res) {
    //redirects to SAML idP can either be initiated from the application (with an access token)
    //or from the ID site (with an authorization bearer).
    //when using _.defaultTo here, the first param is found in ID Site bearer
    //while the 2nd one is found in access token
    return BluebirdPromise.join(
        //don't restrict the lookup account store to the requested organization (if any)
        //(if accounts are linked to organizations via a groups, org.getDirectories() would be empty)
        //organization memberships are checked after login instead (c.f. directoryController)
        BluebirdPromise.resolve(
            accountHelper.getSubAccountStore(
                models.application.build({id: req.swagger.params.id.value}),
                _.defaultTo(req.swagger.params['accountStore.href'].value, req.authInfo.ash)
            )
        )
            .then(getSamlDirectoryProvider),
        samlHelper.getRelayState(
            req.user,
            {
                cb_uri: req.authInfo.cb_uri,
                state: req.authInfo.state,
                init_jti: _.defaultTo(req.authInfo.init_jti, req.authInfo.jti),
                app_href: _.defaultTo(req.authInfo.app_href, req.authInfo.sub),
                inv_href: req.authInfo.inv_href,
                onk: req.authInfo.onk
            },
            '1h'
        )
    )
        .spread(samlHelper.getLoginRequestUrl)
        .then(_.bindKey(res, 'redirect'))
        .catch(req.next);
};

function getSamlDirectoryProvider(accountStore) {
    if (accountStore instanceof models.directory) {
        return accountStore.getProvider({
            include: [models.samlServiceProviderMetadata]
        })
            .tap(provider => ApiError.assert(provider.providerId === 'saml', ApiError, 400, 2014, 'The directory %s is not a SAML directory', accountStore.id));
    }
    ApiError.assert(accountStore.getDirectories, ApiError, 400, 2014, 'SAML login in %s is not supported', accountStore.constructor.options.name.plural);
    return accountStore.getDirectories({
        attributes: [],
        include: [{
            model: models.directoryProvider,
            as: 'provider',
            where: {
                providerId: 'saml'
            },
            include: [models.samlServiceProviderMetadata]
        }],
        limit: 1
    })
        .then(_.head)
        .tap(_.partial(ApiError.assert, _, ApiError, 404, 2014, 'No SAML provider found in %s %s', accountStore.constructor.name, accountStore.id))
        .get('provider');
}

function expandAccountActionResult(account, expand) {
    //return the account only if the expand paramter was set
    return expand ? account : {
        account: _.pick(account, 'href')
    };
}

module.exports = controller;