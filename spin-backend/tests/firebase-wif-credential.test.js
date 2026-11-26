'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { IdentityPoolClient, GoogleAuth } = require('google-auth-library');
const {
  createFirebaseWifClients,
  createFirebaseWifCredential,
  PROJECT_ID,
  SERVICE_ACCOUNT_EMAIL,
  CLOUD_PLATFORM_SCOPE
} = require('../firebase-wif-credential');

test('Firebase WIF credential is bound to the staging pool, provider, and service account', async () => {
  let options;
  let suppliedToken;
  class FakeIdentityPoolClient {
    constructor(value) {
      options = value;
      this.credentials = {};
    }
    async getAccessToken() {
      suppliedToken = await options.subject_token_supplier.getSubjectToken();
      this.credentials = {
        access_token: 'short-lived-google-access-token',
        expiry_date: Date.now() + 3600000
      };
    }
  }

  const { credential, authClient } = createFirebaseWifClients({
    IdentityPoolClient: FakeIdentityPoolClient,
    getOidcToken: async () => 'vercel-preview-oidc-token'
  });
  const result = await credential.getAccessToken();

  assert.equal(suppliedToken, 'vercel-preview-oidc-token');
  assert.match(options.audience, /projects\\/403309153314\\/locations\\/global\\/workloadIdentityPools\\/voltix-staging-vercel\\/providers\\/vercel-preview$/);
  assert.equal(options.subject_token_type, 'urn:ietf:params:oauth:token-type:id_token');
  assert.equal(options.token_url, 'https://sts.googleapis.com/v1/token');
  assert.equal(
    options.service_account_impersonation_url,
    'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' +
      SERVICE_ACCOUNT_EMAIL + ':generateAccessToken'
  );
  assert.equal(typeof options.subject_token_supplier.getSubjectToken, 'function');
  assert.equal(result.access_token, 'short-lived-google-access-token');
  assert.ok(result.expires_in > 0 && result.expires_in <= 3600);
  assert.equal(authClient.scopes[0], CLOUD_PLATFORM_SCOPE);
  assert.equal(PROJECT_ID, 'voltix-pro-gh-staging');
});

test('Firebase WIF credential initializes with the real google-auth-library client', () => {
  const credential = createFirebaseWifCredential({
    IdentityPoolClient,
    getOidcToken: async () => 'vercel-preview-oidc-token'
  });
  assert.equal(typeof credential.getAccessToken, 'function');
});

test('GoogleAuth uses the exact federated IdentityPoolClient for Firestore', () => {
  const { authClient } = createFirebaseWifClients({
    IdentityPoolClient,
    getOidcToken: async () => 'vercel-preview-oidc-token'
  });
  const auth = new GoogleAuth({
    authClient,
    projectId: PROJECT_ID,
    scopes: [CLOUD_PLATFORM_SCOPE]
  });

  assert.equal(auth.cachedCredential, authClient);
  assert.equal(auth._cachedProjectId, PROJECT_ID);
  assert.deepEqual(auth.scopes, [CLOUD_PLATFORM_SCOPE]);
});

test('Firebase WIF credential fails closed when Vercel does not provide an OIDC token', async () => {
  class FakeIdentityPoolClient {
    constructor(options) {
      this.options = options;
      this.credentials = {};
    }
    async getAccessToken() {
      await this.options.subject_token_supplier.getSubjectToken();
    }
  }

  const credential = createFirebaseWifCredential({
    IdentityPoolClient: FakeIdentityPoolClient,
    getOidcToken: async () => null
  });

  await assert.rejects(
    credential.getAccessToken(),
    /Vercel OIDC token is unavailable/
  );
});

test('Vercel Preview uses federated Firestore auth and cannot fall back to a static key', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(server.includes("process.env.VERCEL_ENV === 'preview'"));
  assert.ok(server.includes('createFirebaseWifClients'));
  assert.ok(server.includes('new GoogleAuth('));
  assert.ok(server.includes('new FirestoreSdk.Firestore({ projectId: firebaseAdminOptions.projectId, auth: firestoreAuth })'));
  assert.ok(server.includes('FirestoreSdk.FieldValue'));
  assert.ok(server.includes("await import('@vercel/oidc')"));
  assert.ok(server.includes('if (!process.env.FIREBASE_SERVICE_ACCOUNT)'));
  assert.ok(server.includes('admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))'));
  const previewBlock = server.slice(
    server.indexOf("if (process.env.VERCEL_ENV === 'preview')"),
    server.indexOf("if (!process.env.FIREBASE_SERVICE_ACCOUNT)")
  );
  assert.doesNotMatch(previewBlock, /FIREBASE_SERVICE_ACCOUNT/);
  assert.ok(server.includes(': admin.firestore();'));
});
