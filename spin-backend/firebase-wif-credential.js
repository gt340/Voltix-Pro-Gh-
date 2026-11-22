'use strict';

const PROJECT_NUMBER = '403309153314';
const PROJECT_ID = 'voltix-pro-gh-staging';
const WORKLOAD_POOL_ID = 'voltix-staging-vercel';
const PROVIDER_ID = 'vercel-preview';
const SERVICE_ACCOUNT_EMAIL =
  'voltix-staging-backend@voltix-pro-gh-staging.iam.gserviceaccount.com';

function createFirebaseWifCredential({ IdentityPoolClient, getOidcToken }) {
  if (typeof IdentityPoolClient !== 'function') {
    throw new TypeError('IdentityPoolClient is required');
  }
  if (typeof getOidcToken !== 'function') {
    throw new TypeError('getOidcToken is required');
  }

  const audience =
    `//iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WORKLOAD_POOL_ID}/providers/${PROVIDER_ID}`;
  const client = new IdentityPoolClient({
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

  client.scopes = ['https://www.googleapis.com/auth/cloud-platform'];

  return {
    async getAccessToken() {
      await client.getAccessToken();
      const credentials = client.credentials || {};
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
}

module.exports = {
  createFirebaseWifCredential,
  PROJECT_ID,
  SERVICE_ACCOUNT_EMAIL
};
