'use strict';

var scopeHelper = require('./scopeHelper');
var getExpands = require('../../api/helpers/controllerHelper').getExpands;

function isPathAllowed(path, method, allowedPaths) {
    return allowedPaths[path] && allowedPaths[path].indexOf(method) >= 0;
}

function isRequestAllowed(req) {
    if (req.authInfo && req.authInfo.scope) {
        var allowedPaths = scopeHelper.scopeToPaths(req.authInfo.scope);
        var requestPath = req.path;
        //check if a the request and its expanded parts all fall within the authorized scope
        return isPathAllowed(requestPath, req.method.toLowerCase(), allowedPaths) &&
                !Object.keys(getExpands(req.query.expand))
                .map(function (associationName) {
                    return requestPath + '/' + associationName;
                })
                .find(function (path) {
                    return !isPathAllowed(path, 'get', allowedPaths);
                });
    }
    return true;
}

module.exports = function (req, res) {
    if (req.authInfo && req.authInfo.scope) {
        //check if a the request and its expanded parts all fall within the authorized scope
        if (!isRequestAllowed(req)) {
            return res.status(403).send();
        }
    }
    req.next();
};
