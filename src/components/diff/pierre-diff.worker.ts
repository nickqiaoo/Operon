// Load the package through one module URL. Its lazy backends import helpers
// from the worker module, which also registers the worker's message handler.
import '@pierre/diffs/worker/worker.js';
