/*!
 * Copyright 2020 Google LLC
 *
 * Use of this source code is governed by an MIT-style
 * license that can be found in the LICENSE file or at
 * https://opensource.org/licenses/MIT.
 */
const config = {
  "enable-source-maps": true,
  "throw-deprecation": true,
  "timeout": 10000,
  "recursive": true
}
if (process.env.MOCHA_THROW_DEPRECATION === 'false') {
  delete config['throw-deprecation'];
}
if (process.env.MOCHA_REPORTER) {
  config.reporter = process.env.MOCHA_REPORTER;
}
if (process.env.MOCHA_REPORTER_OUTPUT) {
  config['reporter-option'] = `output=${process.env.MOCHA_REPORTER_OUTPUT}`;
}
module.exports = config
