"use strict";

var _ = require('lodash');
var BluebirdPromise = require('sequelize').Promise;
var Optional = require('optional-js');
var models = require('../../models');
var ApiError = require('../../ApiError');


exports.getSubAccountStore = function(accountStore, subAccountStoreHref){
    return Optional.ofNullable(subAccountStoreHref)
            .map(ash => {
                var subAccountStore = models.resolveHref(ash);
                //if account store & sub account store are the same, just return the former
                if(subAccountStore instanceof accountStore.Model.Instance){
                    ApiError.assert(accountStore.id === subAccountStore.id, ApiError, 400, 2014, 'The provided %s have different ID (%s and %s)', accountStore.Model.options.name.plural, accountStore.id, subAccountStore.id);
                    return BluebirdPromise.resolve(accountStore);
                }
                //check that the sub account store actually is an account store
                ApiError.assert(_.find([models.organization.Instance, models.directory.Instance, models.group.Instance], i => subAccountStore instanceof i), ApiError, 400, 2014, 'Cannot lookup accounts in %s', subAccountStoreHref);
                //check if the sub-account store belongs to the account store
                return accountStore['get'+_.upperFirst(subAccountStore.Model.options.name.plural)]({
                        where: {id : subAccountStore.id},
                        limit: 1
                    })
                    .then(_.head)
                    .tap(_.partial(ApiError.assert, _, ApiError, 400, 2014, '%s %s does not belong to %s %s', subAccountStore.Model.name, subAccountStore.id, accountStore.Model.name, accountStore.id));
            })
            .orElse(accountStore);
};

exports.findAccount = function(login, applicationId, organizationName, accountStoreHref){
    //username and password are persisted lowercased to allow for case insensitive search
    var lowerCaseLogin = login.toLowerCase();
    return models.application.build({id: applicationId}, {isNewRecord: false})
            .getLookupAccountStore(organizationName)
            .then(as => exports.getSubAccountStore(as, accountStoreHref))
            .then(as => as.getAccounts({where: { $or: [{email: lowerCaseLogin}, {username: lowerCaseLogin} ]}, limit: 1}))
            .get(0);
};

exports.authenticateAccount = function(login, password, applicationId, organizationName, accountStoreHref){
    return exports.findAccount(login, applicationId, organizationName, accountStoreHref)
        .tap(function(account){
           ApiError.assert(account, ApiError, 400, 7104, 'Login attempt failed because there is no Account in the Application’s associated Account Stores with the specified username or email.');
           ApiError.assert(account.status === 'ENABLED', ApiError, 400, 7101, 'Login attempt failed because the account is not enabled.');
           return account
                   .verifyPassword(password)
                   .then(function(result){
                       ApiError.assert(result, ApiError, 400, 7100, 'Login attempt failed because the specified password is incorrect.');
                   });
        });
};