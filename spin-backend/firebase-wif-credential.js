'use strict';

const PROJECT_NUMBER = '403309153314';
const PROJECT_ID = 'voltix-pro-gh-staging';
const WORKLOAD_POOL_ID = 'voltix-staging-vercel';
const PROVIDER_ID = 'vercel-preview';
const SERVICE_ACCOUNT_EMAIL =
  'voltix-staging-backend@voltix-pro-gh-staging.iam.gserviceaccount.com';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

function createFirebaseWifClients({ IdentityPoolClient, getOidcToken }) {
  if (typeof IdentityPoolClient !== 'function') {
    throw new TypeError('IdentityPoolClient is required');
  }
  if (typeof getOidcToken !== 'function') {
    throw new TypeError('getOidcToken is required');
  }

  const audience =
    `//iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WORKLOAD_POOL_ID}/providers/${PROVIDER_ID}`;
  const authClient = new IdentityPoolClient({
    audience,
    subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
    token_url: 'https://sts.googleapis.com/v1/token',
    service_account_impersonation_url:
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SERVICE_ACCOUNT_EMAIL}:generateAccessToken`,
    subject_token_supplier: {
      async getSubjectToken() {
        const token = await getOidcToken();
        if (typeof token !== 'string' || token.length === 0) {
          throw new Error('Vercel OIDC token is unavailable');
        }
        return token;
      }
    }
  });

  authClient.scopes = [CLOUD_PLATFORM_SCOPE];

  // Firebase Admin Auth accepts this credential interface, while GoogleAuth
  // consumes the original IdentityPoolClient directly for Firestore requests.
  const credential = {
    async getAccessToken() {
      await authClient.getAccessToken();
      const credentials = authClient.credentials || {};
      if (
        typeof credentials.access_token !== 'string' ||
        !credentials.access_token ||
        typeof credentials.expiry_date !== 'number'
      ) {
        throw new Error('Google WIF exchange returned incomplete credentials');
      }
      return {
        access_token: credentials.access_token,
        expires_in: Math.max(
          0,
          Math.floor((credentials.expiry_date - Date.now()) / 1000)
        )
      };
    }
  };

  return { authClient, credential };
}

function createFirebaseWifCredential(options) {
  return createFirebaseWifClients(options).credential;
}

module.exports = {
  createFirebaseWifClients,
  createFirebaseWifCredential,
  PROJECT_ID,
  SERVICE_ACCOUNT_EMAIL,
  CLOUD_PLATFORM_SCOPE
};
