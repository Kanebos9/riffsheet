self.onmessage = function (e) { self.postMessage("worker-alive:" + e.data); };
