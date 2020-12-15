'use strict';

const express = require('express');
const bodyParser = require('body-parser');
const models = require('../models');
const ssacl = require('ssacl');
const ApiError = require('../ApiError.js');

const app = express();
app.use(bodyParser.urlencoded({extended: true}));

app.get('/', function (req, res) {
    models.adminInvitation.findByPk(
        req.query.cpToken,
        {
            include: [
                {
                    model: models.account,
                    as: 'fromAccount',
                    attributes: ['givenName', 'middleName', 'surname', 'fullName']
                },
                {
                    model: models.tenant,
                    attributes: ['key']
                }
            ],
            actor: new ssacl.Omnipotent()
        }
    )
        .then(invitation => {
            ApiError.assert(invitation, ApiError, 400, 400, 'Invitation not found');
            return res.json(invitation.get());
        });
});

app.post('/', function (req, res) {
    models.sequelize.transaction(function () {
        return models.adminInvitation.findByPk(
            req.body.invitationId,
            {actor: new ssacl.Omnipotent()}
        )
            .then(function (invitation) {
                ApiError.assert(invitation, ApiError, 400, 400, 'Invitation not found');
                req.app.get('ssaclCls').set('actor', invitation.tenantId);
                return models.directory.findOne({
                    where: {name: 'Cloudpass Administrators'}
                })
                    .then(function (directory) {
                        return directory.createNewAccount(
                            {
                                givenName: req.body.givenName,
                                surname: req.body.surname,
                                email: invitation.email,
                                password: req.body.password
                            },
                            false
                        );
                    })
                    .then(() => invitation.destroy());
            });
    })
        .then(() => res.status(204).json())
        .catch(req.next);
});

app.use(function (err, req, res, next) {
    if (res.headersSent) {
        return next(err);
    }
    //return an error code corresponding to the error
    res.status(ApiError.FROM_ERROR(err).status).send();
});

module.exports = app;