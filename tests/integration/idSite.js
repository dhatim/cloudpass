'use strict';

var assert = require("assert");
var BluebirdPromise = require('sequelize').Promise;
var jwt = require('jsonwebtoken');
var request = require('supertest-as-promised');
var init = require('./init');

describe('idSite', function(){
    var applicationId;
    var idSiteUrl = 'http://www.example.com';
    var callbackUrl = 'http://www.example.com/callback';
    var mailServer;

    before(function(){
         //start the SMTP server
        mailServer = init.getMailServer();
        //set the ID site URL
        return init.getRequest('tenants/'+init.apiKey.tenantId+'/idSites')
            .query({limit: 1})
            .expect(200)
            .then(function(res){
                return init.postRequest('idSites/'+res.body.items[0].id)
                        .send({url: idSiteUrl})
                        .expect(200);
        }).then(function(){
            //get the admin application
            return init.getRequest('tenants/'+init.apiKey.tenantId+'/applications')
                .query({ name: 'Cloudpass', limit: 1, expand: 'defaultAccountStoreMapping'})
                .expect(200)
                .then(function(res){
                    applicationId = res.body.items[0].id;
                    return init.getRequest('directories/'+res.body.items[0].defaultAccountStoreMapping.accountStoreId)
                              .query({expand: 'passwordPolicy,accountCreationPolicy'})
                              .expect(200);
                })
                .then(function(res){
                  //enable password reset workflow
                  return init.postRequest('passwordPolicies/' + res.body.passwordPolicy.id)
                    .send({resetEmailStatus: 'ENABLED'})
                    .expect(200)
                    .then(function(){
                      return init.postRequest('accountCreationPolicies/' + res.body.accountCreationPolicy.id)
                        .send({verificationEmailStatus: 'ENABLED'})
                        .expect(200)
                    });
                });
        });
    });
  
    after(function () {
      //stop the SMTP server
      mailServer.stop();
    });

    describe('login', function(){
        it('in application', function(){
            return init.getIdSiteBearer(applicationId, callbackUrl)
                .then(function(bearer){
                    return request(init.app).post('/v1/applications/'+applicationId+'/loginAttempts')
                        .set('authorization', 'Bearer '+bearer)
                        .send({
                            type: 'basic',
                            value: new Buffer(init.adminUser+':'+init.adminPassword, 'utf8').toString('base64')
                        })
                        .expect(200);
                })
                .then(function(res){
                    //there should be a redirection URL in the headers
                    assert(res.header['stormpath-sso-redirect-location']);
                    return request(res.header['stormpath-sso-redirect-location']).get('')
                            .expect(302);
                })
                .then(function(res){
                    //cloudpass should redirect us back to the application
                    //and set a cookie for subsequent logins
                    assert(res.header.location);
                    assert(res.header.location.startsWith(callbackUrl+'?jwtResponse='));
                    assert(res.header['set-cookie']);
                    return BluebirdPromise.join(
                            init.getIdSiteJwtRequest(applicationId, callbackUrl),
                            res.header['set-cookie'][0].split(';')[0]
                        );
                })
                .spread(function(jwtRequest, cookie){
                    //send a a new request with the cookie
                    return request(init.app).get('/sso')
                        .query({ jwtRequest: jwtRequest})
                        .set('Cookie', cookie)
                        .expect(302);
                })
                .then(function(res){
                    //cloudpass should redirect directly to the callback URL, not to the ID site
                    assert(res.header.location);
                    assert(res.header.location.startsWith(callbackUrl+'?jwtResponse='));
                });
            });

            it('in organization', function(){
                //create an organization an map it the the application
                var organizationName = init.randomName();
                var organizationId;
                return init.postRequest('organizations')
                    .send({
                        name: organizationName,
                        nameKey: organizationName
                    })
                    .expect(200)
                    .then(function(res){
                        organizationId = res.body.id;
                        return init.postRequest('accountStoreMappings')
                            .send({
                                application:{href: '/applications/'+applicationId},
                                accountStore:{href: '/organizations/'+res.body.id}
                            })
                            .expect(200);
                    })
                    .then(function(){
                        return init.getIdSiteBearer(applicationId, callbackUrl, organizationName);
                    })
                    .tap(function(bearer){
                       //the bearer should give access to the organization & its ID site model
                       return request(init.app).get('/v1/organizations/'+organizationId)
                                .set('authorization', 'Bearer '+bearer)
                                .query({ expand: 'idSiteModel'})
                                .expect(200)
                                .then(res => {
                                   assert.strictEqual(res.body.name, organizationName);
                                   assert(res.body.idSiteModel.hasOwnProperty('providers'));
                                   assert(res.body.idSiteModel.hasOwnProperty('passwordPolicy'));
                                   assert(res.body.idSiteModel.hasOwnProperty('logoUrl'));
                                 });
                    })
                    .then(function(bearer){
                        //Cloudpass should return a 400 because the account is not in this organization
                        return request(init.app).post('/v1/applications/'+applicationId+'/loginAttempts')
                            .set('authorization', 'Bearer '+bearer)
                            .send({
                                type: 'basic',
                                value: new Buffer('test@example.com:Aa123456', 'utf8').toString('base64')
                            })
                            .expect(400);
                    });
            });
    });

    it('logout', function(){
        return init.getIdSiteJwtRequest(applicationId, callbackUrl)
                .then(function(jwtRequest){
                    return request(init.app).get('/sso/logout')
                            .query({ jwtRequest: jwtRequest})
                            .expect(302);
                })
                .then(function(res){
                    assert(res.header.location);
                    assert.strictEqual(res.header.location, callbackUrl);
                    assert(res.header['set-cookie']);
                    //cookie should be empty
                    assert.strictEqual(res.header['set-cookie'][0].split(';')[0].split('=')[1], '');
                });
    });
  
    it('password reset', function(){
      return init.getIdSiteBearer(applicationId, callbackUrl)
        .then(function(bearer){
           return BluebirdPromise.join(
              init.getEmailPromise(mailServer, init.adminUser),
              request(init.app).post('/v1/applications/'+applicationId+'/passwordResetTokens')
                  .set('authorization', 'Bearer '+bearer)
                  .send({email: init.adminUser})
                  .expect(200)
           ).spread(function(email){
              let jwtParam = /\/#\/reset\?jwt=(.*?)\n/.exec(email.body)[1];
              assert(jwtParam);
              let tokenId = jwt.decode(jwtParam).sp_token;
              assert(tokenId);
              return request(init.app).post('/v1/applications/'+applicationId+'/passwordResetTokens/'+tokenId)
                  .set('authorization', 'Bearer '+jwtParam)
                  .send({password: init.adminPassword})
                  .expect(200);
           });
       });
    });
  
    it('email verification', function(){
      const address = init.randomName() + '@example.com';
      return init.getIdSiteBearer(applicationId, callbackUrl)
        .then(function(bearer){
          return BluebirdPromise.join(
                init.getEmailPromise(mailServer, address.toLowerCase()),
                request(init.app).post('/v1/applications/'+applicationId+'/accounts')
                  .set('authorization', 'Bearer '+bearer)
                  .send({
                      email: address,
                      password: 'Aa123456',
                      givenName: init.randomName(),
                      surname: init.randomName()
                  })
                  .expect(200)
            )
            .spread(function(email, res){
                  assert.strictEqual(res.body.status, 'UNVERIFIED');
                  const jwtParam = /\/#\/verify\?jwt=(.*?)\n/.exec(email.body)[1];
                  assert(jwtParam);
                  const tokenId = jwt.decode(jwtParam).sp_token;
                  assert(tokenId);
                  return request(init.app).post('/v1/accounts/emailVerificationTokens/'+tokenId)
                    .set('authorization', 'Bearer '+jwtParam)
                    .expect(200);
              });
        })
    });

    it('Requests with bearer authorization must have a limited scope', function(){
        return init.getIdSiteBearer(applicationId, callbackUrl)
                .then(function(bearer){
                    return request(init.app).get('/v1/applications/'+applicationId+'/accounts')
                        .set('authorization', 'Bearer '+bearer)
                        .expect(403)
                        .toPromise();
                });
    });

    it('ID site model must be exposed by applications', function(){
        return init.getRequest('applications/'+applicationId+'/idSiteModel')
                .expect(200)
                .then(function(res){
                    assert(res.body.hasOwnProperty('providers'));
                    assert(res.body.hasOwnProperty('passwordPolicy'));
                    assert(res.body.hasOwnProperty('logoUrl'));
                });
    });
});