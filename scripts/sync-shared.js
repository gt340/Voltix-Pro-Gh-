'use strict';
// Copies the shared payment modules from lib/ into spin-backend/ (it deploys as a separate project and
// cannot import ../lib). tests/phase2.test.js fails if the copies drift, so run this after editing lib/.
const fs = require('fs'), path = require('path');
for (const f of ['catalog.js', 'safety.js', 'ball-payments.js']) {
  fs.copyFileSync(path.join(__dirname, '..', 'lib', f), path.join(__dirname, '..', 'spin-backend', f));
  console.log('synced', f);
}
