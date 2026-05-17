'use strict';
// Safe replacement for the abandoned vm2 package.
// Uses Node's built-in vm module — sufficient for typescript-json-schema's usage.
const nodeVm = require('vm');

class VM {
  constructor(options) {
    this._options = options || {};
  }

  run(code) {
    return nodeVm.runInNewContext(code, Object.create(null), { timeout: this._options.timeout });
  }
}

class NodeVM {
  constructor(options) {
    this._options = options || {};
  }

  run(code, filename) {
    const script = new nodeVm.Script(code, { filename });
    return script.runInNewContext(Object.create(null));
  }
}

module.exports = { VM, NodeVM };
