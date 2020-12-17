"use strict";

const _ = require('lodash');
const BluebirdPromise = require('sequelize').Promise;
const signJwt = BluebirdPromise.promisify(require('jsonwebtoken').sign);
const randomstring = require("randomstring");
const Optional = require("optional-js");
const baseController = require('../helpers/baseController');
const controllerHelper = require('../helpers/controllerHelper');
const accountHelper = require('../helpers/accountHelper');
const scopeHelper = require('../../helpers/scopeHelper');
const email = require('../../helpers/email');
const models = require('../../models');
const ApiError = require('../../ApiError');

const controller = baseController(models.invitation);


function sendEmail(invitation, apiKey) {
    return invitation.getApplication({
        include: [{
            model: models.invitationPolicy,
            include: [{
                model: models.emailTemplate,
                as: 'invitationEmailTemplates'
            }]
        }]
    })
        .then(application => {
            ApiError.assert(application.invitationPolicy.invitationEmailStatus === 'ENABLED', ApiError, 400, 400, 'the invitation workflow is not enabled');
            return BluebirdPromise.resolve(
                //if a callbackUri is specified, the link in the email must send the user on ID site
                Optional.ofNullable(invitation.callbackUri)
                    .map(callbackUri => BluebirdPromise.join(
                        signJwt(
                            {
                                init_jti: randomstring.generate(20),
                                scope: scopeHelper.getIdSiteScope(application),
                                app_href: application.href,
                                cb_uri: callbackUri,
                                ash: application.href,
                                inv_href: invitation.href,
                                email: invitation.email,
                                sp_token: 'null'
                            },
                            apiKey.secret,
                            {
                                subject: apiKey.id,
                                audience: 'idSite'
                            }
                        ),
                        models.idSite.findOne({attributes: ['url']}).get('url'),
                        accountHelper.findCloudAccount(invitation.email, application.id)
                        )
                            .spread((jwt, idSiteUrl, account) => ({url: idSiteUrl + '/#/' + Optional.ofNullable(account).map(_.constant('')).orElse('register') + '?jwt=' + jwt}))
                    )
                    .orElseGet(_.stubObject)
            )
                .then(placeHolderValues =>
                    //add applications, organization & fromAccount placeholders
                    BluebirdPromise.join(
                        Optional.ofNullable(invitation.organizationId).map(() => invitation.getOrganization({attributes: ['name', 'nameKey', 'description']})).orElseGet(_.stubObject),
                        Optional.ofNullable(invitation.fromAccountId).map(() => invitation.getFromAccount({attributes: ['givenName', 'surname', 'username', 'email']})).orElseGet(_.stubObject)
                    )
                        .spread((organization, fromAccount) => {
                            placeHolderValues.application = _.pick(application, ['name']);
                            placeHolderValues.organization = _.pick(organization, ['name', 'nameKey', 'description']);
                            placeHolderValues.fromAccount = _.pick(fromAccount, ['givenName', 'fullName', 'surname', 'username', 'email']);
                            email.send(
                                {email: invitation.email},
                                null,
                                application.invitationPolicy.invitationEmailTemplates[0],
                                invitation.id,
                                placeHolderValues
                            );
                        })
                );

        });
}

controller.create = function (req, res) {
    return controllerHelper.queryAndExpand(
        () => controllerHelper.create(
            models.invitation,
            {tenantId: req.user.tenantId},
            req.swagger.params.attributes.value
        )
            .tap(invitation => sendEmail(invitation, req.user)),
        req,
        res,
        true
    );
};

controller.update = function (req, res) {
    return controllerHelper.queryAndExpand(
        () => controllerHelper.update(
            models.invitation,
            req.swagger.params.id.value,
            req.swagger.params.newAttributes.value
        ),
        req,
        res,
        true
    );
};

module.exports = controller;
