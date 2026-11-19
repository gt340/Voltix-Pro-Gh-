test('PAYSTACK adapter: valid successful response returns verified transaction data', async () => {
  const expected = paid(1000, { reference: 'COINS/ENCODE01' });
  let request;
  const verify = createPaystackVerify({
    secret: SECRET,
    axios: { get: async (url, options) => {
      request = { url, options };
      return { status: 200, data: { status: true, data: expected } };
    } },
  });
  const result = await verify('COINS/ENCODE01');
  assert.equal(result.found, true);
  assert.deepEqual(result.data, expected);
  assert.match(request.url, /COINS%2FENCODE01$/);
  assert.equal(request.options.timeout, 15000);
  assert.equal(request.options.headers.Authorization, 'Bearer ' + SECRET);
});