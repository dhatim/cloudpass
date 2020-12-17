"use strict";

const assert = require('assert');
const BluebirdPromise = require('sequelize').Promise;
const jwt = require('jsonwebtoken');
const request = require('supertest');
const init = require('./init');

describe('invitation', () => {
    let mailServer;
    let applicationId;
    let invitationId;
    const invitedEmail = init.randomName() + '@example.com';
    const callbackUri = 'https://example.com/callback';

    before(() => {
        //start the SMTP server
        mailServer = init.getMailServer();
        //get the admin application
        return init.getRequest('tenants/' + init.apiKey.tenantId + '/applications')
            .query({name: 'Cloudpass', limit: 1, expand: 'invitationPolicy'})
            .expect(200)
            .then(function (res) {
                applicationId = res.body.items[0].id;
                //enable invitation emails
                return init.postRequest('invitationPolicies/' + res.body.items[0].invitationPolicy.id)
                    .send({invitationEmailStatus: "ENABLED"})
                    .expect(200)
            });
    });

    after(() => {
        mailServer.stop();
    });

    it('create', () =>
        //if no callbackUri is specified, the link in the email must redirect to the address specified in the email template
        BluebirdPromise.join(
            init.getEmailPromise(mailServer, invitedEmail),
            init.postRequest('invitations')
                .send({
                    email: invitedEmail,
                    application: {href: '/applications/' + applicationId}
                })
                .expect(200)
        ).spread((email, res) => {
            invitationId = res.body.id;
            assert.strictEqual(email.headers.subject, 'Invitation');
            assert(email.body.indexOf('https://change.me.example.com?cpToken=' + invitationId) >= 0);
        })
    );

    function createInvitationWithCbUri(emailAddress, expectedPath) {
        //if a callbackUri is specified, the link in the email must redirect to the ID site
        return BluebirdPromise.join(
            init.getEmailPromise(mailServer, emailAddress),
            init.postRequest('invitations/' + invitationId)
                .send({callbackUri})
                .expect(200)
        ).spread((email) => {
            assert.strictEqual(email.headers.subject, 'Invitation');
            const jwtParam = new RegExp('/#/' + expectedPath + '\\?jwt=(.*?)\n').exec(email.body)[1];
            assert(jwtParam);
            const decodedJwt = jwt.decode(jwtParam);
            assert.strictEqual(decodedJwt.inv_href, '/invitations/' + invitationId);
            assert.strictEqual(decodedJwt.email, emailAddress);
            //login with this token
            return request(init.servers.main).post('/v1/applications/' + applicationId + '/loginAttempts')
                .set('authorization', 'Bearer ' + jwtParam)
                .send({
                    type: 'basic',
                    value: Buffer.from(init.adminUser + ':' + init.adminPassword, 'utf8').toString('base64')
                })
                .expect(200);
        })
            .then(res => {
                assert(res.header['stormpath-sso-redirect-location']);
                return request(init.servers.main).get(res.header['stormpath-sso-redirect-location'])
                    .expect(302);
            })
            .then(res => {
                assert(res.header.location);
                const locationStart = callbackUri + '?jwtResponse=';
                assert(res.header.location.startsWith(locationStart));
                const jwtResponse = res.header.location.substring(locationStart.length);
                assert.strictEqual(jwt.decode(jwtResponse).inv_href, '/invitations/' + invitationId);
                return null;
            });
    }

    function idSiteRequestWithInvitation(email) {
        return init.getIdSiteJwtRequest(
            applicationId,
            {
                cb_uri: 'http://www.example.com/callback',
                inv_href: '/invitations/' + invitationId
            }
        )
            .then(jwtRequest =>
                request(init.servers.main).get('/sso')
                    .query({jwtRequest: jwtRequest})
                    .expect(302)
            )
            .then(res => {
                const fragmentStart = '/#/?jwt=';
                const startIndex = res.header.location.indexOf(fragmentStart);
                assert(startIndex >= 0);
                const decodedJwt = jwt.decode(res.header.location.substring(startIndex + fragmentStart.length));
                assert(decodedJwt.inv_href);
                assert(decodedJwt.inv_href.indexOf('/invitations/' + invitationId) >= 0);
                assert.strictEqual(decodedJwt.email, email);
                return null;
            });
    }

    it('idSite request', () => idSiteRequestWithInvitation(invitedEmail));

    it('delete', () => init.deleteRequest('invitations/' + invitationId).expect(204));

});