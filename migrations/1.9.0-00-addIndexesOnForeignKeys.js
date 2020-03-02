"use strict";
module.exports = {
    up: function (migration, DataTypes, models) {
        return migration.addIndex(
            'accounts',
            ['tenantId']
        ).then(() => migration.addIndex(
            'accounts',
            ['directoryId']
        )).then(() => migration.addIndex(
            'accounts',
            ['emailVerificationTokenId']
        )).then(() => migration.addIndex(
            'accountStoreMappings',
            ['applicationId']
        )).then(() => migration.addIndex(
            'accountStoreMappings',
            ['accountStoreType', 'applicationId']
        )).then(() => migration.addIndex(
            'accountStoreMappings',
            ['tenantId']
        )).then(() => migration.addIndex(
            'groupMemberships',
            ['tenantId']
        )).then(() => migration.addIndex(
            'groupMemberships',
            ['accountId']
        )).then(() => migration.addIndex(
            'groupMemberships',
            ['groupId']
        )).then(() => migration.addIndex(
            'groups',
            ['directoryId', 'status']
        )).then(() => migration.addIndex(
            'groups',
            ['tenantId']
        )).then(() => migration.addIndex(
            'directories',
            ['accountCreationPolicyId']
        )).then(() => migration.addIndex(
            'directories',
            ['accountLockingPolicyId']
        )).then(() => migration.addIndex(
            'directories',
            ['passwordPolicyId']
        )).then(() => migration.addIndex(
            'directories',
            ['tenantId']
        ));
    }
};
