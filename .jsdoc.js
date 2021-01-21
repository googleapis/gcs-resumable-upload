/*!
 * Copyright 2018 Google LLC
 *
 * Use of this source code is governed by an MIT-style
 * license that can be found in the LICENSE file or at
 * https://opensource.org/licenses/MIT.
 */

'use strict';

module.exports = {
  opts: {
    readme: './README.md',
    package: './package.json',
    template: './node_modules/jsdoc-fresh',
    recurse: true,
    verbose: true,
    destination: './docs/'
  },
  plugins: [
    'plugins/markdown',
    'jsdoc-region-tag'
  ],
  source: {
    excludePattern: '(^|\\/|\\\\)[._]',
    include: [
      'src'
    ],
    includePattern: '\\.js$'
  },
  templates: {
    copyright: 'Copyright 2019 Google, LLC.',
    includeDate: false,
    sourceFiles: false,
    systemName: 'gcs-resumable-upload',
    theme: 'lumen',
    default: {
      "outputSourceFiles": false
    }
  },
  markdown: {
    idInHeadings: true
  }
};
