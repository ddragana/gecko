// |reftest| skip-if(!this.hasOwnProperty('Atomics')||!this.hasOwnProperty('SharedArrayBuffer')) -- Atomics,SharedArrayBuffer is not enabled unconditionally
// Copyright (C) 2017 Mozilla Corporation.  All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.

/*---
esid: sec-atomics.wake
description: >
  Test that Atomics.wake wakes zero waiters if the count is negative
features: [Atomics, SharedArrayBuffer, TypedArray]
---*/

$262.agent.start(
`
$262.agent.receiveBroadcast(function (sab) {
  var ia = new Int32Array(sab);
  $262.agent.report(Atomics.wait(ia, 0, 0, 1000)); // We will timeout eventually
  $262.agent.leaving();
})
`);

var ia = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

$262.agent.broadcast(ia.buffer);
$262.agent.sleep(500); // Give the agent a chance to wait
assert.sameValue(Atomics.wake(ia, 0, -1), 0); // Don't actually wake it
assert.sameValue(getReport(), "timed-out");

function getReport() {
  var r;
  while ((r = $262.agent.getReport()) == null)
    $262.agent.sleep(100);
  return r;
}

reportCompare(0, 0);
