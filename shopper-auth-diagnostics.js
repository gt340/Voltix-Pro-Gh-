(function(root){
  'use strict';

  const STORAGE_KEY = 'voltixShopperAuthDiagnostics';
  const MAX_RECORDS = 5;

  function redact(value){
    return String(value || '')
      .replace(/\+?233\d{9}\b/g, '[PHONE REDACTED]')
      .replace(/\b0\d{9}\b/g, '[PHONE REDACTED]')
      .replace(/\b\d{6}\b/g, '[OTP REDACTED]')
      .replace(/(api[_-]?key|token|secret|authorization)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
      .slice(0, 300);
  }

  function readRecords(){
    try {
      return JSON.parse(root.sessionStorage.getItem(STORAGE_KEY) || '[]');
    } catch (_) {
      return [];
    }
  }

  function display(record){
    if(!root.document || !root.document.body) return;

    let panel = root.document.getElementById('shopperAuthDiagnosticPanel');

    if(!panel){
      panel = root.document.createElement('section');
      panel.id = 'shopperAuthDiagnosticPanel';
      panel.setAttribute('role', 'status');
      panel.style.cssText =
        'margin:12px;padding:14px;border:1px solid #b7791f;border-radius:8px;background:#fffaf0;color:#222;';

      const heading = root.document.createElement('strong');
      heading.textContent = 'Phone sign-in diagnostic';

      const content = root.document.createElement('pre');
      content.id = 'shopperAuthDiagnosticContent';
      content.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;';

      panel.appendChild(heading);
      panel.appendChild(content);
      root.document.body.appendChild(panel);
    }

    const content = root.document.getElementById('shopperAuthDiagnosticContent');
    if(content) content.textContent = JSON.stringify(record, null, 2);
  }

  function recordShopperAuthDiagnostic(error){
    const record = {
      timestamp: new Date().toISOString(),
      code: redact(error && error.code || 'unknown'),
      name: redact(error && error.name || 'Error'),
      message: redact(error && error.message || 'No error message supplied'),
      firebaseSdk: '10.12.2',
      online: root.navigator ? Boolean(root.navigator.onLine) : null,
      recaptchaContainer: redact(root.__voltixRecaptchaContainerId || 'none'),
      recaptchaVerifierPresent: Boolean(root.__voltixRecaptchaVerifier),
      phoneConfirmationPresent: Boolean(root.__voltixPhoneConfirmation)
    };

    const records = readRecords();
    records.push(record);

    try {
      root.sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(records.slice(-MAX_RECORDS))
      );
    } catch (_) {}

    display(record);
    return record;
  }

  function clearShopperAuthDiagnostics(){
    try {
      root.sessionStorage.removeItem(STORAGE_KEY);
    } catch (_) {}

    if(root.document){
      const panel = root.document.getElementById('shopperAuthDiagnosticPanel');
      if(panel) panel.remove();
    }
  }

  root.recordShopperAuthDiagnostic = recordShopperAuthDiagnostic;
  root.clearShopperAuthDiagnostics = clearShopperAuthDiagnostics;

  if(typeof module !== 'undefined' && module.exports){
    module.exports = {
      redact,
      readRecords,
      recordShopperAuthDiagnostic,
      clearShopperAuthDiagnostics
    };
  }
})(globalThis);
